import { describe, expect, test } from "bun:test"
import { Clock, Crypto, Effect } from "effect"
import { fail, property, type SkillsError, type Source } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { fileRef } from "../src/ref.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { listCatalog } from "../src/catalog-consumption.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import {
  directorySkillMetadata,
  withSharedDirectoryMetadata,
} from "../src/shared-metadata-inventory.ts"
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

function fixture(
  options: {
    readonly unconfigured?: boolean
    readonly wrap?: (
      path: string,
      read: Effect.Effect<unknown, SkillsError>,
    ) => Effect.Effect<unknown, SkillsError>
  } = {},
) {
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
          request: (path, body, requestOptions) => {
            const read = Effect.suspend(() => {
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
              if (response === undefined) return api.request(path, body, requestOptions)
              const method = requestOptions?.method ?? (body === undefined ? "GET" : "POST")
              const finish = api.metrics?.begin({
                path,
                method,
                content: requestOptions?.content,
                key: canonicalSharedJson([path, body ?? null]),
                requestBytes: body === undefined ? 0 : encode(JSON.stringify(body)).length,
              })
              finish?.({
                outcome: "success",
                responseBytes: encode(JSON.stringify(response)).length,
              })
              return Effect.succeed(response)
            })
            return options.wrap?.(path, read) ?? read
          },
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
  test("SC11 paired catalog and default directory reuse one complete metadata inventory", async () => {
    const f = fixture()
    f.inventory([[f.rows[0]], [f.rows[1], f.rows[2]]])
    const result = await f.run(listCatalog({ database: db, directory: {} }))
    expect(result.version).toBe(1)
    if (!result.catalog.ok || !result.directory.ok)
      throw new Error("Both projections must succeed.")
    expect(result.catalog.value.records.map((record) => record.name)).toEqual(["Alpha", "Gamma"])
    expect(result.directory.value.records.map((record) => record.name)).toEqual(["Gamma", "Alpha"])
    expect(
      f.requests.filter((request) => request.path.includes(`/data_sources/${ds}/query`)),
    ).toHaveLength(2)
    assertMetadataOnly(f)
  })

  test("SC11 separate catalog calls retain their own fresh observations", async () => {
    const f = fixture()
    f.inventory([[f.rows[0]], [f.rows[1], f.rows[2]]])
    await f.run(listCatalog({ database: db }))
    await f.run(listCatalog({ database: db, defaultView: true }))
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(4)
    assertMetadataOnly(f)
  })

  test.each(["catalog", "directory"])(
    "SC11 combined directory honors a warm %s projection and then both caches",
    async (warm) => {
      const f = fixture()
      f.inventory([[f.rows[0]], [f.rows[1], f.rows[2]]])
      await f.run(
        listCatalog({ database: db, ...(warm === "directory" ? { defaultView: true } : {}) }),
      )
      f.clear()
      const result = await f.run(listCatalog({ database: db, directory: {} }))
      if (!result.catalog.ok || !result.directory.ok)
        throw new Error("Expected complete projections")
      expect((warm === "catalog" ? result.catalog.value : result.directory.value).source).toBe(
        "local_cache",
      )
      expect(
        f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
      ).toHaveLength(2)
      f.clear()
      const cached = await f.run(listCatalog({ database: db, directory: {} }))
      const offline = await f.run(listCatalog({ database: db, directory: {}, offline: true }))
      expect(cached).toMatchObject({
        catalog: { ok: true, value: { source: "local_cache" } },
        directory: { ok: true, value: { source: "local_cache" } },
      })
      expect(offline).toMatchObject({ catalog: { ok: true }, directory: { ok: true } })
      expect(f.requests).toHaveLength(0)
    },
  )

  test("SC11 full catalog conflicts remain independent from a valid selected View", async () => {
    const f = fixture()
    f.members([[skillPage]])
    f.rows[1] = row(beta, "unrelated", "Unrelated one")
    f.rows[2] = row(gamma, "unrelated", "Unrelated two")
    const result = await f.run(listCatalog({ database: db, directory: { view: viewA } }))
    expect(result.catalog).toMatchObject({ ok: false, error: { code: "SHARED_SKILL_ID_CONFLICT" } })
    if (!result.directory.ok) throw new Error("The unrelated conflict must not block the View")
    expect(result.directory.value.records.map((record) => record.name)).toEqual(["Alpha"])
    expect(result.directory.value.coverage.exhaustive).toBe(true)
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
    assertMetadataOnly(f)
  })

  test("SC11 malformed Skill ID details survive a combined catalog with a valid View", async () => {
    const f = fixture()
    f.members([[skillPage]])
    f.rows[1] = row(beta, "", "Private malformed row", true)
    const result = await f.run(listCatalog({ database: db, directory: { view: viewA } }))
    expect(result.catalog).toEqual({
      ok: false,
      error: {
        code: "INVALID_SHARED_SKILL",
        message: "Skill ID must be a stable bounded identity.",
        details: {
          page_id: beta,
          data_source_id: ds,
          property: "Skill ID",
          property_id: library.skills.property_ids["Skill ID"],
          reason: "empty",
          value_length: 0,
        },
      },
    })
    expect(JSON.stringify(result.catalog)).not.toContain("Private malformed row")
    if (!result.directory.ok) throw new Error("The unrelated invalid row must not block the View")
    expect(result.directory.value.records.map((record) => record.name)).toEqual(["Alpha"])
    expect(result.directory.value.coverage.exhaustive).toBe(true)
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
    expect(f.requests.some((request) => request.path.startsWith("v1/pages/"))).toBe(false)
    assertMetadataOnly(f)
  })

  test("SC11 shared raw inventory preserves disabled identity claims and selected missing rows", async () => {
    const f = fixture()
    f.members([[skillPage]])
    f.rows[1] = row(beta, "alpha", "Disabled duplicate", false)
    const conflict = await f.run(listCatalog({ database: db, directory: { view: viewA } }))
    expect(conflict).toMatchObject({
      catalog: { ok: false, error: { code: "SHARED_SKILL_ID_CONFLICT" } },
      directory: { ok: false, error: { code: "SHARED_SKILL_ID_CONFLICT" } },
    })
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
    const missing = fixture()
    missing.members([[id(9999)]])
    const result = await missing.run(listCatalog({ database: db, directory: { view: viewA } }))
    expect(result).toMatchObject({
      catalog: { ok: true },
      directory: {
        ok: true,
        value: {
          records: [],
          coverage: {
            exhaustive: false,
            failed_sources: [{ id: id(9999), code: "VIEW_MEMBER_UNAVAILABLE" }],
          },
        },
      },
    })
    const offline = await missing.run(
      listCatalog({ database: db, directory: { view: viewA }, offline: true }),
    )
    expect(offline.directory).toMatchObject({ ok: false, error: { code: "CACHE_MISSING" } })
  })

  test("SC11 unregistered disabled pages stay outside both directory projections", async () => {
    const f = fixture()
    f.rows[1] = row(beta, "", "Unregistered draft", false)
    const result = await f.run(listCatalog({ database: db, directory: { view: viewA } }))
    if (!result.catalog.ok || !result.directory.ok)
      throw new Error("Drafts must not block discovery")
    expect(result.catalog.value.records.map((record) => record.name)).toEqual(["Alpha", "Gamma"])
    expect(result.directory.value.records.map((record) => record.name)).toEqual(["Gamma", "Alpha"])
    expect(result.catalog.value.coverage.exhaustive).toBe(true)
    expect(result.directory.value.coverage.exhaustive).toBe(true)
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
    assertMetadataOnly(f)
  })

  test("SC11 incomplete inventory is never shared into a successful View", async () => {
    const f = fixture()
    f.status({ type: "incomplete", incomplete_reason: "query_result_limit_reached" })
    const result = await f.run(listCatalog({ database: db, directory: { view: viewA } }))
    expect(result.catalog).toMatchObject({ ok: true, value: { coverage: { exhaustive: false } } })
    expect(result.directory).toMatchObject({ ok: false, error: { code: "VIEW_INCOMPLETE" } })
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(2)
  })

  test.each(["scope", "descriptor"])(
    "SC11 %s changes re-read inventory and reject mixed directory projections",
    async (change) => {
      let identities = 0
      let descriptors = 0
      const f = fixture({
        wrap: (path, read) =>
          read.pipe(
            Effect.map((value) => {
              if (change === "scope" && path === "v1/users/me" && ++identities > 1)
                return { object: "user", id: "changed-fixture-user" }
              if (change === "descriptor" && path === "v1/databases/" + db && ++descriptors > 1)
                return {
                  ...property(value),
                  description: [
                    {
                      plain_text:
                        LIBRARY_MARKER +
                        JSON.stringify({
                          ...library,
                          skills: {
                            ...library.skills,
                            property_ids: { ...library.skills.property_ids, Tags: "changed-tags" },
                          },
                        }),
                    },
                  ],
                }
              return value
            }),
          ),
      })
      const error = await f.run(Effect.flip(listCatalog({ database: db, directory: {} })))
      expect(error.code).toBe(change === "scope" ? "ACCESS_DENIED" : "SHARED_LIBRARY_ID_CONFLICT")
      expect(
        f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
      ).toHaveLength(2)
    },
  )

  test.each([0, 60_000])(
    "SC11 an expired or max-age-zero inventory is not shared, maxAge=%s",
    async (maxAge) => {
      const f = fixture()
      let now = 1_000
      await f.run(
        Effect.gen(function* () {
          const clock = yield* Clock.Clock
          return yield* withSharedDirectoryMetadata(
            Effect.gen(function* () {
              yield* directorySkillMetadata(library, "scope", maxAge, "catalog")
              now += maxAge
              yield* directorySkillMetadata(library, "scope", maxAge, "view")
            }),
          ).pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              currentTimeMillis: Effect.sync(() => now),
              currentTimeMillisUnsafe: () => now,
            }),
          )
        }),
      )
      expect(
        f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
      ).toHaveLength(2)
    },
  )

  test("SC11 View freshness retains the original shared inventory observation time", async () => {
    let now = Date.now()
    const original = now
    const f = fixture({
      wrap: (path, read) =>
        Effect.suspend(() => {
          if (path.endsWith("/queries")) now += 10_000
          return read
        }),
    })
    const result = await f.run(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock
        return yield* listCatalog({ database: db, directory: {} }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillis: Effect.sync(() => now),
            currentTimeMillisUnsafe: () => now,
          }),
        )
      }),
    )
    if (!result.directory.ok) throw new Error("Expected a complete View")
    expect(result.directory.value.fetched_at).toBe(original)
    expect(result.directory.value.freshness.age_ms).toBe(10_000)
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
  })

  test("SC11 cancellation interrupts the combined operation rather than becoming a directory outcome", async () => {
    const f = fixture({
      wrap: (path, read) => (path.endsWith("/queries") ? Effect.interrupt : read),
    })
    await expect(f.run(listCatalog({ database: db, directory: {} }))).rejects.toThrow(/interrupt/i)
    expect(
      f.requests.filter((request) => request.path.includes("/data_sources/" + ds + "/query")),
    ).toHaveLength(1)
    const retry = await f.run(
      listCatalog({ database: db, directory: { view: viewB }, offline: true }),
    )
    expect(retry.directory).toMatchObject({ ok: false, error: { code: "CACHE_MISSING" } })
  })

  test("SC11 typed cancellation also rejects the entire combined operation", async () => {
    const f = fixture({
      wrap: (path, read) =>
        path.endsWith("/queries")
          ? Effect.fail(fail("CANCELLED", "Controlled cancellation"))
          : read,
    })
    const error = await f.run(Effect.flip(listCatalog({ database: db, directory: {} })))
    expect(error.code).toBe("CANCELLED")
  })

  test("SC11 a directory Profile without a database fails before source access", async () => {
    const f = fixture()
    const error = await f.run(Effect.flip(listCatalog({ directory: { profile: "profile" } })))
    expect(error.code).toBe("INVALID_ARGUMENT")
    expect(f.requests).toHaveLength(0)
  })

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

  test("Tags and View membership refresh independently of warm content and exact historical pins", async () => {
    const f = fixture()
    const snapshot = await f.base.open()
    const ref = fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id)
    const original = await f.base.run(readSkill(ref, { offline: true }))
    if (!("content" in original)) throw new Error("Expected the fixed main text")
    const objects = structuredClone(f.base.objects)
    f.rows[0] = f.base.main
    const tags = (names: string[]) => {
      property(f.base.main.properties).tags = {
        id: library.skills.property_ids.Tags,
        type: "multi_select",
        multi_select: names.map((name) => ({ id: name, name, color: "default" })),
      }
    }
    tags(["visible"])
    // These are controlled API observations, not a reimplementation of Notion's filter engine.
    f.members([[skillPage]])
    f.clear()
    const first = await f.run(viewCatalog({ database: db, view: viewA }))
    expect(first.records.map((record) => record.id)).toEqual([snapshot.record.id])
    assertMetadataOnly(f)

    tags(["hidden"])
    f.members([[gamma]])
    f.clear()
    const warm = await f.run(viewCatalog({ database: db, view: viewA }))
    expect(warm.records).toEqual(first.records)
    expect(warm.fetched_at).toBe(first.fetched_at)
    expect(warm.source).toBe("local_cache")
    expect(f.requests).toHaveLength(0)

    const refreshed = await f.run(viewCatalog({ database: db, view: viewA, refresh: true }))
    expect(refreshed.records.map((record) => record.id)).toEqual([
      sharedSkillId(library.library_id, "gamma"),
    ])
    expect(refreshed.coverage.exhaustive).toBe(true)
    expect(f.requests.some((call) => call.path.endsWith(`/views/${viewA}/queries`))).toBe(true)
    assertMetadataOnly(f)

    // A changed server View selection is observed again when the directory expires.
    f.members([[skillPage, gamma]])
    f.clear()
    const expired = await f.run(viewCatalog({ database: db, view: viewA, maxAge: 0 }))
    expect(expired.records.map((record) => record.id)).toEqual([
      snapshot.record.id,
      sharedSkillId(library.library_id, "gamma"),
    ])
    expect(expired.source).toBe("notion")
    expect(expired.coverage.exhaustive).toBe(true)
    assertMetadataOnly(f)

    f.status({ type: "incomplete", incomplete_reason: "query_result_limit_reached" })
    f.clear()
    const failed = await f.run(
      Effect.flip(viewCatalog({ database: db, view: viewA, refresh: true })),
    )
    expect(failed.code).toBe("VIEW_INCOMPLETE")
    assertMetadataOnly(f)
    f.clear()
    const retained = await f.run(viewCatalog({ database: db, view: viewA, offline: true }))
    expect(retained.records).toEqual(expired.records)
    expect(retained.fetched_at).toBe(expired.fetched_at)
    const historical = await f.base.run(readSkill(ref, { offline: true }))
    if (!("content" in historical)) throw new Error("Expected the historical main text")
    expect(historical.snapshot_id).toBe(snapshot.snapshot_id)
    expect(historical.content).toBe(original.content)
    expect(historical.native_references).toEqual(original.native_references)
    expect(f.base.objects).toEqual(objects)
    expect(f.requests).toHaveLength(0)
    expect(f.base.requestMetrics().total_requests).toBe(0)
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
