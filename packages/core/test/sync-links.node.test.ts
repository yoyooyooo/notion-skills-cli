import { expect, test } from "@effect/vitest"

import { Effect } from "effect"
import { readFile, readlink, realpath, rename, symlink, writeFile } from "node:fs/promises"

import { join } from "node:path"

import { property } from "../src/model.ts"

import { planSync, applySync, reconcileSync } from "../src/sync.ts"

import { guide, fixture, code } from "./sync-fixture.ts"
test("L4 byte-identical symlink retarget invalidates reviewed target", async () => {
  const f = await fixture()
  const link = join(f.scratch, "logical")
  await symlink("skill", link)
  const bound = await f.bind(link, "linked")
  const copy = join(f.scratch, "same-bytes")
  const content = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
      content,
      [],
      "fixture-copy",
    ),
  )
  const plan = await f.run(planSync(bound.binding.id))
  await rename(link, join(f.retained, "old-link"))
  await symlink("same-bytes", link)
  expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("SYNC_PLAN_STALE")
  expect(f.mutations()).toBe(0)
})

test("L6 actual commit boundary link drift retains original common baseline", async () => {
  const f = await fixture()
  const link = join(f.scratch, "logical-commit")
  await symlink("skill", link)
  const bound = await f.bind(link, "logical-commit")
  const replacement = join(f.scratch, "replacement")
  const original = (await f.run(f.filesystem.inspect(f.root))).content!
  await f.run(
    f.filesystem.commit(
      await f.run(f.filesystem.inspect(replacement, { allowMissing: true })),
      original,
      [],
      "fixture-replacement",
    ),
  )
  f.remoteEdit("Fresh remote pull.\n")
  const plan = await f.run(planSync(bound.binding.id))
  let retargeted = false
  f.faults.localBoundary = async () => {
    if (retargeted) return
    retargeted = true
    await rename(link, join(f.retained, "pre-commit-link"))
    await symlink("replacement", link)
  }
  expect((await f.run(applySync(plan.plan_id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(await readFile(join(replacement, "references/guide.md"), "utf8")).toContain(
    "Original guide",
  )
  expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain("Original guide")
})

test("R2 recovery fences byte-identical per-file symlink retarget", async () => {
  const f = await fixture()
  const actual = join(f.scratch, "linked-guide.md")
  await rename(join(f.root, "references/guide.md"), actual)
  await symlink(actual, join(f.root, "references/guide.md"))
  const bound = await f.bind()
  await writeFile(actual, "Accepted linked candidate.\n")
  const plan = await f.run(planSync(bound.binding.id))
  f.faults.lostResponse = true
  await f.run(applySync(plan.plan_id).pipe(Effect.result))
  const alternate = join(f.scratch, "alternate-guide.md")
  await writeFile(alternate, await readFile(actual))
  await rename(join(f.root, "references/guide.md"), join(f.retained, "original-guide-link"))
  await symlink(alternate, join(f.root, "references/guide.md"))
  const mutations = f.mutations()
  expect(code(await f.run(reconcileSync(bound.binding.id).pipe(Effect.result)))).toBe(
    "SYNC_PLAN_STALE",
  )
  expect(property(f.bases()[0]![1]).generation).toBe(1)
  expect(f.mutations()).toBe(mutations)
})

test("L1/L3 checked pull preserves multi-hop roots and final-file links", async () => {
  const f = await fixture()
  const parent = join(f.scratch, "linked-parent")
  await symlink(f.scratch, parent)
  const first = join(f.scratch, "first-hop")
  const second = join(f.scratch, "second-hop")
  await symlink("second-hop", first)
  await symlink("skill", second)
  const actual = join(f.scratch, "external-reference.md")
  await rename(join(f.root, "references/guide.md"), actual)
  await symlink(actual, join(f.root, "references/guide.md"))
  const bound = await f.bind(join(parent, "first-hop"), "links")
  f.remoteEdit("# Guide\n\nUpdated through all links.\n")
  await f.run(applySync((await f.run(planSync(bound.binding.id))).plan_id))
  expect(await readFile(actual, "utf8")).toContain("Updated through all links")
  const inspection = await f.run(f.filesystem.inspect(join(parent, "first-hop")))
  for (const [logical, target] of [
    [parent, f.scratch],
    [first, "second-hop"],
    [second, "skill"],
  ] as const) {
    expect(await readlink(logical)).toBe(target)
    const resolvedParent = await realpath(join(logical, ".."))
    const finalName = logical.split("/").at(-1)!
    expect(
      inspection.proof.root.nodes.some(
        (node) =>
          node.kind === "link" &&
          node.path === join(resolvedParent, finalName) &&
          node.link === target,
      ),
    ).toBe(true)
  }
  expect(await readlink(join(f.root, "references/guide.md"))).toBe(actual)
  expect(
    inspection.proof.files
      .find((file) => file.path === "references/guide.md")!
      .proof.nodes.some((node) => node.kind === "link" && node.link === actual),
  ).toBe(true)
})
