import { Schema } from "effect"
import {
  BindingSchema,
  PublishedMembersSchema,
  SubscriptionSchema,
  UpstreamOperationSchema,
  UpstreamPlanSchema,
} from "./upstream-model.ts"
import { PublicationMarkerSchema } from "./publication-integrity-state.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const MapCheckpointAdoptionInputSchema = Schema.Struct({
  original_plan_id: Schema.String,
  success_capture: Schema.Struct({
    command: Schema.String,
    stdout: Schema.String,
    exit_code: Schema.String,
    finished_at: Schema.String,
  }),
})
export type MapCheckpointAdoptionInput = typeof MapCheckpointAdoptionInputSchema.Type

export const MapCheckpointCaptureCommandSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  purpose: Schema.optional(Schema.String),
  started_at: Schema.String,
})
export const MapCheckpointCaptureSchema = Schema.Struct({
  input: MapCheckpointAdoptionInputSchema,
  sha256: Schema.Struct({ command: Hash, stdout: Hash, exit_code: Hash, finished_at: Hash }),
  command: MapCheckpointCaptureCommandSchema,
  finished_at: Schema.String,
  historical_operation: UpstreamOperationSchema,
  selected_member: Schema.String,
})

export const AdoptedMapCheckpointSchema = Schema.Struct({
  subscription_id: Schema.String,
  version: Schema.String,
  published: PublishedMembersSchema,
})
export const MapCheckpointNativeInputsSchema = Schema.Struct({
  original_plan: UpstreamPlanSchema,
  original_operation: UpstreamOperationSchema,
  bindings: Schema.Array(BindingSchema),
  targets: Schema.Array(
    Schema.Struct({
      target_key: Schema.String,
      claim: Schema.NullOr(
        Schema.Struct({ page_id: Schema.String, publisher_subscription_id: Schema.String }),
      ),
    }),
  ),
  commands: Schema.Struct({
    saved: Schema.Struct({ unpublished: Schema.Literal(true) }),
    intended: PublishedMembersSchema,
    accepted_config: Schema.Null,
    checkpoint: Schema.Null,
    projection: Schema.NullOr(Schema.Unknown),
  }),
  publications: Schema.Array(
    Schema.Struct({ operation_id: Schema.String, receipt_sha256: Hash, integrity_sha256: Hash }),
  ),
})
export const MapCheckpointMemberProofSchema = Schema.Struct({
  member_key: Schema.String,
  page_id: Schema.String,
  publication_operation_id: Schema.String,
  version: Schema.String,
  content_hash: Hash,
  ownership: Schema.Struct({
    subscription_id: Schema.String,
    member_key: Schema.String,
    mode: Schema.Literal("tracked"),
    published_hash: Hash,
    revision: Schema.String,
  }),
  marker: PublicationMarkerSchema,
  metadata_sha256: Hash,
  observed_portable_sha256: Hash,
})
export const MapCheckpointAdoptionPlanSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("upstream_map_checkpoint_adoption"),
  authority: Schema.Literal("adopt_observed_complete_baseline"),
  plan_id: Schema.String,
  plan_hash: Hash,
  scope: Schema.String,
  capture: MapCheckpointCaptureSchema,
  native_inputs: MapCheckpointNativeInputsSchema,
  native_inputs_sha256: Hash,
  remote_evidence: Schema.Struct({
    subscription: SubscriptionSchema,
    last_edited_time: Schema.String,
    members: Schema.Array(MapCheckpointMemberProofSchema),
  }),
  evidence_sha256: Hash,
  checkpoint: AdoptedMapCheckpointSchema,
})
export type MapCheckpointAdoptionPlan = typeof MapCheckpointAdoptionPlanSchema.Type
export const MapCheckpointAdoptionReceiptSchema = Schema.Struct({
  format: Schema.Literal(1),
  domain: Schema.Literal("upstream_map_checkpoint_adoption"),
  authority: Schema.Literal("adopt_observed_complete_baseline"),
  state: Schema.Literal("applied"),
  operation_id: Schema.String,
  plan_id: Schema.String,
  plan_hash: Hash,
  original_plan_id: Schema.String,
  original_operation_id: Schema.String,
  scope: Schema.String,
  subscription_id: Schema.String,
  checkpoint: AdoptedMapCheckpointSchema,
  native_inputs_sha256: Hash,
  evidence_sha256: Hash,
  notion_writes: Schema.Literal(0),
  original_history_changed: Schema.Literal(false),
})
export const mapCheckpointAdoptionPlanKey = (id: string) => `map-checkpoint-adoption:plan:${id}`
export const mapCheckpointAdoptionReceiptKey = (id: string) =>
  `map-checkpoint-adoption:receipt:${id}`

/** The receipt records this reviewed baseline adoption, never a historical remote ACK. */
export function mapCheckpointAdoptionReceipt(plan: MapCheckpointAdoptionPlan) {
  return Schema.decodeUnknownSync(MapCheckpointAdoptionReceiptSchema)(
    {
      format: 1,
      domain: "upstream_map_checkpoint_adoption",
      authority: "adopt_observed_complete_baseline",
      state: "applied",
      operation_id: `${plan.plan_id}:apply`,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      original_plan_id: plan.native_inputs.original_plan.plan_id,
      original_operation_id: plan.native_inputs.original_operation.operation_id,
      scope: plan.scope,
      subscription_id: plan.checkpoint.subscription_id,
      checkpoint: plan.checkpoint,
      native_inputs_sha256: plan.native_inputs_sha256,
      evidence_sha256: plan.evidence_sha256,
      notion_writes: 0,
      original_history_changed: false,
    },
    { onExcessProperty: "error" },
  )
}
