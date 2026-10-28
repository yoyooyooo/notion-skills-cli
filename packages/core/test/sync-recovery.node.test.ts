import { expect, test } from "@effect/vitest"

import { Effect } from "effect"
import { readFile, writeFile } from "node:fs/promises"

import { join } from "node:path"

import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"

import { resumePublication } from "../src/mutation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  planSync,
  applySync,
  syncStatus,
  unbindSync,
  reconcileSync,
  stableSyncJson,
} from "../src/sync.ts"

import { page, guide, fixture, code } from "./sync-fixture.ts"
test("S15/R7 one grouped push fans out with independent bases and partial receipts", async () => {
  const f = await fixture()
  const a = await f.bind()
  const bRoot = join(f.scratch, "copy-b")
  const cRoot = join(f.scratch, "copy-c")
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(bRoot, { allowMissing: true })),
      (await f.run(f.filesystem.inspect(f.root))).content!,
      [],
      "fixture-b",
    ),
  )
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(cRoot, { allowMissing: true })),
      (await f.run(f.filesystem.inspect(f.root))).content!,
      [],
      "fixture-c",
    ),
  )
  const b = await f.bind(bRoot, "copy-b")
  const c = await f.bind(cRoot, "copy-c")
  await f.editLocal("# Guide\n\nAccepted candidate.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  expect(plan.bindings.filter((edge) => edge.direction === "push")).toHaveLength(1)
  const failedEdge = plan.bindings.filter((edge) => edge.direction === "pull").at(-1)!
  f.faults.localBoundary = async (boundary) => {
    if (boundary.path.startsWith(failedEdge.local.resolved_path))
      throw fail("LOCAL_IO_ERROR", "Injected fan-out failure")
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.remoteGuide()).toContain("Accepted candidate")
  const remotePatches = f.calls.filter(
    (call) => call.path === `v1/pages/${guide}/markdown` && call.method === "PATCH",
  )
  expect(remotePatches).toHaveLength(1)
  const baselines = new Map(f.bases().map(([key, value]) => [key, property(value)]))
  for (const edge of plan.bindings) {
    expect(baselines.get(`sync/bases/${edge.binding.id}.json`)!.generation).toBe(
      edge.binding.id === failedEdge.binding.id ? 1 : 2,
    )
  }
  expect([a.binding.id, b.binding.id, c.binding.id]).toContain(failedEdge.binding.id)
  const before = f.mutations()
  expect(code(await f.run(reconcileSync(failedEdge.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  expect(f.mutations()).toBe(before)
})

test("C17 offline status consumes observation without provider calls or baseline publication", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("Unobserved remote edit.\n")
  const count = f.calls.length
  const base = stableSyncJson(f.bases())
  const status = await f.run(syncStatus(bound.binding.id))
  expect(status.bindings[0]!.provisional).toBe(true)
  expect(status.bindings[0]!.authoritative).toBe(false)
  expect(f.calls.length).toBe(count)
  const refreshed = (await f.run(syncStatus(bound.binding.id, { refresh: true }))).bindings[0]!
  expect(f.calls.length).toBeGreaterThan(count)
  expect(refreshed.authoritative).toBe(true)
  expect(refreshed.provisional).toBe(false)
  expect(refreshed.remote_freshness).toBe("validated")
  expect(refreshed.remote_validated_at).toEqual(expect.any(Number))
  expect(refreshed.remote_content_id).not.toBe(status.bindings[0]!.remote_content_id)
  expect(stableSyncJson(f.bases())).toBe(base)
})

test("R2/P8 lost response fences page until explicit publication resume; sync reconciliation never replays mutation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\nLost response candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  const stopped = await f.run(applySync(plan.plan_id).pipe(Effect.result))
  expect(code(stopped)).toBe("WRITE_OUTCOME_UNKNOWN")
  if (stopped._tag !== "Failure") throw new Error("Expected lost publication response")
  const publicationId = String(
    property(property(property(stopped.failure).details).cause_details).operation_id,
  )
  expect(publicationId).toMatch(/^p_[a-zA-Z0-9-]+$/)
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  const base = stableSyncJson(f.bases())
  const mutations = f.mutations()
  const calls = f.calls.length
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PENDING")
  expect(f.calls).toHaveLength(calls)
  for (const incomplete of [
    await f.run(planSync(bound.binding.id).pipe(Effect.result)),
    await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)),
  ]) {
    expect(code(incomplete)).toBe("PUBLICATION_INCOMPLETE")
    if (incomplete._tag === "Failure")
      expect(property(incomplete.failure.details).operation_id).toBe(publicationId)
  }
  expect(property(receipt).status).toBe("pending")
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(f.mutations()).toBe(mutations)
  const publication = await f.run(reconcilePublication(publicationId))
  expect(publication.next.argv).toEqual(["ntn-skills", "operation", "resume", publicationId])
  expect(publication.verified).toBe(false)
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(f.mutations()).toBe(mutations)
  const bodyWrites = f.calls.filter(
    (call) => call.path.endsWith("/markdown") && call.method === "PATCH",
  ).length
  await f.run(resumePublication(publicationId))
  expect(
    f.calls.filter((call) => call.path.endsWith("/markdown") && call.method === "PATCH"),
  ).toHaveLength(bodyWrites)
  expect(stableSyncJson(f.bases())).toBe(base)
  const afterResume = f.mutations()
  const reconciled = await f.run(reconcileSync(bound.binding.id))
  expect(reconciled.outcome).toBe("complete")
  expect(reconciled.baseline_advanced).toBe(true)
  expect(f.mutations()).toBe(afterResume)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

test("R4 baseline publication interruption is recovered using fresh readback only", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("# Guide\n\nPulled before publication failure.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.baselineStop = true
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STORAGE_ERROR")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const mutations = f.mutations()
  expect((await f.run(reconcileSync(bound.binding.id))).baseline_advanced).toBe(true)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.mutations()).toBe(mutations)
})

