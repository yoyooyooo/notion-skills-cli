import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, Layer, Schema } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  withCurrentSkillOperation,
  type CurrentOperationSession,
} from "../src/shared-current-operation.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0")
const rich = (value: string) => [{ type: "text", text: { content: value } }]
const library: SharedLibrary = {
  version: 1,
  library_id: "current-operations",
  operation_id: "library-current-operations",
  parent_page_id: id(1),
  skills: {
    database_id: id(2),
    data_source_id: id(3),
    property_ids: { "Skill ID": "skill-id", "Current State": "state", Operation: "operation" },
  },
  files: { database_id: id(4), data_source_id: id(5), property_ids: {} },
  records: {
    database_id: id(6),
    data_source_id: id(7),
    property_ids: {
      Name: "title",
      "Record ID": "record",
      "Entity ID": "entity",
      Kind: "kind",
      Hash: "hash",
      Payload: "payload",
      Skill: "skill",
      Resource: "resource",
    },
  },
}
const intent = {
  operation_id: "write-example-1",
  skill_id: "example",
  input_sha256: "a".repeat(64),
}
const ownerId = id(10),
  productPath = "v1/blocks/" + ownerId + "/children"
const parent = mkdtempSync(join(tmpdir(), "ntn-current-operation-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
function fields(input: unknown) {
  return Object.fromEntries(
    Object.entries(property(input)).map(([key, value]) => {
      const item = property(value)
      const type = ["title", "rich_text", "select", "relation", "files"].find(
        (name) => name in item,
      )
      return [
        key,
        {
          ...item,
          id: key,
          type,
          ...(type === "relation" || type === "rich_text" ? { has_more: false } : {}),
        },
      ]
    }),
  )
}
function matches(row: unknown, input: unknown): boolean {
  const filter = property(input)
  if (Array.isArray(filter.or)) return filter.or.some((value) => matches(row, value))
  if (Array.isArray(filter.and)) return filter.and.every((value) => matches(row, value))
  const value = property(property(property(row).properties)[String(filter.property)])
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}
function fixture(options: { skillExists?: boolean } = {}) {
  const root = mkdtempSync(join(parent, "case-")),
    json = new Map<string, unknown>()
  const records = new Map<string, Record<string, unknown>>(),
    values: string[] = []
  const calls: { path: string; body: unknown; method: string }[] = []
  const owner: Record<string, unknown> = {
    object: "page",
    id: ownerId,
    parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
    in_trash: false,
    properties: fields({
      "skill-id": { rich_text: rich(intent.skill_id) },
      state: { select: { name: "ready" } },
      operation: { rich_text: [] },
    }),
  }
  let count = 100
  let skillExists = options.skillExists ?? true
  let fault:
    | {
        target: "product" | "record-create" | "retirement"
        outcome: "visible" | "absent"
        error?: SkillsError
      }
    | undefined
  const api: Notion["Service"] = {
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("current-operation-credential"),
    apiOrigin: "https://fixture.local",
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? "GET",
          request = property(body)
        calls.push({ path, body, method })
        if (path.startsWith("v1/data_sources/" + library.records.data_source_id + "/query"))
          return {
            object: "list",
            results: [...records.values()].filter(
              (row) => row.in_trash !== true && matches(row, request.filter),
            ),
            has_more: false,
            next_cursor: null,
          }
        if (path === "v1/pages" && method === "POST") {
          if (property(request.parent).data_source_id === library.skills.data_source_id) {
            expect(skillExists).toBe(false)
            skillExists = true
            owner.properties = fields(request.properties)
            return owner
          }
          const chosen = fault?.target === "record-create" ? fault : undefined
          if (chosen) fault = undefined
          const row = {
            object: "page",
            id: id(count++),
            parent: request.parent,
            properties: fields(request.properties),
            in_trash: false,
          }
          if (chosen?.outcome !== "absent") records.set(row.id, row)
          if (chosen)
            return yield* Effect.fail(
              chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Record CREATE response lost."),
            )
          return row
        }
        if (path === productPath && method === "POST") {
          const chosen = fault?.target === "product" ? fault : undefined
          if (chosen) fault = undefined
          expect(property(property(owner.properties).state).select).toEqual({ name: "applying" })
          if (chosen?.outcome !== "absent") values.push(String(request.value))
          if (chosen)
            return yield* Effect.fail(
              chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Product response lost."),
            )
          return { value: request.value }
        }
        if (path === "v1/pages/" + ownerId) {
          if (!skillExists) return yield* Effect.fail(fail("NOT_FOUND", "Skill is not created."))
          if (method === "PATCH")
            owner.properties = { ...property(owner.properties), ...fields(request.properties) }
          return owner
        }
        const row = records.get(path.replace("v1/pages/", ""))
        if (row !== undefined) {
          if (method === "PATCH") {
            const chosen =
              request.in_trash === true && fault?.target === "retirement" ? fault : undefined
            if (chosen) fault = undefined
            if (chosen?.outcome !== "absent") {
              if (request.in_trash === true) row.in_trash = true
              if (request.properties !== undefined)
                row.properties = { ...property(row.properties), ...fields(request.properties) }
            }
            if (chosen)
              return yield* Effect.fail(
                chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Retirement response lost."),
              )
          }
          return row
        }
        if (path.startsWith("v1/pages/"))
          return yield* Effect.fail(fail("NOT_FOUND", "Page is unavailable."))
        return yield* Effect.fail(
          fail("UNEXPECTED", "Unexpected current operation request.", { path }),
        )
      }),
  }
  const store: Store["Service"] = {
    root,
    configRoot: root,
    cacheRoot: root,
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    listKeys: (prefix) => Effect.succeed([...json.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          json.has(key)
            ? Schema.decodeUnknownSync(schema)(structuredClone(json.get(key)))
            : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid current pending fixture."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
      }),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          json.delete(key)
          return { key, retention_path: "current-cleared" }
        }),
      ),
    reserveCacheGeneration: () => Effect.die("Unexpected cache generation"),
    registerBindingWithBase: () => Effect.die("Unexpected binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected old receipt"),
    backup: () => Effect.die("Unexpected backup"),
    readBytes: () => Effect.die("Unexpected local bytes"),
    writeBytes: () => Effect.die("Unexpected local bytes"),
    output: () => Effect.die("Unexpected export"),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, store),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const observerFreshness: boolean[] = []
  const action = (
    session: CurrentOperationSession,
    value = "first",
    replay: "never" | "idempotent" = "never",
  ) =>
    session.dispatch({
      key: "append:" + value,
      replay,
      request: { path: productPath, body: { value }, options: { method: "POST" } },
      observe: ({ fresh }) =>
        Effect.sync(() => {
          observerFreshness.push(fresh)
          return values.includes(value)
            ? { status: "complete" as const, value }
            : { status: "missing" as const }
        }),
      acknowledge: (response) =>
        Effect.try({
          try: () => {
            if (property(response).value !== value) throw new Error()
            return value
          },
          catch: () => fail("BAD_ACK", "Product ACK mismatched."),
        }),
    })
  const apply = (
    options: {
      mode?: "apply" | "resume"
      nextIntent?: typeof intent
      values?: string[]
      replay?: "never" | "idempotent"
      verifyFailure?: boolean
      foreignOwner?: boolean
    } = {},
  ) =>
    withCurrentSkillOperation(library, {
      intent: options.nextIntent ?? intent,
      skillPageId: ownerId,
      mode: options.mode,
      run: (session) =>
        Effect.gen(function* () {
          for (const value of options.values ?? ["first"])
            yield* action(session, value, options.replay)
          return values.length
        }),
      verify: () =>
        Effect.gen(function* () {
          if (options.verifyFailure)
            return yield* Effect.fail(fail("CURRENT_TREE_INCOMPLETE", "Final scope is incomplete."))
          if (options.foreignOwner)
            owner.properties = {
              ...property(owner.properties),
              ...fields({
                state: { select: { name: "applying" } },
                operation: { rich_text: rich("another-operation") },
              }),
            }
          expect(values).toEqual(options.values ?? ["first"])
        }),
    })
  return {
    run,
    apply,
    action,
    values,
    calls,
    records,
    json,
    owner,
    observerFreshness,
    skillExists: () => skillExists,
    fault: (next: NonNullable<typeof fault>) => {
      fault = next
    },
    productRequests: () => calls.filter((call) => call.path === productPath).length,
    activeRecords: () => [...records.values()].filter((row) => row.in_trash !== true),
  }
}
describe("one finite current write", () => {
  test("a complete current scope remains a true remote and local no-op", async () => {
    const f = fixture()
    f.values.push("first")
    expect(await f.run(f.apply())).toBe(1)
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(0)
    expect(f.records.size).toBe(0)
    expect(f.json.size).toBe(0)
  })
  test("writes through applying, verifies the actual result, then clears owner and current intent", async () => {
    const f = fixture()
    expect(await f.run(f.apply())).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toHaveLength(0)
    expect(f.json.size).toBe(0)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe("")
    expect([...f.records.values()]).toHaveLength(1)
  })
  test("new Skill creation binds its current intent before any content write", async () => {
    const f = fixture({ skillExists: false })
    const result = withCurrentSkillOperation(library, {
      intent,
      skillPageId: null,
      run: (session) =>
        Effect.gen(function* () {
          const page = yield* session.dispatch<string, never>({
            key: "create-skill",
            replay: "never",
            request: {
              path: "v1/pages",
              options: { method: "POST" },
              body: {
                parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
                properties: {
                  "skill-id": { rich_text: rich(intent.skill_id) },
                  state: { select: { name: "applying" } },
                  operation: { rich_text: rich(intent.operation_id) },
                },
              },
            },
            observe: () =>
              Effect.succeed(
                f.skillExists()
                  ? { status: "complete" as const, value: ownerId }
                  : { status: "missing" as const },
              ),
            acknowledge: () => Effect.succeed(ownerId),
          })
          yield* session.bindSkill(page)
          expect(session.skillPageId).toBe(ownerId)
          expect(session.pendingActionKey).toBeUndefined()
          return yield* f.action(session)
        }),
      verify: () =>
        Effect.sync(() => {
          expect(f.values).toEqual(["first"])
        }),
    })
    expect(await f.run(result)).toBe("first")
    expect(f.json.size).toBe(0)
    const record = [...f.records.values()][0]
    expect(property(property(record?.properties).skill).relation).toEqual([{ id: ownerId }])
    expect(f.activeRecords()).toHaveLength(0)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
  })
  test("a pending multipart request binds the part number as well as its exact bytes", async () => {
    const f = fixture()
    const attempt = (partNumber: number, mode: "apply" | "resume") =>
      withCurrentSkillOperation(library, {
        intent,
        skillPageId: ownerId,
        mode,
        run: (session) =>
          session.dispatch({
            key: "upload:part",
            replay: "never",
            fileSha256: "c".repeat(64),
            request: {
              path: productPath,
              body: { value: "part" },
              options: { method: "POST", file: "/fixture/part", partNumber },
            },
            observe: () => Effect.succeed({ status: "missing" as const }),
          }),
        verify: () => Effect.void,
      })
    f.fault({ target: "product", outcome: "absent" })
    await f.run(attempt(1, "apply").pipe(Effect.result))
    const changed = await f.run(attempt(2, "resume").pipe(Effect.result))
    expect(changed._tag).toBe("Failure")
    if (changed._tag === "Failure") expect(changed.failure.code).toBe("CURRENT_OPERATION_CONFLICT")
    expect(f.productRequests()).toBe(1)
  })
  test("observes an unknown accepted append and never repeats it", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "visible" })
    expect((await f.run(f.apply().pipe(Effect.result)))._tag).toBe("Failure")
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toHaveLength(1)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.observerFreshness).toContain(true)
    expect(f.json.size).toBe(0)
  })
  test("unknown invisible append stays actionable and rejects changed input", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "absent" })
    await f.run(f.apply().pipe(Effect.result))
    const resumed = await f.run(f.apply({ mode: "resume" }).pipe(Effect.result))
    expect(resumed._tag).toBe("Failure")
    if (resumed._tag === "Failure") {
      expect(resumed.failure.code).toBe("CURRENT_OPERATION_UNRESOLVED")
      expect(property(resumed.failure.details).next).toBe("reconcile_current")
      expect(property(resumed.failure.details).input_sha256).toBe(intent.input_sha256)
    }
    const changed = await f.run(
      f.apply({ nextIntent: { ...intent, input_sha256: "b".repeat(64) } }).pipe(Effect.result),
    )
    expect(changed._tag).toBe("Failure")
    expect(f.productRequests()).toBe(1)
    expect(f.json.size).toBe(1)
  })
  test("explicit resume may retry the same idempotent request after fresh observation", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "absent" })
    await f.run(f.apply({ replay: "idempotent" }).pipe(Effect.result))
    expect(await f.run(f.apply({ mode: "resume", replay: "idempotent" }))).toBe(1)
    expect(f.productRequests()).toBe(2)
  })
  test("completed earlier actions do not clear a different unresolved marker", async () => {
    const f = fixture()
    f.values.push("first")
    f.fault({ target: "product", outcome: "visible" })
    await f.run(f.apply({ values: ["first", "second"] }).pipe(Effect.result))
    expect(await f.run(f.apply({ mode: "resume", values: ["first", "second"] }))).toBe(2)
    expect(f.productRequests()).toBe(1)
    expect(f.values).toEqual(["first", "second"])
  })
  test("a failed final scope stays attention and can finish without another append", async () => {
    const f = fixture()
    const first = await f.run(f.apply({ verifyFailure: true }).pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "attention" })
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
  })
  test("budget rejection starts no attention write and preserves a not-sent action for resume", async () => {
    const f = fixture()
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("REQUEST_BUDGET_EXHAUSTED", "Budget refused dispatch."),
    })
    await f.run(f.apply().pipe(Effect.result))
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "applying" })
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(2)
  })
  test("a definitive Notion rate limit stops all follow-up requests and retains the rejected action for explicit resume", async () => {
    const f = fixture()
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("RATE_LIMITED", "Notion refused this current write.", {
        phase: "definitive_rejection",
        http_status: 429,
        rate_limit_reason: "public_api_request_blocked",
      }),
    })
    const result = await f.run(f.apply().pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("RATE_LIMITED")
    expect(f.productRequests()).toBe(1)
    expect(f.calls.at(-1)?.path).toBe(productPath)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "applying" })
    expect(f.activeRecords()).toHaveLength(1)
    expect(
      [...f.json.values()].some(
        (value) => property(property(value).not_dispatched).key === "append:first",
      ),
    ).toBe(true)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(2)
    expect(f.json.size).toBe(0)
  })
  test("foreign owner operation is never cleared during finalization", async () => {
    const f = fixture()
    const result = await f.run(f.apply({ foreignOwner: true }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_OPERATION_CONFLICT")
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe(
      "another-operation",
    )
    expect(f.activeRecords()).toHaveLength(1)
  })
  test("unknown Operation create uses its stable identity before any product mutation", async () => {
    const f = fixture()
    f.fault({ target: "record-create", outcome: "visible" })
    await f.run(f.apply().pipe(Effect.result))
    expect(f.productRequests()).toBe(0)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect([...f.records.values()]).toHaveLength(1)
  })
  test("missing unknown Operation create cannot be replaced by another POST", async () => {
    const f = fixture()
    f.fault({ target: "record-create", outcome: "absent" })
    await f.run(f.apply().pipe(Effect.result))
    const result = await f.run(f.apply({ mode: "resume" }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_OPERATION_UNRESOLVED")
    expect(
      f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST"),
    ).toHaveLength(1)
    expect(f.productRequests()).toBe(0)
  })
  test("unknown successful retirement resumes with no product or owner write", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    const first = await f.run(f.apply().pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    expect(f.activeRecords()).toHaveLength(0)
    expect(f.json.size).toBe(1)
    const before = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    const after = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(after).toBe(before)
    expect(f.json.size).toBe(0)
  })
  test("a new input clears only a confirmed retired prior locator before starting", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    await f.run(f.apply().pipe(Effect.result))
    expect(f.json.size).toBe(1)
    expect(
      await f.run(
        f.apply({
          nextIntent: { ...intent, operation_id: "write-next", input_sha256: "b".repeat(64) },
          values: ["first", "second"],
        }),
      ),
    ).toBe(2)
    expect(f.values).toEqual(["first", "second"])
    expect(f.productRequests()).toBe(2)
    expect(f.json.size).toBe(0)
    expect(f.activeRecords()).toHaveLength(0)
  })
  test("an empty Operation query plus inaccessible retired page cannot erase the prior locator", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    await f.run(f.apply().pipe(Effect.result))
    f.records.clear()
    const before = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    const result = await f.run(
      f
        .apply({
          nextIntent: { ...intent, operation_id: "write-next", input_sha256: "b".repeat(64) },
          values: ["first", "second"],
        })
        .pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("NOT_FOUND")
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(before)
    expect(f.json.size).toBe(1)
    expect(f.values).toEqual(["first"])
  })
})
