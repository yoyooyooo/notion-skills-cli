import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { freshness } from "../src/cache.ts"
import { pageCatalog, type ListCatalogResult } from "../src/catalog-consumption.ts"
import { resolveCatalogReference } from "../src/catalog-reference.ts"
import { fileRef } from "../src/ref.ts"

const at = 1000
const catalog: ListCatalogResult = {
  scope: "a".repeat(64),
  fetched_at: at,
  databases: [],
  records: ["first", "second", "third"].map((name, index) => ({
    id: `shared_skill:library:${name}`,
    kind: "skill",
    name,
    alias: name,
    description: "Controlled catalog metadata",
    default_context: false,
    entrypoint: "SKILL.md",
    ref: fileRef(`shared_skill:library:${name}`, "SKILL.md"),
    locator: {
      type: "shared_skill",
      library_id: "library",
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
    library_id: "library",
    library_entry: "00000000-0000-4000-8000-000000000010",
    profile_id: "daily",
    revision_id: "a".repeat(64),
    selection: "profile",
    source: "notion",
    freshness: freshness({ refresh: true }, at, at, 60000),
  },
}
const run = (input: ListCatalogResult, options: Parameters<typeof pageCatalog>[1]) =>
  Effect.runPromise(pageCatalog(input, options).pipe(Effect.provide(NodeServices.layer)))

test("SC25 Profile pagination survives refresh to offline while revision/query/scope changes reject the cursor", async () => {
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
    { ...cached, profile: { ...catalog.profile, revision_id: "b".repeat(64) } },
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

test("current name selection preserves exact name, alias, resource path, and canonical File ID", () => {
  const ordinary = ordinaryCatalog()
  const first = ordinary.records[0]
  if (first === undefined) throw new Error("Expected catalog fixture record")
  const record = { ...first, name: "First Skill", alias: "first-skill" }
  const selected = { ...ordinary, records: [record], count: 1 }
  for (const target of ["First Skill", "first-skill", "skill://First%20Skill/SKILL.md"])
    expect(resolveCatalogReference(target, { ok: true, ...selected })).toEqual({
      record,
      scope: selected.scope,
      ref: fileRef(record.id, record.entrypoint),
    })
  expect(resolveCatalogReference("skill://first-skill/references/a%20b.md", selected).ref).toBe(
    fileRef(record.id, "references/a b.md"),
  )
  const exactFile = fileRef(record.id, "references/a.md", undefined, "selected-file")
  expect(resolveCatalogReference(exactFile, selected).ref).toBe(exactFile)
  for (const query of ["first", "First", record.description])
    expect(() => resolveCatalogReference(query, selected)).toThrow(
      expect.objectContaining({ code: "SKILL_NOT_FOUND" }),
    )
})

test("ordinary enabled names stay distinct from disabled display names and stable identity conflicts", () => {
  const ordinary = ordinaryCatalog()
  const [first, second] = ordinary.records
  if (first === undefined || second === undefined) throw new Error("Expected catalog records")
  const duplicateName = { ...second, name: first.name, alias: first.alias }
  expect(() =>
    resolveCatalogReference(first.name, { ...ordinary, records: [first, duplicateName], count: 2 }),
  ).toThrow(expect.objectContaining({ code: "SKILL_AMBIGUOUS" }))
  expect(
    resolveCatalogReference(first.name, {
      ...ordinary,
      records: [first, { ...duplicateName, enabled: false }],
      count: 2,
    }).record.id,
  ).toBe(first.id)
  expect(() =>
    resolveCatalogReference(second.name, {
      ...ordinary,
      records: [{ ...second, enabled: false }],
      count: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "SKILL_NOT_FOUND" }))
  expect(() =>
    resolveCatalogReference(first.name, {
      ...ordinary,
      records: [first, { ...first, locator: second.locator }],
      count: 2,
    }),
  ).toThrow(expect.objectContaining({ code: "CATALOG_INCOMPLETE" }))
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
        resolveCatalogReference("first", { ...ordinary, records, count: records.length, coverage }),
      ).toThrow(expect.objectContaining({ code: "CATALOG_INCOMPLETE" }))
})

test("Views, Profiles, queried or paged lists cannot prove ordinary name uniqueness", async () => {
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
    expect(() => resolveCatalogReference("first", projected)).toThrow(
      expect.objectContaining({ code: "CATALOG_INCOMPLETE" }),
    )
})

test("fixed references use their manifest and malformed or failed catalogs remain errors", () => {
  const ordinary = ordinaryCatalog()
  expect(() =>
    resolveCatalogReference(fileRef("first", "SKILL.md", `s_${"a".repeat(64)}`), ordinary),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }))
  for (const invalid of [null, {}, { ...ordinary, ok: false }, { ...ordinary, records: null }])
    expect(() => resolveCatalogReference("first", invalid)).toThrow(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    )
})
