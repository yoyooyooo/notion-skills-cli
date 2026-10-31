import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import { Clock, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { catalog, explicitSource } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import {
  CatalogSchema,
  ContentRecordSchema,
  SnapshotSchema,
  decode,
  fail,
  resolveRecord,
  recordFromPage,
} from "../src/model.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const source = {
  id: "ds",
  parent: { database_id: database },
  title: [{ plain_text: "Skills" }],
  database_type: "skills",
}
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  properties: {
    RenamedTitle: { type: "title", title: [{ plain_text: "Sample Skill" }] },
    RenamedDescription: {
      id: "notion%3A%2F%2Fskills%2Fdescription_property",
      rich_text: [{ plain_text: "Review resources" }],
    },
  },
}

const memoryStore = Layer.succeed(Store, {
  integrity: integrityRepositoryFixture(),
  upstream: upstreamRepositoryFixture(),
  registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
  advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
  backup: () => Effect.die(new Error("Unexpected backup")),
  root: "/unused",
  configRoot: "/unused",
  cacheRoot: "/unused",
  reserveCacheGeneration: (() => {
    let generation = 0
    return () => Effect.sync(() => ++generation)
  })(),
  listKeys: () => Effect.succeed([] as readonly string[]),
  retireKeys: () => Effect.succeed([] as readonly { key: string; retention_path: string }[]),
  readJson: () => Effect.succeed(undefined),
  writeJson: () => Effect.void,
  readBytes: () => Effect.fail(fail("UNUSED", "unused")),
  writeBytes: () => Effect.void,
  output: () => Effect.fail(fail("UNUSED", "unused")),
})

test("a shared library never falls through to the legacy References consumer", async () => {
  const calls: string[] = []
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path: string) => {
      calls.push(path)
      return Effect.succeed({
        id: database,
        description: [{ plain_text: "ntn-skills-library:v1 {}" }],
        data_sources: [{ id: "ds" }],
      })
    },
  })
  const result = await Effect.runPromise(
    explicitSource(database).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, memoryStore, api)),
      Effect.result,
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Expected a protected boundary")
  expect(result.failure.code).toBe("SHARED_LIBRARY_CONSUMER_PENDING")
  expect(calls).toEqual([`v1/databases/${database}`])
})

test("discovery follows both search and row cursors, excludes ordinary databases, deduplicates pages", async () => {
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path, body) => {
      const cursor =
        body && typeof body === "object" && "start_cursor" in body ? body.start_cursor : undefined
      if (path === "v1/users/me") return Effect.succeed({ id: "user", object: "user" })
      if (path === "v1/search")
        return Effect.succeed(
          cursor
            ? { results: [source], has_more: false, next_cursor: null }
            : {
                results: [{ ...source, id: "ordinary", database_type: null }],
                has_more: true,
                next_cursor: "search-next",
              },
        )
      if (path === "v1/data_sources/ds/query")
        return Effect.succeed(
          cursor
            ? {
                results: [
                  row,
                  {
                    ...row,
                    id: "22222222-2222-4222-8222-222222222222",
                    properties: {
                      ...row.properties,
                      RenamedTitle: { type: "title", title: [{ plain_text: "Another Skill" }] },
                    },
                  },
                  { ...row, id: "trashed", in_trash: true },
                ],
                has_more: false,
                next_cursor: null,
              }
            : { results: [row], has_more: true, next_cursor: "rows-next" },
        )
      return Effect.fail(fail("UNEXPECTED", "Unexpected request"))
    },
  })
  const result = await Effect.runPromise(
    catalog({ refresh: true }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, api, memoryStore)),
    ),
  )
  expect(result.records).toEqual([
    {
      id: "notion_page:22222222-2222-4222-8222-222222222222",
      kind: "skill",
      entrypoint: "SKILL.md",
      locator: {
        type: "notion_page",
        page_id: "22222222-2222-4222-8222-222222222222",
        database_id: database,
        data_source_id: "ds",
      },
      name: "Another Skill",
      alias: "another-skill",
      description: "Review resources",
      default_context: false,
      ref: "skill://22222222-2222-4222-8222-222222222222/SKILL.md",
    },
    {
      id: "notion_page:11111111-1111-4111-8111-111111111111",
      kind: "skill",
      entrypoint: "SKILL.md",
      locator: {
        type: "notion_page",
        page_id: "11111111-1111-4111-8111-111111111111",
        database_id: database,
        data_source_id: "ds",
      },
      name: "Sample Skill",
      alias: "sample-skill",
      description: "Review resources",
      default_context: false,
      ref: "skill://11111111-1111-4111-8111-111111111111/SKILL.md",
    },
  ])
  expect(result.coverage).toEqual({
    method: "search_and_registered",
    exhaustive: false,
    queried_data_sources: ["ds"],
    failed_sources: [],
    search_index_limited: true,
  })
})

