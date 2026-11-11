import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Queue,
  Random,
  Stream,
} from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { NotionCredentialProviderLive } from "../src/notion-credential.ts"
import { TestClock } from "effect/testing"
import { decode, property, SkillsError } from "../src/model.ts"
import { Notion, NotionTransport, withNotionRequestAttribution } from "../src/notion.ts"
import {
  makeRequestScheduler,
  NOTION_ADMISSION_BUDGET_MS,
  NotionRequestScheduler,
  type RequestScheduleState,
} from "../src/notion-request-scheduler.ts"
import { configuredToken, Store } from "../src/store.ts"

const store = Layer.succeed(Store, {
  integrity: integrityRepositoryFixture(),
  upstream: upstreamRepositoryFixture(),
  registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
  advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
  backup: () => Effect.die(new Error("Unexpected backup")),
  root: "/notion-test",
  configRoot: "/notion-test",
  cacheRoot: "/notion-test",
  reserveCacheGeneration: (() => {
    let generation = 0
    return () => Effect.sync(() => ++generation)
  })(),
  listKeys: () => Effect.succeed([]),
  retireKeys: () => Effect.succeed([]),
  readJson: (_key, schema) =>
    Effect.sync(() => decode(schema, { token: "sensitive-fixture-token" })),
  writeJson: () => Effect.void,
  readBytes: () => Effect.succeed(new Uint8Array()),
  writeBytes: () => Effect.void,
  output: () => Effect.succeed({ output: "", reused: false }),
})

// Bun transport tests use the same scheduler over an atomic memory driver.
// The Node scheduler suite exercises two real SQLite connections to one temp file.
function memoryScheduleState(): RequestScheduleState {
  const rows = new Map<string, { next: number; cooldown: number }>()
  return {
    claim: (credential, now, interval) =>
      Effect.sync(() => {
        const row = rows.get(credential) ?? { next: 0, cooldown: 0 }
        const at = Math.max(row.next, row.cooldown)
        if (now < at) return { admitted: false, at } as const
        rows.set(credential, { ...row, next: now + interval })
        return { admitted: true } as const
      }),
    defer: (credential, until) =>
      Effect.sync(() => {
        const row = rows.get(credential) ?? { next: 0, cooldown: 0 }
        rows.set(credential, { ...row, cooldown: Math.max(row.cooldown, until) })
      }),
  }
}

type Start = { readonly path: string; readonly attempt: number; readonly millis: number }
type Response = {
  readonly text?: string
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly networkError?: string
  readonly bodyWait?: Effect.Effect<void>
  readonly wait?: Effect.Effect<void>
}

test("filtered metadata POST queries retain read-only failure semantics", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        text: JSON.stringify({ object: "error", code: "conflict_error", status: 409 }),
      }),
      ({ api, starts }) =>
        Effect.gen(function* () {
          const result = yield* api
            .request(
              "v1/data_sources/00000000-0000-4000-8000-000000000001/query?filter_properties=title",
              {},
            )
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw Error("Expected request failure")
          expect(result.failure.code).toBe("NOTION_REQUEST_FAILED")
          expect(starts).toHaveLength(1)
        }),
    ),
  )
})

test("prefetch refuses mutations before HTTP but accepts read-only metadata POSTs", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({ text: JSON.stringify({ results: [] }) }),
      ({ api, starts }) =>
        Effect.gen(function* () {
          const denied = yield* api
            .request("v1/pages", { parent: {} }, { priority: "prefetch" })
            .pipe(Effect.result)
          expect(denied._tag === "Failure" && denied.failure.code).toBe(
            "NOTION_PREFETCH_WRITE_FORBIDDEN",
          )
          expect(starts).toHaveLength(0)
          yield* api.request(
            "v1/data_sources/00000000-0000-4000-8000-000000000001/query",
            {},
            { priority: "prefetch" },
          )
          expect(starts).toHaveLength(1)
        }),
    ),
  )
})

test("prefetch exits after one 429 or 529 and preserves the shared server cooldown", async () => {
  for (const status of [429, 529])
    await Effect.runPromise(
      withClockedNotion(
        () => ({
          status,
          headers: { "retry-after": "2" },
          text: JSON.stringify({
            object: "error",
            status,
            code: "rate_limited",
            message: "Controlled service pressure",
          }),
        }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request("v1/pages/pressure", undefined, { priority: "prefetch" })
              .pipe(Effect.result)
            expect(result._tag === "Failure" && result.failure.details).toMatchObject({
              deferred: true,
              reason: "prefetch_service_pressure",
              http_status: status,
              retry_after_seconds: 2,
            })
            expect(starts).toHaveLength(1)
            const foreground = yield* api
              .request("v1/pages/later", undefined, { queueBudgetMs: 100 })
              .pipe(Effect.result)
            expect(foreground._tag === "Failure" && foreground.failure.code).toBe("RATE_LIMITED")
            expect(starts).toHaveLength(1)
          }),
      ),
    )
})

test("a structured public_api_request_blocked response is never retried", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        text: JSON.stringify({
          object: "error",
          code: "rate_limited",
          status: 429,
          additional_data: { rate_limit_reason: "public_api_request_blocked", retry_after: 60 },
        }),
      }),
      ({ api, starts }) =>
        Effect.gen(function* () {
          const result = yield* api.request("v1/pages/example").pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw Error("Expected request failure")
          expect(result.failure.details).toMatchObject({
            rate_limit_reason: "public_api_request_blocked",
          })
          expect(starts).toHaveLength(1)
        }),
    ),
  )
})

