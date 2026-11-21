import { expect, test } from "bun:test"
import { Command } from "effect/cli"
import { Effect, Sink, Stdio } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import {
  currentWriteFixture,
  library,
  testBytes,
} from "../../core/test/shared-current-write-fixture.ts"
import { readCurrentOperationIntent } from "../../core/src/shared-current-operation.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../../core/src/shared-current-write.ts"
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
        projection_policy: { include: ["references/**/*.md"], exclude: ["**/tests/**"] },
      },
      target,
      library.skills.database_id,
      { requests: 7000, bytes: 900000, duration_ms: 3600000 },
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
      "--include",
      "references/**/*.md",
      "--exclude",
      "**/tests/**",
      "--max-requests",
      "7000",
      "--max-bytes",
      "900000",
      "--timeout",
      "3600000",
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
  expect(
    currentProjectionRecoveryNext(
      { projection: true, operation_id: "missing-frozen-policy" },
      target,
      library.skills.database_id,
    ),
  ).toBeUndefined()
})

test("projection scope is explicit and a batch cannot reinterpret one Skill's recovery identity", () => {
  expect(prepareCurrentProjectionOptions(base).scope).toEqual({ kind: "skill", page_id: target })
  expect(prepareCurrentProjectionOptions(base).mode).toBe("auto")
  expect(prepareCurrentProjectionOptions({ ...base, operation: "explicit" }).mode).toBe("apply")
  expect(prepareCurrentProjectionOptions({ ...base, dryRun: true }).mode).toBe("apply")
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
    { ...base, cancel: true },
    { ...base, cancel: true, operation: "one-intent", resume: true },
    { ...base, cancel: true, operation: "one-intent", dryRun: true },
    { ...base, cancel: true, operation: "one-intent", include: ["**/*.md"] },
    { ...base, target: undefined, daily: true, cancel: true, operation: "one-intent" },
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

test("the same daily CLI command resumes its interrupted Skill then completes the remaining targets", async () => {
  const f = currentWriteFixture(await mkdtemp(join(tmpdir(), "ntn-cli-daily-projection-")))
  const targets: string[] = []
  for (const skill_id of ["a-first", "b-second"]) {
    const plan = await f.run(
      prepareCurrentSkillWrite({
        skill_id,
        kind: "skill",
        name: skill_id,
        description: "Actual daily CLI continuation",
        files: [{ path: "SKILL.md", bytes: testBytes("# " + skill_id + "\n") }],
      }),
    )
    const written = await f.run(
      writeCurrentSkill(library, { plan, operation_id: "seed-" + skill_id }),
    )
    targets.push(written.page_id)
    Object.assign(property(f.pages.get(written.page_id)!.properties), {
      daily: { id: "daily", type: "checkbox", checkbox: true },
      delete: { id: "delete", type: "checkbox", checkbox: false },
    })
  }
  f.rewrite((path, response) =>
    [library.skills, library.sources].some(
      (table) => path === `v1/data_sources/${table.data_source_id}`,
    )
      ? {
          ...response,
          properties: {
            ...property(response.properties),
            日用: { id: "daily", name: "日用", type: "checkbox", checkbox: {} },
            期望删除: { id: "delete", name: "期望删除", type: "checkbox", checkbox: {} },
          },
        }
      : response,
  )
  const run = () =>
    f.run(
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio
        const output: string[] = []
        yield* Command.runWith(currentProjectionCommand, { version: "test", renderErrors: false })([
          "--daily",
          "--entry",
          library.skills.database_id,
        ]).pipe(
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
      }),
    )
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(run()).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: { failed_target: targets[0], completed: [], remaining_targets: [targets[1]] },
  })
  const pending = await f.run(readCurrentOperationIntent(library, { kind: "skill", id: "a-first" }))
  const firstBody = structuredClone(f.blocks.get(targets[0]!))
  f.clearCalls()
  const completed = await run()
  expect(completed).toMatchObject({ status: "complete", skills: 2 })
  expect(Array.isArray(completed.results) ? completed.results[0] : undefined).toMatchObject({
    operation_id: pending?.intent.operation_id,
    status: "unchanged",
  })
  expect(f.blocks.get(targets[0]!)).toEqual(firstBody)
  expect(f.mutations().filter((call) => call.path === `v1/blocks/${targets[0]}/children`)).toEqual(
    [],
  )
  for (const id of ["a-first", "b-second"])
    expect(await f.run(readCurrentOperationIntent(library, { kind: "skill", id }))).toBeUndefined()
  f.clearCalls()
  expect(await run()).toMatchObject({ status: "complete", skills: 2 })
  expect(f.mutations()).toEqual([])
})

test("reading globs replace their own defaults without changing operation scope", () => {
  const defaults = prepareCurrentProjectionOptions(base)
  expect(defaults.policy.include).toEqual(["**/*.md"])
  expect(defaults.policy.exclude.length).toBeGreaterThan(0)
  expect(
    prepareCurrentProjectionOptions({ ...base, include: ["references/**/*.md"] }).policy,
  ).toEqual({ include: ["references/**/*.md"], exclude: defaults.policy.exclude })
  expect(prepareCurrentProjectionOptions({ ...base, exclude: [] }).policy.exclude).toEqual([])
  for (const include of [["/absolute.md"], ["../outside.md"], [""], ["bad\\path.md"]])
    expect(() => prepareCurrentProjectionOptions({ ...base, include })).toThrow()
  expect(
    prepareCurrentProjectionOptions({ ...base, operation: "old-reading-intent", cancel: true })
      .scope,
  ).toEqual({ kind: "skill", page_id: target })
})

test("public projection parsing rejects an ambiguous write scope before any remote request", async () => {
  const f = currentWriteFixture(await mkdtemp(join(tmpdir(), "ntn-cli-projection-")))
  for (const args of [
    ["--entry", library.skills.database_id],
    [target, "--daily", "--entry", library.skills.database_id],
    ["--daily", "--operation", "one-intent", "--entry", library.skills.database_id],
    [target, "--resume", "--entry", library.skills.database_id],
    [target, "--cancel", "--entry", library.skills.database_id],
    [target, "--cancel", "--operation", "old", "--resume", "--entry", library.skills.database_id],
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
  for (const name of [
    "daily",
    "dry-run",
    "resume",
    "cancel",
    "include",
    "exclude",
    "operation",
    "entry",
  ])
    expect(parameters.some((parameter) => parameter.name === name)).toBe(true)
  for (const name of ["max-requests", "max-bytes", "timeout"])
    expect(parameters.find((parameter) => parameter.name === name)?.primitive).toBe("Int")
  for (const name of ["native", "as", "supersede"])
    expect(parameters.some((parameter) => parameter.name === name)).toBe(false)
})
