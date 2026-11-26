import { mkdtemp, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  CANDIDATE_SNAPSHOT_CONTRACT_VERSION,
  listCatalog,
  readCandidateSnapshot,
  readSkill,
} from "../../cli/src/sdk.ts"
import { runLocalRuntimeOperation } from "../../cli/src/operation-runtime.ts"
import { CatalogObservationSchema } from "../src/catalog-cache.ts"
import { property } from "../src/model.ts"
import { Store } from "../src/store.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { currentId, currentRich } from "./shared-current-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)

async function controlled() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-candidate-snapshot-"))
  const f = nativeGraphFixture({ width: 1 })
  const library = f.descriptor
  const source = await startSdkSourceFixture(
    {
      notion: {
        library,
        root: librarySchemaResponse("v1/pages/" + library.library_id, library),
        root_children: property(
          librarySchemaResponse("v1/blocks/" + library.library_id + "/children", library),
        ).results,
        databases: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/databases/" + library[role].database_id, library),
        ),
        data_sources: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/data_sources/" + library[role].data_source_id, library),
        ),
        main: structuredClone(f.pages[0]),
        skills: structuredClone(f.pages),
        files: [],
        records: [],
        sources: [],
        bodies: Object.fromEntries(f.bodies),
      },
    },
    join(root, "requests.jsonl"),
  )
  const options = {
    library: library.library_id,
    env: {
      NOTION_API_TOKEN: "candidate-controlled-token",
      NOTION_API_BASE_URL: source.origin,
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
      NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    },
  }
  return { root, f, library, source, options }
}
async function finish(c: Awaited<ReturnType<typeof controlled>>) {
  await c.source.close()
  expect(c.source.unexpected).toEqual([])
  expect(
    c.source.requests.filter(
      (row: { method: string; path: string }) =>
        row.method !== "GET" && !row.path.endsWith("/query"),
    ),
  ).toEqual([])
  console.info(JSON.stringify({ candidateSnapshotEvidence: c.root }))
}

test("local candidate miss and warm snapshot acquire no transport, scheduler, View, or bodies", async () => {
  const c = await controlled()
  try {
    expect(CANDIDATE_SNAPSHOT_CONTRACT_VERSION).toBe(1)
    const reports: unknown[] = []
    const local = {
      ...c.options,
      metrics: true,
      env: { ...c.options.env, NTN_SKILLS_NOTION_CONCURRENCY: "invalid" },
      onRequestMetrics: (value: unknown) => reports.push(value),
    }
    expect(await readCandidateSnapshot(local)).toMatchObject({
      kind: "miss",
      reason: "scope_unavailable",
    })
    expect(c.source.requests).toHaveLength(0)
    await expect(stat(c.options.env.NTN_SKILLS_SCHEDULER_ROOT)).rejects.toMatchObject({
      code: "ENOENT",
    })
    const catalog = await listCatalog({ ...c.options, refresh: true })
    const before = c.source.requests.length
    const first = await readCandidateSnapshot(local)
    expect(first).toMatchObject({
      kind: "snapshot",
      libraryId: c.library.library_id,
      scope: catalog.scope,
      coverage: "complete",
      verifiedAt: catalog.fetched_at,
      fetched_at: catalog.fetched_at,
      records: catalog.records,
    })
    expect(await readCandidateSnapshot(local)).toEqual(first)
    expect(c.source.requests).toHaveLength(before)
    expect(c.source.requests.some((row: { path: string }) => /markdown|views/.test(row.path))).toBe(
      false,
    )
    expect(
      await readCandidateSnapshot({
        ...local,
        env: { ...local.env, NOTION_API_TOKEN: "different-credential" },
      }),
    ).toMatchObject({ kind: "miss", reason: "scope_unavailable" })
    expect(await readCandidateSnapshot({ ...local, library: currentId(999) })).toMatchObject({
      kind: "miss",
      reason: "catalog_unavailable",
    })
    expect(c.source.requests).toHaveLength(before)
    for (const report of reports) expect(report).toMatchObject({ total_requests: 0, trace: [] })
  } finally {
    await finish(c)
  }
}, 30_000)

test("partial refresh retains the last complete directory and exact rejections until complete-empty replacement", async () => {
  const c = await controlled()
  try {
    const first = await listCatalog({ ...c.options, refresh: true })
    const added = structuredClone(c.source.notion.skills[1])
    added.id = currentId(9900)
    property(added.properties).skill_id = currentRich("skill_id", "added")
    property(added.properties).main_file_id = currentRich("main_file_id", "main-added")
    property(added.properties).title = {
      id: "title",
      type: "title",
      title: [{ plain_text: "added" }],
    }
    c.source.notion.skills.push(added)
    property(c.source.notion.skills[1].properties).description = currentRich(
      "description",
      "x".repeat(2001),
    )
    const partial = await listCatalog({ ...c.options, refresh: true })
    expect(partial.coverage.exhaustive).toBe(false)
    const retained = await readCandidateSnapshot(c.options)
    expect(retained).toMatchObject({
      kind: "snapshot",
      coverage: "partial",
      stale: true,
      verifiedAt: first.fetched_at,
    })
    if (retained.kind !== "snapshot") throw new Error("Expected retained local directory")
    expect(retained.records.map((record) => record.name)).toEqual(["a", "added"])
    expect(retained.denials).toContainEqual(
      expect.objectContaining({ kind: "physical", identity: c.f.pageIds[1], code: "unavailable" }),
    )
    property(c.source.notion.skills[0].properties).enabled = {
      id: "enabled",
      type: "checkbox",
      checkbox: false,
    }
    await listCatalog({ ...c.options, refresh: true })
    c.source.notion.skills.shift()
    await listCatalog({ ...c.options, refresh: true })
    const denied = await readCandidateSnapshot(c.options)
    if (denied.kind !== "snapshot") throw new Error("Expected partial local directory")
    expect(denied.records.map((record) => record.name)).toEqual(["added"])
    expect(denied.denials).toContainEqual(
      expect.objectContaining({ identity: c.f.pageIds[0], code: "disabled" }),
    )
    c.source.notion.skills = []
    const empty = await listCatalog({ ...c.options, refresh: true })
    expect(empty.coverage.exhaustive).toBe(true)
    expect(await readCandidateSnapshot(c.options)).toMatchObject({
      kind: "snapshot",
      coverage: "complete",
      records: [],
      verifiedAt: empty.fetched_at,
    })
  } finally {
    await finish(c)
  }
}, 30_000)