// Exercise the real Notion Layer and public request API, replacing only process IO
// and Effect's Clock. Queues rendezvous at observable starts and registered sleeps.
function withClockedNotion<A>(
  respond: (start: Start) => Response,
  use: (fixture: {
    readonly api: Notion["Service"]
    readonly peer: Notion["Service"]
    readonly clock: TestClock.TestClock
    readonly starts: Start[]
    readonly started: Queue.Queue<Start>
    readonly sleeps: Queue.Queue<number>
  }) => Effect.Effect<A, SkillsError>,
  timeoutMs = 60_000,
  concurrency?: string,
  traceLimit = 0,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const started = yield* Queue.unbounded<Start>()
      const sleeps = yield* Queue.unbounded<number>()
      const starts: Start[] = []
      const attempts = new Map<string, number>()
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const path = url.pathname.slice(1) + url.search
          const attempt = (attempts.get(path) ?? 0) + 1
          attempts.set(path, attempt)
          const millis = Number(yield* Clock.monotonicTimeNanos) / 1_000_000
          const start = { path, attempt, millis }
          starts.push(start)
          const response = respond(start)
          yield* Queue.offer(started, start)
          yield* response.wait ?? Effect.void
          if (response.networkError !== undefined)
            return yield* Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error(response.networkError),
                }),
              }),
            )
          const text = response.text ?? JSON.stringify({ object: "page", id: path })
          let status = response.status
          if (status === undefined) {
            try {
              const reported = property(JSON.parse(text)).status
              if (typeof reported === "number") status = reported
            } catch {}
          }
          const stream = Stream.unwrap(
            Effect.as(
              response.bodyWait ?? Effect.void,
              Stream.make(new TextEncoder().encode(text)),
            ),
          )
          const body = yield* Stream.toReadableStreamEffect(stream)
          return HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: status ?? 200,
              headers: { "content-type": "application/json", ...response.headers },
            }),
          )
        }),
      )
      const observedClock: Clock.Clock = {
        ...clock,
        sleep: (duration) =>
          Effect.gen(function* () {
            const millis = Duration.toMillis(duration)
            // Deadline guards are observed by their outcomes, not as scheduling
            // sleeps. Keep the actual admission and retry waits in this queue.
            if (millis !== timeoutMs && millis !== NOTION_ADMISSION_BUDGET_MS)
              yield* Queue.offer(sleeps, millis)
            yield* clock.sleep(duration)
          }),
      }
      const scheduleState = memoryScheduleState()
      const layer = NotionTransport.pipe(
        Layer.provide(NotionCredentialProviderLive),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              NTN_SKILLS_REQUEST_TIMEOUT_MS: String(timeoutMs),
              NTN_SKILLS_REQUEST_TRACE_LIMIT: String(traceLimit),
              ...(concurrency === undefined ? {} : { NTN_SKILLS_NOTION_CONCURRENCY: concurrency }),
            }),
          ),
        ),
        Layer.provide(Layer.effect(NotionRequestScheduler, makeRequestScheduler(scheduleState))),
        Layer.provide(Layer.merge(store, Layer.succeed(HttpClient.HttpClient, client))),
      )
      return yield* Effect.gen(function* () {
        const api = yield* Effect.provide(Notion, layer)
        const peer = yield* Effect.provide(Notion, layer)
        return yield* use({ api, peer, clock, starts, started, sleeps })
      }).pipe(
        Effect.provideService(Clock.Clock, observedClock),
        // Retry boundaries below advance the TestClock by exact values. Select
        // the zero-jitter boundary through the public Random service as well.
        Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0 }),
        Effect.provide(NodeServices.layer),
      )
    }),
  )
}

test("successful network attempts get fresh budgets even when the operation exceeds one minute", async () => {
  const paths = [0, 1, 2, 3].map((index) => `v1/pages/progress-${index}`)
  await Effect.runPromise(
    withClockedNotion(
      () => ({ wait: Effect.sleep(20_000) }),
      ({ api, clock, started, starts }) =>
        Effect.gen(function* () {
          const operation = yield* Effect.forkChild(
            Effect.forEach(paths, (path) => api.request(path)),
            { startImmediately: true },
          )
          for (const path of paths) {
            expect((yield* Queue.take(started)).path).toBe(path)
            yield* clock.adjust(20_000)
          }
          expect(yield* Fiber.join(operation)).toEqual(paths.map((id) => ({ object: "page", id })))
          expect(starts.map((start) => start.millis)).toEqual([0, 20_000, 40_000, 60_000])
        }),
      30_000,
    ),
  )
})

test("request starts are shared, immediate first, and spaced while earlier requests remain in flight", async () => {
  const release = Latch.makeUnsafe()
  await Effect.runPromise(
    withClockedNotion(
      ({ path }) => ({ wait: path === "v1/pages/first" ? release.await : Effect.void }),
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(api.request("v1/pages/first"), {
            startImmediately: true,
          })
          expect(yield* Queue.take(started)).toEqual({
            path: "v1/pages/first",
            attempt: 1,
            millis: 0,
          })
          const second = yield* Effect.forkChild(api.request("v1/pages/second"), {
            startImmediately: true,
          })
          const third = yield* Effect.forkChild(api.request("v1/pages/third"), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* clock.adjust(349)
          expect(starts.map((start) => start.millis)).toEqual([0])
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(350)
          yield* Effect.yieldNow
          yield* clock.adjust(350)
          expect((yield* Queue.take(started)).millis).toBe(700)
          expect(yield* Fiber.join(second)).toEqual({ object: "page", id: "v1/pages/second" })
          expect(yield* Fiber.join(third)).toEqual({ object: "page", id: "v1/pages/third" })
          expect(first.pollUnsafe()).toBeUndefined()
          yield* release.open
          yield* Fiber.join(first)
        }),
    ),
  )
})

test("serial requests add no admission delay after a response taking at least 350 milliseconds", async () => {
  for (const duration of [350, 500]) {
    await Effect.runPromise(
      withClockedNotion(
        ({ path }) => ({ wait: path === "v1/pages/slow" ? Effect.sleep(duration) : Effect.void }),
        ({ api, clock, starts, started, sleeps }) =>
          Effect.gen(function* () {
            const first = yield* Effect.forkChild(api.request("v1/pages/slow"), {
              startImmediately: true,
            })
            expect((yield* Queue.take(started)).millis).toBe(0)
            yield* Effect.yieldNow
            yield* clock.adjust(duration)
            yield* Fiber.join(first)
            const second = yield* Effect.forkChild(api.request("v1/pages/next"), {
              startImmediately: true,
            })
            yield* clock.adjust(0)
            expect(starts.map((start) => start.millis)).toEqual([0, duration])
            expect(yield* Fiber.join(second)).toEqual({ object: "page", id: "v1/pages/next" })
          }),
      ),
    )
  }
})