test("failed data sources remain visible rather than becoming empty successful catalogs", async () => {
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) =>
      path === "v1/users/me"
        ? Effect.succeed({ id: "user", object: "user" })
        : path === "v1/search"
          ? Effect.succeed({ results: [source], has_more: false, next_cursor: null })
          : Effect.fail(fail("ACCESS_DENIED", "denied")),
  })
  const result = await Effect.runPromise(
    catalog({ refresh: true }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, api, memoryStore)),
    ),
  )
  expect(result.coverage.failed_sources).toEqual([
    {
      id: "ds",
      code: "ACCESS_DENIED",
      database_id: database,
      alias: database,
      title: "Skills",
      data_source_id: "ds",
    },
  ])
  expect(result.coverage.exhaustive).toBe(false)
})

test("invalid descriptions preserve other catalog records with explicit failed-source coverage", async () => {
  const valid = {
    ...row,
    properties: {
      ...row.properties,
      RenamedDescription: {
        ...row.properties.RenamedDescription,
        rich_text: [{ plain_text: "x".repeat(1211) }],
      },
    },
  }
  const invalid = {
    ...row,
    id: "22222222-2222-4222-8222-222222222222",
    properties: {
      ...row.properties,
      RenamedDescription: {
        ...row.properties.RenamedDescription,
        rich_text: [{ plain_text: "x".repeat(2001) }],
      },
    },
  }
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) =>
      Effect.succeed(
        path === "v1/users/me"
          ? { id: "user", object: "user" }
          : path === "v1/search"
            ? { results: [source], has_more: false, next_cursor: null }
            : { results: [valid, invalid], has_more: false, next_cursor: null },
      ),
  })
  const result = await Effect.runPromise(
    catalog({ refresh: true }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, api, memoryStore)),
    ),
  )
  expect(result.records).toHaveLength(1)
  expect(result.records[0]!.description).toBe("x".repeat(1211))
  expect(result.coverage.failed_sources).toContainEqual(
    expect.objectContaining({ id: invalid.id, code: "INVALID_SKILL" }),
  )
})

test("invalid Notion titles cannot produce a successful catalog", async () => {
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) =>
      path === "v1/users/me"
        ? Effect.succeed({ id: "user", object: "user" })
        : path === "v1/search"
          ? Effect.succeed({ results: [source], has_more: false, next_cursor: null })
          : Effect.succeed({
              results: [
                {
                  ...row,
                  properties: {
                    ...row.properties,
                    RenamedTitle: { type: "title", title: [{ plain_text: "Sample\u0000Skill" }] },
                  },
                },
              ],
              has_more: false,
              next_cursor: null,
            }),
  })
  const result = await Effect.runPromise(
    catalog({ refresh: true }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, api, memoryStore)),
      Effect.result,
    ),
  )
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: "11111111-1111-4111-8111-111111111111", name: "Sample\u0000Skill" },
  })
})

