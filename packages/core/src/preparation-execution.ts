import { Effect } from "effect"
import { fail, SkillsError } from "./model.ts"

/** Execution limits never change the selected graph, its version vector or its purpose. */
export type PrepareExecutionOptions = {
  readonly priority?: "required" | "prefetch"
  readonly queueBudgetMs?: number
  readonly timeBudgetMs?: number
  readonly rateShare?: number
}
export type PrepareExecution = {
  readonly priority: "required" | "prefetch"
  readonly queueBudgetMs?: number
  readonly timeBudgetMs?: number
  readonly rateShare?: number
}

export function normalizePrepareExecution(options: PrepareExecutionOptions = {}): PrepareExecution {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) => !["priority", "queueBudgetMs", "timeBudgetMs", "rateShare"].includes(key),
    ) ||
    (options.priority !== undefined && !["required", "prefetch"].includes(options.priority))
  )
    throw fail("INVALID_ARGUMENT", "Invalid preparation execution policy.")
  for (const key of ["queueBudgetMs", "timeBudgetMs"] as const) {
    const value = options[key]
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    )
      throw fail("INVALID_ARGUMENT", `${key} requires a positive duration in milliseconds.`)
  }
  const priority = options.priority ?? "required"
  if (
    options.rateShare !== undefined &&
    (priority !== "prefetch" ||
      !Number.isFinite(options.rateShare) ||
      options.rateShare <= 0 ||
      options.rateShare > 1)
  )
    throw fail(
      "INVALID_ARGUMENT",
      "rateShare requires prefetch priority and a number greater than zero and at most one.",
    )
  return priority === "prefetch"
    ? {
        priority,
        queueBudgetMs: options.queueBudgetMs ?? 1_000,
        timeBudgetMs: options.timeBudgetMs ?? 5_000,
        rateShare: options.rateShare ?? 0.1,
      }
    : {
        priority,
        ...(options.queueBudgetMs === undefined ? {} : { queueBudgetMs: options.queueBudgetMs }),
        ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
      }
}

export const prepareRequestPolicy = (execution: PrepareExecution) => ({
  priority: execution.priority,
  ...(execution.queueBudgetMs === undefined ? {} : { queueBudgetMs: execution.queueBudgetMs }),
  ...(execution.rateShare === undefined ? {} : { rateShare: execution.rateShare }),
})

export function withPrepareExecution<A, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  execution: PrepareExecution,
) {
  if (execution.timeBudgetMs === undefined) return effect
  return effect.pipe(
    Effect.timeout(execution.timeBudgetMs),
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "PREPARE_TIME_BUDGET",
            "Preparation was cancelled after its execution time budget.",
            {
              deferred: true,
              priority: execution.priority,
              time_budget_ms: execution.timeBudgetMs,
            },
          ),
    ),
  )
}
