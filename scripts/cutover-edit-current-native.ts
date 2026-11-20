/** AH-513 only. Edit one exact ready native guide with two existing files.
 * Delete with AH-517. This finite caller is not a public command or a legacy
 * reader. The current operation kernel owns every mutation and recovery step. */
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
import {
  currentFileRecord,
  queryCurrentSkillIndex,
} from "../packages/core/src/shared-current-index.ts"
import { withCurrentInvocationBudget } from "../packages/core/src/shared-current-invocation.ts"
import {
  inspectCurrentOperation,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentOperationPredecessor,
  type CurrentWriteMode,
} from "../packages/core/src/shared-current-operation.ts"
import {
  currentRecordText,
  queryCurrentSharedOperationRecord,
} from "../packages/core/src/shared-current-records.ts"
import {
  currentWriteIdentity,
  prepareCurrentSkillWrite,
  prepareCurrentWriteFile,
  type PreparedCurrentSkillWrite,
  type PreparedCurrentWriteFile,
} from "../packages/core/src/shared-current-write-input.ts"
import { SharedLibrarySchema } from "../packages/core/src/shared-library-model.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { isCoalescibleNotionRead } from "../packages/core/src/shared-read-coalescing.ts"
import { sha256 } from "../packages/core/src/store.ts"
import { parseYaml } from "../packages/core/src/yaml.ts"
import {
  dispatchExpectedNativeBody,
  inspectBootstrapSchema,
  observeExpectedNativeBody,
  type ExpectedNativeBody,
} from "./cutover-bootstrap-current.ts"

const PageId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const NativeContent = Schema.Struct({
  kind: Schema.Literal("native"),
  mode: Schema.Literals(["100644", "100755"]),
  frontmatter: Schema.String,
})
const ReadyNativeEditSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ah513-ready-native-edit"),
  library: SharedLibrarySchema,
  owner: Schema.Struct({
    page_id: PageId,
    skill_id: Schema.String,
    before: Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      compatibility: Schema.String,
      kind: Schema.Literal("skill"),
      enabled: Schema.Boolean,
      default_context: Schema.Boolean,
      main_file_id: Schema.String,
      current_state: Schema.Literal("ready"),
      operation: Schema.Literal(""),
      relations: Schema.Struct({
        origin: Schema.Array(PageId),
        members: Schema.Array(PageId),
        requires: Schema.Array(PageId),
      }),
    }),
    after: Schema.Struct({ description: Schema.String, compatibility: Schema.String }),
  }),
  files: Schema.Array(
    Schema.Struct({
      page_id: PageId,
      file_id: Schema.String,
      path: Schema.String,
      name: Schema.String,
      before: Schema.Struct({
        content: NativeContent,
        body: Schema.Struct({ local_path: Schema.String, sha256: Hash, bytes: Size }),
      }),
      after: Schema.Struct({
        local_bytes_path: Schema.String,
        sha256: Hash,
        bytes: Size,
        content: NativeContent,
      }),
    }),
  ),
})
const Predecessor = Schema.Struct({
  record_page_id: PageId,
  operation_id: Schema.String,
  input_sha256: Hash,
  completion: Schema.Literal("ready"),
  owner_page_id: PageId,
  in_flight: Schema.Struct({
    key: Schema.String,
    request_sha256: Hash,
    replay: Schema.Literal("idempotent"),
  }),
})
const NativeEditSchema = Schema.Union([
  ReadyNativeEditSchema,
  Schema.Struct({
    ...ReadyNativeEditSchema.fields,
    predecessor: Predecessor,
    owner: Schema.Struct({
      ...ReadyNativeEditSchema.fields.owner.fields,
      before: Schema.Struct({
        ...ReadyNativeEditSchema.fields.owner.fields.before.fields,
        current_state: Schema.Literals(["applying", "attention"]),
        operation: Schema.String,
      }),
    }),
  }),
])
type NativeEdit = typeof NativeEditSchema.Type
type NativePrepared = Extract<PreparedCurrentWriteFile, { readonly kind: "native" }>
type BoundEdit = {
  readonly selected: NativeEdit["files"][number]
  readonly prepared: NativePrepared
  readonly body: ExpectedNativeBody
}
export type PreparedNativeEdit = {
  readonly selected: NativeEdit
  readonly plan: PreparedCurrentSkillWrite
  readonly files: readonly BoundEdit[]
  readonly main: BoundEdit
  readonly document_sha256: string
  readonly input_sha256: string
}
const invalid = (message: string, details?: unknown) =>
  fail("CUTOVER_NATIVE_EDIT_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The finite native edit is invalid."),
  })
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
type Phase = "initial" | "progress" | "complete"

