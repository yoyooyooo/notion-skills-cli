import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { freshness } from "../src/cache.ts"
import { pageCatalog, type ListCatalogResult } from "../src/catalog-consumption.ts"
import { resolveCatalogReference } from "../src/catalog-reference.ts"
import { fileRef } from "../src/ref.ts"

import { currentLibrary } from "./shared-current-fixture.ts"

const library = {
  ...currentLibrary,
  library_id: "0c64a309-510e-5d37-b23c-3ce2f966c66e",
  skills: {
    ...currentLibrary.skills,
    database_id: "00000000-0000-4000-8000-000000000010",
    data_source_id: "00000000-0000-4000-8000-000000000011",
  },
}
const at = 1000
const catalog: ListCatalogResult = {
  scope: "a".repeat(64),
  fetched_at: at,
  databases: [
    {
      alias: "library",
      title: "Library",
      role: "content",
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      shared_library: library,
    },
  ],
  records: ["first", "second", "third"].map((name, index) => ({
    id: `skill://${name}?library=0c64a309-510e-5d37-b23c-3ce2f966c66e`,
    kind: "skill",
    name,
    alias: name,
    description: "Controlled catalog metadata",
    default_context: false,
    enabled: true,
    entrypoint: "SKILL.md",
    ref: fileRef(`skill://${name}?library=0c64a309-510e-5d37-b23c-3ce2f966c66e`, "SKILL.md"),
    locator: {
      type: "shared_skill",
      library_id: "0c64a309-510e-5d37-b23c-3ce2f966c66e",
      skill_id: name,
      page_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      database_id: "00000000-0000-4000-8000-000000000010",
      data_source_id: "00000000-0000-4000-8000-000000000011",
    },
  })),
  count: 3,
  source: "notion",
  freshness: freshness({ refresh: true }, at, at, 60000),
  coverage: {
    method: "explicit_view",
    exhaustive: true,
    queried_data_sources: [],
    failed_sources: [],
    search_index_limited: false,
  },
  profile: {
    library_id: "0c64a309-510e-5d37-b23c-3ce2f966c66e",
    profile_id: "daily",
    fingerprint: "a".repeat(64),
    selection: "profile",
    source: "notion",
    freshness: freshness({ refresh: true }, at, at, 60000),
  },
}
const run = (input: ListCatalogResult, options: Parameters<typeof pageCatalog>[1]) =>
  Effect.runPromise(pageCatalog(input, options).pipe(Effect.provide(NodeServices.layer)))

test("SC25 Profile pagination survives refresh to offline while fingerprint/query/scope changes reject the cursor", async () => {
  const first = await run(catalog, { limit: 1 })
  if (first.next_cursor === null || catalog.profile === undefined)
    throw new Error("Expected a paged Profile fixture")
  const cached: ListCatalogResult = {
    ...catalog,
    source: "local_cache",
    freshness: freshness({ offline: true }, at, at + 2000, 60000),
    profile: {
      ...catalog.profile,
      source: "local_cache",
      freshness: freshness({ offline: true }, at, at + 2000, 60000),
    },
  }
  const next = await run(cached, { limit: 2, cursor: first.next_cursor })
  expect([...first.records, ...next.records]).toEqual([...catalog.records])
  expect(next.has_more).toBe(false)
  expect(next.next_cursor).toBeNull()
  for (const changed of [
    { ...cached, scope: "b".repeat(64) },
    { ...cached, fetched_at: at + 1 },
    { ...cached, profile: { ...catalog.profile, fingerprint: "b".repeat(64) } },
  ])
    await expect(run(changed, { limit: 2, cursor: first.next_cursor })).rejects.toMatchObject({
      code: "LIST_CURSOR_STALE",
    })
  await expect(run(cached, { query: "first", cursor: first.next_cursor })).rejects.toMatchObject({
    code: "LIST_CURSOR_STALE",
  })
})

function ordinaryCatalog() {
  const { profile: _profile, ...ordinary } = catalog
  return {
    ...ordinary,
    coverage: { ...ordinary.coverage, method: "explicit_database" },
  }
}

test("exact stable identity selection preserves root and resource paths without name fallback", () => {
  const ordinary = ordinaryCatalog()
  const first = ordinary.records[0]!
  const record = { ...first, name: "First Skill", alias: "first-skill" }
  const selected = { ...ordinary, records: [record], count: 1 }
  expect(resolveCatalogReference(record.id, selected)).toEqual({
    record,
    scope: selected.scope,
    ref: fileRef(record.id, record.entrypoint),
  })
  expect(
    resolveCatalogReference("skill://first/references/a%20b.md", selected, library.library_id).ref,
  ).toBe(fileRef(record.id, "references/a b.md"))
  for (const target of [
    "First Skill",
    "first-skill",
    "skill://First%20Skill/SKILL.md",
    "skill://first-skill?library=0c64a309-510e-5d37-b23c-3ce2f966c66e",
  ])
    expect(() => resolveCatalogReference(target, selected, library.library_id)).toThrow()
  expect(() => resolveCatalogReference("skill://first", selected)).toThrow(
    expect.objectContaining({ code: "LIBRARY_CONTEXT_REQUIRED" }),
  )
})

