import { createServer } from "node:http"
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
  FileSystem,
  Latch,
  Layer,
  Queue,
  Sink,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { decode, SkillsError } from "../src/model.ts"
import { Notion, NotionTransport } from "../src/notion.ts"
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

const NotionLive = NotionTransport.pipe(
  Layer.provide(
    Layer.effect(
      NotionRequestScheduler,
      Effect.suspend(() => makeRequestScheduler(memoryScheduleState())),
    ),
  ),
)

type Start = { readonly path: string; readonly attempt: number; readonly millis: number }
type Response = {
  readonly stdout?: string
  readonly stderr?: string
  readonly exit?: number
  readonly stdoutWait?: Effect.Effect<void>
  readonly wait?: Effect.Effect<void>
}

test("filtered metadata POST queries retain read-only failure semantics", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        stdout: JSON.stringify({ object: "error", code: "conflict_error", status: 409 }),
        exit: 1,
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

test("a structured public_api_request_blocked response is never retried", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        stdout: JSON.stringify({
          object: "error",
          code: "rate_limited",
          status: 429,
          additional_data: { rate_limit_reason: "public_api_request_blocked", retry_after: 60 },
        }),
        exit: 1,
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
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* TestClock.make()
      const started = yield* Queue.unbounded<Start>()
      const sleeps = yield* Queue.unbounded<number>()
      const starts: Start[] = []
      const attempts = new Map<string, number>()
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") throw new Error("Expected a standard command")
          const path = command.args[1]!
          const attempt = (attempts.get(path) ?? 0) + 1
          attempts.set(path, attempt)
          const millis = Number(yield* Clock.monotonicTimeNanos) / 1_000_000
          const start = { path, attempt, millis }
          starts.push(start)
          const response = respond(start)
          const stdout = Stream.unwrap(
            Effect.as(
              response.stdoutWait ?? Effect.void,
              Stream.make(
                new TextEncoder().encode(
                  response.stdout ?? JSON.stringify({ object: "page", id: path }),
                ),
              ),
            ),
          )
          const stderr = Stream.make(new TextEncoder().encode(response.stderr ?? ""))
          const handle = ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(attempt),
            exitCode: (response.wait ?? Effect.void).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(response.exit ?? 0)),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout,
            stderr,
            all: Stream.merge(stdout, stderr),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          })
          yield* Queue.offer(started, start)
          return handle
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
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              NTN_SKILLS_REQUEST_TIMEOUT_MS: String(timeoutMs),
              ...(concurrency === undefined ? {} : { NTN_SKILLS_NOTION_CONCURRENCY: concurrency }),
            }),
          ),
        ),
        Layer.provide(Layer.effect(NotionRequestScheduler, makeRequestScheduler(scheduleState))),
        Layer.provide(
          Layer.merge(store, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      )
      return yield* Effect.gen(function* () {
        const api = yield* Effect.provide(Notion, layer)
        const peer = yield* Effect.provide(Notion, layer)
        return yield* use({ api, peer, clock, starts, started, sleeps })
      }).pipe(Effect.provideService(Clock.Clock, observedClock), Effect.provide(NodeServices.layer))
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
          expect(yield* Queue.take(sleeps)).toBe(350)
          yield* clock.adjust(349)
          expect(starts.map((start) => start.millis)).toEqual([0])
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(350)
          expect(yield* Queue.take(sleeps)).toBe(350)
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
            expect(yield* Queue.take(sleeps)).toBe(duration)
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
          expect(yield* Queue.take(sleeps)).toBe(350)
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
          expect(yield* Queue.take(sleeps)).toBe(250)
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
  for (const failure of [
    { stdout: "", stderr: "error sending request: network connection reset", exit: 5 },
  ]) {
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
              expect(yield* Queue.take(sleeps)).toBe(1_000)
              yield* clock.adjust(900)
              yield* api.request("v1/pages/competing")
              expect((yield* Queue.take(started)).millis).toBe(900)
              yield* clock.adjust(100)
              expect(yield* Queue.take(sleeps)).toBe(250)
              yield* clock.adjust(249)
              expect(starts.map((start) => start.millis)).toEqual([0, 900])
              yield* clock.adjust(1)
              expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_250 })
              expect(yield* Fiber.join(read)).toEqual({ object: "page", id: path })
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
          expect(yield* Queue.take(sleeps)).toBe(350)
          yield* clock.adjust(349)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(350)
          yield* Fiber.join(second)
        }),
    ),
  )
})

