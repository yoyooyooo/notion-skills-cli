import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { loadSkillUpdateFile } from "../../core/src/import.ts"
import { trashPath } from "../../core/src/local-locks.ts"
import { property, text } from "../../core/src/model.ts"
import { queryCurrentSkillIndex } from "../../core/src/shared-current-index.ts"
import { observeSharedBody } from "../../core/src/shared-page-body.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import { prepareCurrentImport } from "../src/commands-current-import.ts"
import { currentSkillCommand } from "../src/commands-current-skill.ts"
import { libraryCommand } from "../src/commands-library.ts"

const parent = await realpath(await mkdtemp(join(tmpdir(), "ntn-native-cli-")))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const entry = library.skills.database_id
const metadata = "---\nname: Daily Native\ndescription: Manage a daily native Skill\n---\n"
const cli = (f: ReturnType<typeof currentWriteFixture>, argv: readonly string[]) =>
  f.run(Command.runWith(currentSkillCommand, { version: "0" })([...argv]))

test("native management exposes four public commands and no hidden schema or recovery flags", () => {
  expect(selectCommand(libraryCommand, ["skill"])).toBe(currentSkillCommand)
  expect(
    currentSkillCommand.subcommands.flatMap((group) =>
      group.commands.map((command) => command.name),
    ),
  ).toEqual(["create", "update", "register", "remove"])
  for (const name of ["create", "update", "register", "remove"]) {
    const command = selectCommand(currentSkillCommand, [name])
    if (command === undefined) throw new Error("Missing public Skill command: " + name)
    const schema = property(commandSchema(command))
    const parameters = (schema.parameters as unknown[]).map(property)
    expect(parameters.find((item) => item.name === "entry")).toMatchObject({ required: true })
    for (const flag of ["max-requests", "max-bytes", "timeout"])
      expect(parameters.find((item) => item.name === flag)).toMatchObject({
        primitive: "Int",
        max_occurrences: 1,
      })
    for (const flag of [
      "content",
      "main-file-id",
      "current-state",
      "operation",
      "resume",
      "supersede",
    ])
      expect(parameters.find((item) => item.name === flag)).toBeUndefined()
  }
})

test("native create admits Markdown automatically while preserving binary resources", async () => {
  const f = currentWriteFixture(parent),
    directory = join(f.root, "input")
  await mkdir(join(directory, "references"), { recursive: true })
  await writeFile(
    join(directory, "SKILL.md"),
    metadata + "# Daily Native\n\nSee [guide](references/guide.markdown).\n",
  )
  await writeFile(join(directory, "references/guide.markdown"), "# Guide\r\n\r\nCurrent text.\r\n")
  await writeFile(join(directory, "payload.bin"), new Uint8Array([0, 255, 3]))
  const prepared = await f.run(
    prepareCurrentImport(directory, { skillId: "daily-native", nativeMarkdown: true }),
  )
  expect(prepared.plan.files.map((file) => [file.path, file.kind])).toEqual([
    ["SKILL.md", "native"],
    ["payload.bin", "resource"],
    ["references/guide.markdown", "native"],
  ])
  expect(f.calls).toHaveLength(0)
})

test("selected local file admission refuses directories and symbolic links without remote access", async () => {
  const f = currentWriteFixture(parent),
    path = join(f.root, "binary.bin"),
    linked = join(f.root, "linked.bin")
  const bytes = new Uint8Array([0, 255, 13, 10])
  await writeFile(path, bytes)
  await symlink(path, linked)
  expect((await f.run(loadSkillUpdateFile(path))).bytes).toEqual(bytes)
  for (const input of [f.root, linked, join(f.root, "missing.bin")])
    await expect(f.run(loadSkillUpdateFile(input))).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

test("the public CLI creates, updates an explicitly selected main, reads back and removes", async () => {
  const f = currentWriteFixture(parent),
    input = join(f.root, "authored.md"),
    replacement = join(f.root, "replacement.md")
  await writeFile(input, metadata + "# Daily Native\n\nInitial author text.\n")
  await writeFile(replacement, metadata + "# Daily Native\n\nUpdated author text.\n")
  await cli(f, ["create", input, "--library", entry, "--skill-id", "cli-daily"])
  const owner = f.table("skills")[0]
  expect(owner).toBeDefined()
  const page = String(owner!.id)
  f.clearCalls()
  await cli(f, ["create", input, "--library", entry, "--skill-id", "cli-daily"])
  expect(f.mutations()).toHaveLength(0)
  await cli(f, [
    "update",
    page,
    "--library",
    entry,
    "--input",
    replacement,
    "--description",
    "Updated short description",
  ])
  const index = await f.run(queryCurrentSkillIndex(library, page))
  expect(index.main.path).toBe("SKILL.md")
  expect(index.description).toBe("Updated short description")
  expect((await f.run(observeSharedBody(page))).markdown).toContain("Updated author text.")
  f.clearCalls()
  await cli(f, [
    "update",
    page,
    "--library",
    entry,
    "--input",
    replacement,
    "--description",
    "Updated short description",
  ])
  expect(f.mutations()).toHaveLength(0)
  await cli(f, ["remove", page, "--library", entry])
  expect(f.table("skills")).toHaveLength(0)
  expect(f.table("records")).toHaveLength(0)
  f.clearCalls()
  await cli(f, ["remove", page, "--library", entry])
  expect(f.mutations()).toHaveLength(0)
  expect(
    text(
      property(property(f.pages.get(page)?.properties)[library.skills.property_ids["Skill ID"]!])
        .rich_text,
    ),
  ).toBe("cli-daily")
})

test("public native mutation admission refuses malformed flags before any remote request", async () => {
  const f = currentWriteFixture(parent)
  for (const args of [
    ["update", "exact-skill", "--path", "SKILL.md"],
    ["update", "exact-skill", "--file", "malformed"],
    ["update", "exact-skill", "--enabled", "maybe"],
    ["register", "00000000-0000-4000-8000-000000000064", "--default-context", "1"],
    ["remove", "exact-skill", "--max-requests", "0"],
    ["remove", "exact-skill", "--library", "skill://foreign"],
  ])
    await expect(
      cli(f, [...args, ...(args.includes("--library") ? [] : ["--library", entry])]),
    ).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  expect(f.mutations()).toHaveLength(0)
})
