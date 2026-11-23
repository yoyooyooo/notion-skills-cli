import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { prepareCurrentImport } from "../../cli/src/commands-current-import.ts"
import { authScope } from "../src/catalog.ts"
import { exportSkill, snapshotPortable } from "../src/export.ts"
import { trashPath } from "../src/local-locks.ts"
import { property, text } from "../src/model.ts"
import { MANIFEST, portableRelationSelection, validatePortableRelations } from "../src/portable.ts"
import { skillIdentity } from "../src/shared-content.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = realpathSync(mkdtempSync(join(tmpdir(), "ntn-current-portable-")))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})

test("portable relationship context binds once, preserves omission and rejects duplicate or foreign complete identities", () => {
  const base = { version: 1 as const, ownership: "notion" as const, library_id: "test" }
  expect(validatePortableRelations({ ...base, members: ["skill://architect"] })).toEqual({
    ...base,
    members: ["skill://architect?library=test"],
  })
  expect(validatePortableRelations(base)).not.toHaveProperty("members")
  expect(validatePortableRelations({ ...base, members: [] }).members).toEqual([])
  expect(
    portableRelationSelection({ ...base, members: ["skill://architect"] }, "test", {
      members: ["skill://architect?library=test"],
    }),
  ).toEqual({ members: ["skill://architect?library=test"] })
  for (const members of [
    ["skill://architect", "skill://architect?library=test"],
    ["skill://architect?library=production"],
    ["shared_skill:test:architect"],
    ["skill://architect/SKILL.md"],
    ["skill://architect?snapshot=s_" + "a".repeat(64)],
  ])
    expect(() => validatePortableRelations({ ...base, members })).toThrow()
})

test("public current export, local edit and import preserve complete files, execution mode and explicit native relations", async () => {
  const f = currentWriteFixture(parent)
  const common = {
    kind: "skill" as const,
    name: "Current portable",
    description: "Export and import exact current content",
  }
  const target = await f.run(
    writeCurrentSkill(library, {
      plan: await f.run(
        prepareCurrentSkillWrite({
          ...common,
          skill_id: "target",
          files: [{ path: "SKILL.md", bytes: testBytes("# Target\n") }],
        }),
      ),
      operation_id: "target-first",
    }),
  )
  const relations = {
    version: 1 as const,
    ownership: "notion" as const,
    library_id: library.library_id,
    members: [skillIdentity(library.library_id, "target")],
    requires: [skillIdentity(library.library_id, "target")],
  }
  const main = testBytes(
    "\uFEFF---\r\nname: Original\r\ndescription: Source bytes\r\n---\r\n# Authored\r\n[Guide](references/guide.md)\r\n",
  )
  const script = testBytes("export const run = true\n")
  const owner = await f.run(
    writeCurrentSkill(library, {
      plan: await f.run(
        prepareCurrentSkillWrite({
          ...common,
          skill_id: "owner",
          relations,
          files: [
            { path: "SKILL.md", bytes: main },
            { path: "references/guide.md", bytes: testBytes("# Full supporting document\n") },
            { path: "scripts/run.ts", bytes: script, mode: "100755" },
          ],
        }),
      ),
      operation_id: "owner-first",
    }),
  )
  const snapshot = await f.run(
    Effect.gen(function* () {
      return yield* openSharedSnapshot({
        library,
        target: owner.page_id,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
      })
    }),
  )
  const output = join(f.root, "current-export")
  await f.run(exportSkill(snapshot.snapshot_id, { output, format: "directory" }))
  const manifest = JSON.parse(readFileSync(join(output, MANIFEST), "utf8"))
  expect(manifest.relations).toEqual(relations)
  expect(manifest).not.toHaveProperty("projection")
  expect(new Uint8Array(readFileSync(join(output, "SKILL.md")))).toEqual(main)
  expect(new Uint8Array(readFileSync(join(output, "scripts/run.ts")))).toEqual(script)
  expect(statSync(join(output, "scripts/run.ts")).mode & 0o111).not.toBe(0)
  const edited = testBytes("# Edited author content\n[Guide](references/guide.md)\n")
  writeFileSync(join(output, "SKILL.md"), edited)
  const imported = await f.run(prepareCurrentImport(output, { skillId: "owner" }))
  expect(imported.plan.relations).toEqual(relations)
  expect(imported.plan.files.find((file) => file.path === "scripts/run.ts")?.mode).toBe("100755")
  await f.run(writeCurrentSkill(library, { plan: imported.plan, operation_id: "round-trip" }))
  const raw = property(f.pages.get(owner.page_id)?.properties)
  expect(property(raw.members).relation).toEqual([{ id: target.page_id }])
  expect(property(raw.requires).relation).toEqual([{ id: target.page_id }])
  const after = await f.run(
    Effect.gen(function* () {
      return yield* openSharedSnapshot({
        library,
        target: owner.page_id,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
      })
    }),
  )
  const portable = await f.run(snapshotPortable(after))
  expect(portable.files.find((file) => file.path === "SKILL.md")?.bytes).toEqual(edited)
  expect(portable.files.find((file) => file.path === "scripts/run.ts")?.bytes).toEqual(script)
  expect(portable.relations).toEqual(relations)
  expect(portable).not.toHaveProperty("projection")
  expect(
    f
      .table("skills")
      .filter((row) => text(property(property(row.properties)["skill-id"]).rich_text) === "owner"),
  ).toHaveLength(1)
})

test("current Prompt export has no relation or retained projection payload", async () => {
  const f = currentWriteFixture(parent)
  const written = await f.run(
    writeCurrentSkill(library, {
      plan: await f.run(
        prepareCurrentSkillWrite({
          skill_id: "prompt",
          kind: "prompt",
          name: "Prompt",
          description: "Current prompt",
          files: [{ path: "PROMPT.md", bytes: testBytes("Exact prompt\r\n") }],
        }),
      ),
      operation_id: "prompt-first",
    }),
  )
  const snapshot = await f.run(
    Effect.gen(function* () {
      return yield* openSharedSnapshot({
        library,
        target: written.page_id,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
      })
    }),
  )
  const output = join(f.root, "prompt-export")
  await f.run(exportSkill(snapshot.snapshot_id, { output, format: "directory" }))
  const manifest = JSON.parse(readFileSync(join(output, MANIFEST), "utf8"))
  expect(manifest.kind).toBe("prompt")
  expect(manifest).not.toHaveProperty("relations")
  expect(manifest).not.toHaveProperty("projection")
  expect((await f.run(prepareCurrentImport(output, { skillId: "prompt" }))).plan.kind).toBe(
    "prompt",
  )
})
