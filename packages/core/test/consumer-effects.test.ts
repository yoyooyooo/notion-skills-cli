import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { withConsumptionEffects, type ConsumptionEffects } from "../src/consumption-effects.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import {
  currentLibrary,
  currentScope,
  currentSkillPage,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

const noWrites: ConsumptionEffects = {
  version: 1,
  remote_writes: "none",
  author_content: "unchanged",
  retention: [],
}
const current = () =>
  openSharedSnapshot({
    library: currentLibrary,
    target: currentSkillPage,
    scope: currentScope,
    startedAt: Date.now(),
  })

test("current body observation reports zero remote writes on success", async () => {
  const f = currentSnapshotFixture()
  const observed: ConsumptionEffects[] = []
  const result = await f.run(
    withConsumptionEffects(current(), { onEffects: (value) => observed.push(value) }),
  )
  expect(result.effects).toEqual(noWrites)
  expect(observed).toEqual([noWrites])
  expect(result.files).toHaveLength(3)
  expect(f.semanticWrites()).toEqual([])
})

test("incomplete current bodies report zero writes and preserve the original error", async () => {
  const f = currentSnapshotFixture()
  f.bodies.delete(f.files[0]!.id)
  const observed: ConsumptionEffects[] = []
  const result = await f.run(
    withConsumptionEffects(current(), { onEffects: (value) => observed.push(value) }).pipe(
      Effect.result,
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected the missing current body to fail")
  expect(result.failure.code).toBe("NOTION_NOT_FOUND")
  expect(property(result.failure.details).effects).toEqual(noWrites)
  expect(observed).toEqual([noWrites])
  expect(f.semanticWrites()).toEqual([])
})

test("consumption rejects descendant writes before dispatch with no opt-in flag", async () => {
  const f = currentSnapshotFixture()
  const result = await f.run(
    withConsumptionEffects(
      Effect.gen(function* () {
        const api = yield* Notion
        yield* api.request(
          `v1/pages/${currentSkillPage}/markdown`,
          { markdown: "edited" },
          { method: "PATCH" },
        )
        return {}
      }),
    ).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected semantic-write refusal")
  expect(result.failure.code).toBe("NOTION_READ_ONLY")
  expect(property(result.failure.details).effects).toEqual(noWrites)
  expect(f.calls).toEqual([])
})

test("cancelling a current observation waits for body cleanup and reports zero writes", async () => {
  const f = currentSnapshotFixture()
  const observed: ConsumptionEffects[] = []
  let released = 0
  await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const entered = yield* Deferred.make<void>()
      const running = yield* Effect.forkChild(
        withConsumptionEffects(current(), { onEffects: (value) => observed.push(value) }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path.includes("/markdown")
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(
                      Effect.sync(() => {
                        released++
                      }),
                    ),
                  )
                : api.request(path, body, options),
          }),
        ),
        { startImmediately: true },
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(running)
    }),
  )
  expect(released).toBe(1)
  expect(observed).toEqual([noWrites])
  expect(f.semanticWrites()).toEqual([])
})
