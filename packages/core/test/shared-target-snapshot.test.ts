import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decode, property, SnapshotSchema } from "../src/model.ts"
import { readSkill, targetSnapshot } from "../src/snapshot.ts"
import { parseTarget } from "../src/ref.ts"
import { SHARED_FULL_BODY_MAX_AGE_MS } from "../src/shared-snapshot.ts"
import {
  currentSnapshotFixture,
  currentLibrary as library,
  currentSkillPage as skillPage,
  currentRich as rich,
  currentDigest as digest,
  currentBytes as encode,
} from "./shared-current-fixture.ts"

const options = { database: library.skills.database_id }
const stableId = "shared_skill:library-current:demo"
const stableRef = `skill://${encodeURIComponent(stableId)}/SKILL.md`

function latestEntries(fixture: ReturnType<typeof currentSnapshotFixture>) {
  return [...fixture.json.entries()]
    .filter(([key]) => key.startsWith("cache/latest/"))
    .map(([, value]) => property(value))
}

describe("standard targetSnapshot shared-library integration", () => {
  for (const policy of [{ refresh: true }, { maxAge: 0 }]) {
    test(`relative current reads consume ${JSON.stringify(policy)} once and keep its observation`, async () => {
      const f = currentSnapshotFixture()
      await f.target(parseTarget(skillPage), options)
      f.json.clear()
      f.objects.clear()
      f.clearCalls()
      const first = await f.run(
        readSkill("references/0.md", { ...options, ...policy, from: stableRef }),
      )
      expect("content" in first && first.content).toBe(
        "# Supporting 0\n\nComplete supporting text 0.\n",
      )
      expect(first.source).toBe("notion")
      expect(first.freshness?.policy).toBe(policy.refresh ? "refresh" : "max_age")
      expect(first.materialization?.materialized_paths).toEqual(["references/0.md"])
      expect(f.bodyCalls().length).toBe(3)
      expect(f.semanticWrites().length).toBe(0)

      f.clearCalls()
      const warm = await f.run(
        readSkill("references/0.md", { ...options, maxAge: 30_000, from: stableRef }),
      )
      expect(warm.snapshot_id).toBe(first.snapshot_id)
      expect("content" in warm && warm.content).toBe(
        "# Supporting 0\n\nComplete supporting text 0.\n",
      )
      expect(warm.source).toBe("local_cache")
      expect(warm.freshness?.policy).toBe("max_age")
      expect(warm.freshness?.validated_at).toBe(first.freshness?.validated_at)
      expect(f.calls).toHaveLength(0)

      const rejected = await f.run(
        readSkill("1.md", { ...options, ...policy, from: first.ref }).pipe(Effect.flip),
      )
      expect(rejected.code).toBe("INVALID_ARGUMENT")
      expect(f.calls).toHaveLength(0)
      const pinned = await f.run(readSkill("1.md", { ...options, offline: true, from: first.ref }))
      expect("content" in pinned && pinned.content).toBe(
        "# Supporting 1\n\nComplete supporting text 1.\n",
      )
      expect(pinned.snapshot_id).toBe(first.snapshot_id)
      expect(pinned.source).toBe("local_snapshot")
      expect(pinned.freshness?.policy).toBe("pinned")
      expect(f.calls).toHaveLength(0)
    })
  }

  test("an unbound cached file is rejected offline and needs verified current reselection", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const bytes = encode("[Unbound resource](./missing.md)\n")
    const hash = digest(bytes)
    f.objects.set(`objects/${hash}`, bytes)
    const files = [
      ...first.files,
      { path: "mounted/README.md", bytes: bytes.byteLength, sha256: hash },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    // A directory entry without an exact physical binding is invalid even if its bytes hash matches.
    const version = digest(JSON.stringify(["pre-reference-check", first.version_id, files]))
    const snapshotId = `s_${digest(JSON.stringify([first.scope, first.record.id, version]))}`
    const historical = decode(SnapshotSchema, {
      ...first,
      files,
      version_id: version,
      snapshot_id: snapshotId,
    })
    f.json.set(`snapshots/${snapshotId}.json`, historical)
    for (const entry of latestEntries(f)) {
      entry.snapshot_id = snapshotId
      entry.version_id = version
      entry.current_snapshot = historical
    }
    const retained = structuredClone(historical)
    const observations = structuredClone(latestEntries(f))
    f.clearCalls()
    for (const policy of [{ ...options, offline: true }]) {
      for (const access of ["all", "manifest", "entrypoint", "target"] as const) {
        const error = await f.run(
          Effect.flip(targetSnapshot(parseTarget(stableRef), policy, access)),
        )
        expect(error.code).toBe("STATE_CORRUPT")
      }
    }
    expect(f.calls).toHaveLength(0)
    expect(latestEntries(f)).toEqual(observations)
    expect(f.json.get(`snapshots/${snapshotId}.json`)).toEqual(retained)
    const pinned = await f.run(
      targetSnapshot({ ...parseTarget(stableRef), snapshot: snapshotId }, { offline: true }).pipe(
        Effect.result,
      ),
    )
    expect(pinned._tag === "Failure" && pinned.failure.code).toBe("STATE_CORRUPT")
    expect(f.objects.get(`objects/${hash}`)).toEqual(bytes)
    expect(f.calls).toHaveLength(0)
    const selected = await f.target(parseTarget(stableRef), options)
    expect(selected.snapshot_id).toBe(first.snapshot_id)
    expect(selected.files).toEqual(first.files)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect(f.json.get(`snapshots/${snapshotId}.json`)).toEqual(retained)
  })

  test("cold page ID then page ID and stable reference TTL hits use one shared identity and zero requests", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    expect(first.record.id).toBe(stableId)
    expect(first.record.locator.type).toBe("shared_skill")
    expect(f.bodyCalls().length).toBe(3)
    const previous = structuredClone(latestEntries(f))
    f.clearCalls()
    const pageHit = await f.target(parseTarget(skillPage), options)
    const stableHit = await f.target(parseTarget(stableRef), options)
    expect(pageHit.snapshot_id).toBe(first.snapshot_id)
    expect(stableHit.snapshot_id).toBe(first.snapshot_id)
    expect(pageHit.source).toBe("local_cache")
    expect(stableHit.source).toBe("local_cache")
    expect(f.calls).toHaveLength(0)
    expect(latestEntries(f)).toEqual(previous)
  })

  test("an empty-cache stable reference resolves metadata before entering the same shared consumer", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(stableRef), options)
    expect(first.record.id).toBe(stableId)
    expect(first.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/0.md",
      "references/1.md",
    ])
    expect(f.bodyCalls().length).toBe(3)
    expect(
      f.calls.some((call) =>
        call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
      ),
    ).toBe(true)
    f.clearCalls()
    await f.target(parseTarget(stableRef), options)
    expect(f.calls).toHaveLength(0)
  })

  test("expired metadata revalidates with batched queries and no body download or state write", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    for (const entry of latestEntries(f)) entry.validated_at = Date.now() - 300_001
    f.clearCalls()
    const checked = await f.target(parseTarget(stableRef), options)
    expect(checked.snapshot_id).toBe(first.snapshot_id)
    expect(checked.source).toBe("notion")
    expect(checked.freshness?.validation).toBe("metadata")
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    // Revalidation reads the current Files inventory and checks it again before publication.
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`),
      ),
    ).toHaveLength(2)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`),
      ),
    ).toHaveLength(0)
    expect(f.calls.some((call) => /v1\/pages\/.*\/children/.test(call.path))).toBe(false)
  })

  test("full-body deadline defeats a fresh metadata TTL without mutating the previous snapshot", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const saved = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    for (const entry of latestEntries(f)) {
      entry.validated_at = Date.now()
      entry.shared_body_valid_until = Date.now() - 1
    }
    for (const [key, value] of f.json) {
      if (!key.startsWith("cache/current-native-bodies/")) continue
      const entry = property(value)
      if (!Array.isArray(entry.files)) throw new Error("Missing observation fixture")
      entry.files = entry.files.map((observation) => ({
        ...property(observation),
        body_verified_at: Date.now() - SHARED_FULL_BODY_MAX_AGE_MS - 1,
      }))
    }
    // This controlled edit deliberately does not advance last_edited_time.
    f.bodies.set(skillPage, "Same timestamp, different body\n")
    f.clearCalls()
    const current = await f.target(parseTarget(stableRef), options)
    expect(f.bodyCalls().length).toBe(3)
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(saved)
  })

  test("full-body revalidation of unchanged bytes renews only observation state, preserving snapshot bytes", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const saved = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    f.clearCalls()
    const refreshed = await f.target(parseTarget(stableRef), { ...options, refresh: true })
    expect(f.bodyCalls().length).toBe(3)
    expect(f.semanticWrites().length).toBe(0)
    expect(refreshed.snapshot_id).toBe(first.snapshot_id)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(saved)
    expect(latestEntries(f)).toHaveLength(2)
  })

  test("fixed pins remain exact and offline after current body changes or the Skill is disabled", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    f.bodies.set(skillPage, "New current body\n")
    property(f.main.properties)["Enabled"] = { id: "enabled", type: "checkbox", checkbox: false }
    f.clearCalls()
    const pinned = await f.target(
      { ...parseTarget(stableRef), snapshot: first.snapshot_id },
      { offline: true },
    )
    expect(pinned.snapshot_id).toBe(first.snapshot_id)
    expect(pinned.files).toEqual(first.files)
    expect(pinned.source).toBe("local_snapshot")
    expect(pinned.freshness?.policy).toBe("pinned")
    expect(f.calls).toHaveLength(0)
  })

  test("an observed pending writer blocks current reads without reader reconciliation or losing selected bytes", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const original = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    f.main.properties["Current State"] = {
      id: "state",
      type: "select",
      select: { name: "applying" },
    }
    f.main.properties.Operation = rich("operation", "current-edit")
    f.clearCalls()
    const blocked = await f.run(
      targetSnapshot(parseTarget(stableRef), { ...options, refresh: true }).pipe(Effect.result),
    )
    expect(blocked._tag === "Failure" && blocked.failure.code).toBe("CURRENT_OPERATION_PENDING")
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
    expect([...f.json.keys()].filter((key) => key.startsWith("operations/"))).toEqual([])
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(original)
    f.clearCalls()
    const selected = await f.target(
      { ...parseTarget(stableRef), snapshot: first.snapshot_id },
      { offline: true },
    )
    expect(selected.snapshot_id).toBe(first.snapshot_id)
    expect(f.calls).toHaveLength(0)
    f.main.properties["Current State"] = { id: "state", type: "select", select: { name: "ready" } }
    f.main.properties.Operation = rich("operation", "")
    f.bodies.set(skillPage, "The writer has completed its current edit.\n")
    const current = await f.target(parseTarget(stableRef), { ...options, refresh: true })
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(f.semanticWrites()).toHaveLength(0)
    expect(f.records.size).toBe(0)
  })

  test("an explicitly refreshed disabled Skill fails before fetching or writing its body", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    property(f.main.properties)["Enabled"] = { id: "enabled", type: "checkbox", checkbox: false }
    f.clearCalls()
    await expect(f.target(parseTarget(skillPage), { ...options, refresh: true })).rejects.toThrow(
      "disabled",
    )
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    f.clearCalls()
    await expect(f.target(parseTarget(skillPage), options)).rejects.toThrow("disabled")
    expect(f.bodyCalls().length).toBe(0)
    expect(f.semanticWrites().length).toBe(0)
    f.clearCalls()
    const offline = await f.target(parseTarget(skillPage), { ...options, offline: true })
    expect(offline.snapshot_id).toBe(first.snapshot_id)
    expect(offline.freshness?.validated_at).toBe(first.freshness?.validated_at)
    expect(offline.freshness?.stale).toBe(true)
    expect(f.calls).toHaveLength(0)
    property(f.main.properties)["Enabled"] = { id: "enabled", type: "checkbox", checkbox: true }
    expect((await f.target(parseTarget(skillPage), options)).source).toBe("notion")
  })

  test("metadata-only Description changes preserve authored frontmatter and content identity", async () => {
    const f = currentSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const recordsBefore = f.records.size
    property(f.main.properties)["Description"] = rich("description", "New metadata description")
    f.main.last_edited_time = new Date(Date.now() - 1).toISOString()
    for (const entry of latestEntries(f)) entry.validated_at = Date.now() - 300_001
    f.clearCalls()
    const current = await f.target(parseTarget(stableRef), options)
    expect(current.record.description).toBe("New metadata description")
    expect(current.snapshot_id).toBe(first.snapshot_id)
    expect(current.files).toEqual(first.files)
    expect(new TextDecoder().decode(f.selectedBytes(current, current.entrypoint))).toContain(
      "description: Authored description.",
    )
    expect(f.bodyCalls().length).toBe(1)
    expect(f.semanticWrites().length).toBe(0)
    expect(f.records.size).toBe(recordsBefore)
  })
})
