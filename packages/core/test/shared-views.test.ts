import { describe, expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import { property, type Source } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { Store } from "../src/store.ts"
import { listViews, viewCatalog } from "../src/views.ts"
import { sharedSnapshotFixture, library, skillPage, id, encode } from "./shared-snapshot-fixture.ts"

const db = library.skills.database_id
const ds = library.skills.data_source_id
const viewA = id(40)
const viewB = id(41)
const queryId = id(50)
const beta = id(31)
const gamma = id(32)
const configuredSource: Source = {
  alias: "shared-library",
  database_id: db,
  title: "Shared library",
  data_source_ids: [ds],
  role: "content",
  shared_library: library,
}
const references = (ids: readonly string[], object = "page", next: string | null = null) => ({
  object: "list",
  results: ids.map((id) => ({ id, object })),
  has_more: next !== null,
  next_cursor: next,
  request_status: { type: "complete", incomplete_reason: null },
})
function rich(id: string, value: string) {
  return {
    id,
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
    has_more: false,
  }
}
function row(page: string, stableId: string, name: string, enabled = true, defaultContext = false) {
  return {
    object: "page",
    id: page,
    parent: { type: "data_source_id", data_source_id: ds, database_id: db },
    properties: {
      "Renamed title": { id: "title", type: "title", title: [{ plain_text: name }] },
      "Renamed description": rich("description", `${name} description`),
      "Renamed kind": { id: "kind", type: "select", select: { name: "skill" } },
      "Renamed stable identity": rich("skill_id", stableId),
      "Renamed enabled": { id: "enabled", type: "checkbox", checkbox: enabled },
      "Renamed context": { id: "default", type: "checkbox", checkbox: defaultContext },
      // Display-name decoys must not be interpreted as registered Shared properties.
      Name: { id: "decoy-title", type: "title", title: [{ plain_text: "Wrong legacy title" }] },
      Description: rich("decoy-description", "Wrong legacy description"),
      "Default Context": { id: "decoy-default", type: "checkbox", checkbox: true },
    },
  }
}

function fixture(options: { readonly unconfigured?: boolean } = {}) {
  const base = sharedSnapshotFixture()
  const config = {
    sources: options.unconfigured ? [] : [configuredSource],
    default_database: id(999),
  }
  base.json.set("config.json", structuredClone(config))
  const requests: { readonly path: string; readonly body: unknown }[] = []
  const rows: unknown[] = [
    row(skillPage, "alpha", "Alpha"),
    row(beta, "beta", "Beta", false, true),
    row(gamma, "gamma", "Gamma"),
  ]
  let listed = [viewA, viewB]
  let memberPages: readonly (readonly string[])[] = [[gamma, skillPage, beta]]
  let inventoryPages: readonly (readonly unknown[])[] | undefined
  let status: unknown = { type: "complete", incomplete_reason: null }
  let viewDataSource = ds

  const run = <A, E>(effect: Effect.Effect<A, E, Store | Notion | Crypto.Crypto>) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.suspend(() => {
              requests.push({ path, body })
              const url = new URL(path, "https://api.notion.com/")
              let response: unknown
              if (url.pathname === "/v1/search")
                response = {
                  ...references([]),
                  results: [
                    {
                      id: ds,
                      parent: { database_id: db },
                      database_type: null,
                      title: [{ plain_text: "Shared library" }],
                      properties: {
                        "Skill ID": { type: "rich_text" },
                        "Main File ID": { type: "rich_text" },
                      },
                    },
                  ],
                }
              else if (url.pathname === "/v1/views") response = references(listed, "view")
              else if (
                url.pathname === `/v1/views/${viewA}` ||
                url.pathname === `/v1/views/${viewB}`
              )
                response = {
                  id: url.pathname.endsWith(viewA) ? viewA : viewB,
                  name: url.pathname.endsWith(viewA) ? "Z native first" : "A native second",
                  type: "table",
                  data_source_id: viewDataSource,
                  parent: { type: "database_id", database_id: db },
                  url: `https://notion.so/${db}?v=${url.pathname.endsWith(viewA) ? viewA : viewB}`,
                }
              else if (
                url.pathname === `/v1/views/${viewA}/queries` ||
                url.pathname === `/v1/views/${viewB}/queries`
              )
                response = {
                  ...references(memberPages[0] ?? [], "page", memberPages.length > 1 ? "1" : null),
                  id: queryId,
                  view_id: url.pathname.includes(viewA) ? viewA : viewB,
                  expires_at: new Date(Date.now() + 900000).toISOString(),
                  total_count: memberPages.reduce((total, page) => total + page.length, 0),
                }
              else if (
                url.pathname === `/v1/views/${viewA}/queries/${queryId}` ||
                url.pathname === `/v1/views/${viewB}/queries/${queryId}`
              ) {
                const index = Number(url.searchParams.get("start_cursor"))
                response = references(
                  memberPages[index] ?? [],
                  "page",
                  index + 1 < memberPages.length ? String(index + 1) : null,
                )
              } else if (url.pathname === `/v1/data_sources/${ds}/query`) {
                const pages = inventoryPages ?? [rows]
                const rawCursor = property(body).start_cursor
                const index = rawCursor === undefined ? 0 : Number(rawCursor)
                response = {
                  object: "list",
                  results: structuredClone(pages[index] ?? []),
                  has_more: index + 1 < pages.length,
                  next_cursor: index + 1 < pages.length ? String(index + 1) : null,
                  request_status: status,
                }
              }
              if (response === undefined) return api.request(path, body, options)
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              const finish = api.metrics?.begin({
                path,
                method,
                content: options?.content,
                key: canonicalSharedJson([path, body ?? null]),
                requestBytes: body === undefined ? 0 : encode(JSON.stringify(body)).length,
              })
              finish?.({
                outcome: "success",
                responseBytes: encode(JSON.stringify(response)).length,
              })
              return Effect.succeed(response)
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, controlled))
      }),
    )
  return {
    base,
    config,
    requests,
    rows,
    run,
    members: (pages: readonly (readonly string[])[]) => {
      memberPages = pages
    },
    inventory: (pages: readonly (readonly unknown[])[]) => {
      inventoryPages = pages
    },
    listed: (ids: string[]) => {
      listed = ids
    },
    status: (value: unknown) => {
      status = value
    },
    viewDataSource: (value: string) => {
      viewDataSource = value
    },
    clear: () => {
      requests.length = 0
      base.clearCalls()
    },
  }
}

