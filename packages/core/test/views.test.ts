import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { listViews, viewCatalog, viewId } from "../src/views.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { decode, fail, property, SkillsError } from "../src/model.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const db = "10000000-0000-4000-8000-000000000001"
const ds = "20000000-0000-4000-8000-000000000001"
const a = "30000000-0000-4000-8000-000000000001"
const b = "30000000-0000-4000-8000-000000000002"
const alpha = "40000000-0000-4000-8000-000000000001"
const beta = "40000000-0000-4000-8000-000000000002"
const query = "50000000-0000-4000-8000-000000000001"
const source = { alias: "library", database_id: db, title: "Skills", data_source_ids: [ds] }
const ref = (id: string, object = "page") => ({ id, object })
const list = (results: unknown[], next_cursor: string | null = null) => ({
  results,
  next_cursor,
  has_more: next_cursor !== null,
})
const row = (id: string, name: string, checked: boolean) => ({
  id,
  parent: { database_id: db, data_source_id: ds },
  properties: {
    Name: { type: "title", title: [{ plain_text: name }] },
    Description: { type: "rich_text", rich_text: [{ plain_text: `${name} workflow` }] },
    "Default Context": { type: "checkbox", checkbox: checked },
  },
})
const view = (id: string) => ({
  id,
  name: id === a ? "ZZZ first" : "AAA second",
  type: "table",
  data_source_id: ds,
  parent: { type: "database_id", database_id: db },
  url: `https://notion.so/${db}?v=${id}`,
  quick_filters: { checkbox: { equals: false } },
})
type Override = (path: string, body: unknown) => unknown
function fixture(override: Override = () => undefined) {
  const requests: { path: string; body: unknown }[] = []
  const state = new Map<string, unknown>([["config.json", { sources: [source] }]])
  let generation = 0
  const storage = Layer.succeed(Store, {
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die("unused"),
    advanceBaseAndReceipt: () => Effect.die("unused"),
    backup: () => Effect.die("unused"),
    reserveCacheGeneration: () => Effect.sync(() => ++generation),
    listKeys: (prefix) => Effect.succeed([...state.keys()].filter((key) => key.startsWith(prefix))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        keys.forEach((key) => state.delete(key))
        return keys.map((key) => ({ key, retention_path: "fixture" }))
      }),
    readJson: (key, schema) =>
      Effect.sync(() => (state.has(key) ? decode(schema, state.get(key)) : undefined)),
    writeJson: (key, value) =>
      Effect.sync(() => {
        state.set(key, value)
      }),
    readBytes: () => Effect.die("View discovery must not read bodies"),
    writeBytes: () => Effect.die("unused"),
    output: () => Effect.die("unused"),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("view-fixture-credential"),
    request: (path, body) =>
      Effect.gen(function* () {
        requests.push({ path, body })
        const custom = override(path, body)
        if (custom instanceof SkillsError) return yield* Effect.fail(custom)
        if (custom !== undefined) return custom
        if (path === "v1/users/me") return { id: "user", object: "user" }
        if (path === `v1/databases/${db}`)
          return {
            id: db,
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
            data_sources: [{ id: ds, name: "Skills" }],
          }
        if (path.startsWith("v1/views?")) return list([ref(a, "view"), ref(b, "view")])
        if (path === `v1/views/${a}` || path === `v1/views/${b}`)
          return view(path.endsWith(a) ? a : b)
        if (path.endsWith("/queries"))
          return {
            ...list([ref(path.includes(a) ? alpha : beta)]),
            id: query,
            view_id: path.includes(a) ? a : b,
            expires_at: new Date(Date.now() + 900000).toISOString(),
            total_count: 1,
          }
        if (path === `v1/data_sources/${ds}/query`)
          return list([
            row(alpha, "Alpha", false),
            row(beta, "Beta", true),
            { id: "unrelated-invalid" },
          ])
        return yield* Effect.fail(fail("UNEXPECTED", `Unexpected request ${path}`))
      }),
  })
  return { requests, state, layer: Layer.mergeAll(NodeServices.layer, storage, api) }
}

