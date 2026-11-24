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
  disableCurrentSourceCommand,
  enableCurrentSourceCommand,
  removeCurrentSourceCommand,
  restoreFollowCurrentSourceCommand,
  takeoverCurrentSourceCommand,
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

test("current Source action routes expose the same bounded finite intent controls", () => {
  for (const [name, command] of [
    ["enable", enableCurrentSourceCommand],
    ["disable", disableCurrentSourceCommand],
    ["remove", removeCurrentSourceCommand],
    ["takeover", takeoverCurrentSourceCommand],
    ["restore-follow", restoreFollowCurrentSourceCommand],
  ] as const)
    expect(selectCommand(libraryCommand, ["source", name])).toBe(command)
  expect(selectCommand(libraryCommand, ["source", "apply"])).toBe(applyCurrentSourceCommand)
  expect(selectCommand(libraryCommand, ["source", "refresh"])).toBe(refreshCurrentSourceCommand)
  expect(selectCommand(libraryCommand, ["source", "list"])).toBeUndefined()
  expect(
    currentSourceCommand.subcommands.flatMap((group) =>
      group.commands.map((command) => command.name),
    ),
  ).toEqual([
    "apply",
    "refresh",
    "check",
    "sync",
    "enable",
    "disable",
    "remove",
    "takeover",
    "restore-follow",
  ])
  for (const command of [
    applyCurrentSourceCommand,
    refreshCurrentSourceCommand,
    enableCurrentSourceCommand,
    disableCurrentSourceCommand,
    removeCurrentSourceCommand,
    takeoverCurrentSourceCommand,
    restoreFollowCurrentSourceCommand,
  ]) {
    const schema = property(commandSchema(command))
    const parameters = Array.isArray(schema.parameters) ? schema.parameters.map(property) : []
    expect(parameters.find((parameter) => parameter.name === "library")).toMatchObject({
      required: true,
      max_occurrences: 1,
    })
    for (const name of [
      "operation",
      "resume",
      "supersede",
      "dry-run",
      "max-requests",
      "max-bytes",
      "timeout",
    ])
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
      flags: ["resume", "supersede", "dryRun"],
    })
  }
})

test("invalid Source command flags and identities fail before every remote handler", async () => {
  const directory = await root(),
    f = currentWriteFixture(directory)
  const file = join(directory, "source.json")
  await writeFile(file, JSON.stringify(declaration))
  const apply = ["apply", file, "--library", library.library_id]
  const refresh = ["refresh", "team-skills", "--library", library.library_id]
  for (const base of [
    apply,
    refresh,
    ...["enable", "disable", "remove"].map((name) => [
      name,
      "team-skills",
      "--library",
      library.library_id,
    ]),
    ...["takeover", "restore-follow"].map((name) => [
      name,
      "team-skills",
      "skills/alpha/SKILL.md",
      "--skill-id",
      "alpha",
      "--file-id",
      "main-alpha",
      "--library",
      library.library_id,
    ]),
  ])
    for (const flags of [
      ["--resume"],
      ["--supersede", "old-intent"],
      ["--supersede", "same-intent", "--operation", "same-intent"],
      ["--supersede", "old-intent", "--operation", "new-intent", "--resume"],
      ["--supersede", "old-intent", "--operation", "new-intent", "--dry-run"],
      ["--supersede", "invalid operation", "--operation", "new-intent"],
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
    ["apply", file, "--library", "notion_page:old"],
    ["refresh", "team-skills", "--library", "skill://old"],
    ["refresh", `source-${"a".repeat(64)}`, "--library", library.library_id],
    ["refresh", "snapshot-old", "--library", library.library_id],
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
        "--library",
        library.library_id,
        "--dry-run",
      ]),
    ),
  ).rejects.toMatchObject({ code: "INVALID_PATH" })
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})

test("Source file commands reject incomplete identities, unsafe paths and unsupported authority before remote work", async () => {
  const directory = await root(),
    f = currentWriteFixture(directory)
  const target = ["--library", library.library_id, "--skill-id", "alpha", "--file-id", "main-alpha"]
  for (const args of [
    ["takeover", "team-skills", "skills/alpha/SKILL.md", ...target, "--as", "source"],
    [
      "takeover",
      "team-skills",
      "skills/alpha/SKILL.md",
      ...target,
      "--as",
      "native",
      "--as",
      "resource",
    ],
    ["restore-follow", "team-skills", "skills/alpha/SKILL.md", ...target, "--as", "native"],
    ["takeover", "team-skills", "../outside", ...target],
    ["restore-follow", "team-skills", "", ...target],
    [
      "takeover",
      "team-skills",
      "skills/alpha/SKILL.md",
      "--library",
      library.library_id,
      "--skill-id",
      "alpha",
    ],
    ["restore-follow", "team-skills", "skills/alpha/SKILL.md", ...target, "--native", "SKILL.md"],
  ])
    await expect(
      f.run(Command.runWith(currentSourceCommand, { version: "0" })(args)),
    ).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})
