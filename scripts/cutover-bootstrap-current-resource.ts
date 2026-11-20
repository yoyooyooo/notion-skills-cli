/** AH-513 only. Convert one captured existing main file to its current resource.
 * Delete with AH-517. No supporting Files, uploads, Source writes or old reader.
 * The existing operation kernel owns all mutations and unknown outcomes. */
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  Cause,
  Config,
  ConfigProvider,
  type Crypto,
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
import { CurrentResourceContentSchema } from "../packages/core/src/shared-current-file.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { withCurrentInvocationBudget } from "../packages/core/src/shared-current-invocation.ts"
import {
  withCurrentOperation,
  type CurrentOperationSession,
} from "../packages/core/src/shared-current-operation.ts"
import {
  applyCurrentProjection,
  assertCurrentBodyReplaceable,
  currentProjectionBatches,
  inspectCurrentProjection,
  renderCurrentProjection,
  type CurrentProjectionDispatch,
  type CurrentProjectionPlan,
} from "../packages/core/src/shared-current-projection.ts"
import {
  currentOwnedResourceCreateRequest,
  currentOwnedResourceFromPage,
  currentRecordText,
  queryCurrentOwnedResourceRecord,
} from "../packages/core/src/shared-current-records.ts"
import { validatePreparedCurrentSharedResource } from "../packages/core/src/shared-current-resource.ts"
import {
  currentWriteIdentity,
  prepareCurrentSkillWrite,
  type PreparedCurrentSkillWrite,
  type PreparedCurrentWriteFile,
} from "../packages/core/src/shared-current-write-input.ts"
import { SharedLibrarySchema } from "../packages/core/src/shared-library-model.ts"
import { observeSharedBody } from "../packages/core/src/shared-page-body.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { isCoalescibleNotionRead } from "../packages/core/src/shared-read-coalescing.ts"
import { sha256, type Store } from "../packages/core/src/store.ts"
import { inspectBootstrapSchema } from "./cutover-bootstrap-current.ts"

const PageId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const PropertyGuard = Schema.Struct({ id: Schema.String, sha256: Hash })
const ResourceBootstrapSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("ah513-existing-resource-bootstrap"),
  library: SharedLibrarySchema,
  owner: Schema.Struct({
    page_id: PageId,
    skill_id: Schema.String,
    main_file_id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    kind: Schema.Literal("skill"),
    enabled: Schema.Boolean,
    default_context: Schema.Boolean,
    tags: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.String }),
    ),
    before: Schema.Struct({
      content: Schema.Literal(""),
      state: Schema.Null,
      operation: Schema.Literal(""),
      origin: Schema.Array(PageId),
      members: Schema.Array(PageId),
      requires: Schema.Array(PageId),
      body: Schema.Struct({ local_path: Schema.String, sha256: Hash, bytes: Size }),
    }),
  }),
  file: Schema.Struct({
    path: Schema.Literal("SKILL.md"),
    local_bytes_path: Schema.String,
    sha256: Hash,
    bytes: Size,
    mode: Schema.Literals(["100644", "100755"]),
    content: CurrentResourceContentSchema,
  }),
  origin_after: Schema.Array(PageId),
  before_selection: Schema.Struct({
    owner_properties: Schema.Array(PropertyGuard),
    carrier: Schema.Struct({ page_id: PageId, properties: Schema.Array(PropertyGuard) }),
  }),
})
type Selected = typeof ResourceBootstrapSchema.Type
type ResourceFile = Extract<PreparedCurrentWriteFile, { readonly kind: "resource" }>
type Phase = "initial" | "progress" | "complete"
type BodyStage = "before" | "empty" | "target"
export type PreparedResourceBootstrap = {
  readonly selected: Selected
  readonly plan: PreparedCurrentSkillWrite
  readonly file: ResourceFile
  readonly projection: CurrentProjectionPlan
  readonly before_body: string
  readonly document_sha256: string
  readonly input_sha256: string
}
const invalid = (message: string, details?: unknown) =>
  fail("CUTOVER_RESOURCE_INVALID", message, details)
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The finite resource conversion is invalid."),
  })
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)

