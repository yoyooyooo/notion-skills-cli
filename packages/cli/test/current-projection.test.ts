import { expect, test } from "bun:test"
import { Command } from "effect/cli"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"
import {
  currentProjectionCommand,
  currentProjectionRecoveryNext,
  prepareCurrentProjectionOptions,
} from "../src/commands-current-projection.ts"

const target = "41b5636c-236e-81d3-ba0f-c5fa3f735808"
const base = {
  target,
  daily: false,
  entry: library.skills.database_id,
  resume: false,
  dryRun: false,
}

test("projection recovery names the observed pending intent and never resumes another content writer", () => {
  expect(
    currentProjectionRecoveryNext(
      {
        projection: true,
        operation_id: "original-intent",
        skill_page_id: target,
      },
      target,
      library.skills.database_id,
    ),
  ).toMatchObject({
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "projection",
      target,
      "--entry",
      library.skills.database_id,
      "--operation",
      "original-intent",
      "--resume",
    ],
    read_only: false,
  })
  expect(
    currentProjectionRecoveryNext(
      {
        operation_id: "content-intent",
        owner: { kind: "skill", id: "owned-skill" },
      },
      target,
      library.skills.database_id,
    ),
  ).toMatchObject({
    argv: [
      "ntn-skills",
      "ctl",
      "library",
      "operation",
      "owned-skill",
      "--kind",
      "skill",
      "--entry",
      library.skills.database_id,
    ],
    read_only: true,
  })
  expect(
    currentProjectionRecoveryNext({ path: "missing.md" }, target, library.skills.database_id),
  ).toBeUndefined()
})

test("projection scope is explicit and a batch cannot reinterpret one Skill's recovery identity", () => {
  expect(prepareCurrentProjectionOptions(base).scope).toEqual({ kind: "skill", page_id: target })
  expect(
    prepareCurrentProjectionOptions({ ...base, target: undefined, daily: true }).scope,
  ).toEqual({ kind: "daily" })
  expect(
    prepareCurrentProjectionOptions({
      ...base,
      target:
        "https://app.notion.com/p/statechart-41b5636c236e81d3ba0fc5fa3f735808?source=copy_link",
      operation: "projection-intent",
      resume: true,
    }),
  ).toMatchObject({ scope: { kind: "skill", page_id: target }, mode: "resume" })
  for (const input of [
    { ...base, target: undefined },
    { ...base, daily: true },
    { ...base, target: undefined, daily: true, operation: "one-intent" },
    { ...base, target: undefined, daily: true, resume: true },
    { ...base, resume: true },
    { ...base, operation: "one-intent", resume: true, dryRun: true },
    { ...base, target: "https://example.com/41b5636c236e81d3ba0fc5fa3f735808" },
    { ...base, target: "statechart" },
    { ...base, operation: "invalid operation" },
    { ...base, entry: "notion_page:" + target },
    { ...base, maxRequests: 0 },
    { ...base, maxBytes: -1 },
    { ...base, timeout: 1.5 },
  ])
    expect(() => prepareCurrentProjectionOptions(input)).toThrow()
})

test("public projection parsing rejects an ambiguous write scope before any remote request", async () => {
  const f = currentWriteFixture(await mkdtemp(join(tmpdir(), "ntn-cli-projection-")))
  for (const args of [
    ["--entry", library.skills.database_id],
    [target, "--daily", "--entry", library.skills.database_id],
    ["--daily", "--operation", "one-intent", "--entry", library.skills.database_id],
    [target, "--resume", "--entry", library.skills.database_id],
    [target, "--max-requests", "0", "--entry", library.skills.database_id],
  ]) {
    await expect(
      f.run(
        Command.runWith(currentProjectionCommand, { version: "test", renderErrors: false })(args),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  }
  expect(f.calls).toEqual([])
  expect(f.mutations()).toEqual([])
})

test("the installed projection schema exposes bounded explicit management without a takeover or supersede route", () => {
  const schema = property(commandSchema(currentProjectionCommand))
  if (!Array.isArray(schema.parameters)) throw new Error("Missing command parameters")
  const parameters = schema.parameters.map(property)
  for (const name of ["daily", "dry-run", "resume", "operation", "entry"])
    expect(parameters.some((parameter) => parameter.name === name)).toBe(true)
  for (const name of ["max-requests", "max-bytes", "timeout"])
    expect(parameters.find((parameter) => parameter.name === name)?.primitive).toBe("Int")
  for (const name of ["native", "as", "supersede"])
    expect(parameters.some((parameter) => parameter.name === name)).toBe(false)
})
