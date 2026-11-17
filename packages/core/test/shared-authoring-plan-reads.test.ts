import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { fail, property, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  outsideAuthoringPlanReads,
  withAuthoringPlanReads,
} from "../src/shared-authoring-plan-reads.ts"

const page = "00000000-0000-4000-8000-000000000001"
const path = `v1/pages/${page}`
const query = `v1/data_sources/${page}/query`
const service = (request: Notion["Service"]["request"], readOnly = false): Notion["Service"] => ({
  request,
  version: Effect.succeed("fixture-version"),
  credentialIdentity: Effect.succeed("fixture-credential"),
  ...(readOnly ? { readOnly: true as const } : {}),
})
const run = <A, E>(effect: Effect.Effect<A, E, Notion>, api: Notion["Service"]) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Notion, api)))
const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkChild(effect, { startImmediately: true })

test("one read-only planning scope shares observations but not mutable result objects or later invocations", async () => {
  let calls = 0
  const api = service(() => Effect.sync(() => ({ value: ++calls, child: { unchanged: true } })))
  const prepared = withAuthoringPlanReads(
    Effect.gen(function* () {
      const scoped = yield* Notion
      expect(scoped.readOnly).toBe(true)
      const one = yield* scoped.request(path)
      property(property(one).child).unchanged = false
      const two = yield* scoped.request(path)
      expect(two).toEqual({ value: 1, child: { unchanged: true } })
      expect(calls).toBe(1)
      const nested = yield* withAuthoringPlanReads((yield* Notion).request(path))
      expect(nested).toEqual(two)
    }),
  )
  await run(prepared, api)
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        expect(yield* (yield* Notion).request(path)).toEqual({
          value: 2,
          child: { unchanged: true },
        })
      }),
    ),
    api,
  )
  expect(calls).toBe(2)
})

test("complete path, pagination body and transport options distinguish cached reads", async () => {
  let calls = 0
  const api = service(() => Effect.sync(() => ({ request: ++calls })))
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const n = yield* Notion
        for (const request of [
          () => n.request(path),
          () => n.request(path + "/markdown?markdown_version=v2"),
          () => n.request(query, { filter: { value: "one" }, start_cursor: null }),
          () => n.request(query, { filter: { value: "two" }, start_cursor: null }),
          () => n.request(query, { filter: { value: "one" }, start_cursor: "next" }),
          () =>
            n.request(query, { filter: { value: "one" }, start_cursor: null }, { content: "body" }),
        ]) {
          const one = yield* request()
          expect(yield* request()).toEqual(one)
        }
      }),
    ),
    api,
  )
  expect(calls).toBe(6)
})

test("mutations and file-upload requests cannot leave a planning transport", async () => {
  let calls = 0
  const api = service(() => Effect.sync(() => ({ request: ++calls })))
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const n = yield* Notion
        for (const execute of [
          n.request("v1/pages", { parent: {} }),
          n.request(path, { properties: {} }, { method: "PATCH" }),
          n.request(query, undefined, { file: "/owned/upload" }),
        ]) {
          const result = yield* execute.pipe(Effect.result)
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { code: "SHARED_PLAN_READ_ONLY" },
          })
        }
        expect(calls).toBe(0)
      }),
    ),
    api,
  )
})

test("dispatch escapes the read scope and fresh guards see edits made after planning", async () => {
  let revision = "A",
    reads = 0,
    writes = 0
  const api = service((_path, _body, options) =>
    Effect.sync(() => {
      if (options?.method === "PATCH") {
        writes++
        revision = "C"
      } else reads++
      return { revision }
    }),
  )
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const planned = yield* Notion
        expect(yield* planned.request(path)).toEqual({ revision: "A" })
        revision = "B"
        yield* outsideAuthoringPlanReads(
          Effect.gen(function* () {
            const current = yield* Notion
            expect(current).toBe(api)
            expect(current.readOnly).toBeUndefined()
            expect(yield* current.request(path)).toEqual({ revision: "B" })
            yield* current.request(path, {}, { method: "PATCH" })
          }),
        )
        expect(yield* planned.request(path)).toEqual({ revision: "C" })
        revision = "D"
        expect(yield* planned.request(path)).toEqual({ revision: "D" })
      }),
    ),
    api,
  )
  expect(reads).toBe(4)
  expect(writes).toBe(1)
})

