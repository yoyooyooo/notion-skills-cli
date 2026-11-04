import { expect, spyOn, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, ConfigProvider, Duration, Effect, Exit, Fiber, Layer, Queue } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { discoverLinearSource, discoverSourceDefinition } from "../src/shared-source-adapters.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import type { SourceDefinitionInput } from "../src/shared-sources-model.ts"

const credential = "owned_linear_transport_token"
const input: SourceDefinitionInput = {
  version: 1,
  source_id: "linear-http-case",
  name: "linear-http-review",
  description: "Read the selected issue.",
  enabled: true,
  policy: "manual",
  adapter: {
    type: "linear",
    resources: [{ kind: "issue", id: "TEST-1", path: "SKILL.md" }],
  },
  selection: { roots: ["."], include: [], exclude: [], mapping: {} },
  options: {},
}
const issue = {
  id: "00000000-0000-4000-8000-000000000001",
  identifier: "TEST-1",
  title: "Review",
  description: "# Review\n\nKeep the exact selected instructions.\n",
  updatedAt: "2026-11-04T00:00:00Z",
}
type FetchRequest = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>

function configured<A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer> | HttpClient.HttpClient>,
  fetch: FetchRequest,
  token = credential,
) {
  return effect.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ LINEAR_API_KEY: token }))),
    Effect.provide(NodeServices.layer),
  )
}
function run<A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer> | HttpClient.HttpClient>,
  fetch: FetchRequest,
  token = credential,
) {
  return Effect.runPromise(configured(effect, fetch, token))
}

test("the default Linear source reader uses the supplied official HTTP service", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init })
    return Response.json({ data: { issue } })
  }
  const forbidden = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Uninjected global HTTP is forbidden in this test.")
      },
      {
        preconnect() {
          throw new Error("Uninjected preconnect is forbidden in this test.")
        },
      },
    ),
  )
  try {
    const result = await run(discoverLinearSource(input), fetch)
    expect(calls).toHaveLength(1)
    expect(forbidden).not.toHaveBeenCalled()
    expect(calls[0]?.url).toBe("https://api.linear.app/graphql")
    const init = calls[0]?.init
    expect(init?.method).toBe("POST")
    expect(init?.redirect).toBe("error")
    expect(new Headers(init?.headers).get("authorization")).toBe(credential)
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
    const body = init?.body
    expect(body).toBeInstanceOf(Uint8Array)
    if (!(body instanceof Uint8Array)) throw new Error("Expected encoded JSON request bytes.")
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      query:
        "query SourceResource($id: String!) { issue(id: $id) { id identifier title description updatedAt } }",
      variables: { id: "TEST-1" },
    })
    expect(result.revision).toMatch(/^linear-[a-f0-9]{64}$/u)
    expect(result.members[0]?.portable.files).toHaveLength(1)
    expect(new TextDecoder().decode(result.members[0]?.portable.files[0]?.bytes)).toContain(
      issue.description,
    )
  } finally {
    forbidden.mockRestore()
  }
})

test("Linear JSON bytes cross chunk boundaries intact and share the provider request ledger", async () => {
  const metrics = createRequestMetrics({ traceLimit: 20 })
  const description = "# Review\n\n保留完整中文、é 和 🧪。\n"
  const bytes = new TextEncoder().encode(
    JSON.stringify({ data: { issue: { ...issue, description } } }),
  )
  const split = bytes.findIndex((byte) => byte > 127) + 1
  const chunks = [bytes.slice(0, split), bytes.slice(split, split + 1), bytes.slice(split + 1)]
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks.shift()
          if (chunk === undefined) controller.close()
          else controller.enqueue(chunk)
        },
      },
      { highWaterMark: 0 },
    ),
  )
  const result = await run(discoverSourceDefinition(input, { metrics }), async () => response)
  expect(new TextDecoder().decode(result.members[0]?.portable.files[0]?.bytes)).toContain(
    description,
  )
  expect(metrics.snapshot()).toMatchObject({
    total_requests: 1,
    requests: { provider: 1, notion_write: 0, notion_metadata: 0, notion_body: 0 },
    provider_requests: { linear: 1 },
    response_bytes: bytes.byteLength,
    unknown_response_bytes: 0,
    in_flight: 0,
    outcomes: { success: 1, failure: 0, cancelled: 0 },
    trace_dropped: 0,
  })
  expect(metrics.snapshot().trace).toMatchObject([
    {
      event: "attempt",
      kind: "provider",
      target: null,
      method: "POST",
      http_status: 200,
      response_bytes: bytes.byteLength,
    },
  ])
  const ledger = JSON.stringify(metrics.snapshot())
  for (const privateText of [credential, "query SourceResource", "TEST-1", description])
    expect(ledger).not.toContain(privateText)
})