test("interrupting both a sleeping admission and a queued request releases the gate without reserving slots", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({}),
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          yield* api.request("v1/pages/first")
          yield* Queue.take(started)
          const sleeping = yield* Effect.forkChild(api.request("v1/pages/cancel-sleep"), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          const queued = yield* Effect.forkChild(api.request("v1/pages/cancel-queue"), {
            startImmediately: true,
          })
          yield* Fiber.interrupt(queued)
          yield* Fiber.interrupt(sleeping)
          expect(Exit.hasInterrupts(yield* Fiber.await(queued))).toBe(true)
          expect(Exit.hasInterrupts(yield* Fiber.await(sleeping))).toBe(true)
          yield* clock.adjust(100)
          const survivor = yield* Effect.forkChild(api.request("v1/pages/survivor"), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* clock.adjust(249)
          expect(starts.map((start) => start.path)).toEqual(["v1/pages/first"])
          yield* clock.adjust(1)
          expect(yield* Queue.take(started)).toEqual({
            path: "v1/pages/survivor",
            attempt: 1,
            millis: 350,
          })
          yield* Fiber.join(survivor)
        }),
    ),
  )
})

test("transport read retries pass through the same admission gate after backoff", async () => {
  for (const failure of [{ networkError: "network connection reset" }]) {
    for (const [path, method] of [
      ["v1/pages/read", "GET"],
      ["v1/data_sources/00000000-0000-4000-8000-000000000001/query", "POST"],
      ["v1/search", "POST"],
    ] as const) {
      await Effect.runPromise(
        withClockedNotion(
          (start) => (start.path === path && start.attempt === 1 ? failure : {}),
          ({ api, clock, starts, started, sleeps }) =>
            Effect.gen(function* () {
              const read = yield* Effect.forkChild(api.request(path, undefined, { method }), {
                startImmediately: true,
              })
              expect((yield* Queue.take(started)).millis).toBe(0)
              yield* Effect.yieldNow
              yield* clock.adjust(900)
              const competing = yield* Effect.forkChild(api.request("v1/pages/competing"), {
                startImmediately: true,
              })
              yield* clock.adjust(99)
              expect(starts.map((start) => start.millis)).toEqual([0])
              yield* clock.adjust(1)
              expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_000 })
              expect(yield* Fiber.join(read)).toEqual({ object: "page", id: path })
              yield* clock.adjust(350)
              expect((yield* Queue.take(started)).millis).toBe(1350)
              yield* Fiber.join(competing)
            }),
        ),
      )
    }
  }
})

test("separate clients share the credential admission schedule", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({}),
      ({ api, peer, clock, started, starts, sleeps }) =>
        Effect.gen(function* () {
          yield* api.request("v1/pages/first-client")
          yield* Queue.take(started)
          const second = yield* Effect.forkChild(peer.request("v1/pages/second-client"), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* clock.adjust(349)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(350)
          yield* Fiber.join(second)
        }),
    ),
  )
})

test("a definitive write rate limit retries the same request only after the full shared window", async () => {
  await Effect.runPromise(
    withClockedNotion(
      ({ path, attempt }) =>
        path === "v1/pages/write" && attempt === 1
          ? {
              text: JSON.stringify({ object: "error", code: "rate_limited", status: 429 }),
            }
          : {},
      ({ api, peer, clock, started, starts, sleeps }) =>
        Effect.gen(function* () {
          const writing = yield* Effect.forkChild(
            api.request("v1/pages/write", {}, { method: "PATCH" }),
            { startImmediately: true },
          )
          yield* Queue.take(started)
          yield* Queue.take(sleeps)
          const following = yield* Effect.forkChild(peer.request("v1/pages/following"), {
            startImmediately: true,
          })
          yield* Effect.yieldNow
          yield* clock.adjust(59_999)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(60_000)
          expect(yield* Fiber.join(writing)).toEqual({ object: "page", id: "v1/pages/write" })
          yield* clock.adjust(350)
          expect((yield* Queue.take(started)).millis).toBe(60_350)
          yield* Fiber.join(following)
          expect(starts.filter((start) => start.path === "v1/pages/write")).toHaveLength(2)
        }),
    ),
  )
})

test("structured 429 and 529 read delays above 60 seconds stay outside the process timeout", async () => {
  for (const status of [429, 529]) {
    await Effect.runPromise(
      withClockedNotion(
        ({ attempt }) =>
          attempt === 1
            ? {
                text: JSON.stringify({
                  object: "error",
                  status,
                  code: status === 429 ? "rate_limited" : "service_unavailable",
                  message: "sensitive-fixture-token",
                  additional_data: { retry_after: 90 },
                }),
              }
            : {},
        ({ api, clock, started, starts, sleeps }) =>
          Effect.gen(function* () {
            const read = yield* Effect.forkChild(api.request("v1/pages/long-window"), {
              startImmediately: true,
            })
            expect((yield* Queue.take(started)).millis).toBe(0)
            yield* Effect.yieldNow
            yield* clock.adjust(89_999)
            expect(starts).toHaveLength(1)
            yield* clock.adjust(1)
            expect((yield* Queue.take(started)).millis).toBe(90_000)
            expect(yield* Fiber.join(read)).toEqual({ object: "page", id: "v1/pages/long-window" })
          }),
      ),
    )
  }
})

