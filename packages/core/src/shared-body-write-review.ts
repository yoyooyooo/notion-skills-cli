import { Effect, Schema } from "effect"
import { invalidateSnapshotCache } from "./cache.ts"
import { fail, property, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  bodyWriteObservationId,
  bodyWriteOutcomeId,
  bodyWriteOutcomesEntity,
  retainedMarkdownPayload,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import {
  bodyWriteReviewChecked as checked,
  bodyWriteReviewOperationId,
  bodyWriteReviewReceipt,
  bodyWriteReviewReceiptId,
  makeSharedBodyWriteReviewPlan,
  OriginalBodyWriteIdentitySchema,
  validateSharedBodyWriteReviewPlan,
  type SharedBodyWriteReviewPlan,
} from "./shared-body-write-review-model.ts"
import {
  FileEventSchema,
  nativeFileMetadata,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
  type RetainedContent,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import {
  pendingFileOperationKey,
  pendingFileOperations,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sha256, Store } from "./store.ts"

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
const ObservationSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("body_write_observation"),
  page_id: Schema.String,
  response_defined: Schema.Literal(true),
  response: Schema.Unknown,
})
const MarkdownSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
type OriginalFacts = {
  readonly original: SharedBodyWritePlan
  readonly originalPlanHash: string
  readonly originalOutcomeHash: string
  readonly observationHash: string
  readonly raw: string
  readonly rawHash: string
  readonly markdown: string
  readonly content: RetainedContent
}

function completeBody(raw: unknown, selected: string) {
  const body = Schema.decodeUnknownSync(MarkdownSchema)(raw)
  if (
    body.id !== selected ||
    body.truncated ||
    body.unknown_block_ids.length !== 0 ||
    (body.warnings?.length ?? 0) !== 0 ||
    new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(body.markdown)) !==
      body.markdown
  )
    throw fail(
      "SHARED_BODY_REVIEW_INCOMPLETE",
      "Review requires the complete warning-free UTF-8 observation for the exact original page.",
    )
  return { raw: body.markdown, markdown: normalizeObservedBody(body.markdown) }
}

