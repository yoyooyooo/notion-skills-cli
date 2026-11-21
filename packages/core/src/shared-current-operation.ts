import { Crypto, Effect, Schema } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import {
  CurrentSourceIdSchema,
  parseCurrentFileContent,
  parseCurrentSkillState,
} from "./shared-current-file.ts"
import { currentFileRecord } from "./shared-current-index.ts"
import {
  archiveCurrentSharedOperationRecord,
  assertCurrentOperationRecordSize,
  currentRecordText,
  queryCurrentSharedOperationRecord,
  replaceCurrentSharedOperationRecord,
  writeCurrentSharedOperationRecord,
} from "./shared-current-records.ts"
import { CurrentSourceInputSchema } from "./shared-current-source-action.ts"
import { CurrentProjectionPolicySchema } from "./shared-current-projection-policy.ts"
import { CurrentSkillRegistrationInputSchema } from "./shared-current-skill-register-input.ts"
import { CurrentSkillRemovalInputSchema } from "./shared-current-skill-remove-input.ts"
import { CurrentSkillPatchScopeSchema } from "./shared-current-skill-patch-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const StableId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const CurrentOperationOwnerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("skill"), id: StableId }),
  Schema.Struct({ kind: Schema.Literal("source"), id: CurrentSourceIdSchema }),
])
export type CurrentOperationOwner = typeof CurrentOperationOwnerSchema.Type
export const CurrentSourceIntentBindingSchema = Schema.Struct({
  source_id: CurrentSourceIdSchema,
  source_page_id: Schema.String,
  operation_id: StableId,
  input_sha256: Hash,
  authorization_sha256: Hash,
})
export type CurrentSourceIntentBinding = typeof CurrentSourceIntentBindingSchema.Type
export const CurrentOperationIntentSchema = Schema.Union([
  Schema.Struct({
    operation_id: StableId,
    input_sha256: Hash,
    owner: Schema.Struct({ kind: Schema.Literal("skill"), id: StableId }),
    skill_action: Schema.Union([
      CurrentSkillRegistrationInputSchema,
      CurrentSkillRemovalInputSchema,
      Schema.Struct({ kind: Schema.Literal("update"), scope: CurrentSkillPatchScopeSchema }),
    ]),
  }),
  Schema.Struct({
    operation_id: StableId,
    input_sha256: Hash,
    owner: Schema.Struct({ kind: Schema.Literal("skill"), id: StableId }),
    projection: Schema.Literal(true),
    policy: CurrentProjectionPolicySchema,
  }),
  Schema.Struct({
    operation_id: StableId,
    input_sha256: Hash,
    owner: Schema.Struct({ kind: Schema.Literal("skill"), id: StableId }),
    restore: Schema.Struct({ page_id: Schema.String, policy: CurrentProjectionPolicySchema }),
  }),
  Schema.Struct({
    operation_id: StableId,
    input_sha256: Hash,
    owner: Schema.Struct({ kind: Schema.Literal("skill"), id: StableId }),
    source: Schema.optional(CurrentSourceIntentBindingSchema),
  }),
  Schema.Struct({
    operation_id: StableId,
    input_sha256: Hash,
    owner: Schema.Struct({ kind: Schema.Literal("source"), id: CurrentSourceIdSchema }),
    source_input: CurrentSourceInputSchema,
  }),
])
export type CurrentOperationIntent = typeof CurrentOperationIntentSchema.Type
export type CurrentProjectionIntent = Extract<CurrentOperationIntent, { readonly projection: true }>
export type CurrentSkillRestoreIntent = Extract<
  CurrentOperationIntent,
  { readonly restore: unknown }
>
const ActionSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  request_sha256: Hash,
  replay: Schema.Literals(["never", "idempotent"]),
})
export type CurrentActionMarker = typeof ActionSchema.Type
type ActionMarker = CurrentActionMarker
const SourceProgressSchema = Schema.Struct({
  next_index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  child_started: Schema.Boolean,
})
export type CurrentSourceProgress = typeof SourceProgressSchema.Type
export type CurrentWriteMode =
  | "apply"
  | "resume"
  | { readonly kind: "supersede"; readonly operation_id: string }
const CompletionSchema = Schema.Literals(["ready", "retired"])
const PredecessorSchema = Schema.Struct({
  intent: CurrentOperationIntentSchema,
  completion: CompletionSchema,
  owner_page_id: Schema.NullOr(Schema.String),
  in_flight: Schema.NullOr(ActionSchema),
  source_progress: Schema.optional(SourceProgressSchema),
})
export type CurrentOperationPredecessor = typeof PredecessorSchema.Type

const PayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("current_operation"),
  library_id: Schema.String,
  owner_data_source_id: Schema.String,
  intent: CurrentOperationIntentSchema,
  in_flight: Schema.NullOr(ActionSchema),
  source_progress: Schema.optional(SourceProgressSchema),
  completion: CompletionSchema,
  predecessor: Schema.optional(PredecessorSchema),
})
type CurrentPayload = typeof PayloadSchema.Type
export const CurrentWritePendingSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Schema.String,
  record_id: Schema.String,
  intent: CurrentOperationIntentSchema,
  completion: CompletionSchema,
  owner_page_id: Schema.NullOr(Schema.String),
  predecessor: Schema.optional(PredecessorSchema),
  lifecycle: Schema.Union([
    Schema.Struct({
      phase: Schema.Literal("replacing"),
      record_page_id: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ phase: Schema.Literal("creating") }),
    Schema.Struct({
      phase: Schema.Literals(["active", "retiring"]),
      record_page_id: Schema.String,
    }),
  ]),
  not_dispatched: Schema.optional(ActionSchema),
})
type LocalPending = typeof CurrentWritePendingSchema.Type
type RequestOptions = NonNullable<Parameters<Notion["Service"]["request"]>[2]>
export type CurrentActionObservation<A> =
  | { readonly status: "complete"; readonly value: A }
  | { readonly status: "missing" }
export type CurrentOperationAction<A, R = never> = {
  readonly key: string
  readonly request: {
    readonly path: string
    readonly body?: unknown
    readonly options?: RequestOptions
  }
  /** Multipart paths are local. Their exact bytes supply the current request identity. */
  readonly fileSha256?: string
  readonly replay: "never" | "idempotent"
  readonly observe: (options: {
    readonly fresh: boolean
  }) => Effect.Effect<CurrentActionObservation<A>, SkillsError, R>
  readonly acknowledge?: (response: unknown) => Effect.Effect<A, SkillsError, R>
}
export type CurrentOperationSession = {
  readonly operation_id: string
  readonly intent: CurrentOperationIntent
  readonly owner: CurrentOperationOwner
  readonly ownerPageId: string | null
  readonly ownerRetired: boolean
  readonly predecessor: CurrentOperationPredecessor | undefined
  readonly pendingActionKey: string | undefined
  readonly sourceProgress: CurrentSourceProgress | undefined
  readonly markSourceChildStarted: (
    skillId: string,
  ) => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly markSourceChildComplete: (
    skillId: string,
  ) => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly bindOwner: (
    page: string,
  ) => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly assertCurrent: () => Effect.Effect<unknown, SkillsError, Notion>
  readonly activate: () => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly dispatch: <A, R>(
    action: CurrentOperationAction<A, R>,
  ) => Effect.Effect<A, SkillsError, R | Notion | Crypto.Crypto | Store>
}
export type CurrentProjectionCancellationSession = Pick<
  CurrentOperationSession,
  "operation_id" | "intent" | "owner" | "ownerPageId" | "pendingActionKey" | "assertCurrent"
> & {
  readonly reconcilePendingAction: <A, R>(
    action: CurrentOperationAction<A, R>,
  ) => Effect.Effect<void, SkillsError, R | Notion | Crypto.Crypto | Store>
}
export type CurrentProjectionCancellationResult = {
  readonly status: "cancelled" | "not_found"
  readonly operation_id: string
  readonly input_sha256: string
}

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_OPERATION_INVALID", message, details)
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current write intent."),
  })
function strict<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
}
function decodePayload(value: unknown): CurrentPayload {
  const payload = strict(PayloadSchema, value),
    progress = payload.source_progress
  if (
    ("projection" in payload.intent || "restore" in payload.intent) &&
    (payload.completion !== "ready" || payload.predecessor !== undefined)
  )
    throw invalid("Projection or restoration cannot retire its owner or carry a predecessor.")
  if ("source_input" in payload.intent) {
    const length = payload.intent.source_input.affected_skill_ids.length
    if (
      progress === undefined ||
      progress.next_index > length ||
      (progress.next_index === length && progress.child_started)
    )
      throw invalid("The finite Source child cursor is outside its frozen affected scope.")
  } else if (progress !== undefined)
    throw invalid("A Skill operation cannot carry Source progress.")
  if (payload.predecessor !== undefined) {
    const prior = payload.predecessor
    if (
      canonicalSharedJson(prior.intent.owner) !== canonicalSharedJson(payload.intent.owner) ||
      prior.intent.operation_id === payload.intent.operation_id
    )
      throw invalid("A predecessor must identify a different intent for the same current owner.")
    if ("source_input" in prior.intent) {
      const count = prior.intent.source_input.affected_skill_ids.length
      if (
        prior.source_progress === undefined ||
        prior.source_progress.next_index > count ||
        (prior.source_progress.next_index === count && prior.source_progress.child_started)
      )
        throw invalid("The predecessor Source cursor is outside its affected scope.")
    } else if (prior.source_progress !== undefined)
      throw invalid("A Skill predecessor cannot carry a Source cursor.")
  }
  return payload
}

type ProjectionFileRequest = { readonly page_id: string; readonly archive: boolean }

