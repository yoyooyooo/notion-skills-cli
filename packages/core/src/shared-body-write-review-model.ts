import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { RetainedContentSchema } from "./shared-file-state.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
export const OriginalBodyWriteIdentitySchema = Schema.String.check(
  Schema.isPattern(/^body-write-(?:adopt|follow)-[a-f0-9]{64}\.[a-f0-9]{64}$/u),
)
export const SharedBodyWriteReviewPlanSchema = Schema.Struct({
  version: Schema.Literals([1, 2]),
  kind: Schema.Literal("body_write_review"),
  operation_id: Schema.String.check(Schema.isPattern(/^body-review-[a-f0-9]{64}$/u)),
  original_operation_id: OriginalBodyWriteIdentitySchema,
  original_plan_sha256: Hash,
  original_outcome_sha256: Hash,
  original_status: Schema.Literal("needs_review"),
  decision: Schema.Literal("accepted_observed"),
  library_id: Identity,
  skill_page_id: Schema.String,
  skill_id: Identity,
  file_id: Identity,
  page_id: Schema.String,
  path: Schema.String,
  source_id: Schema.String,
  observation_id: Schema.String,
  observation_sha256: Hash,
  /** Exact UTF-8 response.markdown hash; the retained content uses normalization v1. */
  accepted_observed_sha256: Hash,
  content: RetainedContentSchema,
  event: Schema.Struct({
    event_id: Identity,
    file_id: Identity,
    parents: Schema.Array(Identity),
    kind: Schema.Literal("adopted"),
    content: RetainedContentSchema,
  }),
})
export type SharedBodyWriteReviewPlan = typeof SharedBodyWriteReviewPlanSchema.Type

export function bodyWriteReviewChecked<A>(action: () => A) {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_BODY_REVIEW_INVALID", "The explicit body review is invalid."),
  })
}

/** One immutable decision identity for this exact original operation. */
export function bodyWriteReviewOperationId(originalOperationId: string) {
  return sha256(canonicalSharedJson([1, "body_write_review", originalOperationId])).pipe(
    Effect.map((hash) => `body-review-${hash}`),
  )
}
export const bodyWriteReviewReceiptId = (operationId: string) => `reviewed-${operationId}`

function eventDescription(
  plan: Pick<
    SharedBodyWriteReviewPlan,
    | "version"
    | "original_operation_id"
    | "observation_sha256"
    | "accepted_observed_sha256"
    | "event"
  >,
) {
  return {
    version: plan.version,
    kind: "body_write_review",
    original_operation_id: plan.original_operation_id,
    observation_sha256: plan.observation_sha256,
    accepted_observed_sha256: plan.accepted_observed_sha256,
    file_id: plan.event.file_id,
    parents: plan.event.parents,
    content: plan.event.content,
  }
}

export function bodyWriteReviewReceipt(plan: SharedBodyWriteReviewPlan) {
  return Effect.gen(function* () {
    return {
      version: 1 as const,
      kind: "body_write_review_receipt" as const,
      operation_id: plan.operation_id,
      original_operation_id: plan.original_operation_id,
      original_status: "needs_review" as const,
      status: "reviewed" as const,
      decision: "accepted_observed" as const,
      file_id: plan.file_id,
      accepted_observed_sha256: plan.accepted_observed_sha256,
      content_sha256: plan.content.sha256,
      observation_id: plan.observation_id,
      observation_sha256: plan.observation_sha256,
      event_id: plan.event.event_id,
      plan_sha256: yield* sha256(
        canonicalSharedJson({
          version: 1,
          operation_id: plan.operation_id,
          payload: plan,
        }),
      ),
    }
  })
}

export function validateSharedBodyWriteReviewPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* bodyWriteReviewChecked(() =>
      Schema.decodeUnknownSync(SharedBodyWriteReviewPlanSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    yield* bodyWriteReviewChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        pageId(plan.page_id) !== plan.page_id
      )
        throw fail("SHARED_BODY_REVIEW_INVALID", "Review requires canonical Notion identities.")
      if (normalizePath(plan.path) !== plan.path || plan.path === "" || plan.path === ".")
        throw fail("SHARED_BODY_REVIEW_INVALID", "Review requires the exact canonical file path.")
      if (
        plan.observation_id !== `observed-${plan.original_operation_id}` ||
        plan.event.file_id !== plan.file_id ||
        plan.content.object_id !== `body-${plan.content.sha256}` ||
        !Number.isSafeInteger(plan.content.bytes) ||
        plan.content.bytes < 0 ||
        canonicalSharedJson(plan.event.content) !== canonicalSharedJson(plan.content) ||
        plan.event.parents.length === 0 ||
        new Set(plan.event.parents).size !== plan.event.parents.length ||
        canonicalSharedJson(plan.event.parents) !==
          canonicalSharedJson([...plan.event.parents].sort()) ||
        plan.event.parents.includes(plan.event.event_id)
      )
        throw fail(
          "SHARED_BODY_REVIEW_INVALID",
          "The review content, original observation or parent frontier is inconsistent.",
        )
    })
    if (
      plan.operation_id !== (yield* bodyWriteReviewOperationId(plan.original_operation_id)) ||
      plan.event.event_id !==
        `review-adopt-${yield* sha256(canonicalSharedJson(eventDescription(plan)))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_REVIEW_INVALID",
          "Review identities differ from their frozen original facts.",
        ),
      )
    const receipt = yield* bodyWriteReviewReceipt(plan)
    yield* bodyWriteReviewChecked(() => {
      validateSharedRecordEnvelope(plan.operation_id, plan)
      validateSharedRecordEnvelope(plan.operation_id, plan.event)
      validateSharedRecordEnvelope(plan.operation_id, receipt)
    })
    return plan
  })
}

export function makeSharedBodyWriteReviewPlan(
  input: Omit<
    SharedBodyWriteReviewPlan,
    "kind" | "operation_id" | "original_status" | "decision" | "event"
  > & { readonly parents: readonly string[] },
) {
  return Effect.gen(function* () {
    const { parents, ...facts } = input
    const provisional = {
      ...facts,
      kind: "body_write_review" as const,
      original_status: "needs_review" as const,
      decision: "accepted_observed" as const,
      operation_id: yield* bodyWriteReviewOperationId(input.original_operation_id),
      event: {
        event_id: "pending",
        file_id: input.file_id,
        parents: [...parents].sort(),
        kind: "adopted" as const,
        content: input.content,
      },
    }
    const eventId = `review-adopt-${yield* sha256(canonicalSharedJson(eventDescription(provisional)))}`
    return yield* validateSharedBodyWriteReviewPlan({
      ...provisional,
      event: { ...provisional.event, event_id: eventId },
    })
  })
}