test("an exact 8 MiB response remains valid", async () => {
  const metrics = createRequestMetrics()
  const empty = JSON.stringify({ data: { issue }, padding: "" })
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      data: { issue },
      padding: "x".repeat(8 * 1024 * 1024 - new TextEncoder().encode(empty).byteLength),
    }),
  )
  expect(bytes.byteLength).toBe(8 * 1024 * 1024)
  const result = await run(
    discoverSourceDefinition(input, { metrics }),
    async () => new Response(bytes),
  )
  expect(result.members).toHaveLength(1)
  expect(metrics.snapshot()).toMatchObject({
    response_bytes: bytes.byteLength,
    in_flight: 0,
    outcomes: { success: 1 },
  })
})

for (const length of [undefined, "1"]) {
  test(
    "the first byte over 8 MiB cancels the body regardless of Content-Length " + String(length),
    async () => {
      const metrics = createRequestMetrics()
      let reads = 0
      let cancelled = false
      let signal: AbortSignal | undefined
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads += 1
              if (reads > 2) throw new Error("The reader must not request a third chunk.")
              controller.enqueue(new Uint8Array(reads === 1 ? 8 * 1024 * 1024 : 1))
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: length === undefined ? undefined : { "content-length": length },
        },
      )
      const error = await run(
        Effect.flip(discoverSourceDefinition(input, { metrics })),
        async (_url, init) => {
          signal = init?.signal ?? undefined
          return response
        },
      )
      expect(error.code).toBe("SOURCE_PROVIDER_LIMIT")
      expect(reads).toBe(2)
      expect(cancelled).toBe(true)
      expect(signal?.aborted).toBe(true)
      expect(metrics.snapshot()).toMatchObject({
        total_requests: 1,
        response_bytes: 8 * 1024 * 1024 + 1,
        in_flight: 0,
        outcomes: { success: 0, failure: 1, cancelled: 0 },
      })
    },
  )
}

for (const status of [302, 307, 401, 429, 503]) {
  test("HTTP " + status + " fails once without following or reading the error body", async () => {
    const metrics = createRequestMetrics({ traceLimit: 10 })
    let calls = 0
    let reads = 0
    let signal: AbortSignal | undefined
    const error = await run(
      Effect.flip(discoverSourceDefinition(input, { metrics })),
      async (_url, init) => {
        calls += 1
        signal = init?.signal ?? undefined
        expect(init?.redirect).toBe("error")
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                reads += 1
                throw new Error("An error response body must not be consumed.")
              },
            },
            { highWaterMark: 0 },
          ),
          {
            status,
            headers: { location: "https://unrelated.invalid/" + credential },
          },
        )
      },
    )
    expect(error.code).toBe("SOURCE_PROVIDER_FAILED")
    expect(error.details).toEqual({ status })
    expect(JSON.stringify(error)).not.toContain(credential)
    expect(calls).toBe(1)
    expect(reads).toBe(0)
    expect(signal?.aborted).toBe(true)
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 1,
      provider_requests: { linear: 1 },
      unknown_response_bytes: 1,
      in_flight: 0,
      outcomes: { success: 0, failure: 1, cancelled: 0 },
    })
    expect(metrics.snapshot().trace).toMatchObject([{ http_status: status }])
  })
}