test("View URL selects v rather than database; names and foreign URLs are rejected", () => {
  expect(
    viewId(`https://app.notion.com/p/${db.replaceAll("-", "")}?v=${a.replaceAll("-", "")}`),
  ).toBe(a)
  expect(viewId(a.toUpperCase())).toBe(a)
  for (const input of [
    "Default view",
    `https://example.com?v=${a}`,
    `https://notion.so/${db}`,
    `https://notion.so/${db}?v=${a}&v=${b}`,
  ])
    expect(() => viewId(input)).toThrow()
})

test("API order selects first View regardless of name and ignores checkbox as an extra gate", async () => {
  const f = fixture()
  const listed = await Effect.runPromise(
    listViews({ database: "library" }).pipe(Effect.provide(f.layer)),
  )
  expect(listed.views.map((x) => x.id)).toEqual([a, b])
  const result = await Effect.runPromise(
    viewCatalog({ database: db }).pipe(Effect.provide(f.layer)),
  )
  expect(result.view?.id).toBe(a)
  expect(result.view_selection).toBe("first")
  expect(result.records.map((x) => x.name)).toEqual(["Alpha"])
  expect(result.records[0]?.default_context).toBe(false)
  expect(result.coverage.exhaustive).toBe(true)
  expect(f.requests.some((x) => /blocks|export|upstream/.test(x.path))).toBe(false)
  expect(f.requests.find((x) => x.path.endsWith("/queries"))?.body).toEqual({ page_size: 100 })
})

test("default operation identity validates once per fresh read and reuses the warm observation", async () => {
  const f = fixture()
  const fresh = await Effect.runPromise(
    viewCatalog({ database: db, refresh: true }).pipe(Effect.provide(f.layer)),
  )
  const authCalls = () => f.requests.filter((request) => request.path === "v1/users/me")
  expect(fresh.source).toBe("notion")
  expect(authCalls()).toHaveLength(1)
  const calls = f.requests.length
  const warm = await Effect.runPromise(viewCatalog({ database: db }).pipe(Effect.provide(f.layer)))
  expect(warm.source).toBe("local_cache")
  expect(warm.scope).toBe(fresh.scope)
  expect(warm.records).toEqual(fresh.records)
  expect(warm.fetched_at).toBe(fresh.fetched_at)
  expect(f.requests).toHaveLength(calls)

  const next = await Effect.runPromise(
    viewCatalog({ database: db, refresh: true }).pipe(Effect.provide(f.layer)),
  )
  expect(next.source).toBe("notion")
  expect(next.scope).toBe(fresh.scope)
  expect(authCalls()).toHaveLength(2)
})

for (const code of ["AUTH_REQUIRED", "ACCESS_DENIED"] as const)
  test(
    "default operation identity fails closed on fresh " + code + " despite a warm View",
    async () => {
      let denied = false
      const f = fixture((path) =>
        denied && path === "v1/users/me" ? fail(code, "Fresh identity is unavailable") : undefined,
      )
      const prior = await Effect.runPromise(
        viewCatalog({ database: db, refresh: true }).pipe(Effect.provide(f.layer)),
      )
      expect(prior.source).toBe("notion")
      expect(prior.records.map((record) => record.name)).toEqual(["Alpha"])
      denied = true
      f.requests.length = 0
      const rejected = await Effect.runPromise(
        viewCatalog({ database: db, refresh: true }).pipe(Effect.result, Effect.provide(f.layer)),
      )
      expect(rejected._tag === "Failure" && rejected.failure.code).toBe(code)
      expect(f.requests.map((request) => request.path)).toEqual(["v1/users/me"])
    },
  )

