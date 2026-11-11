import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  cachedRemoteObservation,
  clearCache,
  publishSnapshotObservation,
  validateCachedSharedCurrentTree,
} from "../src/cache.ts"
import { decode, property, SnapshotSchema, type Snapshot } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { digest, encode, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
const proofPrefix = "cache/shared-current-tree-validation/"
const proofKeys = (f: Fixture) => [...f.json.keys()].filter((key) => key.startsWith(proofPrefix))
const latestEntries = (f: Fixture) =>
  [...f.json.entries()]
    .filter(([key]) => key.startsWith("cache/latest/"))
    .map(([, value]) => property(value))

function trackedObservation(
  f: Fixture,
  snapshot: Snapshot,
  access: "manifest" | "metadata" | "all" = "manifest",
) {
  const reads: string[] = []
  const effect = Effect.gen(function* () {
    const store = yield* Store
    const observed =
      access === "all"
        ? cachedRemoteObservation(skillPage, snapshot.scope)
        : cachedRemoteObservation(skillPage, snapshot.scope, { access })
    return yield* observed.pipe(
      Effect.provideService(Store, {
        ...store,
        readBytes: (key) =>
          Effect.suspend(() => {
            reads.push(key)
            return store.readBytes(key)
          }),
      }),
    )
  })
  return { reads, run: () => f.run(effect), error: () => f.run(Effect.flip(effect)) }
}

function withBrokenReference(f: Fixture, snapshot: Snapshot) {
  const bytes = encode("[Missing resource](./missing.md)\n")
  const hash = digest(bytes)
  f.objects.set(`objects/${hash}`, bytes)
  const files = [
    ...snapshot.files,
    { path: "mounted/README.md", bytes: bytes.length, sha256: hash },
  ]
  const version = digest(JSON.stringify(["unchecked-current-tree", snapshot.version_id, files]))
  return decode(SnapshotSchema, {
    ...snapshot,
    files,
    version_id: version,
    snapshot_id: `s_${digest(JSON.stringify([snapshot.scope, snapshot.record.id, version]))}`,
  })
}

describe("shared current complete-tree validation receipts", () => {
  test("current preference projection reuses the stored manifest proof without unselected reads", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    const unselected = first.files.find((file) => file.path !== first.entrypoint)!
    f.objects.delete(`objects/${unselected.sha256}`)
    for (const entry of latestEntries(f)) entry.default_context = !first.record.default_context
    const observations = structuredClone(latestEntries(f))
    const proofs = proofKeys(f).map((key) => structuredClone(f.json.get(key)))
    f.clearCalls()
    const candidate = trackedObservation(f, first, "metadata")
    const observed = await candidate.run()
    expect(observed?.stored_snapshot?.record.default_context).toBe(first.record.default_context)
    expect(observed?.snapshot.record.default_context).toBe(!first.record.default_context)
    expect(candidate.reads).toEqual([])
    const reads: string[] = []
    const current = await f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* targetSnapshot(parseTarget(skillPage), {}, "generated", "entrypoint").pipe(
          Effect.provideService(Store, {
            ...store,
            readBytes: (key) =>
              Effect.suspend(() => {
                reads.push(key)
                return store.readBytes(key)
              }),
          }),
        )
      }),
    )
    const main = first.files.find((file) => file.path === first.entrypoint)!
    expect(reads).toEqual([`objects/${main.sha256}`])
    expect(current.record.default_context).toBe(!first.record.default_context)
    expect(current.snapshot_id).toBe(first.snapshot_id)
    expect(latestEntries(f)).toEqual(observations)
    expect(proofKeys(f).map((key) => f.json.get(key))).toEqual(proofs)
    expect(f.calls).toEqual([])
  })

  test("metadata candidate lookup leaves reference proof to the eligible-current gate", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    for (const key of proofKeys(f)) f.json.delete(key)
    const unchecked = withBrokenReference(f, first)
    f.json.set(`snapshots/${unchecked.snapshot_id}.json`, unchecked)
    for (const entry of latestEntries(f)) entry.snapshot_id = unchecked.snapshot_id
    const observations = structuredClone(latestEntries(f))
    f.clearCalls()
    const candidate = trackedObservation(f, unchecked, "metadata")
    expect((await candidate.run())?.snapshot.snapshot_id).toBe(unchecked.snapshot_id)
    expect(candidate.reads).toEqual([])
    expect(proofKeys(f)).toEqual([])
    expect(latestEntries(f)).toEqual(observations)
    expect(f.calls).toEqual([])
    expect((await f.run(Effect.flip(validateCachedSharedCurrentTree(unchecked)))).code).toBe(
      "SHARED_REFERENCE_BROKEN",
    )
    expect((await trackedObservation(f, unchecked).error()).code).toBe("SHARED_REFERENCE_BROKEN")
    expect(proofKeys(f)).toEqual([])
  })

  for (const fileCount of [3, 101])
    test(`N=${fileCount}: a published proof makes manifest reads independent of unselected local objects`, async () => {
      const f = sharedSnapshotFixture({ fileCount })
      const first = await f.open()
      expect(first.files).toHaveLength(fileCount)
      expect(proofKeys(f)).toHaveLength(1)
      const proofs = proofKeys(f).map((key) => structuredClone(f.json.get(key)))
      const observations = structuredClone(latestEntries(f))
      const unselected = first.files.filter((file) => file.path !== first.entrypoint)
      expect(unselected.length).toBeGreaterThanOrEqual(2)
      const missingBytes = f.objects.get(`objects/${unselected[0]!.sha256}`)!
      f.objects.delete(`objects/${unselected[0]!.sha256}`)
      f.objects.set(`objects/${unselected[1]!.sha256}`, encode("corrupt unselected bytes"))
      f.clearCalls()

      const read = trackedObservation(f, first)
      const observed = await read.run()
      expect(observed?.snapshot.files).toEqual(first.files)
      expect(read.reads).toEqual([])
      expect(observations[0]?.validated_at).toBe(observed?.validated_at)
      expect(observations[0]?.shared_body_valid_until).toBe(observed?.shared_body_valid_until)
      expect(latestEntries(f)).toEqual(observations)
      expect(proofKeys(f).map((key) => f.json.get(key))).toEqual(proofs)
      expect(f.calls).toEqual([])

      const full = trackedObservation(f, first, "all")
      expect((await full.error()).code).toBe("SNAPSHOT_MISSING")
      expect(full.reads).toContain(`objects/${unselected[0]!.sha256}`)
      f.objects.set(`objects/${unselected[0]!.sha256}`, missingBytes)
      const corrupt = trackedObservation(f, first, "all")
      const error = await corrupt.error()
      expect(error.code).toBe("STATE_CORRUPT")
      expect(property(error.details).path).toBe(unselected[1]!.path)
    })

  test("a legacy manifest read verifies every object once and fills proof without renewing freshness", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    for (const key of proofKeys(f)) f.json.delete(key)
    const observations = structuredClone(latestEntries(f))
    f.clearCalls()
    const legacy = trackedObservation(f, first)
    expect((await legacy.run())?.snapshot.snapshot_id).toBe(first.snapshot_id)
    expect(legacy.reads).toEqual(first.files.map((file) => `objects/${file.sha256}`))
    expect(proofKeys(f)).toHaveLength(1)
    const warm = trackedObservation(f, first)
    expect((await warm.run())?.snapshot.snapshot_id).toBe(first.snapshot_id)
    expect(warm.reads).toEqual([])
    expect(latestEntries(f)).toEqual(observations)
    expect(f.calls).toEqual([])
  })

  test("malformed and differently bound receipts fall back to complete verification", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    const key = proofKeys(f)[0]!
    expect(key).toBeDefined()
    const proof = structuredClone(property(f.json.get(key)))
    for (const [field, value] of Object.entries({
      version: 0,
      scope: "foreign-scope",
      record_identity: "shared_skill:foreign:skill",
      snapshot_id: `s_${digest("foreign-snapshot")}`,
      version_id: digest("foreign-version"),
      materialization_version: "unchecked-compiler",
      manifest_sha256: digest("foreign-manifest"),
    })) {
      f.json.set(key, { ...proof, [field]: value })
      const read = trackedObservation(f, first)
      expect((await read.run())?.snapshot.snapshot_id).toBe(first.snapshot_id)
      expect(read.reads).toEqual(first.files.map((file) => `objects/${file.sha256}`))
      expect(f.json.get(key)).toEqual(proof)
    }
  })

  test("proof digest binds record, files, bindings, native references, and complete relations", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    expect(proofKeys(f)).toHaveLength(1)
    const key = `snapshots/${first.snapshot_id}.json`
    const original = decode(SnapshotSchema, f.json.get(key))
    const proofs = proofKeys(f).map((proofKey) => structuredClone(f.json.get(proofKey)))
    expect(original.file_bindings?.length).toBeGreaterThan(0)
    f.objects.delete(`objects/${first.files[0]!.sha256}`)
    const relation = { id: "foreign-member", ref: "skill://foreign/SKILL.md", metadata: {} }
    const variants: readonly Snapshot[] = [
      { ...original, record: { ...original.record, description: "changed record" } },
      { ...original, files: [...original.files].reverse() },
      {
        ...original,
        file_bindings: original.file_bindings!.map((binding) => ({
          ...binding,
          path: `new/${binding.path}`,
        })),
      },
      {
        ...original,
        native_references: {
          version: 1,
          parser_version: 2,
          parent_id: original.record.id,
          source_files: [],
          relations_sha256: digest("changed relation proof"),
          index_sha256: digest("changed native index"),
          entries: [],
          unresolved: [],
        },
      },
      { ...original, members: [relation] },
      { ...original, required: [relation] },
      { ...original, router_members: [relation] },
    ]
    for (const variant of variants) {
      f.json.set(key, decode(SnapshotSchema, variant))
      const read = trackedObservation(f, first)
      expect((await read.error()).code).toBe("SNAPSHOT_MISSING")
      expect(read.reads.length).toBeGreaterThan(0)
      expect(proofKeys(f).map((proofKey) => f.json.get(proofKey))).toEqual(proofs)
    }
  })

  test("a legacy cache cannot gain proof from missing objects or broken local references", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    for (const key of proofKeys(f)) f.json.delete(key)
    const objectKey = `objects/${first.files[0]!.sha256}`
    const bytes = f.objects.get(objectKey)!
    f.objects.delete(objectKey)
    expect((await trackedObservation(f, first).error()).code).toBe("SNAPSHOT_MISSING")
    expect(proofKeys(f)).toEqual([])
    f.objects.set(objectKey, bytes)

    const unchecked = withBrokenReference(f, first)
    f.json.set(`snapshots/${unchecked.snapshot_id}.json`, unchecked)
    for (const entry of latestEntries(f)) entry.snapshot_id = unchecked.snapshot_id
    const observations = structuredClone(latestEntries(f))
    f.clearCalls()
    expect((await trackedObservation(f, unchecked).error()).code).toBe("SHARED_REFERENCE_BROKEN")
    expect(proofKeys(f)).toEqual([])
    expect(latestEntries(f)).toEqual(observations)
    expect(f.calls).toEqual([])
  })

  test("publishing cannot sign or advance current on broken references or unchecked bytes", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    const unchecked = withBrokenReference(f, first)
    const observations = structuredClone(latestEntries(f))
    const proofs = proofKeys(f).map((key) => structuredClone(f.json.get(key)))
    const publish = () =>
      f.run(
        Effect.flip(
          publishSnapshotObservation(unchecked, Date.now(), 2, {
            sharedBodyValidUntil: Date.now() + 60_000,
          }),
        ),
      )
    expect((await publish()).code).toBe("SHARED_REFERENCE_BROKEN")
    const hash = unchecked.files.at(-1)!.sha256
    f.objects.set(`objects/${hash}`, encode("bad checksum"))
    expect((await publish()).code).toBe("STATE_CORRUPT")
    f.objects.delete(`objects/${hash}`)
    expect((await publish()).code).toBe("SNAPSHOT_MISSING")
    expect(latestEntries(f)).toEqual(observations)
    expect(proofKeys(f).map((key) => f.json.get(key))).toEqual(proofs)
  })

  test("proof cannot bypass invalidation, materialization version, or full-body observation requirements", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    const latest = latestEntries(f)[0]!
    const original = structuredClone(latest)
    latest.invalidated = true
    const invalidated = trackedObservation(f, first)
    expect(await invalidated.run()).toBeUndefined()
    expect(invalidated.reads).toEqual([])
    Object.assign(latest, original, { materialization_version: "old-compiler" })
    expect((await trackedObservation(f, first).error()).code).toBe("CACHE_REFRESH_REQUIRED")
    Object.assign(latest, original, { shared_body_valid_until: 0 })
    expect((await trackedObservation(f, first).error()).code).toBe("CACHE_REFRESH_REQUIRED")
  })

  test("targeted clear leaves no current observation and clear all also retires content proofs", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.open()
    expect(proofKeys(f)).toHaveLength(1)
    const clear = (target?: string) =>
      f.run(
        Effect.gen(function* () {
          const store = yield* Store
          return yield* clearCache(target, target === undefined ? { all: true } : {}).pipe(
            Effect.provideService(Store, {
              ...store,
              retireKeys: (keys) =>
                Effect.sync(() =>
                  keys.map((key) => {
                    f.json.delete(key)
                    return { key, retention_path: `fixture-retired/${key}` }
                  }),
                ),
            }),
          )
        }),
      )
    f.clearCalls()
    await clear(skillPage)
    expect(latestEntries(f)).toEqual([])
    expect(proofKeys(f)).toHaveLength(1)
    const withoutCurrent = trackedObservation(f, first)
    expect(await withoutCurrent.run()).toBeUndefined()
    expect(withoutCurrent.reads).toEqual([])
    const cleared = await clear()
    expect(cleared.entries.some((key) => key.startsWith(proofPrefix))).toBe(true)
    expect(proofKeys(f)).toEqual([])
    expect(f.calls).toEqual([])
  })
})
