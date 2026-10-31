import { Clock, Effect, Schema } from "effect"
import { decode, fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  decideObservedBody,
  FileEventSchema,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
} from "./shared-file-state.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type SharedRecord,
} from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  bodyWriteChecked,
  bodyWriteEventDescription,
  bodyWriteObservationId,
  bodyWriteOutcomeId,
  bodyWriteOutcomesEntity,
  makeSharedBodyWritePlan,
  plannedBodyWriteEventId,
  retainedMarkdownPayload,
  validateSharedBodyWritePlan,
  type FrozenWriteBody,
  type RestoreSource,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import { sha256 } from "./store.ts"

export {
  SharedBodyWritePlanSchema,
  sharedBodyWriteProtection,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"

const MarkdownResultSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("body_write_outcome"),
  operation_id: Schema.String,
  file_id: Schema.String,
  status: Schema.Literals(["not_sent", "rejected", "needs_review", "applied"]),
  reason_code: Schema.String,
  observation_id: Schema.optional(Schema.String),
  observed_result_retention: Schema.optional(Schema.Literals(["verified", "not_stored"])),
  event_id: Schema.optional(Schema.String),
})
type Outcome = typeof OutcomeSchema.Type

function decodedBody(raw: unknown, pageId: string) {
  const value = decode(MarkdownResultSchema, raw)
  if (
    value.id !== pageId ||
    value.truncated ||
    value.unknown_block_ids.length !== 0 ||
    (value.warnings?.length ?? 0) !== 0
  )
    throw fail(
      "BODY_INCOMPLETE",
      "A whole-file write requires a complete, warning-free response for its exact page.",
    )
  return { raw_markdown: value.markdown, markdown: normalizeObservedBody(value.markdown) }
}

