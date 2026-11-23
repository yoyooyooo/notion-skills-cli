import { expect, test } from "bun:test"
import { Command } from "effect/cli"
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { property } from "../../core/src/model.ts"
import { thawCurrentImportSkill } from "../../core/src/shared-current-import-plan.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import {
  currentImportBatchCommand,
  loadCurrentImportBatch,
  compileCurrentImportBatch,
} from "../src/commands-current-import-batch.ts"

const header = (name: string) => `---\nname: ${name}\ndescription: Batch fixture\n---\n`
async function fixture(inputs: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-import-batch-")))
  for (const [name, body] of Object.entries(inputs)) {
    await mkdir(join(root, name))
    await writeFile(join(root, name, "SKILL.md"), header(name) + body)
  }
  const manifest = join(root, "batch.json")
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      root: ".",
      skills: Object.keys(inputs).map((name) => ({ root: name, skill_id: name })),
    }),
  )
  const f = currentWriteFixture(root)
  const command = Command.runWith(currentImportBatchCommand, { version: "0" })
  const run = (args: readonly string[] = []) =>
    f.run(
      command([
        manifest,
        "--entry",
        library.skills.database_id,
        ...(args.includes("--operation") ? [] : ["--operation", "batch-fixture"]),
        ...args,
      ]),
    )
  return { root, manifest, f, run }
}
function relation(f: ReturnType<typeof currentWriteFixture>, skillId: string, field = "Members") {
  const owner = f
    .table("skills")
    .find((row) =>
      JSON.stringify(property(row.properties)[library.skills.property_ids["Skill ID"]!]).includes(
        '"' + skillId + '"',
      ),
    )!
  return property(property(owner.properties)[library.skills.property_ids[field]!]).relation ?? []
}
function portable(relations: unknown) {
  return JSON.stringify({
    format: "ntn-skills",
    version: 2,
    kind: "skill",
    name: "Fixture",
    description: "Fixture",
    main: "SKILL.md",
    relations,
  })
}

test("an explicit cyclic Members batch writes all bodies first and never changes original files", async () => {
  const { root, manifest, f, run } = await fixture({
    a: "[B](../b/SKILL.md)\n",
    b: "[A](../a/SKILL.md)\n",
  })
  const before = await readFile(join(root, "a", "SKILL.md"), "utf8")
  const plan = await f.run(
    compileCurrentImportBatch(library, await f.run(loadCurrentImportBatch(manifest))),
  )
  expect(plan.mapping).toEqual([
    { root: "a", identity: `skill://a?library=${library.library_id}` },
    { root: "b", identity: `skill://b?library=${library.library_id}` },
  ])
  expect(plan.rewrites.map((entry) => entry.after)).toEqual([
    "skill://b/SKILL.md",
    "skill://a/SKILL.md",
  ])
  expect(plan.items.map((item) => item.relations?.members)).toEqual([
    [`skill://b?library=${library.library_id}`],
    [`skill://a?library=${library.library_id}`],
  ])
  f.clearCalls()
  await run()
  expect(relation(f, "a")).toHaveLength(1)
  expect(relation(f, "b")).toHaveLength(1)
  expect(relation(f, "a", "Requires")).toEqual([])
  expect(await readFile(join(root, "a", "SKILL.md"), "utf8")).toBe(before)
  expect([...f.json.keys()].filter((key) => key.startsWith("operations/import-plan/"))).toEqual([])
})

test("batch omission on reimport preserves a user's deleted Members", async () => {
  const { f, run } = await fixture({ a: "[B](../b/SKILL.md)", b: "# B" })
  await run()
  expect(relation(f, "a")).toHaveLength(1)
  const owner = f
    .table("skills")
    .find((row) =>
      JSON.stringify(property(row.properties)[library.skills.property_ids["Skill ID"]!]).includes(
        '"a"',
      ),
    )!
  rowProperties(owner)[library.skills.property_ids.Members!] = {
    id: library.skills.property_ids.Members,
    type: "relation",
    relation: [],
  }
  await run(["--operation", "batch-reimport"])
  expect(relation(f, "a")).toEqual([])
})
const rowProperties = (row: unknown) => property(property(row).properties)

