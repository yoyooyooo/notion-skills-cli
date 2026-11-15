import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { fail } from "../src/model.ts"
import { makeBoundedImmutableReadCoalescer } from "../src/shared-immutable-read.ts"

const fork = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true })

test("immutable readers share only while pending and a creator cancellation preserves its survivor", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const shared = yield* makeBoundedImmutableReadCoalescer<number>({ entries: 2, bytes: 10 })
      const gate = yield* Deferred.make<void>()
      let calls = 0,
        finalized = 0
      const execute = Effect.sync(() => ++calls).pipe(
        Effect.flatMap((value) => Deferred.await(gate).pipe(Effect.as(value))),
        Effect.ensuring(
          Effect.sync(() => {
            finalized += 1
          }),
        ),
      )
      const first = yield* fork(shared.run("exact", 5, execute))
      const second = yield* fork(shared.run("exact", 5, execute))
      expect(calls).toBe(1)
      yield* Fiber.interrupt(first)
      expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
      expect(finalized).toBe(0)
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(second)).toBe(1)
      expect(finalized).toBe(1)
      expect(yield* shared.run("exact", 5, execute)).toBe(2)
    }),
  )
})

test.each([
  { entries: 1, bytes: 100 },
  { entries: 100, bytes: 5 },
])("admission bounds new shared producers and releases their capacity (%o)", async (limits) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const shared = yield* makeBoundedImmutableReadCoalescer<number>(limits)
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const execute = Effect.sync(() => ++calls).pipe(
        Effect.flatMap((value) => Deferred.await(gate).pipe(Effect.as(value))),
      )
      const admitted = yield* fork(shared.run("first", 5, execute))
      const joined = yield* fork(shared.run("first", 5, execute))
      const excess = yield* fork(shared.run("second", 5, execute))
      const separate = yield* fork(shared.run("second", 5, execute))
      expect(calls).toBe(3)
      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.joinAll([admitted, joined, excess, separate])).toEqual([1, 1, 2, 3])
      const nextGate = yield* Deferred.make<void>()
      const next = Effect.sync(() => ++calls).pipe(
        Effect.flatMap((value) => Deferred.await(nextGate).pipe(Effect.as(value))),
      )
      const one = yield* fork(shared.run("second", 5, next))
      const two = yield* fork(shared.run("second", 5, next))
      expect(calls).toBe(4)
      yield* Deferred.succeed(nextGate, undefined)
      expect(yield* Fiber.joinAll([one, two])).toEqual([4, 4])
    }),
  )
})

test("a cancelled producer holds its capacity through cleanup but cannot attract new waiters", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const shared = yield* makeBoundedImmutableReadCoalescer<string>({ entries: 1, bytes: 5 })
      const cleanupStarted = yield* Deferred.make<void>()
      const allowCleanup = yield* Deferred.make<void>()
      const original = yield* fork(
        shared.run(
          "same",
          5,
          Effect.never.pipe(
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowCleanup)),
              ),
            ),
          ),
        ),
      )
      const cancelling = yield* fork(Fiber.interrupt(original))
      yield* Deferred.await(cleanupStarted)
      const freshGate = yield* Deferred.make<void>()
      let freshCalls = 0
      const execute = Effect.sync(() => ++freshCalls).pipe(
        Effect.andThen(Deferred.await(freshGate)),
        Effect.as("fresh"),
      )
      const first = yield* fork(shared.run("same", 5, execute))
      const second = yield* fork(shared.run("same", 5, execute))
      expect(freshCalls).toBe(2)
      yield* Deferred.succeed(allowCleanup, undefined)
      yield* Fiber.join(cancelling)
      yield* Deferred.succeed(freshGate, undefined)
      expect(yield* Fiber.joinAll([first, second])).toEqual(["fresh", "fresh"])
      expect(yield* shared.run("same", 5, Effect.succeed("after-cleanup"))).toBe("after-cleanup")
    }),
  )
})

test("failed immutable reads release their entry and do not cache failure", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const shared = yield* makeBoundedImmutableReadCoalescer<string>({ entries: 1, bytes: 5 })
      const rejected = yield* shared
        .run("same", 5, Effect.fail(fail("TEST_READ_FAILED", "Controlled failure")))
        .pipe(Effect.result)
      expect(rejected._tag).toBe("Failure")
      expect(yield* shared.run("same", 5, Effect.succeed("retry"))).toBe("retry")
    }),
  )
})
