import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, Duration, Effect, Fiber, FileSystem, Queue } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { type SkillsError } from "../src/model.ts"
import {
  makeSqliteRequestScheduler,
  NOTION_ADMISSION_BUDGET_MS,
  type NotionRequestScheduler,
} from "../src/notion-request-scheduler.ts"

const credential = "a".repeat(64)
const deadline = Clock.monotonicTimeNanos.pipe(
  Effect.map((now) => now + BigInt(NOTION_ADMISSION_BUDGET_MS) * 1_000_000n),
)

function withSchedulers<A>(
  use: (fixture: {
    readonly first: NotionRequestScheduler["Service"]
    readonly second: NotionRequestScheduler["Service"]
    readonly clock: TestClock.TestClock
    readonly sleeps: Queue.Queue<number>
  }) => Effect.Effect<A, SkillsError>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "notion-request-scheduler-" })
      const clock = yield* TestClock.make()
      const sleeps = yield* Queue.unbounded<number>()
      const observedClock: Clock.Clock = {
        ...clock,
        sleep: (duration) =>
          Effect.gen(function* () {
            yield* Queue.offer(sleeps, Duration.toMillis(duration))
            yield* clock.sleep(duration)
          }),
      }
      return yield* Effect.gen(function* () {
        // Each constructor owns a separate SQLite connection and local queue.
        const first = yield* makeSqliteRequestScheduler(directory)
        const second = yield* makeSqliteRequestScheduler(directory)
        return yield* use({ first, second, clock, sleeps })
      }).pipe(Effect.provideService(Clock.Clock, observedClock))
    }),
  ).pipe(Effect.provide(NodeServices.layer))
}

test("independent SQLite scheduler instances admit only one shared credential per interval", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock, sleeps }) =>
      Effect.gen(function* () {
        yield* first.acquire(credential, yield* deadline)
        const next = yield* Effect.forkChild(
          second.acquire(credential, yield* deadline).pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        expect(yield* Queue.take(sleeps)).toBe(350)
        yield* clock.adjust(349)
        expect(next.pollUnsafe()).toBeUndefined()
        yield* clock.adjust(1)
        expect(yield* Fiber.join(next)).toBe(350)

        // A different credential has a separate rate budget, even in the same file.
        yield* first.acquire("b".repeat(64), yield* deadline)
        const third = yield* Effect.forkChild(
          first.acquire(credential, yield* deadline).pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        expect(yield* Queue.take(sleeps)).toBe(350)
        yield* clock.adjust(350)
        expect(yield* Fiber.join(third)).toBe(700)
      }),
    ),
  )
})

test("shared cooldowns only extend and are rechecked before a waiting process claims a slot", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock, sleeps }) =>
      Effect.gen(function* () {
        yield* first.cooldown(credential, 90_000)
        yield* second.cooldown(credential, 60_000)
        const waiting = yield* Effect.forkChild(
          second.acquire(credential, yield* deadline).pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        expect(yield* Queue.take(sleeps)).toBe(30_000)
        yield* clock.adjust(60_000)
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* first.cooldown(credential, 60_000)
        yield* clock.adjust(59_999)
        expect(waiting.pollUnsafe()).toBeUndefined()
        yield* clock.adjust(1)
        expect(yield* Fiber.join(waiting)).toBe(120_000)
      }),
    ),
  )
})

test("cancelling admission leaves no future SQLite reservation", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock, sleeps }) =>
      Effect.gen(function* () {
        yield* first.acquire(credential, yield* deadline)
        const cancelled = yield* Effect.forkChild(second.acquire(credential, yield* deadline), {
          startImmediately: true,
        })
        expect(yield* Queue.take(sleeps)).toBe(350)
        yield* Fiber.interrupt(cancelled)
        yield* clock.adjust(100)
        const survivor = yield* Effect.forkChild(
          second.acquire(credential, yield* deadline).pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        expect(yield* Queue.take(sleeps)).toBe(250)
        yield* clock.adjust(250)
        expect(yield* Fiber.join(survivor)).toBe(350)
      }),
    ),
  )
})

test("over-budget cooldowns survive new scheduler instances and never consume a slot", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock }) =>
      Effect.gen(function* () {
        yield* first.cooldown(credential, 600_000)
        const refused = yield* second.acquire(credential, yield* deadline).pipe(Effect.result)
        expect(refused._tag).toBe("Failure")
        if (refused._tag !== "Failure") throw new Error("Expected bounded admission refusal")
        expect(refused.failure.code).toBe("RATE_LIMITED")
        expect(refused.failure.details).toMatchObject({
          phase: "input_rejected",
          retry_after_seconds: 600,
        })
        yield* clock.adjust(600_000)
        yield* first.acquire(credential, yield* deadline)
        expect(yield* Clock.currentTimeMillis).toBe(600_000)
        yield* first.cooldown(credential, 1e308 * 1_000)
        const enormous = yield* second.acquire(credential, yield* deadline).pipe(Effect.result)
        expect(enormous._tag === "Failure" && enormous.failure.code).toBe("RATE_LIMITED")
      }),
    ),
  )
})