test("default first-detail selection does not populate or overwrite the public complete View list", async () => {
  const f = fixture()
  const selected = await Effect.runPromise(
    viewCatalog({ database: db }).pipe(Effect.provide(f.layer)),
  )
  expect(selected.view?.id).toBe(a)
  expect(selected.records.map((record) => record.name)).toEqual(["Alpha"])
  const details = () =>
    f.requests.filter((request) => [a, b].some((id) => request.path === "v1/views/" + id))
  expect(details().map((request) => request.path)).toEqual(["v1/views/" + a])
  const calls = f.requests.length
  const warm = await Effect.runPromise(viewCatalog({ database: db }).pipe(Effect.provide(f.layer)))
  expect(warm.source).toBe("local_cache")
  expect(warm.view).toEqual(selected.view)
  expect(f.requests).toHaveLength(calls)
  const absentList = await Effect.runPromise(
    listViews({ database: db, offline: true }).pipe(Effect.result, Effect.provide(f.layer)),
  )
  expect(absentList._tag === "Failure" && absentList.failure.code).toBe("CACHE_MISSING")
  expect(f.requests).toHaveLength(calls)

  const complete = await Effect.runPromise(
    listViews({ database: db }).pipe(Effect.provide(f.layer)),
  )
  expect(complete.views.map((entry) => entry.id)).toEqual([a, b])
  expect(details().map((request) => request.path)).toEqual([
    "v1/views/" + a,
    "v1/views/" + a,
    "v1/views/" + b,
  ])
  const savedLists = () =>
    [...f.state]
      .filter(([, value]) => Array.isArray(property(value).views))
      .map(([key, value]) => [key, JSON.stringify(value)])
  const saved = savedLists()
  expect(saved).toHaveLength(1)
  f.requests.length = 0
  const refreshed = await Effect.runPromise(
    viewCatalog({ database: db, refresh: true }).pipe(Effect.provide(f.layer)),
  )
  expect(refreshed.view).toEqual(selected.view)
  expect(details().map((request) => request.path)).toEqual(["v1/views/" + a])
  expect(savedLists()).toEqual(saved)
  const refreshedCalls = f.requests.length
  const offlineList = await Effect.runPromise(
    listViews({ database: db, offline: true }).pipe(Effect.provide(f.layer)),
  )
  expect(offlineList.views).toEqual(complete.views)
  expect(f.requests).toHaveLength(refreshedCalls)
})

test("default first-detail selection does not retrieve an unavailable unselected View", async () => {
  const f = fixture((path) =>
    path === "v1/views/" + b ? fail("ACCESS_DENIED", "Unselected View is unavailable") : undefined,
  )
  const selected = await Effect.runPromise(
    viewCatalog({ database: db }).pipe(Effect.provide(f.layer)),
  )
  expect(selected.view?.id).toBe(a)
  expect(f.requests.some((request) => request.path === "v1/views/" + b)).toBe(false)
  const complete = await Effect.runPromise(
    listViews({ database: db }).pipe(Effect.result, Effect.provide(f.layer)),
  )
  expect(complete._tag === "Failure" && complete.failure.code).toBe("ACCESS_DENIED")
})

for (const emptyFirstPage of [false, true])
  test(
    "default first-detail selection preserves full ID pagination, empty first page=" +
      emptyFirstPage,
    async () => {
      const f = fixture((path) => {
        if (!path.startsWith("v1/views?")) return undefined
        const next = new URL("https://fixture/" + path).searchParams.has("start_cursor")
        return next
          ? list(emptyFirstPage ? [ref(b, "view"), ref(a, "view")] : [ref(b, "view")])
          : list(emptyFirstPage ? [] : [ref(a, "view")], "next")
      })
      const selected = await Effect.runPromise(
        viewCatalog({ database: db }).pipe(Effect.provide(f.layer)),
      )
      const first = emptyFirstPage ? b : a
      expect(selected.view?.id).toBe(first)
      expect(selected.records.map((record) => record.name)).toEqual([
        emptyFirstPage ? "Beta" : "Alpha",
      ])
      const inventory = f.requests.filter((request) => request.path.startsWith("v1/views?"))
      expect(inventory).toHaveLength(2)
      const details = f.requests.filter((request) =>
        [a, b].some((id) => request.path === "v1/views/" + id),
      )
      expect(details.map((request) => request.path)).toEqual(["v1/views/" + first])
      expect(f.requests.indexOf(inventory[1]!)).toBeLessThan(f.requests.indexOf(details[0]!))
    },
  )