function readRegular(path: string): Buffer {
  if (!isAbsolute(path)) throw invalid("Every input path must be absolute.", { path })
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > 8 * 1024 * 1024)
      throw invalid("A finite native input must be a regular file of at most 8 MiB.", { path })
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
      throw invalid("A native input changed while being read.", { path })
    return bytes
  } finally {
    closeSync(descriptor)
  }
}
function headerFields(header: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)(?:\r?\n)*$/u.exec(header)
  if (match === null) throw invalid("The main file requires a complete YAML frontmatter.")
  const parsed = parseYaml(match[1]!)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw invalid("The main frontmatter must be a mapping.")
  return property(parsed)
}

/** Parse and freeze the exact before/after bytes before any service mutation. */
export function prepareNativeEditInput(input: {
  readonly bytes: Uint8Array
  readonly sha256: string
}) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      Schema.decodeUnknownSync(Hash)(input.sha256)
      if (input.bytes.byteLength > 8 * 1024 * 1024 || digest(input.bytes) !== input.sha256)
        throw invalid("The edit JSON differs from its selected SHA-256.")
      const value = Schema.decodeUnknownSync(NativeEditSchema)(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)),
        { onExcessProperty: "error" },
      )
      currentWriteIdentity(value.owner.skill_id, "Skill ID")
      if (
        value.files.length !== 2 ||
        new Set(value.files.map((file) => file.page_id)).size !== 2 ||
        new Set(value.files.map((file) => file.file_id)).size !== 2 ||
        new Set(value.files.map((file) => file.path)).size !== 2 ||
        Object.values(value.owner.before.relations).some((ids) => ids.length !== 0)
      )
        throw invalid("Select exactly two existing native files with empty current relations.")
      if ("predecessor" in value) {
        const prior = value.predecessor
        currentWriteIdentity(prior.operation_id, "Predecessor operation ID")
        if (
          prior.owner_page_id !== value.owner.page_id ||
          prior.operation_id !== value.owner.before.operation ||
          !value.files.some((file) => prior.in_flight.key === "native:" + file.page_id + ":body")
        )
          throw invalid("A predecessor must select this owner and one existing native body action.")
      }
      const main = value.files.find((file) => file.path === "SKILL.md")
      if (
        main === undefined ||
        main.page_id !== value.owner.page_id ||
        main.file_id !== value.owner.before.main_file_id ||
        main.name !== value.owner.before.name
      )
        throw invalid("The exact main File must be the selected owner page.")
      const before = headerFields(main.before.content.frontmatter),
        after = headerFields(main.after.content.frontmatter)
      if (
        before.description !== value.owner.before.description ||
        after.description !== value.owner.after.description ||
        before.compatibility !== value.owner.before.compatibility ||
        after.compatibility !== value.owner.after.compatibility ||
        !same(
          Object.fromEntries(
            Object.entries(before).filter(
              ([key]) => !["description", "compatibility"].includes(key),
            ),
          ),
          Object.fromEntries(
            Object.entries(after).filter(
              ([key]) => !["description", "compatibility"].includes(key),
            ),
          ),
        )
      )
        throw invalid("Only the explicit description and compatibility frontmatter may change.")
      for (const file of value.files) {
        currentWriteIdentity(file.file_id, "File ID")
        if (
          file.before.content.mode !== file.after.content.mode ||
          (file.path !== "SKILL.md" &&
            (file.page_id === value.owner.page_id ||
              !same(file.before.content, file.after.content)))
        )
          throw invalid("Supporting Content and every native mode must remain unchanged.")
      }
      return value
    })
    const originals = yield* Effect.forEach(selected.files, (file) =>
      checked(() => {
        const before = readRegular(file.before.body.local_path),
          after = readRegular(file.after.local_bytes_path)
        if (
          before.length !== file.before.body.bytes ||
          digest(before) !== file.before.body.sha256 ||
          after.length !== file.after.bytes ||
          digest(after) !== file.after.sha256
        )
          throw invalid("The exact before or after native bytes changed.", {
            page_id: file.page_id,
            path: file.path,
          })
        return {
          selected: file,
          before: new TextDecoder("utf-8", { fatal: true }).decode(before),
          after,
        }
      }),
    )
    for (const file of originals) {
      const previous = yield* prepareCurrentWriteFile({
        path: file.selected.path,
        file_id: file.selected.file_id,
        bytes: new TextEncoder().encode(file.selected.before.content.frontmatter + file.before),
        mode: file.selected.before.content.mode,
        authority: { kind: "native" },
      })
      if (
        previous.kind !== "native" ||
        previous.markdown !== file.before ||
        !same(previous.content, file.selected.before.content)
      )
        return yield* Effect.fail(invalid("The captured native body and Content do not compose."))
    }
    const plan = yield* prepareCurrentSkillWrite({
      skill_id: selected.owner.skill_id,
      kind: selected.owner.before.kind,
      name: selected.owner.before.name,
      description: selected.owner.after.description,
      enabled: selected.owner.before.enabled,
      default_context: selected.owner.before.default_context,
      files: originals.map((file) => ({
        path: file.selected.path,
        file_id: file.selected.file_id,
        bytes: file.after,
        mode: file.selected.after.content.mode,
        authority: { kind: "native" as const },
      })),
    })
    const files = yield* checked(() =>
      originals
        .map((file) => {
          const prepared = plan.files.find((entry) => entry.path === file.selected.path)
          if (
            prepared === undefined ||
            prepared.kind !== "native" ||
            !same(prepared.content, file.selected.after.content)
          )
            throw invalid("The target full bytes differ from their declared native Content.")
          return {
            selected: file.selected,
            prepared,
            body: {
              page_id: file.selected.page_id,
              path: file.selected.path,
              before: file.before,
              target: prepared.markdown,
            },
          } satisfies BoundEdit
        })
        .sort((a, b) => a.selected.path.localeCompare(b.selected.path)),
    )
    const main = yield* checked(() => {
      const file = files.find((entry) => entry.selected.path === plan.main)
      if (file === undefined) throw invalid("The prepared main File is absent.")
      return file
    })
    return {
      selected,
      plan,
      files,
      main,
      document_sha256: input.sha256,
      input_sha256: yield* sha256(
        canonicalSharedJson({
          kind: selected.kind,
          document_sha256: input.sha256,
          selected,
          prepared_input_sha256: plan.input_sha256,
        }),
      ),
    } satisfies PreparedNativeEdit
  })
}