function loadOriginalFacts(
  library: SharedLibrary,
  skillPageId: string,
  originalOperationId: string,
) {
  return Effect.gen(function* () {
    yield* checked(() => {
      Schema.decodeUnknownSync(OriginalBodyWriteIdentitySchema)(originalOperationId)
      if (pageId(skillPageId) !== skillPageId)
        throw fail(
          "SHARED_BODY_REVIEW_INVALID",
          "Review requires the canonical original Skill page identity.",
        )
    })
    const plans = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId,
      recordId: originalOperationId,
      payloadContainsBody: true,
    })
    const fact = plans[0]
    if (plans.length !== 1 || fact === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INELIGIBLE",
          "The exact original shared body-write plan is unavailable.",
        ),
      )
    const original = yield* validateSharedBodyWritePlan(fact.payload)
    if (
      fact.kind !== "operation" ||
      fact.operation_id !== originalOperationId ||
      fact.record_id !== originalOperationId ||
      fact.entity_id !== original.file_id ||
      fact.skill_page_id !== skillPageId ||
      original.operation_id !== originalOperationId ||
      original.skill_page_id !== skillPageId ||
      original.library_id !== library.library_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The original plan does not belong to this exact library, Skill and file.",
        ),
      )
    const outcomes = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId,
      recordId: bodyWriteOutcomeId(originalOperationId),
    })
    const rawOutcome = outcomes[0]
    if (outcomes.length !== 1 || rawOutcome === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INELIGIBLE",
          "An unknown original write cannot be accepted from current bytes; its needs_review outcome is required.",
        ),
      )
    const outcome = yield* checked(() =>
      Schema.decodeUnknownSync(OutcomeSchema)(rawOutcome.payload, { onExcessProperty: "error" }),
    )
    if (
      rawOutcome.kind !== "operation" ||
      rawOutcome.operation_id !== originalOperationId ||
      rawOutcome.record_id !== bodyWriteOutcomeId(originalOperationId) ||
      rawOutcome.entity_id !== bodyWriteOutcomesEntity ||
      rawOutcome.skill_page_id !== skillPageId ||
      outcome.operation_id !== originalOperationId ||
      outcome.file_id !== original.file_id ||
      outcome.status !== "needs_review" ||
      outcome.observed_result_retention !== "verified" ||
      outcome.observation_id !== bodyWriteObservationId(originalOperationId) ||
      outcome.event_id !== undefined
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INELIGIBLE",
          "Only an original needs_review outcome with its retained complete response can be reviewed.",
        ),
      )
    const observations = yield* querySharedRecords(library, {
      kind: "object",
      entityId: outcome.observation_id,
      skillPageId,
      recordId: outcome.observation_id,
      payloadContainsBody: true,
    })
    const observation = observations[0]
    if (
      observations.length !== 1 ||
      observation === undefined ||
      observation.kind !== "object" ||
      observation.operation_id !== originalOperationId ||
      observation.record_id !== outcome.observation_id ||
      observation.entity_id !== outcome.observation_id ||
      observation.skill_page_id !== skillPageId
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INELIGIBLE",
          "The immutable original response is missing or belongs to another operation.",
        ),
      )
    const envelope = yield* checked(() =>
      Schema.decodeUnknownSync(ObservationSchema)(observation.payload, {
        onExcessProperty: "error",
      }),
    )
    if (envelope.page_id !== original.page_id)
      return yield* Effect.fail(
        fail("SHARED_BODY_REVIEW_INVALID", "The retained response names another page."),
      )
    const body = yield* checked(() => completeBody(envelope.response, original.page_id))
    const rawHash = yield* sha256(body.raw)
    const normalizedHash = yield* sha256(body.markdown)
    const content = {
      object_id: `body-${normalizedHash}`,
      sha256: normalizedHash,
      bytes: new TextEncoder().encode(body.markdown).byteLength,
    }
    // Existing original protection is a prerequisite, never repaired by review.
    const bodies = new Map([
      [original.before.fingerprint.sha256, original.before.markdown],
      [original.candidate.content.sha256, original.candidate.markdown],
    ])
    for (const [hash, markdown] of bodies)
      yield* appendSharedRecord(library, {
        mode: "reconcile",
        recordId: `body-${hash}`,
        operationId: `retain-${hash}`,
        skillPageId,
        kind: "object",
        entityId: `body-${hash}`,
        payload: retainedMarkdownPayload(markdown),
      })
    yield* checked(() =>
      validateSharedRecordEnvelope(
        `retain-${normalizedHash}`,
        retainedMarkdownPayload(body.markdown),
      ),
    )
    return {
      original,
      originalPlanHash: fact.hash,
      originalOutcomeHash: rawOutcome.hash,
      observationHash: observation.hash,
      ...body,
      rawHash,
      content,
    } satisfies OriginalFacts
  })
}

function planFor(
  facts: OriginalFacts,
  accepted: string,
  version: SharedBodyWriteReviewPlan["version"],
) {
  return Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/u.test(accepted) || accepted !== facts.rawHash)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_HASH_MISMATCH",
          "The explicit accepted hash differs from the exact original response.markdown bytes.",
          {
            observed_sha256: facts.rawHash,
            normalized_sha256: facts.content.sha256,
          },
        ),
      )
    const original = facts.original
    return yield* makeSharedBodyWriteReviewPlan({
      version,
      original_operation_id: original.operation_id,
      original_plan_sha256: facts.originalPlanHash,
      original_outcome_sha256: facts.originalOutcomeHash,
      library_id: original.library_id,
      skill_page_id: original.skill_page_id,
      skill_id: original.skill_id,
      file_id: original.file_id,
      page_id: original.page_id,
      path: original.path,
      source_id: original.source_id,
      observation_id: bodyWriteObservationId(original.operation_id),
      observation_sha256: facts.observationHash,
      accepted_observed_sha256: accepted,
      content: {
        ...facts.content,
        ...(version === 1 ? {} : nativeFileMetadata(original.candidate.content)),
      },
      parents: original.event.parents,
    })
  })
}

