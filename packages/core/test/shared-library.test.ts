import { expect, test } from "bun:test"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { initializeSharedLibrary, libraryFromDatabase } from "../src/shared-library.ts"
import { Notion } from "../src/notion.ts"
import { fail, property, text, SkillsError } from "../src/model.ts"

const parent = "11111111-1111-4111-8111-111111111111"
const id = (number: number) => `22222222-2222-4222-8222-${number.toString().padStart(12, "0")}`

function fixture(
  unknownFirstCreate = false,
  failures: {
    readonly members?: "accepted" | "not_accepted"
    readonly descriptor?: "accepted" | "not_accepted"
  } = {},
) {
  const databases = new Map<string, { name: string; raw: Record<string, unknown> }>()
  const sources = new Map<string, Record<string, unknown>>()
  const calls: Array<{ path: string; write: boolean; method: string; body: unknown }> = []
  let counter = 0
  let hideMembers = false
  const responseField = (raw: unknown, fieldId: string) => {
    const field = property(raw)
    const type = Object.keys(field)[0]
    const relation = property(field.relation)
    const relationMode =
      relation.single_property !== undefined ? "single_property" : "dual_property"
    return {
      ...field,
      id: fieldId,
      type,
      ...(type === "relation" ? { relation: { ...relation, type: relationMode } } : {}),
    }
  }
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, write: method !== "GET", method, body })
        const value = property(body)
        if (path === `v1/blocks/${parent}/children?page_size=100`)
          return Effect.succeed({
            results: [...databases].map(([databaseId, db]) => ({
              id: databaseId,
              type: "child_database",
              child_database: { title: db.name },
            })),
            has_more: false,
            next_cursor: null,
          })
        if (path === "v1/databases" && method === "POST") {
          const dbId = id(++counter),
            sourceId = id(counter + 100)
          const raw = {
            id: dbId,
            parent: { page_id: parent },
            title: value.title,
            description: [],
            data_sources: [{ id: sourceId, name: "fixture" }],
            in_trash: false,
          }
          databases.set(dbId, { name: text(value.title), raw })
          const properties = Object.fromEntries(
            Object.entries(property(property(value.initial_data_source).properties)).map(
              ([name, raw], index) => {
                const field = property(raw),
                  type = Object.keys(field)[0]
                return [name, responseField(raw, type === "title" ? "title" : `p${index}`)]
              },
            ),
          )
          sources.set(sourceId, {
            id: sourceId,
            parent: { database_id: dbId },
            properties,
            in_trash: false,
          })
          if (unknownFirstCreate && counter === 1)
            return Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Response lost after creating the table."),
            )
          return Effect.succeed(raw)
        }
        const db = databases.get(path.replace("v1/databases/", ""))
        if (db) {
          if (method === "PATCH") {
            if (failures.descriptor !== "not_accepted") Object.assign(db.raw, value)
            if (failures.descriptor !== undefined)
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Descriptor response lost."))
          }
          return Effect.succeed(structuredClone(db.raw))
        }
        const source = sources.get(path.replace("v1/data_sources/", ""))
        if (source) {
          if (method === "PATCH") {
            if (failures.members !== "not_accepted") {
              for (const [name, field] of Object.entries(property(value.properties)))
                property(source.properties)[name] = responseField(
                  field,
                  name === "Members" ? "members%3Aself" : `extra-${name}`,
                )
            }
            if (failures.members !== undefined)
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Members schema response lost."))
          }
          const response = structuredClone(source)
          if (hideMembers) delete property(response.properties).Members
          return Effect.succeed(response)
        }
        return Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected fixture request.", { path }))
      }),
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Notion, api)))),
    )
  return {
    databases,
    sources,
    calls,
    run,
    hideMembers: (hidden: boolean) => {
      hideMembers = hidden
    },
  }
}