test("metadata cached before the naming contract cannot bypass title validation", async () => {
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) =>
      path === "v1/users/me"
        ? Effect.succeed({ id: "user", object: "user" })
        : Effect.fail(fail("UNEXPECTED", "Only cached metadata is expected")),
  })
  const cachedStore = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: () => Effect.succeed([] as readonly string[]),
    retireKeys: () => Effect.succeed([] as readonly { key: string; retention_path: string }[]),
    readJson: (key, schema) =>
      Effect.gen(function* () {
        if (!key.startsWith("cache/catalogs/")) return undefined
        return decode(schema, {
          scope: key.split("/")[2],
          fetched_at: (yield* Clock.currentTimeMillis) - 1000,
          databases: [],
          records: [
            {
              id: "notion_page:11111111-1111-4111-8111-111111111111",
              kind: "skill",
              entrypoint: "SKILL.md",
              locator: {
                type: "notion_page",
                page_id: "11111111-1111-4111-8111-111111111111",
                database_id: database,
                data_source_id: "ds",
              },
              name: "资源\u0000治理",
              alias: "资源治理",
              description: "Review resources",
              default_context: false,
              ref: "skill://11111111-1111-4111-8111-111111111111/SKILL.md",
            },
          ],
          coverage: {
            method: "search",
            exhaustive: false,
            queried_data_sources: ["ds"],
            failed_sources: [],
            search_index_limited: true,
          },
        })
      }),
    writeJson: () => Effect.void,
    readBytes: () => Effect.fail(fail("UNUSED", "unused")),
    writeBytes: () => Effect.void,
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const result = await Effect.runPromise(
    catalog().pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, api, cachedStore)),
      Effect.result,
    ),
  )
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: "11111111-1111-4111-8111-111111111111", name: "资源\u0000治理" },
  })
})

test("switching credentials for one user isolates cached discovery and switching back reuses its own catalog", async () => {
  const files = new Map<string, unknown>()
  let credential = "first-credential"
  let queryCount = 0
  const cachedStore = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...files.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        const retired: Array<{ key: string; retention_path: string }> = []
        for (const key of keys) {
          if (!key.startsWith("cache/")) continue
          files.delete(key)
          retired.push({ key, retention_path: "fixture_trash" })
        }
        return retired
      }),
    readJson: (key, schema) =>
      Effect.sync(() => (files.has(key) ? decode(schema, files.get(key)) : undefined)),
    writeJson: (key, value) =>
      Effect.sync(() => {
        files.set(key, value)
      }),
    readBytes: () => Effect.fail(fail("UNUSED", "unused")),
    writeBytes: () => Effect.void,
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path) => {
      if (path === "v1/users/me") return Effect.succeed({ id: "same-user", object: "user" })
      if (path === "v1/search")
        return Effect.succeed({ results: [source], has_more: false, next_cursor: null })
      if (path === "v1/data_sources/ds/query") {
        queryCount++
        return Effect.succeed({
          results: [
            {
              ...row,
              id:
                credential === "first-credential"
                  ? "55555555-5555-4555-8555-555555555555"
                  : "66666666-6666-4666-8666-666666666666",
            },
          ],
          has_more: false,
          next_cursor: null,
        })
      }
      return Effect.fail(fail("UNEXPECTED", "Unexpected request"))
    },
  })
  const run = () =>
    Effect.runPromise(
      catalog().pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, api, cachedStore))),
    )
  const first = await run()
  credential = "second-credential"
  const second = await run()
  expect(first.records.map((record) => record.id)).toEqual([
    "notion_page:55555555-5555-4555-8555-555555555555",
  ])
  expect(second.records.map((record) => record.id)).toEqual([
    "notion_page:66666666-6666-4666-8666-666666666666",
  ])
  expect(second.scope).not.toBe(first.scope)
  credential = "first-credential"
  const restored = await run()
  expect(restored.scope).toEqual(first.scope)
  expect(restored.records).toEqual(first.records)
  expect(restored.fetched_at).toEqual(first.fetched_at)
  expect(queryCount).toBe(2)
})