/** Version comes from the immutable original review, never the current default. */
function retainedReviewPlan(
  library: SharedLibrary,
  original: SharedBodyWritePlan,
  operationId: string,
) {
  return Effect.gen(function* () {
    const records = yield* querySharedRecords(library, {
      kind: "operation",
      skillPageId: original.skill_page_id,
      recordId: operationId,
      payloadContainsBody: true,
    })
    if (records.length === 0) return undefined
    const record = records[0]
    if (
      records.length !== 1 ||
      record === undefined ||
      record.kind !== "operation" ||
      record.record_id !== operationId ||
      record.operation_id !== operationId ||
      record.entity_id !== original.file_id ||
      record.skill_page_id !== original.skill_page_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The retained review does not name the exact original file.",
        ),
      )
    const plan = yield* validateSharedBodyWriteReviewPlan(record.payload)
    if (
      plan.operation_id !== operationId ||
      plan.original_operation_id !== original.operation_id ||
      plan.library_id !== library.library_id ||
      plan.skill_page_id !== original.skill_page_id ||
      plan.file_id !== original.file_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The retained review belongs to another original operation.",
        ),
      )
    return plan
  })
}

function fileEvents(library: SharedLibrary, plan: SharedBodyWriteReviewPlan) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, {
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
    })
    return yield* checked(() =>
      rows.map((row) => {
        const event = Schema.decodeUnknownSync(FileEventSchema)(row.payload, {
          onExcessProperty: "error",
        })
        if (
          row.record_id !== event.event_id ||
          row.entity_id !== event.file_id ||
          event.file_id !== plan.file_id
        )
          throw fail(
            "SHARED_BODY_REVIEW_INVALID",
            "A file event differs from its exact recorded identity.",
          )
        return event
      }),
    )
  })
}

function verifyCurrent(
  library: SharedLibrary,
  plan: SharedBodyWriteReviewPlan,
  facts: OriginalFacts,
) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(library, plan.skill_page_id)
    const binding = [index.main, ...index.files].find((file) => file.file_id === plan.file_id)
    const events = yield* fileEvents(library, plan)
    const state = yield* checked(() => resolveFileState(plan.file_id, events))
    if (
      !index.enabled ||
      binding === undefined ||
      index.skill_id !== plan.skill_id ||
      binding.page_id !== plan.page_id ||
      binding.path !== plan.path ||
      index.source_reference !== plan.source_id ||
      state.ownership.kind === "tombstone" ||
      canonicalSharedJson(state.heads) !== canonicalSharedJson(plan.event.parents)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_STALE",
          "The original file binding, source selection or parent frontier changed; no new review facts were accepted.",
        ),
      )
    yield* checked(() => resolveFileState(plan.file_id, [...events, plan.event]))
    const raw = yield* (yield* Notion).request(
      `v1/pages/${plan.page_id}/markdown?markdown_version=v2`,
    )
    const current = yield* checked(() => completeBody(raw, plan.page_id))
    if (current.raw !== facts.raw || current.markdown !== facts.markdown)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_STALE",
          "The current complete response differs byte-for-byte from the original observation; explicitly reviewing another body is not authorized.",
        ),
      )
    return { index, events, state }
  })
}

function reviewed(plan: SharedBodyWriteReviewPlan) {
  return {
    status: "reviewed" as const,
    decision: "accepted_observed" as const,
    operation_id: plan.operation_id,
    original_operation_id: plan.original_operation_id,
    original_status: "needs_review" as const,
    accepted_observed_sha256: plan.accepted_observed_sha256,
    content_sha256: plan.content.sha256,
    observation_id: plan.observation_id,
    event: plan.event,
    verified: true as const,
    requires_fresh_read: true as const,
  }
}