function field(raw: unknown, ids: Readonly<Record<string, string>>, name: string, type: string) {
  const id = ids[name],
    matches = Object.entries(property(property(raw).properties)).flatMap(([key, value]) =>
      id && (key === id || property(value).id === id) ? [property(value)] : [],
    ),
    value = matches[0]
  if (matches.length !== 1 || value?.type !== type || value.has_more === true)
    throw invalid("A current property is absent, duplicated or incomplete.", {
      page_id: property(raw).id,
      property: name,
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
  if (!Array.isArray(value[type])) throw invalid("A current text property is incomplete.")
  return text(value[type])
}
function content(raw: unknown, ids: Readonly<Record<string, string>>) {
  return Schema.decodeUnknownSync(NativeContent)(JSON.parse(rich(raw, ids, "Content")), {
    onExcessProperty: "error",
  })
}
function livePage(raw: unknown, page: string, table: string) {
  const row = property(raw),
    parent = property(row.parent)
  if (
    row.object !== "page" ||
    row.id !== page ||
    row.archived === true ||
    row.in_trash === true ||
    row.is_archived === true ||
    parent.type !== "data_source_id" ||
    parent.data_source_id !== table
  )
    throw invalid("The exact current page is unavailable or changed table.", { page_id: page })
}
function ownerMetadata(
  input: PreparedNativeEdit,
  raw: unknown,
  operation: string,
  phase: Phase,
  predecessorOperation?: string,
) {
  const { owner, library } = input.selected,
    before = owner.before,
    ids = library.skills.property_ids
  livePage(raw, owner.page_id, library.skills.data_source_id)
  if (
    rich(raw, ids, "Name", "title") !== before.name ||
    rich(raw, ids, "Skill ID") !== owner.skill_id ||
    rich(raw, ids, "Main File ID") !== before.main_file_id ||
    property(field(raw, ids, "Kind", "select").select).name !== before.kind ||
    field(raw, ids, "Enabled", "checkbox").checkbox !== before.enabled ||
    field(raw, ids, "Default Context", "checkbox").checkbox !== before.default_context
  )
    throw invalid("Immutable current owner metadata changed.", { page_id: owner.page_id })
  for (const name of ["Origin", "Members", "Requires"]) {
    const value = field(raw, ids, name, "relation").relation
    if (!Array.isArray(value) || value.length !== 0)
      throw invalid("The exact ready native owner gained a relationship.", { property: name })
  }
  const state = property(field(raw, ids, "Current State", "select").select).name,
    op = rich(raw, ids, "Operation")
  if (
    (phase === "initial" &&
      predecessorOperation !== undefined &&
      (state !== before.current_state || op !== predecessorOperation)) ||
    (!(state === "ready" && op === "") &&
      !(
        phase !== "initial" &&
        (state === "applying" || state === "attention") &&
        op === operation
      ) &&
      !(
        phase !== "complete" &&
        predecessorOperation !== undefined &&
        state === before.current_state &&
        op === predecessorOperation
      ))
  )
    throw invalid("The selected owner is neither ready nor owned by this finite intent.")
  const actualContent = content(raw, ids),
    description = rich(raw, ids, "Description"),
    isBefore =
      description === before.description && same(actualContent, input.main.selected.before.content),
    isAfter =
      description === owner.after.description && same(actualContent, input.main.prepared.content)
  if (!(phase === "initial" ? isBefore : phase === "complete" ? isAfter : isBefore || isAfter))
    throw invalid("Owner Description and native Content are neither the exact before nor target.", {
      page_id: owner.page_id,
      phase,
    })
  return isAfter
}
function fileMetadata(
  input: PreparedNativeEdit,
  file: BoundEdit,
  raw: unknown,
  operation: string,
  phase: Phase,
  predecessorOperation?: string,
) {
  const { library, owner } = input.selected
  if (file.selected.page_id === owner.page_id)
    return ownerMetadata(input, raw, operation, phase, predecessorOperation)
  const ids = library.files.property_ids
  livePage(raw, file.selected.page_id, library.files.data_source_id)
  const relation = field(raw, ids, "Skill", "relation").relation
  if (
    rich(raw, ids, "Name", "title") !== file.selected.name ||
    rich(raw, ids, "File ID") !== file.selected.file_id ||
    rich(raw, ids, "Path") !== file.selected.path ||
    !Array.isArray(relation) ||
    relation.length !== 1 ||
    property(relation[0]).id !== owner.page_id ||
    !same(content(raw, ids), file.selected.before.content)
  )
    throw invalid("The exact supporting File metadata or native Content changed.", {
      page_id: file.selected.page_id,
      path: file.selected.path,
    })
  return true
}

function queryPages(table: string, filter: unknown) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      rows: unknown[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        "v1/data_sources/" + table + "/query",
        {
          page_size: 100,
          filter,
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const page = yield* checked(() => {
        const outer = property(raw),
          list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          outer.object !== "list" ||
          (list.has_more
            ? !list.next_cursor || cursors.has(list.next_cursor)
            : list.next_cursor !== null)
        )
          throw invalid("The exact current scope query did not complete.")
        return list
      })
      rows.push(...page.results)
      if (!page.has_more) break
      cursor = page.next_cursor!
      cursors.add(cursor)
    }
    return rows
  })
}
function inspectMetadata(
  input: PreparedNativeEdit,
  operation: string,
  phase: Phase,
  predecessorOperation?: string,
) {
  return Effect.gen(function* () {
    const { library, owner } = input.selected,
      fileRows = yield* queryPages(library.files.data_source_id, {
        property: library.files.property_ids.Skill,
        relation: { contains: owner.page_id },
      }),
      // The owner is the final HTTP read before deciding its property PATCH.
      // The supplied index inputs below require only local validation.
      owners = yield* queryPages(library.skills.data_source_id, {
        property: library.skills.property_ids["Skill ID"],
        rich_text: { equals: owner.skill_id },
      })
    if (owners.length !== 1)
      return yield* Effect.fail(invalid("The stable Skill ID is absent or duplicated."))
    const raw = owners[0]
    const complete = yield* checked(() =>
      ownerMetadata(input, raw, operation, phase, predecessorOperation),
    )
    const files = yield* checked(() =>
      fileRows.map((row) =>
        currentFileRecord(
          row,
          owner.page_id,
          library.files.data_source_id,
          library.files.property_ids,
        ),
      ),
    )
    const index = yield* queryCurrentSkillIndex(library, owner.page_id, raw, files),
      actual = [index.main, ...index.files]
    yield* checked(() => {
      if (
        actual.length !== input.files.length ||
        actual.some(
          (file) =>
            !input.files.some(
              (selected) =>
                selected.selected.page_id === file.page_id &&
                selected.selected.file_id === file.file_id &&
                selected.selected.path === file.path &&
                file.content.kind === "native",
            ),
        )
      )
        throw invalid("The complete existing file directory changed.")
    })
    for (const file of input.files) {
      const page =
        file.selected.page_id === owner.page_id
          ? raw
          : fileRows.find((row) => property(row).id === file.selected.page_id)
      yield* checked(() => fileMetadata(input, file, page, operation, phase, predecessorOperation))
    }
    return complete
  })
}
function inspectScope(
  input: PreparedNativeEdit,
  operation: string,
  phase: Phase,
  predecessorOperation?: string,
) {
  return Effect.gen(function* () {
    yield* inspectMetadata(input, operation, phase, predecessorOperation)
    for (const file of input.files) yield* observeExpectedNativeBody(file.body, phase)
  })
}

