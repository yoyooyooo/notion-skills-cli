import { expect, test } from "bun:test"
import { Command } from "effect/cli"
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { property } from "../../core/src/model.ts"
import { fileRef } from "../../core/src/ref.ts"
import { portableZip } from "../../core/src/portable.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../../core/src/shared-current-write.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import {
  currentImportCommand,
  prepareCurrentImport,
  prepareCurrentImportMembers,
} from "../src/commands-current-import.ts"
import { currentMembersPlanCommand } from "../src/commands-current-members.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const member = `skill://target?library=${library.library_id}`
const canonical = fileRef(member, "SKILL.md")
const header = "---\nname: Owner\ndescription: Imported owner\n---\n"
const base = ["--entry", library.skills.database_id, "--skill-id", "owner"]
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-members-cli-")))
  const input = join(root, "input")
  await mkdir(input)
  const f = currentWriteFixture(root)
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "target",
      kind: "skill",
      name: "Target",
      description: "Target",
      files: [{ path: "SKILL.md", bytes: encode("# Target") }],
    }),
  )
  const target = await f.run(
    writeCurrentSkill(library, { plan, operation_id: "create-target", mode: "apply" }),
  )
  return { root, input, f, target }
}
function members(f: ReturnType<typeof currentWriteFixture>, skillId: string) {
  const owner = f
    .table("skills")
    .find((row) =>
      JSON.stringify(property(row.properties)[library.skills.property_ids["Skill ID"]!]).includes(
        '"' + skillId + '"',
      ),
    )!
  return property(property(owner.properties)[library.skills.property_ids.Members!]).relation
}

test("the public import command adds verified canonical Members only on creation and keeps later user deletion", async () => {
  const { input, f } = await setup()
  await writeFile(join(input, "SKILL.md"), header + `[target](${canonical})`)
  f.clearCalls()
  await f.run(
    Command.runWith(currentImportCommand, { version: "0" })([
      input,
      ...base,
      "--operation",
      "first-import",
    ]),
  )
  expect(members(f, "owner")).toHaveLength(1)
  const row = f
    .table("skills")
    .find((value) =>
      JSON.stringify(property(value.properties)[library.skills.property_ids["Skill ID"]!]).includes(
        '"owner"',
      ),
    )!
  property(row.properties)[library.skills.property_ids.Members!] = {
    ...property(property(row.properties)[library.skills.property_ids.Members!]),
    relation: [],
  }
  await f.run(
    Command.runWith(currentImportCommand, { version: "0" })([
      input,
      ...base,
      "--operation",
      "repeat-import",
    ]),
  )
  expect(members(f, "owner")).toEqual([])
  expect(
    property(property(row.properties)[library.skills.property_ids.Requires!]).relation ?? [],
  ).toEqual([])
})

test("members-plan writes a verified portable directory which the normal importer applies, without modifying the original", async () => {
  const { root, input, f } = await setup()
  const original = header + "Read [target](../b/SKILL.md).\n`../b/SKILL.md`\n"
  await writeFile(join(input, "SKILL.md"), original)
  const bindings = join(root, "bindings.json")
  await writeFile(
    bindings,
    JSON.stringify({
      version: 1,
      root: "skills/a",
      targets: [{ path: "skills/b/SKILL.md", ref: canonical }],
    }),
  )
  const output = join(root, "portable")
  f.clearCalls()
  await f.run(
    Command.runWith(currentMembersPlanCommand, { version: "0" })([
      input,
      ...base,
      "--bindings",
      bindings,
      "--output",
      output,
    ]),
  )
  expect(f.mutations()).toEqual([])
  expect(await readFile(join(input, "SKILL.md"), "utf8")).toBe(original)
  const selected = await f.run(prepareCurrentImport(output, { skillId: "owner" }))
  expect(selected.plan.relations?.members).toEqual([member])
  expect(new TextDecoder().decode(selected.plan.files[0]!.bytes)).toContain(
    "skill://target/SKILL.md",
  )
  await f.run(
    Command.runWith(currentImportCommand, { version: "0" })([
      output,
      ...base,
      "--operation",
      "planned-import",
    ]),
  )
  expect(members(f, "owner")).toHaveLength(1)
})