test("same display names stay independent and duplicate stable identities are rejected", () => {
  const ordinary = ordinaryCatalog(),
    first = ordinary.records[0]!,
    second = ordinary.records[1]!
  const duplicateName = { ...second, name: first.name, alias: first.alias }
  expect(
    resolveCatalogReference(first.id, { ...ordinary, records: [first, duplicateName], count: 2 })
      .record.id,
  ).toBe(first.id)
  expect(
    resolveCatalogReference(second.id, { ...ordinary, records: [first, duplicateName], count: 2 })
      .record.id,
  ).toBe(second.id)
  expect(() =>
    resolveCatalogReference(second.id, {
      ...ordinary,
      records: [{ ...second, enabled: false }],
      count: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "CONTENT_DISABLED" }))
  expect(() =>
    resolveCatalogReference(first.id, { ...ordinary, records: [first, first], count: 2 }),
  ).toThrow(expect.objectContaining({ code: "SKILL_ID_CONFLICT" }))
  const foreignLibrary = {
    ...library,
    library_id: "cc029b5c-680e-576d-a381-a069d3f9f26e",
    skills: {
      ...library.skills,
      database_id: "00000000-0000-4000-8000-000000000020",
      data_source_id: "00000000-0000-4000-8000-000000000021",
    },
  }
  const foreign = {
    ...first,
    id: "skill://first?library=cc029b5c-680e-576d-a381-a069d3f9f26e",
    ref: "skill://first/SKILL.md?library=cc029b5c-680e-576d-a381-a069d3f9f26e",
    locator: {
      ...first.locator,
      library_id: "cc029b5c-680e-576d-a381-a069d3f9f26e",
      database_id: foreignLibrary.skills.database_id,
      data_source_id: foreignLibrary.skills.data_source_id,
    },
  }
  const two = {
    ...ordinary,
    records: [first, foreign],
    count: 2,
    databases: [
      ...ordinary.databases,
      {
        alias: "test",
        title: "Testing",
        role: "content",
        database_id: foreignLibrary.skills.database_id,
        data_source_ids: [foreignLibrary.skills.data_source_id],
        shared_library: foreignLibrary,
      },
    ],
  }
  expect(resolveCatalogReference("skill://first", two, library.library_id).record.id).toBe(first.id)
  expect(resolveCatalogReference("skill://first", two, foreignLibrary.library_id).record.id).toBe(
    foreign.id,
  )
  expect(() => resolveCatalogReference("skill://first", two)).toThrow()
  expect(() =>
    resolveCatalogReference(first.id, {
      ...two,
      databases: two.databases.map((source) => ({
        ...source,
        shared_library: {
          ...source.shared_library,
          library_id: "0c64a309-510e-5d37-b23c-3ce2f966c66e",
        },
      })),
    }),
  ).toThrow(expect.objectContaining({ code: "LIBRARY_ID_CONFLICT" }))
})

test("zero and one match require complete source coverage before selection", () => {
  const ordinary = ordinaryCatalog()
  for (const records of [[], ordinary.records.slice(0, 1)])
    for (const coverage of [
      { ...ordinary.coverage, exhaustive: false },
      { ...ordinary.coverage, search_index_limited: true },
      {
        ...ordinary.coverage,
        failed_sources: [
          {
            id: "another-source",
            code: "ACCESS_DENIED",
            database_id: "another-database",
            alias: "another",
            title: "Unavailable source",
          },
        ],
      },
    ])
      expect(() =>
        resolveCatalogReference("skill://first?library=0c64a309-510e-5d37-b23c-3ce2f966c66e", {
          ...ordinary,
          records,
          count: records.length,
          coverage,
        }),
      ).toThrow(expect.objectContaining({ code: "CATALOG_INCOMPLETE" }))
})

test("Views, Profiles, queried or paged lists cannot prove ordinary identity coverage", async () => {
  const ordinary = ordinaryCatalog()
  const queriedPage = await run(ordinary, { query: "first", limit: 50 })
  expect(queriedPage.has_more).toBe(false)
  for (const projected of [
    catalog,
    queriedPage,
    { ...ordinary, coverage: { ...ordinary.coverage, method: "explicit_view" } },
    { ...ordinary, view: null, view_selection: "none", view_query: null },
    { ...ordinary, query: "first" },
    { ...ordinary, count: 1 },
  ])
    expect(() =>
      resolveCatalogReference(
        "skill://first?library=0c64a309-510e-5d37-b23c-3ce2f966c66e",
        projected,
      ),
    ).toThrow(expect.objectContaining({ code: "CATALOG_INCOMPLETE" }))
})

test("fixed references use their manifest and malformed or failed catalogs remain errors", () => {
  const ordinary = ordinaryCatalog()
  expect(() =>
    resolveCatalogReference(
      fileRef(
        "skill://first?library=0c64a309-510e-5d37-b23c-3ce2f966c66e",
        "SKILL.md",
        `s_${"a".repeat(64)}`,
      ),
      ordinary,
    ),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }))
  for (const invalid of [null, {}, { ...ordinary, ok: false }, { ...ordinary, records: null }])
    expect(() =>
      resolveCatalogReference(
        "skill://first?library=0c64a309-510e-5d37-b23c-3ce2f966c66e",
        invalid,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }))
})
