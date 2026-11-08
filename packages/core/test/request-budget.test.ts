import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Notion, NotionTransport } from "../src/notion.ts"
import { NotionCredentialProvider } from "../src/notion-credential.ts"
import { NotionRequestScheduler } from "../src/notion-request-scheduler.ts"
import { makeRequestBudget, RequestBudget } from "../src/request-budget.ts"
import { requestBudgetHttpClient } from "../src/request-budget-http.ts"

function transport(responses: readonly number[], queueDelay = 0, responseDelay = 0) {
  const sent: string[] = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      sent.push(url.pathname)
      if (responseDelay) yield* Effect.sleep(responseDelay)
      const status = responses[Math.min(sent.length - 1, responses.length - 1)] ?? 200
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            status === 200
              ? { object: "page", id: url.pathname, padding: "x".repeat(100) }
              : {
                  object: "error",
                  code: "internal_server_error",
                  message: "Controlled retry",
                  status,
                },
          ),
          { status, headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(NotionCredentialProvider, {
      resolve: Effect.succeed({
        token: Redacted.make("controlled-budget-token"),
        identity: "controlled-budget",
      }),
    }),
    Layer.succeed(NotionRequestScheduler, {
      acquire: () => Effect.void,
      withAdmission: (_credential, _deadline, _permits, attempt) =>
        Effect.sleep(queueDelay).pipe(Effect.andThen(attempt)),
      cooldown: () => Effect.void,
    }),
  )
  const layer = NotionTransport.pipe(Layer.provide(dependencies))
  return {
    sent,
    run: <A, E>(effect: Effect.Effect<A, E, Notion>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}

test("request budget stops a real retry before its second transport attempt", async () => {
  const f = transport([500, 200])
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const budget = yield* makeRequestBudget("retry-one", {
        requests: 1,
        bytes: 1_000_000,
        duration_ms: 1000,
      })
      const outcome = yield* api
        .request("v1/pages/one")
        .pipe(Effect.provideService(RequestBudget, budget), Effect.result)
      return { outcome, budget: yield* budget.snapshot, metrics: api.requestMetrics?.() }
    }),
  )
  expect(result.outcome._tag).toBe("Failure")
  if (result.outcome._tag === "Failure")
    expect(result.outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
  expect(f.sent).toHaveLength(1)
  expect(result.budget.attempts).toBe(1)
  expect(result.metrics?.total_requests).toBe(1)
})

test("budgeted retries and ordinary unbudgeted requests preserve existing transport behavior", async () => {
  for (const limited of [true, false]) {
    const f = transport([500, 200])
    const count = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const budget = yield* makeRequestBudget(`two-${limited}`, {
          requests: 2,
          bytes: 1_000_000,
          duration_ms: 1000,
        })
        if (limited)
          yield* api.request("v1/pages/retry").pipe(Effect.provideService(RequestBudget, budget))
        else yield* api.request("v1/pages/retry")
        return api.requestMetrics?.().total_requests
      }),
    )
    expect(count).toBe(2)
    expect(f.sent).toHaveLength(2)
  }
})

test("concurrent callers cannot bypass one admitted response byte overshoot", async () => {
  const f = transport([200])
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const budget = yield* makeRequestBudget("parallel-byte", {
        requests: 20,
        bytes: 1,
        duration_ms: 1000,
      })
      const outcomes = yield* Effect.forEach(
        [1, 2, 3, 4, 5, 6],
        (id) => api.request(`v1/pages/${id}`).pipe(Effect.result),
        { concurrency: 6 },
      ).pipe(Effect.provideService(RequestBudget, budget))
      return { outcomes, budget: yield* budget.snapshot }
    }),
  )
  expect(result.outcomes.filter((result) => result._tag === "Success")).toHaveLength(1)
  expect(f.sent).toHaveLength(1)
  expect(result.budget.attempts).toBe(1)
  expect(result.budget.byte_overshoot).toBe(result.budget.response_bytes - 1)
  expect(result.budget.maximum_in_flight).toBe(1)
})

