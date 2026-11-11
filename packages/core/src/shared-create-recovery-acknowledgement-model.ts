import { Schema } from "effect"
import { SourceMutationAcknowledgementSchema } from "./shared-sources-model.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Attempt = Schema.String.check(
  Schema.isPattern(/^(?:skill-create|create-recovery)-[a-f0-9]{64}$/u),
)

/** Shared data-only original request/ACK commitments, independent of recovery execution. */
export const SharedCreateKnownBootstrapSchema = Schema.Struct({
  kind: Schema.Literals(["known_needs_review", "acknowledged_main_before_manifest"]),
  original_journal_sha256: Hash,
  original_dispatches_sha256: Hash,
  allocations: Schema.Array(
    Schema.Struct({ file_id: Identity, acknowledgement: SourceMutationAcknowledgementSchema }),
  ),
})
export type SharedCreateKnownBootstrap = typeof SharedCreateKnownBootstrapSchema.Type

/** Data-only ownership of the unchanged frozen create POST and original ACK.
 * Request builders, completion readers and executable recovery stay outside this leaf. */
export const SharedCreateFrozenPostSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.String.check(Schema.isPattern(/^source-op-[a-f0-9]{64}$/u)),
  identity: Schema.String,
  path: Schema.Literal("v1/pages"),
  method: Schema.Literal("POST"),
  body: Schema.Unknown,
})

export const SharedNativeAllocationProofSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native_create_acknowledgement"),
  original_operation_id: Schema.String,
  allocation_operation_id: Attempt,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  path: Schema.String,
  page_id: Schema.String,
  dispatch: SharedCreateFrozenPostSchema,
  acknowledgement: SourceMutationAcknowledgementSchema,
})
export type SharedNativeAllocationProof = typeof SharedNativeAllocationProofSchema.Type

export const SharedNativeAllocationReferenceSchema = Schema.Struct({
  file_id: Identity,
  page_id: Schema.String,
  allocation_operation_id: Attempt,
  record_id: Schema.String.check(Schema.isPattern(/^native-ack-[a-f0-9]{64}$/u)),
  hash: Hash,
})
export type SharedNativeAllocationReference = typeof SharedNativeAllocationReferenceSchema.Type
