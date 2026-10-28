import { expect, test } from "@effect/vitest"

import { Effect } from "effect"
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises"

import { join } from "node:path"

import { once } from "node:events"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"

import { snapshotPortable } from "../src/export.ts"
import { openSkill } from "../src/snapshot.ts"

import { bindSync, planSync, applySync, stableSyncJson } from "../src/sync.ts"

import { page, guide, encoder, fixture, code } from "./sync-fixture.ts"
test("S3 local reference edit uses bound page writer and verifies baseline", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\nLocal update.\n")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("push")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  const applied = await f.run(applySync(plan.plan_id))
  expect(applied.verified).toBe(true)
  expect(f.remoteGuide()).toContain("Local update")
  expect(property(f.bases()[0]![1]).generation).toBe(2)
  expect(f.calls.some((call) => call.path === "v1/pages" && call.method === "POST")).toBe(false)
})

test("S4 remote-only reference edit pulls the whole skill preserving unrelated local bytes", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await writeFile(join(f.root, "personal.txt"), "unrelated sentinel")
  f.remoteEdit("# Guide\n\nRemote reference change.\n")
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("pull")
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
    "Remote reference change",
  )
  expect(await readFile(join(f.root, "personal.txt"), "utf8")).toBe("unrelated sentinel")
  expect(await readFile(join(f.root, "SKILL.md"), "utf8")).toContain("Sample")
  expect(f.mutations()).toBe(0)
})

test("S5 independently equal changed content advances baseline without writing", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const text = "# Guide\n\nConverged independent edit.\n"
  await f.editLocal(text)
  f.remoteEdit(text)
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("advance_baseline")
  await f.run(applySync(plan.plan_id))
  expect(f.mutations()).toBe(0)
  expect(property(f.bases()[0]![1]).generation).toBe(2)
})

for (const changed of ["local", "remote"] as const)
  test(`S7 ${changed} edit invalidates saved plan before any effect`, async () => {
    const f = await fixture()
    const bound = await f.bind()
    await f.editLocal("Planned local content.\n")
    const plan = await f.run(planSync(bound.binding.id))
    if (changed === "local") await f.editLocal("Independent local edit.\n")
    else f.remoteEdit("Independent remote edit.\n")
    const base = stableSyncJson(f.bases())
    expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
    expect(f.mutations()).toBe(0)
    expect(stableSyncJson(f.bases())).toBe(base)
  })

test("S11 missing established root and corrupt baseline are explicit errors", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await rename(f.root, join(f.retained, "missing-root"))
  const result = await f.run(planSync(bound.binding.id).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  f.json.delete(`sync/bases/${bound.binding.id}.json`)
  expect(code(await f.run(planSync(bound.binding.id).pipe(Effect.result)))).toBe("STATE_CORRUPT")
  expect(f.mutations()).toBe(0)
})

test("S12 page-only spacing is semantically stable and code fences remain significant", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await f.editLocal("# Guide\n\n\nOriginal guide.\n\n")
  const samePlan = await f.run(planSync(bound.binding.id))
  expect(samePlan.bindings[0]!.direction).toBe("unchanged")
  await f.editLocal("# Guide\n\n```text\n  significant code\n```\n")
  expect((await f.run(planSync(bound.binding.id))).bindings[0]!.direction).toBe("push")
})

test("S14 ordinary missing leaf requires explicit Notion initialization", async () => {
  const f = await fixture()
  const leaf = join(f.scratch, "absent")
  const bound = await f.bind(leaf, "absent")
  expect(bound.baseline_initialized).toBe(false)
  const plan = await f.run(planSync(bound.binding.id, { from: "notion" }))
  await f.run(applySync(plan.plan_id))
  expect(await readFile(join(leaf, "SKILL.md"), "utf8")).toContain("Sample")
  expect(f.mutations()).toBe(0)
  const dangling = join(f.scratch, "dangling")
  await symlink("missing-destination", dangling)
  expect(
    (await f.run(bindSync(page, { path: dangling, as: "dangling" }).pipe(Effect.result)))._tag,
  ).toBe("Failure")
  expect(f.bases()).toHaveLength(1)
})