test("R4 receipt publication interruption does not advance baseline twice", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Confirmed before final receipt.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.receiptStop = true
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  await f.run(reconcileSync(bound.binding.id))
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

test("R5 local boundary failure retains baseline and recoverable operation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.remoteEdit("Remote update with failing disk.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.localBoundary = async () => {
    throw fail("LOCAL_IO_ERROR", "Injected disk failure")
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(receipt).status).toBe("pending")
})

test("R6 malformed receipt fences planning/apply explicitly instead of inventing a baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const plan = await f.run(planSync(bound.binding.id))
  f.json.set("sync/receipts/o_00000000-0000-4000-8000-000000000000.json", { broken: true })
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(f.mutations()).toBe(0)
})

test("R1/R2 interruption preserves persistent receipt and no baseline movement", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Interrupted candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.interruptBody = true
  try {
    await f.run(applySync(plan.plan_id))
  } catch {}
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(receipt).status).toBe("pending")
  const mutations = f.mutations()
  const incomplete = await f.run(reconcileSync(bound.binding.id).pipe(Effect.result))
  expect(code(incomplete)).toBe("PUBLICATION_INCOMPLETE")
  if (incomplete._tag === "Failure")
    expect(property(incomplete.failure.details).operation_id).toMatch(/^p_[a-zA-Z0-9-]+$/)
  expect(f.mutations()).toBe(mutations)
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const retainedReceipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(retainedReceipt).status).toBe("pending")
  expect(code(await f.run(planSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "PUBLICATION_INCOMPLETE",
  )
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PENDING")
})