test("a read-only 503 respects a Retry-After longer than one minute", async () => {
  await Effect.runPromise(
    withClockedNotion(
      ({ attempt }) =>
        attempt === 1
          ? {
              status: 503,
              headers: { "retry-after": "75" },
              text: JSON.stringify({ object: "error", code: "service_unavailable" }),
            }
          : {},
      ({ api, clock, starts, started }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(api.request("v1/pages/retry-header"), {
            startImmediately: true,
          })
          expect((yield* Queue.take(started)).millis).toBe(0)
          yield* clock.adjust(74_999)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(75_000)
          expect(yield* Fiber.join(request)).toEqual({
            object: "page",
            id: "v1/pages/retry-header",
          })
        }),
    ),
  )
})

test("rate limit read retries are bounded and the last cooldown remains shared", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        text: JSON.stringify({ object: "error", status: 429, code: "rate_limited" }),
      }),
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(
            api.request("v1/pages/exhausted").pipe(Effect.result),
            {
              startImmediately: true,
            },
          )
          yield* Queue.take(started)
          yield* Effect.yieldNow
          for (let attempt = 0; attempt < 3; attempt++) {
            yield* clock.adjust(60_000)
            yield* Queue.take(started)
          }
          const result = yield* Fiber.join(read)
          expect(result._tag === "Failure" && result.failure.code).toBe("RATE_LIMITED")
          expect(starts.map((start) => start.millis)).toEqual([0, 60_000, 120_000, 180_000])
        }),
    ),
  )
})

test("cooldowns beyond the request budget persist and reject later writes before spawn", async () => {
  await Effect.runPromise(
    withClockedNotion(
      ({ path }) =>
        path === "v1/pages/over-budget"
          ? {
              text: JSON.stringify({
                object: "error",
                status: 429,
                code: "rate_limited",
                additional_data: { retry_after: 600 },
              }),
            }
          : {},
      ({ api, peer, clock, starts }) =>
        Effect.gen(function* () {
          const read = yield* api.request("v1/pages/over-budget").pipe(Effect.result)
          const write = yield* peer
            .request("v1/pages/not-sent", {}, { method: "PATCH" })
            .pipe(Effect.result)
          for (const result of [read, write]) {
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected admission rejection")
            expect(result.failure.code).toBe("RATE_LIMITED")
            expect(result.failure.details).toMatchObject({
              phase: "input_rejected",
              reason: "admission_wait_exhausted",
              retry_after_seconds: 600,
            })
          }
          expect(starts).toHaveLength(1)
          yield* clock.adjust(600_000)
          yield* peer.request("v1/pages/after-window")
          expect(starts.map((start) => start.millis)).toEqual([0, 600_000])
        }),
    ),
  )
})

test("structured diagnostics retain only safe delays and never replay contradictory or server-error writes", async () => {
  for (const [status, code, hint, expectedDelay] of [
    [429, "rate_limited", "75", 75],
    [429, "rate_limited", 1e308, 1e308],
    [429, "rate_limited", -1, 60],
    [429, "rate_limited", "private-token", 60],
    [429, "rate_limited", { value: "private-token" }, 60],
    [529, "service_unavailable", 90, 90],
    [500, "internal_server_error", 90, 90],
    [503, "service_unavailable", 90, 90],
  ] as const) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({
          text: JSON.stringify({
            object: "error",
            status,
            code,
            message: "private-token",
            additional_data: {
              retry_after: hint,
              body: "private-token",
              ...(status === 429 ? { retry_guidance: ["Do not repeat the write."] } : {}),
            },
          }),
        }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request("v1/pages/write", {}, { method: "POST" })
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected API rejection")
            expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
            expect(result.failure.details).toMatchObject({ http_status: status })
            const details = result.failure.details as { retry_after_seconds?: number }
            expect(details.retry_after_seconds).toBe(expectedDelay)
            expect(starts).toHaveLength(1)
            expect(JSON.stringify(result)).not.toContain("private-token")
          }),
      ),
    )
  }
})

test("read transport timeout without an exit code retries after backoff", async () => {
  await Effect.runPromise(
    withClockedNotion(
      ({ attempt }) => (attempt === 1 ? { wait: Effect.never } : {}),
      ({ api, clock, started, starts, sleeps }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(
            api.request("v1/pages/read-timeout").pipe(Effect.result),
            { startImmediately: true },
          )
          expect((yield* Queue.take(started)).millis).toBe(0)
          yield* clock.adjust(60_000)
          yield* Effect.yieldNow
          expect(starts).toHaveLength(1)
          yield* clock.adjust(999)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(61_000)
          expect((yield* Fiber.join(request))._tag).toBe("Success")
          expect(starts).toHaveLength(2)
        }),
    ),
  )
})

test("read transport timeout exhaustion stops after the existing three retry budget", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({ wait: Effect.never }),
      ({ api, clock, started, starts, sleeps }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(
            api.request("v1/pages/read-timeout-exhausted").pipe(Effect.result),
            { startImmediately: true },
          )
          for (let attempt = 0; attempt < 4; attempt++) {
            yield* Queue.take(started)
            yield* clock.adjust(60_000)
            if (attempt < 3) {
              const delay = 1_000 * 2 ** attempt
              yield* Effect.yieldNow
              yield* clock.adjust(delay)
            }
          }
          const result = yield* Fiber.join(request)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected exhausted read timeout")
          expect(result.failure.code).toBe("NOTION_UNAVAILABLE")
          expect(result.failure.details).toEqual({ reason: "timeout" })
          expect(starts.map((start) => start.millis)).toEqual([0, 61_000, 123_000, 187_000])
        }),
    ),
  )
})

test("write timeout retains unknown outcome and never replays", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({ wait: Effect.never }),
      ({ api, clock, started, starts }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(
            api.request("v1/pages/timeout", {}, { method: "PATCH" }).pipe(Effect.result),
            { startImmediately: true },
          )
          yield* Queue.take(started)
          yield* clock.adjust(1_500)
          const result = yield* Fiber.join(request)
          expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
          expect(JSON.stringify(result)).toContain("timeout")
          expect(starts).toHaveLength(1)
        }),
      1_500,
    ),
  )
})

