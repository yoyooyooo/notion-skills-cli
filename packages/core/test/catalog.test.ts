import { resolveCatalogReference } from "../src/catalog-reference.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"
import { expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { authScope, catalog, explicitSource } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import {
  CatalogSchema,
  ContentRecordSchema,
  SnapshotSchema,
  decode,
  fail,
  property,
  SkillsError,
  type Source,
} from "../src/model.ts"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import {
  currentDigest,
  currentId,
  currentLibrary,
  currentRich,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"

type Services =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
type Call = { path: string; body: unknown }
const list = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})
const sourceFor = (library: SharedLibrary, alias = library.library_id): Source => ({
  alias,
  database_id: library.skills.database_id,
  data_source_ids: [library.skills.data_source_id],
  title: alias,
  role: "content",
  shared_library: library,
})
function page(library: SharedLibrary, n: number, name = "Sample Skill") {
  const { Name, Description, ...properties } = currentSnapshotFixture({ fileCount: 0 }).main
    .properties
  return {
    object: "page",
    id: currentId(1000 + n),
    parent: {
      type: "data_source_id",
      database_id: library.skills.database_id,
      data_source_id: library.skills.data_source_id,
    },
    properties: {
      ...properties,
      RenamedTitle: { ...Name, title: [{ plain_text: name }] },
      RenamedDescription: {
        ...Description,
        rich_text: [
          { type: "text", plain_text: "Review resources", text: { content: "Review resources" } },
        ],
      },
      "Skill ID": currentRich("skill-id", "skill-" + n),
      "Main File ID": currentRich("main-id", "main-" + n),
    },
  }
}
const recordId = (library: SharedLibrary, n: number) =>
  `skill://skill-${n}?library=${encodeURIComponent(library.library_id)}`
function anotherLibrary(): SharedLibrary {
  return {
    ...currentLibrary,
    library_id: "45c64249-e1dd-59ab-ad9f-604ff752ddb4",
    operation_id: "library-other",
    skills: {
      ...currentLibrary.skills,
      database_id: currentId(20001),
      data_source_id: currentId(20002),
    },
    files: {
      ...currentLibrary.files,
      database_id: currentId(20003),
      data_source_id: currentId(20004),
    },
    records: {
      ...currentLibrary.records,
      database_id: currentId(20005),
      data_source_id: currentId(20006),
    },
    sources: {
      ...currentLibrary.sources,
      database_id: currentId(20007),
      data_source_id: currentId(20008),
    },
  }
}
function fixture() {
  const base = currentSnapshotFixture({ fileCount: 0 })
  const sources = new Map([[currentLibrary.skills.database_id, sourceFor(currentLibrary)]])
  const rows = new Map<string, unknown[]>([
    [currentLibrary.skills.data_source_id, [page(currentLibrary, 1)]],
  ])
  const calls: Call[] = []
  let credential = "catalog-first",
    fault: ((call: Call) => unknown) | undefined
  const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...api,
            connectionIdentity: undefined,
            credentialIdentity: Effect.sync(() => credential),
            request: (path, body) =>
              Effect.gen(function* () {
                const call = { path, body }
                calls.push(call)
                const overridden = fault?.(call)
                if (overridden instanceof SkillsError) return yield* Effect.fail(overridden)
                if (overridden !== undefined) return overridden
                if (path === "v1/users/me") return { object: "user", id: "catalog-principal" }
                if (path === "v1/search")
                  return list(
                    [...sources.values()].map((source) => ({
                      id: source.data_source_ids[0],
                      parent: { database_id: source.database_id },
                      title: [{ plain_text: source.title }],
                      properties: {
                        "Skill ID": { type: "rich_text" },
                        "Main File ID": { type: "rich_text" },
                      },
                      database_type: null,
                    })),
                  )
                const selected = [...sources.values()].find(
                  (source) => path === `v1/databases/${source.database_id}`,
                )
                if (selected)
                  return {
                    id: selected.database_id,
                    parent: { type: "page_id", page_id: selected.shared_library!.library_id },
                    title: [{ plain_text: selected.title }],
                    database_type: null,
                    description: [
                      { plain_text: LIBRARY_MARKER + JSON.stringify(selected.shared_library) },
                    ],
                    data_sources: selected.data_source_ids.map((id) => ({
                      id,
                      name: selected.title,
                    })),
                  }
                for (const source of sources.values()) {
                  const schema = librarySchemaResponse(path, source.shared_library!)
                  if (schema !== undefined) return schema
                }
                const dataSource = [...rows.keys()].find(
                  (id) => path.split("?")[0] === `v1/data_sources/${id}/query`,
                )
                if (dataSource !== undefined) {
                  const cursor = property(body).start_cursor,
                    offset = cursor === undefined ? 0 : Number(String(cursor).slice(7))
                  const selected = rows.get(dataSource)!,
                    end = Math.min(selected.length, offset + 100)
                  return list(
                    structuredClone(selected.slice(offset, end)),
                    end < selected.length ? "offset-" + end : null,
                  )
                }
                return yield* Effect.fail(
                  fail("UNEXPECTED_REQUEST", "Catalog must stay on current metadata routes.", {
                    path,
                  }),
                )
              }),
          }),
        )
      }),
    )
  return {
    ...base,
    sources,
    rows,
    calls,
    run,
    credential: (value: string) => {
      credential = value
    },
    fault: (value: typeof fault) => {
      fault = value
    },
    add: (library: SharedLibrary, alias: string) => {
      sources.set(library.skills.database_id, sourceFor(library, alias))
      rows.set(library.skills.data_source_id, [page(library, 2)])
    },
  }
}

