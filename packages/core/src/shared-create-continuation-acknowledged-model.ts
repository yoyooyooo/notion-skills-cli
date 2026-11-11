import { Effect, Schema } from "effect"
import { pageId } from "./ref.ts"
import { createChecked } from "./shared-create-model.ts"
import {
  knownRecoveryPlan,
  validateSharedCreateKnownRecoveryReview,
  sharedCreateRecoveryFileCommitment,
  type SharedCreateKnownRecoveryReview,
} from "./shared-create-recovery-known-model.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateKnownRecoveryObservationSchema,
  SharedCreateRecoveryFileCommitmentSchema,
  type SharedCreateRecoveryBinding,
  type SharedCreateKnownRecoveryObservation,
} from "./shared-create-recovery-proof-model.ts"
import {
  SharedNativeAllocationReferenceSchema,
  type SharedNativeAllocationReference,
} from "./shared-create-recovery-acknowledgement-model.ts"
import { projectSharedRecoveryFiles } from "./shared-create-recovery-projection.ts"
import { prefixRecoveryRequired } from "./shared-create-recovery-errors.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const refusal = (message: string) => Effect.fail(prefixRecoveryRequired(message))

/** Known complete allocations are distinct from the original unknown-POST continuation v1. */
export const SharedCreateAcknowledgedContinuationReviewSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("skill_create_continuation_review"),
  continuation_id: Schema.String.check(Schema.isPattern(/^create-continuation-[a-f0-9]{64}$/u)),
  original_operation_id: Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u)),
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Hash,
  recovery_id: Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u)),
  recovery_review_record_hash: Hash,
  recovery_journal_sha256: Hash,
  recovery_dispatches_sha256: Hash,
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("reproject_acknowledged_allocations"),
  original_write_outcome: Schema.Literal("acknowledged"),
  projection_version: Schema.Literal(11),
  observation_kind: Schema.Literal("post_failure_current_read"),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  allocations: Schema.Array(SharedNativeAllocationReferenceSchema),
  files: Schema.Array(SharedCreateRecoveryFileCommitmentSchema),
  observations: Schema.Array(SharedCreateKnownRecoveryObservationSchema),
  remaining_file_ids: Schema.Array(Identity),
})
export type SharedCreateAcknowledgedContinuationReview =
  typeof SharedCreateAcknowledgedContinuationReviewSchema.Type
export const SharedCreateAcknowledgedContinuationOutcomeSchema = Schema.Struct({
  version: Schema.Literal(6),
  kind: Schema.Literal("skill_create_recovery_outcome"),
  status: Schema.Literal("applied"),
  original_operation_id: Schema.String,
  original_manifest_sha256: Hash,
  original_plan_sha256: Hash,
  original_outcome_sha256: Hash,
  bootstrap_sha256: Hash,
  recovery_id: Schema.String,
  skill_id: Identity,
  skill_page_id: Schema.String,
  review_record_hash: Hash,
  continuation_id: Schema.String,
  continuation_review_record_hash: Hash,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
})
export type SharedCreateAcknowledgedContinuationOutcome =
  typeof SharedCreateAcknowledgedContinuationOutcomeSchema.Type

export function validateSharedCreateAcknowledgedContinuationReview(
  input: unknown,
  expectedId?: string,
) {
  return Effect.gen(function* () {
    const review = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateAcknowledgedContinuationReviewSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const count = review.files.length
    if (
      count === 0 ||
      review.bindings.length !== count ||
      review.allocations.length !== count ||
      review.observations.length !== count ||
      review.remaining_file_ids.length !== 0 ||
      review.library.library_id !== review.library_id ||
      pageId(review.skill_page_id) !== review.skill_page_id ||
      review.bindings[0]?.page_id !== review.skill_page_id ||
      new Set(review.files.map((file) => file.file_id)).size !== count ||
      new Set(review.files.map((file) => file.path)).size !== count ||
      new Set(review.bindings.map((item) => item.page_id)).size !== count ||
      new Set(review.allocations.map((item) => item.record_id)).size !== count
    )
      return yield* refusal(
        "An acknowledged continuation requires every exact allocation and no remaining native creation.",
      )
    for (const [index, file] of review.files.entries()) {
      const binding = review.bindings[index]!,
        allocation = review.allocations[index]!,
        observed = review.observations[index]!
      if (
        binding.file_id !== file.file_id ||
        binding.path !== file.path ||
        binding.event_id !== file.event_id ||
        pageId(binding.page_id) !== binding.page_id ||
        allocation.file_id !== binding.file_id ||
        allocation.page_id !== binding.page_id ||
        ![review.original_operation_id, review.recovery_id].includes(
          allocation.allocation_operation_id,
        ) ||
        observed.file_id !== binding.file_id ||
        observed.page_id !== binding.page_id ||
        observed.body_sha256 !== file.body_sha256 ||
        observed.body_bytes !== file.body_bytes
      )
        return yield* refusal(
          "The continuation changed a complete native binding, body observation or v11 projection.",
        )
    }
    const { continuation_id, ...fields } = review
    if (
      continuation_id !== "create-continuation-" + (yield* hash(fields)) ||
      (expectedId !== undefined && expectedId !== continuation_id)
    )
      return yield* refusal(
        "The complete continuation differs from its independently reviewed digest.",
      )
    yield* createChecked(() => validateSharedRecordEnvelope(continuation_id, review, "operation"))
    return review
  })
}

