import { expect, test } from "bun:test"
import { Effect } from "effect"
import { consume, decodeConsumeResult } from "../src/consumer.ts"
import { property } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { prepareSharedProfileChange } from "../src/shared-profile.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  currentLibrary as library,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
  currentId as id,
  currentRich as rich,
  currentDigest as digest,
} from "./shared-current-fixture.ts"

async function consumer(readMaxAge: number) {
  const f = currentSnapshotFixture()
  const plan = await f.run(
    prepareSharedProfileChange(library, {
      profile: {
        profile_id: "daily",
        name: "Daily",
        enabled: true,
        freshness: {
          default: { read_max_age_ms: 600_000 },
          skills: [
            {
              skill_id: "demo",
              read_max_age_ms: readMaxAge,
              source_check_max_age_ms: 86_400_000,
            },
          ],
        },
      },
      expectedFingerprint: null,
    }),
  )
  const envelope = canonicalSharedJson({
    version: 1,
    operation_id: plan.operation_id,
    payload: plan.payload,
  })
  f.records.set(plan.record_id, {
    object: "page",
    id: id(500),
    parent: {
      type: "data_source_id",
      data_source_id: library.records.data_source_id,
      database_id: library.records.database_id,
    },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: "Daily" }] },
      "Record ID": rich("record", plan.record_id),
      Kind: { id: "kind", type: "select", select: { name: "profile" } },
      "Entity ID": rich("entity", "daily"),
      Hash: rich("hash", digest(envelope)),
      Payload: rich("payload", envelope),
      Skill: { id: "skill", type: "relation", relation: [], has_more: false },
      Origin: { id: "origin", type: "relation", relation: [], has_more: false },
      Resource: { id: "resource", type: "files", files: [] },
    },
  })
  f.json.set("config.json", {
    shared_profile: { library_id: library.library_id, profile_id: "daily" },
  })
  return f
}
const options = { library: library.library_id }
const current = parseTarget("skill://demo/SKILL.md?library=00000000-0000-4000-8000-000000000002")
function observations(f: ReturnType<typeof currentSnapshotFixture>) {
  return [...f.json.entries()]
    .filter(([key]) => key.startsWith("cache/latest/"))
    .map(([, value]) => property(value))
}

test("strict consume proof retains the effective shared freshness evidence", async () => {
  const f = await consumer(10_000)
  const input = {
    version: 1 as const,
    targets: ["skill://demo/SKILL.md?library=00000000-0000-4000-8000-000000000002"],
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
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
})

test("a day-long Skill body policy cannot postpone independent current eligibility checks", async () => {
  const f = await consumer(86_400_000)
  const first = await f.target(parseTarget(skillPage), options)
  for (const observation of observations(f)) observation.validated_at = Date.now() - 300_001
  property(f.main.properties).Enabled = { id: "enabled", type: "checkbox", checkbox: false }
  f.clearCalls()
  await expect(f.target(current, options)).rejects.toThrow("disabled")
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
  expect(f.json.get(`snapshots/${first.snapshot_id}.json`)).toBeDefined()
})

test("explicit force refresh wins over the selected shared body duration", async () => {
  const f = await consumer(86_400_000)
  const first = await f.target(parseTarget(skillPage), options)
  f.clearCalls()
  const forced = await f.target(current, { ...options, maxAge: 0 })
  expect(forced.snapshot_id).toBe(first.snapshot_id)
  expect(forced.freshness).toMatchObject({ max_age_ms: 0, policy_source: "explicit" })
  expect(f.bodyCalls()).toHaveLength(3)
  expect(f.semanticWrites()).toHaveLength(0)
})