function recoveryError(error: SkillsError, plan: SharedBodyWriteReviewPlan, stage: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    review_operation_id: plan.operation_id,
    original_operation_id: plan.original_operation_id,
    review_stage: stage,
    recovery: {
      version: 1,
      mode: "reconcile",
      original_operation_id: plan.original_operation_id,
      accepted_observed_sha256: plan.accepted_observed_sha256,
      never_replay: true,
    },
  })
}

function verifyReviewAncestry(plan: SharedBodyWriteReviewPlan, observed: readonly FileEvent[]) {
  const byId = new Map<string, FileEvent>()
  for (const event of observed.filter((value) => value.file_id === plan.file_id)) {
    const previous = byId.get(event.event_id)
    if (previous !== undefined && canonicalSharedJson(previous) !== canonicalSharedJson(event))
      throw fail(
        "SHARED_BODY_REVIEW_INVALID",
        "The observed file facts contain conflicting event identities.",
      )
    byId.set(event.event_id, event)
  }
  const accepted = byId.get(plan.event.event_id)
  if (accepted === undefined || canonicalSharedJson(accepted) !== canonicalSharedJson(plan.event))
    throw fail(
      "SHARED_BODY_REVIEW_UNRESOLVED",
      "The review event is absent from the complete observed file facts.",
    )
  const closure = new Map<string, FileEvent>(),
    pending = [plan.event.event_id]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (closure.has(next)) continue
    const event = byId.get(next)
    if (event === undefined)
      throw fail(
        "SHARED_BODY_REVIEW_UNRESOLVED",
        "The original review event ancestry is unavailable.",
      )
    closure.set(next, event)
    pending.push(...event.parents)
  }
  const state = resolveFileState(plan.file_id, [...closure.values()])
  if (
    canonicalSharedJson(state.heads) !== canonicalSharedJson([plan.event.event_id]) ||
    state.ownership.kind !== "custom" ||
    canonicalSharedJson(state.ownership.content) !== canonicalSharedJson(plan.content)
  )
    throw fail(
      "SHARED_BODY_REVIEW_INVALID",
      "The review event does not adopt the retained observed body.",
    )
}

function verifyChain(
  library: SharedLibrary,
  plan: SharedBodyWriteReviewPlan,
  facts: OriginalFacts,
  events?: readonly FileEvent[],
) {
  return Effect.gen(function* () {
    const expected = yield* planFor(facts, plan.accepted_observed_sha256, plan.version)
    if (canonicalSharedJson(expected) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The review differs from the exact retained original plan, outcome and observation.",
        ),
      )
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: plan.file_id,
      payload: plan,
    })
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.content.object_id,
      operationId: `retain-${plan.content.sha256}`,
      skillPageId: plan.skill_page_id,
      kind: "object",
      entityId: plan.content.object_id,
      payload: retainedMarkdownPayload(facts.markdown),
    })
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: plan.event.event_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      payload: plan.event,
    })
    const receipt = yield* bodyWriteReviewReceipt(plan)
    yield* appendSharedRecord(library, {
      mode: "reconcile",
      recordId: bodyWriteReviewReceiptId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: plan.file_id,
      payload: receipt,
    })
    const observed = events ?? (yield* fileEvents(library, plan))
    yield* checked(() => verifyReviewAncestry(plan, observed))
    return reviewed(plan)
  }).pipe(Effect.mapError((error) => recoveryError(error, plan, "reconcile")))
}

/** Historical completion only. Never use a current body to fill an absent review fact. */
export function reconcileSharedBodyWriteReview(
  library: SharedLibrary,
  input: SharedBodyWriteReviewPlan,
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedBodyWriteReviewPlan(input)
    if (plan.library_id !== library.library_id)
      return yield* Effect.fail(
        fail("SHARED_BODY_REVIEW_INVALID", "The review belongs to another library."),
      )
    const facts = yield* loadOriginalFacts(library, plan.skill_page_id, plan.original_operation_id)
    return yield* verifyChain(library, plan, facts)
  })
}

