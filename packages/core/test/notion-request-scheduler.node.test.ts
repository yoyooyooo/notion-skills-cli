import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, Duration, Effect, Fiber, FileSystem, Queue, Semaphore } from "effect"
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
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "notion-request-scheduler-" })
      const directory = yield* fs.realPath(temporary)
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
        expect(yield* Queue.take(sleeps)).toBeLessThanOrEqual(1_000)
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
        let actualWait = 0
        const cancelled = yield* Effect.forkChild(
          second.acquire(credential, yield* deadline, {
            onWait: (started, ended) => {
              actualWait += Number(ended - started) / 1_000_000
            },
          }),
          {
            startImmediately: true,
          },
        )
        expect(yield* Queue.take(sleeps)).toBe(350)
        yield* clock.adjust(100)
        yield* Fiber.interrupt(cancelled)
        expect(actualWait).toBe(100)
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
        let actualWait = 0
        const refused = yield* second
          .acquire(credential, yield* deadline, {
            onWait: (started, ended) => {
              actualWait += Number(ended - started) / 1_000_000
            },
          })
          .pipe(Effect.result)
        expect(refused._tag).toBe("Failure")
        if (refused._tag !== "Failure") throw new Error("Expected bounded admission refusal")
        expect(refused.failure.code).toBe("RATE_LIMITED")
        expect(actualWait).toBe(0)
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

test("queue budget expires while every network permit is occupied and creates no future send", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, clock, sleeps }) =>
      Effect.gen(function* () {
        const permits = yield* Semaphore.make(0)
        let sends = 0
        const waiting = yield* Effect.forkChild(
          first
            .withAdmission(
              credential,
              yield* deadline,
              permits,
              Effect.sync(() => {
                sends += 1
              }),
              { queueBudgetMs: 50 },
            )
            .pipe(Effect.result),
          { startImmediately: true },
        )
        yield* Queue.take(sleeps)
        yield* clock.adjust(50)
        const result = yield* Fiber.join(waiting)
        expect(result._tag === "Failure" && result.failure.details).toMatchObject({
          deferred: true,
          budget: "queue",
        })
        expect(sends).toBe(0)
        yield* first.acquire(credential, yield* deadline)
        expect(yield* Clock.currentTimeMillis).toBe(50)
      }),
    ),
  )
})

test("old prefetch requests age into the foreground queue and cannot starve", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock, sleeps }) =>
      Effect.gen(function* () {
        yield* first.cooldown(credential, 31_000)
        const prefetch = yield* Effect.forkChild(
          first
            .acquire(credential, yield* deadline, { priority: "prefetch" })
            .pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        yield* Queue.take(sleeps)
        yield* clock.adjust(30_000)
        yield* Queue.takeAll(sleeps)
        const foreground = yield* Effect.forkChild(
          second
            .acquire(credential, yield* deadline, { priority: "foreground" })
            .pipe(Effect.andThen(Clock.currentTimeMillis)),
          { startImmediately: true },
        )
        yield* Queue.take(sleeps)
        yield* clock.adjust(1_000)
        expect(yield* Fiber.join(prefetch)).toBe(31_000)
        expect(foreground.pollUnsafe()).toBeUndefined()
        yield* clock.adjust(350)
        expect(yield* Fiber.join(foreground)).toBe(31_350)
      }),
    ),
  )
})

test("an aged prefetch blocked on its own network capacity cannot block another process", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock, sleeps }) =>
      Effect.gen(function* () {
        const permits = yield* Semaphore.make(0)
        const prefetch = yield* Effect.forkChild(
          first.withAdmission(credential, yield* deadline, permits, Effect.void, {
            priority: "prefetch",
          }),
          { startImmediately: true },
        )
        yield* Queue.take(sleeps)
        yield* clock.adjust(31_000)
        yield* second.acquire(credential, yield* deadline, { priority: "foreground" })
        expect(yield* Clock.currentTimeMillis).toBe(31_000)
        expect(prefetch.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(prefetch)
      }),
    ),
  )
})

test("endpoint throttles stay local and unknown reasons conservatively cool the shared workspace", async () => {
  await Effect.runPromise(
    withSchedulers(({ first, second, clock }) =>
      Effect.gen(function* () {
        const scope = {
          apiOrigin: "https://api.notion.com",
          connection: "connection-a",
          workspace: "workspace-a",
          endpoint: "POST data-source-query",
        }
        yield* first.cooldown(credential, 5_000, {
          ...scope,
          reason: "public_api_endpoint_rate_limit",
        })
        yield* second.acquire(credential, yield* deadline, { ...scope, endpoint: "GET page" })
        expect(yield* Clock.currentTimeMillis).toBe(0)
        const endpoint = yield* second
          .acquire(credential, yield* deadline, { ...scope, queueBudgetMs: 100 })
          .pipe(Effect.result)
        expect(endpoint._tag === "Failure" && endpoint.failure.details).toMatchObject({
          deferred: true,
          retry_after_seconds: 5,
        })
        yield* first.cooldown(credential, 10_000, { ...scope, reason: "future_unknown_reason" })
        const shared = yield* second
          .acquire("different", yield* deadline, {
            ...scope,
            connection: "connection-b",
            queueBudgetMs: 100,
          })
          .pipe(Effect.result)
        expect(shared._tag === "Failure" && shared.failure.details).toMatchObject({
          deferred: true,
          retry_after_seconds: 10,
        })
        yield* second.acquire("independent", yield* deadline, {
          ...scope,
          connection: "connection-c",
          workspace: "workspace-c",
        })
        expect(yield* Clock.currentTimeMillis).toBe(0)
        yield* clock.adjust(10_000)
        yield* first.acquire(credential, yield* deadline, scope)
      }),
    ),
  )
})
