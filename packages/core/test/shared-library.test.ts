import { afterAll, expect, test } from "bun:test"
import { Crypto, Effect, Layer, Schema } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import { Store } from "../src/store.ts"
import {
  initializeSharedLibrary,
  loadSharedLibrary,
  libraryFromDatabase,
  LIBRARY_MARKER,
} from "../src/shared-library.ts"
import { Notion } from "../src/notion.ts"
import { fail, property, text, SkillsError } from "../src/model.ts"

const parent = "11111111-1111-4111-8111-111111111111"
const id = (number: number) => `22222222-2222-4222-8222-${number.toString().padStart(12, "0")}`
const stateParent = mkdtempSync(join(tmpdir(), "ntn-library-init-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(stateParent))
})

function fixture(
  unknownFirstCreate = false,
  failures: {
    readonly root?: "accepted" | "not_accepted"
    readonly members?: "accepted" | "not_accepted"
    readonly descriptor?: "accepted" | "not_accepted"
    readonly origins?: "accepted" | "not_accepted"
    readonly before?: "Files" | "Members" | "Origin" | "descriptor"
  } = {},
) {
  const state = new Map<string, unknown>(),
    root = mkdtempSync(join(stateParent, "case-"))
  const store: Store["Service"] = {
    root,
    configRoot: root,
    cacheRoot: root,
    reserveCacheGeneration: () => Effect.succeed(1),
    listKeys: (prefix) => Effect.succeed([...state.keys()].filter((key) => key.startsWith(prefix))),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          state.delete(key)
          return { key, retention_path: "fixture" }
        }),
      ),
    readJson: (key, schema) =>
      Effect.sync(() =>
        state.has(key) ? Schema.decodeUnknownSync(schema)(state.get(key)) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.sync(() => {
        state.set(key, structuredClone(value))
      }),
    readBytes: () => Effect.fail(fail("UNEXPECTED", "No bytes")),
    writeBytes: () => Effect.fail(fail("UNEXPECTED", "No bytes")),
    backup: () => Effect.fail(fail("UNEXPECTED", "No backup")),
    output: () => Effect.fail(fail("UNEXPECTED", "No output")),
  }
  const roots = new Map<string, { raw: Record<string, unknown>; marker: unknown }>()
  let rootCounter = 0
  let hiddenRoot: string | undefined
  const databases = new Map<string, { name: string; raw: Record<string, unknown> }>()
  const sources = new Map<string, Record<string, unknown>>()
  const calls: Array<{ path: string; write: boolean; method: string; body: unknown }> = []
  let counter = 0
  let hiddenRelation: "Members" | "Requires" | undefined
  let hiddenTable: string | undefined
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
        if (path === `v1/pages/${parent}`) return Effect.succeed({ object: "page", id: parent, in_trash: false, properties: {} })
        if (path === "v1/pages" && method === "POST") {
          const rootId = id(10000 + ++rootCounter)
          const raw = { object: "page", id: rootId, parent: value.parent, properties: value.properties, in_trash: false }
          if (failures.root !== "not_accepted") roots.set(rootId, { raw, marker: property((value.children as unknown[])[0]) })
          if (failures.root !== undefined) return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Root CREATE response was lost."))
          return Effect.succeed(raw)
        }
        const rootRead = roots.get(path.replace("v1/pages/", ""))
        if (rootRead && method === "GET") return Effect.succeed(structuredClone(rootRead.raw))
        if (path === `v1/blocks/${parent}/children?page_size=100`)
          return Effect.succeed({ results: [...roots.keys()].filter(root => root !== hiddenRoot).map(root => ({ id: root, type: "child_page" })), has_more: false, next_cursor: null })
        const rootChildren = /^v1\/blocks\/([^/]+)\/children\?page_size=100$/u.exec(path)
        if (rootChildren && roots.has(rootChildren[1]!)) {
          const rootId = rootChildren[1]!
          return Effect.succeed({
            results: [
              { ...property(roots.get(rootId)!.marker), id: id(20000 + [...roots.keys()].indexOf(rootId)) },
              ...[...databases].filter(([databaseId, db]) => databaseId !== hiddenTable && property(db.raw.parent).page_id === rootId).map(([databaseId, db]) => ({ id: databaseId, type: "child_database", child_database: { title: db.name } })),
            ], has_more: false, next_cursor: null,
          })
        }
        if (path === "v1/databases" && method === "POST") {
          if (text(value.title) === failures.before)
            return Effect.fail(
              fail("REQUEST_BUDGET_EXHAUSTED", "Pause before table dispatch.", {
                phase: "input_rejected",
              }),
            )
          const dbId = id(++counter),
            sourceId = id(counter + 100)
          const raw = {
            object: "database",
            id: dbId,
            parent: value.parent,
            title: value.title,
            description: value.description ?? [],
            is_inline: value.is_inline ?? false,
            data_sources: [{ id: sourceId, name: "fixture" }],
            in_trash: false,
          }
          databases.set(dbId, { name: text(value.title), raw })
          const properties = Object.fromEntries(
            Object.entries(property(property(value.initial_data_source).properties)).map(
              ([name, raw], index) => {
                const field = property(raw),
                  type = Object.keys(field)[0]
                const response = responseField(raw, type === "title" ? "title" : `p${index}`)
                const relation = property(response.relation)
                if (type === "relation" && relation.type === "dual_property") {
                  const target = sources.get(String(relation.data_source_id))
                  if (!target) throw Error("A dual relation must target an existing fixture table")
                  const dual = property(relation.dual_property)
                  const reverseId = `reverse-${sourceId}-${index}`
                  relation.dual_property = { ...dual, synced_property_id: reverseId }
                  property(target.properties)[
                    String(dual.synced_property_name ?? `Related ${sourceId}`)
                  ] = {
                    id: reverseId,
                    type: "relation",
                    relation: {
                      type: "dual_property",
                      data_source_id: sourceId,
                      dual_property: { synced_property_id: response.id },
                    },
                  }
                }
                return [name, response]
              },
            ),
          )
          sources.set(sourceId, {
            object: "data_source",
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
            if (failures.before === "descriptor")
              return Effect.fail(
                fail("REQUEST_BUDGET_EXHAUSTED", "Pause before descriptor dispatch.", {
                  phase: "input_rejected",
                }),
              )
            if (failures.descriptor !== "not_accepted") Object.assign(db.raw, value)
            if (failures.descriptor !== undefined)
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Descriptor response lost."))
          }
          return Effect.succeed(structuredClone(db.raw))
        }
        const source = sources.get(path.replace("v1/data_sources/", ""))
        if (source) {
          if (method === "PATCH") {
            const membersPatch = property(value.properties).Members !== undefined
            const originsPatch = property(value.properties).Origin !== undefined
            if (
              (membersPatch && failures.before === "Members") ||
              (originsPatch && failures.before === "Origin")
            )
              return Effect.fail(
                fail("REQUEST_BUDGET_EXHAUSTED", "Pause before relation dispatch.", {
                  phase: "input_rejected",
                }),
              )
            if (
              (!membersPatch || failures.members !== "not_accepted") &&
              (!originsPatch || failures.origins !== "not_accepted")
            ) {
              for (const [name, field] of Object.entries(property(value.properties)))
                property(source.properties)[name] = responseField(
                  field,
                  name === "Members" ? "members%3Aself" : `extra-${name}`,
                )
            }
            if (membersPatch && failures.members !== undefined)
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Members schema response lost."))
            if (originsPatch && failures.origins !== undefined)
              return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Origin schema response lost."))
          }
          const response = structuredClone(source)
          if (hiddenRelation) delete property(response.properties)[hiddenRelation]
          return Effect.succeed(response)
        }
        return Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected fixture request.", { path }))
      }),
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(Notion, api),
            Layer.succeed(Store, store),
          ),
        ),
      ),
    )
  return {
    roots,
    hideRoot: (root: string | undefined) => { hiddenRoot = root },
    databases,
    sources,
    calls,
    state,
    clearFailures: () => {
      delete failures.root
      failures = {}
    },
    hideTable: (libraryId?: string) => {
      hiddenTable = libraryId
    },
    run,
    hideRelation: (name: "Members" | "Requires") => {
      hiddenRelation = name
    },
  }
}