test("same-name skills stay distinct by database, alias selection scopes lookup and failures identify their owner", async () => {
  const otherDatabase = "87654321-1234-1234-1234-123456789abc"
  const registered = [
    {
      role: "content" as const,
      alias: "frontend",
      database_id: database,
      title: "Frontend Skills",
      data_source_ids: ["ds"],
    },
    {
      role: "content" as const,
      alias: "ops",
      database_id: otherDatabase,
      title: "Operations Skills",
      data_source_ids: ["other-ds"],
    },
  ]
  let broken = false
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: () => Effect.succeed([] as readonly string[]),
    retireKeys: () => Effect.succeed([] as readonly { key: string; retention_path: string }[]),
    readJson: (key, schema) =>
      Effect.sync(() =>
        key === "config.json" ? decode(schema, { sources: registered }) : undefined,
      ),
    writeJson: () => Effect.void,
    readBytes: () => Effect.fail(fail("UNUSED", "unused")),
    writeBytes: () => Effect.void,
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) => {
      if (path === "v1/users/me") return Effect.succeed({ id: "user", object: "user" })
      if (path === "v1/search")
        return Effect.succeed({ results: [], has_more: false, next_cursor: null })
      const db = registered.find((db) => path === `v1/databases/${db.database_id}`)
      if (db)
        return Effect.succeed({
          id: db.database_id,
          database_type: "skills",
          title: [{ plain_text: db.title }],
          data_sources: db.data_source_ids.map((id) => ({ id, name: db.title })),
        })
      if (path === "v1/data_sources/other-ds/query" && broken)
        return Effect.fail(fail("ACCESS_DENIED", "denied"))
      if (path.endsWith("/query"))
        return Effect.succeed({
          results: [
            {
              ...row,
              id: path.includes("other-ds")
                ? "44444444-4444-4444-8444-444444444444"
                : "33333333-3333-4333-8333-333333333333",
            },
          ],
          has_more: false,
          next_cursor: null,
        })
      return Effect.fail(fail("UNEXPECTED", "Unexpected request"))
    },
  })
  const run = (database?: string) =>
    Effect.runPromise(
      catalog({ database, refresh: true }).pipe(
        Effect.provide(Layer.mergeAll(NodeServices.layer, api, store)),
      ),
    )
  const merged = await run()
  expect(merged.databases).toEqual(registered)
  expect(merged.records.map((record) => record.id)).toEqual([
    "notion_page:33333333-3333-4333-8333-333333333333",
    "notion_page:44444444-4444-4444-8444-444444444444",
  ])
  try {
    resolveRecord("sample-skill", merged)
    throw new Error("Expected ambiguity")
  } catch (error) {
    expect(error).toMatchObject({
      code: "SKILL_AMBIGUOUS",
      details: { databases: registered, candidates: merged.records },
    })
  }
  const scoped = await run("ops")
  expect(scoped.databases).toEqual([registered[1]!])
  expect(resolveRecord("sample-skill", scoped).id).toBe(
    "notion_page:44444444-4444-4444-8444-444444444444",
  )
  broken = true
  const partial = await run()
  expect(partial.records.map((record) => record.id)).toEqual([
    "notion_page:33333333-3333-4333-8333-333333333333",
  ])
  expect(partial.coverage.failed_sources).toEqual([
    {
      id: "other-ds",
      code: "ACCESS_DENIED",
      database_id: otherDatabase,
      alias: "ops",
      title: "Operations Skills",
      data_source_id: "other-ds",
    },
  ])
})

test("Default Context accepts true, false and absent, and rejects explicit invalid properties", () => {
  const source = {
    alias: "skills",
    database_id: database,
    title: "Skills",
    data_source_ids: ["ds"],
  }
  const convert = (value?: unknown) =>
    recordFromPage(
      {
        ...row,
        properties: {
          ...row.properties,
          ...(value === undefined ? {} : { "Default Context": value }),
        },
      },
      source,
      "ds",
    )
  expect(convert().default_context).toBe(false)
  expect(convert({ type: "checkbox", checkbox: false }).default_context).toBe(false)
  expect(convert({ type: "checkbox", checkbox: true }).default_context).toBe(true)
  for (const invalid of [
    null,
    { type: "rich_text", rich_text: [] },
    { type: "checkbox" },
    { type: "checkbox", checkbox: "true" },
  ]) {
    expect(() => convert(invalid)).toThrow("Default Context must be a checkbox property.")
  }
})