test("a definitive write rate limit records a full shared window without replaying the write", async () => {
  await Effect.runPromise(
    withClockedNotion(
      ({ path }) =>
        path === "v1/pages/write"
          ? {
              stdout: "",
              stderr:
                "error: Public API request failed (429 Too Many Requests rate_limited): secret\n",
              exit: 5,
            }
          : {},
      ({ api, peer, clock, started, starts, sleeps }) =>
        Effect.gen(function* () {
          const rejection = yield* api
            .request("v1/pages/write", {}, { method: "PATCH" })
            .pipe(Effect.result)
          expect(rejection._tag).toBe("Failure")
          if (rejection._tag !== "Failure") throw new Error("Expected rate limit")
          expect(rejection.failure.code).toBe("RATE_LIMITED")
          expect(rejection.failure.details).toMatchObject({
            phase: "definitive_rejection",
            retry_after_seconds: 60,
            retry_after_source: "fallback",
          })
          expect(JSON.stringify(rejection)).not.toContain("secret")
          yield* Queue.take(started)
          const following = yield* Effect.forkChild(peer.request("v1/pages/following"), {
            startImmediately: true,
          })
          expect(yield* Queue.take(sleeps)).toBe(30_000)
          yield* clock.adjust(59_999)
          expect(starts).toHaveLength(1)
          yield* clock.adjust(1)
          expect((yield* Queue.take(started)).millis).toBe(60_000)
          yield* Fiber.join(following)
          expect(starts.filter((start) => start.path === "v1/pages/write")).toHaveLength(1)
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
                stdout: JSON.stringify({
                  object: "error",
                  status,
                  code: status === 429 ? "rate_limited" : "service_unavailable",
                  message: "sensitive-fixture-token",
                  additional_data: { retry_after: 90 },
                }),
                exit: 1,
              }
            : {},
        ({ api, clock, started, starts, sleeps }) =>
          Effect.gen(function* () {
            const read = yield* Effect.forkChild(api.request("v1/pages/long-window"), {
              startImmediately: true,
            })
            expect((yield* Queue.take(started)).millis).toBe(0)
            expect(yield* Queue.take(sleeps)).toBe(30_000)
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

test("rate limit read retries are bounded and the last cooldown remains shared", async () => {
  await Effect.runPromise(
    withClockedNotion(
      () => ({
        stdout: JSON.stringify({ object: "error", status: 429, code: "rate_limited" }),
        exit: 1,
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
          expect(yield* Queue.take(sleeps)).toBe(30_000)
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
              stdout: JSON.stringify({
                object: "error",
                status: 429,
                code: "rate_limited",
                additional_data: { retry_after: 600 },
              }),
              exit: 1,
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

test("structured rate limit diagnostics retain only safe delays and never replay server-error writes", async () => {
  for (const [status, code, hint, expectedDelay] of [
    [429, "rate_limited", "75", 75],
    [429, "rate_limited", 1e308, 1e308],
    [429, "rate_limited", -1, 60],
    [429, "rate_limited", "private-token", 60],
    [429, "rate_limited", { value: "private-token" }, 60],
    [529, "service_unavailable", 90, 90],
    [500, "internal_server_error", 90, undefined],
    [503, "service_unavailable", 90, undefined],
  ] as const) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({
          stdout: JSON.stringify({
            object: "error",
            status,
            code,
            message: "private-token",
            additional_data: { retry_after: hint, body: "private-token" },
          }),
          exit: 1,
        }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request("v1/pages/write", {}, { method: "POST" })
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected API rejection")
            expect(result.failure.code).toBe(
              status === 429 ? "RATE_LIMITED" : "WRITE_OUTCOME_UNKNOWN",
            )
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

test("transport diagnostics stay safe, read retry exhaustion preserves backoff, and writes remain unknown", async () => {
  for (const method of ["GET", "PATCH", "POST"] as const) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({
          stdout: "",
          stderr:
            "DNS resolution failed https://private.invalid/file?signature=secret authorization: Bearer sensitive-fixture-token",
          exit: 5,
        }),
        ({ api, clock, starts, started, sleeps }) =>
          Effect.gen(function* () {
            const request = yield* Effect.forkChild(
              api.request("v1/pages/sample", undefined, { method }).pipe(Effect.result),
              { startImmediately: true },
            )
            expect((yield* Queue.take(started)).millis).toBe(0)
            if (method === "GET") {
              for (const delay of [1_000, 2_000, 4_000]) {
                expect(yield* Queue.take(sleeps)).toBe(delay)
                yield* clock.adjust(delay)
                yield* Queue.take(started)
              }
            }
            const result = yield* Fiber.join(request)
            expect(starts.map((start) => start.millis)).toEqual(
              method === "GET" ? [0, 1_000, 3_000, 7_000] : [0],
            )
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected a failed transport")
            expect(result.failure.code).toBe(
              method === "GET" ? "NOTION_REQUEST_FAILED" : "WRITE_OUTCOME_UNKNOWN",
            )
            expect(result.failure.details).toMatchObject({
              path: "v1/pages/sample",
              exit_code: 5,
              reason: "dns",
              stderr_bytes: new TextEncoder().encode(
                "DNS resolution failed https://private.invalid/file?signature=secret authorization: Bearer sensitive-fixture-token",
              ).byteLength,
            })
            const details = result.failure.details
            if (!details || typeof details !== "object" || !("stderr_sha256" in details))
              throw new Error("Expected safe diagnostic fingerprint")
            expect(details.stderr_sha256).toMatch(/^[a-f0-9]{64}$/)
            const output = JSON.stringify(result.failure)
            expect(output).not.toContain("sensitive-fixture-token")
            expect(output).not.toContain("signature=secret")
            expect(output).not.toContain("private.invalid")
          }),
      ),
    )
  }
})

test("real process failures and bounded diagnostics remain typed and redacted", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const executable = `${directory}/ntn-fixture`
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}\nprocess.stderr.write('secret-fixture '.repeat(6000)); process.exitCode = 5\n`,
        )
        yield* fs.chmod(executable, 0o700)
        const result = yield* Effect.gen(function* () {
          return yield* (yield* Notion)
            .request("v1/pages/example", {}, { method: "PATCH" })
            .pipe(Effect.result)
        }).pipe(
          Effect.provide(NotionLive.pipe(Layer.provide(store))),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ NTN_SKILLS_NTN_BIN: executable })),
          ),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(SkillsError)
          expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
          expect(JSON.stringify(result.failure)).not.toContain("secret-fixture")
          expect(JSON.stringify(result.failure)).toContain("output_limit")
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})

test("interrupting a real ntn process closes its scoped child without replay", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped()
        const executable = `${directory}/ntn-fixture`
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`,
        )
        yield* fs.chmod(executable, 0o700)
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        const spawned = yield* Queue.unbounded<ChildProcessSpawner.ChildProcessHandle>()
        let starts = 0
        const observed = ChildProcessSpawner.make((command) =>
          real.spawn(command).pipe(
            Effect.tap((child) =>
              Effect.gen(function* () {
                starts++
                yield* Queue.offer(spawned, child)
              }),
            ),
          ),
        )
        yield* Effect.gen(function* () {
          const api = yield* Notion
          const request = yield* Effect.forkChild(
            api.request("v1/pages/example", {}, { method: "PATCH" }),
            { startImmediately: true },
          )
          const child = yield* Queue.take(spawned)
          expect(yield* child.isRunning).toBe(true)
          yield* Fiber.interrupt(request)
          expect(Exit.hasInterrupts(yield* Fiber.await(request))).toBe(true)
          expect(yield* child.isRunning).toBe(false)
          expect(starts).toBe(1)
        }).pipe(
          Effect.provide(
            NotionLive.pipe(
              Layer.provide(
                Layer.merge(
                  store,
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, observed),
                ),
              ),
            ),
          ),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ NTN_SKILLS_NTN_BIN: executable })),
          ),
        )
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
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
          expect(yield* Queue.take(sleeps)).toBe(1_000)
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
              expect(yield* Queue.take(sleeps)).toBe(delay)
              yield* clock.adjust(delay)
            }
          }
          const result = yield* Fiber.join(request)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected exhausted read timeout")
          expect(result.failure.code).toBe("NTN_UNAVAILABLE")
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

test("official stderr rejection protocol preserves definite failures and never replays writes", async () => {
  for (const [stderr, exit, expected, status, notionCode] of [
    [
      "error: Public API request failed (400 Bad Request validation_error): sensitive-fixture-token",
      5,
      "NOTION_REQUEST_FAILED",
      400,
      "validation_error",
    ],
    [
      "error: Public API request failed (403 Forbidden restricted_resource): sensitive-fixture-token",
      5,
      "ACCESS_DENIED",
      403,
      "restricted_resource",
    ],
    [
      "error: Public API request failed (404 Not Found object_not_found): sensitive-fixture-token",
      5,
      "NOT_FOUND",
      404,
      "object_not_found",
    ],
    [
      "error: Public API request failed (429 Too Many Requests rate_limited): sensitive-fixture-token",
      5,
      "RATE_LIMITED",
      429,
      "rate_limited",
    ],
    [
      "error: Public API request failed: sensitive-fixture-token\n  hint: Set NOTION_API_TOKEN, or run `ntn login` to reuse a saved workspace token.\n",
      4,
      "AUTH_REQUIRED",
      401,
      "unauthorized",
    ],
  ] as const) {
    for (const method of ["PATCH", "POST"] as const) {
      await Effect.runPromise(
        withClockedNotion(
          () => ({ stdout: "", stderr, exit }),
          ({ api, starts }) =>
            Effect.gen(function* () {
              const result = yield* api
                .request("v1/pages/sample", {}, { method })
                .pipe(Effect.result)
              expect(result._tag).toBe("Failure")
              if (result._tag !== "Failure") throw new Error("Expected rejection")
              expect(result.failure.code).toBe(expected)
              expect(result.failure.details).toMatchObject({
                http_status: status,
                notion_code: notionCode,
                phase: "definitive_rejection",
              })
              expect(starts).toHaveLength(1)
              expect(JSON.stringify(result)).not.toContain("sensitive-fixture-token")
            }),
        ),
      )
    }
  }
})

test("untrusted stderr, conflicts, server errors and invalid JSON retain unknown write outcomes", async () => {
  for (const response of [
    {
      stdout: "",
      stderr:
        "error: Public API request failed (500 Internal Server Error internal_server_error): secret",
      exit: 5,
    },
    {
      stdout: "",
      stderr: "error: Public API request failed (409 Conflict conflict_error): secret",
      exit: 5,
    },
    {
      stdout: "",
      stderr:
        "error: Public API request failed (500 Internal Server Error validation_error): secret",
      exit: 5,
    },
    {
      stdout: "",
      stderr: "error: Public API request failed (400 Bad Request untrusted_secret_code): secret",
      exit: 5,
    },
    {
      stdout: "",
      stderr: "untrusted Public API request failed (400 Bad Request validation_error): secret",
      exit: 5,
    },
    {
      stdout: "",
      stderr:
        "untrusted failure\nerror: Public API request failed (400 Bad Request validation_error): secret",
      exit: 5,
    },
    { stdout: "", stderr: "error: unrelated failure", exit: 1 },
    { stdout: "", stderr: "error: Failed to execute public API request", exit: 5 },
    { stdout: "", stderr: "error: connection reset by peer", exit: 5 },
    { stdout: "", stderr: "", exit: 0 },
    { stdout: "{broken", stderr: "", exit: 0 },
    { stdout: '{"object":"error"}', stderr: "", exit: 0 },
  ]) {
    await Effect.runPromise(
      withClockedNotion(
        () => response,
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request("v1/pages/sample", {}, { method: "POST" })
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected unknown outcome")
            expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
            expect(starts).toHaveLength(1)
            expect(JSON.stringify(result)).not.toContain("secret")
            if (response.stderr === "error: Failed to execute public API request")
              expect(result.failure.details).toMatchObject({ reason: "invalid_response" })
          }),
      ),
    )
  }
})

test("exact official transport envelope uses bounded read retries and never replays writes", async () => {
  const stderr = "error: Failed to execute public API request\n"
  for (const recover of [true, false]) {
    await Effect.runPromise(
      withClockedNotion(
        ({ attempt }) => (recover && attempt > 1 ? {} : { stdout: "", stderr, exit: 5 }),
        ({ api, clock, started, sleeps, starts }) =>
          Effect.gen(function* () {
            const request = yield* Effect.forkChild(
              api.request("v1/databases/sample").pipe(Effect.result),
              { startImmediately: true },
            )
            yield* Queue.take(started)
            for (const delay of recover ? [1_000] : [1_000, 2_000, 4_000]) {
              expect(yield* Queue.take(sleeps)).toBe(delay)
              yield* clock.adjust(delay)
              yield* Queue.take(started)
            }
            const result = yield* Fiber.join(request)
            expect(starts.map((start) => start.millis)).toEqual(
              recover ? [0, 1_000] : [0, 1_000, 3_000, 7_000],
            )
            expect(result._tag).toBe(recover ? "Success" : "Failure")
            if (result._tag === "Failure") {
              expect(result.failure.code).toBe("NOTION_REQUEST_FAILED")
              expect(result.failure.details).toMatchObject({
                reason: "unknown_transport",
                exit_code: 5,
                stderr_bytes: 44,
                stderr_sha256: "40fbf00674ed97a740e5422b69b87374073d6d7b767c0eeefaff8beb9bafe3ad",
              })
            }
          }),
      ),
    )
  }
  for (const method of ["POST", "PATCH"] as const) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({ stdout: "", stderr, exit: 5 }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api.request("v1/pages/sample", {}, { method }).pipe(Effect.result)
            expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
            if (result._tag === "Failure")
              expect(result.failure.details).toMatchObject({ reason: "unknown_transport" })
            expect(starts).toHaveLength(1)
          }),
      ),
    )
  }
})