function currentIntent(input: PreparedNativeEdit, operation: string) {
  return {
    operation_id: operation,
    owner: { kind: "skill", id: input.selected.owner.skill_id },
    input_sha256: input.input_sha256,
  } satisfies CurrentOperationIntent
}

/** Inspect both kernel coordinates and the actual Record. During replacing,
 * inspectCurrentOperation intentionally exposes the staged successor rather
 * than the remote predecessor's still-unconfirmed action. */
function inspectSuccession(input: PreparedNativeEdit, operation: string, successorOnly = false) {
  return Effect.gen(function* () {
    const { selected } = input
    if (!("predecessor" in selected))
      return yield* Effect.fail(invalid("A finite handoff requires its explicit predecessor."))
    const { library, owner, predecessor: prior } = selected,
      intent = currentIntent(input, operation),
      predecessor = {
        intent: {
          operation_id: prior.operation_id,
          input_sha256: prior.input_sha256,
          owner: intent.owner,
        },
        completion: prior.completion,
        owner_page_id: prior.owner_page_id,
        in_flight: prior.in_flight,
      } satisfies CurrentOperationPredecessor,
      current = yield* inspectCurrentOperation(library, intent.owner)
    if (current === undefined) {
      const raw = yield* (yield* Notion).request("v1/pages/" + owner.page_id)
      yield* checked(() => {
        ownerMetadata(input, raw, operation, "complete")
        if (
          property(field(raw, library.skills.property_ids, "Current State", "select").select)
            .name !== "ready" ||
          rich(raw, library.skills.property_ids, "Operation") !== ""
        )
          throw invalid("An absent operation is complete only for the exact ready target.")
      })
      return "complete" as const
    }
    const isPredecessor = same(current.intent, predecessor.intent)
    yield* checked(() => {
      if (
        current.owner_page_id !== owner.page_id ||
        current.record_page_id !== prior.record_page_id ||
        current.completion !== "ready" ||
        current.owner_in_trash !== false ||
        current.source_progress !== undefined ||
        current.local_lifecycle?.phase === "creating" ||
        (isPredecessor
          ? successorOnly ||
            current.predecessor !== undefined ||
            !same(current.in_flight, prior.in_flight)
          : !same(current.intent, intent) || !same(current.predecessor, predecessor))
      )
        throw invalid("The exact predecessor or successor operation changed before handoff.")
    })
    if (!current.record_observed) {
      if (
        !isPredecessor &&
        current.local_lifecycle?.phase === "retiring" &&
        current.owner_state?.state === "ready"
      )
        return "complete" as const
      return yield* Effect.fail(invalid("The exact handoff Record is not observable."))
    }
    // Use the current Record reader, including its singularity and envelope
    // hash checks. This is the kernel's stable identity for this exact owner.
    const record = yield* queryCurrentSharedOperationRecord(library, {
      recordId:
        "operation-current-" +
        digest(
          canonicalSharedJson([library.library_id, library.skills.data_source_id, owner.skill_id]),
        ),
      entityId: "current-skill:" + owner.skill_id,
    })
    const remoteIsPredecessor = yield* checked(() => {
      if (
        record === undefined ||
        record.page_id !== prior.record_page_id ||
        !same(record.owner, { kind: "skill", page_id: owner.page_id })
      )
        throw invalid("The handoff physical Record or its owner changed.")
      const payload = property(record.payload),
        old = record.operation_id === prior.operation_id,
        expected = {
          version: 1,
          kind: "current_operation",
          library_id: library.library_id,
          owner_data_source_id: library.skills.data_source_id,
          intent: old ? predecessor.intent : intent,
          completion: "ready",
          in_flight: old ? prior.in_flight : payload.in_flight,
          ...(old ? {} : { predecessor }),
        }
      if (
        (old
          ? successorOnly || (!isPredecessor && current.local_lifecycle?.phase !== "replacing")
          : isPredecessor || record.operation_id !== operation) ||
        !same(payload, expected)
      )
        throw invalid("The current Record payload differs from the frozen handoff.")
      return old
    })
    return remoteIsPredecessor ? ("predecessor" as const) : ("successor" as const)
  })
}