test("S10 duplicate real directory is committed once with independent logical links", async () => {
  const f = await fixture()
  const a = await f.bind()
  const link = join(f.scratch, "distribution")
  await symlink("skill", link)
  const b = await f.bind(link, "distribution")
  expect(a.binding.id).not.toBe(b.binding.id)
  f.remoteEdit("# Guide\n\nOne real target.\n")
  let referenceWrites = 0
  f.faults.localBoundary = async (boundary) => {
    if (boundary.kind === "replace" && boundary.path.endsWith("references/guide.md"))
      referenceWrites++
  }
  const plan = await f.run(planSync(undefined, { all: true }))
  await f.run(applySync(plan.plan_id))
  expect(referenceWrites).toBeGreaterThan(0)
  expect(f.bases().map(([, value]) => property(value).generation)).toEqual([2, 2])
  expect(await readFile(join(link, "references/guide.md"), "utf8")).toContain("One real target")
})

test("S13 removing a reference retains local bytes and child page remains readable", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await rename(join(f.root, "references/guide.md"), join(f.retained, "user-removed-guide"))
  const plan = await f.run(planSync(bound.binding.id))
  expect(plan.bindings[0]!.direction).toBe("push")
  await f.run(applySync(plan.plan_id))
  const remote = await f.run(openSkill(page))
  expect(remote.references?.some((reference) => reference.id === guide)).toBe(false)
  expect(f.remoteGuide()).toContain("Original guide")
  expect(await readFile(join(f.retained, "user-removed-guide"), "utf8")).toContain("Original guide")
})

test("S11 incomplete/denied remote reads never publish shortened common base", async () => {
  for (const fault of ["denyRemote", "incompleteRemote", "unknownRemote"] as const) {
    const f = await fixture()
    const bound = await f.bind()
    const base = stableSyncJson(f.bases())
    f.faults[fault] = true
    expect(code(await f.run(planSync(bound.binding.id).pipe(Effect.result)))).toBe(
      fault === "denyRemote" ? "ACCESS_DENIED" : "MARKDOWN_INCOMPLETE",
    )
    expect(stableSyncJson(f.bases())).toBe(base)
    expect(f.mutations()).toBe(0)
  }
})

test("S3 exact Files storage preserves binary additions modifications and removals", async () => {
  const f = await fixture(true)
  const bound = await f.bind()
  await mkdir(join(f.root, "assets"))
  const bytes = new Uint8Array([0, 255, 11, 0, 97])
  await writeFile(join(f.root, "assets/fixture.bin"), bytes)
  await writeFile(join(f.root, "references/guide.md"), "# Guide\n\nExact reference addition.\n")
  const mainBytes = encoder.encode(
    (await readFile(join(f.root, "SKILL.md"), "utf8")) + "\nByte exact main addition.\n",
  )
  await writeFile(join(f.root, "SKILL.md"), mainBytes)
  const added = await f.run(planSync(bound.binding.id))
  expect(added.bindings[0]!.mode).toBe("exact")
  await f.run(applySync(added.plan_id))
  let portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.find((file) => file.path === "assets/fixture.bin")!.bytes).toEqual(bytes)
  expect(portable.files.find((file) => file.path === "SKILL.md")!.bytes).toEqual(mainBytes)
  expect(portable.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/fixture.bin",
    "references/guide.md",
  ])
  const changed = new Uint8Array([1, 254, 10, 1, 98])
  await writeFile(join(f.root, "assets/fixture.bin"), changed)
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.find((file) => file.path === "assets/fixture.bin")!.bytes).toEqual(changed)
  await rename(join(f.root, "assets/fixture.bin"), join(f.retained, "removed-binary"))
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  portable = await f.run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  expect(portable.files.some((file) => file.path === "assets/fixture.bin")).toBe(false)
  expect(await readFile(join(f.retained, "removed-binary"))).toEqual(Buffer.from(changed))
})