test("one parent initializes three related tables and repeats without writes or body reads", async () => {
  const f = fixture()
  const first = await f.run(initializeSharedLibrary({ parent }))
  expect(first.reused).toBe(false)
  expect(f.databases.size).toBe(3)
  expect(first.library.files.property_ids.Skill).toBeDefined()
  expect(first.library.skills.property_ids.Members).toBe("members%3Aself")
  const membersWrite = f.calls.findIndex(
    (call) =>
      call.method === "PATCH" &&
      call.path === `v1/data_sources/${first.library.skills.data_source_id}`,
  )
  const descriptorWrite = f.calls.findIndex(
    (call) =>
      call.method === "PATCH" && call.path === `v1/databases/${first.library.skills.database_id}`,
  )
  expect(membersWrite).toBeGreaterThan(0)
  expect(descriptorWrite).toBeGreaterThan(membersWrite)
  expect(f.calls[membersWrite]?.body).toEqual({
    properties: {
      Members: {
        relation: {
          data_source_id: first.library.skills.data_source_id,
          single_property: {},
        },
      },
    },
  })
  const writes = f.calls.filter((call) => call.write).length
  const second = await f.run(initializeSharedLibrary({ parent }))
  expect(second).toEqual({ ...first, reused: true })
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
  expect(f.calls.some((call) => call.path.includes("/markdown"))).toBe(false)
  const attached = await f.run(initializeSharedLibrary({ entry: first.library.skills.database_id }))
  expect(attached.library).toEqual(first.library)
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("unknown creation retains its operation and does not treat absence as permission to replay", async () => {
  const f = fixture(true)
  const result = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Expected failure")
  if (!(result.failure instanceof SkillsError)) throw result.failure
  const operation = property(result.failure.details).operation_id
  expect(typeof operation).toBe("string")
  const writes = f.calls.filter((call) => call.write).length
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "unfinished initialization",
  )
  await expect(
    f.run(initializeSharedLibrary({ parent, operation: String(operation) })),
  ).rejects.toThrow("Missing rows are not permission")
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("attached library rejects a retargeted relation without any repair writes", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSharedLibrary({ parent }))
  const source = f.sources.get(library.files.data_source_id)
  if (!source) throw Error("Fixture source missing")
  property(property(source.properties).Skill).relation = {
    data_source_id: parent,
    single_property: {},
  }
  const writes = f.calls.filter((call) => call.write).length
  await expect(
    f.run(initializeSharedLibrary({ entry: library.skills.database_id })),
  ).rejects.toThrow("different Skills table")
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("malformed library entry cannot be mistaken for a valid shared mapping", () => {
  expect(libraryFromDatabase({ description: [] })).toBeUndefined()
  expect(() =>
    libraryFromDatabase({ id: parent, description: [{ plain_text: "ntn-skills-library:v1 {}" }] }),
  ).toThrow()
})

test("attachment follows stable property IDs after a user renames columns", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSharedLibrary({ parent }))
  for (const source of f.sources.values())
    source.properties = Object.fromEntries(
      Object.entries(property(source.properties)).map(([name, field]) => [
        `Renamed ${name}`,
        field,
      ]),
    )
  const writes = f.calls.filter((call) => call.write).length
  expect(
    (await f.run(initializeSharedLibrary({ entry: library.skills.database_id }))).library,
  ).toEqual(library)
  expect((await f.run(initializeSharedLibrary({ parent }))).library).toEqual(library)
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("attachment rejects replacement of a registered data source even if its columns match", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSharedLibrary({ parent }))
  const db = f.databases.get(library.files.database_id)
  if (!db) throw Error("Fixture database missing")
  db.raw.data_sources = [{ id: id(999) }]
  const writes = f.calls.filter((call) => call.write).length
  await expect(
    f.run(initializeSharedLibrary({ entry: library.skills.database_id })),
  ).rejects.toThrow("registered data source was replaced")
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "registered data source was replaced",
  )
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("registered Members is optional for old libraries and never silently adopted or created", async () => {
  for (const keepUnregisteredColumn of [true, false]) {
    const f = fixture()
    const { library } = await f.run(initializeSharedLibrary({ parent }))
    const { Members: _, ...properties } = library.skills.property_ids
    const old = { ...library, skills: { ...library.skills, property_ids: properties } }
    const db = f.databases.get(library.skills.database_id)
    const source = f.sources.get(library.skills.data_source_id)
    if (!db || !source) throw Error("Fixture missing")
    db.raw.description = [{ plain_text: `ntn-skills-library:v1 ${JSON.stringify(old)}` }]
    if (!keepUnregisteredColumn) delete property(source.properties).Members
    const before = structuredClone(db.raw.description)
    const writes = f.calls.filter((call) => call.write).length
    expect(
      (await f.run(initializeSharedLibrary({ entry: library.skills.database_id }))).library,
    ).toEqual(old)
    expect((await f.run(initializeSharedLibrary({ parent }))).library).toEqual(old)
    expect(
      (await f.run(initializeSharedLibrary({ parent, operation: library.operation_id }))).library,
    ).toEqual(old)
    expect(db.raw.description).toEqual(before)
    expect(property(source.properties).Members !== undefined).toBe(keepUnregisteredColumn)
    expect(f.calls.filter((call) => call.write).length).toBe(writes)
  }
})

test("descriptor rejects empty, unsafe and overlapping optional Members identities", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSharedLibrary({ parent }))
  for (const memberId of ["", "title", "path/escape", "bad%escape"]) {
    const descriptor = {
      ...library,
      skills: {
        ...library.skills,
        property_ids: { ...library.skills.property_ids, Members: memberId },
      },
    }
    expect(() =>
      libraryFromDatabase({
        id: library.skills.database_id,
        description: [{ plain_text: `ntn-skills-library:v1 ${JSON.stringify(descriptor)}` }],
      }),
    ).toThrow()
  }
  const descriptor = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: {
        ...library.skills.property_ids,
        Unexpected: library.skills.property_ids.Members!,
      },
    },
  }
  expect(() =>
    libraryFromDatabase({
      id: library.skills.database_id,
      description: [{ plain_text: `ntn-skills-library:v1 ${JSON.stringify(descriptor)}` }],
    }),
  ).toThrow("optional Members binding")
})