test("unlisted siblings, missing files, overlapping roots and symlinks are never guessed", async () => {
  const { root, manifest, f, run } = await fixture({ a: "[B](../b/SKILL.md)", b: "# B" })
  await writeFile(manifest, JSON.stringify({ version: 1, skills: [{ root: "a", skill_id: "a" }] }))
  await expect(run()).rejects.toMatchObject({ code: "CURRENT_IMPORT_BATCH_UNRESOLVED" })
  expect(f.mutations()).toEqual([])
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      skills: [
        { root: "a", skill_id: "a" },
        { root: "a/nested", skill_id: "nested" },
      ],
    }),
  )
  await expect(f.run(loadCurrentImportBatch(manifest))).rejects.toMatchObject({
    code: "CURRENT_IMPORT_BATCH_INVALID",
  })
  for (const skill_id of ["UPPER", "a?library=foreign", "a/SKILL.md", "shared_skill:a"]) {
    await writeFile(manifest, JSON.stringify({ version: 1, skills: [{ root: "a", skill_id }] }))
    await expect(f.run(loadCurrentImportBatch(manifest))).rejects.toMatchObject({
      code: "CURRENT_IMPORT_BATCH_INVALID",
    })
  }
  await symlink(join(root, "b"), join(root, "alias"))
  await writeFile(
    manifest,
    JSON.stringify({ version: 1, skills: [{ root: "alias", skill_id: "b" }] }),
  )
  await expect(f.run(loadCurrentImportBatch(manifest))).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
})

test("foreign relationships require exact copy authorization and only batch-owned full refs are rebound", async () => {
  const { root, manifest, f } = await fixture({
    a:
      "[B](skill://b/SKILL.md?library=production)\n[external](skill://outside/SKILL.md?library=production)\n[missing](skill://b/missing.md?library=production)\n[fixed](skill://b/SKILL.md?library=production&snapshot=s_" +
      "a".repeat(64) +
      ")\n    [example](skill://b/SKILL.md?library=production)\n[use][shared]\n![image][shared]\n\n[shared]: skill://b/SKILL.md?library=production",
    b: "# B",
  })
  const unchanged = await f.run(
    compileCurrentImportBatch(library, await f.run(loadCurrentImportBatch(manifest))),
  )
  expect(unchanged.rewrites).toEqual([])
  expect(unchanged.items[0]?.relations).toBeUndefined()
  const unboundBody = await f.run(thawCurrentImportSkill(unchanged.items[0]!.body))
  expect(new TextDecoder().decode(unboundBody.files[0]!.bytes)).toContain(
    "skill://b/SKILL.md?library=production",
  )
  await writeFile(
    join(root, "a", ".ntn-skills.json"),
    portable({
      version: 1,
      ownership: "notion",
      library_id: "production",
      members: ["skill://b?library=production"],
    }),
  )
  await expect(
    f.run(compileCurrentImportBatch(library, await f.run(loadCurrentImportBatch(manifest)))),
  ).rejects.toMatchObject({ code: "PORTABLE_RELATION_SCOPE" })
  const plan = await f.run(
    compileCurrentImportBatch(library, await f.run(loadCurrentImportBatch(manifest, "production"))),
  )
  expect(plan.items[0]?.relations?.members).toEqual([`skill://b?library=${library.library_id}`])
  expect(plan.rewrites.map((entry) => entry.before)).toEqual([
    "skill://b?library=production",
    "skill://b/SKILL.md?library=production",
  ])
  const derived = await f.run(thawCurrentImportSkill(plan.items[0]!.body))
  const body = new TextDecoder().decode(derived.files[0]!.bytes)
  expect(body).toContain("skill://outside/SKILL.md?library=production")
  expect(body).toContain("skill://b/missing.md?library=production")
  expect(body).toContain("skill://b/SKILL.md?library=production&snapshot=s_")
  expect(body).toContain("skill://b/SKILL.md?library=" + library.library_id)
  expect(body).toContain("    [example](skill://b/SKILL.md?library=production)")
  expect(body).toContain("[shared]: skill://b/SKILL.md?library=production")
  expect(f.mutations()).toEqual([])
  await writeFile(
    join(root, "a", ".ntn-skills.json"),
    portable({
      version: 1,
      ownership: "notion",
      library_id: "production",
      members: ["skill://outside?library=production"],
    }),
  )
  await expect(
    f.run(
      compileCurrentImportBatch(
        library,
        await f.run(loadCurrentImportBatch(manifest, "production")),
      ),
    ),
  ).rejects.toMatchObject({ code: "PORTABLE_RELATION_SCOPE" })
  expect(f.mutations()).toEqual([])
})