test("a missing Linear credential stops before any HTTP attempt", async () => {
  const metrics = createRequestMetrics()
  let calls = 0
  const error = await run(
    Effect.flip(discoverSourceDefinition(input, { metrics })),
    async () => {
      calls += 1
      throw new Error("No HTTP attempt is permitted.")
    },
    "",
  )
  expect(error.code).toBe("SOURCE_AUTH_REQUIRED")
  expect(calls).toBe(0)
  expect(metrics.snapshot()).toMatchObject({ total_requests: 0, in_flight: 0 })
})

test("a missing response body retains the explicit invalid-provider outcome", async () => {
  const metrics = createRequestMetrics()
  const error = await run(
    Effect.flip(discoverSourceDefinition(input, { metrics })),
    async () => new Response(null),
  )
  expect(error.code).toBe("SOURCE_PROVIDER_INVALID")
  expect(metrics.snapshot()).toMatchObject({
    response_bytes: 0,
    in_flight: 0,
    outcomes: { failure: 1 },
  })
})

for (const failure of ["network", "stream", "json"]) {
  test(
    "a " + failure + " failure keeps transport internals out of public diagnostics",
    async () => {
      const metrics = createRequestMetrics()
      const error = await run(
        Effect.flip(discoverSourceDefinition(input, { metrics })),
        async () => {
          if (failure === "network") throw new Error("Private request Authorization=" + credential)
          if (failure === "json") return new Response("not-json-" + credential)
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  controller.error(new Error("Private stream " + credential))
                },
              },
              { highWaterMark: 0 },
            ),
          )
        },
      )
      expect(error.code).toBe("SOURCE_PROVIDER_FAILED")
      expect(JSON.stringify(error)).not.toContain(credential)
      expect(metrics.snapshot()).toMatchObject({
        total_requests: 1,
        in_flight: 0,
        outcomes: { success: 0, failure: 1, cancelled: 0 },
      })
    },
  )
}

test("GraphQL errors reject the candidate after a successful HTTP observation", async () => {
  const metrics = createRequestMetrics()
  const error = await run(Effect.flip(discoverSourceDefinition(input, { metrics })), async () =>
    Response.json({ data: { issue }, errors: [{ message: credential }] }),
  )
  expect(error.code).toBe("SOURCE_PROVIDER_PARTIAL")
  expect(JSON.stringify(error)).not.toContain(credential)
  expect(metrics.snapshot()).toMatchObject({
    total_requests: 1,
    in_flight: 0,
    outcomes: { success: 1, failure: 0, cancelled: 0 },
  })
})

for (const phase of ["headers", "body"]) {
  test("the 45 second deadline bounds " + phase + " without restarting after headers", async () => {
    const metrics = createRequestMetrics()
    const started = Promise.withResolvers<void>()
    const pulling = Promise.withResolvers<void>()
    const response = Promise.withResolvers<Response>()
    let signal: AbortSignal | undefined
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulling.resolve()
          return new Promise<void>(() => {})
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const fetch = (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener("abort", () => response.reject(new Error("Private " + credential)), {
        once: true,
      })
      started.resolve()
      return response.promise
    }
    await run(
      Effect.scoped(
        Effect.gen(function* () {
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
          const pending = yield* Effect.forkChild(
            discoverSourceDefinition(input, { metrics }).pipe(
              Effect.provideService(Clock.Clock, observedClock),
              Effect.result,
            ),
            { startImmediately: true },
          )
          expect(yield* Queue.take(sleeps)).toBe(45_000)
          yield* Effect.promise(() => started.promise)
          if (phase === "body") {
            yield* clock.adjust(20_000)
            response.resolve(new Response(body))
            yield* Effect.promise(() => pulling.promise)
            yield* clock.adjust(24_999)
          } else yield* clock.adjust(44_999)
          expect(pending.pollUnsafe()).toBeUndefined()
          yield* clock.adjust(1)
          const result = yield* Fiber.join(pending)
          expect(result._tag).toBe("Failure")
          if (result._tag !== "Failure") throw new Error("Expected the bounded timeout.")
          expect(result.failure.code).toBe("SOURCE_PROVIDER_TIMEOUT")
          expect(JSON.stringify(result.failure)).not.toContain(credential)
        }),
      ),
      fetch,
    )
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(phase === "body")
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 1,
      in_flight: 0,
      outcomes: { success: 0, failure: 1, cancelled: 0 },
    })
  })
}

