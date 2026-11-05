import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Clock, Effect, Fiber, Layer } from "effect"
import { decode, fail, type SkillsError, type Snapshot } from "../src/model.ts"
import { Store, sha256, configuration, setToken } from "../src/store.ts"
import { catalog } from "../src/catalog.ts"
import { Notion } from "../src/notion.ts"
import { openSkill, readSkill, listSkill, targetSnapshot, snapshotInfo } from "../src/snapshot.ts"
import { exportSkill, snapshotPortable } from "../src/export.ts"
import { parseTarget } from "../src/ref.ts"
import {
  cacheStatus,
  clearCache,
  configureCachePolicy,
  clearCachePolicy,
  cachedRemoteObservation,
  invalidateSnapshotCache,
  parseDuration,
  publishSnapshotObservation,
  reserveScopeAccess,
  recordScopeAccess,
} from "../src/cache.ts"

const page = "11111111-1111-4111-8111-111111111111"
const database = "44444444-4444-4444-8444-444444444444"
const guide = "22222222-2222-4222-8222-222222222222"
const other = "33333333-3333-4333-8333-333333333333"
function fixture() {
  let now = 1_000_000
  let credential = "credential-one"
  let denied:
    | {
        readonly code: "ACCESS_DENIED" | "AUTH_REQUIRED" | "NOT_FOUND" | "NOTION_UNAVAILABLE"
        readonly path?: string
      }
    | undefined
  let paused: { readonly path: string; readonly started: () => void } | undefined
  let body = "Original reference."
  let name = "Sample Skill"
  let decoy = false
  let additional = false
  let failReference = false
  let defaultContext = false
  const requests: string[] = []
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const generations = new Map<string, number>()
  const retired: string[] = []
  const properties = (recordName = name) => ({
    Name: { id: "title", type: "title", title: [{ plain_text: recordName }] },
    Description: { type: "rich_text", rich_text: [{ plain_text: "Use when testing cache." }] },
    References: { id: "references", type: "rich_text", rich_text: [] },
    "Default Context": { type: "checkbox", checkbox: defaultContext },
  })
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: "/state",
    configRoot: "/config",
    cacheRoot: "/cache",
    reserveCacheGeneration: (scope, id) =>
      Effect.sync(() => {
        const key = `${scope}/${id}`
        const next = (generations.get(key) ?? 0) + 1
        generations.set(key, next)
        return next
      }),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix + "/"))),
    retireKeys: (keys) =>
      Effect.try({
        try: () => {
          if (keys.some((key) => !key.startsWith("cache/")))
            throw fail("INVALID_ARGUMENT", "Only cache may be retired.")
          for (const key of keys) {
            json.delete(key)
            retired.push(key)
          }
          return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
        },
        catch: (error) => error as SkillsError,
      }),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, json.get(key)) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid fixture state."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, value)
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object.")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: (destination, bytes) =>
      Effect.sync(() => {
        objects.set(`output/${destination}`, bytes)
        return { output: destination, reused: false }
      }),
  })
  const api = Layer.succeed(Notion, {
    credentialIdentity: Effect.sync(() => credential),
    version: Effect.succeed("fixture"),
    request: (path) =>
      Effect.gen(function* () {
        requests.push(path)
        if (paused?.path === path) {
          paused.started()
          yield* Effect.never
        }
        if (denied && (denied.path === undefined || denied.path === path))
          return yield* Effect.fail(fail(denied.code, "Denied."))
        if (path === "v1/users/me") return { id: "user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: properties() }
        if (path === "v1/search")
          return {
            results: [
              {
                id: "ds",
                parent: { database_id: database },
                title: [],
                database_type: null,
                properties: properties(),
              },
            ],
            has_more: false,
            next_cursor: null,
          }
        if (path === "v1/data_sources/ds/query")
          return {
            results: [
              { id: page, properties: properties() },
              ...(additional ? [{ id: other, properties: properties("Other Skill") }] : []),
              ...(decoy
                ? [{ id: "33333333-3333-4333-8333-333333333333", properties: properties() }]
                : []),
            ],
            has_more: false,
            next_cursor: null,
          }
        if (path === `v1/pages/${page}`)
          return {
            id: page,
            parent: { database_id: database, data_source_id: "ds" },
            properties: properties(),
          }
        if (additional && path === `v1/pages/${other}`)
          return {
            id: other,
            parent: { database_id: database, data_source_id: "ds" },
            properties: properties("Other Skill"),
          }
        if (path === `v1/pages/${guide}`)
          return {
            id: guide,
            properties: { title: { type: "title", title: [{ plain_text: "Guide" }] } },
          }
        if (path.includes("/properties/references"))
          return {
            object: "list",
            results: [
              {
                object: "property_item",
                rich_text: {
                  type: "mention",
                  plain_text: "Guide",
                  mention: { type: "page", page: { id: guide } },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }
        if (
          path === `v1/blocks/${page}/children?page_size=100` ||
          path === `v1/blocks/${guide}/children?page_size=100` ||
          (additional && path === `v1/blocks/${other}/children?page_size=100`)
        )
          return { object: "list", results: [], has_more: false, next_cursor: null }
        if (
          path === `v1/pages/${page}/markdown` ||
          (additional && path === `v1/pages/${other}/markdown`)
        )
          return {
            object: "page_markdown",
            markdown: "Main body.",
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === `v1/pages/${guide}/markdown`) {
          if (failReference) return yield* Effect.fail(fail("ACCESS_DENIED", "Reference missing."))
          return {
            object: "page_markdown",
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected provider request.", { path }))
      }),
  })
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  }
  const layer = Layer.mergeAll(NodeServices.layer, store, api)
  return {
    requests,
    json,
    objects,
    retired,
    generations,
    defaultContext: (value: boolean) => {
      defaultContext = value
    },
    time: (value: number) => {
      now = value
    },
    deny: (
      code:
        | "ACCESS_DENIED"
        | "AUTH_REQUIRED"
        | "NOT_FOUND"
        | "NOTION_UNAVAILABLE" = "ACCESS_DENIED",
      path?: string,
    ) => {
      denied = { code, path }
    },
    allow: () => {
      denied = undefined
    },
    addOther: () => {
      additional = true
    },
    pause: (path: string) =>
      new Promise<void>((started) => {
        paused = { path, started }
      }),
    change: (value: string) => {
      body = value
    },
    rename: (value: string) => {
      name = value
    },
    duplicate: () => {
      decoy = true
    },
    incomplete: () => {
      failReference = true
    },
    credential: (value: string) => {
      credential = value
    },
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(layer),
          Effect.provideService(Clock.Clock, clock),
        ) as Effect.Effect<A, E>,
      ),
  }
}

test("C1/C3 warm complete reads add zero requests without moving validation or persistent sync state", async () => {
  const f = fixture()
  f.json.set("sync/baselines/b.json", { generation: 7 })
  const first = await f.run(readSkill(page))
  const requests = f.requests.length
  for (const time of [1_000_010, 1_030_000, 1_299_999]) {
    f.time(time)
    const warm = await f.run(readSkill(page))
    expect(warm.snapshot_id).toBe(first.snapshot_id)
    expect(warm.source).toBe("local_cache")
    expect(warm.freshness?.validated_at).toBe(first.freshness?.validated_at)
  }
  expect(f.requests.length).toBe(requests)
  expect(f.json.get("sync/baselines/b.json")).toEqual({ generation: 7 })
})

for (const [offset, online] of [
  [299_999, false],
  [300_000, true],
  [300_001, true],
  [-1, true],
] as const) {
  test(`C2/C3 exact age ${offset} validates online=${online}`, async () => {
    const f = fixture()
    await f.run(readSkill(page))
    const before = f.requests.length
    f.time(1_000_000 + offset)
    const result = await f.run(readSkill(page))
    expect(result.source).toBe(online ? "notion" : "local_cache")
    expect(f.requests.length > before).toBe(online)
  })
}

test("C4/C5 strong refresh sees reference-only changes; same version reuses immutable manifest", async () => {
  const f = fixture()
  const first = await f.run(readSkill(page, { path: "references/guide.md" }))
  f.change("Changed reference.")
  expect((await f.run(readSkill(page, { path: "references/guide.md" }))).snapshot_id).toBe(
    first.snapshot_id,
  )
  f.time(1_000_100)
  const fresh = await f.run(readSkill(page, { refresh: true, path: "references/guide.md" }))
  expect("content" in fresh && fresh.content).toBe("Changed reference.")
  expect(fresh.snapshot_id).not.toBe(first.snapshot_id)
  const manifests = [...f.json.keys()].filter((key) => key.startsWith("snapshots/"))
  const objects = f.objects.size
  f.time(1_000_200)
  const same = await f.run(readSkill(page, { refresh: true }))
  expect(same.snapshot_id).toBe(fresh.snapshot_id)
  expect(same.freshness?.validated_at).not.toBe(fresh.freshness?.validated_at)
  expect([...f.json.keys()].filter((key) => key.startsWith("snapshots/"))).toEqual(manifests)
  expect(f.objects.size).toBe(objects)
})

for (const marker of [undefined, "references-v3"]) {
  test(`prior materialization ${marker ?? "missing marker"} refreshes identity while preserving pinned bytes`, async () => {
    const f = fixture()
    const current = await f.run(openSkill(page))
    const oldVersion = await f.run(
      sha256(
        JSON.stringify([
          "references-v3",
          "skill",
          "SKILL.md",
          [],
          "Sample Skill",
          "Use when testing cache.",
          [
            {
              type: "mention",
              plain_text: "Guide",
              mention: { type: "page", page: { id: guide } },
            },
          ],
          [
            { id: page, path: "SKILL.md", markdown: "Main body." },
            { id: guide, path: "references/guide.md", markdown: "Original reference." },
          ],
          [],
        ]),
      ),
    )
    const oldId = `s_${await f.run(sha256(JSON.stringify([current.scope, current.record.id, oldVersion])))}`
    const oldBytes = new TextEncoder().encode("---\nname: sample-skill\n---\nMain body.")
    const oldHash = await f.run(sha256(oldBytes))
    f.objects.set(`objects/${oldHash}`, oldBytes)
    const old: Snapshot = {
      ...current,
      snapshot_id: oldId,
      version_id: oldVersion,
      files: current.files.map((file) =>
        file.path === current.entrypoint
          ? { path: file.path, bytes: oldBytes.length, sha256: oldHash }
          : file,
      ),
    }
    // Leave only the structurally valid prior-generation snapshot and current pointer.
    f.json.delete(`snapshots/${current.snapshot_id}.json`)
    f.json.set(`snapshots/${oldId}.json`, old)
    for (const [key, value] of f.json) {
      if (!key.startsWith("cache/latest/")) continue
      f.json.set(key, { ...(value as object), snapshot_id: oldId, materialization_version: marker })
    }
    const before = f.requests.length
    const offline = await f.run(readSkill(page, { offline: true }).pipe(Effect.result))
    expect(offline._tag === "Failure" && offline.failure.code).toBe("CACHE_REFRESH_REQUIRED")
    expect(f.requests.length).toBe(before)
    const refreshed = await f.run(readSkill(page, { refresh: true }))
    expect(refreshed.snapshot_id).not.toBe(oldId)
    expect(refreshed.snapshot_id).toBe(current.snapshot_id)
    expect("content" in refreshed && refreshed.content).toContain('"name": "Sample Skill"')
    const pinned = await f.run(readSkill(oldId))
    expect("content" in pinned && pinned.content).toBe(new TextDecoder().decode(oldBytes))
    expect(f.json.get(`snapshots/${oldId}.json`)).toEqual(old)
    const count = f.requests.length
    expect((await f.run(readSkill(page))).snapshot_id).toBe(refreshed.snapshot_id)
    expect(f.requests.length).toBe(count)
    expect((await f.run(readSkill(page, { refresh: true }))).snapshot_id).toBe(
      refreshed.snapshot_id,
    )
    // Online selection must also bypass a prior-generation pointer while it is within its TTL.
    for (const [key, value] of f.json) {
      if (!key.startsWith("cache/latest/")) continue
      f.json.set(key, { ...(value as object), snapshot_id: oldId, materialization_version: marker })
    }
    const onlineBefore = f.requests.length
    expect((await f.run(readSkill(page))).snapshot_id).toBe(refreshed.snapshot_id)
    expect(f.requests.length).toBeGreaterThan(onlineBefore)
  })
}

test("C6/C7 failed expiry has no stale fallback or timestamp reset; explicit offline remains an observation", async () => {
  const f = fixture()
  const first = await f.run(readSkill(page))
  f.time(1_300_000)
  f.deny()
  const failure = await f.run(readSkill(page).pipe(Effect.result))
  expect(failure._tag === "Failure" && failure.failure.code).toBe("ACCESS_DENIED")
  const before = f.requests.length
  const offline = await f.run(readSkill(page, { offline: true }))
  expect(offline.source).toBe("local_cache")
  expect(offline.freshness).toMatchObject({
    stale: true,
    age_ms: 300_000,
    validated_at: first.freshness?.validated_at,
  })
  expect(f.requests.length).toBe(before)
})

test("C8 credential scopes isolate cache and a new credential requires online validation", async () => {
  const f = fixture()
  await f.run(readSkill(page))
  const originalIdentity = await f.run(
    sha256(JSON.stringify(["credential-one", "", "https://api.notion.com"])),
  )
  expect(f.json.has(`cache/identities/${originalIdentity}.json`)).toBe(true)
  f.credential("credential-two")
  expect((await f.run(readSkill(page, { offline: true }).pipe(Effect.result)))._tag).toBe("Failure")
  const second = await f.run(readSkill(page))
  expect(second.source).toBe("notion")
  f.credential("credential-one")
  const before = f.requests.length
  expect((await f.run(readSkill(page))).source).toBe("local_cache")
  expect(f.requests.length).toBe(before)
  f.credential("credential-without-recorded-scope")
  expect((await f.run(readSkill(page, { offline: true }).pipe(Effect.result)))._tag).toBe("Failure")
  const requests = f.requests.length
  await f.run(readSkill(page))
  expect(f.requests.length).toBeGreaterThan(requests)
})

for (const target of [page, "sample-skill"])
  for (const code of ["ACCESS_DENIED", "AUTH_REQUIRED", "NOT_FOUND"] as const)
    test(`SC12 ${code} during refresh fences current ${target} without changing old pins`, async () => {
      const f = fixture()
      const first = await f.run(readSkill(target, { database }))
      const manifest = f.json.get(`snapshots/${first.snapshot_id}.json`)
      f.time(1_000_100)
      f.deny(code, code === "AUTH_REQUIRED" ? "v1/users/me" : `v1/pages/${page}/markdown`)
      const refresh = await f.run(
        readSkill(target, { database, refresh: true }).pipe(Effect.result),
      )
      expect(refresh._tag === "Failure" && refresh.failure.code).toBe(code)
      const current = await f.run(readSkill(target, { database }).pipe(Effect.result))
      expect(current._tag === "Failure" && current.failure.code).toBe(code)
      if (code === "ACCESS_DENIED" || code === "AUTH_REQUIRED") {
        const fixed = await f.run(readSkill(first.ref).pipe(Effect.result))
        expect(fixed._tag === "Failure" && fixed.failure.code).toBe(code)
        const resource = await f.run(
          readSkill("references/guide.md", { from: first.ref }).pipe(Effect.result),
        )
        expect(resource._tag === "Failure" && resource.failure.code).toBe(code)
      }
      const before = f.requests.length
      const offline = await f.run(readSkill(target, { database, offline: true }))
      expect(offline.snapshot_id).toBe(first.snapshot_id)
      expect(offline.freshness).toMatchObject({
        policy: "offline",
        stale: true,
        age_ms: 100,
        validated_at: first.freshness?.validated_at,
      })
      const pinned = await f.run(readSkill(first.ref, { offline: true }))
      expect(pinned.snapshot_id).toBe(first.snapshot_id)
      expect(pinned.freshness?.policy).toBe("pinned")
      if (code !== "NOT_FOUND") expect(pinned.freshness?.stale).toBe(true)
      expect(f.requests.length).toBe(before)
      expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(manifest)
      f.allow()
      const recovered = await f.run(readSkill(target, { database }))
      expect(recovered.source).toBe("notion")
      expect(recovered.freshness).toMatchObject({ stale: false, age_ms: 0 })
      const after = f.requests.length
      expect(after).toBeGreaterThan(before)
      expect((await f.run(readSkill(target, { database }))).source).toBe("local_cache")
      expect(f.requests.length).toBe(after)
    })

for (const entry of ["current", "catalog", "current-body"] as const)
  test(`SC12 authentication rejection from ${entry} fences another current binding and directory in the same scope`, async () => {
    const f = fixture()
    f.addOther()
    const first = await f.run(readSkill(page, { database }))
    const second = await f.run(readSkill(other, { database }))
    const directory = await f.run(catalog({ database }))
    f.credential("credential-two")
    const otherCredential = await f.run(readSkill(other, { database }))
    f.credential("credential-one")
    f.time(1_000_100)
    f.deny("AUTH_REQUIRED", entry === "current-body" ? `v1/pages/${page}/markdown` : "v1/users/me")
    const denied = await f.run(
      (entry === "catalog"
        ? catalog({ database, refresh: true }).pipe(Effect.asVoid)
        : readSkill(page, { database, refresh: true }).pipe(Effect.asVoid)
      ).pipe(Effect.result),
    )
    expect(denied._tag === "Failure" && denied.failure.code).toBe("AUTH_REQUIRED")
    if (entry === "current-body") f.deny("AUTH_REQUIRED", "v1/users/me")
    const unrelated = await f.run(readSkill(other, { database }).pipe(Effect.result))
    expect(unrelated._tag === "Failure" && unrelated.failure.code).toBe("AUTH_REQUIRED")
    const listed = await f.run(catalog({ database }).pipe(Effect.result))
    expect(listed._tag === "Failure" && listed.failure.code).toBe("AUTH_REQUIRED")
    const before = f.requests.length
    const offline = await f.run(readSkill("other-skill", { database, offline: true }))
    expect(offline.snapshot_id).toBe(second.snapshot_id)
    expect(offline.freshness).toMatchObject({
      validated_at: second.freshness?.validated_at,
      age_ms: 100,
      stale: true,
    })
    const oldDirectory = await f.run(catalog({ database, offline: true }))
    expect(oldDirectory.fetched_at).toBe(directory.fetched_at)
    expect(oldDirectory.freshness.stale).toBe(true)
    expect((await f.run(readSkill(first.ref, { offline: true }))).snapshot_id).toBe(
      first.snapshot_id,
    )
    expect(f.requests.length).toBe(before)
    f.credential("credential-two")
    expect((await f.run(readSkill(other, { database }))).snapshot_id).toBe(
      otherCredential.snapshot_id,
    )
    expect(f.requests.length).toBe(before)
    f.credential("credential-one")
    f.allow()
    expect((await f.run(readSkill(other, { database }))).source).toBe("notion")
    expect((await f.run(readSkill(page, { database }))).source).toBe("notion")
  })

for (const code of ["ACCESS_DENIED", "NOT_FOUND"] as const)
  test(`SC12 page ${code} does not revoke a different fresh binding`, async () => {
    const f = fixture()
    f.addOther()
    await f.run(readSkill(page, { database }))
    const second = await f.run(readSkill(other, { database }))
    f.deny(code, `v1/pages/${page}/markdown`)
    const denied = await f.run(readSkill(page, { database, refresh: true }).pipe(Effect.result))
    expect(denied._tag === "Failure" && denied.failure.code).toBe(code)
    const before = f.requests.length
    const unaffected = await f.run(readSkill(other, { database }))
    expect(unaffected.source).toBe("local_cache")
    expect(unaffected.snapshot_id).toBe(second.snapshot_id)
    expect(f.requests.length).toBe(before)
  })

test("SC12 scope rejection reaches an old pin with no current observation", async () => {
  const f = fixture()
  f.addOther()
  await f.run(readSkill(page, { database }))
  const old = await f.run(readSkill(other, { database }))
  for (const key of f.json.keys()) if (key.includes(`/notion_page:${other}/`)) f.json.delete(key)
  f.deny("AUTH_REQUIRED", "v1/users/me")
  await f.run(readSkill(page, { database, refresh: true }).pipe(Effect.result))
  const denied = await f.run(readSkill(old.ref).pipe(Effect.result))
  expect(denied._tag === "Failure" && denied.failure.code).toBe("AUTH_REQUIRED")
  const before = f.requests.length
  const offline = await f.run(readSkill(old.ref, { offline: true }))
  expect(offline.snapshot_id).toBe(old.snapshot_id)
  expect(offline.freshness).toMatchObject({ policy: "pinned", stale: true })
  expect(f.requests.length).toBe(before)
  f.allow()
  await f.run(readSkill(page, { database, refresh: true }))
  const validated = f.requests.length
  expect((await f.run(readSkill(old.ref))).snapshot_id).toBe(old.snapshot_id)
  expect(f.requests.length).toBe(validated)
})

test("SC12 transient network failure does not manufacture a permission rejection or a newer validation", async () => {
  const f = fixture()
  const first = await f.run(readSkill(page))
  f.time(1_000_100)
  f.deny("NOTION_UNAVAILABLE", "v1/users/me")
  const failure = await f.run(readSkill(page, { refresh: true }).pipe(Effect.result))
  expect(failure._tag === "Failure" && failure.failure.code).toBe("NOTION_UNAVAILABLE")
  const before = f.requests.length
  const warm = await f.run(readSkill(page))
  expect(warm.source).toBe("local_cache")
  expect(warm.freshness).toMatchObject({ validated_at: first.freshness?.validated_at, age_ms: 100 })
  expect(f.requests.length).toBe(before)
})

test("SC12 cancelling an in-flight refresh neither publishes nor marks the old observation denied", async () => {
  const f = fixture()
  const first = await f.run(readSkill(page))
  const before = [...f.json].filter(([key]) => key.startsWith("cache/latest/"))
  const started = f.pause(`v1/pages/${page}/markdown`)
  await f.run(
    Effect.gen(function* () {
      const reading = yield* readSkill(page, { refresh: true }).pipe(Effect.forkChild)
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(reading)
    }).pipe(Effect.scoped),
  )
  const requests = f.requests.length
  const warm = await f.run(readSkill(page))
  expect(warm.source).toBe("local_cache")
  expect(warm.snapshot_id).toBe(first.snapshot_id)
  expect(warm.freshness?.validated_at).toBe(first.freshness?.validated_at)
  expect([...f.json].filter(([key]) => key.startsWith("cache/latest/"))).toEqual(before)
  expect(f.requests.length).toBe(requests)
})

test("C9 current name selection uses complete scoped catalogs and refresh exposes ambiguity", async () => {
  const f = fixture()
  await f.run(readSkill("sample-skill", { database }))
  const before = f.requests.length
  expect((await f.run(readSkill("sample-skill", { database, offline: true }))).source).toBe(
    "local_cache",
  )
  expect(f.requests.length).toBe(before)
  f.duplicate()
  const result = await f.run(
    readSkill("sample-skill", { database, refresh: true }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("SKILL_AMBIGUOUS")
  expect((await f.run(readSkill(page, { refresh: true }))).record.id).toBe(`notion_page:${page}`)
})

test("C10 files lists the fixed manifest while selected reads and full exports reject corrupted objects", async () => {
  const f = fixture()
  const snapshot = await f.run(openSkill(page))
  const ref = snapshot.files.find((file) => file.path === "references/guide.md")!
  f.objects.set(`objects/${ref.sha256}`, new TextEncoder().encode("corrupt"))
  const before = f.requests.length
  const pinned = await f.run(listSkill(snapshot.snapshot_id))
  expect(pinned.files.map((file) => file.path)).toEqual(snapshot.files.map((file) => file.path))
  const selected = await f.run(
    readSkill(snapshot.snapshot_id, { path: ref.path }).pipe(Effect.result),
  )
  expect(selected._tag === "Failure" && selected.failure.code).toBe("STATE_CORRUPT")
  const complete = await f.run(cachedRemoteObservation(page, snapshot.scope).pipe(Effect.result))
  expect(complete._tag === "Failure" && complete.failure.code).toBe("STATE_CORRUPT")
  const exported = await f.run(snapshotPortable(snapshot).pipe(Effect.result))
  expect(exported._tag === "Failure" && exported.failure.code).toBe("STATE_CORRUPT")
  expect(f.requests.length).toBe(before)
  const rebuilt = await f.run(readSkill(page))
  expect(rebuilt.source).toBe("notion")
  const portable = await f.run(snapshotPortable(await f.run(openSkill(page))))
  expect(portable.files.map((file) => file.path)).toContain("references/guide.md")
})

test("C11/C16 empty new cache never adopts old state catalogs or alters baselines/pinned versions", async () => {
  const f = fixture()
  const snapshot = await f.run(openSkill(page))
  f.json.set("catalogs/legacy.json", { fetched_at: 1_000_000 })
  f.json.set("sync/baselines/b.json", { generation: 3 })
  await f.run(clearCache(undefined, { all: true }))
  const pinned = await f.run(readSkill(snapshot.snapshot_id))
  expect(pinned.source).toBe("local_snapshot")
  expect(pinned.freshness).toEqual({ policy: "pinned" })
  const before = f.requests.length
  await f.run(readSkill(page))
  expect(f.requests.length).toBeGreaterThan(before)
  expect(f.json.get("sync/baselines/b.json")).toEqual({ generation: 3 })
  expect(f.json.has("catalogs/legacy.json")).toBe(true)
})

test("C12/C13 strong writes cannot inherit TTL and same-clock invalidation is restored only by later validation", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  f.change("Changed independently.")
  expect((await f.run(readSkill(page))).snapshot_id).toBe(first.snapshot_id)
  const online = await f.run(openSkill(page))
  expect(online.snapshot_id).not.toBe(first.snapshot_id)
  await f.run(invalidateSnapshotCache(page, online.scope))
  expect(await f.run(cachedRemoteObservation(page, online.scope))).toBeUndefined()
  const restored = await f.run(openSkill(page))
  expect((await f.run(readSkill(page))).snapshot_id).toBe(restored.snapshot_id)
  f.time(900_000)
  await f.run(invalidateSnapshotCache(page, online.scope))
  await f.run(openSkill(page))
  expect((await f.run(readSkill(page))).source).toBe("local_cache")
})

test("C14 causal generations prevent delayed older publication from regressing complete latest observation", async () => {
  const f = fixture()
  const old = await f.run(openSkill(page))
  const reserved = f.generations.get(`${old.scope}/${old.record.id}`)!
  f.change("New version.")
  const newer = await f.run(openSkill(page))
  await f.run(publishSnapshotObservation(old, 1_000_000, reserved))
  expect((await f.run(cachedRemoteObservation(page, old.scope)))?.snapshot.snapshot_id).toBe(
    newer.snapshot_id,
  )
  await f.run(invalidateSnapshotCache(page, old.scope))
  await f.run(publishSnapshotObservation(newer, 1_000_000, reserved + 1))
  expect(await f.run(cachedRemoteObservation(page, old.scope))).toBeUndefined()
  await f.run(
    invalidateSnapshotCache(page, old.scope, {
      retainForOffline: true,
      accessDenied: "ACCESS_DENIED",
    }),
  )
  await f.run(publishSnapshotObservation(old, 1_000_000, reserved))
  const fixed = await f.run(readSkill(old.snapshot_id).pipe(Effect.result))
  expect(fixed._tag === "Failure" && fixed.failure.code).toBe("ACCESS_DENIED")
  const before = await f.run(reserveScopeAccess(old.scope))
  const after = await f.run(reserveScopeAccess(old.scope))
  await f.run(recordScopeAccess(old.scope, after, "AUTH_REQUIRED"))
  await f.run(recordScopeAccess(old.scope, before))
  const scoped = await f.run(readSkill(old.snapshot_id).pipe(Effect.result))
  expect(scoped._tag === "Failure" && scoped.failure.code).toBe("AUTH_REQUIRED")
})

test("C15/P1 every read entry carries policy and pinned relative flags fail before provider work", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  const before = f.requests.length
  expect(snapshotInfo(await f.run(targetSnapshot(parseTarget(page)))).source).toBe("local_cache")
  expect((await f.run(listSkill(page))).source).toBe("local_cache")
  const exported = await f.run(
    exportSkill(page, { output: "/cache-test.zip", format: "zip", offline: true }),
  )
  expect(exported.source).toBe("local_cache")
  expect(exported.snapshot_id).toBe(first.snapshot_id)
  const relative = await f.run(
    readSkill("references/guide.md", {
      from: `skill://${page}/SKILL.md?snapshot=${first.snapshot_id}`,
      offline: true,
    }),
  )
  expect(relative.source).toBe("local_snapshot")
  for (const options of [{ refresh: true }, { maxAge: 0 }, { offline: true, refresh: true }]) {
    const failure = await f.run(readSkill(first.snapshot_id, options).pipe(Effect.result))
    expect(failure._tag === "Failure" && failure.failure.code).toBe("INVALID_ARGUMENT")
  }
  expect(f.requests.length).toBe(before)
  const zero = await f.run(readSkill(page, { maxAge: 0 }))
  expect(zero.source).toBe("notion")
})

test("C17/C18/P6 cache status and targeted retirement are offline and retain all persistent content", async () => {
  const f = fixture()
  await f.run(readSkill("sample-skill", { database }))
  const current = await f.run(openSkill(page))
  f.json.set("cache/latest/other-scope/notion_page:other-page/entry.json", {
    record_identity: "notion_page:other-page",
    scope: "other-scope",
    generation: 1,
    started_at: 0,
    validated_at: 0,
    invalidated: true,
  })
  for (const key of [
    "sync/bindings.json",
    "sync/plans/p.json",
    "sync/receipts/r.json",
    "sync/baselines/b.json",
    "config.json",
  ])
    f.json.set(key, key === "config.json" ? { sources: [] } : { retained: true })
  const persistent = [...f.json.keys()].filter((key) => !key.startsWith("cache/"))
  const before = f.requests.length
  expect((await f.run(cacheStatus())).observations).toHaveLength(1)
  const preview = await f.run(clearCache(page, { dryRun: true }))
  expect(preview.entries.length).toBeGreaterThan(0)
  expect(f.retired).toHaveLength(0)
  await f.run(clearCache(page))
  expect(await f.run(cachedRemoteObservation(page, current.scope))).toBeUndefined()
  expect(f.json.has("cache/latest/other-scope/notion_page:other-page/entry.json")).toBe(true)
  expect(persistent.every((key) => f.json.has(key))).toBe(true)
  expect(f.objects.size).toBeGreaterThan(0)
  expect(f.requests.length).toBe(before)
})

test("P7 saving and clearing policy preserves every typed configuration field and keeps secrets private", async () => {
  const f = fixture()
  const bindings = [
    {
      id: "binding",
      label: "sample",
      page_id: page,
      database_id: database,
      data_source_id: "ds",
      scope: "scope",
      logical_path: "/local",
      active: true,
      revision: 2,
    },
  ]
  f.json.set("config.json", {
    token: "secret",
    default_database: database,
    sources: [],
    sync_bindings: bindings,
  })
  const saved = await f.run(configureCachePolicy({ readMaxAge: 0, catalogMaxAge: 2_000 }))
  expect(JSON.stringify(saved)).not.toContain("secret")
  expect((await f.run(configuration)).sync_bindings).toEqual(bindings)
  await f.run(setToken("next-secret"))
  expect((await f.run(configuration)).cache_policy).toEqual({
    read_max_age_ms: 0,
    catalog_max_age_ms: 2_000,
  })
  await f.run(clearCachePolicy)
  const final = await f.run(configuration)
  expect(final.cache_policy).toBeUndefined()
  expect(final.sync_bindings).toEqual(bindings)
  expect(final.token).toBe("next-secret")
  expect(f.requests).toHaveLength(0)
})

test("P1 duration parser rejects invalid integers/fractions/overflow and accepts all declared units", () => {
  for (const [input, value] of [
    ["0", 0],
    ["0s", 0],
    ["30s", 30_000],
    ["5m", 300_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
  ] as const)
    expect(parseDuration(input)).toBe(value)
  for (const input of ["1", "-1s", "1.5m", "Infinity", "1e3s", "9007199254740991d", "", " 1s"])
    expect(() => parseDuration(input)).toThrow()
})

test("incomplete reference read never publishes a shortened successful observation", async () => {
  const f = fixture()
  const old = await f.run(openSkill(page))
  f.change("Changed.")
  f.incomplete()
  const failure = await f.run(readSkill(page, { refresh: true }).pipe(Effect.result))
  expect(failure._tag).toBe("Failure")
  expect(await f.run(cachedRemoteObservation(page, old.scope))).toBeUndefined()
  const retained = await f.run(cachedRemoteObservation(page, old.scope, { offline: true }))
  expect(retained?.snapshot.snapshot_id).toBe(old.snapshot_id)
  expect(retained?.snapshot.files).toEqual(old.files)
  expect(retained?.invalidated).toBe(true)
})

test("catalog independent expiry/offline metadata preserves coverage without upgrading discovery", async () => {
  const f = fixture()
  const first = await f.run(catalog())
  expect(first.coverage.exhaustive).toBe(false)
  const before = f.requests.length
  f.time(1_059_999)
  expect((await f.run(catalog())).source).toBe("local_cache")
  expect(f.requests.length).toBe(before)
  f.time(1_060_000)
  expect((await f.run(catalog())).source).toBe("notion")
  f.time(1_120_000)
  f.deny()
  const offline = await f.run(catalog({ offline: true }))
  expect(offline.coverage).toEqual(first.coverage)
  expect(offline.freshness.stale).toBe(true)
})

test("checkbox-only refresh updates current metadata while preserving pinned snapshot bytes and identity", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  expect(first.record.default_context).toBe(false)
  f.defaultContext(true)
  const checked = await f.run(openSkill(page, { refresh: true }))
  expect(checked.record.default_context).toBe(true)
  expect((await f.run(openSkill(page))).record.default_context).toBe(true)
  expect(checked.snapshot_id).toBe(first.snapshot_id)
  expect(checked.version_id).toBe(first.version_id)
  expect(checked.files).toEqual(first.files)
  const pinned = await f.run(targetSnapshot(parseTarget(first.snapshot_id)))
  expect(pinned.record.default_context).toBe(false)
  f.defaultContext(false)
  expect((await f.run(openSkill(page, { refresh: true }))).record.default_context).toBe(false)
})

test("current snapshots require explicit Default Context metadata", async () => {
  const f = fixture()
  const original = await f.run(openSkill(page))
  for (const [key, value] of f.json) {
    const legacy = JSON.parse(JSON.stringify(value))
    if (key.startsWith("snapshots/")) delete legacy.record.default_context
    if (key.startsWith("cache/latest/")) delete legacy.default_context
    f.json.set(key, legacy)
  }
  const restored = await f.run(
    readSkill(original.snapshot_id, { offline: true }).pipe(Effect.result),
  )
  expect(restored._tag).toBe("Failure")
})
