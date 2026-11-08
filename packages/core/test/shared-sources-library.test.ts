import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fail, property, text, SkillsError } from "../src/model.ts"
import { initializeSourceLibrary, attachSourceLibrary } from "../src/shared-sources-library.ts"
import {
  LIBRARY_MARKER,
  libraryFromDatabase,
  sharedSkillProperties,
  sharedFileProperties,
  sharedRecordProperties,
} from "../src/shared-library.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { library as base, id } from "./shared-snapshot-fixture.ts"
import { registrationStore } from "./shared-source-registration-fixture.ts"

function fixture(
  fixtureOptions: { encodedRollupIds?: boolean; originFault?: "mismatch" | "unknown" } = {},
) {
  const library: typeof base = {
    ...structuredClone(base),
    files: {
      ...base.files,
      property_ids: {
        ...base.files.property_ids,
        ...(fixtureOptions.encodedRollupIds ? { Skill: "a%5B_t" } : {}),
      },
    },
  }
  const local = registrationStore()
  const store: Store["Service"] = {
    ...local.store,
    listKeys: (prefix) =>
      Effect.sync(() => [...local.records.keys()].filter((key) => key.startsWith(prefix)).sort()),
  }
  const databases = new Map<string, Record<string, unknown>>()
  const schemas = new Map<string, Record<string, unknown>>()
  const calls: Array<{ path: string; method: string }> = []
  let next = 90,
    unknown: "accepted" | "absent" | undefined
  let originFault = fixtureOptions.originFault,
    originCreated = false
  const field = (name: string, value: unknown, stable: string) => {
    const shape = property(value),
      type = Object.keys(shape)[0]!
    return {
      id: stable,
      name,
      type,
      ...shape,
      ...(type === "relation"
        ? {
            relation: {
              ...property(shape.relation),
              type: property(shape.relation).dual_property ? "dual_property" : "single_property",
            },
          }
        : {}),
      ...(type === "rollup"
        ? {
            rollup: {
              ...property(shape.rollup),
              relation_property_id: decodeURIComponent(
                String(property(shape.rollup).relation_property_id),
              ),
              rollup_property_id: decodeURIComponent(
                String(property(shape.rollup).rollup_property_id),
              ),
            },
          }
        : {}),
    }
  }
  for (const [role, layout] of [
    ["skills", sharedSkillProperties],
    ["files", sharedFileProperties(base.skills.data_source_id)],
    ["records", sharedRecordProperties(base.skills.data_source_id)],
  ] as const) {
    const table = library[role]
    databases.set(table.database_id, {
      object: "database",
      id: table.database_id,
      parent: { page_id: base.parent_page_id },
      is_inline: false,
      in_trash: false,
      data_sources: [{ id: table.data_source_id }],
      description:
        role === "skills" ? [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }] : [],
    })
    schemas.set(table.data_source_id, {
      object: "data_source",
      id: table.data_source_id,
      parent: { database_id: table.database_id },
      in_trash: false,
      properties: Object.fromEntries(
        Object.entries(layout).map(([name, value]) => [
          name,
          field(name, value, table.property_ids[name]!),
        ]),
      ),
    })
  }
  const api: Notion["Service"] = {
    credentialIdentity: Effect.succeed("sources-init-test"),
    version: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (body ? "POST" : "GET"),
          value = property(body)
        calls.push({ path, method })
        if (path.startsWith(`v1/blocks/${base.parent_page_id}/children`))
          return Effect.succeed({
            object: "list",
            results: [...databases.keys()].map((db) => ({ id: db, type: "child_database" })),
            has_more: false,
            next_cursor: null,
          })
        if (path === "v1/databases" && method === "POST") {
          if (unknown === "absent") {
            unknown = undefined
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Unobserved Sources POST"))
          }
          const db = id(next++),
            ds = id(next++)
          const layout = property(property(value.initial_data_source).properties),
            props: Record<string, unknown> = {}
          for (const [name, v] of Object.entries(layout)) {
            const stable = name === "Name" ? "title" : `new-${next++}`
            const converted = field(name, v, stable)
            if (converted.type === "relation") {
              const relation = property(converted.relation),
                target = schemas.get(String(relation.data_source_id))!
              const reverse =
                fixtureOptions.encodedRollupIds && name === "Skills"
                  ? "E%5Ega"
                  : `reverse-${next++}`
              property(target.properties).Origin = field(
                "Origin",
                { relation: { data_source_id: ds, dual_property: { synced_property_id: stable } } },
                reverse,
              )
              Object.assign(converted, {
                relation: {
                  ...relation,
                  type: "dual_property",
                  dual_property: { synced_property_id: reverse },
                },
              })
            }
            props[name] = converted
          }
          const row = {
            object: "database",
            id: db,
            parent: value.parent,
            title: value.title,
            description: value.description,
            is_inline: value.is_inline,
            in_trash: false,
            data_sources: [{ id: ds }],
          }
          databases.set(db, row)
          schemas.set(ds, {
            object: "data_source",
            id: ds,
            parent: { database_id: db },
            in_trash: false,
            properties: props,
          })
          if (unknown === "accepted") {
            unknown = undefined
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost Sources POST response"))
          }
          return Effect.succeed(structuredClone(row))
        }
        const db = databases.get(path.replace("v1/databases/", ""))
        if (db) {
          if (method === "PATCH") Object.assign(db, value)
          return Effect.succeed(structuredClone(db))
        }
        const schema = schemas.get(path.replace("v1/data_sources/", ""))
        if (schema) {
          if (method === "PATCH")
            for (const [key, raw] of Object.entries(property(value.properties))) {
              const fields = property(schema.properties),
                priorName =
                  Object.keys(fields).find((name) => property(fields[name]).id === key) ?? key
              const prior = property(fields[priorName]),
                change = property(raw),
                name = String(change.name ?? priorName)
              const updated = change.name
                ? { ...prior, name }
                : field(name, raw, typeof prior.id === "string" ? prior.id : `new-${next++}`)
              if (name !== priorName) delete fields[priorName]
              fields[name] = updated
            }
          const observed = structuredClone(schema)
          if (
            path === `v1/data_sources/${library.files.data_source_id}` &&
            method === "PATCH" &&
            property(property(value.properties).Origin).rollup !== undefined
          ) {
            originCreated = true
            if (originFault === "unknown") {
              originFault = undefined
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost Origin rollup response"))
            }
          }
          if (
            path === `v1/data_sources/${library.files.data_source_id}` &&
            method === "GET" &&
            originCreated &&
            originFault === "mismatch"
          ) {
            originFault = undefined
            property(property(property(observed.properties).Origin).rollup).rollup_property_id =
              "different-source-property"
          }
          return Effect.succeed(observed)
        }
        return Effect.fail(fail("UNEXPECTED_REQUEST", path))
      }),
  }
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Notion, api),
        Effect.provideService(Store, store),
        Effect.provide(NodeServices.layer),
      ) as Effect.Effect<A, E, never>,
    )
  return {
    run,
    calls,
    databases,
    schemas,
    library,
    records: local.records,
    lose: (mode: "accepted" | "absent") => {
      unknown = mode
    },
    descriptor: () => libraryFromDatabase(databases.get(base.skills.database_id))!,
  }
}

