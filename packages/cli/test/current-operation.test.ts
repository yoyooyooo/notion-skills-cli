import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { trashPath } from "../../core/src/local-locks.ts"
import { property } from "../../core/src/model.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../../core/src/shared-current-write.ts"
import {
  currentWriteFixture,
  library,
  testBytes,
} from "../../core/test/shared-current-write-fixture.ts"
import {
  currentOperationCommand,
  inspectCurrentLibraryOperation,
} from "../src/commands-current-operation.ts"
import { libraryCommand } from "../src/commands-library.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-operation-cli-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const entry = library.skills.database_id
const owner = { kind: "skill", id: "pending-skill" } as const

test("operation inspection is one current read route with exact owner and bounded controls", () => {
  expect(selectCommand(libraryCommand, ["operation"])).toBe(currentOperationCommand)
  expect(currentOperationCommand.subcommands).toEqual([])
  const schema = property(commandSchema(currentOperationCommand))
  const parameters = Array.isArray(schema.parameters) ? schema.parameters.map(property) : []
  for (const name of ["owner-id", "kind", "entry"])
    expect(parameters.find((parameter) => parameter.name === name)).toMatchObject({
      required: true,
    })
  for (const name of ["max-requests", "max-bytes", "timeout"])
    expect(parameters.find((parameter) => parameter.name === name)).toMatchObject({
      primitive: "Int",
      max_occurrences: 1,
    })
  for (const name of ["resume", "supersede", "operation", "repair"])
    expect(parameters.find((parameter) => parameter.name === name)).toBeUndefined()
})

test("operation local admission refuses invalid kinds, identities, entries and budgets before remote reads", async () => {
  const f = currentWriteFixture(parent)
  for (const changed of [
    { kind: "page" },
    { ownerId: "unsafe identity" },
    { entry: "notion_page:old" },
    { entry: "skill://old" },
    { maxRequests: 0 },
    { maxBytes: -1 },
    { timeout: 1.5 },
    { kind: "source", ownerId: "source-" + "a".repeat(64) },
  ])
    await expect(
      f.run(
        inspectCurrentLibraryOperation({ ownerId: owner.id, kind: owner.kind, entry, ...changed }),
      ),
    ).rejects.toThrow()
  for (const args of [
    [owner.id, "--entry", entry],
    [owner.id, "--kind", "skill", "--entry", entry, "--resume"],
    [owner.id, "--kind", "skill", "--entry", entry, "--kind", "source"],
    [owner.id, "--kind", "skill", "--entry", entry, "--max-requests", "0"],
  ])
    await expect(
      f.run(Command.runWith(currentOperationCommand, { version: "0" })(args)),
    ).rejects.toThrow()
  expect(f.calls).toEqual([])
  expect(f.mutations()).toEqual([])
})

test("no observable Skill or Source intent does not certify an owner is present, ready or retired", async () => {
  const f = currentWriteFixture(parent)
  for (const kind of ["skill", "source"] as const) {
    f.clearCalls()
    const value = await f.run(
      inspectCurrentLibraryOperation({ ownerId: "not-created", kind, entry, maxRequests: 37 }),
    )
    expect(value).toMatchObject({
      version: 1,
      contract: "current",
      owner: { kind, id: "not-created" },
      status: "not_found",
      operation: null,
      library: {
        library_id: library.library_id,
        database_id: entry,
        data_source_id: library.skills.data_source_id,
      },
      budget: { limits: { requests: 37 } },
    })
    expect("state" in value).toBe(false)
    expect(f.calls.some((call) => call.path.startsWith("v1/pages/"))).toBe(false)
    expect(f.calls.some((call) => call.path.includes("/query"))).toBe(true)
    expect(f.mutations()).toEqual([])
  }
})

test("the public operation reader reports a real unknown CREATE without replay or state changes", async () => {
  const f = currentWriteFixture(parent)
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: owner.id,
      kind: "skill",
      name: "Pending",
      description: "Current unknown create",
      files: [{ path: "SKILL.md", bytes: testBytes("# Pending original\n") }],
    }),
  )
  f.failNext({ kind: "skill-create", outcome: "absent" })
  await expect(
    f.run(writeCurrentSkill(library, { plan, operation_id: "create-intent" })),
  ).rejects.toThrow()
  const pages = JSON.stringify([...f.pages])
  const pending = () =>
    JSON.stringify(
      [...f.json].filter(([key]) => key.startsWith("operations/current-write-pending/")),
    )
  const before = pending()
  f.clearCalls()
  const value = await f.run(
    inspectCurrentLibraryOperation({ ownerId: owner.id, kind: owner.kind, entry }),
  )
  expect(value).toMatchObject({
    status: "observed",
    owner,
    operation: {
      owner,
      intent: { owner, operation_id: "create-intent", input_sha256: plan.input_sha256 },
      completion: "ready",
      owner_page_id: null,
      owner_state: null,
      owner_in_trash: null,
      record_observed: true,
    },
  })
  expect(value.operation?.in_flight).not.toBeNull()
  expect(value.operation?.record_page_id).toMatch(/^[a-f0-9-]{36}$/)
  expect(value.operation?.local_lifecycle?.phase).toBe("active")
  expect(
    f.calls.some((call) => call.path.includes("/markdown") || call.path.includes("/children")),
  ).toBe(false)
  expect(f.mutations()).toEqual([])
  expect(JSON.stringify([...f.pages])).toBe(pages)
  expect(pending()).toBe(before)
})