function inspectSuccessionScope(
  input: PreparedNativeEdit,
  operation: string,
  successorOnly = false,
) {
  return Effect.gen(function* () {
    const stage = yield* inspectSuccession(input, operation, successorOnly),
      phase = stage === "predecessor" ? "initial" : stage === "complete" ? "complete" : "progress",
      predecessorOperation =
        phase !== "complete" && "predecessor" in input.selected
          ? input.selected.predecessor.operation_id
          : undefined
    yield* inspectScope(input, operation, phase, predecessorOperation)
    // Neither body reads nor a staged local handoff may hide a new author edit
    // or a changed remote predecessor action before a kernel mutation.
    yield* inspectMetadata(input, operation, phase, predecessorOperation)
    if ((yield* inspectSuccession(input, operation, successorOnly)) !== stage)
      return yield* Effect.fail(invalid("The exact handoff changed during scope verification."))
  })
}

function editMode(
  input: PreparedNativeEdit,
  operation: string,
  mode: "apply" | "resume",
  supersede?: string,
): CurrentWriteMode {
  currentWriteIdentity(operation, "Operation ID")
  if (!("predecessor" in input.selected)) {
    if (supersede !== undefined) throw invalid("This input does not select a predecessor.")
    return mode
  }
  const prior = input.selected.predecessor.operation_id
  if (operation === prior || (mode === "apply" ? supersede !== prior : supersede !== undefined))
    throw invalid("Apply requires the exact --supersede predecessor; resume keeps the new input.")
  return mode === "apply" ? { kind: "supersede", operation_id: prior } : "resume"
}
function report(input: PreparedNativeEdit, operation: string, state: string) {
  return {
    contract: "current",
    kind: "ah513-ready-native-edit",
    library_id: input.selected.library.library_id,
    owner_page_id: input.selected.owner.page_id,
    skill_id: input.selected.owner.skill_id,
    operation_id: operation,
    document_sha256: input.document_sha256,
    input_sha256: input.input_sha256,
    ...("predecessor" in input.selected ? { predecessor: input.selected.predecessor } : {}),
    state,
    files: input.files.map((file) => ({
      page_id: file.selected.page_id,
      file_id: file.selected.file_id,
      path: file.selected.path,
      before_body_sha256: digest(file.body.before),
      target_body_sha256: digest(file.body.target),
      target_sha256: file.prepared.sha256,
    })),
  }
}

