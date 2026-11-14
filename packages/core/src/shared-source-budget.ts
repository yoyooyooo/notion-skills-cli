import { Crypto, Effect } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, type SkillsError } from "./model.ts"
import { makeRequestBudget, RequestBudget, type RequestBudgetLimits } from "./request-budget.ts"
import { requestBudgetHttpClient } from "./request-budget-http.ts"

/** Manual apply and reconcile use the same transport admission and deadline as policy runs. */
export function withSourceCommandBudget<A, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  limits: RequestBudgetLimits,
) {
  return Effect.gen(function* () {
    const identity = yield* (yield* Crypto.Crypto)
      .randomUUIDv4()
      .pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify this source invocation.")))
    const budget = yield* makeRequestBudget(`source-command-${identity}`, limits)
    const client = yield* HttpClient.HttpClient
    const outcome = yield* effect.pipe(
      Effect.provideService(RequestBudget, budget),
      Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(client, budget)),
      Effect.timeout(limits.duration_ms),
      Effect.catchTag("TimeoutError", () => Effect.fail(budget.exhaust("duration"))),
      Effect.result,
    )
    const usage = yield* budget.snapshot
    if (outcome._tag === "Failure")
      return yield* Effect.fail(
        fail(outcome.failure.code, outcome.failure.message, {
          original_details: outcome.failure.details ?? null,
          ...(property(outcome.failure.details).next === undefined
            ? {}
            : { next: property(outcome.failure.details).next }),
          budget: usage,
          recovery:
            "Keep the exact frozen plan and inspect its original operations; do not start a replacement dispatch.",
        }),
      )
    return { result: outcome.success, budget: usage }
  })
}
