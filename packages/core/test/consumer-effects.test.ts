import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { consume, type ConsumptionEffects } from "../src/consumer.ts"
import { withConsumptionEffects, withConsumptionRetention } from "../src/consumption-effects.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { readSkill } from "../src/snapshot.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"

const noWrites: ConsumptionEffects = {
  version: 1,
  remote_writes: "none",
  author_content: "unchanged",
  retention: [],
}
const input = (root: string) => ({
  version: 1,
  targets: [root],
  purpose: "use",
  freshness: { policy: "refresh" },
})

test("current consume discloses both root and required retention without author writes", async () => {
  const f = nativeGraphFixture({ width: 1 })
  const result = await f.run(consume(input(f.pageIds[0]!)))
  expect(result.status).toBe("ready")
  const effects = property(property(result).effects)
  expect(effects.remote_writes).toBe("retained")
  expect(effects.author_content).toBe("unchanged")
  expect(effects.retention).toEqual(
    expect.arrayContaining(
      f.pageIds.map((id) => expect.objectContaining({ skill_page_id: id, status: "confirmed" })),
    ),
  )
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(6)
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
  f.clearCalls()
  const repeated = await f.run(consume(input(f.pageIds[0]!)))
  expect(property(repeated).effects).toEqual(noWrites)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(0)
  const strict = await f.run(consume(input(f.pageIds[0]!), { readOnly: true }))
  expect(strict.status).toBe("ready")
  expect(strict.effects).toEqual(noWrites)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(0)
})

test("strict current consume and scalar read refuse retention before the first write", async () => {
  for (const mode of ["consume", "read"] as const) {
    const f = nativeGraphFixture({ width: 1 })
    if (mode === "consume") {
      const result = await f.run(consume(input(f.pageIds[0]!), { readOnly: true }))
      expect(result.status).toBe("failed")
      expect(property(result).effects).toEqual(noWrites)
    } else {
      const result = await f.run(
        readSkill(f.pageIds[0]!, { readOnly: true, refresh: true }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected a read-only refusal")
      expect(property(result.failure.details).effects).toEqual(noWrites)
    }
    expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
  }
})

test("fixed read-only consumption keeps exact historical bytes and proves no remote writes", async () => {
  const f = nativeGraphFixture({ width: 1 })
  const first = await f.run(consume(input(f.pageIds[0]!)))
  if (first.status !== "ready") throw new Error(JSON.stringify(first))
  const root = first.preparation.roots[0]?.ref
  if (!root) throw new Error("Missing fixed root")
  f.bodies.set(f.pageIds[0]!, "new author content\n")
  f.clearCalls()
  const fixed = await f.run(
    consume({ version: 1, targets: [root], purpose: "use" }, { readOnly: true }),
  )
  expect(fixed.status).toBe("ready")
  expect(property(fixed).effects).toEqual(noWrites)
  const scalar = await f.run(readSkill(root, { readOnly: true }))
  expect(property(scalar).effects).toEqual(noWrites)
  expect("content" in scalar && scalar.content).toContain("# a instruction")
  expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
})

test("an acknowledged retention write with a lost response stays unknown in a failed result", async () => {
  const f = nativeGraphFixture({ width: 1 })
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* consume(input(f.pageIds[0]!)).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api
              .request(path, body, options)
              .pipe(
                Effect.flatMap((value) =>
                  path === "v1/pages"
                    ? Effect.fail(fail("NOTION_UNAVAILABLE", "Controlled response loss"))
                    : Effect.succeed(value),
                ),
              ),
        }),
      )
    }),
  )
  expect(result.status).toBe("failed")
  const effects = property(property(result).effects)
  expect(effects.remote_writes).toBe("unknown")
  expect(effects.author_content).toBe("unchanged")
  expect(effects.retention).toEqual([
    expect.objectContaining({ skill_page_id: f.pageIds[0], status: "unknown" }),
  ])
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
})

test("a missing required body preserves the root's confirmed retention in the failed receipt", async () => {
  const f = nativeGraphFixture({ width: 1 })
  f.bodies.delete(f.pageIds[1]!)
  const result = await f.run(consume(input(f.pageIds[0]!)))
  if (result.status !== "failed") throw new Error("Expected an incomplete required graph")
  expect(result.effects.remote_writes).toBe("retained")
  expect(result.effects.author_content).toBe("unchanged")
  expect(result.effects.retention).toEqual([
    expect.objectContaining({ skill_page_id: f.pageIds[0], status: "confirmed" }),
  ])
  expect(property(result.error.details).effects).toEqual(result.effects)
  expect(property(property(result.error.details).preparation).status).toBe("partial")
  expect("delivery" in result).toBe(false)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(3)
})

test("cancellation after a retention ACK waits for cleanup and preserves an unknown write outcome", async () => {
  const f = nativeGraphFixture({ width: 1 })
  const stop = new AbortController()
  let released = 0
  const result = await f.run(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const api = yield* Notion
      const running = yield* Effect.forkChild(
        consume(input(f.pageIds[0]!), { signal: stop.signal }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              api.request(path, body, options).pipe(
                Effect.flatMap((value) =>
                  path !== "v1/pages"
                    ? Effect.succeed(value)
                    : Effect.gen(function* () {
                        yield* Deferred.succeed(entered, undefined)
                        return yield* Effect.never
                      }).pipe(
                        Effect.ensuring(
                          Effect.sync(() => {
                            released++
                          }),
                        ),
                      ),
                ),
              ),
          }),
        ),
        { startImmediately: true },
      )
      yield* Deferred.await(entered)
      stop.abort()
      return yield* Fiber.join(running)
    }),
  )
  expect(released).toBe(1)
  expect(result.status).toBe("cancelled")
  expect(result.effects.remote_writes).toBe("unknown")
  expect(result.effects.author_content).toBe("unchanged")
  expect(result.effects.retention).toEqual([
    expect.objectContaining({ skill_page_id: f.pageIds[0], status: "unknown" }),
  ])
  expect("preparation" in result).toBe(false)
  expect("delivery" in result).toBe(false)
  expect(f.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
})

test("a write outside the exact Records create boundary cannot claim retention or unchanged author content", async () => {
  const f = nativeGraphFixture({ width: 0 })
  const result = await f.run(
    withConsumptionEffects(
      withConsumptionRetention(
        Effect.gen(function* () {
          const api = yield* Notion
          yield* api.request(
            `v1/pages/${f.pageIds[0]}/markdown`,
            { markdown: "edited" },
            { method: "PATCH" },
          )
          return {}
        }),
        { skill_page_id: f.pageIds[0]!, file_id: "main-a", operation_id: "test-operation" },
        f.descriptor.records.data_source_id,
      ),
    ),
  )
  expect(result.effects).toEqual({
    ...noWrites,
    remote_writes: "unknown",
    author_content: "unknown",
  })
})

test("strict mode rejects an unclassified descendant write before transport dispatch", async () => {
  const f = nativeGraphFixture({ width: 0 })
  const result = await f.run(
    withConsumptionEffects(
      Effect.gen(function* () {
        const api = yield* Notion
        yield* api.request(
          `v1/pages/${f.pageIds[0]}/markdown`,
          { markdown: "edited" },
          { method: "PATCH" },
        )
        return {}
      }),
      { readOnly: true },
    ).pipe(Effect.result),
  )
  if (result._tag !== "Failure") throw new Error("Expected a read-only capability refusal")
  expect(result.failure.code).toBe("NOTION_READ_ONLY")
  expect(property(result.failure.details).effects).toEqual(noWrites)
  expect(f.calls).toHaveLength(0)
})
