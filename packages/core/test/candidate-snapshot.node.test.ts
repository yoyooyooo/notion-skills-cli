import { sourceMemberCacheKey } from "../src/shared-source-materialization-state.ts"
import { mkdtemp, realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, test } from "vitest"
import {
  CANDIDATE_SNAPSHOT_CONTRACT_VERSION,
  listCatalog,
  discoverSourceMembers,
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

test("unrelated stored identities cannot break a selected Library while its own corrupt observation still fails", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    const before = await readCandidateSnapshot(c.options)
    const requests = c.source.requests.length
    const database = new DatabaseSync(join(c.options.env.NTN_SKILLS_HOME, "state.sqlite"))
    const insert = (segment: string, identity: string) => {
      const key = `cache/latest/${catalog.scope}/${segment}/stored-observation.json`
      const observation = {
        record_identity: identity,
        scope: catalog.scope,
        started_at: catalog.fetched_at,
        validated_at: catalog.fetched_at,
        invalidated: true,
        generation: 1,
        access_denied: "ACCESS_DENIED",
      }
      database
        .prepare(
          "INSERT INTO observations(id,scope,record_identity,generation,validated_at,payload) VALUES(?,?,?,?,?,?)",
        )
        .run(key, catalog.scope, identity, 1, catalog.fetched_at, JSON.stringify(observation))
    }
    try {
      // A real daily Store retained older, unselected Library addresses. The
      // current selection must not decode or reinterpret those identities.
      const unrelated = `shared_skill:library-${currentId(999)}:unselected`
      insert(unrelated, unrelated)
      expect(await readCandidateSnapshot(c.options)).toEqual(before)
      const selected = catalog.records[0]!.id
      insert(encodeURIComponent(selected), "different-selected-identity")
      await expect(readCandidateSnapshot(c.options)).rejects.toMatchObject({
        code: "STATE_CORRUPT",
      })
      expect(c.source.requests).toHaveLength(requests)
    } finally {
      database.close()
    }
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

test("actual SDK Source discovery and local candidate snapshots share the registered SQLite cache domain", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    expect(await discoverSourceMembers({ library: c.library.library_id }, c.options)).toMatchObject(
      { coverage: "complete", candidates: [], effects: { remote_writes: "none" } },
    )
    const candidate = {
      type: "source_member" as const,
      library_id: c.library.library_id,
      scope: catalog.scope,
      source_id: "registered-source",
      member_key: "skills/first-use",
      expected_skill_id: "first-use",
      registration_digest: "b".repeat(64),
      name: "First use",
      alias: "first-use",
      description: "Registered, not yet imported",
      enabled: true,
      readiness: "materializable" as const,
    }
    await runLocalRuntimeOperation(
      () =>
        Effect.flatMap(Store, (store) =>
          store.writeJson(sourceMemberCacheKey(catalog.scope, c.library.library_id), {
            version: 2,
            library_id: c.library.library_id,
            scope: catalog.scope,
            candidates: [candidate],
          }),
        ),
      c.options,
    )
    const requests = c.source.requests.length
    expect(await readCandidateSnapshot(c.options)).toMatchObject({
      kind: "snapshot",
      source_members: [candidate],
    })
    expect(
      await readCandidateSnapshot({
        ...c.options,
        env: { ...c.options.env, NOTION_API_TOKEN: "another-client-credential" },
      }),
    ).toMatchObject({ kind: "miss", reason: "scope_unavailable" })
    expect(c.source.requests).toHaveLength(requests)
  } finally {
    await finish(c)
  }
}, 30_000)

test("versioned candidate slots preserve legacy readers and reject crossed address or scope", async () => {
  const c = await controlled()
  try {
    const catalog = await listCatalog({ ...c.options, refresh: true })
    const candidate = {
      type: "source_member" as const,
      library_id: c.library.library_id,
      scope: catalog.scope,
      source_id: "registered-source",
      member_key: "skills/patched",
      expected_skill_id: "patched",
      registration_digest: "a".repeat(64),
      name: "Patched",
      alias: "patched",
      description: "Legacy transformation",
      enabled: true,
      readiness: "materializable" as const,
    }
    const legacyKey = `cache/source-members/${catalog.scope}/${c.library.library_id}.json`
    const currentKey = sourceMemberCacheKey(catalog.scope, c.library.library_id)
    const legacy = {
      version: 1,
      library_id: c.library.library_id,
      scope: catalog.scope,
      candidates: [candidate],
    }
    const current = {
      ...legacy,
      version: 2,
      candidates: [
        { ...candidate, readiness: "blocked", reason: "CURRENT_SOURCE_WRITE_UNSUPPORTED" },
      ],
    }
    const write = (key: string, value: unknown) =>
      runLocalRuntimeOperation(
        () => Effect.flatMap(Store, (store) => store.writeJson(key, value)),
        c.options,
      )
    await write(legacyKey, legacy)
    const requests = c.source.requests.length
    expect(await readCandidateSnapshot(c.options)).toMatchObject({
      kind: "snapshot",
      source_members: [],
    })
    await write(currentKey, current)
    expect(await readCandidateSnapshot(c.options)).toMatchObject({
      kind: "snapshot",
      records: catalog.records,
      source_members: current.candidates,
    })
    const database = new DatabaseSync(join(c.options.env.NTN_SKILLS_HOME, "state.sqlite"), {
      readOnly: true,
    })
    try {
      const persisted = (key: string) =>
        JSON.parse(
          String(
            database
              .prepare("SELECT payload FROM shared_local_records WHERE key = ? AND retired = 0")
              .get(key)?.payload,
          ),
        )
      expect(persisted(legacyKey)).toEqual(legacy)
      expect(persisted(currentKey)).toEqual(current)
    } finally {
      database.close()
    }
    for (const [key, value] of [
      [legacyKey, current],
      [currentKey, legacy],
      [currentKey, { ...current, scope: "b".repeat(64) }],
    ] as const)
      await expect(write(key, value)).rejects.toMatchObject({ code: "STATE_CONFLICT" })
    await expect(write(currentKey, { ...current, version: 3 })).rejects.toMatchObject({
      code: "STATE_CORRUPT",
    })
    expect(
      await readCandidateSnapshot({
        ...c.options,
        env: { ...c.options.env, NOTION_API_TOKEN: "foreign-candidate-reader" },
      }),
    ).toMatchObject({ kind: "miss", reason: "scope_unavailable" })
    expect(c.source.requests).toHaveLength(requests)
  } finally {
    await finish(c)
  }
}, 30_000)
