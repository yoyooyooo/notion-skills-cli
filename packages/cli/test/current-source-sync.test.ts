import { expect, test } from "bun:test"
import { Effect, Sink, Stdio } from "effect"
import { Command } from "effect/cli"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { prepareCurrentSharedSourceContent } from "../../core/src/shared-current-source.ts"
import type { CurrentSourceDeclaration } from "../../core/src/shared-current-source-input.ts"
import { currentSourceWriteProperties } from "../../core/src/shared-current-source-management.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import { currentSourceCommand } from "../src/commands-current-source.ts"
import {
  checkCurrentSourcesCommand,
  syncCurrentSourcesCommand,
} from "../src/commands-current-source-sync.ts"

const base = ["--library", library.library_id, "--source", "pinned-fixture"]
const identity = ["--manager", "fixture", "--execution-id", "a".repeat(64)]

async function fixture(run: (f: ReturnType<typeof currentWriteFixture>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-sync-cli-"))
  const previousExit = process.exitCode
  try {
    await run(currentWriteFixture(root))
  } finally {
    process.exitCode = previousExit
    await rm(root, { recursive: true, force: true })
  }
}

function cli(args: string[]) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const output: string[] = []
    yield* Command.runWith(currentSourceCommand, { version: "test", renderErrors: false })(
      args,
    ).pipe(
      Effect.provideService(Stdio.Stdio, {
        ...stdio,
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
            }),
          ),
        stderr: () => Sink.drain,
      }),
    )
    return property(JSON.parse(output.join("")))
  })
}

async function seedPinned(f: ReturnType<typeof currentWriteFixture>) {
  const declaration: CurrentSourceDeclaration = {
    version: 1,
    definition: {
      version: 1,
      source_id: "pinned-fixture",
      name: "Pinned fixture",
      description: "No upstream ref check",
      enabled: true,
      policy: "pinned",
      adapter: { type: "git", url: "https://github.com/example/skills", ref: "a".repeat(40) },
      selection: { roots: ["."], include: [], exclude: [], mapping: {} },
      options: {},
    },
    contributions: [],
  }
  const selected = await f.run(
    prepareCurrentSharedSourceContent({
      version: 1,
      kind: "composition",
      mounts: [],
      base: {
        kind: "git",
        source: {
          url: "https://github.com/example/skills",
          commit: "a".repeat(40),
          tree: "b".repeat(40),
          root: "",
          files: [],
        },
      },
    }),
  )
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            ...currentSourceWriteProperties(library, {
              declaration,
              content: selected.content,
              revision: selected.revision,
            }),
            [library.sources.property_ids.Status!]: { select: { name: "ready" } },
            [library.sources.property_ids.Operation!]: { rich_text: [] },
          },
        },
        { method: "POST" },
      ),
    ),
  )
  f.clearCalls()
}

test("Source check and sync expose explicit selection, shared budgets and separate management controls", () => {
  expect(selectCommand(currentSourceCommand, ["check"])).toBe(checkCurrentSourcesCommand)
  expect(selectCommand(currentSourceCommand, ["sync"])).toBe(syncCurrentSourcesCommand)
  for (const command of [checkCurrentSourcesCommand, syncCurrentSourcesCommand]) {
    const schema = property(commandSchema(command))
    const parameters = Array.isArray(schema.parameters) ? schema.parameters.map(property) : []
    expect(parameters.find((item) => item.name === "source")).toMatchObject({
      required: true,
      min_occurrences: 1,
      max_occurrences: 256,
    })
    for (const name of ["max-requests", "max-bytes", "timeout"])
      expect(parameters.find((item) => item.name === name)).toMatchObject({
        primitive: "Int",
        max_occurrences: 1,
      })
    expect(parameters.find((item) => item.name === "json")).toBeUndefined()
    for (const name of ["operation", "resume", "supersede", "dry-run"])
      expect(parameters.find((item) => item.name === name)).toBeUndefined()
  }
})

test("invalid or implicit Source scope and incompatible modes are rejected before remote work", async () => {
  await fixture(async (f) => {
    for (const args of [
      ["check", "--library", library.library_id],
      ["sync", "--library", library.library_id, ...identity],
      ["check", ...base, "--source", "snapshot-retired"],
      ["check", ...base, "--source", "invalid:source"],
      ["check", ...base, "--manager", "unexpected"],
      ["check", ...base, "--max-requests", "0"],
      ["check", ...base, "--max-bytes", "-1"],
      ["check", ...base, "--timeout", "0"],
      ["check", ...base, "--json"],
      ["sync", ...base, ...identity, "--mode", "tracking"],
      ["sync", ...base, ...identity, "--projection", "all"],
      ["sync", ...base, ...identity, "--manager", "duplicate"],
      ["sync", ...base, ...identity, "--resume"],
    ])
      await expect(f.run(cli(args))).rejects.toThrow()
    expect(f.calls).toEqual([])
  })
})

test("real CLI handlers emit complete skipped reports and zero semantic writes for pinned Sources", async () => {
  await fixture(async (f) => {
    await seedPinned(f)
    for (const action of ["check", "sync"]) {
      const result = await f.run(cli([action, ...base, ...(action === "sync" ? identity : [])]))
      expect(result).toMatchObject({
        ok: true,
        version: 1,
        kind: "current_source_sync",
        action,
        status: "complete",
        results: [
          { source_id: "pinned-fixture", status: "skipped", reason: "pinned", retryable: false },
        ],
      })
      expect(process.exitCode).toBe(0)
      expect(f.mutations()).toEqual([])
    }
  })
})

test("a batch reports every selected missing Source and maps incomplete outcomes to exit one", async () => {
  await fixture(async (f) => {
    const result = await f.run(cli(["check", ...base, "--source", "another-missing"]))
    expect(result).toMatchObject({
      ok: false,
      kind: "current_source_sync",
      action: "check",
      status: "failed",
    })
    const results = Array.isArray(result.results) ? result.results.map(property) : []
    expect(results.map((item) => item.source_id)).toEqual(["another-missing", "pinned-fixture"])
    expect(results.every((item) => property(item.error).code === "CURRENT_SOURCE_NOT_FOUND")).toBe(
      true,
    )
    expect(process.exitCode).toBe(1)
    expect(
      f.calls.filter((call) => call.path === `v1/databases/${library.skills.database_id}`),
    ).toHaveLength(1)
    expect(f.mutations()).toEqual([])
  })
})