test("one operation creates a root and four tables; explicit reconciliation and attachment stay read-only", async () => {
  const f = fixture()
  const first = await f.run(initializeSharedLibrary({ parent }))
  expect(first.reused).toBe(false)
  expect(f.databases.size).toBe(4)
  expect(first.library.files.property_ids.Skill).toBeDefined()
  expect(first.library.skills.property_ids.Members).toBe("members%3Aself")
  expect(first.library.skills.property_ids.Requires).toBeDefined()
  expect(first.library.skills.property_ids.Origin).toBeDefined()
  expect(first.library.records.property_ids.Origin).toBeDefined()
  expect(first.library.files.property_ids.Origin).toBe("extra-Origin")
  expect(first.library.sources).toBeDefined()
  expect(
    f.calls
      .filter((call) => call.write)
      .every((call) => /^v1\/(?:pages|databases|data_sources)(?:\/|$)/.test(call.path)),
  ).toBe(true)
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
  const originsWrite = f.calls.findIndex(
    (call) =>
      call.method === "PATCH" &&
      call.path === `v1/data_sources/${first.library.files.data_source_id}`,
  )
  expect(descriptorWrite).toBeGreaterThan(originsWrite)
  expect(f.calls[membersWrite]?.body).toEqual({
    properties: {
      Members: {
        relation: {
          data_source_id: first.library.skills.data_source_id,
          single_property: {},
        },
      },
      Requires: {
        relation: { data_source_id: first.library.skills.data_source_id, single_property: {} },
      },
    },
  })
  const writes = f.calls.filter((call) => call.write).length
  const second = await f.run(initializeSharedLibrary({ parent, operation: first.library.operation_id }))
  expect(second).toEqual({ ...first, reused: true })
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
  expect(f.calls.some((call) => call.path.includes("/markdown"))).toBe(false)
  const attached = await f.run(initializeSharedLibrary({ library: first.library.library_id }))
  expect(attached.library).toEqual(first.library)
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("new libraries use clean full-page titles and atomic internal table identities", async () => {
  const f = fixture()
  const { library } = await f.run(initializeSharedLibrary({ parent }))
  const creates = f.calls.filter((call) => call.path === "v1/databases" && call.method === "POST")
  expect(creates.map((call) => text(property(call.body).title))).toEqual([
    "Skills",
    "Files",
    "Records",
    "Sources",
  ])
  for (const call of creates) {
    const body = property(call.body)
    expect(body.is_inline).toBe(false)
    const description = text(body.description)
    expect(description.startsWith("ntn-skills-table:v1 ")).toBe(true)
    expect(JSON.parse(description.slice("ntn-skills-table:v1 ".length))).toEqual({
      version: 1,
      operation_id: library.operation_id,
      parent_page_id: library.library_id,
      role: text(body.title),
    })
  }
})

test("completed library discovery and original-operation recovery ignore all display titles", async () => {
  const f = fixture()
  const first = await f.run(initializeSharedLibrary({ parent }))
  for (const [libraryId, table] of f.databases) {
    table.name = `用户自定义 ${libraryId}`
    table.raw.title = [{ text: { content: table.name } }]
  }
  const writes = f.calls.filter((call) => call.write).length
  expect(await f.run(initializeSharedLibrary({ library: first.library.library_id }))).toEqual({ ...first, reused: true })
  expect(
    await f.run(initializeSharedLibrary({ parent, operation: first.library.operation_id })),
  ).toEqual({ ...first, reused: true })
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("renaming an unfinished table cannot hide its initialization or permit another create", async () => {
  const f = fixture(true)
  const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (first._tag !== "Failure") throw Error("Expected unknown create")
  if (!(first.failure instanceof SkillsError)) throw first.failure
  const operation = String(property(first.failure.details).operation_id)
  for (const table of f.databases.values()) {
    table.name = "任意名称"
    table.raw.title = [{ text: { content: table.name } }]
  }
  const writes = f.calls.filter((call) => call.write).length
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "unfinished initialization",
  )
  await expect(f.run(initializeSharedLibrary({ parent, operation }))).rejects.toThrow(
    "Missing rows are not permission",
  )
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("a renamed complete original operation cannot be selected through another operation id", async () => {
  const f = fixture()
  await f.run(initializeSharedLibrary({ parent }))
  const writes = f.calls.filter((call) => call.write).length
  await expect(
    f.run(initializeSharedLibrary({ parent, operation: "library-other" })),
  ).rejects.toThrow()
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("unregistered tables without internal identities are never adopted by their display name", async () => {
  const f = fixture(true)
  const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (first._tag !== "Failure") throw Error("Expected unknown create")
  if (!(first.failure instanceof SkillsError)) throw first.failure
  for (const table of f.databases.values()) table.raw.description = []
  const writes = f.calls.filter((call) => call.write).length
  const operation = String(property(first.failure.details).operation_id)
  await expect(f.run(initializeSharedLibrary({ parent, operation }))).rejects.toThrow()
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow()
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
    f.run(initializeSharedLibrary({ library: library.library_id })),
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
    (await f.run(initializeSharedLibrary({ library: library.library_id }))).library,
  ).toEqual(library)
  expect((await f.run(initializeSharedLibrary({ library: library.library_id }))).library).toEqual(library)
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
    f.run(initializeSharedLibrary({ library: library.library_id })),
  ).rejects.toThrow("registered data source was replaced")
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "registered data source was replaced",
  )
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("an incomplete registered layout cannot attach or silently adopt unregistered Members", async () => {
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
    for (const input of [
      { library: library.library_id },
      { parent },
      { parent, operation: library.operation_id },
    ]) {
      const result = await f.run(initializeSharedLibrary(input).pipe(Effect.result))
      if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
        throw Error("Incomplete layout must fail")
      expect(result.failure.code).toBe("CURRENT_SCHEMA_REQUIRED")
    }
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
  ).toThrow("Members binding")
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
      f.run(initializeSharedLibrary({ library: library.library_id })),
    ).rejects.toThrow("missing or duplicated")
    expect(f.calls.filter((call) => call.write).length).toBe(writes)
  }
})

test("attachment requires Members to target its own Skills data source and keep a native relation type", async () => {
  for (const change of ["foreign", "wrong_type", "missing_mode", "bad_mode", "dual_mode"]) {
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
    if (change === "dual_mode") {
      property(members.relation).type = "dual_property"
      property(members.relation).dual_property = {}
    }
    const writes = f.calls.filter((call) => call.write).length
    const result = await f.run(
      initializeSharedLibrary({ library: library.library_id }).pipe(Effect.result),
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
  expect(writes).toBe(5)
  expect(f.databases.size).toBe(4)
  expect(property(f.sources.get(id(101))?.properties).Members).toBeDefined()
  const recovered = await f.run(initializeSharedLibrary({ parent, operation }).pipe(Effect.result))
  if (recovered._tag !== "Failure") throw Error("Unregistered descriptor must stay unresolved")
  if (!(recovered.failure instanceof SkillsError)) throw recovered.failure
  expect(recovered.failure.code).toBe("LIBRARY_INIT_INCOMPLETE")
  expect(property(recovered.failure.details).stage).toBe("origins")
  await expect(f.run(initializeSharedLibrary({ parent }))).rejects.toThrow(
    "unfinished initialization",
  )
  expect(f.calls.filter((call) => call.write).length).toBe(writes)
})

test("absent or temporarily invisible Members after unknown PATCH is never permission to resend", async () => {
  for (const [accepted, relation] of [
    [true, "Members"],
    [false, "Members"],
    [true, "Requires"],
  ] as const) {
    const f = fixture(false, { members: accepted ? "accepted" : "not_accepted" })
    const first = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
    if (first._tag !== "Failure") throw Error("Expected unknown Members result")
    if (!(first.failure instanceof SkillsError)) throw first.failure
    const operation = String(property(first.failure.details).operation_id)
    f.hideRelation(relation)
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

async function unfinished(f: ReturnType<typeof fixture>) {
  const result = await f.run(initializeSharedLibrary({ parent }).pipe(Effect.result))
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw Error("Expected unfinished initialization")
  const operation = property(result.failure.details).operation_id
  if (typeof operation !== "string") throw Error("Failure must preserve the exact operation")
  return { operation, error: result.failure }
}

test("explicit resume reconciles a lost create response and creates only the three unstarted tables", async () => {
  const f = fixture(true),
    { operation } = await unfinished(f)
  const originalId = [...f.databases.keys()][0]
  if (originalId === undefined) throw Error("Unknown create must be visible in this fixture")
  expect(f.state.size).toBe(1)
  const result = await f.run(initializeSharedLibrary({ parent, operation, resume: true }))
  expect(result.library.skills.database_id).toBe(originalId)
  expect(result.library.operation_id).toBe(operation)
  expect(f.databases.size).toBe(4)
  expect(
    f.calls.filter((call) => call.path === "v1/databases" && call.method === "POST"),
  ).toHaveLength(4)
  expect(f.state.size).toBe(0)
  const writes = f.calls.filter((call) => call.write).length
  const repeated = await f.run(initializeSharedLibrary({ parent, operation, resume: true }))
  expect(repeated.reused).toBe(true)
  expect(repeated.library).toEqual(result.library)
  expect(
    (await f.run(initializeSharedLibrary({ library: result.library.library_id }))).library,
  ).toEqual(result.library)
  expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
})

test("resume cannot replay an invisible unknown table and can proceed when that same table becomes visible", async () => {
  const f = fixture(true),
    { operation } = await unfinished(f)
  f.hideTable([...f.databases.keys()][0])
  const writes = f.calls.filter((call) => call.write).length
  const pending = structuredClone([...f.state.values()])
  await expect(f.run(initializeSharedLibrary({ parent, operation, resume: true }))).rejects.toThrow(
    "absence cannot authorize",
  )
  expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
  expect([...f.state.values()]).toEqual(pending)
  f.hideTable()
  expect(
    (await f.run(initializeSharedLibrary({ parent, operation, resume: true }))).library
      .operation_id,
  ).toBe(operation)
  expect(f.databases.size).toBe(4)
})

test("known pre-dispatch stops resume at missing tables, relations and descriptor without duplicating objects", async () => {
  for (const before of ["Files", "Members", "Origin", "descriptor"] as const) {
    const f = fixture(false, { before }),
      { operation, error } = await unfinished(f)
    expect(error.code).toBe("REQUEST_BUDGET_EXHAUSTED")
    const ids = [...f.databases.keys()]
    const writes = f.calls.filter((call) => call.write).length
    await expect(f.run(initializeSharedLibrary({ parent, operation }))).rejects.toThrow()
    expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
    f.clearFailures()
    const completed = await f.run(initializeSharedLibrary({ parent, operation, resume: true }))
    expect(completed.library.operation_id).toBe(operation)
    expect([...f.databases.keys()].slice(0, ids.length)).toEqual(ids)
    expect(f.databases.size).toBe(4)
    expect(f.state.size).toBe(0)
  }
})

test("unknown accepted relation writes are observed once before resume advances to the next stage", async () => {
  for (const stage of ["members", "origins"] as const) {
    const f = fixture(false, { [stage]: "accepted" }),
      { operation } = await unfinished(f)
    const path = `v1/data_sources/${stage === "members" ? id(101) : id(102)}`
    expect(f.calls.filter((call) => call.method === "PATCH" && call.path === path)).toHaveLength(1)
    f.clearFailures()
    const result = await f.run(initializeSharedLibrary({ parent, operation, resume: true }))
    expect(result.library.files.property_ids.Origin).toBeDefined()
    expect(f.calls.filter((call) => call.method === "PATCH" && call.path === path)).toHaveLength(1)
    expect(f.state.size).toBe(0)
  }
})

test("unknown absent relation creation stays unresolved even with explicit resume", async () => {
  for (const stage of ["members", "origins"] as const) {
    const f = fixture(false, { [stage]: "not_accepted" }),
      { operation } = await unfinished(f)
    const writes = f.calls.filter((call) => call.write).length
    f.clearFailures()
    await expect(
      f.run(initializeSharedLibrary({ parent, operation, resume: true })),
    ).rejects.toThrow()
    expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
    expect(f.state.size).toBe(1)
  }
})

test("resume may repeat the exact idempotent descriptor replacement after a lost response", async () => {
  for (const outcome of ["accepted", "not_accepted"] as const) {
    const f = fixture(false, { descriptor: outcome }),
      { operation } = await unfinished(f)
    f.clearFailures()
    const result = await f.run(initializeSharedLibrary({ parent, operation, resume: true }))
    expect(result.library.operation_id).toBe(operation)
    expect(result.reused).toBe(outcome === "accepted")
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${id(1)}` && call.method === "PATCH"),
    ).toHaveLength(outcome === "accepted" ? 1 : 2)
    expect(f.databases.size).toBe(4)
    expect(f.state.size).toBe(0)
  }
})

test("original initialization refuses an edited library identity after descriptor response loss", async () => {
  for (const resume of [true, false]) {
    const f = fixture(false, { descriptor: "accepted" }),
      { operation } = await unfinished(f)
    const db = f.databases.get(id(1))
    if (!db) throw Error("Fixture table missing")
    const registered = libraryFromDatabase(db.raw)
    if (!registered) throw Error("Fixture descriptor missing")
    db.raw.description = [
      {
        plain_text:
          LIBRARY_MARKER + JSON.stringify({ ...registered, library_id: "959eb0f3-b440-57dc-b2b2-431f370508bd" }),
      },
    ]
    const writes = f.calls.filter((call) => call.write).length
    const pending = structuredClone([...f.state.entries()])
    const result = await f.run(
      initializeSharedLibrary({ parent, operation, resume }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw Error("An edited library identity must remain unresolved")
    expect(result.failure.code).toBe("LIBRARY_SCHEMA_CONFLICT")
    expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
    expect([...f.state.entries()]).toEqual(pending)
  }
})

test("resume requires retained initialization state and refuses altered known table identities", async () => {
  for (const change of [
    "missing_state",
    "replaced_source",
    "edited_descriptor",
    "different_operation",
  ] as const) {
    const f = fixture(false, { before: "descriptor" }),
      { operation } = await unfinished(f)
    f.clearFailures()
    const db = f.databases.get(id(1))
    if (!db) throw Error("Fixture table missing")
    if (change === "missing_state") f.state.clear()
    if (change === "replaced_source") db.raw.data_sources = [{ id: id(999) }]
    if (change === "edited_descriptor") db.raw.description = [{ plain_text: "Human description" }]
    const writes = f.calls.filter((call) => call.write).length
    await expect(
      f.run(
        initializeSharedLibrary({
          parent,
          operation: change === "different_operation" ? "library-other" : operation,
          resume: true,
        }),
      ),
    ).rejects.toThrow()
    expect(f.calls.filter((call) => call.write)).toHaveLength(writes)
    expect(f.databases.size).toBe(4)
  }
})

test("resume validates its operation selector before network or state writes", async () => {
  const f = fixture()
  for (const input of [
    { parent, resume: true },
    { library: id(1), operation: "library-one", resume: true },
  ]) {
    await expect(f.run(initializeSharedLibrary(input))).rejects.toThrow()
  }
  expect(f.calls).toHaveLength(0)
  expect(f.state.size).toBe(0)
})
