import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { fail, type SkillsError } from "../src/model.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import {
  isCoalescibleNotionRead,
  makeSharedReadCoalescer,
  type SharedReadRequest,
} from "../src/shared-read-coalescing.ts"

const page = "00000000-0000-4000-8000-000000000001"
const read: SharedReadRequest = {
  key: "credential-and-request-digest",
  path: `v1/pages/${page}`,
  method: "GET",
}
const fork = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true })
function attempt<A>(
  metrics: ReturnType<typeof createRequestMetrics>,
  request: SharedReadRequest,
  execute: Effect.Effect<A, SkillsError>,
) {
  return Effect.gen(function* () {
    const finish = metrics.begin({
      path: request.path,
      method: request.method,
      key: request.key,
      content: request.content,
      requestBytes: 0,
    })
    return yield* execute.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() =>
          finish({
            outcome: Exit.isSuccess(exit)
              ? "success"
              : Exit.hasInterrupts(exit)
                ? "cancelled"
                : "failure",
            ...(Exit.isSuccess(exit) ? { responseBytes: 1 } : {}),
          }),
        ),
      ),
    )
  })
}

describe("shared Notion read coalescing", () => {
  test("concurrent equal reads share one transport attempt and count only the join", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const gate = yield* Deferred.make<void>()
        const execute = attempt(
          metrics,
          read,
          Deferred.await(gate).pipe(Effect.as({ result: "same" })),
        )
        const first = yield* fork(coalescer.run(read, execute))
        const second = yield* fork(coalescer.run(read, execute))
        expect(metrics.snapshot().total_requests).toBe(1)
        expect(metrics.snapshot().coalesced_requests).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.joinAll([first, second])).toEqual([
          { result: "same" },
          { result: "same" },
        ])
        expect(metrics.snapshot().outcomes).toEqual({ success: 1, failure: 0, cancelled: 0 })
        expect(metrics.snapshot().duplicate_requests).toBe(0)
      }),
    )
  })

  test.each(["creator", "joiner"] as const)(
    "cancelling the %s leaves the other waiter and producer alive",
    async (cancel) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const metrics = createRequestMetrics()
          const coalescer = yield* makeSharedReadCoalescer(metrics)
          const gate = yield* Deferred.make<void>()
          const execute = attempt(metrics, read, Deferred.await(gate).pipe(Effect.as("finished")))
          const creator = yield* fork(coalescer.run(read, execute))
          const joiner = yield* fork(coalescer.run(read, execute))
          const cancelled = cancel === "creator" ? creator : joiner
          const survivor = cancel === "creator" ? joiner : creator
          yield* Fiber.interrupt(cancelled)
          expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true)
          expect(metrics.snapshot().in_flight).toBe(1)
          expect(metrics.snapshot().outcomes.cancelled).toBe(0)
          yield* Deferred.succeed(gate, undefined)
          expect(yield* Fiber.join(survivor)).toBe("finished")
          expect(metrics.snapshot().total_requests).toBe(1)
          expect(metrics.snapshot().coalesced_requests).toBe(1)
        }),
      )
    },
  )

  test("the last cancelled waiter stops its producer and the same key can start again", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const execute = attempt(metrics, read, Effect.never)
        const first = yield* fork(coalescer.run(read, execute))
        const second = yield* fork(coalescer.run(read, execute))
        yield* Fiber.interrupt(first)
        expect(metrics.snapshot().in_flight).toBe(1)
        yield* Fiber.interrupt(second)
        expect(metrics.snapshot().in_flight).toBe(0)
        expect(metrics.snapshot().outcomes.cancelled).toBe(1)
        expect(yield* coalescer.run(read, attempt(metrics, read, Effect.succeed("new")))).toBe(
          "new",
        )
        expect(metrics.snapshot().total_requests).toBe(2)
      }),
    )
  })

  test("an abandoned producer's slow finalizer cannot delete or attract waiters for its replacement", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const cleanupStarted = yield* Deferred.make<void>()
        const allowCleanup = yield* Deferred.make<void>()
        const allowReplacement = yield* Deferred.make<void>()
        const old = attempt(
          metrics,
          read,
          Effect.never.pipe(
            Effect.ensuring(
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowCleanup)),
              ),
            ),
          ),
        )
        const original = yield* fork(coalescer.run(read, old))
        const cancelling = yield* fork(Fiber.interrupt(original))
        yield* Deferred.await(cleanupStarted)
        const fresh = attempt(
          metrics,
          read,
          Deferred.await(allowReplacement).pipe(Effect.as("replacement")),
        )
        const one = yield* fork(coalescer.run(read, fresh))
        const two = yield* fork(coalescer.run(read, fresh))
        expect(metrics.snapshot().total_requests).toBe(2)
        yield* Deferred.succeed(allowCleanup, undefined)
        yield* Fiber.join(cancelling)
        const three = yield* fork(coalescer.run(read, fresh))
        expect(metrics.snapshot().total_requests).toBe(2)
        expect(metrics.snapshot().coalesced_requests).toBe(2)
        yield* Deferred.succeed(allowReplacement, undefined)
        expect(yield* Fiber.joinAll([one, two, three])).toEqual([
          "replacement",
          "replacement",
          "replacement",
        ])
        expect(metrics.snapshot().outcomes).toEqual({ success: 1, failure: 0, cancelled: 1 })
      }),
    )
  })

  test("failed lookups are shared only while pending and are immediately retryable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const gate = yield* Deferred.make<void>()
        const rejected = attempt(
          metrics,
          read,
          Deferred.await(gate).pipe(
            Effect.andThen(Effect.fail(fail("READ_FAILED", "Controlled failure"))),
          ),
        )
        const one = yield* fork(coalescer.run(read, rejected).pipe(Effect.result))
        const two = yield* fork(coalescer.run(read, rejected).pipe(Effect.result))
        yield* Deferred.succeed(gate, undefined)
        const failures = yield* Fiber.joinAll([one, two])
        expect(
          failures.every(
            (result) => result._tag === "Failure" && result.failure.code === "READ_FAILED",
          ),
        ).toBe(true)
        expect(
          yield* coalescer.run(read, attempt(metrics, read, Effect.succeed("recovered"))),
        ).toBe("recovered")
        expect(metrics.snapshot().total_requests).toBe(2)
        expect(metrics.snapshot().outcomes).toEqual({ success: 1, failure: 1, cancelled: 0 })
      }),
    )
  })

  test("completed success is never reused as a response cache", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const coalescer = yield* makeSharedReadCoalescer()
        let calls = 0
        const execute = Effect.sync(() => ++calls)
        expect(yield* coalescer.run(read, execute)).toBe(1)
        expect(yield* coalescer.run(read, execute)).toBe(2)
      }),
    )
  })

  test("credential/body identity, path and body classification separate pending lookups", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const gate = yield* Deferred.make<void>()
        const requests: readonly SharedReadRequest[] = [
          read,
          { ...read, key: "another-credential-or-body-digest" },
          { ...read, path: `${read.path}/markdown` },
          { ...read, content: "body" },
        ]
        const fibers = yield* Effect.forEach(requests, (request) =>
          fork(coalescer.run(request, attempt(metrics, request, Deferred.await(gate)))),
        )
        expect(metrics.snapshot().total_requests).toBe(requests.length)
        expect(metrics.snapshot().coalesced_requests).toBe(0)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll(fibers)
      }),
    )
  })

  test("separate service instances never share an in-flight request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const one = yield* makeSharedReadCoalescer(metrics)
        const two = yield* makeSharedReadCoalescer(metrics)
        const gate = yield* Deferred.make<void>()
        const execute = attempt(metrics, read, Deferred.await(gate))
        const first = yield* fork(one.run(read, execute))
        const second = yield* fork(two.run(read, execute))
        expect(metrics.snapshot().total_requests).toBe(2)
        expect(metrics.snapshot().coalesced_requests).toBe(0)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll([first, second])
      }),
    )
  })

  const queryPaths = ["v1/search", `v1/data_sources/${page}/query`, `v1/views/${page}/queries`]
  test.each(queryPaths)("read-only POST %s shares its pending query", async (path) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const request: SharedReadRequest = { ...read, path, method: "POST" }
        expect(isCoalescibleNotionRead(request)).toBe(true)
        const gate = yield* Deferred.make<void>()
        const execute = attempt(metrics, request, Deferred.await(gate))
        const one = yield* fork(coalescer.run(request, execute))
        const two = yield* fork(coalescer.run(request, execute))
        expect(metrics.snapshot().total_requests).toBe(1)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll([one, two])
      }),
    )
  })

  const excluded: readonly SharedReadRequest[] = [
    { ...read, path: "v1/pages", method: "POST" },
    { ...read, method: "PATCH" },
    { ...read, path: "v1/search", method: "PATCH" },
    { ...read, path: `v1/data_sources/${page}/query`, method: "PATCH" },
    { ...read, path: "v1/unknown/query", method: "POST" },
    { ...read, path: "v1/data_sources/not-a-source/query", method: "POST" },
    { ...read, file: "/tmp/request-body.json" },
    { ...read, key: "" },
  ]
  test.each(excluded)("excluded request is never coalesced: %j", async (request) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        expect(isCoalescibleNotionRead(request)).toBe(false)
        const gate = yield* Deferred.make<void>()
        const execute = attempt(metrics, request, Deferred.await(gate))
        const one = yield* fork(coalescer.run(request, execute))
        const two = yield* fork(coalescer.run(request, execute))
        expect(metrics.snapshot().total_requests).toBe(2)
        expect(metrics.snapshot().coalesced_requests).toBe(0)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.joinAll([one, two])
      }),
    )
  })

  test("all callers cancelled during admission consume no transport attempt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const admission = yield* Deferred.make<void>()
        const queued = Deferred.await(admission).pipe(
          Effect.andThen(attempt(metrics, read, Effect.succeed("admitted"))),
        )
        const one = yield* fork(coalescer.run(read, queued))
        const two = yield* fork(coalescer.run(read, queued))
        expect(metrics.snapshot().total_requests).toBe(0)
        yield* Fiber.interrupt(one)
        yield* Fiber.interrupt(two)
        yield* Deferred.succeed(admission, undefined)
        expect(metrics.snapshot().total_requests).toBe(0)
        expect(yield* coalescer.run(read, queued)).toBe("admitted")
        expect(metrics.snapshot().total_requests).toBe(1)
      }),
    )
  })

  test("the full retry chain is shared, while every actual attempt remains counted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const metrics = createRequestMetrics()
        const coalescer = yield* makeSharedReadCoalescer(metrics)
        const retry = yield* Deferred.make<void>()
        const chain = Effect.gen(function* () {
          yield* attempt(
            metrics,
            read,
            Effect.fail(fail("RETRY", "Controlled transient failure")),
          ).pipe(Effect.result)
          yield* Deferred.await(retry)
          return yield* attempt(metrics, read, Effect.succeed("second attempt"))
        })
        const one = yield* fork(coalescer.run(read, chain))
        const two = yield* fork(coalescer.run(read, chain))
        expect(metrics.snapshot().total_requests).toBe(1)
        yield* Deferred.succeed(retry, undefined)
        expect(yield* Fiber.joinAll([one, two])).toEqual(["second attempt", "second attempt"])
        expect(metrics.snapshot().total_requests).toBe(2)
        expect(metrics.snapshot().coalesced_requests).toBe(1)
        expect(metrics.snapshot().outcomes).toEqual({ success: 1, failure: 1, cancelled: 0 })
      }),
    )
  })
})