function readRegular(path: string): Buffer {
  if (!isAbsolute(path)) throw invalid("Every input path must be absolute.", { path })
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > 8 * 1024 * 1024)
      throw invalid("A finite input must be a regular file of at most 8 MiB.", { path })
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
      throw invalid("A frozen input changed while being read.", { path })
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

/** document is the original JSON byte sequence, not a parsed or reserialized value. */
export function prepareResourceBootstrapInput(input: {
  readonly document: Uint8Array
  readonly input_sha256: string
}) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      Schema.decodeUnknownSync(Hash)(input.input_sha256)
      if (
        input.document.byteLength > 8 * 1024 * 1024 ||
        digest(input.document) !== input.input_sha256
      )
        throw invalid("The frozen JSON differs from its selected SHA-256.")
      const value = Schema.decodeUnknownSync(ResourceBootstrapSchema)(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.document)),
        { onExcessProperty: "error" },
      )
      currentWriteIdentity(value.owner.skill_id, "Skill ID")
      currentWriteIdentity(value.owner.main_file_id, "Main File ID")
      if (
        value.owner.before.origin.length !== 1 ||
        value.owner.before.members.length ||
        value.owner.before.requires.length ||
        value.origin_after.length
      )
        throw invalid("Select one captured Origin to clear and empty Members/Requires.")
      if (new Set(value.owner.tags.map((tag) => tag.id)).size !== value.owner.tags.length)
        throw invalid("The captured Tags repeat an identity.")
      const selection = value.before_selection
      if (
        selection.owner_properties.length === 0 ||
        selection.owner_properties.length > 8 ||
        new Set(selection.owner_properties.map((guard) => guard.id)).size !==
          selection.owner_properties.length ||
        new Set(selection.carrier.properties.map((guard) => guard.id)).size !==
          selection.carrier.properties.length
      )
        throw invalid("Freeze the exact selection properties once each.")
      const mutable = ["Content", "Current State", "Operation", "Origin"].map(
        (name) => value.library.skills.property_ids[name],
      )
      if (selection.owner_properties.some((guard) => !guard.id || mutable.includes(guard.id)))
        throw invalid("A before-selection guard cannot bind a field changed by this conversion.")
      for (const name of ["Record ID", "Entity ID", "Kind", "Hash", "Payload", "Skill", "Origin"])
        if (
          !selection.carrier.properties.some(
            (guard) => guard.id === value.library.records.property_ids[name],
          )
        )
          throw invalid(
            "The selected carrier requires its exact identity, payload and ownership guards.",
            { property: name },
          )
      return value
    })
    const captured = yield* checked(() => {
      const original = readRegular(selected.file.local_bytes_path)
      const body = readRegular(selected.owner.before.body.local_path)
      if (
        original.byteLength !== selected.file.bytes ||
        digest(original) !== selected.file.sha256 ||
        body.byteLength !== selected.owner.before.body.bytes ||
        digest(body) !== selected.owner.before.body.sha256
      )
        throw invalid("A captured original or current page body differs from its declared bytes.")
      return { original, body: new TextDecoder("utf-8", { fatal: true }).decode(body) }
    })
    const owner = selected.owner
    const plan = yield* prepareCurrentSkillWrite({
      skill_id: owner.skill_id,
      name: owner.name,
      description: owner.description,
      kind: owner.kind,
      enabled: owner.enabled,
      default_context: owner.default_context,
      files: [
        {
          path: selected.file.path,
          bytes: captured.original,
          mode: selected.file.mode,
          file_id: owner.main_file_id,
          authority: { kind: "resource" },
        },
      ],
    })
    const prepared = yield* checked(() => {
      const file = plan.files[0]
      if (
        plan.files.length !== 1 ||
        plan.main !== "SKILL.md" ||
        file?.kind !== "resource" ||
        file.resource.status !== "inline" ||
        !same(file.content, selected.file.content)
      )
        throw invalid("Only one exact existing inline resource main is admitted.")
      const projection = renderCurrentProjection({ path: file.path, bytes: file.bytes })
      if (
        projection.representation !== "markdown" ||
        projection.blocks.length === 0 ||
        currentProjectionBatches(projection.blocks).length !== 1
      )
        throw invalid("This finite resource requires one complete readable projection batch.")
      return { file, projection }
    })
    const inputHash = yield* sha256(
      canonicalSharedJson({
        kind: selected.kind,
        document_sha256: input.input_sha256,
        prepared_input_sha256: plan.input_sha256,
        projection: prepared.projection,
      }),
    )
    return {
      selected,
      plan,
      ...prepared,
      before_body: captured.body,
      document_sha256: input.input_sha256,
      input_sha256: inputHash,
    } satisfies PreparedResourceBootstrap
  })
}