test("explicit Sources initialization creates one full-page table, relations and derived file origin", async () => {
  const f = fixture(),
    result = await f.run(initializeSourceLibrary(base))
  expect(result.reused).toBe(false)
  expect(result.library.sources).toBeDefined()
  expect(f.databases).toHaveProperty("size", 4)
  expect(result.library.skills.database_id).toBe(base.skills.database_id)
  expect(
    f.calls.filter((call) => call.path === "v1/databases" && call.method === "POST"),
  ).toHaveLength(1)
  const origin = property(property(f.schemas.get(base.files.data_source_id)!.properties).Origin)
  expect(origin.type).toBe("rollup")
  expect(property(origin.rollup).rollup_property_id).toBe(result.library.skills.property_ids.Origin)
  expect(f.descriptor()).toEqual(result.library)
  f.calls.length = 0
  expect(await f.run(initializeSourceLibrary(result.library))).toMatchObject({ reused: true })
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})
test("captured raw Origin rollup IDs match encoded stable properties and repeat without writes", async () => {
  const f = fixture({ encodedRollupIds: true })
  const result = await f.run(initializeSourceLibrary(f.library))
  expect(result.library.skills.property_ids.Origin).toBe("E%5Ega")
  expect(result.library.files.property_ids.Skill).toBe("a%5B_t")
  const origin = property(property(f.schemas.get(base.files.data_source_id)!.properties).Origin)
  expect(origin.rollup).toMatchObject({
    relation_property_id: "a[_t",
    rollup_property_id: "E^ga",
    function: "show_unique",
  })
  f.calls.length = 0
  expect((await f.run(initializeSourceLibrary(result.library))).library).toEqual(result.library)
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})

