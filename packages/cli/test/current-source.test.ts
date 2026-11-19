import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import type { CurrentSourceDeclaration } from "../../core/src/shared-current-source-input.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import {
  applyCurrentSourceCommand,
  currentSourceCommand,
  loadCurrentSourceDeclaration,
  refreshCurrentSourceCommand,
} from "../src/commands-current-source.ts"
import { libraryCommand } from "../src/commands-library.ts"

const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: "team-skills",
    name: "Team skills",
    description: "Current Git contents",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/skills", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: [
    {
      member_key: "skills/alpha",
      skill_id: "alpha",
      mount_path: "",
      mapping: {},
      exclude: ["local.md"],
    },
    {
      member_key: "skills/beta",
      skill_id: "beta",
      mount_path: "",
      mapping: { "old.md": "references/current.md" },
      exclude: [],
    },
  ],
}
const root = async () => realpath(await mkdtemp(join(tmpdir(), "ntn-source-cli-")))
const load = (path: string) =>
  Effect.runPromise(loadCurrentSourceDeclaration(path).pipe(Effect.provide(NodeServices.layer)))

test("Source JSON admission selects exact current contributions without requiring a library or provider", async () => {
  const directory = await root(),
    path = join(directory, "source.json")
  await writeFile(path, JSON.stringify(declaration))
  const result = await load(path)
  expect(result).toEqual(declaration)
  expect(result.definition.selection.exclude).toEqual([])
  expect(result.contributions[0]!.exclude).toEqual(["local.md"])
})

test("Source JSON admission rejects malformed, nonregular, oversized and unknown input", async () => {
  const directory = await root()
  const cases: readonly [string, string | Uint8Array][] = [
    ["broken.json", "{"],
    ["utf8.json", new Uint8Array([255, 254])],
    ["empty.json", ""],
    ["oversized.json", " ".repeat(512 * 1024 + 1)],
    ["unknown.json", JSON.stringify({ ...declaration, history: [] })],
    ["legacy.json", JSON.stringify({ version: 1, adapter: declaration.definition.adapter })],
    [
      "unsafe.json",
      JSON.stringify({
        ...declaration,
        contributions: [{ ...declaration.contributions[0], exclude: ["../outside"] }],
      }),
    ],
    [
      "transform.json",
      JSON.stringify({
        ...declaration,
        definition: { ...declaration.definition, options: { patch: { version: 1, files: [] } } },
      }),
    ],
  ]
  for (const [name, bytes] of cases) {
    const path = join(directory, name)
    await writeFile(path, bytes)
    await expect(load(path)).rejects.toThrow()
  }
  await expect(load(directory)).rejects.toMatchObject({ code: "CURRENT_SOURCE_INPUT_INVALID" })
  await expect(load(join(directory, "missing.json"))).rejects.toMatchObject({
    code: "CURRENT_SOURCE_INPUT_INVALID",
  })
  const valid = join(directory, "valid.json"),
    linked = join(directory, "linked.json")
  await writeFile(valid, JSON.stringify(declaration))
  await symlink(valid, linked)
  await expect(load(linked)).rejects.toMatchObject({ code: "CURRENT_SOURCE_INPUT_INVALID" })
})

test("apply and refresh schema routes expose the same bounded finite intent controls", () => {
  expect(selectCommand(libraryCommand, ["source", "apply"])).toBe(applyCurrentSourceCommand)
  expect(selectCommand(libraryCommand, ["source", "refresh"])).toBe(refreshCurrentSourceCommand)
  expect(selectCommand(libraryCommand, ["source", "list"])).toBeUndefined()
  expect(
    currentSourceCommand.subcommands.flatMap((group) =>
      group.commands.map((command) => command.name),
    ),
  ).toEqual(["apply", "refresh"])
  for (const command of [applyCurrentSourceCommand, refreshCurrentSourceCommand]) {
    const schema = property(commandSchema(command))
    const parameters = Array.isArray(schema.parameters) ? schema.parameters.map(property) : []
    expect(parameters.find((parameter) => parameter.name === "entry")).toMatchObject({
      required: true,
      max_occurrences: 1,
    })
    for (const name of ["operation", "resume", "dry-run", "max-requests", "max-bytes", "timeout"])
      expect(parameters.find((parameter) => parameter.name === name)).toBeDefined()
    for (const name of ["max-requests", "max-bytes", "timeout"])
      expect(parameters.find((parameter) => parameter.name === name)).toMatchObject({
        primitive: "Int",
        max_occurrences: 1,
      })
    expect(parameters.find((parameter) => parameter.name === "timeout")?.description).toContain(
      "ms",
    )
    expect(
      parameters.find((parameter) => parameter.name === "max-requests")?.description,
    ).toContain("Git subprocess requests are not counted")
    expect(schema.constraints).toContainEqual({
      kind: "mutually_exclusive",
      flags: ["resume", "dryRun"],
    })
  }
})

test("invalid Source command flags and identities fail before every remote handler", async () => {
  const directory = await root(),
    f = currentWriteFixture(directory)
  const file = join(directory, "source.json")
  await writeFile(file, JSON.stringify(declaration))
  const apply = ["apply", file, "--entry", library.skills.database_id]
  const refresh = ["refresh", "team-skills", "--entry", library.skills.database_id]
  for (const base of [apply, refresh])
    for (const flags of [
      ["--resume"],
      ["--resume", "--operation", "source-intent", "--dry-run"],
      ["--operation", "invalid operation"],
      ["--max-requests", "0"],
      ["--max-bytes", "-1"],
      ["--timeout", "0"],
      ["--max-requests", "2", "--max-requests", "3"],
      ["--legacy"],
    ])
      await expect(
        f.run(Command.runWith(currentSourceCommand, { version: "0" })([...base, ...flags])),
      ).rejects.toThrow()
  for (const args of [
    ["apply", file, "--entry", "notion_page:old"],
    ["refresh", "team-skills", "--entry", "skill://old"],
    ["refresh", `source-${"a".repeat(64)}`, "--entry", library.skills.database_id],
    ["refresh", "snapshot-old", "--entry", library.skills.database_id],
  ])
    await expect(
      f.run(Command.runWith(currentSourceCommand, { version: "0" })(args)),
    ).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})

test("malformed local apply input never enters the real Source coordinator", async () => {
  const directory = await root(),
    f = currentWriteFixture(directory)
  const file = join(directory, "source.json")
  await writeFile(
    file,
    JSON.stringify({
      ...declaration,
      contributions: [{ ...declaration.contributions[0], exclude: ["../outside"] }],
    }),
  )
  await expect(
    f.run(
      Command.runWith(currentSourceCommand, { version: "0" })([
        "apply",
        file,
        "--entry",
        library.skills.database_id,
        "--dry-run",
      ]),
    ),
  ).rejects.toMatchObject({ code: "INVALID_PATH" })
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})