test("HTTP completion waits for the response stream before closing the request scope", async () => {
  const release = Latch.makeUnsafe()
  await Effect.runPromise(
    withClockedNotion(
      () => ({ bodyWait: release.await, text: '{"object":"block","id":"drained"}' }),
      ({ api, started }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(api.request("v1/blocks/drained"), {
            startImmediately: true,
          })
          yield* Queue.take(started)
          yield* release.open
          expect(yield* Fiber.join(request)).toEqual({ object: "block", id: "drained" })
        }),
    ),
  )
})

test("credential configuration uses replaceable provider with persisted-token priority", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* Store
      for (const [configured, expected] of [
        [" persisted-token ", "persisted-token"],
        ["  ", "provider-token"],
        [undefined, "provider-token"],
      ] as const) {
        const value = yield* configuredToken.pipe(
          Effect.provideService(Store, {
            ...base,
            readJson: (_key, schema) => Effect.succeed(decode(schema, { token: configured })),
          }),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ NOTION_API_TOKEN: " provider-token " }),
            ),
          ),
        )
        expect(value).toBe(expected)
      }
      const missing = yield* configuredToken.pipe(
        Effect.provideService(Store, { ...base, readJson: () => Effect.succeed(undefined) }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
      expect(missing).toBeUndefined()
    }).pipe(Effect.provide(store)),
  )
})

// Rendezvous on the real counter instead of guessing when credential hashing and
// the second public request have reached the shared producer.
function observeTransportCoalescing(api: Notion["Service"]) {
  const metrics = api.metrics
  if (metrics === undefined) throw new Error("The formal Notion transport must expose its metrics")
  const joined = Latch.makeUnsafe()
  const note = metrics.coalesced
  metrics.coalesced = () => {
    note()
    joined.openUnsafe()
  }
  return { joined: joined.await, snapshot: () => metrics.snapshot() }
}

test("formal Notion Layer coalesces concurrent equal metadata queries before admission and attempt accounting", async () => {
  const release = Latch.makeUnsafe()
  const path = "v1/data_sources/00000000-0000-4000-8000-000000000001/query?filter_properties=title"
  const body = {
    page_size: 100,
    filter: { property: "Skill", relation: { contains: "00000000-0000-4000-8000-000000000002" } },
  }
  await Effect.runPromise(
    withClockedNotion(
      () => ({ wait: release.await }),
      ({ api, clock, starts, started }) =>
        Effect.gen(function* () {
          const probe = observeTransportCoalescing(api)
          const first = yield* Effect.forkChild(
            api.request(path, body, { queueBudgetMs: NOTION_ADMISSION_BUDGET_MS }),
            { startImmediately: true },
          )
          expect((yield* Queue.take(started)).millis).toBe(0)
          const second = yield* Effect.forkChild(api.request(path, structuredClone(body)), {
            startImmediately: true,
          })
          yield* probe.joined
          expect(starts).toHaveLength(1)
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            coalesced_requests: 1,
            duplicate_requests: 0,
            requests: { notion_metadata: 1, notion_body: 0, notion_write: 0, provider: 0 },
          })
          yield* clock.adjust(350)
          expect(starts).toHaveLength(1)
          yield* release.open
          expect(yield* Fiber.joinAll([first, second])).toEqual([
            { object: "page", id: path },
            { object: "page", id: path },
          ])
          // Completion removes the shared entry; this is a new request, with a fresh slot.
          expect(yield* api.request(path, body)).toEqual({ object: "page", id: path })
          expect(starts.map((start) => start.millis)).toEqual([0, 350])
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 1,
            in_flight: 0,
            outcomes: { success: 2, failure: 0, cancelled: 0 },
          })
        }),
    ),
  )
})

test.each([
  { configured: undefined, limit: 4 },
  { configured: "", limit: 4 },
  { configured: "2", limit: 2 },
])(
  "formal Notion Layer bounds long independent requests without banking admission slots: %j",
  async ({ configured, limit }) => {
    const release = Latch.makeUnsafe()
    await Effect.runPromise(
      withClockedNotion(
        () => ({ wait: release.await }),
        ({ api, clock, starts, started, sleeps }) =>
          Effect.gen(function* () {
            const paths = Array.from(
              { length: limit + 2 },
              (_, index) => `v1/pages/bounded-${index}`,
            )
            const requests = yield* Effect.forEach(paths, (path) =>
              Effect.forkChild(api.request(path), { startImmediately: true }),
            )
            expect((yield* Queue.take(started)).millis).toBe(0)
            for (let index = 1; index < limit; index++) {
              yield* Effect.yieldNow
              yield* clock.adjust(350)
              expect((yield* Queue.take(started)).millis).toBe(index * 350)
            }
            yield* clock.adjust(10_000)
            expect(starts).toHaveLength(limit)
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: limit,
              in_flight: limit,
              peak_concurrency: limit,
            })
            yield* release.open
            const releasedAt = (limit - 1) * 350 + 10_000
            yield* clock.adjust(25)
            const resumedAt = (yield* Queue.take(started)).millis
            expect(resumedAt).toBeGreaterThanOrEqual(releasedAt)
            expect(resumedAt).toBeLessThanOrEqual(releasedAt + 25)
            // Both queued callers can acquire free permits, but only a fresh admission
            // may send. Their accumulated permit wait must not become a send burst.
            yield* Effect.yieldNow
            yield* clock.adjust(349)
            expect(starts).toHaveLength(limit + 1)
            yield* clock.adjust(1)
            expect((yield* Queue.take(started)).millis).toBe(resumedAt + 350)
            yield* Fiber.joinAll(requests)
            const metrics = api.requestMetrics?.()
            expect(metrics).toMatchObject({
              total_requests: limit + 2,
              peak_concurrency: limit,
              in_flight: 0,
              coalesced_requests: 0,
              outcomes: { success: limit + 2, failure: 0, cancelled: 0 },
            })
            expect(metrics?.queue_wait_ms).toBeGreaterThanOrEqual(10_000)
          }),
        60_000,
        configured,
      ),
    )
  },
)

