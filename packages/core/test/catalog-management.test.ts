import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { catalog, discoverDatabases } from "../src/catalog.ts"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { id, library, rich } from "./shared-snapshot-fixture.ts"

function fixture(
  options: {
    readonly managementFirst?: boolean
    readonly registeredManagement?: boolean
    readonly legacyKind?: string
  } = {},
) {
  const f = nativeGraphFixture({ width: 0 })
  const registered: SharedLibrary = {
    ...f.descriptor,
    skills: {
      ...f.descriptor.skills,
      property_ids: {
        ...f.descriptor.skills.property_ids,
        Origin: "origin",
        "Source Member": "member",
      },
    },
    records: {
      ...library.records,
      property_ids: { ...library.records.property_ids, Origin: "origin" },
    },
    sources: {
      database_id: id(80),
      data_source_id: id(81),
      property_ids: Object.fromEntries(
        Object.keys(
          sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
        ).map((name, index) => [name, name === "Name" ? "title" : `source-${index}`]),
      ),
    },
  }
  const root = f.pages[0]!
  property(root.properties).origin = {
    id: "origin",
    type: "relation",
    relation: [],
    has_more: false,
  }
  property(root.properties).member = rich("member", "")
  const managed = [registered.files, registered.records, registered.sources!]
  const legacy = { database_id: id(90), data_source_id: id(91) }
  const references = {
    Description: { id: "description", type: "rich_text" },
    References: { id: "references", type: "rich_text" },
  }
  const searchRows = [
    ...managed.map((table) => ({
      id: table.data_source_id,
      parent: { database_id: table.database_id },
      // Historical added columns made these real management tables look like
      // ordinary References content; their names are intentionally unhelpful.
      title: [{ plain_text: "Ordinary content" }],
      database_type: null,
      properties: references,
    })),
    {
      id: legacy.data_source_id,
      parent: { database_id: legacy.database_id },
      title: [{ plain_text: "Records" }],
      database_type: null,
      properties: references,
    },
  ]
  const sharedSearch = {
    id: registered.skills.data_source_id,
    parent: { database_id: registered.skills.database_id },
    title: [{ plain_text: "Renamed entry" }],
    database_type: null,
    properties: {
      ...references,
      "Skill ID": { id: "skill_id", type: "rich_text" },
      "Main File ID": { id: "main_file_id", type: "rich_text" },
    },
  }
  const searched =
    options.managementFirst === false
      ? [sharedSearch, ...searchRows]
      : [...searchRows, sharedSearch]
  if (options.registeredManagement) {
    f.json.set("config.json", {
      sources: managed.map((table, index) => ({
        alias: `old-content-alias-${index}`,
        database_id: table.database_id,
        data_source_ids: [table.data_source_id],
        title: "Previously registered content",
      })),
    })
  }
  const list = (results: readonly unknown[]) => ({ results, has_more: false, next_cursor: null })
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Notion | Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    >,
  ) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, requestOptions) => {
              const endpoint = path.split("?", 1)[0]
              if (endpoint === `v1/databases/${registered.skills.database_id}`)
                return api.request(path, body, requestOptions).pipe(
                  Effect.map((raw) => ({
                    ...property(raw),
                    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(registered) }],
                  })),
                )
              const ordinary = [...managed, legacy].find(
                (table) => endpoint === `v1/databases/${table.database_id}`,
              )
              if (ordinary) {
                f.calls.push({ path, body, method: requestOptions?.method ?? "GET" })
                return Effect.succeed({
                  id: ordinary.database_id,
                  database_type: null,
                  title: [{ plain_text: "Content candidate" }],
                  description: [],
                  data_sources: [{ id: ordinary.data_source_id, name: "Main" }],
                })
              }
              const ordinarySchema = [...managed, legacy].find(
                (table) => endpoint === `v1/data_sources/${table.data_source_id}`,
              )
              if (ordinarySchema) {
                f.calls.push({ path, body, method: requestOptions?.method ?? "GET" })
                return Effect.succeed({ id: ordinarySchema.data_source_id, properties: references })
              }
              if (endpoint === "v1/search") {
                f.calls.push({ path, body, method: "POST" })
                return Effect.succeed(list(searched))
              }
              if (endpoint === `v1/data_sources/${legacy.data_source_id}/query`) {
                f.calls.push({ path, body, method: "POST" })
                return Effect.succeed(
                  list([
                    {
                      id: id(92),
                      properties: {
                        Name: {
                          id: "title",
                          type: "title",
                          title: [{ plain_text: "Still a legacy Skill" }],
                        },
                        Description: rich(
                          "description",
                          "Valid legacy content remains discoverable.",
                        ),
                        References: rich("references", ""),
                        Kind: {
                          id: "kind",
                          type: "select",
                          select: { name: options.legacyKind ?? "skill" },
                        },
                      },
                    },
                  ]),
                )
              }
              return api.request(path, body, requestOptions)
            },
          }),
        )
      }),
    )
  return { ...f, run, registered, managed, legacy }
}

