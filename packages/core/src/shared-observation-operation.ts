import { Effect, Schema } from "effect"
import { decode, fail, property, SkillsError } from "./model.ts"
import { pageId as notionPageId } from "./ref.ts"
import {
  BodyFingerprintSchema,
  FileEventSchema,
  normalizeObservedBody,
  RetainedContentSchema,
  type FileEvent,
} from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  validateSharedRecordEnvelope,
} from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const OperationId = Schema.String.check(Schema.isPattern(/^observe-[a-f0-9]{64}\.[a-f0-9]{64}$/u))
const AdoptedEventSchema = Schema.Struct({
  event_id: Identity,
  file_id: Identity,
  parents: Schema.Array(Identity),
  kind: Schema.Literal("adopted"),
  content: RetainedContentSchema,
})
export const FrozenObservationBodySchema = Schema.Struct({
  page_id: Schema.String,
  markdown: Schema.String,
  fingerprint: BodyFingerprintSchema,
  bytes: Schema.Number,
  downloaded_at: Schema.Number,
})
export type FrozenObservationBody = typeof FrozenObservationBodySchema.Type

export const SharedObservationPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("file_observation"),
  operation_id: OperationId,
  skill_page_id: Schema.String,
  file_id: Identity,
  page_id: Schema.String,
  body: FrozenObservationBodySchema,
  event: AdoptedEventSchema,
})
export type SharedObservationPlan = typeof SharedObservationPlanSchema.Type
export type SharedObservationStage = "plan" | "object" | "event"

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_OBSERVATION_INVALID", "The frozen observation plan is invalid."),
  })
}

function planDescription(plan: Omit<SharedObservationPlan, "operation_id">) {
  return {
    version: plan.version,
    kind: plan.kind,
    skill_page_id: plan.skill_page_id,
    file_id: plan.file_id,
    page_id: plan.page_id,
    body: plan.body,
    event: plan.event,
  }
}

function eventDescription(event: Extract<FileEvent, { readonly kind: "adopted" }>) {
  return { version: 1, file_id: event.file_id, parents: event.parents, content: event.content }
}