test("verified connection identity binds principal, credential and API origin without a duplicate handshake", async () => {
  const f = fixture(),
    principal = currentId(99),
    credential = "credential-digest"
  const expected = currentDigest(
    JSON.stringify([principal, "", "https://api.notion.com", credential]),
  )
  for (const workspace of [null, currentId(90)]) {
    const api: Notion["Service"] = {
      version: Effect.succeed("current"),
      credentialIdentity: Effect.succeed(credential),
      connectionIdentity: Effect.succeed({
        principal,
        credential,
        connection: "quota-connection",
        workspace,
        api_origin: "https://api.notion.com",
      }),
      request: () => Effect.die("Validated identity already owns the handshake"),
    }
    expect(await f.run(authScope.pipe(Effect.provideService(Notion, api)))).toBe(expected)
  }
  expect(f.calls).toHaveLength(0)
})

for (const [label, description, code] of [
  ["absent", "", "NOT_SHARED_LIBRARY"],
  ["empty", LIBRARY_MARKER + "{}", "CURRENT_SCHEMA_REQUIRED"],
  [
    "three tables",
    LIBRARY_MARKER + JSON.stringify({ ...currentLibrary, sources: undefined }),
    "CURRENT_SCHEMA_REQUIRED",
  ],
  ["malformed JSON", LIBRARY_MARKER + "{", "LIBRARY_INVALID"],
] as const)
  test(
    "current libraries reject " + label + " descriptors before metadata acquisition",
    async () => {
      const f = fixture()
      f.fault((call) =>
        call.path === `v1/databases/${currentLibrary.skills.database_id}`
          ? {
              id: currentLibrary.skills.database_id,
              parent: { type: "page_id", page_id: currentLibrary.library_id },
              description: [{ plain_text: description }],
              data_sources: [{ id: currentLibrary.skills.data_source_id, name: "Skills" }],
              title: [],
              database_type: null,
            }
          : undefined,
      )
      const result = await f.run(
        explicitSource(currentLibrary.library_id).pipe(Effect.result),
      )
      expect(result._tag === "Failure" && result.failure.code).toBe(code)
      expect(f.calls.map((call) => call.path)).toEqual([
        `v1/pages/${currentLibrary.library_id}`,
        `v1/blocks/${currentLibrary.library_id}/children?page_size=100`,
        ...(["skills", "files", "records", "sources"] as const).map(role => `v1/databases/${currentLibrary[role].database_id}`),
      ])
    },
  )