for (const phase of ["headers", "body"]) {
  test(
    "external cancellation during " + phase + " closes the request without becoming a timeout",
    async () => {
      const metrics = createRequestMetrics()
      const started = Promise.withResolvers<void>()
      const pulling = Promise.withResolvers<void>()
      const stop = new AbortController()
      let signal: AbortSignal | undefined
      let cancelled = false
      const fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        signal = init?.signal ?? undefined
        started.resolve()
        if (phase === "headers")
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error(credential)), { once: true })
          })
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull() {
                  pulling.resolve()
                  return new Promise<void>(() => {})
                },
                cancel() {
                  cancelled = true
                },
              },
              { highWaterMark: 0 },
            ),
          ),
        )
      }
      const completion = Effect.runPromiseExit(
        configured(discoverSourceDefinition(input, { metrics }), fetch),
        { signal: stop.signal },
      )
      await started.promise
      if (phase === "body") await pulling.promise
      stop.abort()
      const exit = await completion
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(signal?.aborted).toBe(true)
      expect(cancelled).toBe(phase === "body")
      expect(metrics.snapshot()).toMatchObject({
        total_requests: 1,
        in_flight: 0,
        outcomes: { success: 0, failure: 0, cancelled: 1 },
      })
    },
  )
}

test("four active bodies bound discovery and one failure cancels siblings before later resources start", async () => {
  const metrics = createRequestMetrics()
  const many: SourceDefinitionInput = {
    ...input,
    adapter: {
      type: "linear",
      resources: Array.from({ length: 6 }, (_, index) => ({
        kind: "issue",
        id: "TEST-" + (index + 1),
        path: index === 0 ? "SKILL.md" : "references/" + index + ".md",
      })),
    },
  }
  const reading = Promise.withResolvers<void>()
  const requests: {
    signal: AbortSignal | undefined
    controller: ReadableStreamDefaultController<Uint8Array>
    cancelled: boolean
  }[] = []
  let pulls = 0
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const index = requests.length
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            requests.push({ signal: init?.signal ?? undefined, controller, cancelled: false })
          },
          pull() {
            pulls += 1
            if (pulls === 4) reading.resolve()
            return new Promise<void>(() => {})
          },
          cancel() {
            const request = requests[index]
            if (request) request.cancelled = true
          },
        },
        { highWaterMark: 0 },
      ),
    )
  }
  const stop = new AbortController()
  let watchdogFired = false
  const timeout = setTimeout(() => {
    watchdogFired = true
    stop.abort()
  }, 2_000)
  const completion = Effect.runPromiseExit(
    configured(discoverSourceDefinition(many, { metrics }), fetch),
    { signal: stop.signal },
  )
  try {
    await Promise.race([
      reading.promise,
      completion.then(() => {
        throw new Error("Discovery ended before four bodies were active.")
      }),
    ])
    expect(requests).toHaveLength(4)
    expect(metrics.snapshot()).toMatchObject({ peak_concurrency: 4, in_flight: 4 })
    requests[0]?.controller.error(new Error("Private stream " + credential))
    expect(Exit.isFailure(await completion)).toBe(true)
    expect(watchdogFired).toBe(false)
    expect(requests).toHaveLength(4)
    expect(requests.every((request) => request.signal?.aborted)).toBe(true)
    expect(requests.slice(1).every((request) => request.cancelled)).toBe(true)
    expect(metrics.snapshot()).toMatchObject({
      total_requests: 4,
      provider_requests: { linear: 4 },
      in_flight: 0,
      peak_concurrency: 4,
      outcomes: { success: 0, failure: 1, cancelled: 3 },
    })
  } finally {
    clearTimeout(timeout)
    stop.abort()
    await completion
  }
})
