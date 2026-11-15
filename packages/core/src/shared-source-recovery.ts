import { Effect, Schema } from "effect"
import { fail, property, type SkillsError } from "./model.ts"
import {
  createChecked,
  validateSharedCreatePlan,
  type SharedCreatePlan,
} from "./shared-create-model.ts"
import { SourceOnboardingPlanSchema } from "./shared-source-onboarding-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"
import {
  reviewSharedCreateRecovery,
  applySharedCreateRecovery,
  reconcileSharedCreateRecovery,
} from "./shared-create-recovery.ts"
import {
  reviewSharedRetainedImportRecovery,
  applySharedRetainedImportRecovery,
  reconcileSharedRetainedImportRecovery,
} from "./shared-create-retained-recovery.ts"

/** Select a byte-identical original child without exporting, regenerating or
 * asking an Agent to edit the private parent plan. No runtime is acquired. */
export function selectOriginalSourceRecoveryPlan(input: unknown, operationId?: string) {
  return Effect.gen(function* () {
    if (property(input).kind !== "source_onboarding") {
      const plan = yield* validateSharedCreatePlan(input)
      if (operationId !== undefined && plan.operation_id !== operationId)
        return yield* Effect.fail(
          fail(
            "SOURCE_RECOVERY_SCOPE",
            "The selected operation differs from this original admission plan.",
          ),
        )
      return plan
    }
    const parent = yield* createChecked(() =>
      Schema.decodeUnknownSync(SourceOnboardingPlanSchema)(input, { onExcessProperty: "error" }),
    )
    const { plan_id, ...fields } = parent
    if (plan_id !== "source-onboarding-" + (yield* sha256(canonicalSharedJson(fields))))
      return yield* Effect.fail(
        fail("SOURCE_ONBOARDING_INVALID", "The original frozen parent plan digest differs."),
      )
    if (operationId === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_RECOVERY_OPERATION_REQUIRED",
          "Select the exact original child operation from this saved onboarding plan.",
        ),
      )
    const matches = parent.actions.filter(
      (action) => action.kind === "create" && action.plan.operation_id === operationId,
    )
    const action = matches[0]
    if (matches.length !== 1 || action?.kind !== "create")
      return yield* Effect.fail(
        fail(
          "SOURCE_RECOVERY_SCOPE",
          "The original parent has no unique creation with that exact operation ID.",
        ),
      )
    const plan = yield* validateSharedCreatePlan(action.plan)
    if (
      !plan.source_projection ||
      plan.source_projection.definition.page_id !== action.source.page_id ||
      plan.source_projection.definition.source_id !== action.source.source_id ||
      plan.source_projection.definition.fingerprint !== action.source.fingerprint ||
      plan.source_projection.definition.member !== action.member ||
      !sameLibrary(parent.library, plan.library)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_RECOVERY_SCOPE",
          "The selected child does not preserve its original parent, Source or member.",
        ),
      )
    return plan
  })
}
const sameLibrary = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)

/** The caller already owns the complete frozen admission/parent file. A
 * recovery failure returns its exact identity, not another multi-megabyte copy
 * of private input objects. Budget wrappers preserve the projected diagnostic. */
export function sourceRecoveryError(error: SkillsError, plan: SharedCreatePlan): SkillsError {
  const project = (input: unknown): unknown => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input
    const details = property(input)
    const recovery = property(details.recovery)
    const stage = typeof details.stage === "string" ? details.stage : ""
    const file = stage.startsWith("create_file:")
      ? plan.files.find((item) => item.file_id === stage.slice("create_file:".length))
      : undefined
    const { plan: originalInput, ...remainingRecovery } = recovery
    const original = property(originalInput)
    return {
      ...details,
      ...(file === undefined ? {} : { file_id: file.file_id, path: file.path }),
      ...(Object.hasOwn(details, "original_details")
        ? { original_details: project(details.original_details) }
        : {}),
      ...(Object.hasOwn(recovery, "plan")
        ? {
            recovery: {
              ...remainingRecovery,
              original_plan: {
                operation_id: original.operation_id ?? null,
                skill_id: original.skill_id ?? null,
                retained_in_saved_input:
                  canonicalSharedJson(originalInput) === canonicalSharedJson(plan),
                full_input_omitted: true,
              },
            },
          }
        : {}),
    }
  }
  return fail(error.code, error.message, project(error.details))
}

export function reviewSharedSourceRecovery(input: {
  readonly entry: string
  readonly target: string
  readonly plan: unknown
  readonly operationId?: string
}) {
  return Effect.gen(function* () {
    const plan = yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId)
    const action = Effect.gen(function* () {
      if (plan.source_projection?.version === 2)
        return yield* reviewSharedRetainedImportRecovery({ ...input, plan })
      return yield* reviewSharedCreateRecovery({ ...input, plan, operationId: plan.operation_id })
    })
    return yield* action.pipe(Effect.mapError((error) => sourceRecoveryError(error, plan)))
  }).pipe(withReadOnlyNotion)
}

export function applySharedSourceRecovery(input: {
  readonly entry: string
  readonly plan: unknown
  readonly operationId?: string
  readonly review: unknown
  readonly reviewId: string
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId)
    const action = Effect.gen(function* () {
      if (plan.source_projection?.version === 2)
        return yield* applySharedRetainedImportRecovery({ ...input, plan })
      return yield* applySharedCreateRecovery({ ...input, plan })
    })
    return yield* withSourceUpdateLock(
      plan.library,
      input.dryRun ? action.pipe(withReadOnlyNotion) : action,
    ).pipe(Effect.mapError((error) => sourceRecoveryError(error, plan)))
  })
}

export function reconcileSharedSourceRecovery(input: {
  readonly entry: string
  readonly target: string
  readonly plan: unknown
  readonly operationId?: string
}) {
  return Effect.gen(function* () {
    const plan = yield* selectOriginalSourceRecoveryPlan(input.plan, input.operationId)
    const action = Effect.gen(function* () {
      if (plan.source_projection?.version === 2)
        return yield* reconcileSharedRetainedImportRecovery({ ...input, plan })
      return yield* reconcileSharedCreateRecovery({
        ...input,
        plan,
        operationId: plan.operation_id,
      })
    })
    return yield* action.pipe(Effect.mapError((error) => sourceRecoveryError(error, plan)))
  }).pipe(withReadOnlyNotion)
}
