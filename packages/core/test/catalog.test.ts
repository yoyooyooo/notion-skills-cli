import { expect, test } from "bun:test"
import { Clock, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { catalog } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { decode, fail, resolveSkill } from "../src/model.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const source = {
  id: "ds",
  parent: { database_id: database },
  title: [{ plain_text: "Skills" }],
  database_type: "skills",
}
const row = {
  id: "page",
  properties: {
    RenamedTitle: { type: "title", title: [{ plain_text: "Sample Skill" }] },
    RenamedDescription: {
      id: "notion%3A%2F%2Fskills%2Fdescription_property",
      rich_text: [{ plain_text: "Review resources" }],
    },
  },
}

const memoryStore = Layer.succeed(Store, {
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
                    id: "page-next",
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
  expect(result.skills).toEqual([
    {
      id: "page-next",
      name: "Another Skill",
      alias: "another-skill",
      description: "Review resources",
      database_id: database,
      data_source_id: "ds",
      ref: "skill://page-next/SKILL.md",
    },
    {
      id: "page",
      name: "Sample Skill",
      alias: "sample-skill",
      description: "Review resources",
      database_id: database,
      data_source_id: "ds",
      ref: "skill://page/SKILL.md",
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
                    RenamedTitle: { type: "title", title: [{ plain_text: "Sample  Skill" }] },
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
    details: { page_id: "page", name: "Sample  Skill" },
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
          fetched_at: yield* Clock.currentTimeMillis,
          databases: [],
          skills: [
            {
              id: "page",
              name: "资源治理",
              alias: "资源治理",
              description: "Review resources",
              database_id: database,
              data_source_id: "ds",
              ref: "skill://page/SKILL.md",
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
    details: { page_id: "page", name: "资源治理" },
  })
})

test("switching credentials for one user isolates cached discovery and switching back reuses its own catalog", async () => {
  const files = new Map<string, unknown>()
  let credential = "first-credential"
  let queryCount = 0
  const cachedStore = Layer.succeed(Store, {
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
          results: [{ ...row, id: credential }],
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
  expect(first.skills.map((skill) => skill.id)).toEqual(["first-credential"])
  expect(second.skills.map((skill) => skill.id)).toEqual(["second-credential"])
  expect(second.scope).not.toBe(first.scope)
  credential = "first-credential"
  const restored = await run()
  expect(restored.scope).toEqual(first.scope)
  expect(restored.skills).toEqual(first.skills)
  expect(restored.fetched_at).toEqual(first.fetched_at)
  expect(queryCount).toBe(2)
})

test("same-name skills stay distinct by database, alias selection scopes lookup and failures identify their owner", async () => {
  const otherDatabase = "87654321-1234-1234-1234-123456789abc"
  const registered = [
    { alias: "frontend", database_id: database, title: "Frontend Skills", data_source_ids: ["ds"] },
    {
      alias: "ops",
      database_id: otherDatabase,
      title: "Operations Skills",
      data_source_ids: ["other-ds"],
    },
  ]
  let broken = false
  const store = Layer.succeed(Store, {
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
          results: [{ ...row, id: path.includes("other-ds") ? "ops-page" : "frontend-page" }],
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
  expect(merged.skills.map((skill) => skill.id)).toEqual(["frontend-page", "ops-page"])
  try {
    resolveSkill("sample-skill", merged)
    throw new Error("Expected ambiguity")
  } catch (error) {
    expect(error).toMatchObject({
      code: "SKILL_AMBIGUOUS",
      details: { databases: registered, candidates: merged.skills },
    })
  }
  const scoped = await run("ops")
  expect(scoped.databases).toEqual([registered[1]!])
  expect(resolveSkill("sample-skill", scoped).id).toBe("ops-page")
  broken = true
  const partial = await run()
  expect(partial.skills.map((skill) => skill.id)).toEqual(["frontend-page"])
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
