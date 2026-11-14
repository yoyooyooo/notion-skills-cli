import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSkill } from "../src/mutation.ts"
import { property } from "../src/model.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"

test("ordinary create preserves a complete executable Skill without importing Finder metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-public-resources-"))
  mkdirSync(join(directory, "scripts"))
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: public-resources\ndescription: Complete local Skill\n---\n\n# Workflow\n\nRead scripts/run without executing it.\n",
  )
  writeFileSync(join(directory, "scripts/run"), "#!/bin/sh\nprintf 'never executed'\n", {
    mode: 0o755,
  })
  writeFileSync(join(directory, "config.json"), '{"provider":"example"}\r\n')
  writeFileSync(join(directory, "asset.bin"), new Uint8Array([0, 255, 1, 42]))
  writeFileSync(join(directory, ".DS_Store"), new Uint8Array([0, 255, 0]))
  const f = sharedCreateFixture()
  const preview = await f.run(
    createSkill(directory, { database: createLibrary.skills.database_id, dryRun: true }),
  )
  const plan = property(property(preview).plan)
  expect(plan.complete_resources).toBe(1)
  expect(f.writes()).toHaveLength(0)
  const resources = Array.isArray(plan.resources) ? plan.resources.map(property) : []
  expect(resources.map((value) => value.path).sort()).toEqual([
    "asset.bin",
    "config.json",
    "scripts/run",
  ])
  expect(
    property(property(resources.find((value) => value.path === "scripts/run")?.prepared).content)
      .mode,
  ).toBe("100755")
  const result = await f.run(createSkill(directory, { database: createLibrary.skills.database_id }))
  expect(property(result).verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(4)
}, 30000)
