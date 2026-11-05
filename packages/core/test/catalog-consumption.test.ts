import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { freshness } from "../src/cache.ts"
import { pageCatalog, type ListCatalogResult } from "../src/catalog-consumption.ts"
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