test("search and projected metadata exhaust their cursors, ignore ordinary sources and preserve distinct records", async () => {
  const f = fixture(),
    ds = currentLibrary.skills.data_source_id
  const current = {
    id: ds,
    parent: { database_id: currentLibrary.skills.database_id },
    title: [],
    properties: { "Skill ID": { type: "rich_text" }, "Main File ID": { type: "rich_text" } },
  }
  f.fault((call) => {
    if (call.path === "v1/search")
      return property(call.body).start_cursor
        ? list([current])
        : list(
            [
              {
                ...current,
                id: currentId(90),
                parent: { database_id: currentId(91) },
                properties: {},
              },
            ],
            "search-next",
          )
    if (call.path.startsWith(`v1/data_sources/${ds}/query`))
      return property(call.body).start_cursor
        ? list([
            page(currentLibrary, 2, "Another Skill"),
            { ...page(currentLibrary, 3), in_trash: true },
          ])
        : list([page(currentLibrary, 1)], "rows-next")
  })
  const result = await f.run(catalog({ all: true, refresh: true }))
  expect(result.records.map((record) => [record.id, record.name, record.alias])).toEqual([
    [recordId(currentLibrary, 2), "Another Skill", "another-skill"],
    [recordId(currentLibrary, 1), "Sample Skill", "sample-skill"],
  ])
  expect(result.coverage).toEqual({
    method: "search_and_registered",
    exhaustive: false,
    queried_data_sources: [ds],
    failed_sources: [],
    search_index_limited: true,
  })
  expect(f.calls.filter((call) => call.path === "v1/search")).toHaveLength(2)
  const queries = f.calls.filter((call) => call.path.startsWith(`v1/data_sources/${ds}/query`))
  expect(queries).toHaveLength(2)
  expect(
    new URL("https://fixture/" + queries[0]!.path).searchParams.getAll("filter_properties").sort(),
  ).toEqual(["default", "description", "enabled", "kind", "skill-id", "title"])
  expect(f.calls.some((call) => /pages\/|markdown|blocks\//u.test(call.path) && call.path !== `v1/pages/${currentLibrary.library_id}` && !call.path.startsWith(`v1/blocks/${currentLibrary.library_id}/children`))).toBe(false)
})

for (const boundary of ["search", "metadata"] as const)
  for (const defect of ["missing", "repeated"] as const)
    test(`${boundary} rejects a ${defect} cursor with bounded request growth`, async () => {
      const f = fixture(),
        ds = currentLibrary.skills.data_source_id
      f.fault((call) =>
        (
          boundary === "search"
            ? call.path === "v1/search"
            : call.path.startsWith(`v1/data_sources/${ds}/query`)
        )
          ? { ...list([]), has_more: true, next_cursor: defect === "missing" ? null : "repeat" }
          : undefined,
      )
      const result = await f.run(catalog({ all: true, refresh: true }).pipe(Effect.result))
      if (boundary === "search")
        expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_RESPONSE")
      else {
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") throw new Error("Expected explicit partial source coverage")
        expect(result.success.coverage.exhaustive).toBe(false)
        expect(result.success.coverage.failed_sources).toEqual([
          expect.objectContaining({
            id: ds,
            code: "INVALID_RESPONSE",
            database_id: currentLibrary.skills.database_id,
          }),
        ])
      }
      expect(
        f.calls.filter((call) =>
          boundary === "search"
            ? call.path === "v1/search"
            : call.path.startsWith(`v1/data_sources/${ds}/query`),
        ),
      ).toHaveLength(defect === "missing" ? 1 : 2)
    })

test("failed data sources remain explicit partial coverage while successful content stays available", async () => {
  const f = fixture(),
    other = anotherLibrary()
  f.add(other, "ops")
  f.json.set("config.json", { sources: [...f.sources.values()] })
  f.fault((call) =>
    call.path.startsWith(`v1/data_sources/${other.skills.data_source_id}/query`)
      ? fail("ACCESS_DENIED", "denied")
      : undefined,
  )
  const result = await f.run(catalog({ all: true, refresh: true }))
  expect(result.records.map((record) => record.id)).toEqual([recordId(currentLibrary, 1)])
  expect(result.coverage.exhaustive).toBe(false)
  expect(result.coverage.failed_sources).toEqual([
    {
      id: other.skills.data_source_id,
      code: "ACCESS_DENIED",
      database_id: other.skills.database_id,
      alias: "ops",
      title: "ops",
      data_source_id: other.skills.data_source_id,
    },
  ])
})

test("invalid descriptions preserve valid records and identify the unavailable current row", async () => {
  const f = fixture(),
    valid = page(currentLibrary, 1),
    invalid = page(currentLibrary, 2)
  valid.properties.RenamedDescription = currentRich("description", "x".repeat(1211))
  invalid.properties.RenamedDescription = currentRich("description", "x".repeat(2001))
  f.rows.set(currentLibrary.skills.data_source_id, [valid, invalid])
  const result = await f.run(catalog({ all: true, refresh: true }))
  expect(result.records).toHaveLength(1)
  expect(result.records[0]!.description).toBe("x".repeat(1211))
  expect(result.coverage.failed_sources).toContainEqual(
    expect.objectContaining({ id: invalid.id, code: "INVALID_SKILL" }),
  )
})

test("invalid current Notion titles fail with the selected physical page and exact authored name", async () => {
  const f = fixture(),
    row = page(currentLibrary, 1, "Sample\u0000Skill")
  f.rows.set(currentLibrary.skills.data_source_id, [row])
  const result = await f.run(catalog({ all: true, refresh: true }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: row.id, name: "Sample\u0000Skill" },
  })
})

for (const defect of ["title", "logical-id", "locator", "legacy-locator"] as const)
  test("cached metadata cannot bypass current " + defect + " validation", async () => {
    const f = fixture()
    await f.run(catalog({ library: currentLibrary.library_id }))
    for (const [key, value] of f.json)
      if (key.startsWith("cache/catalogs/")) {
        const cached = JSON.parse(JSON.stringify(value)),
          record = cached.records[0]
        if (defect === "title") record.name = "资源\u0000治理"
        if (defect === "logical-id") record.id = "skill://other?library=00000000-0000-4000-8000-000000000002"
        if (defect === "locator") record.locator.data_source_id = currentId(999)
        if (defect === "legacy-locator")
          record.locator = {
            type: "notion_page",
            page_id: record.locator.page_id,
            database_id: record.locator.database_id,
            data_source_id: record.locator.data_source_id,
          }
        f.json.set(key, cached)
      }
    const before = f.calls.length
    const result = await f.run(
      catalog({ library: currentLibrary.library_id, offline: true }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(
      defect === "title" ? "INVALID_SKILL_NAME" : "STATE_CORRUPT",
    )
    expect(f.calls).toHaveLength(before)
  })

test("one user's changed credentials isolate cached catalogs and switching back reuses only its own observation", async () => {
  const f = fixture(),
    ds = currentLibrary.skills.data_source_id
  const first = await f.run(catalog({ all: true }))
  f.credential("catalog-second")
  f.rows.set(ds, [page(currentLibrary, 2)])
  const second = await f.run(catalog({ all: true }))
  expect(second.records.map((record) => record.id)).toEqual([recordId(currentLibrary, 2)])
  expect(second.scope).not.toBe(first.scope)
  f.credential("catalog-first")
  const before = f.calls.length,
    restored = await f.run(catalog({ all: true }))
  expect(restored.records).toEqual(first.records)
  expect(restored.scope).toBe(first.scope)
  expect(restored.fetched_at).toBe(first.fetched_at)
  expect(f.calls).toHaveLength(before)
  expect(
    f.calls.filter((call) => call.path.startsWith(`v1/data_sources/${ds}/query`)),
  ).toHaveLength(2)
})

test("same names in independent current libraries require an exact source alias and retain failure ownership", async () => {
  const f = fixture(),
    other = anotherLibrary()
  f.add(other, "ops")
  f.sources.set(currentLibrary.skills.database_id, sourceFor(currentLibrary, "frontend"))
  f.json.set("config.json", { sources: [...f.sources.values()] })
  const merged = await f.run(catalog({ all: true, refresh: true }))
  expect(merged.records.map((record) => record.id).sort()).toEqual(
    [recordId(currentLibrary, 1), recordId(other, 2)].sort(),
  )
  expect(() => resolveCatalogReference("skill://sample-skill", merged)).toThrow()
  const scoped = await f.run(catalog({ library: "ops", refresh: true }))
  expect(scoped.databases).toEqual([sourceFor(other, "ops")])
  expect(resolveCatalogReference(recordId(other, 2), scoped).record.id).toBe(recordId(other, 2))
  f.fault((call) =>
    call.path.startsWith(`v1/data_sources/${other.skills.data_source_id}/query`)
      ? fail("ACCESS_DENIED", "denied")
      : undefined,
  )
  const partial = await f.run(catalog({ all: true, refresh: true }))
  expect(partial.records.map((record) => record.id)).toEqual([recordId(currentLibrary, 1)])
  expect(partial.coverage.failed_sources[0]).toMatchObject({
    database_id: other.skills.database_id,
    alias: "ops",
    data_source_id: other.skills.data_source_id,
  })
})

test("Default Context is an explicit current checkbox; disabled records do not enter the public directory", async () => {
  const source = sourceFor(currentLibrary),
    row = page(currentLibrary, 1)
  for (const value of [false, true]) {
    row.properties["Default Context"].checkbox = value
    expect(
      sharedRecordFromPage(row, source, currentLibrary.skills.data_source_id).default_context,
    ).toBe(value)
  }
  for (const value of [
    undefined,
    null,
    { type: "rich_text", rich_text: [] },
    { type: "checkbox" },
    { type: "checkbox", checkbox: "true" },
  ]) {
    const properties = { ...row.properties, "Default Context": value }
    expect(() =>
      sharedRecordFromPage({ ...row, properties }, source, currentLibrary.skills.data_source_id),
    ).toThrow()
  }
  const f = fixture()
  row.properties.Enabled.checkbox = false
  f.rows.set(currentLibrary.skills.data_source_id, [row])
  const result = await f.run(catalog({ library: currentLibrary.library_id }))
  expect(result.records).toEqual([])
  expect(result.coverage.exhaustive).toBe(true)
})

test("current record, catalog and selected snapshot schemas preserve metadata and reject retired locators", () => {
  const current = sharedRecordFromPage(
    page(currentLibrary, 1),
    sourceFor(currentLibrary),
    currentLibrary.skills.data_source_id,
  )
  expect(decode(ContentRecordSchema, current)).toEqual(current)
  expect(decode(ContentRecordSchema, { ...current, default_context: true }).default_context).toBe(
    true,
  )
  expect(() => decode(ContentRecordSchema, { ...current, default_context: "true" })).toThrow()
  for (const type of ["notion_page", "notion_subscription"])
    expect(() =>
      decode(ContentRecordSchema, { ...current, locator: { ...current.locator, type } }),
    ).toThrow()
  const cached = decode(CatalogSchema, {
    scope: "scope",
    fetched_at: 0,
    databases: [sourceFor(currentLibrary)],
    records: [current],
    coverage: {
      method: "explicit_database",
      exhaustive: true,
      queried_data_sources: [currentLibrary.skills.data_source_id],
      failed_sources: [],
      search_index_limited: false,
    },
  })
  expect(cached.records[0]).toEqual(current)
  const snapshot = {
    snapshot_id: "s_" + "a".repeat(64),
    scope: "scope",
    record: current,
    entrypoint: "SKILL.md",
    version_id: "b".repeat(64),
    created_at: 0,
    files: [],
  }
  expect(decode(SnapshotSchema, snapshot)).toEqual(snapshot)
})

for (const count of [101, 205])
  test(`current metadata inventory bounds ${count} records by Notion page size without body fan-out`, async () => {
    const f = fixture(),
      ds = currentLibrary.skills.data_source_id
    f.rows.set(
      ds,
      Array.from({ length: count }, (_, index) => page(currentLibrary, index, "Skill " + index)),
    )
    const result = await f.run(
      catalog({ library: currentLibrary.library_id, refresh: true }),
    )
    expect(result.records).toHaveLength(count)
    expect(result.coverage.exhaustive).toBe(true)
    expect(
      f.calls.filter((call) => call.path.startsWith(`v1/data_sources/${ds}/query`)),
    ).toHaveLength(Math.ceil(count / 100))
    expect(f.calls.some((call) => /v1\/pages\/|markdown|blocks|export/u.test(call.path) && call.path !== `v1/pages/${currentLibrary.library_id}` && !call.path.startsWith(`v1/blocks/${currentLibrary.library_id}/children`))).toBe(
      false,
    )
    expect(
      f.calls.some(
        (call) =>
          call.path.startsWith(`v1/data_sources/${currentLibrary.files.data_source_id}/query`) ||
          call.path.startsWith(`v1/data_sources/${currentLibrary.records.data_source_id}/query`),
      ),
    ).toBe(false)
  })

for (const defect of ["page", "stable-id"] as const)
  test(
    "current catalogs reject duplicate " + defect + " claims instead of silently deduplicating",
    async () => {
      const f = fixture(),
        first = page(currentLibrary, 1),
        second = page(currentLibrary, 2)
      if (defect === "page") second.id = first.id
      else second.properties["Skill ID"] = first.properties["Skill ID"]
      f.rows.set(currentLibrary.skills.data_source_id, [first, second])
      const result = await f.run(catalog({ all: true, refresh: true }).pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("SHARED_SKILL_ID_CONFLICT")
    },
  )