test("formal Notion Layer releases permits on queued and last-waiter cancellation without charging joins another permit", async () => {
  const sharedPath = "v1/pages/bounded-shared-owner"
  await Effect.runPromise(
    withClockedNotion(
      ({ path }) => (path === sharedPath ? { wait: Effect.never } : {}),
      ({ api, clock, starts, started }) =>
        Effect.gen(function* () {
          const probe = observeTransportCoalescing(api)
          const first = yield* Effect.forkChild(api.request(sharedPath), { startImmediately: true })
          yield* Queue.take(started)
          const joined = yield* Effect.forkChild(api.request(sharedPath), {
            startImmediately: true,
          })
          yield* probe.joined
          const queued = yield* Effect.forkChild(api.request("v1/pages/bounded-cancelled-queue"), {
            startImmediately: true,
          })
          const survivor = yield* Effect.forkChild(api.request("v1/pages/bounded-survivor"), {
            startImmediately: true,
          })
          yield* clock.adjust(1_000)
          expect(starts).toHaveLength(1)
          yield* Fiber.interrupt(queued)
          yield* Fiber.interrupt(first)
          yield* clock.adjust(350)
          expect(starts).toHaveLength(1)
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            coalesced_requests: 1,
            in_flight: 1,
            outcomes: { cancelled: 0 },
          })
          yield* Fiber.interrupt(joined)
          yield* clock.adjust(25)
          expect(yield* Queue.take(started)).toEqual({
            path: "v1/pages/bounded-survivor",
            attempt: 1,
            millis: 1_375,
          })
          expect(yield* Fiber.join(survivor)).toEqual({
            object: "page",
            id: "v1/pages/bounded-survivor",
          })
          expect(starts.some((start) => start.path === "v1/pages/bounded-cancelled-queue")).toBe(
            false,
          )
          expect(probe.snapshot()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 1,
            in_flight: 0,
            peak_concurrency: 1,
            outcomes: { success: 1, failure: 0, cancelled: 1 },
          })
        }),
      60_000,
      "1",
    ),
  )
})

test("request attribution follows the actual producer across retry and does not leak to the next phase", async () => {
  const path = "v1/pages/attributed-retry"
  const attribution = {
    phase: "author_preflight" as const,
    skill_page_id: "11111111-2222-4333-8444-555555555555",
    operation_id: "body-write-original.operation",
  }
  await Effect.runPromise(
    withClockedNotion(
      (start) =>
        start.path === path && start.attempt === 1
          ? { networkError: "controlled network failure" }
          : {},
      ({ api, clock, started, sleeps }) =>
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            withNotionRequestAttribution(api.request(path), attribution),
            { startImmediately: true },
          )
          yield* Queue.take(started)
          yield* Queue.take(sleeps)
          yield* clock.adjust(1000)
          yield* Fiber.join(running)
          const metrics = api.requestMetrics?.()
          const attempts = metrics?.trace.filter((entry) => entry.event === "attempt")
          expect(attempts).toHaveLength(2)
          expect(
            attempts?.every(
              (entry) => JSON.stringify(entry.attribution) === JSON.stringify(attribution),
            ),
          ).toBe(true)
          expect(
            metrics?.trace.filter((entry) => entry.event === "wait" && entry.kind === "retry"),
          ).toMatchObject([{ attribution, milliseconds: 1000 }])
          yield* clock.adjust(350)
          yield* api.request("v1/pages/unknown-phase")
          expect(api.requestMetrics?.().trace.at(-1)?.attribution).toEqual({
            phase: null,
            skill_page_id: null,
            operation_id: null,
          })
        }),
      60000,
      "1",
      30,
    ),
  )
})

test("formal Notion Layer holds no concurrency permit during read retry backoff", async () => {
  const path = "v1/pages/bounded-retry"
  await Effect.runPromise(
    withClockedNotion(
      (start) =>
        start.path === path && start.attempt === 1
          ? {
              networkError: "network fixture failure",
            }
          : {},
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          expect((yield* Queue.take(started)).millis).toBe(0)
          yield* Queue.take(sleeps)
          expect(api.requestMetrics?.().in_flight).toBe(0)
          yield* clock.adjust(350)
          const following = yield* Effect.forkChild(
            api.request("v1/pages/bounded-between-attempts"),
            { startImmediately: true },
          )
          yield* clock.adjust(650)
          expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_000 })
          expect(yield* Fiber.join(request)).toEqual({ object: "page", id: path })
          yield* clock.adjust(350)
          expect((yield* Queue.take(started)).millis).toBe(1350)
          expect(yield* Fiber.join(following)).toEqual({
            object: "page",
            id: "v1/pages/bounded-between-attempts",
          })
          expect(starts.map((start) => start.millis)).toEqual([0, 1_000, 1_350])
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 3,
            peak_concurrency: 1,
            in_flight: 0,
            retry_wait_ms: 1_000,
            outcomes: { success: 2, failure: 1, cancelled: 0 },
          })
        }),
      60_000,
      "1",
    ),
  )
})