function readExactBody(pageId: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${pageId}/markdown?markdown_version=v2`)
    const body = yield* bodyWriteChecked(() => decodedBody(raw, pageId))
    return {
      page_id: pageId,
      ...body,
      fingerprint: { normalization_version: 1 as const, sha256: yield* sha256(body.markdown) },
      bytes: new TextEncoder().encode(body.markdown).byteLength,
      downloaded_at: yield* Clock.currentTimeMillis,
    } satisfies FrozenWriteBody
  })
}

function fileEvents(library: SharedLibrary, skillPageId: string, fileId: string) {
  return Effect.gen(function* () {
    const facts = yield* querySharedRecords(library, {
      skillPageId,
      kind: "file_event",
      entityId: fileId,
    })
    return yield* bodyWriteChecked(() =>
      facts.map((fact) => {
        const event = decode(FileEventSchema, fact.payload)
        if (
          fact.record_id !== event.event_id ||
          fact.entity_id !== event.file_id ||
          event.file_id !== fileId
        )
          throw fail(
            "SHARED_STATE_SCOPE",
            "A file event does not match the selected write identity.",
          )
        return event
      }),
    )
  })
}

function currentContext(library: SharedLibrary, skillPageId: string, fileId: string) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(library, skillPageId)
    const binding = [index.main, ...index.files].find((file) => file.file_id === fileId)
    if (!binding || !index.enabled)
      return yield* Effect.fail(
        fail("SHARED_BODY_WRITE_SCOPE", "The selected active Skill/file binding is unavailable."),
      )
    const events = yield* fileEvents(library, skillPageId, fileId)
    const state = yield* bodyWriteChecked(() => resolveFileState(fileId, events))
    return { index, binding, events, state }
  })
}

function validateSource(
  library: SharedLibrary,
  skillPageId: string,
  selected: string,
  source: RestoreSource | undefined,
) {
  return Effect.gen(function* () {
    if (source === undefined) return
    if (source.source_id !== selected || selected === "")
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_STALE",
          "The exact source selected in Notion differs from the frozen restore source.",
        ),
      )
    const binding = yield* resolveSourceBinding(library, {
      skillPageId,
      sourceId: source.source_id,
    })
    if (
      binding.commit !== source.revision ||
      !binding.files.some((file) => file.path === source.path)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_FILE_MISSING",
          "The frozen restore revision/path is not in the exact selected source.",
        ),
      )
  })
}

/**
 * The caller supplies already resolved, verified source projection bytes for
 * restore_follow. This module never downloads providers or guesses latest.
 */
export function prepareSharedBodyWrite(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly fileId: string
  readonly candidateMarkdown: string
  readonly action: "write" | "restore_follow"
  readonly source?: RestoreSource
  readonly expected?: { readonly heads: readonly string[]; readonly body_sha256: string }
}) {
  return Effect.gen(function* () {
    const context = yield* currentContext(input.library, input.skillPageId, input.fileId)
    const headers = yield* querySharedOperationIndex(input.library, input.skillPageId)
    const pending = yield* loadPendingSharedBodyWrites(input.library, {
      skillPageId: input.skillPageId,
      events: context.events,
      headers: headers.filter(
        (header) =>
          header.entity_id === input.fileId || header.entity_id === bodyWriteOutcomesEntity,
      ),
    })
    const original = pending.find((plan) => plan.file_id === input.fileId)
    if (original !== undefined)
      return yield* Effect.fail(
        recoveryError(
          fail(
            "SHARED_BODY_WRITE_PENDING",
            "Reconcile the original shared write before reading a new preimage or planning another write.",
          ),
          original,
          "pending",
        ),
      )
    if (context.state.ownership.kind === "tombstone")
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_SCOPE",
          "A deleted file requires an explicit lifecycle restoration before this body-write path.",
        ),
      )
    if (input.action === "restore_follow" && input.source === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_UNAVAILABLE",
          "Restore-follow requires already verified bytes from the exact selected source.",
        ),
      )
    if (input.action === "write" && input.source !== undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "An ordinary write cannot change the selected source."),
      )
    yield* validateSource(
      input.library,
      input.skillPageId,
      context.index.source_reference,
      input.source,
    )
    const before = yield* readExactBody(context.binding.page_id)
    const decision = yield* bodyWriteChecked(() =>
      decideObservedBody(context.state.ownership, before.fingerprint),
    )
    if (decision.kind !== "unchanged")
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_STALE",
          "The current full body differs from its shared state. Observe and retain that user edit before preparing a write.",
        ),
      )
    if (
      input.expected !== undefined &&
      (input.expected.body_sha256 !== before.fingerprint.sha256 ||
        canonicalSharedJson([...input.expected.heads].sort()) !==
          canonicalSharedJson(context.state.heads))
    )
      return yield* Effect.fail(
        fail("SHARED_BODY_WRITE_STALE", "The selected pinned body or event frontier is stale."),
      )
    const plan = yield* makeSharedBodyWritePlan({
      library_id: input.library.library_id,
      skill_page_id: input.skillPageId,
      skill_id: context.index.skill_id,
      file_id: input.fileId,
      page_id: context.binding.page_id,
      path: context.binding.path,
      source_id: context.index.source_reference,
      action: input.action,
      ...(input.source === undefined ? {} : { restore_source: input.source }),
      before,
      candidateMarkdown: input.candidateMarkdown,
      parents: context.state.heads,
    })
    yield* bodyWriteChecked(() => resolveFileState(input.fileId, [...context.events, plan.event]))
    return plan
  })
}

function recoveryError(error: SkillsError, plan: SharedBodyWritePlan, stage: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    body_write_operation_id: plan.operation_id,
    body_write_stage: stage,
    recovery: { version: 1, mode: "reconcile", plan },
    ...(stage === "plan" && error.code === "WRITE_OUTCOME_UNKNOWN"
      ? {
          first_plan_visibility_boundary: true,
          limitation:
            "An empty independent client cannot distinguish an invisible first plan from a never-sent plan.",
        }
      : {}),
  })
}

function verifyScope(library: SharedLibrary, plan: SharedBodyWritePlan) {
  if (library.library_id !== plan.library_id)
    throw fail(
      "SHARED_BODY_WRITE_SCOPE",
      "The original body write belongs to a different shared library.",
    )
}

function verifyCurrent(library: SharedLibrary, plan: SharedBodyWritePlan, includeBody: boolean) {
  return Effect.gen(function* () {
    const context = yield* currentContext(library, plan.skill_page_id, plan.file_id)
    if (
      context.index.skill_id !== plan.skill_id ||
      context.binding.page_id !== plan.page_id ||
      context.binding.path !== plan.path ||
      context.index.source_reference !== plan.source_id ||
      canonicalSharedJson(context.state.heads) !== canonicalSharedJson(plan.event.parents)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_STALE",
          "The frozen identity, path, source selection or event frontier changed.",
        ),
      )
    yield* validateSource(
      library,
      plan.skill_page_id,
      context.index.source_reference,
      plan.restore_source,
    )
    yield* bodyWriteChecked(() => resolveFileState(plan.file_id, [...context.events, plan.event]))
    if (includeBody) {
      const current = yield* readExactBody(plan.page_id)
      if (
        current.raw_markdown !== plan.before.raw_markdown ||
        current.fingerprint.sha256 !== plan.before.fingerprint.sha256
      )
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_STALE",
            "The complete old matching body changed before dispatch.",
          ),
        )
    }
    return context
  })
}

function retainPlannedBodies(
  library: SharedLibrary,
  plan: SharedBodyWritePlan,
  mode: "create" | "reconcile",
) {
  return Effect.gen(function* () {
    const bodies = new Map([
      [plan.before.fingerprint.sha256, plan.before.markdown],
      [plan.candidate.content.sha256, plan.candidate.markdown],
    ])
    for (const [hash, markdown] of bodies)
      yield* appendSharedRecord(library, {
        mode,
        recordId: `body-${hash}`,
        operationId: `retain-${hash}`,
        skillPageId: plan.skill_page_id,
        kind: "object",
        entityId: `body-${hash}`,
        payload: retainedMarkdownPayload(markdown),
      }).pipe(
        Effect.mapError((error) =>
          recoveryError(
            error,
            plan,
            hash === plan.before.fingerprint.sha256 ? "original_object" : "candidate_object",
          ),
        ),
      )
  })
}

function decodeOutcome(record: SharedRecord): Outcome {
  const outcome = Schema.decodeUnknownSync(OutcomeSchema)(record.payload, {
    onExcessProperty: "error",
  })
  if (
    !plannedBodyWriteEventId(outcome.operation_id) ||
    record.record_id !== bodyWriteOutcomeId(outcome.operation_id) ||
    record.operation_id !== outcome.operation_id ||
    record.entity_id !== bodyWriteOutcomesEntity ||
    (outcome.status === "needs_review"
      ? outcome.observed_result_retention === "verified"
        ? outcome.observation_id !== bodyWriteObservationId(outcome.operation_id)
        : outcome.observed_result_retention !== "not_stored" || outcome.observation_id !== undefined
      : outcome.observation_id !== undefined || outcome.observed_result_retention !== undefined) ||
    (outcome.status === "applied"
      ? outcome.event_id !== plannedBodyWriteEventId(outcome.operation_id)
      : outcome.event_id !== undefined)
  )
    throw fail(
      "SHARED_BODY_WRITE_INVALID",
      "A write outcome does not match its exact original operation.",
    )
  return outcome
}

function saveOutcome(
  library: SharedLibrary,
  plan: SharedBodyWritePlan,
  status: Outcome["status"],
  reasonCode: string,
  raw?: unknown,
) {
  return Effect.gen(function* () {
    let retention: "verified" | "not_stored" | undefined
    let retainedFailure: SkillsError | undefined
    if (status === "needs_review") {
      const result = yield* appendSharedRecord(library, {
        mode: "create",
        recordId: bodyWriteObservationId(plan.operation_id),
        operationId: plan.operation_id,
        skillPageId: plan.skill_page_id,
        kind: "object",
        entityId: bodyWriteObservationId(plan.operation_id),
        payload: {
          version: 1,
          kind: "body_write_observation",
          page_id: plan.page_id,
          response: raw === undefined ? null : raw,
          response_defined: raw !== undefined,
        },
        payloadContainsBody: true,
      }).pipe(Effect.result)
      if (result._tag === "Failure") {
        const error = result.failure
        retainedFailure = recoveryError(
          fail(
            error.code,
            "The returned response could not be verified as retained shared history. Keep the original operation and inspect this exact page; do not replay or roll back the write.",
            {
              ...property(error.details),
              original_and_candidate_retained: true,
              observed_result_retention:
                error.code === "SHARED_RECORD_TOO_LARGE" ? "not_stored" : "unverified",
              observed_page_id: plan.page_id,
            },
          ),
          plan,
          "observed_result",
        )
        // A deterministic envelope-size rejection sent no object POST. Retain
        // a compact review fact; unknown object requests stop immediately.
        if (error.code !== "SHARED_RECORD_TOO_LARGE") return yield* Effect.fail(retainedFailure)
        retention = "not_stored"
      } else retention = "verified"
    }
    const outcome: Outcome = {
      version: 1,
      kind: "body_write_outcome",
      operation_id: plan.operation_id,
      file_id: plan.file_id,
      status,
      reason_code: reasonCode,
      ...(retention === undefined ? {} : { observed_result_retention: retention }),
      ...(retention === "verified"
        ? { observation_id: bodyWriteObservationId(plan.operation_id) }
        : {}),
      ...(status === "applied" ? { event_id: plan.event.event_id } : {}),
    }
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: bodyWriteOutcomeId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: bodyWriteOutcomesEntity,
      payload: outcome,
    }).pipe(
      Effect.mapError((error) =>
        recoveryError(
          fail(error.code, error.message, {
            ...property(error.details),
            ...(retention === undefined ? {} : { observed_result_retention: retention }),
          }),
          plan,
          "outcome",
        ),
      ),
    )
    if (retainedFailure !== undefined) return yield* Effect.fail(retainedFailure)
    return outcome
  })
}

function isDefinitiveValidationRejection(error: SkillsError) {
  const details = property(error.details)
  return (
    error.code === "NOTION_REQUEST_FAILED" &&
    details.phase === "definitive_rejection" &&
    details.http_status === 400 &&
    details.notion_code === "validation_error"
  )
}

/** Reconciliation reads the original facts only; it never sends POST creates or PATCH. */
export function reconcileSharedBodyWrite(library: SharedLibrary, input: SharedBodyWritePlan) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedBodyWritePlan(input)
    yield* bodyWriteChecked(() => verifyScope(library, plan))
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: plan.file_id,
      payload: plan,
      payloadContainsBody: true,
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "plan")))
    yield* retainPlannedBodies(library, plan, "reconcile")
    const outcomes = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: bodyWriteOutcomesEntity,
      recordId: bodyWriteOutcomeId(plan.operation_id),
    })
    const rawOutcome = outcomes[0]
    let outcome: Outcome | undefined
    if (rawOutcome !== undefined) {
      outcome = yield* bodyWriteChecked(() => decodeOutcome(rawOutcome))
      if (outcome.file_id !== plan.file_id)
        return yield* Effect.fail(
          recoveryError(
            fail("SHARED_BODY_WRITE_SCOPE", "The recorded outcome belongs to another file."),
            plan,
            "outcome",
          ),
        )
      if (outcome.status === "needs_review")
        return yield* Effect.fail(
          recoveryError(
            fail(
              "SHARED_BODY_WRITE_REVIEW_REQUIRED",
              "The returned body was not the exact complete candidate. Both original versions remain retained; do not roll back or automatically adopt the result.",
              {
                observation_id: outcome.observation_id,
                observed_result_retention: outcome.observed_result_retention,
              },
            ),
            plan,
            "outcome",
          ),
        )
      if (outcome.status !== "applied")
        return {
          status: "not_applied" as const,
          operation_id: plan.operation_id,
          reason_code: outcome.reason_code,
          verified: true as const,
          requires_fresh_read: true as const,
        }
    }
    const facts = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      recordId: plan.event.event_id,
    })
    const completed = facts[0]
    if (completed !== undefined) {
      if (
        completed.operation_id !== plan.event.event_id ||
        canonicalSharedJson(completed.payload) !== canonicalSharedJson(plan.event)
      )
        return yield* Effect.fail(
          recoveryError(
            fail(
              "SHARED_RECORD_CONFLICT",
              "The recorded write event differs from the original frozen event.",
            ),
            plan,
            "event",
          ),
        )
      if (outcome?.status === "applied")
        return {
          status: "applied" as const,
          operation_id: plan.operation_id,
          event: plan.event,
          verified: true as const,
          requires_fresh_read: true as const,
        }
    }
    const current = yield* readExactBody(plan.page_id).pipe(
      Effect.mapError((error) => recoveryError(error, plan, "current_postcondition")),
    )
    return yield* Effect.fail(
      recoveryError(
        fail(
          "SHARED_BODY_WRITE_UNRESOLVED",
          "The original operation's completion and acceptance event are not both verified. Current bytes or another plan's content event do not authorize replay or missing fact creation.",
          {
            current_sha256: current.fingerprint.sha256,
            body_matches_before: current.raw_markdown === plan.before.raw_markdown,
            body_matches_candidate: current.fingerprint.sha256 === plan.candidate.content.sha256,
          },
        ),
        plan,
        "event",
      ),
    )
  })
}

/** One initial dispatch. Existing or unknown plans always take read-only recovery. */
export function executeSharedBodyWrite<R = never>(
  library: SharedLibrary,
  input: {
    readonly plan: SharedBodyWritePlan
    readonly mode: "create" | "reconcile"
    readonly beforePlanWrite?: (plan: SharedBodyWritePlan) => Effect.Effect<void, SkillsError, R>
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedBodyWritePlan(input.plan)
    yield* bodyWriteChecked(() => verifyScope(library, plan))
    if (input.mode === "reconcile") return yield* reconcileSharedBodyWrite(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Write mode must be create or reconcile."))
    const headers = yield* querySharedOperationIndex(library, plan.skill_page_id)
    if (headers.some((header) => header.record_id === plan.operation_id))
      return yield* reconcileSharedBodyWrite(library, plan)
    const prior = yield* fileEvents(library, plan.skill_page_id, plan.file_id)
    const pending = yield* loadPendingSharedBodyWrites(library, {
      skillPageId: plan.skill_page_id,
      events: prior,
      headers: headers.filter(
        (header) =>
          header.entity_id === plan.file_id || header.entity_id === bodyWriteOutcomesEntity,
      ),
    })
    if (pending[0] !== undefined)
      return yield* Effect.fail(
        recoveryError(
          fail(
            "SHARED_BODY_WRITE_PENDING",
            "An earlier whole-file write must be reconciled first.",
          ),
          pending[0],
          "pending",
        ),
      )
    // Recheck before allocating any receipt; ordinary stale preflight has no effects.
    const initial = yield* verifyCurrent(library, plan, true)
    if (plan.action === "write" && plan.before.fingerprint.sha256 === plan.candidate.content.sha256)
      return {
        status: "unchanged" as const,
        operation_id: plan.operation_id,
        state: initial.state,
        verified: true as const,
        requires_fresh_read: true as const,
      }
    if (input.beforePlanWrite !== undefined) yield* input.beforePlanWrite(plan)
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: plan.file_id,
      payload: plan,
      payloadContainsBody: true,
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "plan")))
    yield* retainPlannedBodies(library, plan, "create")
    const current = yield* verifyCurrent(library, plan, true).pipe(Effect.result)
    if (current._tag === "Failure") {
      yield* saveOutcome(library, plan, "not_sent", current.failure.code)
      return yield* Effect.fail(recoveryError(current.failure, plan, "pre_send"))
    }
    let response: unknown
    if (plan.before.fingerprint.sha256 === plan.candidate.content.sha256) {
      response = {
        id: plan.page_id,
        markdown: plan.before.raw_markdown,
        truncated: false,
        unknown_block_ids: [],
      }
    } else {
      const request = yield* (yield* Notion)
        .request(
          `v1/pages/${plan.page_id}/markdown`,
          {
            markdown_version: "v2",
            type: "update_content",
            update_content: {
              content_updates: [
                { old_str: plan.before.raw_markdown, new_str: plan.candidate.markdown },
              ],
            },
          },
          { method: "PATCH" },
        )
        .pipe(Effect.result)
      if (request._tag === "Failure") {
        if (isDefinitiveValidationRejection(request.failure))
          yield* saveOutcome(library, plan, "rejected", request.failure.code)
        return yield* Effect.fail(recoveryError(request.failure, plan, "body_request"))
      }
      response = request.success
    }
    const exact = yield* Effect.gen(function* () {
      const body = yield* bodyWriteChecked(() => decodedBody(response, plan.page_id))
      const hash = yield* sha256(body.markdown)
      if (
        hash !== plan.candidate.content.sha256 ||
        new TextEncoder().encode(body.markdown).byteLength !== plan.candidate.content.bytes
      )
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_MISMATCH",
            "The whole response differs from the exact frozen candidate; preserve all unmatched text.",
          ),
        )
      return yield* verifyCurrent(library, plan, false)
    }).pipe(Effect.result)
    if (exact._tag === "Failure") {
      yield* saveOutcome(library, plan, "needs_review", exact.failure.code, response)
      return yield* Effect.fail(
        recoveryError(
          fail(
            "SHARED_BODY_WRITE_REVIEW_REQUIRED",
            "The exact complete write was not verified. The original, candidate and returned response remain retained; no rollback or ownership event was sent.",
            {
              cause_code: exact.failure.code,
              observation_id: bodyWriteObservationId(plan.operation_id),
            },
          ),
          plan,
          "postcondition",
        ),
      )
    }
    yield* appendSharedRecord(library, {
      mode: "create",
      recordId: plan.event.event_id,
      operationId: plan.event.event_id,
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      payload: plan.event,
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "event")))
    const events = yield* fileEvents(library, plan.skill_page_id, plan.file_id)
    const state = yield* bodyWriteChecked(() => resolveFileState(plan.file_id, events)).pipe(
      Effect.mapError((error) => recoveryError(error, plan, "observed_frontier")),
    )
    if (!events.some((event) => event.event_id === plan.event.event_id))
      return yield* Effect.fail(
        recoveryError(
          fail(
            "SHARED_BODY_WRITE_UNRESOLVED",
            "The accepted event is not yet visible in the complete file history.",
          ),
          plan,
          "event",
        ),
      )
    yield* saveOutcome(library, plan, "applied", "EXACT_BODY_AND_EVENT_VERIFIED")
    return {
      status: "applied" as const,
      operation_id: plan.operation_id,
      event: plan.event,
      state,
      verified: true as const,
      requires_fresh_read: true as const,
    }
  })
}

/**
 * Reuse the caller's compact operation scan. Successful writes cost no Payload
 * reads; only plans without a verified event load their original full bodies.
 * Non-body outcomes are one paginated query when their headers are present.
 */
export function loadPendingSharedBodyWrites(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const events = new Map<string, FileEvent>()
    for (const raw of input.events) {
      const event = yield* bodyWriteChecked(() => decode(FileEventSchema, raw))
      const previous = events.get(event.event_id)
      if (previous && canonicalSharedJson(previous) !== canonicalSharedJson(event))
        return yield* Effect.fail(
          fail("SHARED_STATE_CONFLICT", "Observed file events contain incompatible duplicates."),
        )
      events.set(event.event_id, event)
    }
    const candidates: SharedOperationHeader[] = []
    for (const header of headers) {
      if (!header.record_id.startsWith("body-write-")) continue
      const eventId = plannedBodyWriteEventId(header.record_id)
      if (!eventId)
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_INVALID",
            "A write operation header has a malformed original identity.",
          ),
        )
      candidates.push(header)
    }
    if (candidates.length === 0) return [] as readonly SharedBodyWritePlan[]
    const outcomes = new Map<string, Outcome>()
    const observedOutcomeIds = new Set<string>()
    const candidateIds = new Set(candidates.map((header) => bodyWriteOutcomeId(header.record_id)))
    const outcomeHeaders = headers.filter(
      (header) =>
        header.entity_id === bodyWriteOutcomesEntity && candidateIds.has(header.record_id),
    )
    if (outcomeHeaders.length !== 0) {
      const rows = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: bodyWriteOutcomesEntity,
      })
      const byId = new Map(headers.map((header) => [header.record_id, header]))
      for (const row of rows) {
        const outcome = yield* bodyWriteChecked(() => decodeOutcome(row))
        const header = byId.get(row.record_id)
        if (!header || row.hash !== header.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_BODY_WRITE_INVALID",
              "The write outcome differs from its compact shared index.",
            ),
          )
        outcomes.set(outcome.operation_id, outcome)
        observedOutcomeIds.add(row.record_id)
      }
      for (const header of outcomeHeaders) {
        if (!observedOutcomeIds.has(header.record_id))
          return yield* Effect.fail(
            fail(
              "SHARED_BODY_WRITE_UNRESOLVED",
              "An indexed original outcome is unavailable; its plan cannot be considered complete.",
              { outcome_id: header.record_id },
            ),
          )
      }
    }
    const plans: SharedBodyWritePlan[] = []
    for (const header of candidates) {
      const outcome = outcomes.get(header.record_id)
      if (outcome && outcome.file_id !== header.entity_id)
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_SCOPE",
            "An outcome belongs to another file than its original plan.",
          ),
        )
      if (outcome?.status === "not_sent" || outcome?.status === "rejected") continue
      // Two original plans can share a content-derived event. An explicit
      // review result for this operation takes precedence over that shared ID.
      const eventId = plannedBodyWriteEventId(header.record_id)
      if (eventId === undefined)
        return yield* Effect.fail(
          fail("SHARED_BODY_WRITE_INVALID", "A write operation header has an invalid identity."),
        )
      const completed = events.get(eventId)
      if (outcome?.status === "applied") {
        if (completed === undefined)
          return yield* Effect.fail(
            fail(
              "SHARED_BODY_WRITE_UNRESOLVED",
              "The original completion outcome has no visible acceptance event.",
              { body_write_operation_id: header.record_id },
            ),
          )
        const digest = yield* sha256(
          yield* bodyWriteChecked(() => canonicalSharedJson(bodyWriteEventDescription(completed))),
        )
        if (
          completed.file_id !== header.entity_id ||
          completed.event_id !== `${completed.kind === "adopted" ? "adopt" : "follow"}-${digest}`
        )
          return yield* Effect.fail(
            fail(
              "SHARED_BODY_WRITE_INVALID",
              "A write operation header names a different acceptance event.",
            ),
          )
        continue
      }
      const rows = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: header.entity_id,
        recordId: header.record_id,
        payloadContainsBody: true,
      })
      const record = rows[0]
      if (rows.length !== 1 || record === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_UNRESOLVED",
            "The indexed original write plan is unavailable; do not create a replacement.",
            { body_write_operation_id: header.record_id },
          ),
        )
      const plan = yield* validateSharedBodyWritePlan(record.payload)
      if (
        record.hash !== header.hash ||
        record.record_id !== plan.operation_id ||
        record.operation_id !== plan.operation_id ||
        record.entity_id !== plan.file_id ||
        record.skill_page_id !== plan.skill_page_id ||
        plan.skill_page_id !== input.skillPageId ||
        plan.library_id !== library.library_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_INVALID",
            "The original write plan differs from its exact shared index identity.",
          ),
        )
      plans.push(plan)
    }
    return plans.sort(
      (left, right) =>
        left.before.downloaded_at - right.before.downloaded_at ||
        (left.operation_id < right.operation_id
          ? -1
          : left.operation_id > right.operation_id
            ? 1
            : 0),
    )
  })
}