test("R3 reference succeeds then main fails; common baseline stays old and receipt fences page", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Accepted reference before main failure.\n")
  const main = await readFile(join(f.root, "SKILL.md"), "utf8")
  await writeFile(join(f.root, "SKILL.md"), main + "\nChanged main body.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.denyMain = true
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("WRITE_PARTIAL")
  expect(f.remoteGuide()).toContain("Accepted reference")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const mutations = f.mutations()
  expect(code(await f.run(planSync(bound.binding.id, { from: "local" }).pipe(Effect.result)))).toBe(
    "PUBLICATION_INCOMPLETE",
  )
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PENDING")
  const incomplete = await f.run(reconcileSync(bound.binding.id).pipe(Effect.result))
  expect(code(incomplete)).toBe("PUBLICATION_INCOMPLETE")
  if (incomplete._tag !== "Failure") throw new Error("Expected incomplete publication")
  const publicationId = String(property(incomplete.failure.details).operation_id)
  expect(property(f.json.get(`publications/${publicationId}.json`)).state).toBe("failed")
  const receipt = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-receipt",
  )!
  expect(property(receipt).status).toBe("pending")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(f.mutations()).toBe(mutations)
  f.faults.denyMain = false
  await f.run(resumePublication(publicationId))
  const afterResume = f.mutations()
  expect((await f.run(reconcileSync(bound.binding.id))).outcome).toBe("complete")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.mutations()).toBe(afterResume)
})

test("committed direct edits pull normally while stale plans and concurrent local edits remain protected", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\nCommitted local publication.\n")
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  const base = stableSyncJson(f.bases())
  const mutations = f.mutations()
  f.remoteEdit("# Guide\n\nDirect Notion edit.\n")
  const first = await f.run(planSync(bound.binding.id))
  expect(first.bindings[0]!.direction).toBe("pull")
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(f.mutations()).toBe(mutations)

  f.remoteEdit("# Guide\n\nUpdated direct Notion edit.\n")
  expect(code(await f.run(applySync(first.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
    "Committed local publication.",
  )
  expect(f.mutations()).toBe(mutations)

  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("pull")
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
    "Updated direct Notion edit.",
  )
  expect(property(f.bases()[0]![1]).generation).toBe(3)
  expect(f.mutations()).toBe(mutations)

  const pulledBase = stableSyncJson(f.bases())
  await f.editLocal("# Guide\n\nIndependent local work.\n")
  f.remoteEdit("# Guide\n\nIndependent Notion work.\n")
  expect(code(await f.run(planSync(bound.binding.id).pipe(Effect.result)))).toBe("SYNC_CONFLICT")
  expect(stableSyncJson(f.bases())).toBe(pulledBase)
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
    "Independent local work.",
  )
  expect(f.remoteGuide()).toContain("Independent Notion work.")
  expect(f.mutations()).toBe(mutations)
}, 60_000)

test("scope drift cannot authorize a saved plan", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Scope-bound candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.changeCredential()
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
})

test("inactive retained binding can reconcile pending writes after unbind", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Unbound accepted content.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  await f.run(unbindSync(bound.binding.id))
  const base = stableSyncJson(f.bases())
  const mutations = f.mutations()
  const incomplete = await f.run(reconcileSync(bound.binding.id).pipe(Effect.result))
  expect(code(incomplete)).toBe("PUBLICATION_INCOMPLETE")
  if (incomplete._tag !== "Failure") throw new Error("Expected incomplete publication")
  expect(f.mutations()).toBe(mutations)
  expect(stableSyncJson(f.bases())).toBe(base)
  await f.run(resumePublication(String(property(incomplete.failure.details).operation_id)))
  const afterResume = f.mutations()
  expect((await f.run(reconcileSync(bound.binding.id))).outcome).toBe("complete")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.mutations()).toBe(afterResume)
})

test("R6 schema-valid empty receipt participants cannot erase a pending fence", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Pending candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  const entry = [...f.json.entries()].find(
    ([, value]) => property(value).format === "ntn-skills-sync-receipt",
  )!
  f.json.set(entry[0], { ...property(entry[1]), bindings: [] })
  const mutations = f.mutations()
  const calls = f.calls.length
  const base = stableSyncJson(f.bases())
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "STATE_CORRUPT",
  )
  expect(f.calls).toHaveLength(calls)
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(property(f.json.get(entry[0])).status).toBe("pending")
  expect(f.mutations()).toBe(mutations)
})

test("R1 failure before first content mutation retains common base and safely classifies no effects", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Prepared but never written candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.beforeRemoteWrite = true
  const base = stableSyncJson(f.bases())
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("STORAGE_ERROR")
  expect(f.mutations()).toBe(0)
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_DIVERGED",
  )
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(f.remoteGuide()).toContain("Prepared but never written candidate")
})
