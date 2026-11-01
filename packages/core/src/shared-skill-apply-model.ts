import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import {
  SharedBodyWritePlanSchema,
  validateSharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import {
  SharedMetadataWritePlanSchema,
  validateSharedMetadataWritePlan,
} from "./shared-metadata-write-model.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const SharedSkillApplyPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("skill_apply"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-apply-[a-f0-9]{64}\.[a-f0-9]{64}$/u)),
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  snapshot_id: Schema.String.check(Schema.isPattern(/^s_[a-f0-9]{64}$/u)),
  snapshot_version_id: Schema.String,
  snapshot_scope: Hash,
  source_id: Schema.String,
  bodies: Schema.Array(SharedBodyWritePlanSchema),
  metadata: Schema.optional(SharedMetadataWritePlanSchema),
})
export type SharedSkillApplyPlan = typeof SharedSkillApplyPlanSchema.Type
export type SharedSkillApplyChild =
  | SharedSkillApplyPlan["bodies"][number]
  | NonNullable<SharedSkillApplyPlan["metadata"]>
export const sharedSkillApplyPlansEntity = "skill-apply-plans-v1"
export const sharedSkillApplyOutcomesEntity = "skill-apply-outcomes-v1"
export const sharedSkillApplyOutcomeId = (operationId: string) => `outcome-${operationId}`
export const sharedSkillApplyProtection = {
  strategy: "frozen_sequential_child_operations",
  atomic: false,
  all_inputs_validated_before_dispatch: true,
  automatic_retry: false,
  automatic_rollback: false,
  original_children_required_for_recovery: true,
} as const

export const applyChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_APPLY_INVALID", "The frozen shared apply operation is invalid."),
  })

export function sharedSkillApplyChildren(
  plan: Pick<SharedSkillApplyPlan, "bodies" | "metadata">,
): readonly SharedSkillApplyChild[] {
  return [...plan.bodies, ...(plan.metadata === undefined ? [] : [plan.metadata])]
}

export function sharedSkillApplyChildrenHash(operationId: string): string | undefined {
  return /^skill-apply-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(operationId)?.[1]
}

export function validateSharedSkillApplyPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* applyChecked(() =>
      Schema.decodeUnknownSync(SharedSkillApplyPlanSchema)(input, { onExcessProperty: "error" }),
    )
    const children = sharedSkillApplyChildren(plan)
    yield* applyChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        plan.snapshot_version_id === "" ||
        children.length === 0 ||
        new Set(children.map((child) => child.operation_id)).size !== children.length ||
        new Set(plan.bodies.map((child) => child.file_id)).size !== plan.bodies.length ||
        new Set(plan.bodies.map((child) => child.page_id)).size !== plan.bodies.length ||
        new Set(plan.bodies.map((child) => child.path)).size !== plan.bodies.length
      )
        throw fail(
          "SHARED_APPLY_INVALID",
          "An apply requires one exact Skill and distinct changed child identities.",
        )
      if (
        canonicalSharedJson(plan.bodies.map((child) => child.path)) !==
        canonicalSharedJson(plan.bodies.map((child) => child.path).sort())
      )
        throw fail("SHARED_APPLY_INVALID", "Apply body operations must use canonical path order.")
      for (const child of children) {
        if (
          child.library_id !== plan.library_id ||
          child.skill_id !== plan.skill_id ||
          child.skill_page_id !== plan.skill_page_id
        )
          throw fail(
            "SHARED_APPLY_INVALID",
            "Every frozen child must belong to the exact original shared Skill.",
          )
        if (
          child.kind === "body_write" &&
          (child.action !== "write" ||
            child.source_id !== plan.source_id ||
            child.before.fingerprint.sha256 === child.candidate.content.sha256)
        )
          throw fail(
            "SHARED_APPLY_INVALID",
            "An apply body child must change one file without changing source selection.",
          )
        if (
          child.kind === "metadata_write" &&
          (child.file_id !== plan.file_id ||
            child.changes.some((change) => change.field === "Source") ||
            child.changes.every(
              (change) => canonicalSharedJson(change.before) === canonicalSharedJson(change.after),
            ))
        )
          throw fail(
            "SHARED_APPLY_INVALID",
            "Apply metadata must change nominated authoring fields; Source uses its explicit selector.",
          )
      }
    })
    for (const child of plan.bodies) yield* validateSharedBodyWritePlan(child)
    if (plan.metadata !== undefined) yield* validateSharedMetadataWritePlan(plan.metadata)
    const childrenHash = yield* sha256(
      canonicalSharedJson(children.map((child) => child.operation_id)),
    )
    const { operation_id, ...description } = plan
    if (
      operation_id !==
      `skill-apply-${childrenHash}.${yield* sha256(canonicalSharedJson(description))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "The original apply identity does not match its complete child plans.",
        ),
      )
    yield* applyChecked(() => validateSharedRecordEnvelope(plan.operation_id, plan))
    return plan
  })
}

export function makeSharedSkillApplyPlan(
  input: Omit<SharedSkillApplyPlan, "version" | "kind" | "operation_id">,
) {
  return Effect.gen(function* () {
    const description = { version: 1 as const, kind: "skill_apply" as const, ...input }
    const childrenHash = yield* sha256(
      canonicalSharedJson(sharedSkillApplyChildren(description).map((child) => child.operation_id)),
    )
    const operation_id = `skill-apply-${childrenHash}.${yield* sha256(canonicalSharedJson(description))}`
    return yield* validateSharedSkillApplyPlan({ ...description, operation_id })
  })
}
