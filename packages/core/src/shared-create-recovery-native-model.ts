import { Schema } from "effect"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import {
  SharedCreateRecoveryBindingSchema,
  SharedCreateRecoveryFileSchema,
  SharedCreateKnownRecoveryObservationSchema,
} from "./shared-create-recovery-proof-model.ts"
import { SharedNativeAllocationReferenceSchema } from "./shared-create-recovery-acknowledgement-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const OriginalId = Schema.String.check(Schema.isPattern(/^skill-create-[a-f0-9]{64}$/u))
const ReviewId = Schema.String.check(Schema.isPattern(/^create-recovery-[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))

/** Local authorization references are not a replacement for shared byte and ACK proof. */
export const SharedNativeRecoveryOriginSchema = Schema.Struct({
  kind: Schema.Literal("inventory_native_import"),
  plan_id: Schema.String.check(Schema.isPattern(/^inventory-import-[a-f0-9]{64}$/u)),
  plan_sha256: Hash,
  approved_manifest: Hash,
  local_entity_id: Schema.String.check(Schema.isPattern(/^local-entity-[a-f0-9]{64}$/u)),
  permissions: Schema.Literal(
    "only_this_complete_reviewed_entity; no_local_changes; no_existing_content_replacement",
  ),
})
export type SharedNativeRecoveryOrigin = typeof SharedNativeRecoveryOriginSchema.Type

/** This leaf imports no recovery runtime, request builder or inventory coordinator. */
export const SharedCreateNativeRecoveryReviewSchema = Schema.Struct({
  version: Schema.Literal(5),
  kind: Schema.Literal("skill_create_recovery_review"),
  review_id: ReviewId,
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Schema.Null,
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  decision: Schema.Literal("reproject_retained_input"),
  projection_version: Schema.Literal(12),
  observation_kind: Schema.Literal("post_failure_current_read"),
  origin: SharedNativeRecoveryOriginSchema,
  bootstrap: Schema.Struct({
    kind: Schema.Literal("acknowledged_main_before_manifest"),
    original_journal_sha256: Hash,
    original_dispatches_sha256: Hash,
    allocations: Schema.Array(SharedNativeAllocationReferenceSchema),
  }),
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
  files: Schema.Array(SharedCreateRecoveryFileSchema),
  observations: Schema.Array(SharedCreateKnownRecoveryObservationSchema),
})
export type SharedCreateNativeRecoveryReview = typeof SharedCreateNativeRecoveryReviewSchema.Type

export const SharedCreateNativeRecoveryOutcomeSchema = Schema.Struct({
  version: Schema.Literal(7),
  kind: Schema.Literal("skill_create_recovery_outcome"),
  status: Schema.Literal("applied"),
  original_operation_id: OriginalId,
  original_plan_sha256: Hash,
  original_manifest_sha256: Hash,
  original_outcome_sha256: Schema.Null,
  bootstrap_sha256: Hash,
  recovery_id: ReviewId,
  skill_id: Identity,
  skill_page_id: Schema.String,
  review_record_hash: Hash,
  bindings: Schema.Array(SharedCreateRecoveryBindingSchema),
})
export type SharedCreateNativeRecoveryOutcome = typeof SharedCreateNativeRecoveryOutcomeSchema.Type

export const sharedNativeRecoveryReviewEntity = "skill-create-native-recovery-reviews-v1"
export const sharedNativeRecoveryOutcomesEntity = "skill-create-native-recovery-outcomes-v1"
