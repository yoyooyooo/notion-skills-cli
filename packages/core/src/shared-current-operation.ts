import { Crypto, Effect, Schema } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { parseCurrentSkillState } from "./shared-current-file.ts"
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
export const CurrentSkillWriteIntentSchema = Schema.Struct({
  operation_id: StableId,
  skill_id: StableId,
  input_sha256: Hash,
})
export type CurrentSkillWriteIntent = typeof CurrentSkillWriteIntentSchema.Type
const ActionSchema = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  request_sha256: Hash,
  replay: Schema.Literals(["never", "idempotent"]),
})
type ActionMarker = typeof ActionSchema.Type
const PayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("current_skill_write"),
  library_id: Schema.String,
  skills_data_source_id: Schema.String,
  intent: CurrentSkillWriteIntentSchema,
  in_flight: Schema.NullOr(ActionSchema),
})
type CurrentPayload = typeof PayloadSchema.Type
export const CurrentWritePendingSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  library_id: Schema.String,
  record_id: Schema.String,
  intent: CurrentSkillWriteIntentSchema,
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
  readonly skill_id: string
  readonly skillPageId: string | null
  readonly pendingActionKey: string | undefined
  readonly bindSkill: (
    page: string,
  ) => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
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
function uuid(input: string): string {
  if (
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("Use an exact Notion page identity.")
  const result = pageId(input)
  if (result === undefined) throw invalid("Use an exact Notion page identity.")
  return result
}
function binding(library: SharedLibrary, name: string): string {
  const id = library.skills.property_ids[name]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A current Skill property is missing.", {
      missing: name,
      next: "migrate_current_content",
    })
  return id
}
function ownerState(
  library: SharedLibrary,
  intent: CurrentSkillWriteIntent,
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
    uuid(parent.data_source_id) !== uuid(library.skills.data_source_id)
  )
    throw fail(
      "CURRENT_OPERATION_CONFLICT",
      "The current Skill owner is unavailable or belongs to another table.",
    )
  const field = (name: string, type: string) => {
    const id = binding(library, name),
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
  if (rich("Skill ID") !== intent.skill_id)
    throw fail(
      "CURRENT_OPERATION_CONFLICT",
      "The physical Skill page has a different stable identity.",
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
function sameIntent(a: CurrentSkillWriteIntent, b: CurrentSkillWriteIntent): boolean {
  return (
    a.operation_id === b.operation_id &&
    a.skill_id === b.skill_id &&
    a.input_sha256 === b.input_sha256
  )
}
function recovery(
  error: SkillsError,
  intent: CurrentSkillWriteIntent,
  marker: ActionMarker | null,
  page: string | null,
) {
  return fail(error.code, error.message, {
    ...property(error.details),
    operation_id: intent.operation_id,
    skill_id: intent.skill_id,
    skill_page_id: page,
    input_sha256: intent.input_sha256,
    next: "reconcile_current",
    required_input: "Resupply the same prepared input; its exact fingerprint is required.",
    ...(marker === null ? {} : { action: marker.key, replay: marker.replay }),
  })
}

/** One mutable current intent. The local lock coordinates this Store, never remote writers. */
export function withCurrentSkillOperation<A, R>(
  library: SharedLibrary,
  input: {
    readonly intent: CurrentSkillWriteIntent
    readonly skillPageId: string | null
    readonly mode?: "apply" | "resume"
    readonly run: (session: CurrentOperationSession) => Effect.Effect<A, SkillsError, R>
    readonly verify: (
      session: CurrentOperationSession,
      value: A,
    ) => Effect.Effect<void, SkillsError, R>
  },
): Effect.Effect<A, SkillsError, R | Notion | Crypto.Crypto | Store> {
  return Effect.gen(function* () {
    const intent = yield* checked(() => strict(CurrentSkillWriteIntentSchema, input.intent))
    const suppliedPage = yield* checked(() =>
      input.skillPageId === null ? null : uuid(input.skillPageId),
    )
    const mode = input.mode ?? "apply"
    if (mode !== "apply" && mode !== "resume")
      return yield* Effect.fail(invalid("Use apply or resume for a current intent."))
    yield* checked(() => {
      for (const name of ["Skill ID", "Current State", "Operation"]) binding(library, name)
      uuid(library.skills.data_source_id)
    })
    const api = yield* Notion,
      store = yield* Store
    const scope = yield* sha256(
      canonicalSharedJson([
        api.apiOrigin ?? "https://api.notion.com",
        yield* api.credentialIdentity,
        library.library_id,
      ]),
    )
    const target = yield* sha256(
      canonicalSharedJson([library.library_id, library.skills.data_source_id, intent.skill_id]),
    )
    const recordId = "operation-current-" + target,
      entityId = "current-skill:" + intent.skill_id
    const key =
      "operations/current-write-pending/" +
      (yield* sha256(canonicalSharedJson([scope, target]))) +
      "/pending.json"
    return yield* withLocalLocks(
      store.root,
      [
        "current-skill:" +
          (api.apiOrigin ?? "https://api.notion.com") +
          ":" +
          library.skills.data_source_id +
          ":" +
          intent.skill_id,
      ],
      Effect.gen(function* () {
        let pending = yield* store.readJson(key, CurrentWritePendingSchema)
        if (
          pending !== undefined &&
          (pending.scope !== scope ||
            pending.library_id !== library.library_id ||
            pending.record_id !== recordId)
        )
          return yield* Effect.fail(
            recovery(
              fail(
                "CURRENT_OPERATION_PENDING",
                "A different current input is unfinished for this Skill.",
              ),
              pending.intent,
              null,
              suppliedPage,
            ),
          )
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
              recovery(
                fail(
                  "CURRENT_OPERATION_PENDING",
                  "A different current input is unfinished for this Skill.",
                ),
                stale.intent,
                null,
                suppliedPage,
              ),
            )
          const recordPage = stale.lifecycle.record_page_id
          const ownerRaw = yield* api.request("v1/pages/" + suppliedPage)
          const current = yield* checked(() =>
            ownerState(library, stale.intent, suppliedPage, ownerRaw),
          )
          if (current.state !== "ready")
            return yield* Effect.fail(
              recovery(
                fail("CURRENT_OPERATION_PENDING", "The previous current owner is not ready."),
                stale.intent,
                null,
                suppliedPage,
              ),
            )
          const retiredPage = yield* checked(() => uuid(recordPage))
          const retiredRaw = yield* api.request("v1/pages/" + retiredPage)
          yield* checked(() => {
            const row = property(retiredRaw),
              parent = property(row.parent)
            if (
              row.object !== "page" ||
              typeof row.id !== "string" ||
              uuid(row.id) !== retiredPage ||
              row.in_trash !== true ||
              parent.type !== "data_source_id" ||
              typeof parent.data_source_id !== "string" ||
              uuid(parent.data_source_id) !== uuid(library.records.data_source_id)
            )
              throw fail(
                "CURRENT_OPERATION_PENDING",
                "The previous Operation has not been observed in trash. Keep its current locator.",
              )
          })
          yield* store.retireKeys([key])
          pending = undefined
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
        let owner = record?.skill_page_id ?? suppliedPage
        if (
          record?.skill_page_id !== null &&
          record?.skill_page_id !== undefined &&
          suppliedPage !== null &&
          record.skill_page_id !== suppliedPage
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_OPERATION_CONFLICT",
              "The intent is bound to a different physical Skill page.",
            ),
          )
        let payload: CurrentPayload = {
          version: 1,
          kind: "current_skill_write",
          library_id: library.library_id,
          skills_data_source_id: uuid(library.skills.data_source_id),
          intent,
          in_flight: null,
        }
        if (record !== undefined) {
          const found = record
          payload = yield* checked(() => strict(PayloadSchema, found.payload))
          if (
            payload.library_id !== library.library_id ||
            payload.skills_data_source_id !== uuid(library.skills.data_source_id) ||
            !sameIntent(payload.intent, intent) ||
            record.operation_id !== intent.operation_id
          )
            return yield* Effect.fail(
              recovery(
                fail("CURRENT_OPERATION_PENDING", "A different current intent owns this Skill."),
                payload.intent,
                payload.in_flight,
                owner,
              ),
            )
        }
        if (record === undefined && pending !== undefined && pending.lifecycle.phase !== "retiring")
          return yield* Effect.fail(
            recovery(
              fail(
                "CURRENT_OPERATION_UNRESOLVED",
                "The current operation CREATE has not been observed; do not repeat it from absence.",
              ),
              intent,
              null,
              owner,
            ),
          )
        if (record === undefined && pending === undefined && mode === "resume")
          return yield* Effect.fail(
            recovery(
              fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished current intent was found."),
              intent,
              null,
              owner,
            ),
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
        if (record !== undefined && !alreadyRetiring)
          yield* saveLocal({ phase: "active", record_page_id: record.page_id }, notDispatched)
        let settled =
          payload.in_flight === null ||
          (notDispatched !== undefined &&
            canonicalSharedJson(notDispatched) === canonicalSharedJson(payload.in_flight))
        let ownerReady = alreadyRetiring
        let dispatching = false
        const persist = (marker: ActionMarker | null) =>
          Effect.gen(function* () {
            if (record === undefined)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "The current operation is already retired."),
              )
            const next: CurrentPayload = { ...payload, in_flight: marker }
            record = yield* writeCurrentSharedOperationRecord(library, {
              current: record,
              recordId,
              operationId: intent.operation_id,
              entityId,
              skillPageId: owner,
              payload: next,
            })
            payload = next
            settled = marker === null
          })
        const ensureOpen = () =>
          Effect.gen(function* () {
            if (record !== undefined) return
            if (alreadyRetiring)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "A retiring intent cannot begin new work."),
              )
            yield* saveLocal({ phase: "creating" })
            const written = yield* writeCurrentSharedOperationRecord(library, {
              current: null,
              recordId,
              operationId: intent.operation_id,
              entityId,
              skillPageId: owner,
              payload,
            }).pipe(Effect.result)
            if (written._tag === "Failure") {
              if (definitive(written.failure)) yield* store.retireKeys([key])
              return yield* Effect.fail(recovery(written.failure, intent, null, owner))
            }
            record = written.success
            yield* saveLocal({ phase: "active", record_page_id: record.page_id })
            if (owner !== null) yield* changeOwner("applying")
          })
        const dispatch = <B, R2>(
          action: CurrentOperationAction<B, R2>,
          internal = false,
        ): Effect.Effect<B, SkillsError, R2 | Notion | Crypto.Crypto | Store> =>
          Effect.gen(function* () {
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
                    "A ready Skill cannot resume an incomplete earlier write.",
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
                    property(body.parent).data_source_id !== library.skills.data_source_id
                  )
                    throw invalid("Bind the created Skill before writing its content or Files.")
                  if (
                    text(property(properties[binding(library, "Skill ID")]).rich_text) !==
                      intent.skill_id ||
                    text(property(properties[binding(library, "Operation")]).rich_text) !==
                      intent.operation_id ||
                    property(property(properties[binding(library, "Current State")]).select)
                      .name !== "applying"
                  )
                    throw invalid(
                      "Create the Skill with its stable identity, applying state and current Operation together.",
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
              return yield* Effect.fail(invalid("The current intent has no physical Skill owner."))
            const raw = yield* api.request("v1/pages/" + page)
            return yield* checked(() => ownerState(library, intent, page, raw))
          })
        const changeOwner = (next: "applying" | "ready" | "attention") =>
          Effect.gen(function* () {
            const page = owner
            if (page === null)
              return yield* Effect.fail(invalid("Bind a Skill before changing its current state."))
            const properties = {
              [binding(library, "Current State")]: { select: { name: next } },
              [binding(library, "Operation")]: {
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
                          "Another current operation owns this Skill.",
                        ),
                      )
                    return state.state === next
                      ? { status: "complete" as const, value: undefined }
                      : { status: "missing" as const }
                  }),
                acknowledge: (raw) =>
                  checked(() => {
                    const state = ownerState(library, intent, page, raw)
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
          skill_id: intent.skill_id,
          get skillPageId() {
            return owner
          },
          get pendingActionKey() {
            return settled ? undefined : payload.in_flight?.key
          },
          dispatch,
          bindSkill: (page) =>
            Effect.gen(function* () {
              const selected = yield* checked(() => uuid(page))
              if (owner !== null && owner !== selected)
                return yield* Effect.fail(
                  fail("CURRENT_OPERATION_CONFLICT", "A current intent cannot switch Skill pages."),
                )
              const raw = yield* api.request("v1/pages/" + selected)
              const state = yield* checked(() => ownerState(library, intent, selected, raw))
              if (state.state === "ready" || state.operation_id !== intent.operation_id)
                return yield* Effect.fail(
                  fail(
                    "CURRENT_OPERATION_CONFLICT",
                    "The created Skill was not marked for this current intent.",
                  ),
                )
              owner = selected
              if (record?.skill_page_id !== selected) {
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
          if (owner !== null) {
            const state = yield* observeOwner()
            if (state.state !== "ready" && state.operation_id !== intent.operation_id)
              return yield* Effect.fail(
                fail("CURRENT_OPERATION_CONFLICT", "Another current operation owns this Skill."),
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
            )
              ownerReady = true
            else if (state.state === "ready" && record !== undefined) yield* changeOwner("applying")
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
              return yield* Effect.fail(
                recovery(error, intent, settled ? null : payload.in_flight, owner),
              )
            }),
          ),
        )
      }),
    )
  })
}