function exactProperty(raw: unknown, id: string) {
  const matches = Object.entries(property(property(raw).properties)).flatMap(([key, value]) =>
    key === id || property(value).id === id ? [property(value)] : [],
  )
  const field = matches[0]
  if (
    !id ||
    matches.length !== 1 ||
    field === undefined ||
    field.id !== id ||
    field.has_more === true
  )
    throw invalid("An exact property is missing, duplicated or incomplete.", { property_id: id })
  return field
}
function field(raw: unknown, ids: Readonly<Record<string, string>>, name: string, type: string) {
  const value = exactProperty(raw, ids[name] ?? "")
  if (value.type !== type) throw invalid("The current property type changed.", { property: name })
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
    throw invalid("A current text property is incomplete.", { property: name })
  return text(value[type])
}
function livePage(raw: unknown, page: string, table: string) {
  const value = property(raw),
    parent = property(value.parent)
  if (
    value.object !== "page" ||
    value.id !== page ||
    value.in_trash === true ||
    value.archived === true ||
    value.is_archived === true ||
    parent.type !== "data_source_id" ||
    parent.data_source_id !== table
  )
    throw invalid("The exact physical page is unavailable or changed table.", { page_id: page })
}
function assertGuards(raw: unknown, guards: readonly (typeof PropertyGuard.Type)[]) {
  for (const guard of guards)
    if (digest(canonicalSharedJson(exactProperty(raw, guard.id))) !== guard.sha256)
      throw fail(
        "CUTOVER_RESOURCE_SELECTION_CHANGED",
        "The approved current original selection or carrier changed.",
        {
          page_id: property(raw).id,
          property_id: guard.id,
        },
      )
}
function relation(raw: unknown, ids: Readonly<Record<string, string>>, name: string) {
  const values = field(raw, ids, name, "relation").relation
  if (!Array.isArray(values)) throw invalid("A current relation is incomplete.", { property: name })
  const result = values.map((value) => Schema.decodeUnknownSync(PageId)(property(value).id))
  if (new Set(result).size !== result.length) throw invalid("A current relation repeats a page.")
  return result.sort()
}
function assertMetadata(
  input: PreparedResourceBootstrap,
  operation: string,
  raw: unknown,
  phase: Phase,
  initialApply = false,
) {
  const { owner, library } = input.selected,
    ids = library.skills.property_ids
  livePage(raw, owner.page_id, library.skills.data_source_id)
  const tags = field(raw, ids, "Tags", "multi_select").multi_select
  if (
    rich(raw, ids, "Skill ID") !== owner.skill_id ||
    rich(raw, ids, "Main File ID") !== owner.main_file_id ||
    rich(raw, ids, "Name", "title") !== owner.name ||
    rich(raw, ids, "Description") !== owner.description ||
    property(field(raw, ids, "Kind", "select").select).name !== owner.kind ||
    field(raw, ids, "Enabled", "checkbox").checkbox !== owner.enabled ||
    field(raw, ids, "Default Context", "checkbox").checkbox !== owner.default_context ||
    !Array.isArray(tags) ||
    !same(tags, owner.tags) ||
    relation(raw, ids, "Members").length ||
    relation(raw, ids, "Requires").length
  )
    throw invalid("The captured owner metadata, identity or relation scope changed.", {
      page_id: owner.page_id,
    })
  const content = rich(raw, ids, "Content"),
    origin = relation(raw, ids, "Origin")
  const before = content === "" && same(origin, [...owner.before.origin].sort())
  const target = content === canonicalSharedJson(input.file.content) && origin.length === 0
  if ((!before && !target) || (phase === "initial" && !before) || (phase === "complete" && !target))
    throw invalid("Content and Origin are neither the exact captured pair nor the target pair.")
  if (before) assertGuards(raw, input.selected.before_selection.owner_properties)
  const state = field(raw, ids, "Current State", "select").select,
    op = rich(raw, ids, "Operation")
  const blank = state === null && op === "" && before
  const current = property(state).name
  if (
    phase === "initial"
      ? !blank
      : !(blank && phase !== "complete") &&
        !((current === "applying" || current === "attention") && op === operation) &&
        !(current === "ready" && op === "" && target && !initialApply)
  )
    throw invalid("This owner is not uninitialized or owned by the exact resource operation.")
  return { stage: target ? ("target" as const) : ("before" as const), raw }
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
        { page_size: 100, filter, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const value = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          property(raw).object !== "list" ||
          (value.has_more
            ? !value.next_cursor || cursors.has(value.next_cursor)
            : value.next_cursor !== null)
        )
          throw invalid("The current metadata query is incomplete.")
        for (const row of value.results) {
          const page = Schema.decodeUnknownSync(PageId)(property(row).id)
          livePage(row, page, table)
          if (seen.has(page)) throw invalid("A current query repeated a physical page.")
          seen.add(page)
        }
        return value
      })
      rows.push(...list.results)
      if (!list.has_more) return rows
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
  })
}
/** Files are completely checked first. The last metadata HTTP read is the exact owner. */
function inspectMetadata(
  input: PreparedResourceBootstrap,
  operation: string,
  phase: Phase,
  initialApply = false,
) {
  return Effect.gen(function* () {
    const { library, owner } = input.selected
    const files = yield* queryPages(library.files.data_source_id, {
      property: library.files.property_ids.Skill,
      relation: { contains: owner.page_id },
    })
    if (files.length)
      return yield* Effect.fail(invalid("This complete owner must have no supporting Files."))
    const owners = yield* queryPages(library.skills.data_source_id, {
      property: library.skills.property_ids["Skill ID"],
      rich_text: { equals: owner.skill_id },
    })
    return yield* checked(() => {
      if (owners.length !== 1)
        throw invalid("The exact stable Skill identity is absent or ambiguous.")
      return assertMetadata(input, operation, owners[0], phase, initialApply)
    })
  })
}
function inspectCarrier(input: PreparedResourceBootstrap) {
  return Effect.gen(function* () {
    const { library, before_selection } = input.selected,
      carrier = before_selection.carrier
    const raw = yield* (yield* Notion).request(`v1/pages/${carrier.page_id}`, undefined, {
      content: "body",
    })
    yield* checked(() => {
      livePage(raw, carrier.page_id, library.records.data_source_id)
      assertGuards(raw, carrier.properties)
    })
  })
}
const resourceOwner = (input: PreparedResourceBootstrap) => ({
  kind: "skill" as const,
  page_id: input.selected.owner.page_id,
})
function inspectResource(input: PreparedResourceBootstrap, required: boolean) {
  return Effect.gen(function* () {
    const found = yield* queryCurrentOwnedResourceRecord(input.selected.library, {
      owner: resourceOwner(input),
      objectId: input.file.content.object_id,
    })
    if (found === undefined) {
      if (required)
        return yield* Effect.fail(invalid("The exact current owned resource is missing."))
      return undefined
    }
    const verified = yield* validatePreparedCurrentSharedResource({
      status: "inline",
      content: input.file.content,
      manifest: found.record.payload,
    })
    yield* checked(() => {
      const attachment = property(found.resource)
      if (
        verified.uploadBytes !== undefined ||
        !Buffer.from(verified.bytes).equals(Buffer.from(input.file.bytes)) ||
        attachment.type !== "files" ||
        attachment.has_more === true ||
        !Array.isArray(attachment.files) ||
        attachment.files.length
      )
        throw invalid("The current resource does not contain the exact inline original.")
    })
    return found
  })
}
function inspectBody(
  input: PreparedResourceBootstrap,
  allowProjection: boolean,
): Effect.Effect<BodyStage, SkillsError, Notion | Crypto.Crypto> {
  return Effect.gen(function* () {
    const page = input.selected.owner.page_id
    if (allowProjection) {
      // Content already binds the verified resource. Empty is the existing
      // projection protocol's complete clear boundary, not a native body or
      // proof of who cleared it. No extra durable phase is invented here.
      if ((yield* inspectCurrentProjection({ pageId: page, plan: input.projection })).matches)
        return "target" as const
      if (
        (yield* inspectCurrentProjection({
          pageId: page,
          plan: { ...input.projection, blocks: [] },
        })).matches
      )
        return "empty" as const
    }
    const body = yield* observeSharedBody(page)
    if (body.markdown !== input.before_body)
      return yield* Effect.fail(
        fail(
          "CUTOVER_RESOURCE_BODY_CHANGED",
          "The body is outside the exact baseline or current projection states.",
          {
            page_id: page,
            before_sha256: digest(input.before_body),
            actual_sha256: digest(body.markdown),
          },
        ),
      )
    return "before" as const
  })
}
/** Costly body/resource/carrier reads precede the final complete metadata observation. */
function inspectScope(
  input: PreparedResourceBootstrap,
  operation: string,
  options: {
    readonly phase?: Phase
    readonly initialApply?: boolean
    readonly resourceRequired?: boolean
    readonly targetRequired?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const phase = options.phase ?? "progress"
    const before = yield* inspectMetadata(input, operation, phase, options.initialApply)
    const resource = yield* inspectResource(
      input,
      options.resourceRequired === true || before.stage === "target",
    )
    const body = yield* inspectBody(input, phase !== "initial" && before.stage === "target")
    if (before.stage === "before") yield* assertCurrentBodyReplaceable(input.selected.owner.page_id)
    if (phase === "complete" && body !== "target")
      return yield* Effect.fail(
        invalid("The complete generated reading projection is not present."),
      )
    if (before.stage === "before") yield* inspectCarrier(input)
    const after = yield* inspectMetadata(input, operation, phase, options.initialApply)
    if (before.stage !== after.stage || (options.targetRequired && after.stage !== "target"))
      return yield* Effect.fail(invalid("Current authority changed during this scope observation."))
    if (phase === "complete") {
      const index = yield* queryCurrentSkillIndex(
        input.selected.library,
        input.selected.owner.page_id,
        after.raw,
        [],
      )
      if (
        index.main.file_id !== input.selected.owner.main_file_id ||
        index.main.path !== input.file.path ||
        !same(index.main.content, input.file.content) ||
        index.files.length
      )
        return yield* Effect.fail(
          invalid("The complete current index differs from this exact resource tree."),
        )
    }
    return { ...after, body, resource }
  })
}
function result(input: PreparedResourceBootstrap, operation: string, state: string) {
  return {
    kind: input.selected.kind,
    state,
    operation_id: operation,
    input_sha256: input.input_sha256,
    document_sha256: input.document_sha256,
    prepared_input_sha256: input.plan.input_sha256,
    library_id: input.selected.library.library_id,
    owner_page_id: input.selected.owner.page_id,
    skill_id: input.selected.owner.skill_id,
    file_id: input.selected.owner.main_file_id,
    path: input.file.path,
    content: input.file.content,
    projection_blocks: input.projection.blocks.length,
    supporting_files: 0,
    uploads: 0,
  }
}
export function inspectResourceBootstrap(input: PreparedResourceBootstrap, operation: string) {
  return Effect.gen(function* () {
    currentWriteIdentity(operation, "Operation ID")
    const api = yield* Notion
    const readOnly: Notion["Service"] = {
      ...api,
      readOnly: true,
      request: (path, body, options) => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        return !isCoalescibleNotionRead({
          key: "cutover-resource-dry-run",
          path,
          method,
          file: options?.file,
        }) ||
          (method === "GET" && body !== undefined)
          ? Effect.fail(fail("NOTION_READ_ONLY", "Resource dry-run cannot dispatch a mutation."))
          : api.request(path, body, options)
      },
    }
    return yield* Effect.gen(function* () {
      const registration = yield* inspectBootstrapSchema(input.selected.library)
      const current = yield* inspectScope(input, operation)
      return {
        ...result(input, operation, "dry-run"),
        registration,
        resource_present: current.resource !== undefined,
        remote_writes: 0,
      }
    }).pipe(Effect.provideService(Notion, readOnly))
  })
}
export function bootstrapCurrentResource(
  input: PreparedResourceBootstrap,
  operation: string,
  mode: "apply" | "resume",
) {
  return Effect.gen(function* () {
    const { library, owner } = input.selected
    const registration = yield* inspectBootstrapSchema(library)
    const verify = () =>
      inspectScope(input, operation, { phase: "complete", resourceRequired: true }).pipe(
        Effect.asVoid,
      )
    return yield* withCurrentOperation(library, {
      intent: {
        operation_id: operation,
        input_sha256: input.input_sha256,
        owner: { kind: "skill", id: owner.skill_id },
      },
      ownerPageId: owner.page_id,
      mode,
      bootstrapExistingOwner: {
        assertUninitialized: () =>
          inspectScope(input, operation, { phase: "initial" }).pipe(Effect.asVoid),
      },
      assertScope: inspectScope(input, operation, { initialApply: mode === "apply" }).pipe(
        Effect.asVoid,
      ),
      run: (session: CurrentOperationSession) =>
        Effect.gen(function* () {
          const request = yield* currentOwnedResourceCreateRequest(library, {
            owner: resourceOwner(input),
            objectId: input.file.content.object_id,
            payload: input.file.resource.manifest,
          })
          yield* session.dispatch({
            key: `resource:${input.file.content.object_id}:create`,
            replay: "never",
            request,
            observe: () =>
              Effect.gen(function* () {
                yield* session.assertCurrent()
                const current = yield* inspectScope(input, operation)
                return current.resource === undefined
                  ? { status: "missing" as const }
                  : { status: "complete" as const, value: undefined }
              }),
            acknowledge: (raw) =>
              Effect.gen(function* () {
                yield* currentOwnedResourceFromPage(library, raw, {
                  owner: resourceOwner(input),
                  objectId: input.file.content.object_id,
                })
                yield* inspectScope(input, operation, { resourceRequired: true })
              }),
          })
          yield* session.dispatch({
            key: `bootstrap-resource:${owner.page_id}:content-origin`,
            replay: "idempotent",
            request: {
              path: `v1/pages/${owner.page_id}`,
              body: {
                properties: {
                  [library.skills.property_ids.Content!]: {
                    rich_text: currentRecordText(canonicalSharedJson(input.file.content)),
                  },
                  [library.skills.property_ids.Origin!]: { relation: [] },
                },
              },
              options: { method: "PATCH" },
            },
            observe: () =>
              Effect.gen(function* () {
                yield* session.assertCurrent()
                const current = yield* inspectScope(input, operation, { resourceRequired: true })
                return current.stage === "target"
                  ? { status: "complete" as const, value: undefined }
                  : { status: "missing" as const }
              }),
            acknowledge: (raw) =>
              Effect.gen(function* () {
                yield* checked(() => assertMetadata(input, operation, raw, "complete"))
                yield* inspectScope(input, operation, {
                  resourceRequired: true,
                  targetRequired: true,
                })
              }),
          })
          const assertCurrent = session
            .assertCurrent()
            .pipe(
              Effect.andThen(
                inspectScope(input, operation, { resourceRequired: true, targetRequired: true }),
              ),
              Effect.asVoid,
            )
          const dispatch: CurrentProjectionDispatch<Notion | Crypto.Crypto | Store> = (action) =>
            session.dispatch({
              ...action,
              observe: () =>
                Effect.gen(function* () {
                  // Existing projection code establishes complete batch/prefix semantics.
                  const observed = yield* action.observe({ fresh: true })
                  const current = yield* inspectScope(input, operation, {
                    resourceRequired: true,
                    targetRequired: true,
                  })
                  const clear = action.key === `projection:${owner.page_id}:clear`
                  const matches = clear
                    ? observed.status === "complete"
                      ? current.body !== "before"
                      : current.body === "before"
                    : observed.status === "complete"
                      ? current.body === "target"
                      : current.body === "empty"
                  if (!matches)
                    return yield* Effect.fail(
                      invalid("The projection changed during its final scope observation."),
                    )
                  return observed
                }),
              acknowledge: (raw) => action.acknowledge(raw).pipe(Effect.tap(() => assertCurrent)),
            })
          yield* applyCurrentProjection({
            pageId: owner.page_id,
            content: input.file.content,
            plan: input.projection,
            assertCurrent,
            dispatch,
          })
          return { ...result(input, operation, "ready"), registration }
        }),
      verify,
      verifyCompletedResume: () =>
        verify().pipe(Effect.as({ ...result(input, operation, "ready"), registration })),
    })
  })
}