export function inspectCurrentNativeEdit(input: PreparedNativeEdit, operation: string) {
  return Effect.gen(function* () {
    yield* checked(() => currentWriteIdentity(operation, "Operation ID"))
    if ("predecessor" in input.selected && operation === input.selected.predecessor.operation_id)
      return yield* Effect.fail(invalid("A successor requires a new operation ID."))
    const api = yield* Notion
    const readOnly: Notion["Service"] = {
      ...api,
      readOnly: true,
      request: (path, body, options) => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        return !isCoalescibleNotionRead({
          key: "cutover-native-edit-dry-run",
          path,
          method,
          file: options?.file,
        }) ||
          (method === "GET" && body !== undefined)
          ? Effect.fail(fail("NOTION_READ_ONLY", "The finite edit dry-run cannot mutate."))
          : api.request(path, body, options)
      },
    }
    return yield* Effect.gen(function* () {
      const registration = yield* inspectBootstrapSchema(input.selected.library)
      yield* "predecessor" in input.selected
        ? inspectSuccessionScope(input, operation)
        : inspectScope(input, operation, "initial")
      return { ...report(input, operation, "dry-run"), registration, remote_writes: 0 }
    }).pipe(Effect.provideService(Notion, readOnly))
  })
}

export function editCurrentNative(
  input: PreparedNativeEdit,
  operation: string,
  mode: "apply" | "resume",
  supersede?: string,
) {
  return Effect.gen(function* () {
    const requestedMode = yield* checked(() => editMode(input, operation, mode, supersede)),
      { library, owner } = input.selected,
      registration = yield* inspectBootstrapSchema(library)
    const completed = (bodyPatches: number, metadataPatches: number) => ({
      ...report(input, operation, "ready"),
      registration,
      acknowledged_body_patches: bodyPatches,
      acknowledged_metadata_patches: metadataPatches,
    })
    const verify = () => inspectScope(input, operation, "complete")
    return yield* withCurrentOperation(library, {
      intent: currentIntent(input, operation),
      ownerPageId: owner.page_id,
      mode: requestedMode,
      ...("predecessor" in input.selected
        ? {
            assertScope: inspectSuccessionScope(input, operation),
            beforeMutation: inspectSuccessionScope(input, operation),
            afterActivate: inspectSuccessionScope(input, operation, true),
          }
        : {
            assertScope: inspectScope(input, operation, mode === "apply" ? "initial" : "progress"),
            afterActivate: inspectScope(input, operation, "progress"),
          }),
      run: (session) =>
        Effect.gen(function* () {
          let bodyPatches = 0
          for (const file of input.files)
            if (
              yield* dispatchExpectedNativeBody(session, {
                ...file.body,
                assertScope: inspectMetadata(input, operation, "progress").pipe(Effect.asVoid),
              })
            )
              bodyPatches += 1
          const metadataPatched = yield* session.dispatch({
            key: "ready-native:owner-description-content",
            replay: "idempotent",
            request: {
              path: "v1/pages/" + owner.page_id,
              body: {
                properties: {
                  [library.skills.property_ids.Description!]: {
                    rich_text: currentRecordText(owner.after.description),
                  },
                  [library.skills.property_ids.Content!]: {
                    rich_text: currentRecordText(canonicalSharedJson(input.main.prepared.content)),
                  },
                },
              },
              options: { method: "PATCH" },
            },
            observe: () =>
              Effect.gen(function* () {
                yield* session.assertCurrent()
                yield* inspectMetadata(input, operation, "progress")
                for (const file of input.files)
                  yield* observeExpectedNativeBody(file.body, "complete")
                // Body reads must not hide a concurrent Description or Content edit.
                const complete = yield* inspectMetadata(input, operation, "progress")
                return complete
                  ? { status: "complete" as const, value: false }
                  : { status: "missing" as const }
              }),
            acknowledge: () => verify().pipe(Effect.as(true)),
          })
          return completed(bodyPatches, metadataPatched ? 1 : 0)
        }),
      verify,
      verifyCompletedResume: () => verify().pipe(Effect.as(completed(0, 0))),
    })
  })
}