test("record catalogs and snapshots preserve metadata and stable identity", () => {
  const legacy = {
    id: "notion_page:11111111-1111-4111-8111-111111111111",
    kind: "skill" as const,
    entrypoint: "SKILL.md",
    locator: {
      type: "notion_page" as const,
      page_id: "11111111-1111-4111-8111-111111111111",
      database_id: database,
      data_source_id: "ds",
    },
    name: "Sample Skill",
    alias: "sample-skill",
    description: "Review resources",
    default_context: false,
    ref: "skill://11111111-1111-4111-8111-111111111111/SKILL.md",
  }
  expect(decode(ContentRecordSchema, legacy).default_context).toBe(false)
  expect(decode(ContentRecordSchema, { ...legacy, default_context: true }).default_context).toBe(
    true,
  )
  expect(() => decode(ContentRecordSchema, { ...legacy, default_context: "true" })).toThrow()
  const cached = decode(CatalogSchema, {
    scope: "scope",
    fetched_at: 0,
    databases: [],
    records: [legacy],
    coverage: {
      method: "fixture",
      exhaustive: true,
      queried_data_sources: [],
      failed_sources: [],
      search_index_limited: false,
    },
  })
  expect(cached.records[0]?.default_context).toBe(false)
  const snapshot = {
    snapshot_id: "s_" + "a".repeat(64),
    scope: "scope",
    record: legacy,
    entrypoint: "SKILL.md",
    version_id: "old",
    created_at: 0,
    files: [],
  }
  const restored = decode(SnapshotSchema, snapshot)
  expect(restored.record.default_context).toBe(false)
  expect(restored.snapshot_id).toBe(snapshot.snapshot_id)
  expect(restored.version_id).toBe(snapshot.version_id)
  expect(restored.files).toEqual(snapshot.files)
})

// Metadata and exact Router ref captured by upstream-runner/raw/v1-cold-router.1.stdout
// and v1-status.1.stdout; no local runner directory or live Notion access is required.
const runner = {
  subscription: "3fd5636c-236e-81b9-9da8-dad8c705f36b",
  database: "af1eb768-3e4c-40e8-9741-bdfba8fe1534",
  source: "4568df18-ac6e-49fc-b020-5f85bb63a2ae",
  target: "d9091165-4e39-42af-a8d1-86f886d38827",
  member: "3fd5636c-236e-8140-8afd-cd19f89e2b9f",
  name: "Upstream Proof Pkglpdgfpegigpga",
  hash: "72bb6a12f5431285d90129adb2952bc07e3ea7d1f249505195d87e74b105a401",
  revision: "1202ff7b8779ad6bc99eedcf070058153f0e0712",
  ref: "skill://upstream%3A3fd5636c-236e-81b9-9da8-dad8c705f36b/ROUTER.md",
}

type CatalogFault =
  | "none"
  | "query"
  | "database-id"
  | "database-trash"
  | "source-id"
  | "source-parent"
  | "source-trash"
  | "locator"
  | "member-missing"
  | "member-hash"
  | "member-marker"
  | "member-parent"
  | "member-relation"
  | "other-target"

