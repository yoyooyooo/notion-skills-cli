import { Effect, Schema } from "effect"
import { fail } from "./model.ts"
import {
  SharedBodyWritePlanSchema,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import {
  SharedObservationPlanSchema,
  validateSharedObservationPlan,
  type SharedObservationPlan,
} from "./shared-observation-operation.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export type SharedPendingFilePlan = SharedObservationPlan | SharedBodyWritePlan
export type SharedPendingFileScope = {
  readonly prefix: string
  readonly scope: string
  readonly library_id: string
  readonly skill_id: string
  readonly skill_page_id: string
}

const PendingFileOperationSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  plan: Schema.Union([SharedObservationPlanSchema, SharedBodyWritePlanSchema]),
})

/** A dispatch barrier, not ownership state. Keep the registered SQLite namespace. */
export function sharedPendingObservationPrefix(scope: string, libraryId: string, skillId: string) {
  return sha256(canonicalSharedJson([scope, libraryId, skillId])).pipe(
    Effect.map((identity) => `operations/shared-observation-pending/${identity}`),
  )
}

export function pendingFileOperationKey(prefix: string, plan: SharedPendingFilePlan) {
  return sha256(canonicalSharedJson([plan.file_id, plan.operation_id])).pipe(
    Effect.map((identity) => `${prefix}/${identity}.json`),
  )
}

function validatePlan(plan: SharedPendingFilePlan) {
  return plan.kind === "body_write"
    ? validateSharedBodyWritePlan(plan).pipe(Effect.map((value): SharedPendingFilePlan => value))
    : validateSharedObservationPlan(plan).pipe(Effect.map((value): SharedPendingFilePlan => value))
}

function scopeMatches(input: SharedPendingFileScope, plan: SharedPendingFilePlan) {
  return (
    plan.skill_page_id === input.skill_page_id &&
    (plan.kind !== "body_write" ||
      (plan.library_id === input.library_id && plan.skill_id === input.skill_id))
  )
}

export function pendingFileOperations(input: SharedPendingFileScope) {
  return Effect.gen(function* () {
    const store = yield* Store
    const entries: Array<{ readonly key: string; readonly plan: SharedPendingFilePlan }> = []
    for (const key of yield* store.listKeys(`${input.prefix}/`)) {
      if (!key.endsWith(".json")) continue
      const entry = yield* store.readJson(key, PendingFileOperationSchema)
      if (entry === undefined) continue
      const plan = yield* validatePlan(entry.plan)
      if (
        entry.scope !== input.scope ||
        entry.library_id !== input.library_id ||
        entry.skill_id !== input.skill_id ||
        entry.skill_page_id !== input.skill_page_id ||
        !scopeMatches(input, plan) ||
        key !== (yield* pendingFileOperationKey(input.prefix, plan))
      )
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "A pending file operation belongs to a different scope or original intent.",
          ),
        )
      entries.push({ key, plan })
    }
    return entries
  })
}

export function retainPendingFileOperation(
  input: SharedPendingFileScope,
  plan: SharedPendingFilePlan,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const validated = yield* validatePlan(plan)
    if (!scopeMatches(input, validated))
      return yield* Effect.fail(
        fail("SHARED_FILE_SCOPE", "The pending file operation belongs to another shared Skill."),
      )
    const key = yield* pendingFileOperationKey(input.prefix, validated)
    const value = {
      version: 1 as const,
      scope: input.scope,
      library_id: input.library_id,
      skill_id: input.skill_id,
      skill_page_id: input.skill_page_id,
      plan: validated,
    }
    const previous = yield* store.readJson(key, PendingFileOperationSchema)
    if (previous !== undefined && canonicalSharedJson(previous) !== canonicalSharedJson(value))
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "A frozen dispatch receipt cannot be replaced by a different original plan.",
        ),
      )
    yield* store.writeJson(key, value)
  })
}