export function parseNativeEditArguments(args: readonly string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1]
    if (
      !key ||
      ![
        "--input",
        "--input-sha256",
        "--operation",
        "--mode",
        "--supersede",
        "--store",
        "--max-requests",
        "--max-bytes",
        "--timeout",
      ].includes(key) ||
      value === undefined ||
      values.has(key)
    )
      throw invalid("Supply each documented option once with an explicit value.")
    values.set(key, value)
  }
  const absolute = (key: string) => {
    const value = values.get(key)
    if (!value || !isAbsolute(value)) throw invalid(key + " requires an absolute path.")
    return resolve(value)
  }
  const positive = (key: string) => {
    const value = values.get(key)
    if (!value || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw invalid(key + " requires a positive integer.")
    return Number(value)
  }
  const operation = values.get("--operation")
  if (!operation) throw invalid("Select a stable operation ID.")
  currentWriteIdentity(operation, "Operation ID")
  const mode = Schema.decodeUnknownSync(Schema.Literals(["dry-run", "apply", "resume"]))(
      values.get("--mode"),
    ),
    supersede = values.get("--supersede")
  if (supersede !== undefined) {
    currentWriteIdentity(supersede, "Predecessor operation ID")
    if (mode !== "apply") throw invalid("Only apply accepts --supersede.")
  }
  return {
    input: absolute("--input"),
    input_sha256: Schema.decodeUnknownSync(Hash)(values.get("--input-sha256")),
    operation,
    mode,
    supersede,
    store: absolute("--store"),
    limits: {
      requests: positive("--max-requests"),
      bytes: positive("--max-bytes"),
      duration_ms: positive("--timeout"),
    } satisfies RequestBudgetLimits,
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
      return yield* Effect.fail(fail("CONFIG_ERROR", "The project token is invalid."))
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
      "node scripts/cutover-edit-current-native.ts --input ABS --input-sha256 SHA256 --operation ID --mode dry-run|apply|resume [--supersede OLD] --store ABS --max-requests N --max-bytes N --timeout MS\nAH-513 only; delete with AH-517. One exact native owner, two existing files, empty relations. Apply with a frozen predecessor requires --supersede OLD. Only authored bodies, Description and main Content may change. No library marker, schema, Source or File creation. Resume requires identical input, operation and Store, without --supersede.\n",
    )
    return
  }
  const options = parseNativeEditArguments(process.argv.slice(2))
  const input = await Effect.runPromise(
    prepareNativeEditInput({
      bytes: readRegular(options.input),
      sha256: options.input_sha256,
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
          inspectCurrentNativeEdit(input, options.operation),
          options.limits,
        ).pipe(
          Effect.bind("request_metrics", () =>
            Effect.map(Notion, (api) => api.requestMetrics?.() ?? null),
          ),
          Effect.provide(Layer.mergeAll(runtime, storeRuntime)),
          Effect.map((value) => JSON.stringify(value)),
        )
      : withCurrentInvocationBudget(
          editCurrentNative(input, options.operation, options.mode, options.supersede),
          options.limits,
        ).pipe(
          Effect.bind("request_metrics", () =>
            Effect.map(Notion, (api) => api.requestMetrics?.() ?? null),
          ),
          Effect.provide(Layer.mergeAll(runtime, storeRuntime)),
          Effect.map((value) => JSON.stringify(value)),
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
            ...report(input, options.operation, "interrupted"),
            next: "Repeat the identical input with --mode resume and the same --store.",
          }) + "\n",
        )
        process.exitCode = 130
        return
      }
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      if (error instanceof SkillsError) throw error
      throw invalid("The finite current edit stopped before completion.")
    }
    process.stdout.write(exit.value + "\n")
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    const value =
      error instanceof SkillsError
        ? { code: error.code, message: error.message, details: error.details }
        : { code: "CUTOVER_NATIVE_EDIT_INVALID", message: "The finite native edit failed." }
    process.stderr.write(JSON.stringify(value) + "\n")
    process.exitCode = 1
  })
