/** AH-513 only. Bootstrap one existing, fully captured native Skill in place.
 * Delete with AH-517. This is deliberately not a daily command or legacy reader.
 * Resource/Source trees must enter through their current authority primitives;
 * this first slice accepts only existing native pages and never rewrites bodies. */
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  Cause,
  Config,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { localRuntime, storeRuntime } from "../packages/cli/src/runtime.ts"
import { fail, listSchema, property, SkillsError, text } from "../packages/core/src/model.ts"
import { Notion, NotionTransport } from "../packages/core/src/notion.ts"
import { NotionCredentialProvider } from "../packages/core/src/notion-credential.ts"
import { NotionRequestSchedulerLive } from "../packages/core/src/notion-request-scheduler.ts"
import type { RequestBudgetLimits } from "../packages/core/src/request-budget.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { withCurrentInvocationBudget } from "../packages/core/src/shared-current-invocation.ts"
import {
  withCurrentOperation,
  type CurrentOperationSession,
} from "../packages/core/src/shared-current-operation.ts"
import { currentRecordText } from "../packages/core/src/shared-current-records.ts"
import {
  prepareCurrentSkillWrite,
  type PreparedCurrentSkillWrite,
  type PreparedCurrentWriteFile,
} from "../packages/core/src/shared-current-write-input.ts"
import {
  LIBRARY_MARKER,
  preservesSharedLibraryBindings,
  SharedLibrarySchema,
  type SharedLibrary,
} from "../packages/core/src/shared-library-model.ts"
import {
  inspectTable,
  registeredSkillProperties,
  sharedFileProperties,
  sharedRecordProperties,
} from "../packages/core/src/shared-library.ts"
import { observeSharedBody } from "../packages/core/src/shared-page-body.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { isCoalescibleNotionRead } from "../packages/core/src/shared-read-coalescing.ts"
import { sourceDefinitionLayout } from "../packages/core/src/shared-sources-model.ts"
import { sha256 } from "../packages/core/src/store.ts"

const PageId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const NativeFile = Schema.Struct({
  path: Schema.String,
  authority: Schema.Literal("native"),
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  mode: Schema.Literals(["100644", "100755"]),
  local_bytes_path: Schema.String,
  binding: Schema.Struct({
    kind: Schema.Literal("existing"),
    page_id: PageId,
    file_id: Schema.String,
  }),
  native: Schema.Struct({
    body: Schema.Struct({
      page_id: PageId,
      local_path: Schema.String,
      sha256: Hash,
      bytes: Schema.Number,
    }),
  }),
  content_candidate: Schema.Struct({
    kind: Schema.Literal("native"),
    mode: Schema.Literals(["100644", "100755"]),
    frontmatter: Schema.String,
  }),
})
const NativeOwner = Schema.Struct({
  owner_page_id: PageId,
  skill_id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["skill", "router"]),
  entrypoint: Schema.String,
  enabled: Schema.Boolean,
  default_context: Schema.Boolean,
  relations: Schema.Struct({
    origin: Schema.Array(PageId),
    members: Schema.Array(PageId),
    requires: Schema.Array(PageId),
  }),
  files: Schema.Array(NativeFile),
})
type Owner = typeof NativeOwner.Type
type NativePrepared = Extract<PreparedCurrentWriteFile, { readonly kind: "native" }>
type BoundFile = { readonly page_id: string; readonly prepared: NativePrepared }
export type BootstrapInput = {
  readonly library: SharedLibrary
  readonly tree_sha256: string
  readonly owner: Owner
  readonly plan: PreparedCurrentSkillWrite
  readonly files: readonly BoundFile[]
  readonly input_sha256: string
}
const invalid = (message: string, details?: unknown) =>
  fail("CUTOVER_BOOTSTRAP_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current bootstrap input."),
  })
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

function readRegular(path: string): Buffer {
  if (!isAbsolute(path))
    throw invalid("Every supplied input needs an explicit absolute path.", { path })
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) throw invalid("Bootstrap inputs must be regular files.", { path })
    const bytes = readFileSync(descriptor),
      after = fstatSync(descriptor)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== before.size
    )
      throw invalid("A bootstrap input changed while it was read.", { path })
    return bytes
  } finally {
    closeSync(descriptor)
  }
}
function readJson(path: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegular(path)))
}

