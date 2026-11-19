import { Crypto, Effect, Schema } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { CurrentSourceIdSchema, parseCurrentSkillState } from "./shared-current-file.ts"
import {
  archiveCurrentSharedOperationRecord,
  currentRecordText,
  queryCurrentSharedOperationRecord,
  writeCurrentSharedOperationRecord,
} from "./shared-current-records.ts"
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
const SourceInputSchema = Schema.Struct({
  configuration_sha256: Hash,
  resolved_commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  affected_skill_ids: Schema.Array(StableId).check(
    Schema.isMaxLength(10000),
    Schema.makeFilter(
      (ids) => new Set(ids).size === ids.length || "Affected Skill IDs must be unique.",
    ),
  ),
})
export const CurrentOperationIntentSchema = Schema.Union([
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
    source_input: SourceInputSchema,
  }),
])
export type CurrentOperationIntent = typeof CurrentOperationIntentSchema.Type
const ActionSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  request_sha256: Hash,
  replay: Schema.Literals(["never", "idempotent"]),
})
type ActionMarker = typeof ActionSchema.Type
const SourceProgressSchema = Schema.Struct({
  next_index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  child_started: Schema.Boolean,
})
export type CurrentSourceProgress = typeof SourceProgressSchema.Type
const PayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("current_operation"),
  library_id: Schema.String,
  owner_data_source_id: Schema.String,
  intent: CurrentOperationIntentSchema,
  in_flight: Schema.NullOr(ActionSchema),
  source_progress: Schema.optional(SourceProgressSchema),
})
type CurrentPayload = typeof PayloadSchema.Type
export const CurrentWritePendingSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Schema.String,
  record_id: Schema.String,
  intent: CurrentOperationIntentSchema,
  lifecycle: Schema.Union([
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
  return payload
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
export function currentOperationOwnerState(
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
  const state = property(field("Current State", "select").select).name
  if (typeof state !== "string") throw invalid("The current owner has no state.")
  return parseCurrentSkillState(state, rich("Operation"))
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
          skill_page_id: page,
          ...("source" in intent && intent.source !== undefined
            ? { source_intent: intent.source }
            : {}),
        }
      : {
          source_id: intent.owner.id,
          source_page_id: page,
          required_state:
            "Keep the original local Store and credentials. An unknown write cannot be safely recreated from an empty local state.",
        }),
    input_sha256: intent.input_sha256,
    next: "reconcile_current",
    required_input:
      intent.owner.kind === "source"
        ? "Resupply the original Source declaration with --operation and --resume."
        : "Resupply the same prepared input; its exact fingerprint is required.",
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

/** Read the one current intent before provider discovery, including a not-yet-observed CREATE. */
export function readCurrentOperationIntent(library: SharedLibrary, owner: CurrentOperationOwner) {
  return Effect.gen(function* () {
    const address = yield* operationAddress(library, owner),
      store = yield* Store
    const pending = yield* store.readJson(address.key, CurrentWritePendingSchema)
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
    if (record === undefined)
      return pending === undefined ? undefined : { intent: pending.intent, owner_page_id: null }
    const payload = yield* checked(() => decodePayload(record.payload))
    if (
      payload.library_id !== library.library_id ||
      payload.owner_data_source_id !== address.dataSourceId ||
      canonicalSharedJson(payload.intent.owner) !== canonicalSharedJson(owner) ||
      payload.intent.operation_id !== record.operation_id ||
      (record.owner !== null && record.owner.kind !== owner.kind) ||
      (pending !== undefined &&
        (!sameIntent(pending.intent, payload.intent) ||
          (pending.lifecycle.phase !== "creating" &&
            pending.lifecycle.record_page_id !== record.page_id)))
    )
      return yield* Effect.fail(
        invalid("The current Operation locator, input or owner is inconsistent."),
      )
    return { intent: payload.intent, owner_page_id: record.owner?.page_id ?? null }
  })
}

/** One mutable current intent. The local lock coordinates this Store, never remote writers. */
export function withCurrentOperation<A, R>(
  library: SharedLibrary,
  input: {
    readonly intent: CurrentOperationIntent
    readonly ownerPageId: string | null
    readonly mode?: "apply" | "resume"
    readonly assertScope?: Effect.Effect<void, SkillsError, R>
    readonly beforeMutation?: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
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
  },
): Effect.Effect<A, SkillsError, R | Notion | Crypto.Crypto | Store> {
  return Effect.gen(function* () {
    const intent = yield* checked(() =>
      strict(CurrentOperationIntentSchema, structuredClone(input.intent)),
    )
    const suppliedPage = yield* checked(() =>
      input.ownerPageId === null ? null : uuid(input.ownerPageId),
    )
    let mode = input.mode ?? "apply"
    if (mode !== "apply" && mode !== "resume")
      return yield* Effect.fail(invalid("Use apply or resume for a current intent."))
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
    const address = yield* operationAddress(library, intent.owner)
    const { scope, recordId, entityId, key } = address
    // Created inside Effect.gen: reusing this Effect cannot retain another
    // invocation's confirmation or attach a merely supplied operation ID.
    let retainFailure: ((error: SkillsError) => SkillsError) | undefined
    return yield* withLocalLocks(
      store.root,
      [address.lock],
      Effect.gen(function* () {
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
          const current = yield* checked(() =>
            currentOperationOwnerState(library, stale.intent, suppliedPage, ownerRaw),
          )
          if (current.state !== "ready")
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
        let owner = record?.owner?.page_id ?? suppliedPage
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
              lifecycle,
              ...(notDispatched === undefined ? {} : { not_dispatched: notDispatched }),
            }
            yield* store.writeJson(key, next)
            pending = next
          })
        const alreadyRetiring = pending?.lifecycle.phase === "retiring"
        const notDispatched = pending?.not_dispatched
        let settled =
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
            if (closed || ownerReady || completedReadOnly)
              return yield* Effect.fail(
                invalid("A completed current intent cannot begin a mutation."),
              )
            if (!mutationScopeConfirmed) {
              if (input.beforeMutation !== undefined) yield* input.beforeMutation
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
            if (owner !== null) yield* changeOwner("applying")
          })
        const dispatch = <B, R2>(
          action: CurrentOperationAction<B, R2>,
          internal = false,
        ): Effect.Effect<B, SkillsError, R2 | Notion | Crypto.Crypto | Store> =>
          Effect.gen(function* () {
            if (closed) return yield* Effect.fail(invalid("The current intent session is closed."))
            if (dispatching && !internal)
              return yield* Effect.fail(
                invalid("Actions within one current intent must run sequentially."),
              )
            if (!internal) dispatching = true
            return yield* Effect.gen(function* () {
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
              const hash = yield* sha256(canonicalSharedJson(request))
              const marker: ActionMarker = {
                key: action.key,
                request_sha256: hash,
                replay: action.replay,
              }
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
              if (ownerReady && action.key !== "$owner.ready")
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
              if (owner === null)
                yield* checked(() => {
                  const body = property(request.body),
                    properties = property(body.properties)
                  if (
                    request.path !== "v1/pages" ||
                    request.method !== "POST" ||
                    property(body.parent).data_source_id !==
                      ownerTable(library, intent.owner).data_source_id
                  )
                    throw invalid(
                      "Bind the created owner before writing its content or child targets.",
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
        const observeOwner = () =>
          Effect.gen(function* () {
            const page = owner
            if (page === null)
              return yield* Effect.fail(invalid("The current intent has no physical owner."))
            const raw = yield* api.request("v1/pages/" + page)
            return yield* checked(() => currentOperationOwnerState(library, intent, page, raw))
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
              const state = yield* checked(() =>
                currentOperationOwnerState(library, intent, owner!, raw),
              )
              if (
                state.state === "ready"
                  ? !ownerReady && (record !== undefined || pending !== undefined)
                  : record === undefined || state.operation_id !== intent.operation_id
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
              const selected = yield* checked(() => uuid(page))
              if (owner !== null && owner !== selected)
                return yield* Effect.fail(
                  fail("CURRENT_OPERATION_CONFLICT", "A current intent cannot switch owner pages."),
                )
              const raw = yield* api.request("v1/pages/" + selected)
              const state = yield* checked(() =>
                currentOperationOwnerState(library, intent, selected, raw),
              )
              if (state.state === "ready" || state.operation_id !== intent.operation_id)
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
          if (input.assertScope !== undefined) yield* input.assertScope
          if (
            mode === "resume" &&
            record === undefined &&
            pending === undefined &&
            input.verifyCompletedResume !== undefined
          ) {
            if (owner === null || (yield* observeOwner()).state !== "ready")
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_NOT_FOUND",
                  "A completed resume requires the exact ready owner.",
                ),
              )
            completedReadOnly = true
            return yield* input.verifyCompletedResume(session)
          }
          if (owner !== null) {
            const state = yield* observeOwner()
            if (alreadyRetiring && state.state !== "ready")
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
            if (state.state !== "ready" && record === undefined)
              return yield* Effect.fail(
                fail(
                  "CURRENT_OPERATION_UNRESOLVED",
                  "The unfinished owner has no observable current intent. Inspect it before writing.",
                ),
              )
            if (
              state.state === "ready" &&
              (alreadyRetiring || payload.in_flight?.key === "$owner.ready")
            ) {
              ownerReady = true
              // The exact ready owner (with an empty Operation) is the actual
              // acknowledgement of a lost ready PATCH. Keep the finite Record
              // until full target verification, but allow only read-only children.
              if (payload.in_flight?.key === "$owner.ready") settled = true
            } else if (state.state === "ready" && record !== undefined)
              yield* changeOwner("applying")
            else if (
              payload.in_flight?.key === "$owner.applying" ||
              payload.in_flight?.key === "$owner.attention"
            ) {
              yield* changeOwner(
                payload.in_flight.key === "$owner.applying" ? "applying" : "attention",
              )
              yield* changeOwner("applying")
            }
          }
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
          if (record === undefined && !alreadyRetiring) return value
          if (!settled && payload.in_flight?.key !== "$owner.ready")
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_PENDING",
                "The caller did not reconcile the pending current action.",
                { pending_action: payload.in_flight?.key },
              ),
            )
          yield* changeOwner("ready")
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
