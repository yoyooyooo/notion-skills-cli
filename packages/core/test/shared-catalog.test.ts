import { describe, expect, test } from "bun:test"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { catalog, creationSource, explicitSource } from "../src/catalog.ts"
import {
  ContentRecordSchema,
  decode,
  fail,
  notionPage,
  property,
  resolveRecord,
  type Source,
} from "../src/model.ts"
import { sharedRecordFromPage, sharedSkillId, sharedSkillProperty } from "../src/shared-content.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const propertyIds = {
  Name: "title",
  Description: "description",
  Kind: "kind",
  Tags: "tags",
  Enabled: "enabled",
  "Default Context": "default",
  References: "references",
  "Skill ID": "stable-skill",
  "Main File ID": "main",
  Projection: "projection",
  Source: "source",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-fixture",
  operation_id: "library-fixture",
  parent_page_id: id(1),
  skills: { database_id: id(2), data_source_id: id(3), property_ids: propertyIds },
  files: {
    database_id: id(4),
    data_source_id: id(5),
    property_ids: {
      Name: "title",
      "File ID": "file",
      Path: "path",
      Projection: "projection",
      Status: "status",
      Skill: "skill",
    },
  },
  records: {
    database_id: id(6),
    data_source_id: id(7),
    property_ids: {
      Name: "title",
      "Record ID": "record",
      Kind: "kind",
      "Entity ID": "entity",
      Hash: "hash",
      Payload: "payload",
      Skill: "skill",
    },
  },
}
const source: Source = {
  alias: "shared",
  database_id: library.skills.database_id,
  title: "Shared Skills",
  data_source_ids: [library.skills.data_source_id],
  role: "content",
  shared_library: library,
}
const rich = (propertyId: string, content: string) => ({
  id: propertyId,
  type: "rich_text",
  rich_text: [{ plain_text: content }],
})
function row(
  options: {
    n?: number
    name?: string
    skillId?: string
    enabled?: boolean
    kind?: string
    renamed?: boolean
  } = {},
) {
  const n = options.n ?? 1
  const properties: Record<string, unknown> = {
    Name: {
      id: propertyIds.Name,
      type: "title",
      title: [{ plain_text: options.name ?? "Shared skill" }],
    },
    Description: rich(propertyIds.Description, "Use the selected shared content."),
    Kind: { id: propertyIds.Kind, type: "select", select: { name: options.kind ?? "skill" } },
    Enabled: { id: propertyIds.Enabled, type: "checkbox", checkbox: options.enabled ?? true },
    "Default Context": { id: propertyIds["Default Context"], type: "checkbox", checkbox: true },
    "Skill ID": rich(propertyIds["Skill ID"], options.skillId ?? `skill-${n}`),
    "Main File ID": rich(propertyIds["Main File ID"], `main-${n}`),
    Source: rich(propertyIds.Source, "must not be fetched for metadata discovery"),
  }
  return {
    object: "page",
    id: id(1000 + n),
    parent: {
      type: "data_source_id",
      data_source_id: library.skills.data_source_id,
      database_id: library.skills.database_id,
    },
    properties: options.renamed
      ? Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [`renamed-${key}`, value]),
        )
      : properties,
  }
}
function database() {
  return {
    object: "database",
    id: library.skills.database_id,
    database_type: null,
    title: [{ plain_text: "Shared Skills" }],
    description: [{ plain_text: `${LIBRARY_MARKER}${JSON.stringify(library)}` }],
    parent: { type: "page_id", page_id: library.parent_page_id },
    data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
  }
}
function searchedSource() {
  return {
    id: library.skills.data_source_id,
    parent: { database_id: library.skills.database_id },
    database_type: null,
    title: [{ plain_text: "Shared Skills" }],
    properties: {
      Description: { id: propertyIds.Description, type: "rich_text" },
      References: { id: propertyIds.References, type: "rich_text" },
      "Skill ID": { id: propertyIds["Skill ID"], type: "rich_text" },
      "Main File ID": { id: propertyIds["Main File ID"], type: "rich_text" },
    },
  }
}

