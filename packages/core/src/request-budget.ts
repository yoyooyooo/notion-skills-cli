import { Clock, Context, Effect, Semaphore } from "effect"
import { fail, type SkillsError } from "./model.ts"

export type RequestBudgetLimits = {
  readonly requests: number
  readonly bytes: number
  readonly duration_ms: number
}

export type RequestBudgetReason = "requests" | "bytes" | "duration"

/** Opt-in invocation budget. Admission is synchronous between Effects, so two
 * concurrent transports cannot both spend the last permit. Ordinary callers do
 * not install this service and retain their existing retry/admission policy. */
export class RequestBudget extends Context.Service<
  RequestBudget,
  {
    readonly identity: string
    readonly deadline: bigint
    readonly check: Effect.Effect<void, SkillsError>
    readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    readonly admit: (requestBytes: number) => Effect.Effect<void, SkillsError>
    readonly responseBytes: (delta: number) => void
    readonly exhaust: (reason: RequestBudgetReason) => SkillsError
    readonly snapshot: Effect.Effect<{
      readonly limits: RequestBudgetLimits
      readonly attempts: number
      readonly request_bytes: number
      readonly response_bytes: number
      readonly elapsed_ms: number
      readonly exhausted: RequestBudgetReason | null
      readonly byte_overshoot: number
      readonly byte_policy: "finish_admitted_response"
      readonly byte_units: "payload_bytes_excluding_http_tls_framing"
      readonly maximum_in_flight: 1
    }>
  }
>()("ntn-skills/RequestBudget") {}

export function makeRequestBudget(identity: string, limits: RequestBudgetLimits) {
  return Effect.gen(function* () {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value <= 0)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Request budgets must be positive safe integers.", {
            budget: name,
          }),
        )
    const started = yield* Clock.monotonicTimeNanos
    const deadline = started + BigInt(limits.duration_ms) * 1_000_000n
    const permits = yield* Semaphore.make(1)
    let attempts = 0
    let requestBytes = 0
    let responseBytes = 0
    let exhausted: RequestBudgetReason | null = null
    const exhaust = (reason: RequestBudgetReason) => {
      exhausted = reason
      return fail("REQUEST_BUDGET_EXHAUSTED", "The request invocation budget is exhausted.", {
        reason,
        attempts,
        request_bytes: requestBytes,
        response_bytes: responseBytes,
      })
    }
    const check = Effect.gen(function* () {
      if ((yield* Clock.monotonicTimeNanos) >= deadline)
        return yield* Effect.fail(exhaust("duration"))
      if (attempts >= limits.requests) return yield* Effect.fail(exhaust("requests"))
      if (requestBytes + responseBytes >= limits.bytes) return yield* Effect.fail(exhaust("bytes"))
    })
    return {
      identity,
      deadline,
      check,
      withPermit: permits.withPermits(1),
      admit: (bytes: number) =>
        Effect.gen(function* () {
          yield* check
          if (Math.max(0, bytes) > limits.bytes - requestBytes - responseBytes)
            return yield* Effect.fail(exhaust("bytes"))
          // No asynchronous action occurs between checking and spending.
          attempts += 1
          requestBytes += Math.max(0, bytes)
        }),
      responseBytes: (delta: number) => {
        responseBytes += Math.max(0, delta)
      },
      exhaust,
      snapshot: Effect.gen(function* () {
        return {
          limits,
          attempts,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          elapsed_ms: Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000,
          exhausted,
          byte_overshoot: Math.max(0, requestBytes + responseBytes - limits.bytes),
          byte_policy: "finish_admitted_response" as const,
          byte_units: "payload_bytes_excluding_http_tls_framing" as const,
          maximum_in_flight: 1 as const,
        }
      }),
    } satisfies RequestBudget["Service"]
  })
}

/** Includes an admitted response (and any wrapped permit wait) in the same
 * invocation deadline. Transport owners still classify an uncertain write. */
export function withinRequestBudget<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budget: RequestBudget["Service"],
) {
  return Effect.gen(function* () {
    const remaining = Number(budget.deadline - (yield* Clock.monotonicTimeNanos)) / 1_000_000
    if (remaining <= 0) return yield* Effect.fail(budget.exhaust("duration"))
    return yield* effect.pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () => Effect.fail(budget.exhaust("duration")),
      }),
    )
  })
}
