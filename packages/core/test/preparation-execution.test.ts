import { expect, test } from "bun:test"
import { Clock, Effect, Fiber, Latch } from "effect"
import { TestClock } from "effect/testing"
import {
  normalizePrepareExecution,
  prepareRequestPolicy,
  withPrepareExecution,
} from "../src/preparation-execution.ts"

test("foreground preparation has no implicit prefetch time or rate policy", () => {
  expect(normalizePrepareExecution()).toEqual({ priority: "required" })
  expect(prepareRequestPolicy(normalizePrepareExecution({ priority: "prefetch" }))).toEqual({
    priority: "prefetch",
    queueBudgetMs: 1000,
    rateShare: 0.1,
  })
  expect(() => normalizePrepareExecution({ rateShare: 0.1 })).toThrow()
  expect(() => normalizePrepareExecution({ priority: "prefetch", rateShare: 0 })).toThrow()
  expect(() => normalizePrepareExecution({ priority: "prefetch", timeBudgetMs: 0 })).toThrow()
})

test("the preparation time budget interrupts its owned work without publishing a late value", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const started = yield* Latch.make(false)
        let interrupted = false,
          published = false
        yield* Effect.gen(function* () {
          const operation = yield* Effect.forkChild(
            withPrepareExecution(
              Effect.gen(function* () {
                yield* started.open
                yield* Effect.never
                published = true
                return "late"
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    interrupted = true
                  }),
                ),
              ),
              normalizePrepareExecution({ priority: "prefetch", timeBudgetMs: 50 }),
            ).pipe(Effect.result),
            { startImmediately: true },
          )
          yield* started.await
          yield* clock.adjust(50)
          const result = yield* Fiber.join(operation)
          expect(result._tag === "Failure" && result.failure.code).toBe("PREPARE_TIME_BUDGET")
          expect(interrupted).toBe(true)
          expect(published).toBe(false)
        }).pipe(Effect.provideService(Clock.Clock, clock))
      }),
    ),
  )
})