test("public exact and scope authorization rejections suppress stale candidates without changing other records", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    const first = catalog.records.find((record) => record.name === "a")!
    c.source.setPhase("physical-denied", { denyCurrent: true })
    await expect(readSkill(first.ref, { ...c.options, refresh: true })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    })
    const local = await readCandidateSnapshot(c.options)
    if (local.kind !== "snapshot") throw new Error("Expected other candidates to remain visible")
    expect(local.records.map((record) => record.name)).toEqual(["leaf-0"])
    expect(local.denials).toContainEqual(
      expect.objectContaining({
        kind: "record",
        identity: first.id,
        code: "ACCESS_DENIED",
      }),
    )
    await expect(readSkill(c.f.pageIds[0]!, { ...c.options, refresh: true })).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    )
    const physical = await readCandidateSnapshot(c.options)
    if (physical.kind !== "snapshot")
      throw new Error("Expected exact physical denial to remain scoped")
    expect(physical.denials).toContainEqual(
      expect.objectContaining({
        kind: "physical",
        identity: c.f.pageIds[0],
        code: "ACCESS_DENIED",
      }),
    )
    c.source.setPhase("scope-denied", { denyAuthentication: true })
    await expect(listCatalog({ ...c.options, refresh: true })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    })
    expect(await readCandidateSnapshot(c.options)).toMatchObject({
      kind: "blocked",
      libraryId: c.library.library_id,
      scope: catalog.scope,
    })
    c.source.setPhase("restored", { denyAuthentication: false, denyCurrent: false })
    await listCatalog({ ...c.options, refresh: true })
    const metadataOnly = await readCandidateSnapshot(c.options)
    if (metadataOnly.kind !== "snapshot") throw new Error("Expected scope recovery")
    expect(metadataOnly.records.map((record) => record.name)).toEqual(["leaf-0"])
    await readSkill(first.ref, { ...c.options, refresh: true })
    const restored = await readCandidateSnapshot(c.options)
    if (restored.kind !== "snapshot") throw new Error("Expected exact authority recovery")
    expect(restored.records.map((record) => record.name)).toEqual(["a", "leaf-0"])
  } finally {
    await finish(c)
  }
}, 30_000)

test("SQLite publication preserves complete facts through newer failure and rejects late old generations", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    await runLocalRuntimeOperation(
      () =>
        Effect.gen(function* () {
          const store = yield* Store
          const keys = yield* store.listKeys(`cache/catalogs/${catalog.scope}`)
          const key = keys[0]!
          const identity =
            "catalog-" +
            key
              .split("/")
              .at(-1)!
              .replace(/\.json$/, "")
          const old = yield* store.reserveCacheGeneration(catalog.scope, identity)
          const newer = yield* store.reserveCacheGeneration(catalog.scope, identity)
          const original = yield* store.readJson(key, CatalogObservationSchema)
          if (original === undefined) throw new Error("Actual online catalog was not persisted")
          yield* store.writeJson(key, {
            ...original,
            records: [],
            coverage: { ...original.coverage, exhaustive: false },
            generation: newer,
            invalidated: true,
            last_failure: {
              code: "NOTION_REQUEST_FAILED",
              observed_at: original.fetched_at + 1000,
            },
          })
          yield* store.writeJson(key, { ...original, records: [], generation: old })
        }),
      c.options,
    )
    const after = await readCandidateSnapshot(c.options)
    expect(after).toMatchObject({
      kind: "snapshot",
      verifiedAt: catalog.fetched_at,
      stale: true,
      coverage: "partial",
      records: catalog.records,
      lastFailure: { code: "NOTION_REQUEST_FAILED" },
    })
    expect(c.source.requests.some((row: { path: string }) => row.path.endsWith("/markdown"))).toBe(
      false,
    )
  } finally {
    await finish(c)
  }
}, 30_000)

test("local snapshot rejects corrupt cached identities without remote repair", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    const requests = c.source.requests.length
    await runLocalRuntimeOperation(
      () =>
        Effect.gen(function* () {
          const store = yield* Store
          const key = (yield* store.listKeys(`cache/catalogs/${catalog.scope}`))[0]!
          const identity =
            "catalog-" +
            key
              .split("/")
              .at(-1)!
              .replace(/\.json$/, "")
          const generation = yield* store.reserveCacheGeneration(catalog.scope, identity)
          const original = yield* store.readJson(key, CatalogObservationSchema)
          if (original === undefined) throw new Error("Actual online catalog was not persisted")
          const records = original.records.map((record, index) =>
            index === 0
              ? { ...record, id: "skill://wrong?library=" + c.library.library_id }
              : record,
          )
          yield* store.writeJson(key, { ...original, generation, records })
        }),
      c.options,
    )
    await expect(readCandidateSnapshot(c.options)).rejects.toMatchObject({ code: "STATE_CORRUPT" })
    expect(c.source.requests).toHaveLength(requests)
  } finally {
    await finish(c)
  }
}, 30_000)
