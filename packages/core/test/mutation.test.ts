import { librarySchemaResponse } from "./library-schema-fixture.ts"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { addSource, libraryId, explicitSource, setDefaultLibrary } from "../src/catalog.ts"
import { ConfigSchema, decode, fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { currentLibrary, currentId } from "./shared-current-fixture.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"

const first = "12345678-1234-1234-1234-123456789abc"
const second = "87654321-1234-1234-1234-123456789abc"
const libraryFor = (id: string) => {
  const offset = id === first ? 100 : 200
  return {
    ...structuredClone(currentLibrary),
    library_id: id,
    operation_id: `library-${id}`,
    skills: { ...currentLibrary.skills, database_id: currentId(offset + 7), data_source_id: currentId(offset) },
    files: {
      ...currentLibrary.files,
      database_id: currentId(offset + 1),
      data_source_id: currentId(offset + 2),
    },
    records: {
      ...currentLibrary.records,
      database_id: currentId(offset + 3),
      data_source_id: currentId(offset + 4),
    },
    sources: {
      ...currentLibrary.sources,
      database_id: currentId(offset + 5),
      data_source_id: currentId(offset + 6),
    },
  }
}
const source = (id: string) => ({
  role: "content" as const,
  alias: id,
  database_id: libraryFor(id).skills.database_id,
  title: "skills",
  data_source_ids: [libraryFor(id).skills.data_source_id],
  shared_library: libraryFor(id),
})
function setup(initial: unknown, ids: string[], broken?: string) {
  let config = initial
  const store = Layer.succeed(Store, {
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
            id: libraryFor(id).skills.data_source_id,
            parent: { database_id: libraryFor(id).skills.database_id },
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
          })),
          has_more: false,
          next_cursor: null,
        })
      const id = path.split("/").at(-1)!
      if (id === broken) return Effect.fail(fail("ACCESS_DENIED", "denied"))
      for (const root of [first, second]) {
        const schema = librarySchemaResponse(path, libraryFor(root))
        if (schema !== undefined) return Effect.succeed(schema)
      }
      return Effect.fail(fail("UNEXPECTED", "unexpected"))
    },
  })
  const live = Layer.mergeAll(NodeServices.layer, store, api)
  const run = <A, E>(operation: Effect.Effect<A, E, Store | Notion>) =>
    Effect.runPromise(operation.pipe(Effect.provide(live)))
  return { run, source, config: () => decode(ConfigSchema, config) }
}

test("default updates and source registration preserve each other's configuration", async () => {
  const fixture = setup({ sources: [], token: "configured-fixture-token" }, [])
  await fixture.run(setDefaultLibrary(first))
  await fixture.run(addSource("other", second))
  expect(fixture.config()).toEqual({
    default_library: first,
    token: "configured-fixture-token",
    sources: [{ ...fixture.source(second), alias: "other" }],
  })
  await fixture.run(setDefaultLibrary())
  expect(fixture.config()).toEqual({
    sources: [{ ...fixture.source(second), alias: "other" }],
    token: "configured-fixture-token",
  })
})

test("registered aliases select Library roots exactly and defaults persist canonical IDs", async () => {
  const fixture = setup({ sources: [], token: "configured-fixture-token" }, [first, second])
  await fixture.run(addSource("frontend", first))
  await fixture.run(addSource("ops", second))
  expect((await fixture.run(explicitSource("frontend"))).shared_library?.library_id).toBe(first)
  expect((await fixture.run(explicitSource(first))).alias).toBe("frontend")
  expect(
    (await fixture.run(explicitSource(`https://www.notion.so/${first.replaceAll("-", "")}`))).alias,
  ).toBe("frontend")
  expect((await fixture.run(explicitSource("ops"))).shared_library?.library_id).toBe(second)
  await fixture.run(setDefaultLibrary("frontend"))
  expect(fixture.config().default_library).toBe(first)
  expect(fixture.config().token).toBe("configured-fixture-token")
  expect((await fixture.run(explicitSource("ops"))).shared_library?.library_id).toBe(second)
  for (const selector of ["Frontend", "Skills", "missing"]) {
    const result = await fixture.run(explicitSource(selector).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe("LIBRARY_NOT_FOUND")
  }
})

test("an ambiguous or inaccessible alias never redirects to another Library", async () => {
  const denied = setup(
    {
      sources: [
        { ...source(first), alias: "frontend", title: "Frontend Skills" },
      ],
      default_library: second,
    },
    [second],
    first,
  )
  const result = await denied.run(explicitSource("frontend").pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "ACCESS_DENIED",

  })
  const duplicate = setup(
    {
      sources: [first, second].map((root) => ({ ...source(root), alias: "shared" })),
    },
    [first, second],
  )
  const ambiguous = await duplicate.run(libraryId("shared").pipe(Effect.result))
  expect(ambiguous._tag === "Failure" && ambiguous.failure.code).toBe("LIBRARY_AMBIGUOUS")
  expect(await duplicate.run(libraryId(first))).toBe(first)
})
