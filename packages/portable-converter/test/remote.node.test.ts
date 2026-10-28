import { expect, test } from "vitest"
import { zipSync } from "fflate"
import { Effect } from "effect"
import { join } from "node:path"
import { fixture, page, database } from "../../core/test/sync-fixture.ts"
import { openSkill } from "../../core/src/snapshot.ts"
import { sha256 } from "../../core/src/store.ts"
import { planRemote, applyRemote } from "../src/remote.ts"
import { BUNDLE } from "../../core/src/portable.ts"
const encoder = new TextEncoder()
test("old remote source archive plans without mutation, formal replace writes v2 and strict reader succeeds", async () => {
  const host = await fixture(true)
  const old = zipSync({
    ".ntn-skills.json": encoder.encode(
      JSON.stringify({
        format: "ntn-skills",
        version: 1,
        name: "Sample Skill",
        description: "Use for sync tests.",
        main: "workflow.md",
      }),
    ),
    "workflow.md": encoder.encode("# Sample\n\nRead [guide](references/guide.md).\n"),
    "references/guide.md": encoder.encode("# Guide\n\nOriginal guide.\n"),
    "assets/raw.bin": new Uint8Array([0, 255, 128, 42]),
  })
  host.seedAttachment(BUNDLE, old)
  const blocked = await host.run(openSkill(page, { refresh: true }).pipe(Effect.result))
  expect(blocked).toMatchObject({ _tag: "Failure", failure: { code: "PORTABLE_UPGRADE_REQUIRED" } })
  const mutations = host.mutations()
  const plan = await host.run(planRemote(page, database, "skill"))
  expect(host.mutations()).toBe(mutations)
  expect(plan.source_inventory.find((file) => file.path === BUNDLE)?.sha256).toBe(
    await host.run(sha256(old)),
  )
  const bytes = JSON.stringify(plan)
  const hash = await host.run(sha256(bytes))
  const result = await host.run(
    applyRemote(bytes, hash, join(host.scratch, "conversion-attempt.json")),
  )
  expect(result).toMatchObject({ verified: true })
  const current = await host.run(openSkill(page, { refresh: true }))
  expect(current.record.kind).toBe("skill")
  expect(current.files.find((file) => file.path === "assets/raw.bin")?.sha256).toBe(
    await host.run(sha256(new Uint8Array([0, 255, 128, 42]))),
  )
  await expect(
    host.run(applyRemote(bytes, hash, join(host.scratch, "conversion-attempt.json"))),
  ).rejects.toThrow()
})