function fixture(
  options: {
    rows?: readonly unknown[]
    configuration?: unknown
    databaseValue?: unknown
    queryIncomplete?: boolean
    searchRepeated?: boolean
  } = {},
) {
  const saved = new Map<string, unknown>()
  if (options.configuration !== undefined) saved.set("config.json", options.configuration)
  let generation = 0
  const store: Store["Service"] = {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    root: "/unused-shared",
    configRoot: "/unused-shared",
    cacheRoot: "/unused-shared",
    reserveCacheGeneration: () => Effect.sync(() => ++generation),
    listKeys: (prefix) => Effect.succeed([...saved.keys()].filter((key) => key.startsWith(prefix))),
    retireKeys: () => Effect.succeed([]),
    readJson: (key, schema) =>
      Effect.sync(() => {
        const value = saved.get(key)
        return value === undefined ? undefined : decode(schema, structuredClone(value))
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        saved.set(key, structuredClone(value))
      }),
    readBytes: () => Effect.fail(fail("UNEXPECTED", "Metadata discovery cannot read body bytes.")),
    writeBytes: () =>
      Effect.fail(fail("UNEXPECTED", "Metadata discovery cannot write body bytes.")),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding write")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline write")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    output: () => Effect.fail(fail("UNEXPECTED", "Metadata discovery cannot materialize content.")),
  }
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("catalog-credential"),
    request: (path, body, method) =>
      Effect.suspend(() => {
        calls.push({ path, body, method: method?.method })
        const url = new URL(path, "https://api.notion.com/")
        if (url.pathname === "/v1/users/me")
          return Effect.succeed({ id: "catalog-user", object: "user" })
        if (url.pathname === `/v1/databases/${library.skills.database_id}`)
          return Effect.succeed(options.databaseValue ?? database())
        if (url.pathname === "/v1/search")
          return Effect.succeed({
            results: options.searchRepeated
              ? [searchedSource(), searchedSource()]
              : [searchedSource()],
            has_more: false,
            next_cursor: null,
          })
        if (url.pathname === `/v1/data_sources/${library.skills.data_source_id}/query`) {
          const rows = options.rows ?? [row()]
          const start = property(body).start_cursor === "next" ? 100 : 0
          const next = rows.length > start + 100 ? "next" : null
          const selected = new Set(url.searchParams.getAll("filter_properties"))
          const result = rows.slice(start, start + 100).map((value) => {
            const page = property(value)
            return {
              ...page,
              properties: Object.fromEntries(
                Object.entries(property(page.properties)).filter(
                  ([key, prop]) =>
                    selected.size === 0 ||
                    selected.has(key) ||
                    selected.has(String(property(prop).id)),
                ),
              ),
            }
          })
          return Effect.succeed({
            results: result,
            has_more: next !== null,
            next_cursor: next,
            ...(options.queryIncomplete
              ? {
                  request_status: {
                    type: "incomplete",
                    incomplete_reason: "query_result_limit_reached",
                  },
                }
              : {}),
          })
        }
        return Effect.fail(fail("UNEXPECTED", "Unexpected nonmetadata request.", { path }))
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
  )
  return {
    calls,
    saved,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Store | Crypto.Crypto>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}

describe("shared content metadata", () => {
  test("stable IDs survive page and display-name changes", () => {
    const first = sharedRecordFromPage(row(), source, library.skills.data_source_id)
    const moved = sharedRecordFromPage(
      row({ n: 2, skillId: "skill-1", name: "Renamed Skill" }),
      source,
      library.skills.data_source_id,
    )
    expect(first.id).toBe(sharedSkillId(library.library_id, "skill-1"))
    expect(first.id).toBe(moved.id)
    expect(first.ref).toBe(moved.ref)
    expect(first.locator.page_id).not.toBe(moved.locator.page_id)
    expect(moved.alias).toBe("renamed-skill")
  })

  test("stable property IDs survive every visible column name changing", () => {
    const actual = sharedRecordFromPage(
      row({ renamed: true, kind: "prompt", enabled: false }),
      source,
      library.skills.data_source_id,
    )
    expect(actual.kind).toBe("prompt")
    expect(actual.entrypoint).toBe("PROMPT.md")
    expect(actual.enabled).toBe(false)
    expect(actual.default_context).toBe(true)
    expect(decode(ContentRecordSchema, actual)).toEqual(actual)
    expect(sharedSkillProperty(row({ renamed: true }), library, "Main File ID").rich_text).toEqual([
      { plain_text: "main-1" },
    ])
  })

  test("legacy mutation boundary rejects a new shared locator", () => {
    const record = sharedRecordFromPage(row(), source, library.skills.data_source_id)
    expect(() => notionPage(record)).toThrow("requires a Notion content page")
  })

  test("rejects missing stable identity, foreign parent, and malformed property types", () => {
    const original = row()
    expect(() =>
      sharedRecordFromPage(
        row({ skillId: "unstable skill name" }),
        source,
        library.skills.data_source_id,
      ),
    ).toThrow("stable bounded identity")
    expect(() =>
      sharedRecordFromPage(
        { ...original, parent: { type: "data_source_id", data_source_id: id(99) } },
        source,
        library.skills.data_source_id,
      ),
    ).toThrow("another source")
    expect(() =>
      sharedRecordFromPage(
        {
          ...original,
          properties: { ...original.properties, Enabled: rich(propertyIds.Enabled, "true") },
        },
        source,
        library.skills.data_source_id,
      ),
    ).toThrow("checkbox")
    expect(() =>
      sharedRecordFromPage(
        {
          ...original,
          properties: { ...original.properties, AnotherName: original.properties.Name },
        },
        source,
        library.skills.data_source_id,
      ),
    ).toThrow("duplicated")
  })
})

describe("shared catalog routing", () => {
  test("an explicit shared library excludes unrelated legacy upstream configuration", async () => {
    const f = fixture({ configuration: { upstream_database: id(900) } })
    const result = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    expect(result.coverage.exhaustive).toBe(true)
    expect(result.coverage.failed_sources).toEqual([])
    expect(result.coverage.queried_data_sources).toEqual([library.skills.data_source_id])
    expect(f.calls).toHaveLength(3)
    expect(f.calls.some((call) => call.path.includes(id(900)))).toBe(false)
  })

  test("explicit source defaults to the legacy write fence, including malformed marked descriptors", async () => {
    for (const databaseValue of [
      database(),
      { ...database(), description: [{ plain_text: `${LIBRARY_MARKER}{}` }] },
    ]) {
      const f = fixture({ databaseValue })
      const result = await f.run(explicitSource(library.skills.database_id).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected a protected mutation boundary")
      expect(result.failure.code).toBe("SHARED_LIBRARY_CONSUMER_PENDING")
      expect(f.calls).toHaveLength(1)
    }
  })

  test("explicit metadata opt-in preserves the descriptor without querying Files or Records", async () => {
    const f = fixture()
    const result = await f.run(
      explicitSource(library.skills.database_id, undefined, { allowShared: true }),
    )
    expect(result.shared_library).toEqual(library)
    expect(result.data_source_ids).toEqual([library.skills.data_source_id])
    expect(f.calls.map((call) => call.path)).toEqual([`v1/databases/${library.skills.database_id}`])
  })

  test("cold explicit catalog is metadata only and includes the shared stable identity", async () => {
    const f = fixture({ rows: [row({ renamed: true })] })
    const result = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.locator.type).toBe("shared_skill")
    expect(result.coverage.exhaustive).toBe(true)
    expect(result.databases[0]?.shared_library).toEqual(library)
    expect(f.calls).toHaveLength(3)
    const query = f.calls.find((call) => call.path.includes("/query?"))
    if (query === undefined) throw new Error("Missing selected Skills query")
    const fields = new URL(query.path, "https://api.notion.com/").searchParams.getAll(
      "filter_properties",
    )
    expect(fields).toEqual([
      propertyIds.Name,
      propertyIds.Description,
      propertyIds.Kind,
      propertyIds["Skill ID"],
      propertyIds.Enabled,
      propertyIds["Default Context"],
    ])
    expect(fields).not.toContain(propertyIds.Source)
    expect(
      f.calls.some(
        (call) =>
          call.path.includes("/markdown") ||
          call.path.includes(library.files.data_source_id) ||
          call.path.includes(library.records.data_source_id),
      ),
    ).toBe(false)
    const record = result.records[0]
    if (record === undefined || record.locator.type !== "shared_skill")
      throw new Error("Missing shared Skill")
    expect(resolveRecord(record.id, result)).toEqual(record)
    expect(resolveRecord(record.locator.page_id, result)).toEqual(record)
  })

  test("101 Skills use two metadata query pages and no per-Skill GET", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      row({ n: index + 1, name: `Skill ${index + 1}` }),
    )
    const f = fixture({ rows })
    const result = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    expect(result.records).toHaveLength(101)
    expect(f.calls).toHaveLength(4)
    expect(f.calls.filter((call) => call.path.includes("/query?"))).toHaveLength(2)
    expect(f.calls.some((call) => call.path.startsWith("v1/pages/"))).toBe(false)
  })

  test("TTL hits issue no remote requests and keep the original validation time", async () => {
    const f = fixture()
    const first = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    f.calls.length = 0
    const cached = await f.run(catalog({ database: library.skills.database_id }))
    expect(cached.records).toEqual(first.records)
    expect(cached.fetched_at).toBe(first.fetched_at)
    expect(cached.source).toBe("local_cache")
    expect(f.calls).toHaveLength(0)
  })

  test("Enabled false removes a Skill from the directory without changing its identity", async () => {
    const f = fixture({ rows: [row(), row({ n: 2, enabled: false })] })
    const result = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    expect(result.records.map((record) => record.id)).toEqual([
      sharedSkillId(library.library_id, "skill-1"),
    ])
    expect(result.coverage.exhaustive).toBe(true)
  })

  test("duplicate stable Skill IDs fail rather than selecting an enumeration winner", async () => {
    const f = fixture({
      rows: [row(), row({ n: 2, skillId: "skill-1", name: "Duplicate binding" })],
    })
    const result = await f.run(
      catalog({ database: library.skills.database_id, refresh: true }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected identity conflict")
    expect(result.failure.code).toBe("SHARED_SKILL_ID_CONFLICT")
  })

  test("global discovery reads one descriptor and never mistakes a shared References schema for legacy", async () => {
    const f = fixture({ searchRepeated: true })
    const result = await f.run(catalog({ refresh: true }))
    expect(result.records[0]?.locator.type).toBe("shared_skill")
    expect(result.coverage.failed_sources).toEqual([])
    expect(result.coverage.search_index_limited).toBe(true)
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${library.skills.database_id}`),
    ).toHaveLength(1)
    expect(
      f.calls.some((call) => call.path === `v1/data_sources/${library.skills.data_source_id}`),
    ).toBe(false)
  })

  test("registered alias selects the same shared library", async () => {
    const f = fixture({ configuration: { sources: [source] } })
    const result = await f.run(catalog({ database: "shared", refresh: true }))
    expect(result.databases[0]?.alias).toBe("shared")
    expect(result.records[0]?.id).toBe(sharedSkillId(library.library_id, "skill-1"))
  })

  test("legacy creation remains fenced when the selected source is shared", async () => {
    const f = fixture()
    await expect(f.run(creationSource(library.skills.database_id))).rejects.toThrow(
      "Legacy creation and publication",
    )
    expect(f.calls).toHaveLength(1)
  })

  test("incomplete pagination never reports an exhaustive empty directory", async () => {
    const f = fixture({ queryIncomplete: true })
    const result = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
    expect(result.coverage.exhaustive).toBe(false)
    expect(result.coverage.failed_sources).toHaveLength(1)
    expect(result.records).toEqual([])
  })
})