/** Reuses actual current preparation, including reference admission. A failed
 * native reference remains a real candidate failure; bootstrap cannot waive it. */
export function prepareBootstrapInput(input: {
  readonly tree: unknown
  readonly tree_sha256: string
  readonly library: unknown
  readonly owner_page_id: string
}) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      Schema.decodeUnknownSync(Hash)(input.tree_sha256)
      const page = Schema.decodeUnknownSync(PageId)(input.owner_page_id)
      const library = Schema.decodeUnknownSync(SharedLibrarySchema)(input.library, {
        onExcessProperty: "error",
      })
      const tree = Schema.decodeUnknownSync(
        Schema.Struct({
          version: Schema.Literal(1),
          composition_complete: Schema.Literal(true),
          library_id: Schema.String,
          owners: Schema.Array(Schema.Unknown),
        }),
      )(input.tree)
      if (tree.library_id !== library.library_id)
        throw invalid("Tree and schema belong to different libraries.")
      const rows = tree.owners.filter((raw) => property(raw).owner_page_id === page)
      if (rows.length !== 1)
        throw invalid("Select exactly one physical owner from the complete tree.", {
          page_id: page,
        })
      const owner = Schema.decodeUnknownSync(NativeOwner)(rows[0])
      if (Object.values(owner.relations).some((relation) => relation.length !== 0))
        throw invalid("This initial native slice requires empty Origin, Members and Requires.", {
          page_id: page,
        })
      if (
        owner.files.length === 0 ||
        new Set(owner.files.map((file) => file.binding.page_id)).size !== owner.files.length
      )
        throw invalid("Every native file needs one distinct existing physical page.")
      const main = owner.files.find((file) => file.path === owner.entrypoint)
      if (
        main?.binding.page_id !== page ||
        owner.files.some((file) => file.native.body.page_id !== file.binding.page_id)
      )
        throw invalid("Native bodies and the main file must retain their exact physical bindings.")
      for (const table of [library.skills, library.files, library.records, library.sources]) {
        Schema.decodeUnknownSync(PageId)(table.database_id)
        Schema.decodeUnknownSync(PageId)(table.data_source_id)
      }
      Schema.decodeUnknownSync(PageId)(library.parent_page_id)
      return { owner, library }
    })
    const files = yield* checked(() =>
      selected.owner.files.map((file) => {
        const bytes = readRegular(file.local_bytes_path),
          body = readRegular(file.native.body.local_path)
        if (
          bytes.length !== file.bytes ||
          digest(bytes) !== file.sha256 ||
          body.length !== file.native.body.bytes ||
          digest(body) !== file.native.body.sha256
        )
          throw invalid("Exact original bytes differ from the frozen candidate.", {
            path: file.path,
            page_id: file.binding.page_id,
          })
        return {
          path: file.path,
          bytes,
          mode: file.mode,
          file_id: file.binding.file_id,
          authority: { kind: "native" as const },
        }
      }),
    )
    const plan = yield* prepareCurrentSkillWrite({
      skill_id: selected.owner.skill_id,
      kind: selected.owner.kind,
      name: selected.owner.name,
      description: selected.owner.description,
      enabled: selected.owner.enabled,
      default_context: selected.owner.default_context,
      files,
    })
    const bound = yield* checked(() =>
      plan.files.map((prepared) => {
        const original = selected.owner.files.find((file) => file.path === prepared.path)
        if (
          original === undefined ||
          prepared.kind !== "native" ||
          plan.main !== selected.owner.entrypoint ||
          canonicalSharedJson(prepared.content) !==
            canonicalSharedJson(original.content_candidate) ||
          digest(prepared.markdown) !== original.native.body.sha256 ||
          Buffer.byteLength(prepared.markdown, "utf8") !== original.native.body.bytes
        )
          throw invalid("Current preparation changed the explicit native header/body boundary.", {
            path: prepared.path,
          })
        return { page_id: original.binding.page_id, prepared }
      }),
    )
    const input_sha256 = yield* sha256(
      canonicalSharedJson({
        kind: "ah513-existing-native-bootstrap",
        version: 1,
        tree_sha256: input.tree_sha256,
        library: selected.library,
        owner_page_id: selected.owner.owner_page_id,
        prepared_input_sha256: plan.input_sha256,
        files: bound.map((file) => ({
          page_id: file.page_id,
          file_id: file.prepared.file_id,
          path: file.prepared.path,
        })),
      }),
    )
    return {
      ...selected,
      tree_sha256: input.tree_sha256,
      plan,
      files: bound,
      input_sha256,
    } satisfies BootstrapInput
  })
}

