import { Schema } from "effect"
import { PortableRelationsSchema } from "./portable.ts"
import { SKILL_REF_VERSION } from "./skill-ref.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const FrozenImportValueSchema = Schema.Struct({ sha256: Hash, text: Schema.String })
export type FrozenImportValue = typeof FrozenImportValueSchema.Type
export const CurrentImportDefinitionSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["single", "batch"]),
  mapping: Schema.Array(Schema.Struct({ root: Schema.String, identity: Schema.String })),
  rewrites: Schema.Array(
    Schema.Struct({
      skill_id: Schema.String,
      from: Schema.String,
      before: Schema.String,
      after: Schema.String,
    }),
  ),
  items: Schema.Array(
    Schema.Struct({
      skill_id: Schema.String,
      original_input_sha256: Hash,
      body: FrozenImportValueSchema,
      body_input_sha256: Hash,
      create_only: Schema.Boolean,
      relations: Schema.optional(PortableRelationsSchema),
      members_discovery: Schema.Unknown,
    }),
  ),
})
export type CurrentImportDefinition = typeof CurrentImportDefinitionSchema.Type
const StepSchema = Schema.Struct({
  phase: Schema.Literals(["started", "complete"]),
  skill_id: Schema.String,
  operation_id: Schema.String,
  input_sha256: Hash,
  prepared: FrozenImportValueSchema,
  result: Schema.optional(Schema.Unknown),
})
export type Step = typeof StepSchema.Type
export const ImportPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  ref_version: Schema.Literal(SKILL_REF_VERSION),
  scope: Hash,
  library_id: Schema.String,
  skills_data_source_id: Schema.String,
  operation_id: Schema.String,
  request_sha256: Hash,
  definition_sha256: Hash,
  definition: CurrentImportDefinitionSchema,
  steps: Schema.Record(Schema.String, StepSchema),
})
export type ImportPlan = typeof ImportPlanSchema.Type

/** Dispatch progress is additive. The compiled mapping, content, relation
 * policy and each started child's exact payload can never be replaced. */
export function preservesCurrentImportPlan(before: unknown, after: unknown): boolean {
  try {
    const decode = Schema.decodeUnknownSync(ImportPlanSchema)
    const old = decode(before, { onExcessProperty: "error" })
    const next = decode(after, { onExcessProperty: "error" })
    const { steps: oldSteps, ...oldIntent } = old
    const { steps: newSteps, ...newIntent } = next
    if (JSON.stringify(oldIntent) !== JSON.stringify(newIntent)) return false
    for (const [key, previous] of Object.entries(oldSteps)) {
      const current = newSteps[key]
      if (current === undefined) return false
      if (previous.phase === "complete") {
        if (JSON.stringify(previous) !== JSON.stringify(current)) return false
      } else {
        const { phase: _beforePhase, result: _beforeResult, ...intent } = previous
        const { phase: _afterPhase, result: _afterResult, ...continued } = current
        if (JSON.stringify(intent) !== JSON.stringify(continued)) return false
      }
    }
    for (const [key, step] of Object.entries(newSteps)) {
      const item = next.definition.items.find((item) => item.skill_id === step.skill_id)
      if (item === undefined || (step.phase === "started" && step.result !== undefined))
        return false
      if (key === "body:" + step.skill_id) {
        if (
          step.prepared.sha256 !== item.body.sha256 ||
          step.input_sha256 !== item.body_input_sha256
        )
          return false
      } else if (key !== "relations:" + step.skill_id || item.relations === undefined) return false
    }
    return true
  } catch {
    return false
  }
}