test("differently cased roots are distinguished by physical directory identity", async () => {
  const { root, manifest, f } = await fixture({ a: "# A" })
  const alias = await stat(join(root, "A")).catch(() => undefined)
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      skills: [
        { root: "a", skill_id: "one" },
        { root: "A", skill_id: "two" },
      ],
    }),
  )
  if (alias !== undefined) {
    await expect(f.run(loadCurrentImportBatch(manifest))).rejects.toMatchObject({
      code: "CURRENT_IMPORT_BATCH_INVALID",
      details: { reason: "physical_root_reused" },
    })
    await mkdir(join(root, "a", "nested"))
    await writeFile(join(root, "a", "nested", "SKILL.md"), header("Nested") + "# Nested")
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        skills: [
          { root: "a", skill_id: "one" },
          { root: "A/nested", skill_id: "two" },
        ],
      }),
    )
    await expect(f.run(loadCurrentImportBatch(manifest))).rejects.toMatchObject({
      code: "CURRENT_IMPORT_BATCH_INVALID",
      details: { reason: "physical_root_reused" },
    })
  } else {
    await mkdir(join(root, "A"))
    await writeFile(join(root, "A", "SKILL.md"), header("Other") + "# Separate directory")
    expect((await f.run(loadCurrentImportBatch(manifest))).items).toHaveLength(2)
  }
  expect(f.mutations()).toEqual([])
})

test("batch invocation budgets use the import boundary before input or remote work", async () => {
  const { f, run } = await fixture({ a: "# A" })
  for (const flag of ["--max-requests", "--max-bytes", "--timeout"])
    await expect(run([flag, "0"])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  expect(f.calls).toEqual([])
})

test("batch Requires cycles fail before any body write", async () => {
  const { root, f, run } = await fixture({ a: "# A", b: "# B" })
  for (const [owner, dependency] of [
    ["a", "b"],
    ["b", "a"],
  ])
    await writeFile(
      join(root, owner!, ".ntn-skills.json"),
      portable({
        version: 1,
        ownership: "notion",
        library_id: library.library_id,
        requires: [`skill://${dependency}?library=${library.library_id}`],
      }),
    )
  await expect(run()).rejects.toMatchObject({ code: "CURRENT_REQUIRES_CYCLE" })
  expect(f.mutations()).toEqual([])
})

test("an acyclic Requires replacement orders prerequisites before dependents instead of creating a transient cycle", async () => {
  const { root, manifest, f, run } = await fixture({ a: "# A", b: "# B" })
  const relations = (requires: readonly string[]) => ({
    version: 1,
    ownership: "notion",
    library_id: library.library_id,
    requires: requires.map((id) => `skill://${id}?library=${library.library_id}`),
  })
  await writeFile(join(root, "b", ".ntn-skills.json"), portable(relations(["a"])))
  await run()
  await writeFile(join(root, "a", ".ntn-skills.json"), portable(relations(["b"])))
  await writeFile(join(root, "b", ".ntn-skills.json"), portable(relations([])))
  const plan = await f.run(
    compileCurrentImportBatch(library, await f.run(loadCurrentImportBatch(manifest))),
  )
  expect(plan.items.map((item) => item.skill_id)).toEqual(["b", "a"])
  await run(["--operation", "batch-flip-requires"])
  expect(relation(f, "a", "Requires")).toHaveLength(1)
  expect(relation(f, "b", "Requires")).toEqual([])
})

test("batch retry retains frozen inputs, rejects changed input and never replays an absent unknown CREATE", async () => {
  const { root, f, run } = await fixture({ a: "# A", b: "# B" })
  f.failNext({ kind: "skill-create", outcome: "absent" })
  await expect(run()).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const original = await readFile(join(root, "a", "SKILL.md"), "utf8")
  await writeFile(join(root, "a", "SKILL.md"), original + "\nChanged")
  f.clearCalls()
  await expect(run(["--resume"])).rejects.toMatchObject({ code: "CURRENT_IMPORT_PLAN_INVALID" })
  expect(f.mutations()).toEqual([])
  await writeFile(join(root, "a", "SKILL.md"), original)
  f.clearCalls()
  await expect(run(["--resume"])).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
  expect(f.mutations()).toEqual([])
  expect(f.table("skills")).toHaveLength(0)
})