test("S10 incompatible page mapping on one real target is rejected before effects", async () => {
  const f = await fixture()
  const bound = await f.bind()
  const config = property(f.json.get("config.json"))
  f.json.set("config.json", {
    ...config,
    sync_bindings: [{ ...bound.binding, page_id: "33333333-3333-4333-8333-333333333333" }],
  })
  const result = await f.run(bindSync(page, { path: f.root, as: "other-page" }).pipe(Effect.result))
  expect(code(result)).toBe("SYNC_TARGET_CONFLICT")
  expect(f.mutations()).toBe(0)
})

test("S3 reference addition allocates once and subsequent sync performs no writer calls", async () => {
  const f = await fixture()
  const bound = await f.bind()
  await mkdir(join(f.root, "references/nested"))
  await writeFile(join(f.root, "references/nested/policy.md"), "# Policy\n\nAdded child policy.\n")
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  const remote = await f.run(openSkill(page))
  expect(
    remote.references?.some((reference) => reference.path === "references/nested/policy.md"),
  ).toBe(true)
  const created = remote.references?.find(
    (reference) => reference.path === "references/nested/policy.md",
  )
  expect(created).toBeDefined()
  const portable = await f.run(snapshotPortable(remote))
  expect(portable.files.find((file) => file.path === "references/nested/policy.md")?.bytes).toEqual(
    encoder.encode("# Policy\n\nAdded child policy.\n"),
  )
  expect(
    f.calls.some(
      (call) =>
        call.path === `v1/blocks/${created!.id}/children?page_size=100` && call.method === "GET",
    ),
  ).toBe(true)
  expect(f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")).toHaveLength(
    1,
  )
  const mutations = f.mutations()
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(f.mutations()).toBe(mutations)
})

test("S15 one remote update converges two unchanged independent copies", async () => {
  const f = await fixture()
  await f.bind()
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  const roots = [join(f.scratch, "copy-one"), join(f.scratch, "copy-two")]
  for (const [index, root] of roots.entries()) {
    await f.run(
      f.filesystem.commit(
        await f.run(f.filesystem.inspect(root, { allowMissing: true })),
        original,
        [],
        `fixture-copy-${index}`,
      ),
    )
    await f.bind(root, `copy-${index}`)
  }
  await f.editLocal("# Guide\n\nOne accepted fan-out.\n")
  const plan = await f.run(planSync(undefined, { all: true }))
  expect(plan.bindings.filter((edge) => edge.direction === "push")).toHaveLength(1)
  const result = await f.run(applySync(plan.plan_id))
  expect(result.receipt.status).toBe("complete")
  expect(result.bindings.every((entry) => entry.generation_after === 2)).toBe(true)
  expect(
    f.calls.filter((call) => call.path === `v1/pages/${guide}/markdown` && call.method === "PATCH"),
  ).toHaveLength(1)
  for (const root of roots)
    expect(await readFile(join(root, "references/guide.md"), "utf8")).toContain(
      "One accepted fan-out",
    )
})

test("S13 Notion reference exclusion removes local inclusion through retention", async () => {
  const f = await fixture()
  const bound = await f.bind()
  // The provider is an independent editor: drive its existing property API, not sync.
  await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      yield* api.request(
        `v1/pages/${page}`,
        { properties: { references: { rich_text: [] } } },
        { method: "PATCH" },
      )
    }),
  )
  const plan = await f.run(planSync(bound.binding.id))
  expect(
    plan.bindings[0]!.actions.some(
      (action) => action.path === "references/guide.md" && action.action === "remove",
    ),
  ).toBe(true)
  const result = await f.run(applySync(plan.plan_id))
  expect(
    result.bindings[0]!.retained.some((entry) => entry.path.endsWith("references/guide.md")),
  ).toBe(true)
  expect(f.remoteGuide()).toContain("Original guide")
  expect(
    (
      await f.run(
        f.filesystem.inspect(f.root, { trackedPaths: ["SKILL.md", "references/guide.md"] }),
      )
    ).content!.files.some((file) => file.path === "references/guide.md"),
  ).toBe(false)
})
