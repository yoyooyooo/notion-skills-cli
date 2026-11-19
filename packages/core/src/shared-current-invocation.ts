import { Crypto, Effect, Option } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, type SkillsError } from "./model.ts"
import {
  makeRequestBudget,
  RequestBudget,
  type RequestBudgetLimits,
  type RequestBudgetSnapshot,
} from "./request-budget.ts"
import { requestBudgetHttpClient } from "./request-budget-http.ts"

export const DEFAULT_CURRENT_INVOCATION_BUDGET: RequestBudgetLimits = Object.freeze({
  requests: 1000,
  bytes: 512 * 1024 * 1024,
  duration_ms: 600_000,
})

/** Install inside the existing runtime, before the first library lookup. Every
 * transport shares one deadline and permit; nested writers cannot reset either.
 * Resume is another outer invocation, with fresh allowance and no budget history.
 * Transport-owned deadlines preserve uncertain writes instead of racing an outer timeout. */
export function withCurrentInvocationBudget<A, R>(
  effect: Effect.Effect<A, SkillsError, R>,
  limits?: Partial<RequestBudgetLimits>,
): Effect.Effect<
  { readonly result: A; readonly budget: RequestBudgetSnapshot },
  SkillsError,
  Exclude<R, RequestBudget> | Crypto.Crypto | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const inherited = yield* Effect.serviceOption(RequestBudget)
    const supplied = Object.fromEntries(
      Object.entries(limits ?? {}).filter(([, value]) => value !== undefined),
    ) as Partial<RequestBudgetLimits>
    let budget: RequestBudget["Service"]
    if (Option.isSome(inherited)) {
      budget = inherited.value
      const current = yield* budget.snapshot
      for (const key of ["requests", "bytes", "duration_ms"] as const)
        if (supplied[key] !== undefined && supplied[key] !== current.limits[key])
          return yield* Effect.fail(
            fail(
              "REQUEST_BUDGET_RECONFIGURATION",
              "A nested current invocation cannot change its active request budget.",
              { budget: current, requested_limits: supplied },
            ),
          )
    } else {
      const identity = yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(
          Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify the current invocation.")),
        )
      budget = yield* makeRequestBudget(`current-invocation-${identity}`, {
        ...DEFAULT_CURRENT_INVOCATION_BUDGET,
        ...supplied,
      })
    }
    const client = yield* HttpClient.HttpClient
    const outcome = yield* effect.pipe(
      Effect.provideService(RequestBudget, budget),
      Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(client, budget)),
      Effect.result,
    )
    const usage = yield* budget.snapshot
    if (outcome._tag === "Failure")
      return yield* Effect.fail(
        fail(outcome.failure.code, outcome.failure.message, {
          ...property(outcome.failure.details),
          budget: usage,
        }),
      )
    return { result: outcome.success, budget: usage }
  })
}