const query = (path: string, dataSource: string) =>
  path.split("?", 1)[0] === `v1/data_sources/${dataSource}/query`

test.each([true, false])(
  "fresh four-table descriptors exclude management candidates independent of search order (%s)",
  async (managementFirst) => {
    const f = fixture({ managementFirst, registeredManagement: true })
    const result = await f.run(catalog({ refresh: true }))
    expect(result.records.map((record) => record.id).sort()).toEqual(
      [`notion_page:${id(92)}`, `shared_skill:${library.library_id}:a`].sort(),
    )
    expect(result.databases.map((source) => source.database_id).sort()).toEqual(
      [library.skills.database_id, f.legacy.database_id].sort(),
    )
    expect(result.coverage.failed_sources).toEqual([])
    for (const table of f.managed)
      expect(f.calls.some((call) => query(call.path, table.data_source_id))).toBe(false)
    expect(result.records.find((record) => record.id === `notion_page:${id(92)}`)?.name).toBe(
      "Still a legacy Skill",
    )
  },
)

test("legacy discovery does not expose management tables when shared consumption is not enabled", async () => {
  const f = fixture()
  const result = await f.run(discoverDatabases())
  expect(result.databases.map((source) => source.database_id)).toEqual([f.legacy.database_id])
  expect(result.failures.map((failure) => failure.code)).toEqual([
    "SHARED_LIBRARY_CONSUMER_PENDING",
  ])
  expect(f.calls.some((call) => call.path.includes("/query"))).toBe(false)
})

test("an actual legacy content table with an invalid Kind still fails instead of being hidden", async () => {
  const f = fixture({ legacyKind: "file_event" })
  const error = await f.run(Effect.flip(catalog({ refresh: true })))
  expect(error.code).toBe("INVALID_RESPONSE")
  expect(error.message).toBe("The response does not match the expected schema.")
  expect(f.calls.some((call) => query(call.path, f.legacy.data_source_id))).toBe(true)
  for (const table of f.managed)
    expect(f.calls.some((call) => query(call.path, table.data_source_id))).toBe(false)
})

test("cold logical ref refresh without database resolves the shared Skill without broad management queries", async () => {
  const f = fixture({ registeredManagement: true })
  const target = `shared_skill:${library.library_id}:a`
  const result = await f.run(readSkill(fileRef(target, "SKILL.md"), { refresh: true }))
  expect(result.record.id).toBe(target)
  expect("content" in result && result.content).toContain("# a instruction")
  expect(f.calls.some((call) => call.path === "v1/search")).toBe(true)
  expect(
    f.calls.some((call) => call.path === `v1/pages/${f.pageIds[0]}/markdown?markdown_version=v2`),
  ).toBe(true)
  expect(f.calls.some((call) => query(call.path, f.registered.sources!.data_source_id))).toBe(false)
  for (const table of [f.registered.files, f.registered.records]) {
    const selected = f.calls.filter((call) => query(call.path, table.data_source_id))
    expect(selected.length).toBeGreaterThan(0)
    for (const call of selected)
      expect(Object.keys(property(property(call.body).filter)).length).toBeGreaterThan(0)
  }
})