test.each(["0", "-1", "1.5", "65", "NaN", "Infinity"])(
  "formal Notion Layer rejects invalid concurrency configuration %j before sending",
  async (configured) => {
    let processes = 0
    const result = await Effect.runPromise(
      withClockedNotion(
        () => {
          processes++
          return {}
        },
        ({ api }) => api.request("v1/pages/invalid-concurrency"),
        60_000,
        configured,
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected concurrency configuration rejection")
    expect(result.failure.code).toBe("CONFIG_ERROR")
    expect(processes).toBe(0)
  },
)

test("formal Notion Layer bounds permit acquisition by admission deadline without truncating its admitted owner", async () => {
  const releaseOwner = Latch.makeUnsafe()
  const ownerPath = "v1/pages/long-admitted-owner"
  const waiterPath = "v1/pages/permit-deadline-waiter"
  await Effect.runPromise(
    withClockedNotion(
      ({ path }) => (path === ownerPath ? { wait: releaseOwner.await } : {}),
      ({ api, clock, starts, started }) =>
        Effect.gen(function* () {
          const owner = yield* Effect.forkChild(api.request(ownerPath), { startImmediately: true })
          yield* Queue.take(started)
          const waiter = yield* Effect.forkChild(api.request(waiterPath).pipe(Effect.result), {
            startImmediately: true,
          })
          yield* clock.adjust(300_001)
          expect(waiter.pollUnsafe()).not.toBeUndefined()
          const result = yield* Fiber.join(waiter)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected admission deadline exhaustion")
          expect(result.failure.code).toBe("RATE_LIMITED")
          expect(result.failure.details).toMatchObject({
            phase: "input_rejected",
            reason: "admission_wait_exhausted",
          })
          expect(owner.pollUnsafe()).toBeUndefined()
          expect(starts.map((start) => start.path)).toEqual([ownerPath])
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 1,
            in_flight: 1,
            outcomes: { cancelled: 0 },
          })
          expect(api.requestMetrics?.().queue_wait_ms).toBeGreaterThanOrEqual(300_000)
          yield* releaseOwner.open
          expect(yield* Fiber.join(owner)).toEqual({ object: "page", id: ownerPath })
          // The abandoned take neither steals the released permit nor leaves a dead waiter.
          expect(yield* api.request("v1/pages/after-permit-deadline")).toEqual({
            object: "page",
            id: "v1/pages/after-permit-deadline",
          })
          expect(starts).toHaveLength(2)
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 2,
            in_flight: 0,
            peak_concurrency: 1,
            outcomes: { success: 2, failure: 0, cancelled: 0 },
          })
        }),
      600_000,
      "1",
    ),
  )
})

test.each(["short", "long"] as const)(
  "SC15 incompatible queue budgets remain independent when the %s waiter arrives first",
  async (firstBudget) => {
    const releaseOwner = Latch.makeUnsafe()
    const ownerPath = "v1/pages/queue-budget-owner"
    const targetPath = "v1/pages/queue-budget-selection"
    await Effect.runPromise(
      withClockedNotion(
        ({ path }) => (path === ownerPath ? { wait: releaseOwner.await } : {}),
        ({ api, clock, starts, started, sleeps }) =>
          Effect.gen(function* () {
            const probe = observeTransportCoalescing(api)
            const owner = yield* Effect.forkChild(api.request(ownerPath), {
              startImmediately: true,
            })
            yield* Queue.take(started)
            const request = (budget: "short" | "long") =>
              api.request(targetPath, undefined, {
                priority: "required",
                queueBudgetMs: budget === "short" ? 100 : 1_000,
              })
            const first = yield* Effect.forkChild(request(firstBudget).pipe(Effect.result), {
              startImmediately: true,
            })
            yield* Queue.take(sleeps)
            const second = yield* Effect.forkChild(
              request(firstBudget === "short" ? "long" : "short").pipe(Effect.result),
              { startImmediately: true },
            )
            // Observe either an independent admission wait or the old wrong join.
            yield* Effect.race(Queue.take(sleeps), probe.joined)
            const short = firstBudget === "short" ? first : second
            const long = firstBudget === "long" ? first : second
            yield* clock.adjust(100)
            yield* releaseOwner.open
            yield* Fiber.join(owner)
            expect(short.pollUnsafe()).not.toBeUndefined()
            expect(long.pollUnsafe()).toBeUndefined()
            const expired = yield* Fiber.join(short)
            expect(expired._tag).toBe("Failure")
            if (expired._tag !== "Failure")
              throw new Error("Expected the short queue budget to expire")
            expect(expired.failure.code).toBe("RATE_LIMITED")
            expect(expired.failure.details).toMatchObject({
              reason: "admission_wait_exhausted",
              budget: "queue",
            })
            expect(starts.map(({ path }) => path)).toEqual([ownerPath])
            yield* clock.adjust(250)
            expect(yield* Fiber.join(long)).toMatchObject({
              _tag: "Success",
              success: { object: "page", id: targetPath },
            })
            expect(starts.map(({ path }) => path)).toEqual([ownerPath, targetPath])
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 2,
              coalesced_requests: 0,
              in_flight: 0,
              outcomes: { success: 2, failure: 0, cancelled: 0 },
            })
          }),
        60_000,
        "1",
      ),
    )
  },
)

test.each(["creator", "joiner"] as const)(
  "formal Notion Layer cancellation of the %s preserves the other shared waiter",
  async (cancel) => {
    const release = Latch.makeUnsafe()
    let producerCancellations = 0
    await Effect.runPromise(
      withClockedNotion(
        () => ({
          wait: release.await.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.hasInterrupts(exit)) producerCancellations++
              }),
            ),
          ),
        }),
        ({ api, starts, started }) =>
          Effect.gen(function* () {
            const probe = observeTransportCoalescing(api)
            const first = yield* Effect.forkChild(api.request("v1/pages/shared-survivor"), {
              startImmediately: true,
            })
            yield* Queue.take(started)
            const second = yield* Effect.forkChild(api.request("v1/pages/shared-survivor"), {
              startImmediately: true,
            })
            yield* probe.joined
            const cancelled = cancel === "creator" ? first : second
            const survivor = cancel === "creator" ? second : first
            yield* Fiber.interrupt(cancelled)
            expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true)
            expect(survivor.pollUnsafe()).toBeUndefined()
            expect(producerCancellations).toBe(0)
            expect(starts).toHaveLength(1)
            expect(probe.snapshot()).toMatchObject({
              total_requests: 1,
              coalesced_requests: 1,
              in_flight: 1,
              outcomes: { cancelled: 0 },
            })
            yield* release.open
            expect(yield* Fiber.join(survivor)).toEqual({
              object: "page",
              id: "v1/pages/shared-survivor",
            })
            expect(probe.snapshot()).toMatchObject({
              in_flight: 0,
              outcomes: { success: 1, failure: 0, cancelled: 0 },
            })
          }),
      ),
    )
  },
)