/** Validate the complete frozen bytes and identities without consulting a current page. */
export function validateSharedObservationPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() =>
      Schema.decodeUnknownSync(SharedObservationPlanSchema)(input, { onExcessProperty: "error" }),
    )
    yield* checked(() => {
      for (const id of [plan.skill_page_id, plan.page_id, plan.body.page_id]) {
        if (notionPageId(id) !== id)
          throw fail(
            "SHARED_OBSERVATION_INVALID",
            "Observation plans require canonical Notion page identities.",
          )
      }
      if (
        plan.page_id !== plan.body.page_id ||
        plan.file_id !== plan.event.file_id ||
        plan.body.fingerprint.sha256 !== plan.event.content.sha256 ||
        plan.body.bytes !== plan.event.content.bytes
      )
        throw fail(
          "SHARED_OBSERVATION_INVALID",
          "The frozen page, body and event do not describe one exact observation.",
        )
      if (
        !Number.isSafeInteger(plan.body.bytes) ||
        plan.body.bytes < 0 ||
        !Number.isSafeInteger(plan.body.downloaded_at) ||
        plan.body.downloaded_at < 0
      )
        throw fail(
          "SHARED_OBSERVATION_INVALID",
          "The frozen byte count and original observation time must be nonnegative safe integers.",
        )
      if (
        new Set(plan.event.parents).size !== plan.event.parents.length ||
        canonicalSharedJson(plan.event.parents) !==
          canonicalSharedJson([...plan.event.parents].sort()) ||
        plan.event.parents.includes(plan.event.event_id)
      )
        throw fail(
          "SHARED_OBSERVATION_INVALID",
          "The original parent frontier must be sorted, unique and non-self-referential.",
        )
      if (normalizeObservedBody(plan.body.markdown) !== plan.body.markdown)
        throw fail(
          "SHARED_OBSERVATION_INVALID",
          "The frozen body must use its declared Markdown normalization.",
        )
    })
    const bytes = new TextEncoder().encode(plan.body.markdown)
    const bodyHash = yield* sha256(bytes)
    const eventHash = yield* sha256(canonicalSharedJson(eventDescription(plan.event)))
    const planHash = yield* sha256(canonicalSharedJson(planDescription(plan)))
    if (
      bodyHash !== plan.body.fingerprint.sha256 ||
      bytes.byteLength !== plan.body.bytes ||
      plan.event.content.object_id !== `body-${bodyHash}` ||
      plan.event.event_id !== `adopt-${eventHash}` ||
      plan.operation_id !== `observe-${eventHash}.${planHash}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_OBSERVATION_INVALID",
          "Frozen observation bytes, event or operation identity do not match their hashes.",
        ),
      )
    // All deterministic failures happen before a local dispatch receipt exists.
    yield* checked(() => {
      validateSharedRecordEnvelope(plan.operation_id, plan)
      validateSharedRecordEnvelope(`retain-${bodyHash}`, {
        version: 1,
        kind: "normalized_markdown",
        normalization_version: 1,
        markdown: plan.body.markdown,
      })
      validateSharedRecordEnvelope(plan.event.event_id, plan.event)
    })
    return plan
  })
}

/** The original download time is part of the plan, never replaced by a recovery clock. */
export function makeSharedObservationPlan(input: {
  readonly skillPageId: string
  readonly fileId: string
  readonly pageId: string
  readonly body: FrozenObservationBody
  readonly event: Extract<FileEvent, { readonly kind: "adopted" }>
}) {
  return Effect.gen(function* () {
    const description = {
      version: 1 as const,
      kind: "file_observation" as const,
      skill_page_id: input.skillPageId,
      file_id: input.fileId,
      page_id: input.pageId,
      body: input.body,
      event: input.event,
    }
    const eventJson = yield* checked(() => canonicalSharedJson(eventDescription(input.event)))
    const planJson = yield* checked(() => canonicalSharedJson(description))
    const eventHash = yield* sha256(eventJson)
    const planHash = yield* sha256(planJson)
    return yield* validateSharedObservationPlan({
      ...description,
      operation_id: `observe-${eventHash}.${planHash}`,
    })
  })
}

function recoveryError(
  error: SkillsError,
  plan: SharedObservationPlan,
  stage: SharedObservationStage,
) {
  const initialUnknown = stage === "plan" && error.code === "WRITE_OUTCOME_UNKNOWN"
  return fail(
    error.code,
    initialUnknown
      ? "The original observation-plan write is unknown. Retain this receipt and reconcile its exact ID; an empty client cannot distinguish an invisible first plan from an operation that never started."
      : error.message,
    {
      ...property(error.details),
      observation_operation_id: plan.operation_id,
      observation_stage: stage,
      recovery: { version: 1, mode: "reconcile", plan },
      ...(initialUnknown ? { first_plan_visibility_boundary: true } : {}),
    },
  )
}

/**
 * The first invocation may create plan -> object -> event, in that order.
 * Reconciliation only observes all three original facts; absence never grants
 * permission to resend any POST. A verified plan is not proof that a later step
 * was never dispatched before a crash.
 */
export function commitSharedObservationPlan(
  library: SharedLibrary,
  input: { readonly mode: "create" | "reconcile"; readonly plan: SharedObservationPlan },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedObservationPlan(input.plan)
    yield* appendSharedRecord(library, {
      mode: input.mode,
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: plan.file_id,
      payload: plan,
      payloadContainsBody: true,
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "plan")))
    const content = plan.event.content
    yield* appendSharedRecord(library, {
      mode: input.mode,
      recordId: content.object_id,
      operationId: `retain-${content.sha256}`,
      skillPageId: plan.skill_page_id,
      kind: "object",
      entityId: content.object_id,
      payload: {
        version: 1,
        kind: "normalized_markdown",
        normalization_version: 1,
        markdown: plan.body.markdown,
      },
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "object")))
    yield* appendSharedRecord(library, {
      mode: input.mode,
      recordId: plan.event.event_id,
      operationId: plan.event.event_id,
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      payload: plan.event,
    }).pipe(Effect.mapError((error) => recoveryError(error, plan, "event")))
    return plan
  })
}

export function reconcileSharedObservation(library: SharedLibrary, plan: SharedObservationPlan) {
  return commitSharedObservationPlan(library, { mode: "reconcile", plan })
}

/**
 * Completed operations cost only compact metadata. Only unresolved plans read
 * their original Payload, marked as body transfer for request accounting.
 */
export function loadPendingSharedObservationPlans(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const index = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const headers = yield* checked(() =>
      index.flatMap((header) => {
        if (!header.record_id.startsWith("observe-")) return []
        const match = /^observe-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(header.record_id)
        if (!match?.[1])
          throw fail(
            "SHARED_OBSERVATION_INVALID",
            "Observation index has a malformed operation identity.",
          )
        return [{ ...header, file_id: header.entity_id, event_id: `adopt-${match[1]}` }]
      }),
    )
    const events = yield* checked(() => {
      const byId = new Map<string, FileEvent>()
      for (const raw of input.events) {
        const event = decode(FileEventSchema, raw)
        const existing = byId.get(event.event_id)
        if (existing && canonicalSharedJson(existing) !== canonicalSharedJson(event))
          throw fail(
            "SHARED_STATE_CONFLICT",
            "One observed event identity has incompatible payloads.",
          )
        byId.set(event.event_id, event)
      }
      return byId
    })
    const plans: SharedObservationPlan[] = []
    for (const header of headers) {
      const completed = events.get(header.event_id)
      if (completed !== undefined) {
        if (
          completed.kind !== "adopted" ||
          completed.file_id !== header.file_id ||
          completed.event_id !==
            `adopt-${yield* sha256(canonicalSharedJson(eventDescription(completed)))}`
        )
          return yield* Effect.fail(
            fail(
              "SHARED_OBSERVATION_INVALID",
              "A completed observation header does not match its exact adoption event.",
            ),
          )
        continue
      }
      const records = yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: header.file_id,
        recordId: header.record_id,
        payloadContainsBody: true,
      })
      const record = records[0]
      if (records.length !== 1 || record === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_RECORD_UNRESOLVED",
            "The indexed original observation plan is not yet available; do not start a replacement.",
            { observation_operation_id: header.record_id },
          ),
        )
      const plan = yield* validateSharedObservationPlan(record.payload)
      if (
        record.record_id !== plan.operation_id ||
        record.operation_id !== plan.operation_id ||
        record.entity_id !== plan.file_id ||
        record.skill_page_id !== plan.skill_page_id ||
        record.hash !== header.hash ||
        plan.event.event_id !== header.event_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_OBSERVATION_INVALID",
            "The frozen plan differs from its exact shared index identity.",
          ),
        )
      plans.push(plan)
    }
    return plans.sort(
      (left, right) =>
        left.body.downloaded_at - right.body.downloaded_at ||
        (left.operation_id < right.operation_id
          ? -1
          : left.operation_id > right.operation_id
            ? 1
            : 0),
    )
  })
}
