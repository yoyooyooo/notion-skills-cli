import { expect, test } from "@effect/vitest"

import { Effect } from "effect"
import { readFile, rename } from "node:fs/promises"

import { join } from "node:path"

import { once } from "node:events"
import { property } from "../src/model.ts"

import {
  bindSync,
  planSync,
  applySync,
  syncStatus,
  unbindSync,
  stableSyncJson,
} from "../src/sync.ts"

import { page, guide, fixture, code } from "./sync-fixture.ts"
test("S1/P2 equal bind initializes once and repetition has no mutation", async () => {
  const f = await fixture()
  const bound = await f.bind()
  expect(bound.baseline_initialized).toBe(true)
  const before = stableSyncJson(f.bases())
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("unchanged")
  await f.run(applySync(plan.plan_id))
  expect(f.mutations()).toBe(0)
  expect(stableSyncJson(f.bases())).toBe(before)
  expect((await f.bind()).reused).toBe(true)
})

test("S2/P2 differing bind has explicit uninitialized state; dry-run stores no binding/base", async () => {
  const f = await fixture()
  await f.editLocal("Different local guide.\n")
  const preview = await f.run(bindSync(page, { path: f.root, as: "preview", dryRun: true }))
  expect(preview.baseline_initialized).toBe(false)
  expect(f.bases()).toEqual([])
  expect(f.json.has("config.json")).toBe(false)
  const bound = await f.bind()
  expect(bound.status).toBe("needs_initialization")
  const conflict = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(code(conflict)).toBe("SYNC_INITIALIZATION_REQUIRED")
  const plan = await f.run(planSync(bound.binding.id, { from: "notion" }))
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain("Original guide")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
})

test("S8 registration follows canonical page identity after remote rename", async () => {
  const f = await fixture()
  const bound = await f.bind()
  f.renameRemote("Renamed Skill")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.binding.page_id).toBe(page)
  expect(plan.bindings[0]!.direction).toBe("pull")
  expect(plan.bindings[0]!.intended.name).toBe("Renamed Skill")
})

test("P10 unbind dry-run retains config; actual unbind invalidates old plans without content removal", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const plan = await f.run(planSync(bound.binding.id))
  const bases = stableSyncJson(f.bases())
  await f.run(unbindSync(bound.binding.id, { dryRun: true }))
  expect((await f.run(syncStatus(bound.binding.id))).bindings).toHaveLength(1)
  await f.run(unbindSync(bound.binding.id))
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(stableSyncJson(f.bases())).toBe(bases)
  expect(await readFile(join(f.root, "SKILL.md"), "utf8")).toContain("Sample")
})

test("P10 label collision cannot redirect a registered binding", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const other = join(f.scratch, "label-target")
  expect(
    code(await f.run(bindSync(page, { path: other, as: bound.binding.label }).pipe(Effect.result))),
  ).toBe("SYNC_BINDING_CONFLICT")
  expect(property(f.json.get("config.json")).sync_bindings as unknown[]).toHaveLength(1)
  expect(f.mutations()).toBe(0)
})

test("S2 explicit local initialization selects only registered remote identity", async () => {
  const f = await fixture()
  await f.editLocal("# Guide\n\nLocal initialization.\n")
  const bound = await f.bind()
  expect(bound.baseline_initialized).toBe(false)
  await f.run(applySync((await f.run(planSync(bound.binding.id, { from: "local" }))).plan_id))
  expect(f.remoteGuide()).toContain("Local initialization")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
})

test("P10 duplicate edge with differing explicit label preserves original registration", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const configurationBefore = stableSyncJson(f.json.get("config.json"))
  const baselinesBefore = stableSyncJson(f.bases())
  const mutationsBefore = f.mutations()
  const result = await f.run(
    bindSync(page, { path: f.root, as: " different-label " }).pipe(Effect.result),
  )
  expect(code(result)).toBe("SYNC_BINDING_CONFLICT")
  if (result._tag === "Failure") {
    expect(property(result.failure.details).supplied_label).toBe("different-label")
    expect(property(result.failure.details).registered_label).toBe(bound.binding.label)
  }
  expect(stableSyncJson(f.json.get("config.json"))).toBe(configurationBefore)
  expect(stableSyncJson(f.bases())).toBe(baselinesBefore)
  expect(f.mutations()).toBe(mutationsBefore)
  expect((await f.bind()).reused).toBe(true)
})