function publishedCatalogFixture(fault: CatalogFault = "none", routers = 1, memberCount = 1) {
  const requests: string[] = []
  const writes = new Map<string, unknown>()
  const rich = (value: string) => ({ type: "rich_text", rich_text: [{ plain_text: value }] })
  const content = {
    alias: "proof",
    database_id: runner.target,
    title: "Proof Content",
    data_source_ids: ["content-ds"],
    role: "content" as const,
  }
  const upstream = {
    id: fault === "database-id" ? database : runner.database,
    database_type: null,
    in_trash: fault === "database-trash",
    title: [{ plain_text: "Proof Upstream" }],
    data_sources: [
      { id: runner.source, name: "Subscriptions" },
      ...(fault === "locator" ? [{ id: "other-upstream-ds", name: "Other subscriptions" }] : []),
    ],
  }
  const memberEntries = Array.from({ length: Math.max(1, memberCount) }, (_, index) => ({
    member_key: `skills/proof-pkglpdgfpegigpga${index ? `-${index}` : ""}`,
    page_id:
      index === 0 ? runner.member : `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
    content_hash: runner.hash,
  }))
  const subscription = {
    id: runner.subscription,
    parent: { data_source_id: fault === "locator" ? "other-upstream-ds" : runner.source },
    properties: {
      Name: { type: "title", title: [{ plain_text: runner.name }] },
      Description: rich("Owned real upstream proof pkglpdgfpegigpga"),
      Status: { type: "select", select: { name: "verified" } },
      Source: rich(
        JSON.stringify({
          provider: { type: "git", url: "https://example.com/proof.git", ref: "main" },
        }),
      ),
      "Target Database ID": rich(fault === "other-target" ? database : runner.target),
      "Default Context": { type: "checkbox", checkbox: true },
      "Published Members": rich(
        JSON.stringify({
          version: 1,
          revision: runner.revision,
          plan_hash: "c".repeat(64),
          publisher_subscription_id: runner.subscription,
          members: memberEntries.slice(0, memberCount),
        }),
      ),
    },
  }
  const member = {
    ...row,
    id: runner.member,
    parent: {
      data_source_id: fault === "member-parent" ? "wrong-ds" : "content-ds",
      database_id: runner.target,
    },
    properties: {
      ...row.properties,
      Upstream: {
        type: "relation",
        relation: fault === "member-relation" ? [] : [{ id: runner.subscription }],
        has_more: false,
      },
      "Upstream Key": rich("skills/proof-pkglpdgfpegigpga"),
      "Published Hash": rich(fault === "member-hash" ? "0".repeat(64) : runner.hash),
      Publication: rich(
        JSON.stringify({
          version: 2,
          operation_id: "publish:proof",
          intended_hash: runner.hash,
          state: fault === "member-marker" ? "writing" : "committed",
          revision: "d".repeat(64),
          manifest_hash: "e".repeat(64),
          ownership_hash: "f".repeat(64),
        }),
      ),
    },
  }
  const memberRows = memberEntries.map((entry, index) => ({
    ...member,
    id: entry.page_id,
    properties: {
      ...member.properties,
      RenamedTitle:
        index === 0
          ? member.properties.RenamedTitle
          : { type: "title", title: [{ plain_text: `Additional Skill ${index}` }] },
      "Upstream Key": rich(entry.member_key),
    },
  }))
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) => {
      requests.push(path)
      const list = (results: unknown[]) =>
        Effect.succeed({ results, has_more: false, next_cursor: null })
      if (path === "v1/users/me") return Effect.succeed({ id: "user", object: "user" })
      if (path === "v1/search") return list([])
      if (path === `v1/databases/${runner.target}`)
        return Effect.succeed({
          id: runner.target,
          database_type: "skills",
          title: [{ plain_text: content.title }],
          data_sources: [{ id: "content-ds", name: content.title }],
        })
      if (path === "v1/data_sources/content-ds/query")
        return list(fault === "member-missing" ? [row] : memberRows)
      if (path === `v1/databases/${runner.database}`) return Effect.succeed(upstream)
      if (path === `v1/data_sources/${runner.source}`)
        return Effect.succeed({
          id: fault === "source-id" ? "wrong-ds" : runner.source,
          title: [],
          parent: { database_id: fault === "source-parent" ? runner.target : runner.database },
          in_trash: fault === "source-trash",
        })
      if (path === `v1/data_sources/${runner.source}/query`)
        return fault === "query"
          ? Effect.fail(fail("ACCESS_DENIED", "denied"))
          : list(
              Array.from({ length: routers }, (_, index) => ({
                ...subscription,
                id:
                  index === 0
                    ? subscription.id
                    : `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
              })),
            )
      if (path === "v1/data_sources/other-upstream-ds")
        return Effect.succeed({
          id: "other-upstream-ds",
          title: [],
          parent: { database_id: runner.database },
        })
      if (path === "v1/data_sources/other-upstream-ds/query") return list([])
      return Effect.die(new Error(`Unexpected metadata discovery request: ${path}`))
    },
  })
  const store = Layer.effect(
    Store,
    Effect.gen(function* () {
      const base = yield* Store
      return {
        ...base,
        readJson: ((key, schema) =>
          Effect.sync(() =>
            key === "config.json"
              ? decode(schema, { upstream_database: runner.database, sources: [content] })
              : undefined,
          )) satisfies typeof base.readJson,
        writeJson: ((key, value) =>
          Effect.sync(() => {
            writes.set(key, value)
          })) satisfies typeof base.writeJson,
      }
    }),
  ).pipe(Layer.provide(memoryStore))
  return {
    content,
    subscription,
    requests,
    writes,
    run: (explicit = false, selection: "all" | "content" = "all") =>
      Effect.runPromise(
        catalog({ refresh: true, ...(explicit ? { database: "proof" } : {}) }, selection).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, api, store)),
        ),
      ),
  }
}