test("formal Notion Layer stops the producer after all waiters cancel and reuses the key without a cached interruption", async () => {
  let producerCancellations = 0
  await Effect.runPromise(
    withClockedNotion(
      ({ attempt }) =>
        attempt === 1
          ? {
              wait: Effect.never.pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.hasInterrupts(exit)) producerCancellations++
                  }),
                ),
              ),
            }
          : {},
      ({ api, clock, starts, started }) =>
        Effect.gen(function* () {
          const probe = observeTransportCoalescing(api)
          const path = "v1/pages/shared-all-cancelled"
          const first = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* Queue.take(started)
          const second = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* probe.joined
          yield* Fiber.interrupt(first)
          expect(producerCancellations).toBe(0)
          yield* Fiber.interrupt(second)
          expect(producerCancellations).toBe(1)
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            in_flight: 0,
            outcomes: { cancelled: 1 },
          })
          yield* clock.adjust(350)
          expect(yield* api.request(path)).toEqual({ object: "page", id: path })
          expect(starts.map((start) => start.millis)).toEqual([0, 350])
          expect(probe.snapshot()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 1,
            outcomes: { success: 1, failure: 0, cancelled: 1 },
          })
        }),
    ),
  )
})

test("formal Notion Layer releases shared admission when every queued waiter cancels", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({}),
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const probe = observeTransportCoalescing(api)
          yield* api.request("v1/pages/occupied-slot")
          yield* Queue.take(started)
          const path = "v1/pages/shared-before-send"
          const first = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* Effect.yieldNow
          const second = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* probe.joined
          yield* Fiber.interrupt(first)
          yield* Fiber.interrupt(second)
          expect(starts.map((start) => start.path)).toEqual(["v1/pages/occupied-slot"])
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            coalesced_requests: 1,
            in_flight: 0,
          })
          yield* clock.adjust(100)
          const replacement = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* Effect.yieldNow
          yield* clock.adjust(250)
          expect((yield* Queue.take(started)).millis).toBe(350)
          expect(yield* Fiber.join(replacement)).toEqual({ object: "page", id: path })
          expect(probe.snapshot()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 1,
            outcomes: { success: 2, failure: 0, cancelled: 0 },
          })
        }),
    ),
  )
})

test("formal Notion Layer shares the complete retry chain and re-admits only its actual attempts", async () => {
  const failedResponse = Latch.makeUnsafe()
  const path = "v1/pages/shared-retry-chain"
  await Effect.runPromise(
    withClockedNotion(
      (start) =>
        start.path === path && start.attempt === 1
          ? {
              wait: failedResponse.await,
              networkError: "network fixture failure",
            }
          : {},
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const probe = observeTransportCoalescing(api)
          const first = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          expect((yield* Queue.take(started)).millis).toBe(0)
          const second = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          yield* probe.joined
          yield* failedResponse.open
          yield* Effect.yieldNow
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            coalesced_requests: 1,
            outcomes: { failure: 1 },
          })
          yield* clock.adjust(900)
          const competing = yield* Effect.forkChild(
            api.request("v1/pages/competing-with-shared-retry"),
            { startImmediately: true },
          )
          yield* clock.adjust(100)
          expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_000 })
          expect(yield* Fiber.joinAll([first, second])).toEqual([
            { object: "page", id: path },
            { object: "page", id: path },
          ])
          yield* clock.adjust(350)
          expect((yield* Queue.take(started)).millis).toBe(1350)
          yield* Fiber.join(competing)
          expect(probe.snapshot()).toMatchObject({
            total_requests: 3,
            coalesced_requests: 1,
            in_flight: 0,
            retry_wait_ms: 1_000,
            outcomes: { success: 2, failure: 1, cancelled: 0 },
          })
        }),
    ),
  )
})

test("formal Notion Layer never merges or replays PATCH calls even when the path is a read query endpoint", async () => {
  const release = Latch.makeUnsafe()
  const path = "v1/data_sources/00000000-0000-4000-8000-000000000001/query?filter_properties=title"
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        wait: release.await,
        networkError: "network fixture failure",
      }),
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(
            api.request(path, {}, { method: "PATCH" }).pipe(Effect.result),
            { startImmediately: true },
          )
          expect((yield* Queue.take(started)).millis).toBe(0)
          const second = yield* Effect.forkChild(
            api.request(path, {}, { method: "PATCH" }).pipe(Effect.result),
            { startImmediately: true },
          )
          yield* Effect.yieldNow
          yield* clock.adjust(350)
          expect((yield* Queue.take(started)).millis).toBe(350)
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 0,
            requests: { notion_write: 2, notion_metadata: 0 },
          })
          yield* release.open
          yield* clock.adjust(10_000)
          const results = yield* Fiber.joinAll([first, second])
          expect(
            results.every(
              (result) =>
                result._tag === "Failure" && result.failure.code === "WRITE_OUTCOME_UNKNOWN",
            ),
          ).toBe(true)
          expect(starts).toHaveLength(2)
          expect(api.requestMetrics?.()).toMatchObject({
            total_requests: 2,
            coalesced_requests: 0,
            retry_wait_ms: 0,
            in_flight: 0,
            outcomes: { success: 0, failure: 2, cancelled: 0 },
          })
        }),
    ),
  )
})

test("formal Notion Layer keeps file-backed POST queries read-only even though they cannot be coalesced", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        text: JSON.stringify({ object: "error", code: "conflict_error", status: 409 }),
      }),
      ({ api, starts }) =>
        Effect.gen(function* () {
          const result = yield* api
            .request("v1/data_sources/00000000-0000-4000-8000-000000000001/query", undefined, {
              method: "POST",
              file: new URL("./fixtures.ts", import.meta.url).pathname,
            })
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected the controlled query failure")
          expect(result.failure.code).toBe("NOTION_REQUEST_FAILED")
          expect(starts).toHaveLength(1)
          expect(api.requestMetrics?.()).toMatchObject({ total_requests: 1, coalesced_requests: 0 })
        }),
    ),
  )
})