test("attachment rejects deleted or replaced Members without binding by its unchanged name", async () => {
  for (const replacement of [
    undefined,
    {
      id: "new-member-id",
      type: "relation",
      relation: { type: "single_property", single_property: {}, data_source_id: id(101) },
    },
  ]) {
    const f = fixture()
    const { library } = await f.run(initializeSharedLibrary({ parent }))
    const source = f.sources.get(library.skills.data_source_id)
    if (!source) throw Error("Fixture missing")
    if (replacement === undefined) delete property(source.properties).Members
    else property(source.properties).Members = replacement
    const writes = f.calls.filter((call) => call.write).length
    await expect(
      f.run(initializeSharedLibrary({ entry: library.skills.database_id })),
    ).rejects.toThrow("missing or duplicated")
    expect(f.calls.filter((call) => call.write).length).toBe(writes)
  }
})

test("attachment requires Members to target its own Skills data source and keep a native relation type", async () => {
  for (const change of ["foreign", "wrong_type", "missing_mode", "bad_mode"]) {
    const f = fixture()
    const { library } = await f.run(initializeSharedLibrary({ parent }))
    const source = f.sources.get(library.skills.data_source_id)
    if (!source) throw Error("Fixture missing")
    const members = property(property(source.properties).Members)
    if (change === "foreign")
      property(members.relation).data_source_id = library.files.data_source_id
    if (change === "wrong_type") members.type = "rich_text"
    if (change === "missing_mode") delete property(members.relation).type
    if (change === "bad_mode") property(members.relation).type = "unknown"
    const writes = f.calls.filter((call) => call.write).length
    const result = await f.run(
      initializeSharedLibrary({ entry: library.skills.database_id }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw Error("Expected relation failure")
    if (!(result.failure instanceof SkillsError)) throw result.failure
    expect(result.failure.code).toBe("LIBRARY_SCHEMA_CONFLICT")
    expect(f.calls.filter((call) => call.write).length).toBe(writes)
  }
})

test("known original initialization follows renamed Members by ID and performs no writes", async () => {
  const f = fixture()
  const first = await f.run(initializeSharedLibrary({ parent }))
  for (const source of f.sources.values())
    source.properties = Object.fromEntries(
      Object.entries(property(source.properties)).map(([name, field]) => [
        `Renamed ${name}`,
        field,
      ]),
    )
  const writes = f.calls.filter((call) => call.write).length
  expect(
    await f.run(initializeSharedLibrary({ parent, operation: first.library.operation_id })),
  ).toEqual({ ...first, reused: true })
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("accepted but unknown Members PATCH retains original operation and never replays either PATCH", async () => {
  const f = fixture(false, { members: "accepted" })
  const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (first._tag !== "Failure") throw Error("Expected unknown Members result")
  if (!(first.failure instanceof SkillsError)) throw first.failure
  expect(first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(property(first.failure.details).stage).toBe("members")
  const operation = String(property(first.failure.details).operation_id)
  const writes = f.calls.filter((call) => call.write).length
  expect(writes).toBe(4)
  expect(f.databases.size).toBe(3)
  expect(property(f.sources.get(id(101))?.properties).Members).toBeDefined()
  const recovered = await f.run(initializeSharedLibrary({ parent, operation }).pipe(Effect.result))
  if (recovered._tag !== "Failure") throw Error("Unregistered descriptor must stay unresolved")
  if (!(recovered.failure instanceof SkillsError)) throw recovered.failure
  expect(recovered.failure.code).toBe("LIBRARY_INIT_INCOMPLETE")
  expect(property(recovered.failure.details).stage).toBe("descriptor")
  expect(property(recovered.failure.details).members_property_id).toBe("members%3Aself")
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "unfinished initialization",
  )
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("absent or temporarily invisible Members after unknown PATCH is never permission to resend", async () => {
  for (const accepted of [true, false]) {
    const f = fixture(false, { members: accepted ? "accepted" : "not_accepted" })
    const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
    if (first._tag !== "Failure") throw Error("Expected unknown Members result")
    if (!(first.failure instanceof SkillsError)) throw first.failure
    const operation = String(property(first.failure.details).operation_id)
    f.hideMembers(true)
    const writes = f.calls.filter((call) => call.write).length
    const recovered = await f.run(
      initializeSharedLibrary({ parent, operation }).pipe(Effect.result),
    )
    if (recovered._tag !== "Failure") throw Error("Missing schema must stay unresolved")
    if (!(recovered.failure instanceof SkillsError)) throw recovered.failure
    expect(recovered.failure.code).toBe("LIBRARY_INIT_INCOMPLETE")
    expect(property(recovered.failure.details).stage).toBe("members")
    expect(f.calls.filter((call) => call.write).length).toBe(writes)
  }
})

test("accepted but unknown descriptor PATCH is recovered by exact registered readback", async () => {
  const f = fixture(false, { descriptor: "accepted" })
  const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (first._tag !== "Failure") throw Error("Expected unknown descriptor result")
  if (!(first.failure instanceof SkillsError)) throw first.failure
  expect(first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(property(first.failure.details).stage).toBe("descriptor")
  const operation = String(property(first.failure.details).operation_id)
  const writes = f.calls.filter((call) => call.write).length
  const recovered = await f.run(initializeSharedLibrary({ parent, operation }))
  expect(recovered.reused).toBe(true)
  expect(recovered.library.operation_id).toBe(operation)
  expect(recovered.library.skills.property_ids.Members).toBe("members%3Aself")
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("an unknown descriptor PATCH absent on readback is not replayed after Members is visible", async () => {
  const f = fixture(false, { descriptor: "not_accepted" })
  const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (first._tag !== "Failure") throw Error("Expected unknown descriptor result")
  if (!(first.failure instanceof SkillsError)) throw first.failure
  const operation = String(property(first.failure.details).operation_id)
  const writes = f.calls.filter((call) => call.write).length
  const recovered = await f.run(initializeSharedLibrary({ parent, operation }).pipe(Effect.result))
  if (recovered._tag !== "Failure") throw Error("Missing descriptor must stay unresolved")
  if (!(recovered.failure instanceof SkillsError)) throw recovered.failure
  expect(recovered.failure.code).toBe("LIBRARY_INIT_INCOMPLETE")
  expect(property(recovered.failure.details).stage).toBe("descriptor")
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})
