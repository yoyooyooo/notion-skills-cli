import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import {
  addSource,
  creationSource,
  databaseId,
  explicitSource,
  setDefaultDatabase,
} from "../src/catalog.ts"
import { ConfigSchema, decode, fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"

const first = "12345678-1234-1234-1234-123456789abc"
const second = "87654321-1234-1234-1234-123456789abc"
function setup(initial: unknown, ids: string[], broken?: string) {
  let config = initial
  const source = (id: string) => ({
    role: "content" as const,
    alias: id,
    database_id: id,
    title: "Skills",
    data_source_ids: [`ds-${id}`],
  })
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/memory",
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: () => Effect.succeed([]),
    retireKeys: () => Effect.succeed([]),
    readJson: (_key, schema) =>
      Effect.succeed(config === undefined ? undefined : decode(schema, config)),
    writeJson: (_key, value) =>
      Effect.sync(() => {
        config = value
      }),
    readBytes: () => Effect.fail(fail("UNUSED", "unused")),
    writeBytes: () => Effect.void,
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path) => {
      if (path === "v1/search")
        return Effect.succeed({
          results: ids.map((id) => ({
            id: `ds-${id}`,
            parent: { database_id: id },
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
          })),
          has_more: false,
          next_cursor: null,
        })
      const id = path.split("/").at(-1)!
      if (id === broken) return Effect.fail(fail("ACCESS_DENIED", "denied"))
      if (path.startsWith("v1/databases/"))
        return Effect.succeed({
          id,
          database_type: "skills",
          title: [{ plain_text: "Skills" }],
          data_sources: [{ id: `ds-${id}`, name: "Skills" }],
        })
      return Effect.fail(fail("UNEXPECTED", "unexpected"))
    },
  })
  const live = Layer.mergeAll(NodeServices.layer, store, api)
  const run = <A, E>(operation: Effect.Effect<A, E, Store | Notion>) =>
    Effect.runPromise(operation.pipe(Effect.provide(live)))
  return { run, source, config: () => decode(ConfigSchema, config) }
}

test("create database selection honors explicit override, configured default, then a unique discovered database", async () => {
  const fixture = setup({ default_database: first }, [first, second])
  expect((await fixture.run(creationSource(second))).database_id).toBe(second)
  expect((await fixture.run(creationSource())).database_id).toBe(first)
  const unique = setup(undefined, [first])
  expect((await unique.run(creationSource())).database_id).toBe(first)
})

test("create refuses zero/multiple discovered databases and never falls back from a failed default", async () => {
  for (const [ids, code] of [
    [[], "DATABASE_NOT_FOUND"],
    [[first, second], "DATABASE_AMBIGUOUS"],
  ] as const) {
    const fixture = setup(undefined, [...ids])
    const result = await fixture.run(creationSource().pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
  }
  const denied = setup({ default_database: first }, [second], first)
  const result = await denied.run(creationSource().pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("ACCESS_DENIED")
  expect((await denied.run(creationSource(second))).database_id).toBe(second)
})

test("failed registered databases prevent unique auto-selection", async () => {
  const fixture = setup(
    { sources: [{ alias: "broken", database_id: first, title: "Skills", data_source_ids: [] }] },
    [second],
    first,
  )
  const result = await fixture.run(creationSource().pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("CATALOG_INCOMPLETE")
})

test("default updates and source registration preserve each other's configuration", async () => {
  const fixture = setup({ sources: [], token: "configured-fixture-token" }, [])
  await fixture.run(setDefaultDatabase(first))
  await fixture.run(addSource("other", second))
  expect(fixture.config()).toEqual({
    default_database: first,
    token: "configured-fixture-token",
    sources: [{ ...fixture.source(second), alias: "other" }],
  })
  await fixture.run(setDefaultDatabase())
  expect(fixture.config()).toEqual({
    sources: [{ ...fixture.source(second), alias: "other" }],
    token: "configured-fixture-token",
  })
})

test("registered aliases select databases exactly and defaults persist canonical IDs", async () => {
  const fixture = setup({ sources: [], token: "configured-fixture-token" }, [first, second])
  await fixture.run(addSource("frontend", first))
  await fixture.run(addSource("ops", second))
  expect((await fixture.run(explicitSource("frontend"))).database_id).toBe(first)
  expect((await fixture.run(explicitSource(first))).alias).toBe("frontend")
  expect(
    (await fixture.run(explicitSource(`https://www.notion.so/${first.replaceAll("-", "")}`))).alias,
  ).toBe("frontend")
  expect((await fixture.run(creationSource("ops"))).database_id).toBe(second)
  await fixture.run(setDefaultDatabase("frontend"))
  expect(fixture.config().default_database).toBe(first)
  expect(fixture.config().token).toBe("configured-fixture-token")
  expect((await fixture.run(creationSource())).database_id).toBe(first)
  expect((await fixture.run(creationSource("ops"))).database_id).toBe(second)
  for (const selector of ["Frontend", "Skills", "missing"]) {
    const result = await fixture.run(explicitSource(selector).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("DATABASE_NOT_FOUND")
  }
})

test("an ambiguous or inaccessible alias never redirects to another database", async () => {
  const denied = setup(
    {
      sources: [
        { alias: "frontend", database_id: first, title: "Frontend Skills", data_source_ids: [] },
      ],
      default_database: second,
    },
    [second],
    first,
  )
  const result = await denied.run(creationSource("frontend").pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "ACCESS_DENIED",
    details: { database_id: first, alias: "frontend", title: "Frontend Skills" },
  })
  const duplicate = setup(
    {
      sources: [first, second].map((database_id) => ({
        alias: "shared",
        database_id,
        title: "Skills",
        data_source_ids: [],
      })),
    },
    [first, second],
  )
  const ambiguous = await duplicate.run(databaseId("shared").pipe(Effect.result))
  expect(ambiguous._tag === "Failure" && ambiguous.failure.code).toBe("DATABASE_AMBIGUOUS")
  expect(await duplicate.run(databaseId(first))).toBe(first)
})
