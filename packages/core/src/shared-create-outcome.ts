import { Schema } from "effect"
import { fail } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  sharedCreateManifest,
  sharedCreateOutcomesEntity,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import { canonicalSharedJson, type SharedRecord } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const OutcomeFields = {
  kind: Schema.Literal("skill_create_outcome"),
  operation_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  status: Schema.Literals(["applied", "needs_review"]),
  reason_code: Schema.String,
  bindings: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      path: Schema.String,
      page_id: Schema.String,
      event_id: Schema.String,
    }),
  ),
}
export const SharedCreateOutcomeSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    ...OutcomeFields,
    source_projection: Schema.optional(
      Schema.Struct({
        source_id: Schema.String,
        revision: Schema.String,
        manifest_record_hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
        local_customization: Schema.optional(Schema.Literal(1)),
      }),
    ),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...OutcomeFields,
    migration_candidate_id: Schema.String.check(
      Schema.isPattern(/^migration-create-[a-f0-9]{64}$/u),
    ),
    manifest_record_hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
])
export type SharedCreateOutcome = typeof SharedCreateOutcomeSchema.Type
export type SharedCreateBinding = SharedCreateOutcome["bindings"][number]
export const sharedCreateOutcomeId = (operation: string) => `outcome-${operation}`
export function sharedCreateManifestRecordHash(plan: SharedCreatePlan) {
  return sha256(
    canonicalSharedJson({
      version: 1,
      operation_id: plan.operation_id,
      payload: sharedCreateManifest(plan),
    }),
  )
}
export function decodeSharedCreateOutcome(row: SharedRecord): SharedCreateOutcome {
  const result = Schema.decodeUnknownSync(SharedCreateOutcomeSchema)(row.payload, {
    onExcessProperty: "error",
  })
  if (
    !/^skill-create-[a-f0-9]{64}$/u.test(result.operation_id) ||
    row.record_id !== sharedCreateOutcomeId(result.operation_id) ||
    row.operation_id !== result.operation_id ||
    row.entity_id !== sharedCreateOutcomesEntity ||
    row.kind !== "operation" ||
    row.skill_page_id !== result.skill_page_id ||
    pageId(result.skill_page_id) !== result.skill_page_id ||
    result.bindings.some((binding) => pageId(binding.page_id) !== binding.page_id) ||
    new Set(result.bindings.map((binding) => binding.file_id)).size !== result.bindings.length
  )
    throw fail(
      "SHARED_CREATE_INVALID",
      "The native creation outcome has a foreign original-operation identity or duplicate binding.",
    )
  return result
}
