import { expect, test } from "bun:test"
import { Clock, Crypto, Effect, Fiber, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import {
  currentId,
  currentLibrary,
  currentRich,
  currentSkillPage,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"
import { fail, property, text } from "../src/model.ts"
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

const page = currentSkillPage
const database = currentLibrary.skills.database_id
const guide = currentId(100)
const other = currentId(90)
const logicalId = "shared_skill:" + currentLibrary.library_id + ":demo"
type FixtureServices =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
function fixture() {
  const base = currentSnapshotFixture({ fileCount: 1 })
  base.main.properties.Name = {
    id: "title",
    type: "title",
    title: [{ plain_text: "Sample Skill" }],
  }
  base.files[0]!.properties.Path = currentRich("path", "references/guide.md")
  base.bodies.set(page, "Main body.")
  base.bodies.set(guide, "Original reference.")
  let now = 1_000_000,
    credential = "credential-one",
    additional = false,
    decoy = false
  let denied:
    | {
        code: "ACCESS_DENIED" | "AUTH_REQUIRED" | "NOT_FOUND" | "NOTION_UNAVAILABLE"
        path?: string
      }
    | undefined
  let paused: { path: string; started: () => void } | undefined
  const requests: string[] = [],
    retired: string[] = [],
    generations = new Map<string, number>()
  const otherPage = () => ({
    ...structuredClone(base.main),
    id: other,
    properties: {
      ...structuredClone(base.main.properties),
      Name: {
        id: "title",
        type: "title",
        title: [{ plain_text: decoy ? "Sample Skill" : "Other Skill" }],
      },
      "Skill ID": currentRich("skill-id", "other-skill"),
      "Main File ID": currentRich("main-id", "other-main"),
    },
  })
  const match = (row: unknown, raw: unknown): boolean => {
    const filter = property(raw)
    if (Array.isArray(filter.and)) return filter.and.every((part) => match(row, part))
    if (Array.isArray(filter.or)) return filter.or.some((part) => match(row, part))
    const field = Object.values(property(property(row).properties))
      .map(property)
      .find((field) => field.id === filter.property)
    if (field === undefined) return false
    if (filter.rich_text !== undefined)
      return text(field.rich_text) === property(filter.rich_text).equals
    if (filter.checkbox !== undefined) return field.checkbox === property(filter.checkbox).equals
    return false
  }
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  }
  const run = <A, E>(effect: Effect.Effect<A, E, FixtureServices>) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion,
          storage = yield* Store
        const api: Notion["Service"] = {
          ...original,
          connectionIdentity: undefined,
          credentialIdentity: Effect.sync(() => credential),
          request: (path, body, options) =>
            Effect.gen(function* () {
              requests.push(path)
              const route = path.split("?")[0]
              const currentPause = paused
              if (currentPause !== undefined && currentPause.path === route) {
                currentPause.started()
                yield* Effect.never
              }
              if (denied && (denied.path === undefined || denied.path === route))
                return yield* Effect.fail(fail(denied.code, "Denied."))
              if (path === "v1/users/me") return { id: "user", object: "user" }
              if (path === "v1/search")
                return {
                  object: "list",
                  results: [
                    {
                      id: currentLibrary.skills.data_source_id,
                      parent: { database_id: database },
                      title: [{ plain_text: "Current Skills" }],
                      database_type: null,
                      properties: base.main.properties,
                    },
                  ],
                  has_more: false,
                  next_cursor: null,
                }
              if (
                path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)
              ) {
                const filter = property(body).filter
                return {
                  object: "list",
                  results: [base.main, ...(additional || decoy ? [otherPage()] : [])]
                    .filter((row) => filter === undefined || match(row, filter))
                    .map((row) => structuredClone(row)),
                  has_more: false,
                  next_cursor: null,
                }
              }
              if ((additional || decoy) && path === `v1/pages/${other}`) return otherPage()
              if ((additional || decoy) && route === `v1/pages/${other}/markdown`)
                return {
                  id: other,
                  markdown: "Other body.",
                  truncated: false,
                  unknown_block_ids: [],
                }
              return yield* original.request(path, body, options)
            }),
        }
        const store: Store["Service"] = {
          ...storage,
          reserveCacheGeneration: (scope, id) =>
            Effect.sync(() => {
              const key = `${scope}/${id}`,
                next = (generations.get(key) ?? 0) + 1
              generations.set(key, next)
              return next
            }),
          retireKeys: (keys) =>
            Effect.sync(() =>
              keys.map((key) => {
                if (!key.startsWith("cache/"))
                  throw fail("INVALID_ARGUMENT", "Only cache may be retired.")
                base.json.delete(key)
                retired.push(key)
                return { key, retention_path: "fixture_trash" }
              }),
            ),
          output: (destination, bytes) =>
            Effect.sync(() => {
              base.objects.set(`output/${destination}`, bytes)
              return { output: destination, reused: false }
            }),
        }
        return yield* effect.pipe(
          Effect.provideService(Notion, api),
          Effect.provideService(Store, store),
          Effect.provideService(Clock.Clock, clock),
        )
      }),
    )
  return {
    ...base,
    requests,
    retired,
    generations,
    run,
    defaultContext: (value: boolean) => {
      base.main.properties["Default Context"].checkbox = value
    },
    time: (value: number) => {
      now = value
    },
    deny: (code: NonNullable<typeof denied>["code"] = "ACCESS_DENIED", path?: string) => {
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
      base.bodies.set(guide, value)
    },
    rename: (value: string) => {
      base.main.properties.Name.title = [{ plain_text: value }]
    },
    duplicate: () => {
      decoy = true
    },
    incomplete: () => {
      base.failRequests((call) =>
        call.path.split("?")[0] === `v1/pages/${guide}/markdown`
          ? fail("ACCESS_DENIED", "Supporting File unavailable.")
          : undefined,
      )
    },
    credential: (value: string) => {
      credential = value
    },
  }
}