test("normal and explicit catalogs preserve upstream provenance and the real exact Router ref", async () => {
  for (const explicit of [false, true]) {
    const f = publishedCatalogFixture("none", 1, 2)
    const result = await f.run(explicit)
    expect(result.databases).toEqual([
      f.content,
      {
        alias: runner.database,
        database_id: runner.database,
        title: "Proof Upstream",
        data_source_ids: [runner.source],
        role: "upstream",
      },
    ])
    expect(result.records).toHaveLength(3)
    expect(result.records.find((record) => record.kind === "router")).toMatchObject({
      ref: runner.ref,
      name: runner.name,
      locator: {
        type: "notion_subscription",
        subscription_id: runner.subscription,
        database_id: runner.database,
        data_source_id: runner.source,
        target_database_id: runner.target,
      },
    })
    expect(result.coverage).toMatchObject({
      method: explicit ? "explicit_database" : "search_and_registered",
      exhaustive: explicit,
      queried_data_sources: ["content-ds", runner.source],
      failed_sources: [],
    })
    const cached = [...f.writes.entries()].find(([key]) => key.startsWith("cache/catalogs/"))?.[1]
    expect(decode(CatalogSchema, cached).databases).toEqual(result.databases)
    expect(f.requests.indexOf(`v1/data_sources/${runner.source}`)).toBeLessThan(
      f.requests.indexOf(`v1/data_sources/${runner.source}/query`),
    )
    expect(f.requests.filter((path) => path.startsWith("v1/pages/"))).toEqual([])
  }
})

for (const { name, repository, prefix } of [
  { name: "Pstack", repository: "plugins", prefix: "pstack" },
  { name: "Matt", repository: "skills", prefix: "matt" },
]) {
  test(`upstream ${name} uses its Notion name as the display namespace`, async () => {
    const f = publishedCatalogFixture()
    f.subscription.properties.Name.title[0]!.plain_text = name
    f.subscription.properties.Source.rich_text[0]!.plain_text = JSON.stringify({
      provider: { type: "git", url: `https://example.com/${repository}.git`, ref: "main" },
    })
    const result = await f.run()
    expect(
      result.records.find((record) => record.id === `notion_page:${runner.member}`),
    ).toMatchObject({
      name: "Sample Skill",
      alias: "sample-skill",
      ref: `skill://${runner.member}/SKILL.md`,
      upstream: { repo: prefix },
    })
  })
}

for (const count of [0, 1, 2]) {
  test(`automatic Routers require multiple Skills: ${count} published`, async () => {
    const f = publishedCatalogFixture("none", 1, count)
    const result = await f.run(true)
    expect(
      result.records.filter((record) => record.kind === "router").map((record) => record.ref),
    ).toEqual(count >= 2 ? [runner.ref] : [])
    expect(
      result.records.find((record) => record.id === `notion_page:${runner.member}`),
    ).toMatchObject({
      kind: "skill",
      ref: `skill://${runner.member}/SKILL.md`,
    })
    if (count === 1)
      expect(
        result.records.find((record) => record.id === `notion_page:${runner.member}`)?.upstream,
      ).toEqual({ repo: "upstream-proof-pkglpdgfpegigpga" })
    expect(result.coverage.failed_sources).toEqual([])
    expect(result.coverage.exhaustive).toBe(true)
  })
}

test("catalog inventories bound request growth while preserving every Router and member record", async () => {
  const small = publishedCatalogFixture("none", 1, 2)
  const many = publishedCatalogFixture("none", 55, 2)
  const first = await small.run(true)
  const result = await many.run(true)
  expect(result.records.filter((record) => record.kind === "router")).toHaveLength(55)
  expect(result.records.filter((record) => record.kind === "skill")).toEqual(
    first.records.filter((record) => record.kind === "skill"),
  )
  expect(result.coverage).toEqual(first.coverage)
  expect(result.coverage.exhaustive).toBe(true)
  expect(many.requests).toEqual(small.requests)
})

