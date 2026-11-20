/** AH-513 only. Bootstrap one existing, fully captured native Skill in place.
 * Delete with AH-517. This is deliberately not a daily command or legacy reader.
 * Resource/Source trees must enter through their current authority primitives;
 * Only an explicit, hash-bound changes input may clear captured Origin links or
 * replace proven hrefs in an exact captured native body. */
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
import { fileRef } from "../packages/core/src/ref.ts"
import { sharedSkillId } from "../packages/core/src/shared-content.ts"
import { requireCurrentSkillReady } from "../packages/core/src/shared-current-file.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { withCurrentInvocationBudget } from "../packages/core/src/shared-current-invocation.ts"
import {
  withCurrentOperation,
  type CurrentOperationSession,
} from "../packages/core/src/shared-current-operation.ts"
import { assertCurrentBodyReplaceable } from "../packages/core/src/shared-current-projection.ts"
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
import { nativeNotionPageId } from "../packages/core/src/shared-native-file-content.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { isCoalescibleNotionRead } from "../packages/core/src/shared-read-coalescing.ts"
import { sourceDefinitionLayout } from "../packages/core/src/shared-sources-model.ts"
import { sha256 } from "../packages/core/src/store.ts"
import { mapMarkdownLinks } from "../packages/core/src/typed-links.ts"

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
const NativeOwnerChanges = Schema.Struct({
  owner_page_id: PageId,
  origin: Schema.Struct({ before: Schema.Array(PageId), after: Schema.Array(PageId) }),
  body_changes: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      page_id: PageId,
      file_id: Schema.String,
      before_body_sha256: Hash,
      after_body_sha256: Hash,
      replacements: Schema.Array(
        Schema.Struct({
          href: Schema.String,
          replacement_href: Schema.String,
          typed_reference: Schema.String,
          target_owner_page_id: PageId,
          target_file_id: Schema.String,
          target_path: Schema.String,
          occurrences: Schema.Literal(1),
        }),
      ),
    }),
  ),
})
const NativeChanges = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ah513-native-changes"),
  tree_sha256: Hash,
  library_id: Schema.String,
  owners: Schema.Array(NativeOwnerChanges),
})
type OwnerChanges = typeof NativeOwnerChanges.Type
type ReferenceTarget = { readonly owner: Owner; readonly file: Owner["files"][number] }
type SelectedChanges = {
  readonly sha256: string
  readonly owner: OwnerChanges
  readonly targets: readonly ReferenceTarget[]
}
type NativePrepared = Extract<PreparedCurrentWriteFile, { readonly kind: "native" }>
type BoundFile = {
  readonly page_id: string
  readonly prepared: NativePrepared
  readonly before_markdown: string
}
export type BootstrapInput = {
  readonly library: SharedLibrary
  readonly tree_sha256: string
  readonly owner: Owner
  readonly plan: PreparedCurrentSkillWrite
  readonly files: readonly BoundFile[]
  readonly input_sha256: string
  readonly changes?: SelectedChanges
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

function selectChanges(input: {
  readonly changes: unknown
  readonly changes_sha256: string | undefined
  readonly tree_sha256: string
  readonly library: SharedLibrary
  readonly owner: Owner
  readonly owners: readonly unknown[]
}): SelectedChanges | undefined {
  if (input.changes === undefined && input.changes_sha256 === undefined) return undefined
  const hash = Schema.decodeUnknownSync(Hash)(input.changes_sha256),
    changes = Schema.decodeUnknownSync(NativeChanges)(input.changes, { onExcessProperty: "error" })
  if (
    changes.tree_sha256 !== input.tree_sha256 ||
    changes.library_id !== input.library.library_id ||
    new Set(changes.owners.map((owner) => owner.owner_page_id)).size !== changes.owners.length
  )
    throw invalid("Changes must name unique owners in this exact frozen tree and library.")
  const selected = changes.owners.filter(
    (owner) => owner.owner_page_id === input.owner.owner_page_id,
  )
  if (selected.length !== 1) throw invalid("Changes must explicitly select this one owner.")
  const owner = selected[0]!
  if (
    owner.origin.before.length === 0 ||
    new Set(owner.origin.before).size !== owner.origin.before.length ||
    owner.origin.after.length !== 0 ||
    canonicalSharedJson([...owner.origin.before].sort()) !==
      canonicalSharedJson([...input.owner.relations.origin].sort())
  )
    throw invalid("Only the exact captured Origin links may be cleared by this finite input.")
  if (
    new Set(owner.body_changes.map((file) => file.path)).size !== owner.body_changes.length ||
    new Set(owner.body_changes.map((file) => file.page_id)).size !== owner.body_changes.length
  )
    throw invalid("Every native body change must have one unique physical file binding.")
  const targets = new Map<string, ReferenceTarget>()
  for (const change of owner.body_changes) {
    const original = input.owner.files.find((file) => file.path === change.path)
    if (
      original === undefined ||
      original.binding.page_id !== change.page_id ||
      original.binding.file_id !== change.file_id ||
      original.native.body.sha256 !== change.before_body_sha256 ||
      change.before_body_sha256 === change.after_body_sha256 ||
      change.replacements.length === 0 ||
      new Set(change.replacements.map((replacement) => replacement.href)).size !==
        change.replacements.length
    )
      throw invalid("A native edit must bind one exact old body and unique href replacements.", {
        path: change.path,
      })
    for (const replacement of change.replacements) {
      const rows = input.owners.filter(
        (raw) => property(raw).owner_page_id === replacement.target_owner_page_id,
      )
      if (rows.length !== 1)
        throw invalid("A typed href target is absent or ambiguous in the complete tree.")
      const target = Schema.decodeUnknownSync(NativeOwner)(rows[0]),
        file = target.files.find((file) => file.path === replacement.target_path)
      if (
        target.owner_page_id === input.owner.owner_page_id ||
        !target.enabled ||
        file === undefined ||
        target.entrypoint !== file.path ||
        file.binding.page_id !== target.owner_page_id ||
        file.binding.file_id !== replacement.target_file_id ||
        !replacement.href.startsWith("../") ||
        /[?#\s]/u.test(replacement.href) ||
        replacement.replacement_href !==
          `https://app.notion.com/p/${file.binding.page_id.replaceAll("-", "")}` ||
        nativeNotionPageId(replacement.replacement_href) !== file.binding.page_id ||
        replacement.typed_reference !==
          fileRef(sharedSkillId(input.library.library_id, target.skill_id), file.path)
      )
        throw invalid("A replacement must name the exact enabled native main in this library.", {
          path: change.path,
          href: replacement.href,
        })
      targets.set(target.owner_page_id, { owner: target, file })
    }
  }
  return { sha256: hash, owner, targets: [...targets.values()] }
}

function changedBody(body: string, change: OwnerChanges["body_changes"][number] | undefined) {
  if (change === undefined) return body
  const counts = new Map(change.replacements.map((replacement) => [replacement.href, 0]))
  const target = mapMarkdownLinks(body, (href) => {
    const replacement = change.replacements.find((replacement) => replacement.href === href)
    if (replacement === undefined) return href
    counts.set(href, counts.get(href)! + 1)
    return replacement.replacement_href
  })
  if (
    digest(body) !== change.before_body_sha256 ||
    digest(target) !== change.after_body_sha256 ||
    change.replacements.some(
      (replacement) => counts.get(replacement.href) !== replacement.occurrences,
    )
  )
    throw invalid("The exact href edits do not reproduce the explicitly selected target body.", {
      path: change.path,
    })
  return target
}

/** Reuses actual current preparation, including reference admission. A failed
 * native reference remains a real candidate failure; bootstrap cannot waive it. */
export function prepareBootstrapInput(input: {
  readonly tree: unknown
  readonly tree_sha256: string
  readonly library: unknown
  readonly owner_page_id: string
  readonly changes?: unknown
  readonly changes_sha256?: string
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
      const changes = selectChanges({
        ...input,
        changes: input.changes,
        changes_sha256: input.changes_sha256,
        library,
        owner,
        owners: tree.owners,
      })
      if (
        owner.relations.members.length !== 0 ||
        owner.relations.requires.length !== 0 ||
        (owner.relations.origin.length !== 0 && changes === undefined)
      )
        throw invalid(
          "Native bootstrap requires empty relations or an exact Origin removal input.",
          {
            page_id: page,
          },
        )
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
      return { owner, library, ...(changes === undefined ? {} : { changes }) }
    })
    const captured = yield* checked(() =>
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
        const markdown = new TextDecoder("utf-8", { fatal: true }).decode(body)
        if (!bytes.equals(Buffer.from(file.content_candidate.frontmatter + markdown)))
          throw invalid(
            "The captured bytes differ from the explicit native header/body boundary.",
            {
              path: file.path,
            },
          )
        const target = changedBody(
          markdown,
          selected.changes?.owner.body_changes.find((change) => change.path === file.path),
        )
        return {
          before: markdown,
          target,
          write: {
            path: file.path,
            bytes:
              target === markdown
                ? bytes
                : Buffer.from(file.content_candidate.frontmatter + target),
            mode: file.mode,
            file_id: file.binding.file_id,
            authority: { kind: "native" as const },
          },
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
      files: captured.map((file) => file.write),
    })
    const bound = yield* checked(() =>
      plan.files.map((prepared) => {
        const original = selected.owner.files.find((file) => file.path === prepared.path),
          capture = captured.find((file) => file.write.path === prepared.path)
        if (
          original === undefined ||
          capture === undefined ||
          prepared.kind !== "native" ||
          plan.main !== selected.owner.entrypoint ||
          canonicalSharedJson(prepared.content) !==
            canonicalSharedJson(original.content_candidate) ||
          prepared.markdown !== capture.target
        )
          throw invalid("Current preparation changed the explicit native header/body boundary.", {
            path: prepared.path,
          })
        return {
          page_id: original.binding.page_id,
          prepared,
          before_markdown: capture.before,
        }
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
        ...(selected.changes === undefined
          ? {}
          : { changes: { sha256: selected.changes.sha256, owner: selected.changes.owner } }),
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
export type ObservationPhase = "initial" | "progress" | "complete"
function assertOwnerMetadata(
  input: BootstrapInput,
  raw: unknown,
  phase: ObservationPhase = "progress",
) {
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
    if (!Array.isArray(relation))
      throw invalid("The captured relation is incomplete.", { property: name })
    const actual = relation.map((row) => Schema.decodeUnknownSync(PageId)(property(row).id)),
      before = name === "Origin" ? (input.changes?.owner.origin.before ?? []) : [],
      matchesBefore =
        canonicalSharedJson([...actual].sort()) === canonicalSharedJson([...before].sort())
    if (
      new Set(actual).size !== actual.length ||
      !(phase === "initial"
        ? matchesBefore
        : actual.length === 0 || (phase === "progress" && matchesBefore))
    )
      throw invalid("The exact captured or target relationship differs from this finite input.", {
        property: name,
        page_id: owner.owner_page_id,
        phase,
      })
  }
}
function assertFileMetadata(
  input: BootstrapInput,
  selected: BoundFile,
  raw: unknown,
  phase: ObservationPhase = "progress",
) {
  if (selected.prepared.path === input.plan.main) {
    assertOwnerMetadata(input, raw, phase)
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
export type ExpectedNativeBody = {
  readonly page_id: string
  readonly path: string
  readonly before: string
  readonly target: string
}
export function observeExpectedNativeBody(
  file: ExpectedNativeBody,
  phase: ObservationPhase = "complete",
) {
  return observeSharedBody(file.page_id).pipe(
    Effect.flatMap((body) => {
      if (body.markdown === file.target && phase !== "initial") return Effect.succeed(true)
      if (body.markdown === file.before && phase !== "complete")
        return Effect.succeed(body.markdown === file.target)
      if (body.markdown === file.target && body.markdown === file.before)
        return Effect.succeed(true)
      return Effect.fail(
        fail(
          "CUTOVER_NATIVE_CHANGED",
          "The authored body is neither the permitted captured text nor its selected target; no overwrite is allowed.",
          {
            path: file.path,
            page_id: file.page_id,
            phase,
            before_sha256: digest(file.before),
            target_sha256: digest(file.target),
            observed_sha256: body.fingerprint.sha256,
          },
        ),
      )
    }),
  )
}
function expectedBody(file: BoundFile): ExpectedNativeBody {
  return {
    page_id: file.page_id,
    path: file.prepared.path,
    before: file.before_markdown,
    target: file.prepared.markdown,
  }
}
const assertBody = (file: BoundFile, phase: ObservationPhase = "complete") =>
  observeExpectedNativeBody(expectedBody(file), phase)

function inspectReferenceTargets(input: BootstrapInput, requireReady: boolean) {
  return Effect.gen(function* () {
    for (const target of input.changes?.targets ?? []) {
      const rows = yield* queryPages(input.library.skills.data_source_id, {
        property: input.library.skills.property_ids["Skill ID"],
        rich_text: { equals: target.owner.skill_id },
      })
      const raw = rows[0]
      yield* checked(() => {
        if (rows.length !== 1) throw invalid("A typed reference target is absent or ambiguous.")
        livePage(raw, target.owner.owner_page_id, input.library.skills.data_source_id)
        const ids = input.library.skills.property_ids
        if (
          rich(raw, ids, "Skill ID") !== target.owner.skill_id ||
          rich(raw, ids, "Main File ID") !== target.file.binding.file_id ||
          property(field(raw, ids, "Kind", "select").select).name !== target.owner.kind ||
          field(raw, ids, "Enabled", "checkbox").checkbox !== true
        )
          throw invalid("A typed reference no longer names its exact enabled native main.", {
            target_page_id: target.owner.owner_page_id,
          })
      })
      if (requireReady) {
        const index = yield* queryCurrentSkillIndex(input.library, target.owner.owner_page_id, raw)
        yield* checked(() => {
          requireCurrentSkillReady(index.state, index.page_id)
          const actual = [index.main, ...index.files]
          if (
            actual.length !== target.owner.files.length ||
            actual.some(
              (file) =>
                !target.owner.files.some(
                  (expected) =>
                    file.page_id === expected.binding.page_id &&
                    file.file_id === expected.binding.file_id &&
                    file.path === expected.path &&
                    canonicalSharedJson(file.content) ===
                      canonicalSharedJson(expected.content_candidate),
                ),
            )
          )
            throw invalid(
              "A ready typed reference target differs from its exact captured native tree.",
              {
                target_page_id: target.owner.owner_page_id,
              },
            )
        })
      }
    }
  })
}
export function inspectBootstrapSchema(library: SharedLibrary) {
  return Effect.gen(function* () {
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
/** Completeness is established by a live owner query and its entire Files relation. */
function inspectOwner(
  input: BootstrapInput,
  operation: string,
  options: {
    readonly complete?: boolean
    readonly uninitialized?: boolean
    readonly initialApply?: boolean
    readonly requireTargetsReady?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const { library, owner } = input
    const owners = yield* queryPages(library.skills.data_source_id, {
      property: library.skills.property_ids["Skill ID"],
      rich_text: { equals: owner.skill_id },
    })
    const raw = owners[0]
    const phase = yield* checked(() => {
      if (owners.length !== 1) throw invalid("The exact stable Skill ID is absent or ambiguous.")
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
      const phase = options.complete ? "complete" : empty ? "initial" : "progress"
      assertOwnerMetadata(input, raw, phase)
      return phase
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
        assertFileMetadata(input, file, row, phase)
        assertContent(input, file, row, options.complete === true)
        if (options.uninitialized && rich(row, fileProperties(input, file), "Content") !== "")
          throw invalid("An uninitialized owner has an already populated File Content.", {
            path: file.prepared.path,
          })
      })
      yield* assertBody(file, phase)
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
    yield* inspectReferenceTargets(
      input,
      options.complete === true || options.requireTargetsReady === true,
    )
    return { owner: raw, files }
  })
}
function result(input: BootstrapInput, operation: string, state: string, authoredBodyWrites = 0) {
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
    authored_body_writes: authoredBodyWrites,
    ...(input.changes === undefined
      ? {}
      : {
          changes_sha256: input.changes.sha256,
          planned_origin_removals: input.changes.owner.origin.before,
          planned_body_changes: input.changes.owner.body_changes.map((file) => ({
            page_id: file.page_id,
            path: file.path,
            before_sha256: file.before_body_sha256,
            target_sha256: file.after_body_sha256,
            href_replacements: file.replacements.length,
          })),
        }),
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
      const registration = yield* inspectBootstrapSchema(input.library)
      yield* inspectOwner(input, operation)
      return { ...result(input, operation, "dry-run"), registration, remote_writes: 0 }
    }).pipe(Effect.provideService(Notion, readOnly))
  })
}

function applyOrigin(input: BootstrapInput, session: CurrentOperationSession) {
  return Effect.gen(function* () {
    if (input.changes === undefined) return
    const api = yield* Notion,
      page = input.owner.owner_page_id
    yield* session.dispatch({
      key: `bootstrap-native:${page}:origin`,
      replay: "idempotent",
      request: {
        path: `v1/pages/${page}`,
        body: { properties: { [input.library.skills.property_ids.Origin!]: { relation: [] } } },
        options: { method: "PATCH" },
      },
      observe: () =>
        Effect.gen(function* () {
          yield* session.assertCurrent()
          const raw = yield* api.request(`v1/pages/${page}`)
          yield* checked(() => assertOwnerMetadata(input, raw))
          for (const file of input.files) yield* assertBody(file, "progress")
          const fresh = yield* api.request(`v1/pages/${page}`)
          const complete = yield* checked(() => {
            assertOwnerMetadata(input, fresh)
            const relation = field(
              fresh,
              input.library.skills.property_ids,
              "Origin",
              "relation",
            ).relation
            return Array.isArray(relation) && relation.length === 0
          })
          return complete
            ? { status: "complete" as const, value: undefined }
            : { status: "missing" as const }
        }),
      acknowledge: (raw) => checked(() => assertOwnerMetadata(input, raw, "complete")),
    })
  })
}

/** The existing operation dispatch owns every body write and its unknown result.
 * Only the exact old text is replaceable; target text acknowledges completion;
 * every third value stops without overwriting an observed author edit. */
export function dispatchExpectedNativeBody(
  session: CurrentOperationSession,
  file: ExpectedNativeBody & {
    readonly assertScope: Effect.Effect<void, SkillsError, Notion>
    readonly beforeReplace?: Effect.Effect<void, SkillsError, Notion>
  },
) {
  return Effect.gen(function* () {
    if (file.before === file.target) return false
    return yield* session.dispatch({
      key: `native:${file.page_id}:body`,
      replay: "idempotent",
      request: {
        path: `v1/pages/${file.page_id}/markdown`,
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: file.target },
        },
        options: { method: "PATCH" },
      },
      observe: () =>
        Effect.gen(function* () {
          yield* session.assertCurrent()
          yield* file.assertScope
          if (yield* observeExpectedNativeBody(file, "progress"))
            return { status: "complete" as const, value: false }
          yield* assertCurrentBodyReplaceable(file.page_id)
          if (file.beforeReplace !== undefined) yield* file.beforeReplace
          // Child-content and reference reads must not conceal an identity,
          // ownership or body edit since the first observation. No API
          // compare-and-swap is implied.
          yield* file.assertScope
          return (yield* observeExpectedNativeBody(file, "progress"))
            ? { status: "complete" as const, value: false }
            : { status: "missing" as const }
        }),
      acknowledge: () => observeExpectedNativeBody(file, "complete").pipe(Effect.as(true)),
    })
  })
}
export function bootstrapCurrent(
  input: BootstrapInput,
  operation: string,
  mode: "apply" | "resume",
) {
  return Effect.gen(function* () {
    const registration = yield* inspectBootstrapSchema(input.library)
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
      assertScope: inspectOwner(input, operation, {
        initialApply: mode === "apply",
        requireTargetsReady: true,
      }).pipe(Effect.asVoid),
      run: (session: CurrentOperationSession) =>
        Effect.gen(function* () {
          let authoredBodyWrites = 0
          yield* applyOrigin(input, session)
          // Stable ordering and exact PATCH payloads survive budget stops. Every
          // action rereads its actual native body before publishing its descriptor.
          for (const file of input.files) {
            if (
              yield* dispatchExpectedNativeBody(session, {
                ...expectedBody(file),
                assertScope: api
                  .request(`v1/pages/${file.page_id}`)
                  .pipe(
                    Effect.flatMap((raw) =>
                      checked(() => assertFileMetadata(input, file, raw, "complete")),
                    ),
                  ),
                beforeReplace: inspectReferenceTargets(input, true),
              })
            )
              authoredBodyWrites += 1
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
                  yield* checked(() => {
                    assertFileMetadata(input, file, raw, "complete")
                    assertContent(input, file, raw, false)
                  })
                  yield* assertBody(file)
                  const fresh = yield* api.request(`v1/pages/${file.page_id}`)
                  const complete = yield* checked(() => {
                    assertFileMetadata(input, file, fresh, "complete")
                    return assertContent(input, file, fresh, false)
                  })
                  return complete
                    ? { status: "complete" as const, value: undefined }
                    : { status: "missing" as const }
                }),
              acknowledge: (raw) =>
                Effect.gen(function* () {
                  yield* checked(() => {
                    assertFileMetadata(input, file, raw, "complete")
                    assertContent(input, file, raw, true)
                  })
                  yield* assertBody(file)
                }),
            })
          }
          return { ...result(input, operation, "ready", authoredBodyWrites), registration }
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
  readonly changes?: string
  readonly changes_sha256?: string
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
        "--changes",
        "--changes-sha256",
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
  if (values.has("--changes") !== values.has("--changes-sha256"))
    throw invalid("Supply --changes and --changes-sha256 together.")
  return {
    tree: absolute("--tree"),
    library: absolute("--library"),
    ...(values.has("--changes")
      ? {
          changes: absolute("--changes"),
          changes_sha256: Schema.decodeUnknownSync(Hash)(values.get("--changes-sha256")),
        }
      : {}),
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
      "node scripts/cutover-bootstrap-current.ts --tree ABS --tree-sha256 SHA256 --library ABS [--changes ABS --changes-sha256 SHA256] --owner-page UUID --operation ID --mode dry-run|apply|resume --store ABS --max-requests N --max-bytes N --timeout MS\nAH-513 only: one existing native owner and exact existing schema. Empty relations and unchanged bodies are required unless an explicit changes input owns exact Origin removal and typed href edits. No schema or Source writes. Keep the same tree, changes, library, operation and Store for resume.\n",
    )
    return
  }
  const options = parseBootstrapArguments(process.argv.slice(2)),
    bytes = readRegular(options.tree)
  if (digest(bytes) !== options.tree_sha256)
    throw invalid("The complete tree differs from the selected SHA-256.")
  const changesBytes = options.changes === undefined ? undefined : readRegular(options.changes)
  if (changesBytes !== undefined && digest(changesBytes) !== options.changes_sha256)
    throw invalid("The finite changes input differs from the selected SHA-256.")
  const input = await Effect.runPromise(
    prepareBootstrapInput({
      tree: JSON.parse(bytes.toString("utf8")),
      tree_sha256: options.tree_sha256,
      library: readJson(options.library),
      owner_page_id: options.owner_page_id,
      ...(changesBytes === undefined
        ? {}
        : {
            changes: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(changesBytes)),
            changes_sha256: options.changes_sha256!,
          }),
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