function projectionFileRequest(
  library: SharedLibrary,
  owner: string | null,
  request: {
    readonly path: string
    readonly method: string
    readonly body: unknown
    readonly file_sha256: string | null
    readonly part_number: number | null
  },
): ProjectionFileRequest | undefined {
  if (owner === null || request.file_sha256 !== null || request.part_number !== null)
    throw invalid("A reading projection requires its current owner and a bounded JSON request.")
  if (
    request.method === "PATCH" &&
    /^v1\/(?:pages\/[a-f0-9-]+\/markdown|blocks\/[a-f0-9-]+\/children)$/iu.test(request.path)
  )
    return undefined
  const exactKeys = (value: Record<string, unknown>, names: readonly string[]) => {
    if (
      Object.keys(value).length !== names.length ||
      names.some((name) => !Object.hasOwn(value, name))
    )
      throw invalid("A projection may change only the declared source File fields.")
  }
  const ids = library.files.property_ids
  const field = (name: string) => {
    const key = ids[name]
    if (key === undefined || key === "")
      throw invalid("A projection requires registered Files properties.", { property: name })
    return key
  }
  const content = (raw: unknown) => {
    const value = property(raw)
    exactKeys(value, ["rich_text"])
    if (!Array.isArray(value.rich_text)) throw invalid("A projection needs complete File Content.")
    const selected = parseCurrentFileContent(text(value.rich_text))
    if (selected.kind !== "source")
      throw invalid("A projection cannot create or take over Notion-owned File content.")
  }
  const body = property(request.body)
  if (request.method === "POST" && request.path === "v1/pages") {
    exactKeys(body, ["parent", "properties"])
    const parent = property(body.parent)
    exactKeys(parent, ["type", "data_source_id"])
    if (parent.type !== "data_source_id" || parent.data_source_id !== library.files.data_source_id)
      throw invalid("A projection may create pages only in its registered Files table.")
    const properties = property(body.properties)
    exactKeys(properties, ["Name", "File ID", "Path", "Skill", "Content"].map(field))
    const read = (name: string, kind: "title" | "rich_text") => {
      const value = property(properties[field(name)])
      exactKeys(value, [kind])
      if (!Array.isArray(value[kind])) throw invalid("A projection needs complete File metadata.")
      return text(value[kind])
    }
    if (!read("Name", "title").trim()) throw invalid("A projection File needs a title.")
    Schema.decodeUnknownSync(StableId)(read("File ID", "rich_text"))
    const path = read("Path", "rich_text")
    if (
      !path ||
      path.length > 4096 ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      normalizePath(path) !== path
    )
      throw invalid("A projection File needs an exact relative path.")
    const relation = property(properties[field("Skill")])
    exactKeys(relation, ["relation"])
    if (
      !Array.isArray(relation.relation) ||
      relation.relation.length !== 1 ||
      property(relation.relation[0]).id !== owner
    )
      throw invalid("A projection File must belong to its exact current Skill.")
    exactKeys(property(relation.relation[0]), ["id"])
    content(properties[field("Content")])
    return undefined
  }
  const match = /^v1\/pages\/([a-f0-9-]+)$/iu.exec(request.path)
  if (request.method !== "PATCH" || match === null || uuid(match[1]!) === owner)
    throw invalid("A projection may change generated bodies or its own source Files only.")
  const archive = body.in_trash === true
  if (archive) exactKeys(body, ["in_trash"])
  else {
    exactKeys(body, ["properties"])
    const properties = property(body.properties)
    exactKeys(properties, [field("Content")])
    content(properties[field("Content")])
  }
  return { page_id: uuid(match[1]!), archive }
}

