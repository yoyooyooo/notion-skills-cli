import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { consume, decodeConsumeResult } from "../src/consumer.ts"
import { property } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { saveSharedProfile } from "../src/shared-profile.ts"
import { library, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

const roots: string[] = []
afterAll(async () => {
  if (process.platform === "darwin")
    for (const root of roots) await Effect.runPromise(trashPath(root))
})
async function consumer(readMaxAge: number) {
  const root = mkdtempSync(join(tmpdir(), "ntn-profile-consumer-"))
  roots.push(root)
  const f = sharedSnapshotFixture({ root })
  await f.run(
    saveSharedProfile(library, {
      profile: {
        profile_id: "daily",
        name: "Daily",
        enabled: true,
        freshness: {
          default: { read_max_age_ms: 600_000 },
          skills: [
            {
              skill_id: "stable-skill",
              read_max_age_ms: readMaxAge,
              source_check_max_age_ms: 86_400_000,
            },
          ],
        },
      },
      expectedFingerprint: null,
    }),
  )
  f.json.set("config.json", {
    shared_profile: { library_entry: library.skills.database_id, profile_id: "daily" },
  })
  return f
}
const options = { database: library.skills.database_id }
const current = parseTarget("skill://shared_skill%3Alibrary-snapshot%3Astable-skill/SKILL.md")
function observations(f: ReturnType<typeof sharedSnapshotFixture>) {
  return [...f.json.entries()]
    .filter(([key]) => key.startsWith("cache/latest/"))
    .map(([, value]) => property(value))
}

test("strict consume proof retains the effective shared freshness evidence", async () => {
  const f = await consumer(10_000)
  const input = {
    version: 1 as const,
    targets: ["skill://shared_skill%3Alibrary-snapshot%3Astable-skill/SKILL.md"],
    purpose: "use" as const,
  }
  const result = await f.run(consume(input, options))
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  expect(await f.run(decodeConsumeResult(result, input))).toEqual(result)
  expect(result.preparation.nodes[0]).toMatchObject({
    freshness: {
      max_age_ms: 10_000,
      policy_source: "skill",
      full_body_max_age_ms: 86_400_000,
      current_eligibility_max_age_ms: 300_000,
    },
  })
})

test("the real current consumer resolves the stable Skill override and a warm hit never renews it", async () => {
  const f = await consumer(10_000)
  const first = await f.target(parseTarget(skillPage), options)
  expect(first.freshness).toMatchObject({
    max_age_ms: 10_000,
    policy_source: "skill",
    full_body_max_age_ms: 86_400_000,
    current_eligibility_max_age_ms: 300_000,
  })
  const retained = structuredClone(observations(f))
  f.clearCalls()
  const warm = await f.target(current, options)
  expect(warm.source).toBe("local_cache")
  expect(warm.freshness?.validated_at).toBe(first.freshness?.validated_at)
  expect(observations(f)).toEqual(retained)
  expect(f.calls).toHaveLength(0)
  for (const observation of observations(f)) observation.validated_at = Date.now() - 10_001
  const expired = structuredClone(observations(f))
  const offline = await f.target(current, { ...options, offline: true })
  expect(offline.freshness?.stale).toBe(true)
  expect(f.calls).toHaveLength(0)
  expect(observations(f)).toEqual(expired)
  const refreshed = await f.target(current, options)
  expect(refreshed.source).toBe("notion")
  expect(refreshed.snapshot_id).toBe(first.snapshot_id)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
})

test("a day-long Skill body policy cannot postpone independent current eligibility checks", async () => {
  const f = await consumer(86_400_000)
  const first = await f.target(parseTarget(skillPage), options)
  for (const observation of observations(f)) observation.validated_at = Date.now() - 300_001
  property(f.main.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
  f.clearCalls()
  await expect(f.target(current, options)).rejects.toThrow("disabled")
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toBeDefined()
})

test("explicit force refresh wins over the selected shared body duration", async () => {
  const f = await consumer(86_400_000)
  const first = await f.target(parseTarget(skillPage), options)
  f.clearCalls()
  const forced = await f.target(current, { ...options, maxAge: 0 })
  expect(forced.snapshot_id).toBe(first.snapshot_id)
  expect(forced.freshness).toMatchObject({ max_age_ms: 0, policy_source: "explicit" })
  expect(f.readBodyCount()).toBe(3)
  expect(f.writeCount()).toBe(0)
})
