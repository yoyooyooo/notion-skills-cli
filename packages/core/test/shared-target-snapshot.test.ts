import { describe, expect, test } from "bun:test"
import { property } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { SHARED_FULL_BODY_MAX_AGE_MS } from "../src/shared-snapshot.ts"
import { sharedSnapshotFixture, library, skillPage, rich } from "./shared-snapshot-fixture.ts"

const options = { database: library.skills.database_id }
const stableId = "shared_skill:library-snapshot:stable-skill"
const stableRef = `skill://${encodeURIComponent(stableId)}/SKILL.md`

function latestEntries(fixture: ReturnType<typeof sharedSnapshotFixture>) {
  return [...fixture.json.entries()]
    .filter(([key]) => key.startsWith("cache/latest/"))
    .map(([, value]) => property(value))
}

describe("standard targetSnapshot shared-library integration", () => {
  test("cold page ID then page ID and stable reference TTL hits use one shared identity and zero requests", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    expect(first.record.id).toBe(stableId)
    expect(first.record.locator.type).toBe("shared_skill")
    expect(f.readBodyCount()).toBe(3)
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
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(stableRef), options)
    expect(first.record.id).toBe(stableId)
    expect(first.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/1.md",
      "references/2.md",
    ])
    expect(f.readBodyCount()).toBe(3)
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
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    for (const entry of latestEntries(f)) entry.validated_at = Date.now() - 300_001
    f.clearCalls()
    const checked = await f.target(parseTarget(stableRef), options)
    expect(checked.snapshot_id).toBe(first.snapshot_id)
    expect(checked.source).toBe("notion")
    expect(checked.freshness?.validation).toBe("metadata")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`),
      ),
    ).toHaveLength(1)
    expect(
      f.calls.filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`),
      ),
    ).toHaveLength(2)
    expect(f.calls.some((call) => /v1\/pages\/.*\/children/.test(call.path))).toBe(false)
  })

  test("full-body deadline defeats a fresh metadata TTL without mutating the previous snapshot", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const saved = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    for (const entry of latestEntries(f)) {
      entry.validated_at = Date.now()
      entry.shared_body_valid_until = Date.now() - 1
    }
    for (const [key, value] of f.json) {
      if (!key.startsWith("cache/shared-file-observations/")) continue
      const entry = property(value)
      if (!Array.isArray(entry.observations)) throw new Error("Missing observation fixture")
      entry.observations = entry.observations.map((observation) => ({
        ...property(observation),
        body_verified_at: Date.now() - SHARED_FULL_BODY_MAX_AGE_MS - 1,
      }))
    }
    // This controlled edit deliberately does not advance last_edited_time.
    f.bodies.set(skillPage, "Same timestamp, different body\n")
    f.clearCalls()
    const current = await f.target(parseTarget(stableRef), options)
    expect(f.readBodyCount()).toBe(3)
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(saved)
  })

  test("full-body revalidation of unchanged bytes renews only observation state, preserving snapshot bytes", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const saved = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    f.clearCalls()
    const refreshed = await f.target(parseTarget(stableRef), { ...options, refresh: true })
    expect(f.readBodyCount()).toBe(3)
    expect(f.writeCount()).toBe(0)
    expect(refreshed.snapshot_id).toBe(first.snapshot_id)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(saved)
    expect(latestEntries(f)).toHaveLength(2)
  })

  test("fixed pins remain exact and offline after current body changes or the Skill is disabled", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    f.bodies.set(skillPage, "New current body\n")
    property(f.main.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
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

  test("known pending intent blocks a current TTL hit until the original shared event is confirmed", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const originalManifest = structuredClone(f.json.get(`snapshots/${first.snapshot_id}.json`))
    f.bodies.set(skillPage, "Edited body with an unknown adoption result\n")
    f.main.last_edited_time = new Date(
      Date.parse(String(f.main.last_edited_time)) + 1,
    ).toISOString()
    f.unknownRecord("file_event", false)
    await expect(f.target(parseTarget(stableRef), { ...options, refresh: true })).rejects.toThrow()
    const pending = [...f.json.entries()].filter(([key]) =>
      key.startsWith("operations/shared-observation-pending/"),
    )
    expect(pending).toHaveLength(1)

    f.clearCalls()
    await expect(f.target(parseTarget(stableRef), options)).rejects.toThrow()
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.calls.length).toBeGreaterThan(0)
    expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toEqual(originalManifest)

    f.clearCalls()
    const pin = await f.target(
      { ...parseTarget(stableRef), snapshot: first.snapshot_id },
      { offline: true },
    )
    const offline = await f.target(parseTarget(stableRef), { ...options, offline: true })
    expect(pin.snapshot_id).toBe(first.snapshot_id)
    expect(offline.snapshot_id).toBe(first.snapshot_id)
    expect(f.calls).toHaveLength(0)

    // Shared confirmation settles the original operation; local state alone
    // cannot claim completion or create a replacement observation.
    const plan = property(property(pending[0]?.[1]).plan)
    const originalEvent = property(plan.event)
    f.seedFact(originalEvent, "file_event", String(plan.file_id), String(originalEvent.event_id))
    f.clearCalls()
    const reconciled = await f.target(parseTarget(stableRef), options)
    expect(reconciled.snapshot_id).not.toBe(first.snapshot_id)
    expect(f.readBodyCount()).toBe(1)
    expect(f.writeCount()).toBe(0)
    expect(
      [...f.json.keys()].some((key) => key.startsWith("operations/shared-observation-pending/")),
    ).toBe(false)
    f.clearCalls()
    const hit = await f.target(parseTarget(stableRef), options)
    expect(hit.snapshot_id).toBe(reconciled.snapshot_id)
    expect(f.calls).toHaveLength(0)
  })

  test("an explicitly refreshed disabled Skill fails before fetching or writing its body", async () => {
    const f = sharedSnapshotFixture()
    await f.target(parseTarget(skillPage), options)
    property(f.main.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    f.clearCalls()
    await expect(f.target(parseTarget(skillPage), { ...options, refresh: true })).rejects.toThrow(
      "disabled",
    )
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("metadata-only Description changes affect the generated frontmatter without taking ownership", async () => {
    const f = sharedSnapshotFixture()
    const first = await f.target(parseTarget(skillPage), options)
    const recordsBefore = f.records.size
    property(f.main.properties).description = rich("description", "New metadata description")
    f.main.last_edited_time = new Date(Date.now() - 1).toISOString()
    for (const entry of latestEntries(f)) entry.validated_at = Date.now() - 300_001
    f.clearCalls()
    const current = await f.target(parseTarget(stableRef), options)
    expect(current.record.description).toBe("New metadata description")
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(f.readBodyCount()).toBe(1)
    expect(f.writeCount()).toBe(0)
    expect(f.records.size).toBe(recordsBefore)
  })
})