test("an acknowledged Origin readback failure resumes its original receipt without repeating PATCH", async () => {
  const f = fixture({ encodedRollupIds: true, originFault: "mismatch" })
  await expect(f.run(initializeSourceLibrary(f.library))).rejects.toMatchObject({
    code: "SOURCE_WRITE_MISMATCH",
  })
  const original = [...f.records].find(
    ([, value]) => property(value).identity === "initialize-file-origin-rollup",
  )
  if (!original) throw new Error("Missing original Origin dispatch")
  const key = original[0]
  const ackKey = key.replace("/source-op-", "/source-ack-")
  const receiptKey = key.replace("/source-op-", "/source-receipt-")
  const ack = structuredClone(f.records.get(ackKey))
  expect(ack).toBeDefined()
  expect(f.records.has(receiptKey)).toBe(false)
  f.calls.length = 0
  const result = await f.run(initializeSourceLibrary(f.library))
  expect(result.library.sources).toBeDefined()
  expect(f.records.get(ackKey)).toEqual(ack)
  expect(f.records.get(receiptKey)).toMatchObject({
    operation_id: property(original[1]).operation,
    verified: true,
  })
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([
    { path: `v1/databases/${base.skills.database_id}`, method: "PATCH" },
  ])
})

test("a visible Origin without its original ACK cannot complete initialization or replay the mutation", async () => {
  const f = fixture({ originFault: "unknown" })
  await expect(f.run(initializeSourceLibrary(f.library))).rejects.toMatchObject({
    code: "SOURCE_WRITE_UNKNOWN",
  })
  f.calls.length = 0
  await expect(f.run(initializeSourceLibrary(f.library))).rejects.toMatchObject({
    code: "SOURCE_WRITE_UNKNOWN",
  })
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
  expect(f.descriptor().sources).toBeUndefined()
})

test.each([
  { relation_property_id: "another-relation" },
  { rollup_property_id: "another-source" },
  { function: "show_original" },
  { rollup_property_id: "E%5Ega" },
])(
  "Origin rollup rejects different identities or function without mutation: %j",
  async (change) => {
    const f = fixture({ encodedRollupIds: true, originFault: "mismatch" })
    await expect(f.run(initializeSourceLibrary(f.library))).rejects.toMatchObject({
      code: "SOURCE_WRITE_MISMATCH",
    })
    const origin = property(property(f.schemas.get(base.files.data_source_id)!.properties).Origin)
    Object.assign(property(origin.rollup), change)
    f.calls.length = 0
    await expect(f.run(initializeSourceLibrary(f.library))).rejects.toMatchObject({
      code: "SOURCE_LIBRARY_CONFLICT",
    })
    expect(f.calls.every((call) => call.method === "GET")).toBe(true)
  },
)

test("visible Sources creation after lost response is observed without creating a second database", async () => {
  const f = fixture()
  f.lose("accepted")
  await expect(f.run(initializeSourceLibrary(base))).rejects.toThrow("verified result")
  const result = await f.run(initializeSourceLibrary(base))
  expect(result.library.sources).toBeDefined()
  expect(
    f.calls.filter((call) => call.path === "v1/databases" && call.method === "POST"),
  ).toHaveLength(1)
})
test("unknown invisible Sources creation is not retried or adopted by display title", async () => {
  const f = fixture()
  f.lose("absent")
  await expect(f.run(initializeSourceLibrary(base))).rejects.toThrow()
  await expect(f.run(initializeSourceLibrary(base))).rejects.toThrow("unresolved")
  expect(
    f.calls.filter((call) => call.path === "v1/databases" && call.method === "POST"),
  ).toHaveLength(1)
})
test("Sources attachment rejects replacing existing content tables before mutations", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSourceLibrary(base))
  f.calls.length = 0
  await expect(
    f.run(
      attachSourceLibrary(base.skills.database_id, {
        ...library,
        files: { ...library.files, database_id: id(800) },
      }),
    ),
  ).rejects.toThrow("cannot be replaced")
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})
test("stable relation validation rejects a Sources table whose Skills relation targets another library", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSourceLibrary(base))
  f.calls.length = 0
  const props = property(f.schemas.get(library.sources!.data_source_id)!.properties)
  property(property(props.Skills).relation).data_source_id = id(800)
  await expect(f.run(attachSourceLibrary(base.skills.database_id, library))).rejects.toThrow(
    "different Skills",
  )
  expect(f.calls.every((call) => call.method === "GET")).toBe(true)
})