function field(raw: unknown, ids: Readonly<Record<string, string>>, name: string, type: string) {
  const id = ids[name]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A bootstrap property is not registered.", {
      missing: name,
    })
  const matches = Object.entries(property(property(raw).properties)).flatMap(([key, value]) =>
    key === id || property(value).id === id ? [property(value)] : [],
  )
  const value = matches[0]
  if (matches.length !== 1 || value?.type !== type || value.has_more === true)
    throw invalid("An exact current property is missing, duplicated or incomplete.", {
      property: name,
      page_id: property(raw).id,
    })
  return value
}
function rich(
  raw: unknown,
  ids: Readonly<Record<string, string>>,
  name: string,
  type = "rich_text",
) {
  const value = field(raw, ids, name, type)
  if (!Array.isArray(value[type]))
    throw invalid("A text property is incomplete.", { property: name })
  return text(value[type])
}
function livePage(raw: unknown, page: string, table: string) {
  const row = property(raw),
    parent = property(row.parent)
  if (
    row.object !== "page" ||
    row.id !== page ||
    row.in_trash === true ||
    row.archived === true ||
    row.is_archived === true ||
    parent.type !== "data_source_id" ||
    parent.data_source_id !== table
  )
    throw invalid("The exact physical page is unavailable or belongs to another table.", {
      page_id: page,
    })
}
function queryPages(table: string, filter: unknown) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      rows: unknown[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${table}/query`,
        {
          page_size: 100,
          filter,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw),
          outer = property(raw)
        if (
          outer.object !== "list" ||
          (outer.request_status !== undefined &&
            property(outer.request_status).type !== "complete") ||
          (result.has_more
            ? !result.next_cursor || cursors.has(result.next_cursor)
            : result.next_cursor !== null)
        )
          throw invalid("The exact metadata inventory is incomplete.")
        for (const row of result.results) {
          const page = Schema.decodeUnknownSync(PageId)(property(row).id)
          livePage(row, page, table)
          if (seen.has(page)) throw invalid("The current inventory repeats a physical page.")
          seen.add(page)
        }
        return result
      })
      rows.push(...list.results)
      if (!list.has_more) return rows
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
  })
}
function assertOwnerMetadata(input: BootstrapInput, raw: unknown) {
  const { owner, library } = input,
    ids = library.skills.property_ids
  livePage(raw, owner.owner_page_id, library.skills.data_source_id)
  const main = input.files.find((file) => file.prepared.path === input.plan.main)!
  if (
    rich(raw, ids, "Skill ID") !== owner.skill_id ||
    rich(raw, ids, "Main File ID") !== main.prepared.file_id ||
    rich(raw, ids, "Name", "title") !== owner.name ||
    rich(raw, ids, "Description") !== owner.description ||
    property(field(raw, ids, "Kind", "select").select).name !== owner.kind ||
    field(raw, ids, "Enabled", "checkbox").checkbox !== owner.enabled ||
    field(raw, ids, "Default Context", "checkbox").checkbox !== owner.default_context
  )
    throw invalid("The captured owner metadata changed.", { page_id: owner.owner_page_id })
  for (const name of ["Origin", "Members", "Requires"]) {
    const relation = field(raw, ids, name, "relation").relation
    if (!Array.isArray(relation) || relation.length !== 0)
      throw invalid("The captured native owner acquired a relationship.", { property: name })
  }
}
function assertFileMetadata(input: BootstrapInput, selected: BoundFile, raw: unknown) {
  if (selected.prepared.path === input.plan.main) {
    assertOwnerMetadata(input, raw)
    return
  }
  const ids = input.library.files.property_ids
  livePage(raw, selected.page_id, input.library.files.data_source_id)
  const relation = field(raw, ids, "Skill", "relation").relation
  if (
    rich(raw, ids, "File ID") !== selected.prepared.file_id ||
    rich(raw, ids, "Path") !== selected.prepared.path ||
    !Array.isArray(relation) ||
    relation.length !== 1 ||
    property(relation[0]).id !== input.owner.owner_page_id
  )
    throw invalid("The captured File identity or path changed.", {
      path: selected.prepared.path,
      page_id: selected.page_id,
    })
}
const fileProperties = (input: BootstrapInput, file: BoundFile) =>
  file.prepared.path === input.plan.main
    ? input.library.skills.property_ids
    : input.library.files.property_ids
function assertContent(input: BootstrapInput, file: BoundFile, raw: unknown, complete: boolean) {
  const actual = rich(raw, fileProperties(input, file), "Content"),
    wanted = canonicalSharedJson(file.prepared.content)
  if (actual !== wanted && (complete || actual !== ""))
    throw invalid("Current Content differs from the finite native input.", {
      path: file.prepared.path,
      page_id: file.page_id,
    })
  return actual === wanted
}
function assertBody(file: BoundFile) {
  return observeSharedBody(file.page_id).pipe(
    Effect.flatMap((body) =>
      body.markdown === file.prepared.markdown
        ? Effect.void
        : Effect.fail(
            fail(
              "CUTOVER_NATIVE_CHANGED",
              "The current authored body changed; bootstrap will not overwrite it.",
              { path: file.prepared.path, page_id: file.page_id },
            ),
          ),
    ),
  )
}
function inspectSchema(input: BootstrapInput) {
  return Effect.gen(function* () {
    const { library } = input
    const database = yield* (yield* Notion).request(`v1/databases/${library.skills.database_id}`)
    const registration = yield* checked(() => {
      const description = text(property(database).description)
      if (!description.startsWith(LIBRARY_MARKER))
        throw invalid("The existing Skills database has no library registration.")
      const previous = Schema.decodeUnknownSync(SharedLibrarySchema)(
        JSON.parse(description.slice(LIBRARY_MARKER.length)),
        { onExcessProperty: "error" },
      )
      if (!preservesSharedLibraryBindings(previous, library))
        throw invalid("The explicit descriptor replaced an existing library or property binding.")
      return canonicalSharedJson(previous) === canonicalSharedJson(library)
        ? ("published" as const)
        : ("additive_descriptor_pending" as const)
    })
    const layouts = {
      skills: {
        ...registeredSkillProperties(library.skills),
        Origin: { relation: { data_source_id: library.sources.data_source_id } },
      },
      files: sharedFileProperties(library.skills.data_source_id),
      records: sharedRecordProperties(library.skills.data_source_id),
      sources: sourceDefinitionLayout(
        library.skills.data_source_id,
        library.records.data_source_id,
      ),
    }
    for (const role of ["skills", "files", "records", "sources"] as const)
      yield* inspectTable(
        library[role].database_id,
        layouts[role],
        library.parent_page_id,
        library[role],
      )
    return registration
  })
}
/** Completeness is established by a live owner query and its entire Files
 * relation. No historical decoder, broad workspace search or author rewrite. */
function inspectOwner(
  input: BootstrapInput,
  operation: string,
  options: {
    readonly complete?: boolean
    readonly uninitialized?: boolean
    readonly initialApply?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const { library, owner } = input
    const owners = yield* queryPages(library.skills.data_source_id, {
      property: library.skills.property_ids["Skill ID"],
      rich_text: { equals: owner.skill_id },
    })
    const raw = owners[0]
    yield* checked(() => {
      if (owners.length !== 1) throw invalid("The exact stable Skill ID is absent or ambiguous.")
      assertOwnerMetadata(input, raw)
      const ids = library.skills.property_ids,
        state = field(raw, ids, "Current State", "select").select,
        op = rich(raw, ids, "Operation")
      const empty = state === null && op === "" && rich(raw, ids, "Content") === ""
      const current = property(state).name
      if (options.uninitialized && !empty)
        throw invalid("The initial owner is no longer uninitialized.")
      if (
        !empty &&
        !((current === "applying" || current === "attention") && op === operation) &&
        !(current === "ready" && op === "" && !options.initialApply)
      )
        throw invalid("The exact owner is neither empty nor owned by this finite input.")
      if (options.complete && empty)
        throw invalid("An empty owner is not a completed current Skill.")
    })
    const files = yield* queryPages(library.files.data_source_id, {
      property: library.files.property_ids.Skill,
      relation: { contains: owner.owner_page_id },
    })
    const expected = input.files.filter((file) => file.prepared.path !== input.plan.main)
    yield* checked(() => {
      if (
        files.length !== expected.length ||
        files.some((row) => !expected.some((file) => file.page_id === property(row).id))
      )
        throw invalid("The complete physical Files scope differs from the prepared current tree.")
    })
    for (const file of input.files) {
      const row =
        file.prepared.path === input.plan.main
          ? raw
          : files.find((row) => property(row).id === file.page_id)
      yield* checked(() => {
        assertFileMetadata(input, file, row)
        assertContent(input, file, row, options.complete === true)
        if (options.uninitialized && rich(row, fileProperties(input, file), "Content") !== "")
          throw invalid("An uninitialized owner has an already populated File Content.", {
            path: file.prepared.path,
          })
      })
      yield* assertBody(file)
    }
    if (options.complete) {
      const index = yield* queryCurrentSkillIndex(library, owner.owner_page_id, raw)
      yield* checked(() => {
        const actual = [index.main, ...index.files]
        if (
          actual.length !== input.files.length ||
          actual.some(
            (file) =>
              !input.files.some(
                (expected) =>
                  expected.page_id === file.page_id &&
                  expected.prepared.file_id === file.file_id &&
                  expected.prepared.path === file.path &&
                  canonicalSharedJson(expected.prepared.content) ===
                    canonicalSharedJson(file.content),
              ),
          )
        )
          throw invalid("The actual current index differs from the fully verified tree.")
      })
    }
    return { owner: raw, files }
  })
}
function result(input: BootstrapInput, operation: string, state: string) {
  return {
    kind: "ah513-existing-native-bootstrap",
    state,
    operation_id: operation,
    input_sha256: input.input_sha256,
    prepared_input_sha256: input.plan.input_sha256,
    tree_sha256: input.tree_sha256,
    library_id: input.library.library_id,
    owner_page_id: input.owner.owner_page_id,
    skill_id: input.owner.skill_id,
    files: input.files.map((file) => ({
      page_id: file.page_id,
      file_id: file.prepared.file_id,
      path: file.prepared.path,
      authority: "native",
      sha256: file.prepared.sha256,
    })),
    authored_body_writes: 0,
  }
}
export function inspectBootstrapCurrent(input: BootstrapInput, operation: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const readOnly: Notion["Service"] = {
      ...api,
      readOnly: true,
      request: (path, body, options) => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        return !isCoalescibleNotionRead({
          key: "cutover-bootstrap-dry-run",
          path,
          method,
          file: options?.file,
        }) ||
          (method === "GET" && body !== undefined)
          ? Effect.fail(fail("NOTION_READ_ONLY", "Bootstrap dry-run cannot dispatch a mutation."))
          : api.request(path, body, options)
      },
    }
    return yield* Effect.gen(function* () {
      const registration = yield* inspectSchema(input)
      yield* inspectOwner(input, operation)
      return { ...result(input, operation, "dry-run"), registration, remote_writes: 0 }
    }).pipe(Effect.provideService(Notion, readOnly))
  })
}
export function bootstrapCurrent(
  input: BootstrapInput,
  operation: string,
  mode: "apply" | "resume",
) {
  return Effect.gen(function* () {
    const registration = yield* inspectSchema(input)
    const api = yield* Notion
    const verify = () => inspectOwner(input, operation, { complete: true }).pipe(Effect.asVoid)
    return yield* withCurrentOperation(input.library, {
      intent: {
        operation_id: operation,
        input_sha256: input.input_sha256,
        owner: { kind: "skill", id: input.owner.skill_id },
      },
      ownerPageId: input.owner.owner_page_id,
      mode,
      bootstrapExistingOwner: {
        assertUninitialized: () =>
          inspectOwner(input, operation, { uninitialized: true }).pipe(Effect.asVoid),
      },
      assertScope: inspectOwner(input, operation, { initialApply: mode === "apply" }).pipe(
        Effect.asVoid,
      ),
      run: (session: CurrentOperationSession) =>
        Effect.gen(function* () {
          // Stable ordering and exact PATCH payloads survive budget stops. Every
          // action rereads its actual native body before publishing its descriptor.
          for (const file of input.files) {
            const properties = {
              [fileProperties(input, file).Content!]: {
                rich_text: currentRecordText(canonicalSharedJson(file.prepared.content)),
              },
            }
            yield* session.dispatch({
              key: `bootstrap-native:${file.page_id}:content`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${file.page_id}`,
                body: { properties },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  yield* session.assertCurrent()
                  const raw = yield* api.request(`v1/pages/${file.page_id}`)
                  const complete = yield* checked(() => {
                    assertFileMetadata(input, file, raw)
                    return assertContent(input, file, raw, false)
                  })
                  yield* assertBody(file)
                  return complete
                    ? { status: "complete" as const, value: undefined }
                    : { status: "missing" as const }
                }),
              acknowledge: (raw) =>
                Effect.gen(function* () {
                  yield* checked(() => {
                    assertFileMetadata(input, file, raw)
                    assertContent(input, file, raw, true)
                  })
                  yield* assertBody(file)
                }),
            })
          }
          return { ...result(input, operation, "ready"), registration }
        }),
      verify,
      verifyCompletedResume: () =>
        verify().pipe(Effect.map(() => ({ ...result(input, operation, "ready"), registration }))),
    })
  })
}

