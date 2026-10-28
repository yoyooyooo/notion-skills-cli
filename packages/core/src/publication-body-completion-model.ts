import { Schema } from "effect"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const PlanId = Schema.String.check(Schema.isPattern(/^pbc_[a-f0-9]{64}$/))
const ObjectValue = Schema.Record(Schema.String, Schema.Unknown)
export const BodyCompletionSnapshotSchema = Schema.Struct({
  page_before: ObjectValue,
  page_after: ObjectValue,
  markdown: ObjectValue,
  inventories: Schema.Record(Schema.String, ObjectValue),
})
export const BodyCompletionRequestSchema = Schema.Struct({
  method: Schema.Literal("PATCH"),
  path: Schema.String,
  body: ObjectValue,
})
const Failure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const Proof = Schema.Struct({
  observed_at_ms: Schema.Number,
  first_sha256: Hash,
  second_sha256: Hash,
  guards_sha256: Hash,
  after: BodyCompletionSnapshotSchema,
})
export const BodyCompletionAttemptSchema = Schema.Struct({
  index: Schema.Number,
  step: Schema.Number,
  request: BodyCompletionRequestSchema,
  request_sha256: Hash,
  before: BodyCompletionSnapshotSchema,
  before_sha256: Hash,
  before_guards_sha256: Hash,
  transport: Schema.Literals(["pending", "acknowledged", "unknown"]),
  response: Schema.optional(Schema.Unknown),
  failure: Schema.optional(Failure),
  disposition: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("acknowledged_verified"), proof: Proof }),
      Schema.Struct({ kind: Schema.Literal("observed_applied"), proof: Proof }),
      Schema.Struct({
        kind: Schema.Literal("known_not_applied"),
        successor_index: Schema.Number,
        proof: Proof,
      }),
    ]),
  ),
})
export const BodyCompletionJournalSchema = Schema.Struct({
  version: Schema.Literal(1),
  plan_id: PlanId,
  plan_hash: Hash,
  original_receipt_sha256: Hash,
  phase: Schema.Literals(["running", "unknown", "verified"]),
  attempts: Schema.Array(BodyCompletionAttemptSchema),
  certificate: Schema.optional(
    Schema.Struct({
      operation_id: Schema.String,
      page_id: Schema.String,
      intended_hash: Hash,
      source_sha256: Hash,
      original_journal_sha256: Hash,
      original_guards_sha256: Hash,
      verified_at_ms: Schema.Number,
      final_snapshot_sha256: Hash,
      final_guards_sha256: Hash,
      checkpoints: Schema.Array(
        Schema.Struct({ path: Schema.String, before: Schema.Unknown, after: Schema.Unknown }),
      ),
    }),
  ),
})
export type BodyCompletionJournal = typeof BodyCompletionJournalSchema.Type
export type BodyCompletionAttempt = typeof BodyCompletionAttemptSchema.Type
export const BodyCompletionPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  domain: Schema.Literal("publication_body_completion"),
  plan_id: PlanId,
  plan_hash: Hash,
  operation_id: Schema.String,
  scope: Schema.String,
  database_id: Schema.String,
  data_source_id: Schema.String,
  root_page_id: Schema.String,
  page_id: Schema.String,
  source_path: Schema.String,
  source_sha256: Hash,
  intended_hash: Hash,
  original_intent_index: Schema.Number,
  original_receipt: Schema.Unknown,
  original_receipt_sha256: Hash,
  integrity: Schema.Unknown,
  integrity_sha256: Hash,
  before: BodyCompletionSnapshotSchema,
  before_sha256: Hash,
  guards_sha256: Hash,
  requests: Schema.Array(BodyCompletionRequestSchema),
  models_sha256: Schema.Array(Hash),
  markdown_sha256: Schema.Array(Hash),
})
export type BodyCompletionPlan = typeof BodyCompletionPlanSchema.Type
export const bodyCompletionPlanKey = (id: string) => `publication-body-completion:plan:${id}`