for (const [label, nextPage, expected] of [
  ["duplicate-id", list([ref(a, "view")]), "INVALID_RESPONSE"],
  ["wrong-object", list([ref(b, "page")]), "INVALID_RESPONSE"],
  [
    "incomplete",
    { ...list([ref(b, "view")]), request_status: { type: "incomplete" } },
    "VIEW_INCOMPLETE",
  ],
  ["missing-cursor", { ...list([ref(b, "view")]), has_more: true }, "INVALID_RESPONSE"],
  ["repeated-cursor", list([ref(b, "view")], "next"), "INVALID_RESPONSE"],
] as const)
  test("default first-detail selection rejects later ID inventory " + label, async () => {
    const f = fixture((path) =>
      path.startsWith("v1/views?")
        ? new URL("https://fixture/" + path).searchParams.has("start_cursor")
          ? nextPage
          : list([ref(a, "view")], "next")
        : undefined,
    )
    const result = await Effect.runPromise(
      viewCatalog({ database: db }).pipe(Effect.result, Effect.provide(f.layer)),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(expected)
    expect(f.requests.filter((request) => request.path.startsWith("v1/views?"))).toHaveLength(2)
    expect(f.requests.some((request) => request.path.startsWith("v1/views/"))).toBe(false)
  })

for (const [label, detail, expected] of [
  ["permission", fail("ACCESS_DENIED", "Selected View is unavailable"), "ACCESS_DENIED"],
  ["incomplete", { ...view(a), name: undefined }, "INVALID_RESPONSE"],
  ["foreign-source", { ...view(a), data_source_id: b }, "VIEW_SCOPE_MISMATCH"],
] as const)
  test("default first-detail selection fails closed on selected " + label, async () => {
    const f = fixture((path) => (path === "v1/views/" + a ? detail : undefined))
    const result = await Effect.runPromise(
      viewCatalog({ database: db }).pipe(Effect.result, Effect.provide(f.layer)),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(expected)
    expect(f.requests.filter((request) => request.path === "v1/views/" + a)).toHaveLength(1)
    expect(
      f.requests.some(
        (request) => request.path === "v1/views/" + b || request.path.endsWith("/queries"),
      ),
    ).toBe(false)
  })

test("explicit View works without first-view enumeration and observations never pollute full catalogs", async () => {
  const f = fixture()
  const run = () =>
    Effect.runPromise(viewCatalog({ database: "library", view: b }).pipe(Effect.provide(f.layer)))
  const first = await run()
  expect(first.records.map((x) => x.name)).toEqual(["Beta"])
  const calls = f.requests.length
  const second = await run()
  expect(second.source).toBe("local_cache")
  expect(f.requests).toHaveLength(calls)
  expect([...f.state.keys()].some((x) => x.startsWith("cache/catalogs"))).toBe(false)
  expect(f.requests.some((x) => x.path.startsWith("v1/views?"))).toBe(false)
  const offline = await Effect.runPromise(
    viewCatalog({ database: "library", view: b, offline: true }).pipe(Effect.provide(f.layer)),
  )
  expect(offline.records).toEqual(first.records)
  const absent = await Effect.runPromise(
    viewCatalog({ database: "library", view: a, offline: true }).pipe(
      Effect.result,
      Effect.provide(f.layer),
    ),
  )
  expect(absent._tag === "Failure" && absent.failure.code).toBe("CACHE_MISSING")
})

test("zero Views is a successful empty directory, not whole-library fallback", async () => {
  const f = fixture((path) => (path.startsWith("v1/views?") ? list([]) : undefined))
  const result = await Effect.runPromise(viewCatalog().pipe(Effect.provide(f.layer)))
  expect(result.view_selection).toBe("none")
  expect(result.records).toEqual([])
  expect(f.requests.some((x) => x.path.endsWith("/query"))).toBe(false)
})

test("View query pages share the same query and retain native order", async () => {
  const f = fixture((path) => {
    if (path.endsWith("/queries"))
      return {
        ...list([ref(beta)], "next"),
        id: query,
        view_id: a,
        expires_at: new Date(Date.now() + 900000).toISOString(),
        total_count: 2,
      }
    if (path.includes(`/queries/${query}?`)) return list([ref(alpha)])
  })
  const result = await Effect.runPromise(viewCatalog({ view: a }).pipe(Effect.provide(f.layer)))
  expect(result.records.map((x) => x.name)).toEqual(["Beta", "Alpha"])
  expect(f.requests.filter((x) => x.path.endsWith("/queries"))).toHaveLength(1)
  expect(f.requests.some((x) => x.path.includes(`/queries/${query}?start_cursor=next`))).toBe(true)
})

for (const [label, value, expected] of [
  [
    "truncated",
    { request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } },
    "VIEW_INCOMPLETE",
  ],
  ["expired", { expires_at: "2020-01-01T00:00:00Z" }, "VIEW_QUERY_EXPIRED"],
  ["wrong-query-view", { view_id: b }, "INVALID_RESPONSE"],
  ["count-mismatch", { total_count: 2 }, "VIEW_INCOMPLETE"],
  ["missing-cursor", { has_more: true, next_cursor: null }, "INVALID_RESPONSE"],
] as const)
  test(`reject ${label} rather than return partial success`, async () => {
    const f = fixture((path) =>
      path.endsWith("/queries")
        ? {
            ...list([ref(alpha)]),
            id: query,
            view_id: a,
            expires_at: new Date(Date.now() + 900000).toISOString(),
            total_count: 1,
            ...value,
          }
        : undefined,
    )
    const result = await Effect.runPromise(
      viewCatalog({ view: a }).pipe(Effect.result, Effect.provide(f.layer)),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(expected)
  })

test("selected member failures remain visible without hiding other members or caching a complete claim", async () => {
  const f = fixture((path, body) => {
    if (path.endsWith("/queries"))
      return {
        ...list([ref(alpha), ref(beta)]),
        id: query,
        view_id: a,
        expires_at: new Date(Date.now() + 900000).toISOString(),
        total_count: 2,
      }
    if (path.endsWith("/query"))
      return list([
        row(alpha, "Alpha", false),
        { ...row(beta, "Beta", true), parent: { database_id: b, data_source_id: ds } },
      ])
  })
  const result = await Effect.runPromise(viewCatalog({ view: a }).pipe(Effect.provide(f.layer)))
  expect(result.records.map((x) => x.name)).toEqual(["Alpha"])
  expect(result.coverage.exhaustive).toBe(false)
  expect(result.coverage.failed_sources[0]?.id).toBe(beta)
  const cached = await Effect.runPromise(
    viewCatalog({ view: a, offline: true }).pipe(Effect.result, Effect.provide(f.layer)),
  )
  expect(cached._tag === "Failure" && cached.failure.code).toBe("CACHE_MISSING")
})

test("explicit wrong-database View fails instead of picking another View", async () => {
  const f = fixture((path) =>
    path === `v1/views/${a}`
      ? {
          id: a,
          name: "Moved",
          type: "table",
          data_source_id: ds,
          parent: { type: "database_id", database_id: b },
          url: "https://notion.so",
        }
      : undefined,
  )
  const result = await Effect.runPromise(
    viewCatalog({ view: a, database: db }).pipe(Effect.result, Effect.provide(f.layer)),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("VIEW_SCOPE_MISMATCH")
  expect(f.requests.some((x) => x.path.startsWith("v1/views?"))).toBe(false)
})