test("queue waits consume deadline before an actual attempt can be admitted", async () => {
  const f = transport([200], 30)
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const budget = yield* makeRequestBudget("queue-expired", {
        requests: 10,
        bytes: 1000,
        duration_ms: 5,
      })
      const outcome = yield* api
        .request("v1/pages/delayed")
        .pipe(Effect.provideService(RequestBudget, budget), Effect.result)
      return { outcome, budget: yield* budget.snapshot }
    }),
  )
  expect(result.outcome._tag).toBe("Failure")
  expect(f.sent).toHaveLength(0)
  expect(result.budget.attempts).toBe(0)
  expect(result.budget.exhausted).toBe("duration")
  expect(result.budget.elapsed_ms).toBeGreaterThanOrEqual(5)
})

test("a known request body must fit the remaining byte allowance before transport admission", async () => {
  const f = transport([200])
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const budget = yield* makeRequestBudget("request-too-large", {
        requests: 10,
        bytes: 1,
        duration_ms: 1000,
      })
      const outcome = yield* api
        .request("v1/data_sources/controlled/query", { page_size: 100 })
        .pipe(Effect.provideService(RequestBudget, budget), Effect.result)
      return { outcome, budget: yield* budget.snapshot, metrics: api.requestMetrics?.() }
    }),
  )
  expect(result.outcome._tag).toBe("Failure")
  expect(f.sent).toHaveLength(0)
  expect(result.budget.attempts).toBe(0)
  expect(result.budget.request_bytes).toBe(0)
  expect(result.budget.exhausted).toBe("bytes")
  expect(result.metrics?.total_requests).toBe(0)
})

test("an admitted slow Notion response ends at the invocation deadline and preserves uncertain write semantics", async () => {
  for (const write of [false, true]) {
    const f = transport([200], 0, 500)
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const budget = yield* makeRequestBudget(`slow-${write}`, {
          requests: 10,
          bytes: 1000,
          duration_ms: 15,
        })
        const outcome = yield* api
          .request(
            "v1/pages/slow",
            write ? { archived: true } : undefined,
            write ? { method: "PATCH" } : undefined,
          )
          .pipe(Effect.provideService(RequestBudget, budget), Effect.result)
        return { outcome, budget: yield* budget.snapshot, metrics: api.requestMetrics?.() }
      }),
    )
    expect(result.outcome._tag).toBe("Failure")
    if (result.outcome._tag === "Failure")
      expect(result.outcome.failure.code).toBe(
        write ? "WRITE_OUTCOME_UNKNOWN" : "REQUEST_BUDGET_EXHAUSTED",
      )
    expect(f.sent).toHaveLength(1)
    expect(result.budget.attempts).toBe(1)
    expect(result.budget.exhausted).toBe("duration")
    expect(result.budget.elapsed_ms).toBeLessThan(400)
    expect(result.metrics?.in_flight).toBe(0)
  }
})

test("a stalled provider response stream cannot outlive the invocation deadline", async () => {
  let sent = 0,
    cancelled = false
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      sent++
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelled = true
            },
          }),
        ),
      )
    }),
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const budget = yield* makeRequestBudget("provider-stalled", {
        requests: 10,
        bytes: 1000,
        duration_ms: 15,
      })
      const outcome = yield* requestBudgetHttpClient(client, budget)
        .get("https://provider.test/exact")
        .pipe(Effect.result)
      return { outcome, budget: yield* budget.snapshot }
    }),
  )
  expect(result.outcome._tag).toBe("Failure")
  expect(sent).toBe(1)
  expect(cancelled).toBe(true)
  expect(result.budget.attempts).toBe(1)
  expect(result.budget.exhausted).toBe("duration")
  expect(result.budget.elapsed_ms).toBeLessThan(400)
})