export function makeSharedCreateAcknowledgedContinuationReview(input: {
  readonly plan: unknown
  readonly originalReview: SharedCreateKnownRecoveryReview
  readonly originalReviewHash: string
  readonly recoveryJournalHash: string
  readonly recoveryDispatchesHash: string
  readonly bindings: readonly SharedCreateRecoveryBinding[]
  readonly allocations: readonly SharedNativeAllocationReference[]
  readonly observations: readonly SharedCreateKnownRecoveryObservation[]
}) {
  return Effect.gen(function* () {
    const plan = yield* knownRecoveryPlan(input.plan),
      old = yield* validateSharedCreateKnownRecoveryReview(input.originalReview)
    if (
      plan.files[0]?.projection.version !== 9 ||
      old.version !== 3 ||
      old.bootstrap.kind !== "known_needs_review" ||
      old.original_outcome_sha256 === null ||
      old.original_operation_id !== plan.operation_id ||
      old.original_plan_sha256 !== (yield* hash(plan)) ||
      input.originalReviewHash !==
        (yield* hash({ version: 1, operation_id: old.review_id, payload: old }))
    )
      return yield* refusal(
        "Only the exact known v9 admission and its retained v3/v10 recovery may enter this continuation.",
      )
    const projected = yield* projectSharedRecoveryFiles(plan, 11)
    const files = [
      ...projected.filter((file) => file.path === plan.entrypoint),
      ...projected.filter((file) => file.path !== plan.entrypoint),
    ]
    if (
      input.bindings.length !== files.length ||
      new Set(input.bindings.map((item) => item.file_id)).size !== files.length
    )
      return yield* refusal("The continuation cannot omit or add a declared allocation.")
    if (
      !files.some(
        (file) =>
          old.files.find((prior) => prior.file_id === file.file_id)?.content.sha256 !==
          file.content.sha256,
      )
    )
      return yield* refusal(
        "This continuation requires an independently changed v11 native prediction.",
      )
    const bindings = files.map((file) => {
      const binding = input.bindings.find((item) => item.file_id === file.file_id)
      if (!binding)
        throw prefixRecoveryRequired("Every declared file must retain its acknowledged page.")
      return { ...binding, event_id: file.event.event_id }
    })
    const fields = {
      version: 2 as const,
      kind: "skill_create_continuation_review" as const,
      original_operation_id: plan.operation_id,
      original_plan_sha256: old.original_plan_sha256,
      original_manifest_sha256: old.original_manifest_sha256,
      original_outcome_sha256: old.original_outcome_sha256,
      recovery_id: old.review_id,
      recovery_review_record_hash: input.originalReviewHash,
      recovery_journal_sha256: input.recoveryJournalHash,
      recovery_dispatches_sha256: input.recoveryDispatchesHash,
      library: plan.library,
      library_id: plan.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: old.skill_page_id,
      decision: "reproject_acknowledged_allocations" as const,
      original_write_outcome: "acknowledged" as const,
      projection_version: 11 as const,
      observation_kind: "post_failure_current_read" as const,
      bindings,
      allocations: input.allocations,
      files: files.map(sharedCreateRecoveryFileCommitment),
      observations: input.observations,
      remaining_file_ids: [],
    }
    return yield* validateSharedCreateAcknowledgedContinuationReview({
      ...fields,
      continuation_id: "create-continuation-" + (yield* hash(fields)),
    })
  })
}