/** Absence keeps the old needs_review barrier. A partial review is never completion. */
export function completedSharedBodyWriteReview(
  library: SharedLibrary,
  original: SharedBodyWritePlan,
  input: {
    readonly headers?: readonly SharedOperationHeader[]
    readonly events?: readonly FileEvent[]
  } = {},
) {
  return Effect.gen(function* () {
    const operationId = yield* bodyWriteReviewOperationId(original.operation_id)
    const headers =
      input.headers ?? (yield* querySharedOperationIndex(library, original.skill_page_id))
    if (
      !headers.some(
        (header) =>
          header.record_id === operationId ||
          header.record_id === bodyWriteReviewReceiptId(operationId),
      )
    )
      return undefined
    const facts = yield* loadOriginalFacts(library, original.skill_page_id, original.operation_id)
    if (canonicalSharedJson(facts.original) !== canonicalSharedJson(original))
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The current original plan differs from the pending write.",
        ),
      )
    const plan = yield* retainedReviewPlan(library, original, operationId)
    if (plan === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RECORD_UNRESOLVED",
          "The original review plan has not been observed; its receipt cannot authorize a replacement.",
        ),
      )
    return yield* verifyChain(library, plan, facts, input.events)
  })
}

/** Public explicit decision. This operation writes Records only, never the native body. */
export function reviewSharedBodyWrite(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly originalOperationId: string
  readonly acceptedObservedSha256: string
  readonly scope: string
  readonly mode: "create" | "reconcile"
  readonly dryRun: boolean
}) {
  return Effect.gen(function* () {
    if (
      !/^[a-f0-9]{64}$/u.test(input.scope) ||
      !/^[a-f0-9]{64}$/u.test(input.acceptedObservedSha256) ||
      !["create", "reconcile"].includes(input.mode) ||
      (input.mode === "reconcile" && input.dryRun)
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Review requires the exact auth scope and accepted SHA-256; dry-run and reconcile are mutually exclusive.",
        ),
      )
    const facts = yield* loadOriginalFacts(
      input.library,
      input.skillPageId,
      input.originalOperationId,
    )
    const original = facts.original
    const operationId = yield* bodyWriteReviewOperationId(original.operation_id)
    const scope = {
      prefix: yield* sharedPendingObservationPrefix(
        input.scope,
        original.library_id,
        original.skill_id,
      ),
      scope: input.scope,
      library_id: original.library_id,
      skill_id: original.skill_id,
      skill_page_id: original.skill_page_id,
    }
    const local = yield* pendingFileOperations(scope)
    const headers = yield* querySharedOperationIndex(input.library, original.skill_page_id)
    const existing = local.find((entry) => entry.plan.operation_id === operationId)
    const localPlan =
      existing === undefined ? undefined : yield* validateSharedBodyWriteReviewPlan(existing.plan)
    const sharedPlan = yield* retainedReviewPlan(input.library, original, operationId)
    if (
      localPlan !== undefined &&
      sharedPlan !== undefined &&
      canonicalSharedJson(localPlan) !== canonicalSharedJson(sharedPlan)
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The local and shared original review plans disagree."),
      )
    const retained = localPlan ?? sharedPlan
    // Another credential scope can hide the original shared review request.
    // Its opaque Store address is enough to forbid a fresh version/dispatch;
    // never read another scope's plan or treat that address as completion.
    const localKey = yield* pendingFileOperationKey(scope.prefix, {
      file_id: original.file_id,
      operation_id: operationId,
    })
    const suffix = localKey.slice(localKey.lastIndexOf("/"))
    const priorScopeDispatch = (yield* (yield* Store).listKeys(
      "operations/shared-observation-pending/",
    )).some(
      (key) =>
        key !== localKey &&
        /^operations\/shared-observation-pending\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u.test(key) &&
        key.endsWith(suffix),
    )
    const recovery =
      input.mode === "reconcile" ||
      retained !== undefined ||
      priorScopeDispatch ||
      headers.some(
        (header) =>
          header.record_id === operationId ||
          header.record_id === bodyWriteReviewReceiptId(operationId),
      )
    if (recovery && retained === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RECORD_UNRESOLVED",
          "The original review plan has not been observed; reconcile never prepares a replacement.",
        ),
      )
    const plan = yield* planFor(facts, input.acceptedObservedSha256, retained?.version ?? 2)
    if (retained !== undefined && canonicalSharedJson(retained) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The retained original review cannot be replaced by another plan."),
      )
    let result: ReturnType<typeof reviewed>
    if (recovery) result = yield* verifyChain(input.library, plan, facts)
    else {
      const other = local.find((entry) => entry.plan.operation_id !== plan.original_operation_id)
      if (other !== undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_PENDING_OPERATION",
            "Reconcile the other frozen operation before accepting this body review.",
            { operation_id: other.plan.operation_id },
          ),
        )
      yield* verifyCurrent(input.library, plan, facts)
      if (input.dryRun)
        return {
          status: "planned" as const,
          decision: "accepted_observed" as const,
          original_status: "needs_review" as const,
          operation_id: plan.operation_id,
          original_operation_id: plan.original_operation_id,
          accepted_observed_sha256: plan.accepted_observed_sha256,
          content_sha256: plan.content.sha256,
          dry_run: true as const,
          plan,
        }
      yield* retainPendingFileOperation(scope, plan)
      const append = (
        stage: string,
        kind: "operation" | "object" | "file_event",
        recordId: string,
        operationId: string,
        entityId: string,
        payload: unknown,
      ) =>
        appendSharedRecord(input.library, {
          mode: "create",
          recordId,
          operationId,
          skillPageId: plan.skill_page_id,
          kind,
          entityId,
          payload,
        }).pipe(Effect.mapError((error) => recoveryError(error, plan, stage)))
      yield* append("plan", "operation", plan.operation_id, plan.operation_id, plan.file_id, plan)
      yield* append(
        "observed_object",
        "object",
        plan.content.object_id,
        `retain-${plan.content.sha256}`,
        plan.content.object_id,
        retainedMarkdownPayload(facts.markdown),
      )
      yield* verifyCurrent(input.library, plan, facts).pipe(
        Effect.mapError((error) => recoveryError(error, plan, "pre_adoption")),
      )
      yield* append(
        "event",
        "file_event",
        plan.event.event_id,
        plan.operation_id,
        plan.file_id,
        plan.event,
      )
      const events = yield* fileEvents(input.library, plan)
      const state = yield* checked(() => resolveFileState(plan.file_id, events))
      if (canonicalSharedJson(state.heads) !== canonicalSharedJson([plan.event.event_id]))
        return yield* Effect.fail(
          recoveryError(
            fail(
              "SHARED_BODY_REVIEW_STALE",
              "The review did not remain the sole observed frontier; preserve its original incomplete facts.",
            ),
            plan,
            "post_adoption",
          ),
        )
      yield* append(
        "receipt",
        "operation",
        bodyWriteReviewReceiptId(plan.operation_id),
        plan.operation_id,
        plan.file_id,
        yield* bodyWriteReviewReceipt(plan),
      )
      result = yield* verifyChain(input.library, plan, facts, events)
    }
    // Completion can retire only derived local barriers; all shared originals remain immutable.
    if (!input.dryRun) {
      yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), input.scope)
      const keys = (yield* pendingFileOperations(scope))
        .filter(
          (entry) =>
            entry.plan.operation_id === plan.operation_id ||
            entry.plan.operation_id === plan.original_operation_id,
        )
        .map((entry) => entry.key)
      if (keys.length !== 0) yield* (yield* Store).retireKeys(keys)
    }
    return { ...result, dry_run: input.dryRun }
  })
}