function readProjectionFile(library: SharedLibrary, owner: string, request: ProjectionFileRequest) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${request.page_id}`)
    return yield* checked(() => {
      const row = property(raw)
      const archived = row.in_trash === true || row.archived === true || row.is_archived === true
      // An archive whose ACK was lost is observable, but it is never a live update target.
      const file = currentFileRecord(
        request.archive && archived
          ? { ...row, in_trash: false, archived: false, is_archived: false }
          : row,
        owner,
        library.files.data_source_id,
        library.files.property_ids,
      )
      if (file.page_id !== request.page_id || file.content.kind !== "source")
        throw invalid("A projection may change only a bound source-owned File.")
      return {
        file_id: file.file_id,
        page_id: file.page_id,
        skill_page_id: file.skill_page_id,
        path: file.path,
        content: file.content,
        archived,
      }
    })
  })
}

function exactSourceFileTarget(
  input: Extract<typeof CurrentSourceInputSchema.Type, { kind: "file_authority" }>,
): string {
  return canonicalSharedJson([
    input.request.skill_id,
    input.request.file_id,
    input.request.source_path,
    input.source_page_id,
    input.target.path,
    input.target.skill_page_id,
    input.target.page_id,
  ])
}

function uuid(input: string): string {
  if (
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("Use an exact Notion page identity.")
  const result = pageId(input)
  if (result === undefined) throw invalid("Use an exact Notion page identity.")
  return result
}
function ownerTable(library: SharedLibrary, owner: CurrentOperationOwner) {
  return owner.kind === "skill" ? library.skills : library.sources
}
function binding(library: SharedLibrary, owner: CurrentOperationOwner, name: string): string {
  const label =
    owner.kind === "source"
      ? name === "Skill ID"
        ? "Source ID"
        : name === "Current State"
          ? "Status"
          : name
      : name
  const id = ownerTable(library, owner).property_ids[label]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A current owner property is missing.", {
      owner: owner.kind,
      missing: label,
      next: "migrate_current_content",
    })
  return id
}
function currentOperationOwnerHeader(
  library: SharedLibrary,
  intent: CurrentOperationIntent,
  page: string,
  input: unknown,
) {
  const row = property(input),
    parent = property(row.parent)
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    uuid(row.id) !== page ||
    row.archived === true ||
    row.is_archived === true ||
    row.in_trash === true ||
    parent.type !== "data_source_id" ||
    typeof parent.data_source_id !== "string" ||
    uuid(parent.data_source_id) !== uuid(ownerTable(library, intent.owner).data_source_id)
  )
    throw fail(
      "CURRENT_OPERATION_CONFLICT",
      "The current owner is unavailable or belongs to another table.",
    )
  const field = (name: string, type: string) => {
    const id = binding(library, intent.owner, name),
      fields = Object.entries(property(row.properties)).flatMap(([key, raw]) => {
        const value = property(raw)
        return key === id || value.id === id ? [value] : []
      })
    if (fields.length !== 1 || fields[0]?.type !== type || fields[0]?.has_more === true)
      throw invalid("The current owner metadata is incomplete.", { property: name })
    return fields[0]
  }
  const rich = (name: string) => {
    const value = field(name, "rich_text")
    if (!Array.isArray(value.rich_text)) throw invalid("The current owner identity is incomplete.")
    return text(value.rich_text)
  }
  if (rich("Skill ID") !== intent.owner.id)
    throw fail(
      "CURRENT_OPERATION_CONFLICT",
      "The physical owner page has a different stable identity.",
    )
  return {
    selection: field("Current State", "select").select,
    operation: rich("Operation"),
  }
}
export function currentOperationOwnerState(
  library: SharedLibrary,
  intent: CurrentOperationIntent,
  page: string,
  input: unknown,
) {
  const header = currentOperationOwnerHeader(library, intent, page, input)
  const state = property(header.selection).name
  if (typeof state !== "string") throw invalid("The current owner has no state.")
  return parseCurrentSkillState(state, header.operation)
}
function definitive(error: SkillsError): boolean {
  const details = property(error.details)
  return (
    details.phase === "input_rejected" ||
    details.phase === "definitive_rejection" ||
    error.code === "REQUEST_BUDGET_EXHAUSTED"
  )
}
function sameIntent(a: CurrentOperationIntent, b: CurrentOperationIntent): boolean {
  return canonicalSharedJson(a) === canonicalSharedJson(b)
}
export function currentOperationFailure(
  error: SkillsError,
  intent: CurrentOperationIntent,
  marker: ActionMarker | null,
  page: string | null,
) {
  const details = property(error.details)
  const sourceInput = "source_input" in intent ? intent.source_input : undefined
  const requiredInput =
    "restore" in intent
      ? "Repeat projection for the exact Skill page with --restore and the same frozen reading policy."
      : "projection" in intent
        ? "Repeat projection with the same current Skill and policy, or use --operation and --resume with the frozen policy. Keep its exact current file bindings."
        : "skill_action" in intent
          ? "Repeat the same skill " +
            intent.skill_action.kind +
            " command with the same exact target, selected files and author metadata. The CLI reconciles its frozen current intent."
          : sourceInput === undefined
            ? "Resupply the same prepared input; its exact fingerprint is required."
            : sourceInput.kind === "declaration"
              ? "Resupply the original Source declaration with --operation and --resume."
              : sourceInput.kind === "file_authority"
                ? "Repeat the same Source file action and exact file identity with --operation and --resume."
                : sourceInput.kind === "enabled"
                  ? "Repeat the same Source enabled action and selected boolean with --operation and --resume."
                  : "Repeat Source removal for this exact Source with --operation and --resume."
  const previousOwner = property(details.owner)
  const sameOwner = previousOwner.kind === intent.owner.kind && previousOwner.id === intent.owner.id
  // An already confirmed original input wins over a later supplied hash for the
  // same owner. A child locator never becomes the public parent recovery command.
  if (
    sameOwner &&
    details.next === "reconcile_current" &&
    typeof details.required_input === "string" &&
    typeof details.operation_id === "string" &&
    typeof details.input_sha256 === "string"
  )
    return error
  const child =
    details.next === "reconcile_current" && !sameOwner && typeof details.operation_id === "string"
      ? details
      : undefined
  return fail(error.code, error.message, {
    ...(child === undefined ? details : { child }),
    operation_id: intent.operation_id,
    owner: intent.owner,
    ...(intent.owner.kind === "skill"
      ? {
          skill_id: intent.owner.id,
          skill_page_id: "restore" in intent ? intent.restore.page_id : page,
          ...("projection" in intent ? { projection: true, projection_policy: intent.policy } : {}),
          ...("restore" in intent
            ? { restore: true, projection_policy: intent.restore.policy }
            : {}),
          ...("source" in intent && intent.source !== undefined
            ? { source_intent: intent.source }
            : {}),
        }
      : {
          source_id: intent.owner.id,
          source_page_id: page,
          ...(sourceInput === undefined
            ? {}
            : {
                source_action: sourceInput.kind,
                ...(sourceInput.kind === "file_authority"
                  ? { source_request: sourceInput.request }
                  : {}),
                ...(sourceInput.kind === "enabled" ? { enabled: sourceInput.enabled } : {}),
              }),
          required_state:
            "Keep the original local Store and credentials. An unknown write cannot be safely recreated from an empty local state.",
        }),
    input_sha256: intent.input_sha256,
    next: "reconcile_current",
    required_input: requiredInput,
    ...(marker === null ? {} : { action: marker.key, replay: marker.replay }),
  })
}

function operationAddress(library: SharedLibrary, owner: CurrentOperationOwner) {
  return Effect.gen(function* () {
    yield* checked(() => strict(CurrentOperationOwnerSchema, owner))
    const api = yield* Notion
    const scope = yield* sha256(
      canonicalSharedJson([
        api.apiOrigin ?? "https://api.notion.com",
        yield* api.credentialIdentity,
        library.library_id,
      ]),
    )
    const dataSourceId = uuid(ownerTable(library, owner).data_source_id)
    const target = yield* sha256(canonicalSharedJson([library.library_id, dataSourceId, owner.id]))
    return {
      scope,
      dataSourceId,
      recordId: "operation-current-" + target,
      entityId: `current-${owner.kind}:` + owner.id,
      key:
        "operations/current-write-pending/" +
        (yield* sha256(canonicalSharedJson([scope, target]))) +
        "/pending.json",
      lock:
        `current-${owner.kind}:` +
        (api.apiOrigin ?? "https://api.notion.com") +
        ":" +
        dataSourceId +
        ":" +
        owner.id,
    }
  })
}

function observeRetiredOperation(library: SharedLibrary, recordPage: string) {
  return Effect.gen(function* () {
    const page = yield* checked(() => uuid(recordPage))
    const raw = yield* (yield* Notion).request("v1/pages/" + page)
    yield* checked(() => {
      const row = property(raw),
        parent = property(row.parent)
      if (
        row.object !== "page" ||
        typeof row.id !== "string" ||
        uuid(row.id) !== page ||
        row.in_trash !== true ||
        parent.type !== "data_source_id" ||
        typeof parent.data_source_id !== "string" ||
        uuid(parent.data_source_id) !== uuid(library.records.data_source_id)
      )
        throw fail(
          "CURRENT_OPERATION_PENDING",
          "The known Operation has not been observed in trash. Keep its current locator.",
        )
    })
  })
}

function loadCurrentOperation(library: SharedLibrary, owner: CurrentOperationOwner) {
  return Effect.gen(function* () {
    const address = yield* operationAddress(library, owner)
    const pending = yield* (yield* Store).readJson(address.key, CurrentWritePendingSchema)
    if (
      pending !== undefined &&
      (pending.scope !== address.scope ||
        pending.library_id !== library.library_id ||
        pending.record_id !== address.recordId ||
        canonicalSharedJson(pending.intent.owner) !== canonicalSharedJson(owner))
    )
      return yield* Effect.fail(
        invalid("The local current intent belongs to another owner or scope."),
      )
    const record = yield* queryCurrentSharedOperationRecord(library, address)
    const payload =
      record === undefined ? undefined : yield* checked(() => decodePayload(record!.payload))
    if (record !== undefined && payload !== undefined) {
      const currentMatches = pending === undefined || sameIntent(pending.intent, payload.intent)
      const predecessorMatches =
        pending?.lifecycle.phase === "replacing" &&
        pending.predecessor !== undefined &&
        sameIntent(pending.predecessor.intent, payload.intent)
      if (
        payload.library_id !== library.library_id ||
        payload.owner_data_source_id !== address.dataSourceId ||
        canonicalSharedJson(payload.intent.owner) !== canonicalSharedJson(owner) ||
        payload.intent.operation_id !== record.operation_id ||
        (record.owner !== null && record.owner.kind !== owner.kind) ||
        (!currentMatches && !predecessorMatches) ||
        (pending !== undefined &&
          pending.lifecycle.phase !== "creating" &&
          pending.lifecycle.record_page_id !== null &&
          pending.lifecycle.record_page_id !== record.page_id)
      )
        return yield* Effect.fail(
          invalid("The current Operation locator, input or owner is inconsistent."),
        )
    }
    if (record === undefined && pending === undefined) return undefined
    const intent = pending?.intent ?? payload!.intent
    const ownerPage = record?.owner?.page_id ?? pending?.owner_page_id ?? null
    if (
      record?.owner !== null &&
      record?.owner !== undefined &&
      pending?.owner_page_id != null &&
      record.owner.page_id !== pending.owner_page_id
    )
      return yield* Effect.fail(invalid("The local and remote current owners differ."))
    return { address, pending, record, payload, intent, ownerPage }
  })
}

/** Read the frozen input before provider discovery, including an unfinished handoff. */
export function readCurrentOperationIntent(library: SharedLibrary, owner: CurrentOperationOwner) {
  return loadCurrentOperation(library, owner).pipe(
    Effect.map((current) =>
      current === undefined
        ? undefined
        : {
            intent: current.intent,
            owner_page_id: current.ownerPage,
            predecessor: current.pending?.predecessor ?? current.payload?.predecessor,
          },
    ),
  )
}

/** Read-only management coordinates. Missing queries never certify retirement. */
export function inspectCurrentOperation(library: SharedLibrary, owner: CurrentOperationOwner) {
  return Effect.gen(function* () {
    const current = yield* loadCurrentOperation(library, owner)
    if (current === undefined) return undefined
    const { pending, record, payload, intent, ownerPage } = current
    let ownerState: ReturnType<typeof currentOperationOwnerState> | null = null
    let ownerInTrash: boolean | null = null
    if (ownerPage !== null) {
      const raw = yield* (yield* Notion).request("v1/pages/" + ownerPage)
      ownerInTrash = property(raw).in_trash === true
      ownerState = yield* checked(() =>
        currentOperationOwnerState(
          library,
          intent,
          ownerPage,
          ownerInTrash
            ? { ...property(raw), in_trash: false, archived: false, is_archived: false }
            : raw,
        ),
      )
    }
    const replacing = pending?.lifecycle.phase === "replacing"
    return {
      owner,
      intent,
      completion: pending?.completion ?? payload!.completion,
      owner_page_id: ownerPage,
      owner_state: ownerState,
      owner_in_trash: ownerInTrash,
      record_page_id:
        record?.page_id ??
        (pending?.lifecycle.phase === "creating"
          ? null
          : (pending?.lifecycle.record_page_id ?? null)),
      record_observed: record !== undefined,
      local_lifecycle: pending?.lifecycle ?? null,
      in_flight: replacing ? null : (payload?.in_flight ?? null),
      source_progress: replacing ? undefined : payload?.source_progress,
      predecessor: pending?.predecessor ?? payload?.predecessor,
    }
  })
}

export type CurrentOperationInspection = Exclude<
  Effect.Success<ReturnType<typeof inspectCurrentOperation>>,
  undefined
>

/** One mutable current intent. The local lock coordinates this Store, never remote writers. */
type CurrentOperationInput<A, R> = {
  readonly intent: CurrentOperationIntent
  readonly ownerPageId: string | null
  readonly mode?: CurrentWriteMode
  readonly completion?: "ready" | "retired"
  readonly supersedingSourceChild?: {
    readonly previous: CurrentSourceIntentBinding
    readonly next: CurrentSourceIntentBinding
  }
  readonly assertScope?: Effect.Effect<void, SkillsError, R>
  readonly beforeMutation?: Effect.Effect<void, SkillsError, R | Notion | Crypto.Crypto | Store>
  readonly afterActivate?: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly unstartedSourceChild?: CurrentSourceIntentBinding
  readonly verifyCompletedResume?: (
    session: CurrentOperationSession,
  ) => Effect.Effect<A, SkillsError, R>
  readonly run: (session: CurrentOperationSession) => Effect.Effect<A, SkillsError, R>
  readonly verify: (
    session: CurrentOperationSession,
    value: A,
  ) => Effect.Effect<void, SkillsError, R>
}
type CurrentOperationExecution<R> =
  | { readonly kind: "write" }
  | {
      readonly kind: "cancel_projection"
      readonly reconcile: (
        session: CurrentProjectionCancellationSession,
      ) => Effect.Effect<void, SkillsError, R | Notion | Crypto.Crypto | Store>
    }

export function withCurrentOperation<A, R>(
  library: SharedLibrary,
  input: CurrentOperationInput<A, R>,
): Effect.Effect<A, SkillsError, R | Notion | Crypto.Crypto | Store> {
  return runCurrentOperation(library, input, { kind: "write" })
}

/** Close only the selected reading intent. Its observed prefix is not a completed projection. */
export function cancelCurrentProjectionOperation<R>(
  library: SharedLibrary,
  input: {
    readonly intent: CurrentProjectionIntent
    readonly ownerPageId: string
    readonly assertScope?: Effect.Effect<void, SkillsError, R>
    readonly reconcile: (
      session: CurrentProjectionCancellationSession,
    ) => Effect.Effect<void, SkillsError, R | Notion | Crypto.Crypto | Store>
  },
): Effect.Effect<
  CurrentProjectionCancellationResult,
  SkillsError,
  R | Notion | Crypto.Crypto | Store
> {
  const result = (
    status: CurrentProjectionCancellationResult["status"],
    session: CurrentOperationSession,
  ): CurrentProjectionCancellationResult => ({
    status,
    operation_id: session.intent.operation_id,
    input_sha256: session.intent.input_sha256,
  })
  return runCurrentOperation(
    library,
    {
      intent: input.intent,
      ownerPageId: input.ownerPageId,
      mode: "resume",
      assertScope: input.assertScope,
      verifyCompletedResume: (session) => Effect.succeed(result("not_found", session)),
      run: (session) => Effect.succeed(result("cancelled", session)),
      verify: () => Effect.void,
    },
    { kind: "cancel_projection", reconcile: input.reconcile },
  )
}

function runCurrentOperation<A, R>(
  library: SharedLibrary,
  input: CurrentOperationInput<A, R>,
  execution: CurrentOperationExecution<R>,
): Effect.Effect<A, SkillsError, R | Notion | Crypto.Crypto | Store> {
  return Effect.gen(function* () {
    const intent = yield* checked(() =>
      strict(CurrentOperationIntentSchema, structuredClone(input.intent)),
    )
    const suppliedPage = yield* checked(() =>
      input.ownerPageId === null ? null : uuid(input.ownerPageId),
    )
    const requestedMode = input.mode ?? "apply"
    const supersededOperation =
      typeof requestedMode === "object" && requestedMode.kind === "supersede"
        ? yield* checked(() => strict(StableId, requestedMode.operation_id))
        : undefined
    let mode = supersededOperation === undefined ? requestedMode : "apply"
    if (mode !== "apply" && mode !== "resume")
      return yield* Effect.fail(
        invalid("Use apply, resume or an exact superseded operation for a current intent."),
      )
    if (supersededOperation === intent.operation_id)
      return yield* Effect.fail(invalid("A successor requires a different operation identity."))
    const completion = yield* checked(() => strict(CompletionSchema, input.completion ?? "ready"))
    const projection = "projection" in intent
    const restore = "restore" in intent ? intent.restore : undefined
    const restorePage =
      restore === undefined ? undefined : yield* checked(() => uuid(restore.page_id))
    const registration =
      "skill_action" in intent && intent.skill_action.kind === "register"
        ? intent.skill_action
        : undefined
    const registrationPage =
      registration === undefined ? undefined : yield* checked(() => uuid(registration.page_id))
    if (
      registration !== undefined &&
      (completion !== "ready" ||
        (suppliedPage !== null && suppliedPage !== registrationPage) ||
        supersededOperation !== undefined ||
        input.supersedingSourceChild !== undefined ||
        input.unstartedSourceChild !== undefined)
    )
      return yield* Effect.fail(
        invalid("Registration requires its exact existing Skill without authority takeover."),
      )
    const preserveReadyOwner = projection || restore !== undefined
    const cancelProjection = execution.kind === "cancel_projection"
    if (cancelProjection && !projection)
      return yield* Effect.fail(invalid("Only a reading projection intent can be cancelled."))
    if (
      restore !== undefined &&
      (completion !== "ready" ||
        (suppliedPage !== null && suppliedPage !== restorePage) ||
        supersededOperation !== undefined ||
        input.supersedingSourceChild !== undefined ||
        input.unstartedSourceChild !== undefined)
    )
      return yield* Effect.fail(
        invalid("Skill restoration requires its exact existing page without content takeover."),
      )
    if (
      projection &&
      (suppliedPage === null ||
        completion !== "ready" ||
        supersededOperation !== undefined ||
        input.supersedingSourceChild !== undefined ||
        input.unstartedSourceChild !== undefined)
    )
      return yield* Effect.fail(
        invalid(
          "Projection requires an existing ready Skill and apply or resume without takeover.",
        ),
      )
    yield* checked(() => {
      for (const name of ["Skill ID", "Current State", "Operation"])
        binding(library, intent.owner, name)
      uuid(ownerTable(library, intent.owner).data_source_id)
      if ("source" in intent && intent.source !== undefined) uuid(intent.source.source_page_id)
      if (
        input.unstartedSourceChild !== undefined &&
        (!("source" in intent) ||
          canonicalSharedJson(intent.source) !== canonicalSharedJson(input.unstartedSourceChild))
      )
        throw invalid("Only an exact parent-bound child can resume an unstarted target.")
      if (new TextEncoder().encode(canonicalSharedJson(intent)).length > 60 * 1024)
        throw fail(
          "CURRENT_RECORD_TOO_LARGE",
          "The bounded current intent leaves no room for its in-flight marker.",
          { phase: "input_rejected", max_intent_bytes: 60 * 1024 },
        )
    })
    const api = yield* Notion,
      store = yield* Store
    // Keep the session API closed over this invocation's services while the
    // caller's scope check still executes immediately before its first mutation.
    const beforeMutation =
      input.beforeMutation === undefined
        ? undefined
        : input.beforeMutation.pipe(
            Effect.provide(yield* Effect.context<R | Notion | Crypto.Crypto | Store>()),
          )
    const address = yield* operationAddress(library, intent.owner)
    const { scope, recordId, entityId, key } = address
    // Created inside Effect.gen: reusing this Effect cannot retain another
    // invocation's confirmation or attach a merely supplied operation ID.
    let retainFailure: ((error: SkillsError) => SkillsError) | undefined
    return yield* withLocalLocks(
      store.root,
      [address.lock],
      Effect.gen(function* () {
        let scopeConfirmed = false
        const assertScope = () =>
          Effect.gen(function* () {
            if (!scopeConfirmed && input.assertScope !== undefined) yield* input.assertScope
            scopeConfirmed = true
          })
        let pending = yield* store.readJson(key, CurrentWritePendingSchema)
        if (
          pending !== undefined &&
          (pending.scope !== scope ||
            pending.library_id !== library.library_id ||
            pending.record_id !== recordId)
        )
          return yield* Effect.fail(
            currentOperationFailure(
              fail(
                "CURRENT_OPERATION_PENDING",
                "A different current input is unfinished for this owner.",
              ),
              pending.intent,
              null,
              suppliedPage,
            ),
          )
        if (pending !== undefined) {
          const original = pending.intent
          retainFailure = (error) => currentOperationFailure(error, original, null, suppliedPage)
        }
        let record = yield* queryCurrentSharedOperationRecord(library, { recordId, entityId })
        const observedRecordPayload = record?.payload
        let observedPayload =
          record === undefined
            ? undefined
            : yield* checked(() => decodePayload(observedRecordPayload))
        const freshPayload = (predecessor?: CurrentOperationPredecessor): CurrentPayload => ({
          version: 1,
          kind: "current_operation",
          library_id: library.library_id,
          owner_data_source_id: address.dataSourceId,
          intent,
          completion,
          in_flight: null,
          ...(predecessor === undefined ? {} : { predecessor }),
          ...("source_input" in intent
            ? { source_progress: { next_index: 0, child_started: false } }
            : {}),
        })
        let replacing =
          pending?.lifecycle.phase === "replacing" ||
          (pending?.lifecycle.phase === "creating" &&
            pending.predecessor !== undefined &&
            record !== undefined)
        const predecessorAlreadySelected = pending?.predecessor ?? observedPayload?.predecessor
        const selectedIntent = pending?.intent ?? observedPayload?.intent
        if (
          observedPayload !== undefined &&
          (observedPayload.library_id !== library.library_id ||
            observedPayload.owner_data_source_id !== address.dataSourceId ||
            canonicalSharedJson(observedPayload.intent.owner) !==
              canonicalSharedJson(intent.owner) ||
            observedPayload.intent.operation_id !== record!.operation_id)
        )
          return yield* Effect.fail(
            invalid("The current Record belongs to another operation scope."),
          )
        if (pending === undefined && observedPayload !== undefined) {
          const original = observedPayload
          const originalOwner = record?.owner?.page_id ?? suppliedPage
          retainFailure = (error) =>
            currentOperationFailure(error, original.intent, original.in_flight, originalOwner)
        }
        if (
          pending !== undefined &&
          canonicalSharedJson(pending.intent.owner) !== canonicalSharedJson(intent.owner)
        )
          return yield* Effect.fail(invalid("The local pending belongs to another owner."))
        if (
          supersededOperation !== undefined &&
          selectedIntent !== undefined &&
          sameIntent(selectedIntent, intent)
        )
          mode = "resume"
        if (
          supersededOperation !== undefined &&
          selectedIntent !== undefined &&
          !sameIntent(selectedIntent, intent)
        ) {
          if ("projection" in selectedIntent || "restore" in selectedIntent)
            return yield* Effect.fail(
              currentOperationFailure(
                fail(
                  "CURRENT_OPERATION_PENDING",
                  "Resume the unfinished reading projection before changing current content.",
                ),
                selectedIntent,
                observedPayload?.in_flight ?? null,
                record?.owner?.page_id ?? pending?.owner_page_id ?? suppliedPage,
              ),
            )
          if (selectedIntent.operation_id !== supersededOperation)
            return yield* Effect.fail(
              currentOperationFailure(
                fail("CURRENT_OPERATION_PENDING", "A different current intent is unfinished."),
                selectedIntent,
                observedPayload?.in_flight ?? null,
                record?.owner?.page_id ?? pending?.owner_page_id ?? suppliedPage,
              ),
            )
          if (
            record !== undefined &&
            observedPayload !== undefined &&
            !sameIntent(observedPayload.intent, selectedIntent)
          )
            return yield* Effect.fail(invalid("The predecessor's local and remote intents differ."))
          if (pending?.lifecycle.phase === "replacing")
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_PENDING",
                "Finish the current intent handoff before replacing it again.",
              ),
            )
          if (record === undefined && pending?.lifecycle.phase !== "creating")
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_UNRESOLVED",
                "The known predecessor Record is not observable; inspect its exact physical locator before superseding.",
              ),
            )
          if ("source" in selectedIntent && selectedIntent.source !== undefined) {
            const authorized = input.supersedingSourceChild
            if (
              authorized === undefined ||
              !("source" in intent) ||
              intent.source === undefined ||
              canonicalSharedJson(authorized.previous) !==
                canonicalSharedJson(selectedIntent.source) ||
              canonicalSharedJson(authorized.next) !== canonicalSharedJson(intent.source) ||
              authorized.previous.source_id !== authorized.next.source_id ||
              authorized.previous.source_page_id !== authorized.next.source_page_id
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
                  "Only the exact successor Source parent may supersede its unfinished child.",
                ),
              )
          } else if (input.supersedingSourceChild !== undefined)
            return yield* Effect.fail(
              invalid("A Source successor cannot claim an unrelated pending Skill."),
            )
          if ("source_input" in selectedIntent && "source_input" in intent) {
            if (
              selectedIntent.source_input.kind !== intent.source_input.kind ||
              selectedIntent.source_input.affected_skill_ids.some(
                (id) => !intent.source_input.affected_skill_ids.includes(id),
              )
            )
              return yield* Effect.fail(
                invalid(
                  "A Source successor must retain its action category and complete predecessor target scope.",
                ),
              )
            if (
              selectedIntent.source_input.kind === "file_authority" &&
              intent.source_input.kind === "file_authority" &&
              exactSourceFileTarget(selectedIntent.source_input) !==
                exactSourceFileTarget(intent.source_input)
            )
              return yield* Effect.fail(
                invalid("A file authority successor must select the same exact current target."),
              )
          }
          const priorOwner = record?.owner?.page_id ?? pending?.owner_page_id ?? suppliedPage
          if (priorOwner !== null) {
            if (suppliedPage !== null && priorOwner !== suppliedPage)
              return yield* Effect.fail(
                invalid("The successor cannot switch physical owner pages."),
              )
            const raw = yield* api.request("v1/pages/" + priorOwner)
            const state = yield* checked(() =>
              currentOperationOwnerState(library, selectedIntent, priorOwner, raw),
            )
            if (state.state !== "ready" && state.operation_id !== selectedIntent.operation_id)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "Another intent now owns the predecessor page."),
              )
          }
          const predecessor: CurrentOperationPredecessor = {
            intent: selectedIntent,
            completion: observedPayload?.completion ?? pending!.completion,
            owner_page_id: priorOwner,
            in_flight: observedPayload?.in_flight ?? null,
            ...("source_input" in selectedIntent
              ? {
                  source_progress: observedPayload?.source_progress ?? {
                    next_index: 0,
                    child_started: false,
                  },
                }
              : {}),
          }
          const next = freshPayload(predecessor)
          yield* assertScope()
          yield* checked(() => {
            decodePayload(next)
            assertCurrentOperationRecordSize(intent.operation_id, next)
          })
          if (pending === undefined) {
            pending = {
              version: 1,
              scope,
              library_id: library.library_id,
              record_id: recordId,
              intent: selectedIntent,
              completion: predecessor.completion,
              owner_page_id: priorOwner,
              lifecycle: { phase: "active", record_page_id: record!.page_id },
              ...(observedPayload?.predecessor === undefined
                ? {}
                : { predecessor: observedPayload.predecessor }),
            }
            yield* store.writeJson(key, pending)
          }
          const replacement: LocalPending = {
            version: 1,
            scope,
            library_id: library.library_id,
            record_id: recordId,
            intent,
            completion,
            owner_page_id: priorOwner,
            predecessor,
            lifecycle: { phase: "replacing", record_page_id: record?.page_id ?? null },
          }
          yield* store.writeJson(key, replacement, { expectedCurrentWritePending: pending })
          pending = replacement
          replacing = true
          retainFailure = (error) => currentOperationFailure(error, intent, null, priorOwner)
        } else if (
          supersededOperation !== undefined &&
          selectedIntent !== undefined &&
          predecessorAlreadySelected?.intent.operation_id !== supersededOperation
        )
          return yield* Effect.fail(
            invalid("The selected successor does not name this predecessor."),
          )
        // A remote handoff can be resumed with this Store only after its exact
        // successor input is supplied. Ordinary readers never admit this state.
        if (
          !replacing &&
          pending === undefined &&
          observedPayload?.predecessor !== undefined &&
          sameIntent(observedPayload.intent, intent) &&
          record?.owner != null
        ) {
          const raw = yield* api.request("v1/pages/" + record.owner.page_id)
          const state = yield* checked(() =>
            currentOperationOwnerState(library, intent, record!.owner!.page_id, raw),
          )
          if (
            state.state !== "ready" &&
            state.operation_id === observedPayload.predecessor.intent.operation_id
          ) {
            pending = {
              version: 1,
              scope,
              library_id: library.library_id,
              record_id: recordId,
              intent,
              completion,
              owner_page_id: record.owner.page_id,
              predecessor: observedPayload.predecessor,
              lifecycle: { phase: "replacing", record_page_id: record.page_id },
            }
            yield* store.writeJson(key, pending)
            replacing = true
          }
        }
        if (replacing) {
          const staged = pending!
          const predecessor = staged.predecessor
          if (
            predecessor === undefined ||
            !sameIntent(staged.intent, intent) ||
            staged.completion !== completion
          )
            return yield* Effect.fail(
              invalid("Resupply the exact successor input to finish its current handoff."),
            )
          retainFailure = (error) =>
            currentOperationFailure(error, intent, null, staged.owner_page_id)
          yield* assertScope()
          if (beforeMutation !== undefined) yield* beforeMutation
          if (record === undefined) {
            if (staged.lifecycle.phase !== "replacing" || staged.lifecycle.record_page_id !== null)
              return yield* Effect.fail(invalid("The known handoff Record is unavailable."))
            const creating: LocalPending = { ...staged, lifecycle: { phase: "creating" } }
            yield* store.writeJson(key, creating)
            pending = creating
            record = yield* writeCurrentSharedOperationRecord(library, {
              current: null,
              recordId,
              entityId,
              operationId: intent.operation_id,
              owner:
                staged.owner_page_id === null
                  ? null
                  : { kind: intent.owner.kind, page_id: staged.owner_page_id },
              payload: freshPayload(predecessor),
            })
          } else if (!sameIntent(observedPayload!.intent, intent)) {
            if (
              !sameIntent(observedPayload!.intent, predecessor.intent) ||
              record.page_id !==
                (staged.lifecycle.phase === "replacing" ? staged.lifecycle.record_page_id : null)
            )
              return yield* Effect.fail(
                invalid("The current Record changed before its successor handoff."),
              )
            record = yield* replaceCurrentSharedOperationRecord(library, {
              current: record,
              recordId,
              entityId,
              operationId: intent.operation_id,
              owner:
                staged.owner_page_id === null
                  ? null
                  : { kind: intent.owner.kind, page_id: staged.owner_page_id },
              payload: freshPayload(predecessor),
            })
          } else if (
            canonicalSharedJson(observedPayload!.predecessor) !==
              canonicalSharedJson(predecessor) ||
            observedPayload!.completion !== completion
          )
            return yield* Effect.fail(
              invalid("The observed successor handoff differs from the selected predecessor."),
            )
          observedPayload = yield* checked(() => decodePayload(record!.payload))
          // The Source parent can now discover this child before any owner or
          // product mutation. A lost cursor PATCH keeps the handoff local.
          if (input.afterActivate !== undefined) yield* input.afterActivate
          if (staged.owner_page_id !== null) {
            const ownerPage = staged.owner_page_id
            const raw = yield* api.request("v1/pages/" + ownerPage)
            const state = yield* checked(() =>
              currentOperationOwnerState(library, intent, ownerPage, raw),
            )
            if (
              state.state !== "ready" &&
              state.operation_id !== intent.operation_id &&
              state.operation_id !== predecessor.intent.operation_id
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_CONFLICT",
                  "Another intent changed the owner during handoff.",
                ),
              )
            if (state.state === "ready" || state.operation_id !== intent.operation_id) {
              const result = yield* api.request(
                "v1/pages/" + ownerPage,
                {
                  properties: {
                    [binding(library, intent.owner, "Current State")]: {
                      select: { name: "applying" },
                    },
                    [binding(library, intent.owner, "Operation")]: {
                      rich_text: currentRecordText(intent.operation_id),
                    },
                  },
                },
                { method: "PATCH" },
              )
              yield* checked(() => {
                const current = currentOperationOwnerState(library, intent, ownerPage, result)
                if (current.state !== "applying" || current.operation_id !== intent.operation_id)
                  throw fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The successor owner binding was not confirmed.",
                  )
              }).pipe(
                Effect.mapError((error) =>
                  fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The successor owner acknowledgement could not be verified.",
                    { cause_code: error.code },
                  ),
                ),
              )
            }
          }
          pending = { ...staged, lifecycle: { phase: "active", record_page_id: record!.page_id } }
          yield* store.writeJson(key, pending)
        }
        if (pending !== undefined && !sameIntent(pending.intent, intent)) {
          const stale = pending
          if (
            mode !== "apply" ||
            stale.lifecycle.phase !== "retiring" ||
            suppliedPage === null ||
            record !== undefined
          )
            return yield* Effect.fail(
              currentOperationFailure(
                fail(
                  "CURRENT_OPERATION_PENDING",
                  "A different current input is unfinished for this owner.",
                ),
                stale.intent,
                null,
                suppliedPage,
              ),
            )
          const recordPage = stale.lifecycle.record_page_id
          const ownerRaw = yield* api.request("v1/pages/" + suppliedPage)
          const trashed = property(ownerRaw).in_trash === true
          const current = yield* checked(() =>
            currentOperationOwnerState(
              library,
              stale.intent,
              suppliedPage,
              stale.completion === "retired" && trashed
                ? { ...property(ownerRaw), in_trash: false, archived: false, is_archived: false }
                : ownerRaw,
            ),
          )
          if (stale.completion === "retired" ? !trashed : current.state !== "ready")
            return yield* Effect.fail(
              currentOperationFailure(
                fail("CURRENT_OPERATION_PENDING", "The previous current owner is not ready."),
                stale.intent,
                null,
                suppliedPage,
              ),
            )
          yield* observeRetiredOperation(library, recordPage)
          yield* store.retireKeys([key])
          pending = undefined
          retainFailure = undefined
        }
        if (
          record !== undefined &&
          pending !== undefined &&
          pending.lifecycle.phase !== "creating" &&
          pending.lifecycle.record_page_id !== record.page_id
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_OPERATION_CONFLICT",
              "The current operation changed physical identity. Inspect it before writing.",
            ),
          )
        if (
          record?.owner !== undefined &&
          record.owner !== null &&
          record.owner.kind !== intent.owner.kind
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_OPERATION_CONFLICT",
              "The current Operation belongs to another owner kind.",
            ),
          )
        let owner = record?.owner?.page_id ?? pending?.owner_page_id ?? suppliedPage
        if (restorePage !== undefined && owner !== null && owner !== restorePage)
          return yield* Effect.fail(
            invalid("The restoration intent has a different physical owner."),
          )
        if (
          record?.owner?.page_id !== null &&
          record?.owner?.page_id !== undefined &&
          suppliedPage !== null &&
          record.owner?.page_id !== suppliedPage
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_OPERATION_CONFLICT",
              "The intent is bound to a different physical owner page.",
            ),
          )
        let payload: CurrentPayload = {
          version: 1,
          kind: "current_operation",
          library_id: library.library_id,
          owner_data_source_id: uuid(ownerTable(library, intent.owner).data_source_id),
          intent,
          completion,
          ...(pending?.predecessor === undefined ? {} : { predecessor: pending.predecessor }),
          in_flight: null,
          ...("source_input" in intent
            ? {
                source_progress: {
                  next_index:
                    pending?.lifecycle.phase === "retiring"
                      ? intent.source_input.affected_skill_ids.length
                      : 0,
                  child_started: false,
                },
              }
            : {}),
        }
        if (record !== undefined) {
          const found = record
          payload = yield* checked(() => decodePayload(found.payload))
          if (
            payload.library_id !== library.library_id ||
            payload.owner_data_source_id !==
              uuid(ownerTable(library, intent.owner).data_source_id) ||
            !sameIntent(payload.intent, intent) ||
            payload.completion !== completion ||
            record.operation_id !== intent.operation_id
          )
            return yield* Effect.fail(
              currentOperationFailure(
                fail("CURRENT_OPERATION_PENDING", "A different current intent owns this page."),
                payload.intent,
                payload.in_flight,
                owner,
              ),
            )
        }
        if (record === undefined && pending !== undefined && pending.lifecycle.phase !== "retiring")
          return yield* Effect.fail(
            currentOperationFailure(
              fail(
                "CURRENT_OPERATION_UNRESOLVED",
                "The current operation CREATE has not been observed; do not repeat it from absence.",
              ),
              intent,
              null,
              owner,
            ),
          )
        if (
          record === undefined &&
          pending === undefined &&
          mode === "resume" &&
          input.unstartedSourceChild !== undefined
        )
          mode = "apply"
        if (
          record === undefined &&
          pending === undefined &&
          mode === "resume" &&
          input.verifyCompletedResume === undefined
        )
          return yield* Effect.fail(
            fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished current intent was found."),
          )
        const saveLocal = (lifecycle: LocalPending["lifecycle"], notDispatched?: ActionMarker) =>
          Effect.gen(function* () {
            const next: LocalPending = {
              version: 1,
              scope,
              library_id: library.library_id,
              record_id: recordId,
              intent,
              completion,
              owner_page_id: owner,
              ...(payload.predecessor === undefined ? {} : { predecessor: payload.predecessor }),
              lifecycle,
              ...(notDispatched === undefined ? {} : { not_dispatched: notDispatched }),
            }
            yield* store.writeJson(key, next)
            pending = next
          })
        const alreadyRetiring = pending?.lifecycle.phase === "retiring"
        let ownerRetired = false
        const notDispatched = pending?.not_dispatched
        let settled =
          (cancelProjection && alreadyRetiring) ||
          payload.in_flight === null ||
          (notDispatched !== undefined &&
            canonicalSharedJson(notDispatched) === canonicalSharedJson(payload.in_flight))
        let ownerReady = alreadyRetiring
        let dispatching = false
        let closed = false
        let mutationScopeConfirmed = false
        let completedReadOnly = false
        let activationScopeConfirmed = false
        let payloadWriteUncertain = false
        const retainCurrentFailure = (error: SkillsError) =>
          currentOperationFailure(error, intent, settled ? null : payload.in_flight, owner)
        if (record !== undefined || pending !== undefined) retainFailure = retainCurrentFailure
        if (record !== undefined && !alreadyRetiring)
          yield* saveLocal({ phase: "active", record_page_id: record.page_id }, notDispatched)
        const persist = (marker: ActionMarker | null) =>
          Effect.gen(function* () {
            if (record === undefined)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "The current operation is already retired."),
              )
            const next: CurrentPayload = { ...payload, in_flight: marker }
            payloadWriteUncertain = true
            record = yield* writeCurrentSharedOperationRecord(library, {
              current: record,
              recordId,
              operationId: intent.operation_id,
              entityId,
              owner: owner === null ? null : { kind: intent.owner.kind, page_id: owner },
              payload: next,
            })
            payload = next
            payloadWriteUncertain = false
            settled = marker === null
          })
        const confirmActivation = () =>
          Effect.gen(function* () {
            if (activationScopeConfirmed) return
            if (input.afterActivate !== undefined) yield* input.afterActivate
            activationScopeConfirmed = true
          })
        const changeSourceProgress = (skillId: string, completing: boolean) =>
          Effect.gen(function* () {
            if (
              closed ||
              completedReadOnly ||
              !("source_input" in intent) ||
              payload.source_progress === undefined
            )
              return yield* Effect.fail(
                invalid("Source progress requires its active finite parent session."),
              )
            if (!settled || payloadWriteUncertain)
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_PENDING",
                  "Resolve the parent action before changing its child cursor.",
                ),
              )
            const index = intent.source_input.affected_skill_ids.indexOf(skillId),
              previous = payload.source_progress
            if (
              index < 0 ||
              index > previous.next_index ||
              (!completing && index !== previous.next_index)
            )
              return yield* Effect.fail(
                invalid("The child target is outside the current ordered Source scope."),
              )
            if (index < previous.next_index || (!completing && previous.child_started)) return
            if (ownerReady)
              return yield* Effect.fail(
                invalid("A ready Source cannot advance unfinished child work."),
              )
            if (!completing && record === undefined)
              return yield* Effect.fail(
                invalid("Activate the parent before marking a discovered child intent."),
              )
            const next: CurrentPayload = {
              ...payload,
              in_flight: null,
              source_progress: {
                next_index: completing ? index + 1 : index,
                child_started: !completing,
              },
            }
            if (record !== undefined) {
              payloadWriteUncertain = true
              record = yield* writeCurrentSharedOperationRecord(library, {
                current: record,
                recordId,
                operationId: intent.operation_id,
                entityId,
                owner: owner === null ? null : { kind: intent.owner.kind, page_id: owner },
                payload: next,
              })
              payloadWriteUncertain = false
            }
            payload = next
            settled = true
          })
        const ensureOpen = () =>
          Effect.gen(function* () {
            if (cancelProjection)
              return yield* Effect.fail(
                invalid("Projection cancellation cannot activate new work."),
              )
            if (closed || ownerReady || completedReadOnly)
              return yield* Effect.fail(
                invalid("A completed current intent cannot begin a mutation."),
              )
            if (!mutationScopeConfirmed) {
              if (beforeMutation !== undefined) yield* beforeMutation
              mutationScopeConfirmed = true
            }
            if (record !== undefined) {
              yield* confirmActivation()
              return
            }
            if (alreadyRetiring)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "A retiring intent cannot begin new work."),
              )
            yield* saveLocal({ phase: "creating" })
            retainFailure = retainCurrentFailure
            const written = yield* writeCurrentSharedOperationRecord(library, {
              current: null,
              recordId,
              operationId: intent.operation_id,
              entityId,
              owner: owner === null ? null : { kind: intent.owner.kind, page_id: owner },
              payload,
            }).pipe(Effect.result)
            if (written._tag === "Failure") {
              if (definitive(written.failure)) {
                yield* store.retireKeys([key])
                pending = undefined
                retainFailure = undefined
              }
              return yield* Effect.fail(written.failure)
            }
            record = written.success
            yield* saveLocal({ phase: "active", record_page_id: record.page_id })
            yield* confirmActivation()
            if (owner !== null && !preserveReadyOwner) yield* changeOwner("applying")
          })
        const inspectRestoreOwner = () =>
          Effect.gen(function* () {
            if (restorePage === undefined)
              return yield* Effect.fail(invalid("The current intent is not a Skill restoration."))
            const raw = property(yield* api.request(`v1/pages/${restorePage}`))
            const state = yield* checked(() =>
              currentOperationOwnerState(library, intent, restorePage, {
                ...raw,
                in_trash: false,
                archived: false,
                is_archived: false,
              }),
            )
            if (state.state !== "ready")
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "Only a ready Skill can be restored."),
              )
          })
        const identifyAction = <B, R2>(action: CurrentOperationAction<B, R2>) =>
          Effect.gen(function* () {
            const request = yield* checked(() => {
              const method = action.request.options?.method ?? "GET"
              if (
                !action.key ||
                action.key.length > 512 ||
                /[\u0000-\u001f\u007f]/u.test(action.key) ||
                !/^v1\//u.test(action.request.path) ||
                !["POST", "PATCH"].includes(method) ||
                (action.replay !== "never" && action.replay !== "idempotent")
              )
                throw invalid("Use one bounded mutating current action.")
              if (
                action.request.options?.file !== undefined &&
                (action.fileSha256 === undefined || !/^[a-f0-9]{64}$/u.test(action.fileSha256))
              )
                throw invalid("Multipart writes need their exact input content fingerprint.")
              return {
                path: action.request.path,
                method,
                body: action.request.body ?? null,
                file_sha256: action.fileSha256 ?? null,
                part_number: action.request.options?.partNumber ?? null,
              }
            })
            if (restorePage !== undefined) {
              yield* checked(() => {
                const body = property(request.body)
                if (
                  Object.keys(body).length !== 1 ||
                  action.key !== "$owner.restore" ||
                  action.replay !== "idempotent" ||
                  request.method !== "PATCH" ||
                  request.path !== `v1/pages/${restorePage}` ||
                  body.in_trash !== false ||
                  request.file_sha256 !== null ||
                  request.part_number !== null
                )
                  throw invalid("Restoration may only untrash its exact existing Skill page.")
              })
              yield* inspectRestoreOwner()
            }
            const fileRequest = projection
              ? yield* checked(() => projectionFileRequest(library, owner, request))
              : undefined
            const projectionFile =
              fileRequest === undefined
                ? undefined
                : yield* readProjectionFile(library, owner!, fileRequest)
            const marker: ActionMarker = {
              key: action.key,
              request_sha256: yield* sha256(canonicalSharedJson(request)),
              replay: action.replay,
            }
            return { request, marker, fileRequest, projectionFile }
          })
        const dispatch = <B, R2>(
          action: CurrentOperationAction<B, R2>,
          internal = false,
        ): Effect.Effect<B, SkillsError, R2 | Notion | Crypto.Crypto | Store> =>
          Effect.gen(function* () {
            if (closed) return yield* Effect.fail(invalid("The current intent session is closed."))
            if (cancelProjection)
              return yield* Effect.fail(
                invalid("Projection cancellation cannot dispatch a body request."),
              )
            if (dispatching && !internal)
              return yield* Effect.fail(
                invalid("Actions within one current intent must run sequentially."),
              )
            if (!internal) dispatching = true
            return yield* Effect.gen(function* () {
              const { request, marker, fileRequest, projectionFile } = yield* identifyAction(action)
              const active = !settled ? payload.in_flight : null
              if (
                payload.in_flight?.key === action.key &&
                canonicalSharedJson(payload.in_flight) !== canonicalSharedJson(marker)
              )
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "The pending action changed. Resupply its original current input.",
                  ),
                )
              const observed = yield* action.observe({
                fresh: active?.key === action.key || alreadyRetiring,
              })
              if (observed.status === "complete") {
                if (active?.key === action.key) settled = true
                return observed.value
              }
              if (completedReadOnly)
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "The previously completed target differs from this Source intent. Resume cannot start a new child write.",
                    { action: action.key },
                  ),
                )
              if (active !== null && active.key !== action.key)
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_PENDING",
                    "Resolve the earlier current action before writing another target.",
                    { pending_action: active.key },
                  ),
                )
              if (ownerReady && action.key !== "$owner." + completion)
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "A ready owner cannot resume an incomplete earlier write.",
                  ),
                )
              if (active !== null && (mode !== "resume" || action.replay === "never"))
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_UNRESOLVED",
                    "The earlier write is not yet visible. A CREATE or append is not repeated from absence.",
                    { action: action.key },
                  ),
                )
              if (owner === null && restorePage === undefined)
                yield* checked(() => {
                  const body = property(request.body),
                    properties = property(body.properties)
                  const createsOwner =
                    registrationPage === undefined &&
                    request.path === "v1/pages" &&
                    request.method === "POST" &&
                    property(body.parent).data_source_id ===
                      ownerTable(library, intent.owner).data_source_id
                  const registersOwner =
                    registrationPage !== undefined &&
                    request.path === "v1/pages/" + registrationPage &&
                    request.method === "PATCH" &&
                    Object.keys(body).length === 1 &&
                    "properties" in body
                  if (!createsOwner && !registersOwner)
                    throw invalid(
                      "Bind the exact created or registered owner before writing its content or child targets.",
                    )
                  if (
                    text(
                      property(properties[binding(library, intent.owner, "Skill ID")]).rich_text,
                    ) !== intent.owner.id ||
                    text(
                      property(properties[binding(library, intent.owner, "Operation")]).rich_text,
                    ) !== intent.operation_id ||
                    property(
                      property(properties[binding(library, intent.owner, "Current State")]).select,
                    ).name !== "applying"
                  )
                    throw invalid(
                      "Create the owner with its stable identity, applying state and current Operation together.",
                    )
                })
              yield* ensureOpen()
              if (restorePage !== undefined) yield* inspectRestoreOwner()
              if (fileRequest !== undefined) {
                const current = yield* readProjectionFile(library, owner!, fileRequest)
                if (canonicalSharedJson(current) !== canonicalSharedJson(projectionFile))
                  return yield* Effect.fail(
                    invalid("The projection File binding changed before its mutation."),
                  )
              }
              if (record === undefined)
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "A retired current operation cannot dispatch.",
                  ),
                )
              yield* saveLocal({ phase: "active", record_page_id: record.page_id }, marker)
              yield* persist(marker)
              yield* saveLocal({ phase: "active", record_page_id: record.page_id })
              const response = yield* api
                .request(action.request.path, action.request.body, action.request.options)
                .pipe(Effect.result)
              if (response._tag === "Failure") {
                if (definitive(response.failure)) {
                  settled = true
                  yield* saveLocal({ phase: "active", record_page_id: record.page_id }, marker)
                }
                return yield* Effect.fail(response.failure)
              }
              const result = yield* (
                action.acknowledge === undefined
                  ? action
                      .observe({ fresh: true })
                      .pipe(
                        Effect.flatMap((value) =>
                          value.status === "complete"
                            ? Effect.succeed(value.value)
                            : Effect.fail(
                                fail(
                                  "WRITE_OUTCOME_UNKNOWN",
                                  "The current action response did not establish its intended result.",
                                ),
                              ),
                        ),
                      )
                  : action.acknowledge(response.success)
              ).pipe(
                Effect.mapError((error) =>
                  fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The current action acknowledgement could not be verified.",
                    { cause_code: error.code },
                  ),
                ),
              )
              settled = true
              return result
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (!internal) dispatching = false
                }),
              ),
            )
          })
        const reconcilePendingAction = <B, R2>(action: CurrentOperationAction<B, R2>) =>
          Effect.gen(function* () {
            if (closed || !cancelProjection || dispatching)
              return yield* Effect.fail(
                invalid("Only one open projection cancellation may reconcile an action."),
              )
            const active = settled ? null : payload.in_flight
            if (active === null)
              return yield* Effect.fail(
                invalid("There is no unsettled projection action to observe."),
              )
            dispatching = true
            return yield* Effect.gen(function* () {
              const { marker } = yield* identifyAction(action)
              if (canonicalSharedJson(active) !== canonicalSharedJson(marker))
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "Cancellation must observe the exact pending request.",
                    { pending_action: active.key },
                  ),
                )
              yield* observeOwner()
              const observed = yield* action.observe({ fresh: true })
              if (observed.status !== "complete")
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_UNRESOLVED",
                    "The pending projection action is not completely observable; cancellation cannot replay it.",
                    { pending_action: active.key },
                  ),
                )
              settled = true
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  dispatching = false
                }),
              ),
            )
          })
        const ownerObservation = (raw: unknown, allowCompletedRetirement = false) => {
          const page = owner
          if (page === null) throw invalid("The current intent has no physical owner.")
          const trashed = property(raw).in_trash === true
          const permitted =
            completion === "retired" &&
            (ownerRetired ||
              alreadyRetiring ||
              payload.in_flight?.key === "$owner.retired" ||
              allowCompletedRetirement)
          const active =
            trashed && permitted
              ? { ...property(raw), in_trash: false, archived: false, is_archived: false }
              : raw
          const state = currentOperationOwnerState(library, intent, page, active)
          if (preserveReadyOwner && state.state !== "ready")
            throw fail(
              "CURRENT_OPERATION_CONFLICT",
              "Projection or restoration requires the current Skill to remain ready.",
            )
          if (trashed) {
            if (
              !permitted ||
              (state.state !== "ready" && state.operation_id !== intent.operation_id)
            )
              throw fail(
                "CURRENT_OPERATION_CONFLICT",
                "The retired owner does not belong to this terminal intent.",
              )
            ownerRetired = true
            ownerReady = true
            if (payload.in_flight?.key === "$owner.retired") settled = true
          }
          return state
        }
        const observeOwner = (allowCompletedRetirement = false) =>
          Effect.gen(function* () {
            if (owner === null)
              return yield* Effect.fail(invalid("The current intent has no physical owner."))
            const raw = yield* api.request("v1/pages/" + owner)
            const state = yield* checked(() => ownerObservation(raw, allowCompletedRetirement))
            return state
          })
        const retireOwner = (value: A) =>
          Effect.gen(function* () {
            const page = owner
            if (page === null)
              return yield* Effect.fail(
                invalid("A retired completion needs an exact physical owner."),
              )
            yield* dispatch(
              {
                key: "$owner.retired",
                replay: "idempotent",
                request: {
                  path: "v1/pages/" + page,
                  body: { in_trash: true },
                  options: { method: "PATCH" },
                },
                observe: () =>
                  Effect.gen(function* () {
                    const raw = yield* api.request("v1/pages/" + page)
                    const state = yield* checked(() => ownerObservation(raw))
                    if (ownerRetired) return { status: "complete", value: undefined } as const
                    if (state.state !== "ready" && state.operation_id !== intent.operation_id)
                      return yield* Effect.fail(
                        fail(
                          "CURRENT_OPERATION_CONFLICT",
                          "Another operation owns the terminal target.",
                        ),
                      )
                    // Recheck configuration and current references after this
                    // last owner observation, through the caller's same verifier.
                    yield* input.verify(session, value)
                    return { status: "missing" } as const
                  }),
                acknowledge: (raw) =>
                  checked(() => {
                    ownerObservation(raw)
                    if (!ownerRetired)
                      throw fail(
                        "WRITE_OUTCOME_UNKNOWN",
                        "The exact owner retirement was not confirmed.",
                      )
                  }),
              },
              true,
            )
          })
        const changeOwner = (next: "applying" | "ready" | "attention") =>
          Effect.gen(function* () {
            const page = owner
            if (page === null)
              return yield* Effect.fail(invalid("Bind an owner before changing its current state."))
            const properties = {
              [binding(library, intent.owner, "Current State")]: { select: { name: next } },
              [binding(library, intent.owner, "Operation")]: {
                rich_text: currentRecordText(next === "ready" ? "" : intent.operation_id),
              },
            }
            return yield* dispatch(
              {
                key: "$owner." + next,
                replay: "idempotent",
                request: {
                  path: "v1/pages/" + page,
                  body: { properties },
                  options: { method: "PATCH" },
                },
                observe: () =>
                  Effect.gen(function* () {
                    const state = yield* observeOwner()
                    if (state.state === "ready")
                      return next === "ready"
                        ? { status: "complete" as const, value: undefined }
                        : { status: "missing" as const }
                    if (state.operation_id !== intent.operation_id)
                      return yield* Effect.fail(
                        fail(
                          "CURRENT_OPERATION_CONFLICT",
                          "Another current operation owns this page.",
                        ),
                      )
                    return state.state === next
                      ? { status: "complete" as const, value: undefined }
                      : { status: "missing" as const }
                  }),
                acknowledge: (raw) =>
                  checked(() => {
                    const state = currentOperationOwnerState(library, intent, page, raw)
                    if (
                      state.state !== next ||
                      (state.state !== "ready" && state.operation_id !== intent.operation_id)
                    )
                      throw invalid(
                        "The current state acknowledgement differs from the selected intent.",
                      )
                  }),
              },
              true,
            )
          })
        const session: CurrentOperationSession = {
          operation_id: intent.operation_id,
          intent,
          owner: intent.owner,
          get ownerPageId() {
            return owner
          },
          get ownerRetired() {
            return ownerRetired
          },
          get predecessor() {
            return payload.predecessor === undefined
              ? undefined
              : structuredClone(payload.predecessor)
          },
          get pendingActionKey() {
            return settled ? undefined : payload.in_flight?.key
          },
          get sourceProgress() {
            return payload.source_progress === undefined
              ? undefined
              : Object.freeze({ ...payload.source_progress })
          },
          markSourceChildStarted: (skillId) => changeSourceProgress(skillId, false),
          markSourceChildComplete: (skillId) => changeSourceProgress(skillId, true),
          dispatch,
          activate: ensureOpen,
          assertCurrent: () =>
            Effect.gen(function* () {
              if (closed || owner === null)
                return yield* Effect.fail(invalid("The current owner session is not active."))
              const raw = yield* api.request("v1/pages/" + owner)
              const state = yield* checked(() => ownerObservation(raw))
              if (ownerRetired) return raw
              if (
                !preserveReadyOwner &&
                (state.state === "ready"
                  ? !ownerReady && (record !== undefined || pending !== undefined)
                  : record === undefined || state.operation_id !== intent.operation_id)
              )
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "The current owner no longer belongs to this intent.",
                  ),
                )
              return raw
            }),
          bindOwner: (page) =>
            Effect.gen(function* () {
              if (closed)
                return yield* Effect.fail(invalid("The current intent session is closed."))
              if (projection)
                return yield* Effect.fail(invalid("A reading projection cannot bind a new owner."))
              const selected = yield* checked(() => uuid(page))
              if (restorePage !== undefined && selected !== restorePage)
                return yield* Effect.fail(
                  invalid("Restoration cannot bind a different Skill page."),
                )
              if (registrationPage !== undefined && selected !== registrationPage)
                return yield* Effect.fail(
                  invalid("Registration cannot bind a different Skill page."),
                )
              if (owner !== null && owner !== selected)
                return yield* Effect.fail(
                  fail("CURRENT_OPERATION_CONFLICT", "A current intent cannot switch owner pages."),
                )
              const raw = yield* api.request("v1/pages/" + selected)
              const state = yield* checked(() =>
                currentOperationOwnerState(library, intent, selected, raw),
              )
              if (
                restorePage !== undefined
                  ? state.state !== "ready"
                  : state.state === "ready" || state.operation_id !== intent.operation_id
              )
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "The created owner was not marked for this current intent.",
                  ),
                )
              owner = selected
              if (record?.owner?.page_id !== selected) {
                if (!settled)
                  return yield* Effect.fail(
                    fail(
                      "CURRENT_OPERATION_PENDING",
                      "Resolve the current create before binding its owner.",
                    ),
                  )
                yield* persist(payload.in_flight)
                settled = true
              }
            }),
        }
        const execute = Effect.gen(function* () {
          yield* assertScope()
          if (
            mode === "resume" &&
            record === undefined &&
            pending === undefined &&
            input.verifyCompletedResume !== undefined
          ) {
            const state = owner === null ? undefined : yield* observeOwner(completion === "retired")
            if (
              owner === null ||
              (completion === "retired" ? !ownerRetired : state?.state !== "ready")
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_NOT_FOUND",
                  "A completed resume requires the exact terminal owner.",
                ),
              )
            completedReadOnly = true
            return yield* input.verifyCompletedResume(session)
          }
          if (supersededOperation !== undefined && record === undefined && pending === undefined) {
            if (
              owner === null ||
              completion !== "ready" ||
              (yield* observeOwner()).state !== "ready"
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_NOT_FOUND",
                  "The predecessor is not observable. Only a complete current target can be accepted without it.",
                ),
              )
            completedReadOnly = true
          }
          if (owner !== null) {
            const state = yield* observeOwner()
            if (
              alreadyRetiring &&
              (completion === "retired" ? !ownerRetired : state.state !== "ready")
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_CONFLICT",
                  "The retiring current owner is no longer ready.",
                ),
              )
            if (state.state !== "ready" && state.operation_id === intent.operation_id)
              retainFailure = retainCurrentFailure
            if (state.state !== "ready" && state.operation_id !== intent.operation_id)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "Another current operation owns this page."),
              )
            if (!ownerRetired && state.state !== "ready" && record === undefined)
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_UNRESOLVED",
                  "The unfinished owner has no observable current intent. Inspect it before writing.",
                ),
              )
            if (ownerRetired) {
              settled = true
            } else if (
              state.state === "ready" &&
              (alreadyRetiring || (!cancelProjection && payload.in_flight?.key === "$owner.ready"))
            ) {
              ownerReady = true
              // The exact ready owner (with an empty Operation) is the actual
              // acknowledgement of a lost ready PATCH. Keep the finite Record
              // until full target verification, but allow only read-only children.
              if (!cancelProjection && payload.in_flight?.key === "$owner.ready") settled = true
            } else if (state.state === "ready" && record !== undefined && !preserveReadyOwner)
              yield* changeOwner("applying")
            else if (
              !cancelProjection &&
              (payload.in_flight?.key === "$owner.applying" ||
                payload.in_flight?.key === "$owner.attention")
            ) {
              yield* changeOwner(
                payload.in_flight.key === "$owner.applying" ? "applying" : "attention",
              )
              yield* changeOwner("applying")
            }
          }
          if (execution.kind === "cancel_projection" && !settled)
            yield* execution.reconcile({
              operation_id: session.operation_id,
              intent: session.intent,
              owner: session.owner,
              get ownerPageId() {
                return session.ownerPageId
              },
              get pendingActionKey() {
                return session.pendingActionKey
              },
              assertCurrent: session.assertCurrent,
              reconcilePendingAction,
            })
          const value = yield* input.run(session)
          yield* input.verify(session, value)
          if (
            "source_input" in intent &&
            (payload.source_progress?.next_index !==
              intent.source_input.affected_skill_ids.length ||
              payload.source_progress.child_started)
          )
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_PENDING",
                "The complete Source child scope has not finished.",
              ),
            )
          if (record === undefined && !alreadyRetiring && completion === "ready") return value
          if (record !== undefined && payload.predecessor !== undefined) {
            const actual = yield* queryCurrentSharedOperationRecord(library, { recordId, entityId })
            if (
              actual === undefined ||
              actual.page_id !== record.page_id ||
              actual.operation_id !== intent.operation_id
            )
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_CONFLICT",
                  "The successor Record is no longer the unique current operation.",
                ),
              )
          }
          if (!settled && (cancelProjection || payload.in_flight?.key !== "$owner." + completion))
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_PENDING",
                "The caller did not reconcile the pending current action.",
                { pending_action: payload.in_flight?.key },
              ),
            )
          if (completion === "retired") yield* retireOwner(value)
          else if (preserveReadyOwner) yield* session.assertCurrent()
          else yield* changeOwner("ready")
          ownerReady = true
          if (record !== undefined) {
            yield* saveLocal({ phase: "retiring", record_page_id: record.page_id })
            yield* archiveCurrentSharedOperationRecord(library, record)
          } else if (pending?.lifecycle.phase === "retiring") {
            yield* observeRetiredOperation(library, pending.lifecycle.record_page_id)
          }
          yield* store.retireKeys([key])
          return value
        })
        return yield* execute.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Applying already blocks consumption. Exhaustion and cancellation do not
              // start another runtime or issue best-effort cleanup writes.
              if (
                !preserveReadyOwner &&
                record !== undefined &&
                settled &&
                !payloadWriteUncertain &&
                (input.afterActivate === undefined || activationScopeConfirmed) &&
                owner !== null &&
                !ownerReady &&
                ![
                  "REQUEST_BUDGET_EXHAUSTED",
                  "RATE_LIMITED",
                  "CANCELLED",
                  "SOURCE_CANCELLED",
                ].includes(error.code)
              )
                yield* changeOwner("attention").pipe(Effect.catch(() => Effect.void))
              return yield* Effect.fail(error)
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              closed = true
            }),
          ),
        )
      }),
    ).pipe(Effect.mapError((error) => retainFailure?.(error) ?? error))
  })
}
