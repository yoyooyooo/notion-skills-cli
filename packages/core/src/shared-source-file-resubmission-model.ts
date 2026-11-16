import { Schema } from "effect"
import {
  SharedCreateFrozenPostSchema,
  SharedNativeAllocationReferenceSchema,
} from "./shared-create-recovery-acknowledgement-model.ts"
import { SharedCreateRecoveryBindingSchema } from "./shared-create-recovery-proof-model.ts"
import {
  SourceMutationAcknowledgementSchema,
  SourceMutationRejectionSchema,
} from "./shared-sources-model.ts"
import type { NativeImagePolicy } from "./shared-native-image-layout.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const ReviewId = Schema.String.check(Schema.isPattern(/^source-file-resubmission-[a-f0-9]{64}$/u))
export const SourceFileResubmissionTextReferenceSchema = Schema.Struct({
  sha256: Hash,
  bytes: Size,
})
export const SourceFileResubmissionObservationSchema = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  body_sha256: Hash,
  body_bytes: Size,
  event_id: Schema.String,
})
const SourceFileResubmissionReviewV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_resubmission_review"),
  review_id: ReviewId,
  original_operation_id: Schema.String,
  permission_scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  source_id: Schema.String,
  file_id: Schema.String,
  path: Schema.String,
  plan_sha256: Hash,
  manifest_sha256: Hash,
  failure_sha256: Hash,
  journal_sha256: Hash,
  retained_review_id: Schema.String,
  retained_review_hash: Hash,
  wire_policy: Schema.Literal("native_image_blocks_v1"),
  changes: Schema.Struct({
    paragraphs: Size,
    images: Size,
    linked_images: Size,
    inserted_line_feeds: Size,
  }),
  original_request_sha256: Hash,
  original_rejection_sha256: Hash,
  candidate_body_sha256: Hash,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  allocations: Schema.Array(SharedNativeAllocationReferenceSchema),
  observations: Schema.Array(SourceFileResubmissionObservationSchema),
})
export const SourceFileResubmissionPlanV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_resubmission_plan"),
  review: SourceFileResubmissionReviewV1Schema,
  original_dispatch: SharedCreateFrozenPostSchema,
  original_rejection: SourceMutationRejectionSchema,
})
const SourceFileResubmissionReviewV2Schema = Schema.Struct({
  ...SourceFileResubmissionReviewV1Schema.fields,
  version: Schema.Literal(2),
  wire_policy: Schema.Literal("native_linked_images_v2"),
  changes: Schema.Struct({
    ...SourceFileResubmissionReviewV1Schema.fields.changes.fields,
    detached_linked_images: Size,
  }),
  predecessor_sha256: Hash,
})
export const SourceFileResubmissionPredecessorSchema = Schema.Struct({
  plan: SourceFileResubmissionPlanV1Schema,
  review_record_hash: Hash,
  dispatch: SharedCreateFrozenPostSchema,
  rejection: SourceMutationRejectionSchema,
})
export const SourceFileResubmissionPlanV2Schema = Schema.Struct({
  ...SourceFileResubmissionPlanV1Schema.fields,
  version: Schema.Literal(2),
  review: SourceFileResubmissionReviewV2Schema,
  predecessor: SourceFileResubmissionPredecessorSchema,
})
export const SourceFileResubmissionReviewSchema = Schema.Union([
  SourceFileResubmissionReviewV1Schema,
  SourceFileResubmissionReviewV2Schema,
])
export const SourceFileResubmissionPlanSchema = Schema.Union([
  SourceFileResubmissionPlanV1Schema,
  SourceFileResubmissionPlanV2Schema,
])
export type SourceFileResubmissionPlan = typeof SourceFileResubmissionPlanSchema.Type

/** Shared immutable facts stay bounded; complete plans and responses use the existing text codec. */
export const SourceFileResubmissionReviewRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_resubmission_review_record"),
  review_id: ReviewId,
  original_operation_id: Schema.String,
  file_id: Schema.String,
  path: Schema.String,
  plan: SourceFileResubmissionTextReferenceSchema,
})
export const SourceFileResubmissionCompletionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_resubmission_completion"),
  review_id: ReviewId,
  original_operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  path: Schema.String,
  page_id: Schema.String,
  new_dispatch: SharedCreateFrozenPostSchema,
  new_acknowledgement: SourceMutationAcknowledgementSchema,
  observation: SourceFileResubmissionObservationSchema,
})
export const SourceFileResubmissionCompletionRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_file_resubmission_completion_record"),
  review_id: ReviewId,
  original_operation_id: Schema.String,
  file_id: Schema.String,
  path: Schema.String,
  proof: SourceFileResubmissionTextReferenceSchema,
})
export const SourceFileResubmissionCompletionReferenceSchema = Schema.Struct({
  file_id: Schema.String,
  path: Schema.String,
  review_id: ReviewId,
  review_record_hash: Hash,
  outcome_record_hash: Hash,
})
export type SourceFileResubmissionCompletionReference =
  typeof SourceFileResubmissionCompletionReferenceSchema.Type

/** Produced only after the complete original refusal, independent review, ACK and body were verified. */
export type VerifiedNativeFileSubstitution = {
  readonly original_operation_id: string
  readonly file_id: string
  readonly path: string
  readonly original_dispatch: typeof SharedCreateFrozenPostSchema.Type
  readonly original_rejection: typeof SourceMutationRejectionSchema.Type
  readonly review_id: string
  readonly wire_policy: NativeImagePolicy
  readonly new_dispatch: typeof SharedCreateFrozenPostSchema.Type
  readonly new_acknowledgement: typeof SourceMutationAcknowledgementSchema.Type
  readonly page_id: string
  readonly prefix_bindings: readonly (typeof SharedCreateRecoveryBindingSchema.Type)[]
  readonly prefix_observations: readonly (typeof SourceFileResubmissionObservationSchema.Type)[]
  readonly observation: typeof SourceFileResubmissionObservationSchema.Type
  readonly completion_reference: SourceFileResubmissionCompletionReference
}