export function parseResourceBootstrapArguments(args: readonly string[]) {
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
  const operation = currentWriteIdentity(values.get("--operation") ?? "", "Operation ID")
  return {
    input: absolute("--input"),
    input_sha256: Schema.decodeUnknownSync(Hash)(values.get("--input-sha256")),
    operation,
    mode: Schema.decodeUnknownSync(Schema.Literals(["dry-run", "apply", "resume"]))(
      values.get("--mode"),
    ),
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
      "node scripts/cutover-bootstrap-current-resource.ts --input ABS --input-sha256 SHA256 --operation ID --mode dry-run|apply|resume --store ABS --max-requests N --max-bytes N --timeout MS\nAH-513 only; delete with AH-517. One existing main inline resource, one explicit old Origin to clear, no supporting Files or uploads. Preserve original carriers until the new resource and projection are verified. Unknown CREATE is never replayed. Resume uses identical input, operation and Store. No schema or registration writes.\n",
    )
    return
  }
  const options = parseResourceBootstrapArguments(process.argv.slice(2))
  const input = await Effect.runPromise(
    prepareResourceBootstrapInput({
      document: readRegular(options.input),
      input_sha256: options.input_sha256,
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
  const program =
    options.mode === "dry-run"
      ? inspectResourceBootstrap(input, options.operation)
      : bootstrapCurrentResource(input, options.operation, options.mode)
  const work = withCurrentInvocationBudget(program, options.limits).pipe(
    Effect.exit,
    Effect.bindTo("exit"),
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
    const completed = await Effect.runPromiseExit(
      work.pipe(Effect.provide(configuration), Effect.scoped),
      { signal: abort.signal },
    )
    const failed = (cause: Cause.Cause<unknown>, metrics: unknown) => {
      const error = Option.getOrUndefined(Cause.findErrorOption(cause))
      const cancelled = Cause.hasInterruptsOnly(cause)
      process.stderr.write(
        JSON.stringify({
          ...(error instanceof SkillsError
            ? { code: error.code, message: error.message, details: error.details }
            : {
                code: cancelled ? "CANCELLED" : "CUTOVER_RESOURCE_INVALID",
                message: "The finite resource conversion stopped before completion.",
              }),
          ...result(input, options.operation, "unfinished"),
          request_metrics: metrics,
          next: "Inspect the current intent; resume only with identical input, operation and Store.",
        }) + "\n",
      )
      process.exitCode = cancelled ? 130 : 1
    }
    if (Exit.isFailure(completed)) failed(completed.cause, null)
    else {
      const { exit, request_metrics } = completed.value
      if (Exit.isFailure(exit)) failed(exit.cause, request_metrics)
      else process.stdout.write(JSON.stringify({ ...exit.value, request_metrics }) + "\n")
    }
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
          : { code: "CUTOVER_RESOURCE_INVALID", message: "The finite resource input failed." },
      ) + "\n",
    )
    process.exitCode = 1
  })
