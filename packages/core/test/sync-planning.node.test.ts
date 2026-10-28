import { expect, test } from "@effect/vitest"

import { Effect } from "effect"
import { readFile, writeFile } from "node:fs/promises"

import { join } from "node:path"

import { property } from "../src/model.ts"

import { sha256 } from "../src/store.ts"

import { planSync, applySync, stableSyncJson } from "../src/sync.ts"

import { page, guide, encoder, fixture, code } from "./sync-fixture.ts"
test("S6 whole-Skill conflict retains nonexecutable plan and unchanged baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const base = stableSyncJson(f.bases())
  await f.editLocal("Local conflicting content.\n")
  f.remoteEdit("Remote conflicting content.\n")
  const result = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(code(result)).toBe("SYNC_CONFLICT")
  const rejected = [...f.json.values()].find(
    (value) => property(value).format === "ntn-skills-sync-plan",
  )!
  expect(property(rejected).applicable).toBe(false)
  expect(code(await f.run(applySync(String(property(rejected).plan_id)).pipe(Effect.result)))).toBe(
    "SYNC_CONFLICT",
  )
  expect(stableSyncJson(f.bases())).toBe(base)
  expect(f.mutations()).toBe(0)
})

test("S9 distinct local candidates conflict before batch writes", async () => {
  const f = await fixture()
  const a = await f.bind()
  const copy = join(f.scratch, "copy")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
      content,
      [],
      "fixture-copy",
    ),
  )
  await f.bind(copy, "copy")
  await f.editLocal("Candidate A.\n")
  await f.editLocal("Candidate B.\n", copy)
  expect(code(await f.run(planSync(undefined, { all: true }).pipe(Effect.result)))).toBe(
    "SYNC_CONFLICT",
  )
  expect(f.mutations()).toBe(0)
  expect(a.binding.page_id).toBe(page)
})

test("P3 invalid selection fails before provider calls", async () => {
  const f = await fixture()
  const before = f.calls.length
  for (const [binding, options] of [
    [undefined, {}],
    ["test", { all: true }],
    [undefined, { all: true, from: "local" as const }],
  ] as const) {
    expect(code(await f.run(planSync(binding, options).pipe(Effect.result)))).toBe(
      "INVALID_ARGUMENT",
    )
  }
  expect(f.calls.length).toBe(before)
})

test("P4/P9 deterministic copied plans apply; tampering and occupied output cannot overwrite", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Reviewed candidate.\n")
  const output = join(f.scratch, "review.json")
  const plan = await f.run(planSync(bound.binding.id, { output }))
  expect((await f.run(planSync(bound.binding.id, { output }))).plan_id).toBe(plan.plan_id)
  const second = join(f.scratch, "occupied.json")
  f.copies.set(second, encoder.encode("occupied"))
  expect(
    code(await f.run(planSync(bound.binding.id, { output: second }).pipe(Effect.result))),
  ).toBe("OUTPUT_CONFLICT")
  const parsed = JSON.parse(await readFile(output, "utf8"))
  parsed.bindings[0].binding.logical_path = "/changed"
  await writeFile(join(f.scratch, "tampered.json"), JSON.stringify(parsed))
  expect(code(await f.run(applySync(join(f.scratch, "tampered.json")).pipe(Effect.result)))).toBe(
    "STATE_CORRUPT",
  )
  await f.run(applySync(output))
  expect(f.remoteGuide()).toContain("Reviewed candidate")
})

test("frozen record plans retain exact reviewed hashes", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("Legacy reviewed candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  const legacy = JSON.parse(JSON.stringify(f.json.get(`sync/plans/${plan.plan_id}.json`)))
  const { plan_id: _originalId, ...body } = legacy
  legacy.plan_id = `p_${await f.run(sha256(stableSyncJson(body)))}`
  f.json.set(`sync/plans/${legacy.plan_id}.json`, legacy)
  const output = join(f.scratch, "legacy-plan.json")
  await writeFile(output, stableSyncJson(legacy))
  expect((await f.run(applySync(output))).verified).toBe(true)
  expect(f.remoteGuide()).toContain("Legacy reviewed candidate")
})

test("batch preflight examines later participants before first remote write", async () => {
  const f = await fixture()
  const a = await f.bind()
  const other = join(f.scratch, "other")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(other, { allowMissing: true })),
      content,
      [],
      "fixture-other",
    ),
  )
  await f.bind(other, "other")
  await f.editLocal("Batch candidate.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  await f.editLocal("Later stale participant.\n", other)
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
  expect(a.binding.page_id).toBe(page)
})

test("S9 independent copy retains its older baseline after another edge converges", async () => {
  const f = await fixture()
  const a = await f.bind()
  const bRoot = join(f.scratch, "older-copy")
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(bRoot, { allowMissing: true })),
      original,
      [],
      "fixture-older",
    ),
  )
  const b = await f.bind(bRoot, "older")
  await f.editLocal("# Guide\n\nNew accepted version.\n")
  await f.run(applySync((await f.run(planSync(a.binding.id))).plan_id))
  const bBase = property(f.json.get(`sync/bases/${b.binding.id}.json`))
  expect(bBase.generation).toBe(1)
  const pull = await f.run(planSync(b.binding.id))
  expect(pull.bindings[0]!.direction).toBe("pull")
  await f.run(applySync(pull.plan_id))
  expect(await readFile(join(bRoot, "references/guide.md"), "utf8")).toContain(
    "New accepted version",
  )
  expect(property(f.json.get(`sync/bases/${b.binding.id}.json`)).generation).toBe(2)
})
