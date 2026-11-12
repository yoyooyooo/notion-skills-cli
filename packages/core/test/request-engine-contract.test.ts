import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Option, Redacted, Semaphore } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Notion, NotionTransport } from "../src/notion.ts"
import { NotionCredentialProvider } from "../src/notion-credential.ts"
import {
  makeRequestScheduler,
  NotionRequestScheduler,
  type RequestScheduleState,
} from "../src/notion-request-scheduler.ts"
import { makeRequestBudget, RequestBudget } from "../src/request-budget.ts"

function controlledTransport(input: {
  readonly statuses?: readonly number[]
  readonly delay?: number
  readonly timeout?: number
  readonly gate?: Effect.Effect<void>
  readonly started?: () => void
}) {
  const sent: string[] = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      sent.push(url.pathname)
      input.started?.()
      if (input.gate) yield* input.gate
      if (input.delay) yield* Effect.sleep(input.delay)
      const statuses = input.statuses ?? [200]
      const status = statuses[Math.min(sent.length - 1, statuses.length - 1)] ?? 200
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            status === 200
              ? { object: "page", id: url.pathname }
              : { object: "error", code: "internal_server_error", status, message: "Controlled" },
          ),
          { status, headers: { "content-type": "application/json" } },
        ),
      )
    }),
  )
  const layer = NotionTransport.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(NotionCredentialProvider, {
          resolve: Effect.succeed({
            token: Redacted.make("request-engine-contract-token"),
            identity: "request-engine-contract",
          }),
        }),
        Layer.succeed(NotionRequestScheduler, {
          acquire: () => Effect.void,
          withAdmission: (_credential, _deadline, _permits, attempt) => attempt,
          cooldown: () => Effect.void,
        }),
      ),
    ),
  )
  return {
    sent,
    run: <A, E>(effect: Effect.Effect<A, E, Notion>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                NTN_SKILLS_REQUEST_TIMEOUT_MS: String(input.timeout ?? 1_000),
              }),
            ),
          ),
        ),
      ),
  }
}

test("FV07 a shared key cannot borrow another invocation budget", async () => {
  const gate = Deferred.makeUnsafe<void>()
  const started = Deferred.makeUnsafe<void>()
  const f = controlledTransport({
    gate: Deferred.await(gate),
    started: () => Deferred.doneUnsafe(started, Effect.void),
  })
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const joined = yield* Deferred.make<void>()
      if (!api.metrics) throw new Error("Formal transport metrics are required")
      const noteJoin = api.metrics.coalesced
      api.metrics.coalesced = () => {
        noteJoin()
        Deferred.doneUnsafe(joined, Effect.void)
      }
      const firstBudget = yield* makeRequestBudget("first-invocation", {
        requests: 2,
        bytes: 10000,
        duration_ms: 1000,
      })
      const exhaustedBudget = yield* makeRequestBudget("exhausted-invocation", {
        requests: 1,
        bytes: 10000,
        duration_ms: 1000,
      })
      yield* exhaustedBudget.admit(0)
      const first = yield* Effect.forkChild(
        api
          .request("v1/pages/budget-partition")
          .pipe(Effect.provideService(RequestBudget, firstBudget)),
        { startImmediately: true },
      )
      yield* Deferred.await(started)
      const second = yield* Effect.forkChild(
        api
          .request("v1/pages/budget-partition")
          .pipe(Effect.provideService(RequestBudget, exhaustedBudget), Effect.result),
        { startImmediately: true },
      )
      // Rendezvous on either independent rejection or the wrong shared join.
      yield* Effect.race(Fiber.await(second), Deferred.await(joined))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      return yield* Fiber.join(second)
    }),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
  expect(f.sent).toHaveLength(1)
})

test("FV07 an uncertain mutation is observed once even when the next response would succeed", async () => {
  const f = controlledTransport({ statuses: [500, 200] })
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* api
        .request("v1/pages/unknown-write", { archived: true }, { method: "PATCH" })
        .pipe(Effect.result)
    }),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.sent).toHaveLength(1)
})

test("FV07 a single HTTP attempt timeout remains independent of admission", async () => {
  const f = controlledTransport({ delay: 80, timeout: 5 })
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* api
        .request("v1/pages/attempt-timeout", { archived: true }, { method: "PATCH" })
        .pipe(Effect.result)
    }),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") {
    expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(result.failure.details).toMatchObject({ phase: "outcome_unknown", reason: "timeout" })
  }
  expect(f.sent).toHaveLength(1)
})

test("FV07 cooled queue holds a lease without a network permit and cancellation removes it", async () => {
  const rows = new Set<string>()
  let attempts = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>()
      const state: RequestScheduleState = {
        enqueue: (entry) =>
          Effect.sync(() => {
            rows.add(entry.id)
          }),
        remove: (id) =>
          Effect.sync(() => {
            rows.delete(id)
          }),
        claim: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(claimed, undefined)
            return { admitted: false, at: Date.now() + 1_000 } as const
          }),
        defer: () => Effect.void,
      }
      const scheduler = yield* makeRequestScheduler(state)
      const permits = yield* Semaphore.make(1)
      const fiber = yield* Effect.forkChild(
        scheduler.withAdmission(
          "scope",
          BigInt(1e18),
          permits,
          Effect.sync(() => {
            attempts++
          }),
          {},
        ),
        { startImmediately: true },
      )
      yield* Deferred.await(claimed)
      expect(attempts).toBe(0)
      expect(rows.size).toBe(1)
      const available = yield* permits.withPermitsIfAvailable(1)(Effect.succeed("available"))
      expect(Option.isSome(available)).toBe(true)
      yield* Fiber.interrupt(fiber)
      expect(rows.size).toBe(0)
      expect(attempts).toBe(0)
    }),
  )
})