function assertMetadataOnly(f: ReturnType<typeof fixture>) {
  expect(f.base.requestMetrics().requests).toMatchObject({
    notion_body: 0,
    notion_write: 0,
    provider: 0,
  })
  expect(f.base.requestMetrics().total_requests).toBe(f.requests.length)
  expect(
    f.requests.some((request) => /\/pages\/|\/markdown|\/blocks|\/export/.test(request.path)),
  ).toBe(false)
  expect(
    f.requests.some(
      (request) =>
        request.path.includes(library.files.data_source_id) ||
        request.path.includes(library.records.data_source_id),
    ),
  ).toBe(false)
  expect(f.base.json.get("config.json")).toEqual(f.config)
}

describe("shared library Views metadata", () => {
  test("lists native View order from a registered shared library without changing the user's default", async () => {
    const f = fixture()
    const result = await f.run(listViews({ database: "shared-library" }))
    expect(result.database.shared_library?.library_id).toBe(library.library_id)
    expect(result.views.map((view) => view.id)).toEqual([viewA, viewB])
    expect(
      f.requests.some((request) =>
        new URL(request.path, "https://api.notion.com/").pathname.endsWith("/query"),
      ),
    ).toBe(false)
    assertMetadataOnly(f)
  })

  test("decodes stable property IDs, filters Enabled, and preserves View members with Default Context false", async () => {
    const f = fixture()
    f.rows.push({ id: id(909), properties: { malformed: true } })
    const result = await f.run(viewCatalog({ database: db, view: viewA }))
    expect(result.records.map((record) => record.name)).toEqual(["Gamma", "Alpha"])
    expect(result.records.map((record) => record.id)).toEqual([
      sharedSkillId(library.library_id, "gamma"),
      sharedSkillId(library.library_id, "alpha"),
    ])
    expect(
      result.records.every(
        (record) =>
          record.locator.type === "shared_skill" &&
          record.enabled === true &&
          record.default_context === false,
      ),
    ).toBe(true)
    expect(result.coverage.exhaustive).toBe(true)
    expect(result.view_query?.total_count).toBe(3)
    const inventory = f.requests.find(
      (request) =>
        new URL(request.path, "https://api.notion.com/").pathname ===
        `/v1/data_sources/${ds}/query`,
    )
    if (inventory === undefined) throw new Error("Missing batched metadata query.")
    expect(
      new URL(inventory.path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
    ).toEqual(["title", "description", "kind", "skill_id", "enabled", "default"])
    expect(inventory.body).toEqual({ page_size: 100 })
    expect(
      f.requests.filter((request) => request.path.includes(`/data_sources/${ds}/query`)),
    ).toHaveLength(1)
    expect(f.requests.some((request) => request.path.startsWith("v1/views?"))).toBe(false)
    assertMetadataOnly(f)
  })

  test("globally discovers a shared Skills entry and chooses its first native View", async () => {
    const f = fixture({ unconfigured: true })
    const result = await f.run(viewCatalog())
    expect(result.view?.id).toBe(viewA)
    expect(result.view_selection).toBe("first")
    expect(result.records.map((record) => record.name)).toEqual(["Gamma", "Alpha"])
    expect(f.requests.some((request) => request.path === "v1/search")).toBe(true)
    assertMetadataOnly(f)
  })

  test("zero Views remains an empty directory rather than a whole-library query", async () => {
    const f = fixture()
    f.listed([])
    const result = await f.run(viewCatalog({ database: db }))
    expect(result.view_selection).toBe("none")
    expect(result.records).toEqual([])
    expect(f.requests.some((request) => request.path.includes(`/data_sources/${ds}/query`))).toBe(
      false,
    )
    assertMetadataOnly(f)
  })

  test("paginates the frozen View membership and one metadata inventory without per-page reads", async () => {
    const f = fixture()
    f.members([[gamma], [skillPage, beta]])
    f.inventory([[f.rows[0]], [f.rows[1], f.rows[2]]])
    const result = await f.run(viewCatalog({ view: viewA }))
    expect(result.records.map((record) => record.name)).toEqual(["Gamma", "Alpha"])
    expect(
      f.requests.filter((request) => request.path.includes(`/data_sources/${ds}/query`)),
    ).toHaveLength(2)
    expect(f.requests.filter((request) => request.path.endsWith("/queries"))).toHaveLength(1)
    expect(
      f.requests.filter((request) => request.path.includes(`/queries/${queryId}?`)),
    ).toHaveLength(1)
    assertMetadataOnly(f)
  })

  test("conflicting stable IDs fail even when one selected row is disabled", async () => {
    const f = fixture()
    f.rows[1] = row(beta, "alpha", "Disabled duplicate", false)
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA })))
    expect(error.code).toBe("SHARED_SKILL_ID_CONFLICT")
    expect([...f.base.json.values()].some((value) => Array.isArray(property(value).records))).toBe(
      false,
    )
  })

  test("a repeated selected metadata page cannot masquerade as a complete shared catalog", async () => {
    const f = fixture()
    f.inventory([[f.rows[0], f.rows[1], f.rows[2]], [f.rows[0]]])
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA })))
    expect(error.code).toBe("SHARED_SKILL_ID_CONFLICT")
  })

  test.each([true, false])(
    "an unselected page cannot claim a selected stable identity, enabled=%s",
    async (enabled) => {
      const f = fixture()
      f.members([[skillPage]])
      f.rows[1] = row(beta, "alpha", "Unselected duplicate", enabled)
      const error = await f.run(Effect.flip(viewCatalog({ view: viewA })))
      expect(error.code).toBe("SHARED_SKILL_ID_CONFLICT")
      expect(
        f.requests.filter((request) => request.path.includes(`/data_sources/${ds}/query`)),
      ).toHaveLength(1)
      assertMetadataOnly(f)
    },
  )

  test("unrelated stable identity conflicts do not change the selected View membership", async () => {
    const f = fixture()
    f.members([[skillPage]])
    f.rows[1] = row(beta, "unrelated", "Unrelated one")
    f.rows[2] = row(gamma, "unrelated", "Unrelated two")
    const result = await f.run(viewCatalog({ view: viewA }))
    expect(result.records.map((record) => record.name)).toEqual(["Alpha"])
    expect(result.coverage.exhaustive).toBe(true)
    assertMetadataOnly(f)
  })

  test("missing or invalid selected metadata remains incomplete and cannot be reused offline", async () => {
    const f = fixture()
    f.rows[0] = {
      ...row(skillPage, "alpha", "Alpha"),
      parent: {
        type: "data_source_id",
        database_id: db,
        data_source_id: library.files.data_source_id,
      },
    }
    const result = await f.run(viewCatalog({ view: viewA }))
    expect(result.records.map((record) => record.name)).toEqual(["Gamma"])
    expect(result.coverage.exhaustive).toBe(false)
    expect(result.coverage.failed_sources[0]?.id).toBe(skillPage)
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA, offline: true })))
    expect(error.code).toBe("CACHE_MISSING")
    assertMetadataOnly(f)
  })

  test("an incomplete shared inventory fails even on its final pagination page", async () => {
    const f = fixture()
    f.status({ type: "incomplete", incomplete_reason: "query_result_limit_reached" })
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA })))
    expect(error.code).toBe("VIEW_INCOMPLETE")
  })

  test("a View cannot address Files or another data source through the shared Skills entry", async () => {
    const f = fixture()
    f.viewDataSource(library.files.data_source_id)
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA })))
    expect(error.code).toBe("VIEW_SCOPE_MISMATCH")
    expect(f.requests.some((request) => request.path.includes("/query"))).toBe(false)
  })

  test("a complete shared View cache remains metadata-only and reusable without requests", async () => {
    const f = fixture()
    const first = await f.run(viewCatalog({ view: viewA }))
    f.clear()
    const cached = await f.run(viewCatalog({ view: viewA }))
    const offline = await f.run(viewCatalog({ view: viewA, offline: true }))
    expect(cached.records).toEqual(first.records)
    expect(offline.records).toEqual(first.records)
    expect(cached.source).toBe("local_cache")
    expect(f.requests).toHaveLength(0)
    expect(f.base.requestMetrics().total_requests).toBe(0)
    expect([...f.base.json.keys()].some((key) => key.startsWith("cache/catalogs/"))).toBe(false)
  })

  test("a cached stable identity conflict is rejected before returning offline members", async () => {
    const f = fixture()
    await f.run(viewCatalog({ view: viewA }))
    for (const [key, value] of f.base.json) {
      const copy = structuredClone(property(value))
      if (
        !key.startsWith("cache/views/") ||
        !Array.isArray(copy.records) ||
        copy.records.length === 0
      )
        continue
      copy.records.push(structuredClone(copy.records[0]))
      f.base.json.set(key, copy)
    }
    f.clear()
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA, offline: true })))
    expect(error.code).toBe("SHARED_SKILL_ID_CONFLICT")
    expect(f.requests).toHaveLength(0)
  })

  test("a disabled cached shared member cannot bypass the Enabled gate", async () => {
    const f = fixture()
    await f.run(viewCatalog({ view: viewA }))
    for (const [key, value] of f.base.json) {
      const copy = structuredClone(property(value))
      if (
        !key.startsWith("cache/views/") ||
        !Array.isArray(copy.records) ||
        copy.records.length === 0
      )
        continue
      property(copy.records[0]).enabled = false
      f.base.json.set(key, copy)
    }
    f.clear()
    const error = await f.run(Effect.flip(viewCatalog({ view: viewA, offline: true })))
    expect(error.code).toBe("STATE_CORRUPT")
    expect(f.requests).toHaveLength(0)
  })
})
