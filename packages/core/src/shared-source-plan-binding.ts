import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { registerSharedSourceFact } from "./shared-source-registration.ts"
import {
  sharedSourcePlanId,
  validateSharedSourcePlan,
  type SharedSourcePlan,
} from "./shared-source-plan.ts"

const SourcePlanIdSchema = Schema.String.check(Schema.isPattern(/^source-plan-[a-f0-9]{64}$/u))
function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_SHARED_SOURCE", "Invalid fixed source plan binding."),
  })
}

export function makeSourcePlanBinding(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() => validateSharedSourcePlan(input))
    return { source_plan_id: yield* sharedSourcePlanId(plan), plan }
  })
}

/** Registers one immutable source fact without selecting it or materializing any resource. */
export function registerSourcePlanBinding(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly mode: "create" | "reconcile"
    readonly plan: SharedSourcePlan
  },
) {
  return Effect.gen(function* () {
    const binding = yield* makeSourcePlanBinding(input.plan)
    const record = yield* registerSharedSourceFact(library, {
      skillPageId: input.skillPageId,
      sourceId: binding.source_plan_id,
      mode: input.mode,
      payload: binding.plan,
    })
    return { binding, record }
  })
}

export function resolveSourcePlanBinding(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly sourcePlanId: string },
) {
  return Effect.gen(function* () {
    const sourceId = yield* checked(() =>
      Schema.decodeUnknownSync(SourcePlanIdSchema)(input.sourcePlanId),
    )
    const records = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "source",
      entityId: sourceId,
    })
    if (records.length === 0)
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_MISSING",
          "The exact selected source plan is unavailable; another plan or current upstream cannot replace it.",
          { source_id: sourceId },
        ),
      )
    const record = records[0]
    if (
      records.length !== 1 ||
      record === undefined ||
      record.record_id !== sourceId ||
      record.operation_id !== `register-${sourceId}`
    ) {
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_CONFLICT",
          "The selected source plan does not have one exact immutable record identity.",
          { source_id: sourceId },
        ),
      )
    }
    const binding = yield* makeSourcePlanBinding(record.payload)
    if (
      binding.source_plan_id !== sourceId ||
      canonicalSharedJson(binding.plan) !== canonicalSharedJson(record.payload)
    ) {
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_CONFLICT",
          "The selected source plan ID does not match its canonical fixed payload.",
          { source_id: sourceId },
        ),
      )
    }
    return binding
  })
}