for (const fault of [
  "member-missing",
  "member-hash",
  "member-marker",
  "member-parent",
  "member-relation",
] as const) {
  test(`catalog does not silently accept ${fault} from its member inventory`, async () => {
    const f = publishedCatalogFixture(fault)
    const result = await f.run(true)
    expect(result.records.filter((record) => record.kind === "router")).toEqual([])
    expect(result.records.filter((record) => record.kind === "skill")).toHaveLength(1)
    expect(result.coverage.exhaustive).toBe(false)
    expect(result.coverage.failed_sources).toContainEqual(
      expect.objectContaining({ id: runner.subscription }),
    )
    expect(f.requests.some((path) => path.startsWith("v1/pages/"))).toBe(false)
  })
}

test("explicit catalog excludes unrelated Router targets without treating absent members as a source failure", async () => {
  const result = await publishedCatalogFixture("other-target").run(true)
  expect(result.records.map((record) => record.kind)).toEqual(["skill"])
  expect(result.coverage.failed_sources).toEqual([])
  expect(result.coverage.exhaustive).toBe(true)
})

test("content-only selection excludes upstream records, provenance and network requests", async () => {
  const f = publishedCatalogFixture()
  const result = await f.run(true, "content")
  expect(result.databases).toEqual([f.content])
  expect(result.records.map((record) => record.kind)).toEqual(["skill"])
  expect(result.coverage.queried_data_sources).toEqual(["content-ds"])
  expect(
    f.requests.some(
      (path) =>
        path.includes(runner.database) ||
        path.includes(runner.source) ||
        path.includes(runner.subscription),
    ),
  ).toBe(false)
})

test("upstream query failure preserves successful content with structured non-atomic coverage", async () => {
  const f = publishedCatalogFixture("query")
  const result = await f.run(true)
  expect(result.records.map((record) => record.kind)).toEqual(["skill"])
  expect(result.databases.map((source) => source.role)).toEqual(["content", "upstream"])
  expect(result.coverage).toMatchObject({
    exhaustive: false,
    queried_data_sources: ["content-ds"],
    failed_sources: [
      {
        id: runner.source,
        code: "ACCESS_DENIED",
        database_id: runner.database,
        data_source_id: runner.source,
        alias: runner.database,
        title: "Upstream subscriptions",
      },
    ],
  })
  expect(() => resolveRecord("sample-skill", result)).toThrow()
})

for (const fault of [
  "database-id",
  "database-trash",
  "source-id",
  "source-parent",
  "source-trash",
  "locator",
] as const) {
  test(`catalog rejects invalid upstream ${fault} without losing content`, async () => {
    const f = publishedCatalogFixture(fault)
    const result = await f.run(true)
    expect(result.records.map((record) => record.kind)).toEqual(["skill"])
    expect(result.coverage.exhaustive).toBe(false)
    expect(result.coverage.failed_sources).toEqual([
      expect.objectContaining({
        id: fault.startsWith("database")
          ? runner.database
          : fault === "locator"
            ? runner.subscription
            : runner.source,
        code: "INVALID_RESPONSE",
        database_id: runner.database,
      }),
    ])
    if (fault !== "locator")
      expect(f.requests).not.toContain(`v1/data_sources/${runner.source}/query`)
    else expect(result.coverage.queried_data_sources).toContain(runner.source)
  })
}

test("legacy missing and empty Kind remain skills while multiple Upstream owners are rejected", () => {
  const source = {
    alias: "skills",
    database_id: database,
    title: "Skills",
    data_source_ids: ["ds"],
    role: "content" as const,
  }
  expect(recordFromPage(row, source, "ds").kind).toBe("skill")
  expect(
    recordFromPage(
      { ...row, properties: { ...row.properties, Kind: { type: "select", select: null } } },
      source,
      "ds",
    ).kind,
  ).toBe("skill")
  expect(() =>
    recordFromPage(
      {
        ...row,
        properties: {
          ...row.properties,
          Upstream: {
            type: "relation",
            relation: [{ id: runner.subscription }, { id: row.id }],
            has_more: false,
          },
        },
      },
      source,
      "ds",
    ),
  ).toThrow("Upstream must contain at most one subscription relation.")
})