export type BootstrapArguments = {
  readonly tree: string
  readonly tree_sha256: string
  readonly library: string
  readonly owner_page_id: string
  readonly operation: string
  readonly mode: "dry-run" | "apply" | "resume"
  readonly store: string
  readonly limits: RequestBudgetLimits
}
export function parseBootstrapArguments(args: readonly string[]): BootstrapArguments {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1]
    if (
      !key ||
      ![
        "--tree",
        "--tree-sha256",
        "--library",
        "--owner-page",
        "--operation",
        "--mode",
        "--store",
        "--max-requests",
        "--max-bytes",
        "--timeout",
      ].includes(key) ||
      value === undefined ||
      values.has(key)
    )
      throw invalid("Supply every documented option once with an explicit value.")
    values.set(key, value)
  }
  const absolute = (key: string) => {
    const value = values.get(key)
    if (!value || !isAbsolute(value)) throw invalid(`${key} needs an absolute path.`)
    return resolve(value)
  }
  const positive = (key: string) => {
    const value = values.get(key)
    if (!value || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw invalid(`${key} needs a positive integer.`)
    return Number(value)
  }
  const operation = values.get("--operation")
  if (!operation || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(operation))
    throw invalid("Supply a stable finite --operation identity.")
  return {
    tree: absolute("--tree"),
    library: absolute("--library"),
    store: absolute("--store"),
    tree_sha256: Schema.decodeUnknownSync(Hash)(values.get("--tree-sha256")),
    owner_page_id: Schema.decodeUnknownSync(PageId)(values.get("--owner-page")),
    operation,
    mode: Schema.decodeUnknownSync(Schema.Literals(["dry-run", "apply", "resume"]))(
      values.get("--mode"),
    ),
    limits: {
      requests: positive("--max-requests"),
      bytes: positive("--max-bytes"),
      duration_ms: positive("--timeout"),
    },
  }
}
const credentials = Layer.effect(
  NotionCredentialProvider,
  Effect.gen(function* () {
    const token = yield* Config.Redacted("NOTION_API_TOKEN").pipe(
      Effect.mapError(() => fail("AUTH_REQUIRED", "Inject the project's NOTION_API_TOKEN.")),
    )
    const value = Redacted.value(token)
    if (!value || /\s/u.test(value))
      return yield* Effect.fail(
        fail("CONFIG_ERROR", "The project token is empty or contains whitespace."),
      )
    return { resolve: Effect.succeed({ token, identity: yield* sha256(value) }) }
  }),
)
const runtime = NotionTransport.pipe(
  Layer.provide(credentials),
  Layer.provide(NotionRequestSchedulerLive),
  Layer.provideMerge(Layer.mergeAll(localRuntime, FetchHttpClient.layer)),
)
async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "node scripts/cutover-bootstrap-current.ts --tree ABS --tree-sha256 SHA256 --library ABS --owner-page UUID --operation ID --mode dry-run|apply|resume --store ABS --max-requests N --max-bytes N --timeout MS\nAH-513 only: one existing native owner, exact existing schema, empty relations. No author-body or schema writes. Keep the same tree, library, operation and Store for resume.\n",
    )
    return
  }
  const options = parseBootstrapArguments(process.argv.slice(2)),
    bytes = readRegular(options.tree)
  if (digest(bytes) !== options.tree_sha256)
    throw invalid("The complete tree differs from the selected SHA-256.")
  const input = await Effect.runPromise(
    prepareBootstrapInput({
      tree: JSON.parse(bytes.toString("utf8")),
      tree_sha256: options.tree_sha256,
      library: readJson(options.library),
      owner_page_id: options.owner_page_id,
    }).pipe(Effect.provide(localRuntime)),
  )
  const configuration = ConfigProvider.layer(
    ConfigProvider.orElse(
      ConfigProvider.fromUnknown({
        NTN_SKILLS_HOME: join(options.store, "state"),
        NTN_SKILLS_CONFIG_HOME: join(options.store, "config"),
        NTN_SKILLS_CACHE_HOME: join(options.store, "cache"),
      }),
      ConfigProvider.fromEnv(),
    ),
  )
  const work =
    options.mode === "dry-run"
      ? withCurrentInvocationBudget(
          inspectBootstrapCurrent(input, options.operation),
          options.limits,
        ).pipe(
          Effect.bind("request_metrics", () =>
            Effect.map(Notion, (api) => api.requestMetrics?.() ?? null),
          ),
          Effect.provide(runtime),
        )
      : withCurrentInvocationBudget(
          bootstrapCurrent(input, options.operation, options.mode),
          options.limits,
        ).pipe(
          Effect.bind("request_metrics", () =>
            Effect.map(Notion, (api) => api.requestMetrics?.() ?? null),
          ),
          Effect.provide(Layer.mergeAll(runtime, storeRuntime)),
        )
  const abort = new AbortController(),
    onSignal = () => abort.abort()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  try {
    const exit = await Effect.runPromiseExit(
      work.pipe(Effect.provide(configuration), Effect.scoped),
      { signal: abort.signal },
    )
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) {
        process.stderr.write(
          JSON.stringify({
            code: "CANCELLED",
            ...result(input, options.operation, "interrupted"),
            next: "Repeat the identical input with --mode resume and the same --store.",
          }) + "\n",
        )
        process.exitCode = 130
        return
      }
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      if (error instanceof SkillsError) throw error
      throw invalid("The finite bootstrap stopped before completion.")
    }
    process.stdout.write(JSON.stringify(exit.value) + "\n")
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify(
        error instanceof SkillsError
          ? { code: error.code, message: error.message, details: error.details }
          : {
              code: "CUTOVER_BOOTSTRAP_INVALID",
              message: error instanceof Error ? error.message : "Invalid bootstrap input.",
            },
      ) + "\n",
    )
    process.exitCode = 1
  })