test("C1/C3 warm complete reads add zero requests without moving validation or current configuration", async () => {
  const f = fixture()
  f.json.set("config.json", { sources: [], default_database: database })
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
  expect(f.json.get("config.json")).toEqual({ sources: [], default_database: database })
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

test("current eligibility and the native body deadline do not advance a fixed selection", async () => {
  const f = fixture()
  const path = "references/guide.md"
  const first = await f.run(readSkill(page, { path }))
  const bodyObservation = () => {
    const entry = [...f.json].find(([key]) => key.startsWith("cache/current-native-bodies/"))
    const files = property(entry?.[1]).files
    if (!Array.isArray(files)) throw new Error("Missing native body observation")
    return property(files.find((file) => property(file).path === path))
  }
  expect(bodyObservation().body_verified_at).toBe(1_000_000)
  f.change("Changed body with unchanged metadata.")
  for (const [age, source] of [
    [299_999, "local_cache"],
    [300_000, "notion"],
    [24 * 60 * 60 * 1000 - 1, "notion"],
  ] as const) {
    f.time(1_000_000 + age)
    f.clearCalls()
    const current = await f.run(readSkill(page, { path }))
    expect(current.source).toBe(source)
    expect(current.snapshot_id).toBe(first.snapshot_id)
    expect("content" in current && current.content).toBe("Original reference.")
    expect(bodyObservation().body_verified_at).toBe(1_000_000)
    expect(f.bodyCalls()).toHaveLength(0)
  }
  f.time(1_000_000 + 24 * 60 * 60 * 1000)
  const expired = await f.run(readSkill(page, { path }))
  expect(expired.snapshot_id).not.toBe(first.snapshot_id)
  expect("content" in expired && expired.content).toBe("Changed body with unchanged metadata.")
  const pinned = await f.run(readSkill(first.ref))
  expect(pinned.snapshot_id).toBe(first.snapshot_id)
  expect("content" in pinned && pinned.content).toBe("Original reference.")
  f.change("Explicit refresh observes this edit immediately.")
  const refreshed = await f.run(readSkill(page, { path, refresh: true }))
  expect(refreshed.snapshot_id).not.toBe(expired.snapshot_id)
  expect("content" in refreshed && refreshed.content).toBe(
    "Explicit refresh observes this edit immediately.",
  )
  expect(f.semanticWrites()).toHaveLength(0)
})

test("C6/C7 unknown transport failure has no online fallback; explicit offline retains the original observation", async () => {
  const f = fixture()
  const first = await f.run(readSkill(page))
  f.time(1_300_000)
  f.deny("NOTION_UNAVAILABLE")
  const failure = await f.run(readSkill(page).pipe(Effect.result))
  expect(failure._tag === "Failure" && failure.failure.code).toBe("NOTION_UNAVAILABLE")
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

test("T05 fixed inventories and exports require the selected credential scope after clear", async () => {
  const f = fixture()
  const original = await f.run(openSkill(page))
  const originalBody = await f.run(readSkill(original.snapshot_id, { offline: true }))
  if (!("content" in originalBody)) throw new Error("Expected the complete native main body")
  const identities = [...f.json.keys()].filter((key) => key.startsWith("cache/identities/"))
  expect(identities).toHaveLength(1)
  const refused = async (code: string) => {
    const before = f.requests.length
    for (const offline of [false, true]) {
      const rejected = await Promise.all([
        f.run(readSkill(original.snapshot_id, { offline }).pipe(Effect.flip)),
        f.run(listSkill(original.snapshot_id, { offline }).pipe(Effect.flip)),
        f.run(
          exportSkill(original.snapshot_id, {
            offline,
            output: "/controlled/t05-refused",
          }).pipe(Effect.flip),
        ),
      ])
      for (const error of rejected)
        expect(error).toMatchObject({
          code,
          details: {
            phase: "fixed_access",
            snapshot_id: original.snapshot_id,
            scope: original.scope,
          },
        })
    }
    expect(f.requests.length).toBe(before)
  }
  f.credential("credential-two")
  await refused("CACHE_SCOPE_UNAVAILABLE")
  const second = await f.run(readSkill(page))
  expect(second.scope).not.toBe(original.scope)
  await refused("SNAPSHOT_SCOPE_MISMATCH")
  const cleared = await f.run(clearCache(undefined, { all: true }))
  for (const key of identities) {
    expect(cleared.entries).not.toContain(key)
    expect(cleared.retired.some((entry) => entry.key === key)).toBe(false)
    expect(f.json.has(key)).toBe(true)
  }
  await refused("SNAPSHOT_SCOPE_MISMATCH")
  f.credential("credential-one")
  const before = f.requests.length
  expect(await f.run(readSkill(original.snapshot_id, { offline: true }))).toMatchObject({
    content: originalBody.content,
    snapshot_id: original.snapshot_id,
    scope: original.scope,
  })
  expect((await f.run(listSkill(original.snapshot_id, { offline: true }))).files).toHaveLength(2)
  expect(f.requests.length).toBe(before)
  // Missing identity state is not reconstructed from content hashes or a pin.
  f.json.delete(identities[0]!)
  await refused("CACHE_SCOPE_UNAVAILABLE")
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
      if (code === "NOT_FOUND") {
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
        expect(pinned.freshness?.stale).toBeUndefined()
      } else {
        for (const input of [target, first.ref])
          await expect(f.run(readSkill(input, { database, offline: true }))).rejects.toMatchObject({
            code,
          })
        await expect(
          f.run(readSkill("references/guide.md", { from: first.ref, offline: true })),
        ).rejects.toMatchObject({ code })
      }
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
    for (const target of ["other-skill", first.ref, second.ref])
      await expect(f.run(readSkill(target, { database, offline: true }))).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      })
    const oldDirectory = await f.run(catalog({ database, offline: true }))
    expect(oldDirectory.fetched_at).toBe(directory.fetched_at)
    expect(oldDirectory.freshness.stale).toBe(true)
    expect(f.requests.length).toBe(before)
    f.credential("credential-two")
    expect((await f.run(readSkill(other, { database }))).snapshot_id).toBe(
      otherCredential.snapshot_id,
    )
    expect((await f.run(readSkill(otherCredential.ref, { offline: true }))).snapshot_id).toBe(
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
    expect((await f.run(readSkill(second.ref, { offline: true }))).snapshot_id).toBe(
      second.snapshot_id,
    )
    expect(f.requests.length).toBe(before)
  })

test("SC12 scope rejection reaches an old pin with no current observation", async () => {
  const f = fixture()
  f.addOther()
  await f.run(readSkill(page, { database }))
  const old = await f.run(readSkill(other, { database }))
  for (const key of f.json.keys())
    if (key.includes("/shared_skill:" + currentLibrary.library_id + ":other-skill/"))
      f.json.delete(key)
  f.deny("AUTH_REQUIRED", "v1/users/me")
  await f.run(readSkill(page, { database, refresh: true }).pipe(Effect.result))
  const denied = await f.run(readSkill(old.ref).pipe(Effect.result))
  expect(denied._tag === "Failure" && denied.failure.code).toBe("AUTH_REQUIRED")
  const before = f.requests.length
  await expect(f.run(readSkill(old.ref, { offline: true }))).rejects.toMatchObject({
    code: "AUTH_REQUIRED",
  })
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
  expect((await f.run(readSkill(page, { refresh: true }))).record.id).toBe(logicalId)
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
  expect(complete._tag === "Success" && complete.success?.snapshot.snapshot_id).toBe(
    snapshot.snapshot_id,
  )
  const exported = await f.run(snapshotPortable(snapshot).pipe(Effect.result))
  expect(exported._tag === "Failure" && exported.failure.code).toBe("STATE_CORRUPT")
  expect(f.requests.length).toBe(before)
  const main = await f.run(readSkill(page))
  expect(main.source).toBe("local_cache")
  expect(main.snapshot_id).toBe(snapshot.snapshot_id)
  expect(f.requests.length).toBe(before)
})

test("C11/C16 cache retirement preserves selected bytes and forces current discovery", async () => {
  const f = fixture()
  const snapshot = await f.run(openSkill(page))
  f.json.set("config.json", { sources: [], default_database: database })
  await f.run(clearCache(undefined, { all: true }))
  const pinned = await f.run(readSkill(snapshot.snapshot_id))
  expect(pinned.source).toBe("local_snapshot")
  expect(pinned.freshness).toEqual({ policy: "pinned" })
  const before = f.requests.length
  await f.run(readSkill(page))
  expect(f.requests.length).toBeGreaterThan(before)
  expect(f.json.get("config.json")).toEqual({ sources: [], default_database: database })
})

test("target clear retains native body observations while all clear forces body revalidation without deleting pins", async () => {
  const f = fixture()
  const path = "references/guide.md"
  const first = await f.run(readSkill(page, { path }))
  const nativeKey = [...f.json.keys()].find((key) =>
    key.startsWith("cache/current-native-bodies/"),
  )!
  const nativeObservation = structuredClone(f.json.get(nativeKey))
  f.change("Changed after the initial fixed selection.")
  const targetClear = await f.run(clearCache(page))
  expect(targetClear.entries).not.toContain(nativeKey)
  expect(f.json.get(nativeKey)).toEqual(nativeObservation)
  f.clearCalls()
  const afterTarget = await f.run(readSkill(page, { path }))
  expect(afterTarget.source).toBe("notion")
  expect(afterTarget.snapshot_id).toBe(first.snapshot_id)
  expect(f.bodyCalls()).toHaveLength(0)
  const allClear = await f.run(clearCache(undefined, { all: true }))
  expect(allClear.entries).toContain(nativeKey)
  expect(f.json.has(nativeKey)).toBe(false)
  f.clearCalls()
  const old = await f.run(readSkill(first.ref))
  expect(old.snapshot_id).toBe(first.snapshot_id)
  expect("content" in old && old.content).toBe("Original reference.")
  expect(f.calls).toHaveLength(0)
  const current = await f.run(readSkill(page, { path }))
  expect(current.snapshot_id).not.toBe(first.snapshot_id)
  expect("content" in current && current.content).toBe("Changed after the initial fixed selection.")
  expect(f.bodyCalls().length).toBeGreaterThan(0)
  expect(f.semanticWrites()).toHaveLength(0)
})

test("C12/C13 explicit refresh cannot inherit TTL and same-clock invalidation needs later validation", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  f.change("Changed independently.")
  expect((await f.run(readSkill(page))).snapshot_id).toBe(first.snapshot_id)
  const online = await f.run(openSkill(page, { refresh: true }))
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
  const observed = await f.run(cachedRemoteObservation(page, old.scope))
  const publication = { sharedBodyValidUntil: observed?.shared_body_valid_until }
  expect(publication.sharedBodyValidUntil).toBeGreaterThan(1_000_000)
  f.change("New version.")
  const newer = await f.run(openSkill(page, { refresh: true }))
  await f.run(publishSnapshotObservation(old, 1_000_000, reserved, publication))
  expect((await f.run(cachedRemoteObservation(page, old.scope)))?.snapshot.snapshot_id).toBe(
    newer.snapshot_id,
  )
  await f.run(invalidateSnapshotCache(page, old.scope))
  await f.run(publishSnapshotObservation(newer, 1_000_000, reserved + 1, publication))
  expect(await f.run(cachedRemoteObservation(page, old.scope))).toBeUndefined()
  await f.run(
    invalidateSnapshotCache(page, old.scope, {
      retainForOffline: true,
      accessDenied: "ACCESS_DENIED",
    }),
  )
  await f.run(publishSnapshotObservation(old, 1_000_000, reserved, publication))
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
      from: `skill://${encodeURIComponent(first.record.id)}/${first.entrypoint}?snapshot=${first.snapshot_id}`,
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
  f.json.set("cache/latest/other-scope/shared_skill:other-library:other-page/entry.json", {
    record_identity: "shared_skill:other-library:other-page",
    scope: "other-scope",
    generation: 1,
    started_at: 0,
    validated_at: 0,
    invalidated: true,
  })
  f.json.set("config.json", { sources: [] })
  const persistent = [...f.json.keys()].filter((key) => !key.startsWith("cache/"))
  const before = f.requests.length
  expect((await f.run(cacheStatus())).observations).toHaveLength(1)
  const preview = await f.run(clearCache(page, { dryRun: true }))
  expect(preview.entries.length).toBeGreaterThan(0)
  expect(f.retired).toHaveLength(0)
  await f.run(clearCache(page))
  expect(await f.run(cachedRemoteObservation(page, current.scope))).toBeUndefined()
  expect(
    f.json.has("cache/latest/other-scope/shared_skill:other-library:other-page/entry.json"),
  ).toBe(true)
  expect(persistent.every((key) => f.json.has(key))).toBe(true)
  expect(f.objects.size).toBeGreaterThan(0)
  expect(f.requests.length).toBe(before)
})

test("P7 saving and clearing policy preserves every typed configuration field and keeps secrets private", async () => {
  const f = fixture()
  const sources = [
    {
      alias: "current",
      database_id: database,
      title: "Current Skills",
      data_source_ids: [currentLibrary.skills.data_source_id],
    },
  ]
  f.json.set("config.json", { token: "secret", default_database: database, sources })
  const saved = await f.run(configureCachePolicy({ readMaxAge: 0, catalogMaxAge: 2_000 }))
  expect(JSON.stringify(saved)).not.toContain("secret")
  expect((await f.run(configuration)).sources).toEqual(sources)
  await f.run(setToken("next-secret"))
  expect((await f.run(configuration)).cache_policy).toEqual({
    read_max_age_ms: 0,
    catalog_max_age_ms: 2_000,
  })
  await f.run(clearCachePolicy)
  const final = await f.run(configuration)
  expect(final.cache_policy).toBeUndefined()
  expect(final.sources).toEqual(sources)
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

test("checkbox-only refresh selects a new record while preserving the earlier pin and content version", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  expect(first.record.default_context).toBe(false)
  f.defaultContext(true)
  const checked = await f.run(openSkill(page, { refresh: true }))
  expect(checked.record.default_context).toBe(true)
  expect((await f.run(openSkill(page))).record.default_context).toBe(true)
  expect(checked.snapshot_id).not.toBe(first.snapshot_id)
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