test("a late pre-write producer cannot seed or attract fresh post-boundary reads", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const api = service(() =>
        Effect.suspend(() => {
          const request = ++calls
          return request === 1
            ? Deferred.await(gate).pipe(Effect.as({ revision: "old" }))
            : Effect.succeed({ revision: "new" })
        }),
      )
      yield* withAuthoringPlanReads(
        Effect.gen(function* () {
          const planner = yield* Notion
          const pending = yield* fork(planner.request(path))
          expect(calls).toBe(1)
          yield* outsideAuthoringPlanReads(Effect.void)
          expect(yield* planner.request(path)).toEqual({ revision: "new" })
          expect(calls).toBe(2)
          yield* Deferred.succeed(gate, undefined)
          expect(yield* Fiber.join(pending)).toEqual({ revision: "old" })
          expect(yield* planner.request(path)).toEqual({ revision: "new" })
          expect(calls).toBe(3)
        }),
      ).pipe(Effect.provideService(Notion, api))
    }),
  )
})

test("one cancelled reader does not cancel a sibling; failures and abandoned producers never become cache hits", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const api = service(() =>
        Effect.suspend(() => {
          calls++
          return Deferred.await(gate).pipe(Effect.as({ read: true }))
        }),
      )
      yield* withAuthoringPlanReads(
        Effect.gen(function* () {
          const n = yield* Notion
          const first = yield* fork(n.request(path))
          const second = yield* fork(n.request(path))
          expect(calls).toBe(1)
          yield* Fiber.interrupt(first)
          expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true)
          yield* Deferred.succeed(gate, undefined)
          expect(yield* Fiber.join(second)).toEqual({ read: true })
          expect(yield* n.request(path)).toEqual({ read: true })
          expect(calls).toBe(1)
        }),
      ).pipe(Effect.provideService(Notion, api))
    }),
  )
  let attempts = 0
  const failing = service(() =>
    Effect.suspend(
      (): Effect.Effect<unknown, SkillsError> =>
        ++attempts === 1
          ? Effect.fail(fail("ACCESS_DENIED", "No permission"))
          : Effect.succeed({ allowed: true }),
    ),
  )
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const n = yield* Notion
        expect(yield* n.request(path).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "ACCESS_DENIED" },
        })
        expect(yield* n.request(path)).toEqual({ allowed: true })
        expect(attempts).toBe(2)
      }),
    ),
    failing,
  )
})

test("read-only original authority cannot be upgraded by leaving a plan", async () => {
  const api = service(
    (_path, _body, options) =>
      options?.method === "PATCH"
        ? Effect.fail(fail("READ_ONLY", "Original caller forbids writes"))
        : Effect.succeed({}),
    true,
  )
  await run(
    withAuthoringPlanReads(
      outsideAuthoringPlanReads(
        Effect.gen(function* () {
          const current = yield* Notion
          expect(current).toBe(api)
          expect(current.readOnly).toBe(true)
          expect(
            yield* current.request(path, {}, { method: "PATCH" }).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure", failure: { code: "READ_ONLY" } })
        }),
      ),
    ),
    api,
  )
})

test("escaping planning cannot unwrap an inner caller's read-only or foreign authenticated service", async () => {
  let outerWrites = 0
  const outer = service(() =>
    Effect.sync(() => {
      outerWrites++
      return {}
    }),
  )
  const restricted = service(
    () => Effect.fail(fail("INNER_READ_ONLY", "Do not unwrap this guard")),
    true,
  )
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const result = yield* outsideAuthoringPlanReads(
          Effect.gen(function* () {
            const api = yield* Notion
            expect(api).toBe(restricted)
            return yield* api.request(path, {}, { method: "PATCH" })
          }),
        ).pipe(Effect.provideService(Notion, restricted), Effect.result)
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INNER_READ_ONLY" } })
      }),
    ),
    outer,
  )
  expect(outerWrites).toBe(0)
})

test("planning memory is bounded: excess keys and large responses bypass memoization without evicting live work", async () => {
  let calls = 0
  const api = service(() => Effect.sync(() => ({ call: ++calls })))
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const n = yield* Notion
        for (let i = 0; i < 128; i++) yield* n.request(path + "?field=" + i)
        yield* n.request(path + "?field=0")
        expect(calls).toBe(128)
        yield* n.request(path + "?field=128")
        yield* n.request(path + "?field=128")
        expect(calls).toBe(130)
      }),
    ),
    api,
  )
  let bigCalls = 0
  const large = service(() =>
    Effect.sync(() => ({ blob: "x".repeat(8 * 1024 * 1024), call: ++bigCalls })),
  )
  await run(
    withAuthoringPlanReads(
      Effect.gen(function* () {
        const n = yield* Notion
        yield* n.request(path)
        yield* n.request(path)
      }),
    ),
    large,
  )
  expect(bigCalls).toBe(2)
})