test("only exact pre-send input rejection signatures classify as invalid arguments", async () => {
  for (const stderr of [
    "error: Invalid JSON from --data @-\n",
    "error: Failed to read request JSON from /private/sensitive-fixture-token.json\n",
  ]) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({ stdout: "", stderr, exit: 1 }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request("v1/pages/sample", {}, { method: "POST" })
              .pipe(Effect.result)
            expect(result._tag === "Failure" && result.failure.code).toBe("ARGUMENT_INVALID")
            expect(JSON.stringify(result)).toContain("input_rejected")
            expect(JSON.stringify(result)).not.toContain("sensitive-fixture-token")
            expect(starts).toHaveLength(1)
          }),
      ),
    )
  }
})

test("exit completion waits for stdout drain before closing the request scope", async () => {
  const release = Latch.makeUnsafe()
  await Effect.runPromise(
    withClockedNotion(
      () => ({ stdoutWait: release.await, stdout: '{"object":"block","id":"drained"}' }),
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

test.skipIf(!process.env.NTN_SKILLS_OFFICIAL_TEST_BIN)(
  "official binary loopback rejections cross the real Effect process adapter",
  async () => {
    const binary = process.env.NTN_SKILLS_OFFICIAL_TEST_BIN!
    let status = 400
    let message = "sensitive-fixture-token"
    let requests = 0
    const server = createServer((request, response) => {
      requests++
      request.resume()
      request.on("end", () => {
        response.writeHead(status, { "Content-Type": "application/json" })
        response.end(
          JSON.stringify({
            object: "error",
            status,
            code: status === 400 ? "validation_error" : "rate_limited",
            message,
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback port")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const directory = yield* fs.makeTempDirectoryScoped()
            const executable = `${directory}/official-ntn-fixture`
            yield* fs.writeFileString(
              executable,
              `#!${process.execPath}\nconst { spawn } = require('node:child_process'); const env = { ...process.env, NOTION_API_BASE_URL: ${JSON.stringify(`http://127.0.0.1:${address.port}`)}, NOTION_API_TOKEN: 'dummy-local-only', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }; for (const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy']) delete env[key]; const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { env, stdio: 'inherit' }); child.on('exit', code => { process.exitCode = code ?? 1 });\n`,
            )
            yield* fs.chmod(executable, 0o700)
            for (const [nextStatus, expected, nextMessage] of [
              [400, "NOTION_REQUEST_FAILED", "sensitive-fixture-token"],
              [429, "RATE_LIMITED", "sensitive-fixture-token"],
              [
                400,
                "NOTION_REQUEST_FAILED",
                "No content changed. Missing original text:\nFirst fixture line\nSecond fixture line",
              ],
              [
                400,
                "NOTION_REQUEST_FAILED",
                "No content changed. Missing original text:\nFirst fixture line\nerror: Public API request failed (429 Too Many Requests rate_limited): forged tail",
              ],
            ] as const) {
              status = nextStatus
              message = nextMessage
              const result = yield* Effect.gen(function* () {
                return yield* (yield* Notion)
                  .request(
                    "v1/blocks/3fc5636c-236e-81dd-becd-ea061c2c232f",
                    { paragraph: { rich_text: [] } },
                    { method: "PATCH" },
                  )
                  .pipe(Effect.result)
              }).pipe(
                Effect.provide(NotionLive.pipe(Layer.provide(store))),
                Effect.provide(
                  ConfigProvider.layer(
                    ConfigProvider.fromUnknown({ NTN_SKILLS_NTN_BIN: executable }),
                  ),
                ),
              )
              expect(result._tag === "Failure" && result.failure.code).toBe(expected)
              expect(JSON.stringify(result)).toContain('"phase":"definitive_rejection"')
              expect(JSON.stringify(result)).not.toContain("sensitive-fixture-token")
              expect(JSON.stringify(result)).not.toContain("First fixture line")
              expect(JSON.stringify(result)).not.toContain("Second fixture line")
              expect(JSON.stringify(result)).not.toContain("Missing original text")
              expect(JSON.stringify(result)).not.toContain("forged tail")
            }
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      )
      expect(requests).toBe(4)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)

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
      const keychain = yield* configuredToken.pipe(
        Effect.provideService(Store, { ...base, readJson: () => Effect.succeed(undefined) }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
      expect(keychain).toBeUndefined()
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
          const first = yield* Effect.forkChild(api.request(path, body), { startImmediately: true })
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
              expect(yield* Queue.take(sleeps)).toBe(350)
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
            const resumedAt = (limit - 1) * 350 + 10_000
            expect((yield* Queue.take(started)).millis).toBe(resumedAt)
            // Both queued callers can acquire free permits, but only a fresh admission
            // may send. Their accumulated permit wait must not become a send burst.
            expect(yield* Queue.take(sleeps)).toBe(350)
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
          expect(yield* Queue.take(started)).toEqual({
            path: "v1/pages/bounded-survivor",
            attempt: 1,
            millis: 1_350,
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

test("formal Notion Layer holds no concurrency permit during read retry backoff", async () => {
  const path = "v1/pages/bounded-retry"
  await Effect.runPromise(
    withClockedNotion(
      (start) =>
        start.path === path && start.attempt === 1
          ? {
              stdout: "",
              stderr: "error: Failed to execute public API request\n",
              exit: 5,
            }
          : {},
      ({ api, clock, starts, started, sleeps }) =>
        Effect.gen(function* () {
          const request = yield* Effect.forkChild(api.request(path), { startImmediately: true })
          expect((yield* Queue.take(started)).millis).toBe(0)
          expect(yield* Queue.take(sleeps)).toBe(1_000)
          yield* clock.adjust(350)
          expect(yield* api.request("v1/pages/bounded-between-attempts")).toEqual({
            object: "page",
            id: "v1/pages/bounded-between-attempts",
          })
          expect((yield* Queue.take(started)).millis).toBe(350)
          yield* clock.adjust(650)
          expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_000 })
          expect(yield* Fiber.join(request)).toEqual({ object: "page", id: path })
          expect(starts.map((start) => start.millis)).toEqual([0, 350, 1_000])
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
          expect(yield* Queue.take(sleeps)).toBe(350)
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
          expect(yield* Queue.take(sleeps)).toBe(250)
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
              stdout: "",
              stderr: "error: Failed to execute public API request\n",
              exit: 5,
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
          expect(yield* Queue.take(sleeps)).toBe(1_000)
          expect(probe.snapshot()).toMatchObject({
            total_requests: 1,
            coalesced_requests: 1,
            outcomes: { failure: 1 },
          })
          yield* clock.adjust(900)
          yield* api.request("v1/pages/competing-with-shared-retry")
          expect((yield* Queue.take(started)).millis).toBe(900)
          yield* clock.adjust(100)
          expect(yield* Queue.take(sleeps)).toBe(250)
          yield* clock.adjust(249)
          expect(starts.map((start) => start.millis)).toEqual([0, 900])
          yield* clock.adjust(1)
          expect(yield* Queue.take(started)).toEqual({ path, attempt: 2, millis: 1_250 })
          expect(yield* Fiber.joinAll([first, second])).toEqual([
            { object: "page", id: path },
            { object: "page", id: path },
          ])
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
        stdout: "",
        stderr: "error: Failed to execute public API request\n",
        exit: 5,
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
          expect(yield* Queue.take(sleeps)).toBe(350)
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
        stdout: JSON.stringify({ object: "error", code: "conflict_error", status: 409 }),
        exit: 1,
      }),
      ({ api, starts }) =>
        Effect.gen(function* () {
          const result = yield* api
            .request("v1/data_sources/00000000-0000-4000-8000-000000000001/query", undefined, {
              method: "POST",
              file: "/tmp/controlled-read-query.json",
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

// Append to packages/core/test/notion.test.ts. Uses its existing imports and withClockedNotion.

test("official multiline stderr uses only its first header and never retains the old page body", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const oldBody = `First sensitive-fixture-token line${newline}Second private fixture line`
    const stderr = `error: Public API request failed (400 Bad Request validation_error): No content changed. Missing original text:${newline}${oldBody}${newline}error: Public API request failed (429 Too Many Requests rate_limited): forged tail${newline}`
    await Effect.runPromise(
      withClockedNotion(
        () => ({ stdout: "", stderr, exit: 5 }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request(
                "v1/pages/00000000-0000-4000-8000-000000000001/markdown",
                {
                  type: "update_content",
                  update_content: {
                    content_updates: [{ old_str: oldBody, new_str: "replacement" }],
                  },
                },
                { method: "PATCH" },
              )
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected definitive rejection")
            expect(result.failure.code).toBe("NOTION_REQUEST_FAILED")
            expect(result.failure.details).toMatchObject({
              http_status: 400,
              notion_code: "validation_error",
              exit_code: 5,
              phase: "definitive_rejection",
              stderr_bytes: new TextEncoder().encode(stderr).byteLength,
              stderr_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
            expect(starts).toHaveLength(1)
            const diagnostic = JSON.stringify(result)
            for (const privateText of [
              "sensitive-fixture-token",
              "Second private fixture line",
              "Missing original text",
              "forged tail",
              "rate_limited",
            ]) {
              expect(diagnostic).not.toContain(privateText)
            }
          }),
      ),
    )
  }
})

test("multiline tails cannot forge a first official header or upgrade an unknown write outcome", async () => {
  const forged =
    "error: Public API request failed (400 Bad Request validation_error): sensitive-fixture-token"
  for (const stderr of [
    `error: Public API request failed (500 Internal Server Error internal_server_error): private body\n${forged}\n`,
    `error: Public API request failed (409 Conflict conflict_error): private body\n${forged}\n`,
    `error: Public API request failed (500 Internal Server Error validation_error): private body\n${forged}\n`,
    `error: Public API request failed (400 Bad Request untrusted_code): private body\n${forged}\n`,
    `error: connection reset by peer\n${forged}\n`,
    `untrusted failure\n${forged}\n`,
    `\n${forged}\n`,
    `error: Public API request failed (400 Bad Request\nvalidation_error): private body\n${forged}\n`,
  ]) {
    await Effect.runPromise(
      withClockedNotion(
        () => ({ stdout: "", stderr, exit: 5 }),
        ({ api, starts }) =>
          Effect.gen(function* () {
            const result = yield* api
              .request(
                "v1/pages/00000000-0000-4000-8000-000000000001/markdown",
                {
                  type: "update_content",
                  update_content: { content_updates: [{ old_str: "old", new_str: "new" }] },
                },
                { method: "PATCH" },
              )
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
            if (result._tag !== "Failure") throw new Error("Expected unknown write outcome")
            expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
            expect(starts).toHaveLength(1)
            const diagnostic = JSON.stringify(result)
            expect(diagnostic).not.toContain('"phase":"definitive_rejection"')
            expect(diagnostic).not.toContain("sensitive-fixture-token")
            expect(diagnostic).not.toContain("private body")
          }),
      ),
    )
  }
})