test("a ZIP with unresolved cross-root links produces no output and no remote writes", async () => {
  const { root, f } = await setup()
  const input = join(root, "input.zip"),
    output = join(root, "no-output")
  await writeFile(
    input,
    portableZip({
      kind: "skill",
      name: "Owner",
      description: "Owner",
      main: "SKILL.md",
      files: [{ path: "SKILL.md", bytes: encode("[unknown](../unknown/SKILL.md)") }],
    }),
  )
  f.clearCalls()
  await f.run(
    Command.runWith(currentMembersPlanCommand, { version: "0" })([
      input,
      ...base,
      "--output",
      output,
    ]),
  )
  expect(
    await stat(output).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(f.mutations()).toEqual([])
})

test("explicit empty Members and explicit Requires survive automatic import admission", async () => {
  const { input, f } = await setup()
  await writeFile(join(input, "SKILL.md"), header + `[target](${canonical})`)
  const relations = {
    version: 1 as const,
    ownership: "notion" as const,
    library_id: library.library_id,
    members: [],
    requires: [member],
  }
  await writeFile(
    join(input, ".ntn-skills.json"),
    JSON.stringify({
      format: "ntn-skills",
      version: 2,
      kind: "skill",
      name: "Owner",
      description: "Owner",
      main: "SKILL.md",
      relations,
    }),
  )
  const prepared = await f.run(prepareCurrentImport(input, { skillId: "owner" }))
  const selected = await f.run(prepareCurrentImportMembers(library, prepared.plan))
  expect(selected.plan.relations).toEqual(relations)
  expect(selected.members_discovery.member_policy).toBe("explicit")
  await f.run(
    Command.runWith(currentImportCommand, { version: "0" })([
      input,
      ...base,
      "--operation",
      "explicit-import",
    ]),
  )
  expect(members(f, "owner")).toEqual([])
})

test("automatic Members resume the frozen input without rediscovering target links", async () => {
  const { input, f } = await setup()
  await writeFile(join(input, "SKILL.md"), header + `[target](${canonical})`)
  const command = Command.runWith(currentImportCommand, { version: "0" })
  f.failNext({ kind: "relations", outcome: "accepted" })
  await expect(
    f.run(command([input, ...base, "--operation", "resume-auto"])),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  const frozen = [...f.json].find(([key]) => key.startsWith("operations/import-plan/"))
  expect(frozen).toBeDefined()
  expect(JSON.stringify(frozen?.[1])).toContain(member)
  f.clearCalls()
  await f.run(command([input, ...base, "--operation", "resume-auto", "--resume"]))
  expect(members(f, "owner")).toHaveLength(1)
  expect(f.table("skills")).toHaveLength(2)
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/data_sources/${library.skills.data_source_id}/query` &&
        JSON.stringify(call.body).includes('"target"'),
    ),
  ).toEqual([])
  expect(
    [...f.json.keys()].filter(
      (key) =>
        key.startsWith("operations/import-plan/") ||
        key.startsWith("operations/current-write-pending/"),
    ),
  ).toEqual([])
})

test("a concurrent manual creation cannot receive automatic Members selected while the identity was absent", async () => {
  const { input, f } = await setup()
  await writeFile(join(input, "SKILL.md"), header + `[target](${canonical})`)
  const prepared = await f.run(prepareCurrentImport(input, { skillId: "owner" }))
  const automatic = await f.run(prepareCurrentImportMembers(library, prepared.plan))
  expect(automatic.create_only).toBe(true)
  const manual = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "owner",
      kind: "skill",
      name: "Manual owner",
      description: "Manual",
      files: [{ path: "SKILL.md", bytes: encode("# Authored manually") }],
      relations: { version: 1, ownership: "notion", library_id: library.library_id, members: [] },
    }),
  )
  await f.run(
    writeCurrentSkill(library, { plan: manual, operation_id: "manual-wins", mode: "apply" }),
  )
  f.clearCalls()
  await expect(
    f.run(
      writeCurrentSkill(library, {
        plan: automatic.plan,
        operation_id: "automatic-race",
        mode: "apply",
        create_only: true,
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_SKILL_EXISTS" })
  expect(members(f, "owner")).toEqual([])
  expect(f.mutations()).toEqual([])
})

test("members-plan rejects output inside its original directory, including an alias through a symlink parent", async () => {
  const { root, input, f } = await setup()
  await writeFile(join(input, "SKILL.md"), header + `[target](${canonical})`)
  const alias = join(root, "input-alias")
  await symlink(input, alias)
  f.clearCalls()
  for (const output of [input, join(input, "portable"), join(alias, "portable")])
    await expect(
      f.run(
        Command.runWith(currentMembersPlanCommand, { version: "0" })([
          input,
          ...base,
          "--output",
          output,
        ]),
      ),
    ).rejects.toMatchObject({ code: "MEMBERS_OUTPUT_INVALID" })
  expect(f.calls).toEqual([])
  expect(
    await stat(join(input, "portable")).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})
