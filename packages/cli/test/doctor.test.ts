import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Sink, Stdio } from "effect"
import { Command } from "effect/cli"
import { trashPath } from "../../core/src/local-locks.ts"
import { fail, property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { openSkill } from "../../core/src/snapshot.ts"
import { currentWriteFixture, id, library } from "../../core/test/shared-current-write-fixture.ts"
import { doctorCommand } from "../src/commands-doctor.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-doctor-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})

function fixture() {
  const f = currentWriteFixture(parent)
  const run = (args: readonly string[], authenticationFailure = false) =>
    f.run(
      Effect.gen(function* () {
        const stdio = yield* Stdio.Stdio
        const api = yield* Notion
        const output: string[] = []
        yield* Command.runWith(doctorCommand, { version: "test", renderErrors: false })(args).pipe(
          Effect.provideService(Stdio.Stdio, {
            ...stdio,
            stdout: () =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Effect.sync(() => {
                  output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
                }),
              ),
          }),
          Effect.provideService(
            Notion,
            authenticationFailure
              ? {
                  ...api,
                  connectionIdentity: Effect.fail(
                    fail("AUTH_REQUIRED", "Controlled denied authentication."),
                  ),
                }
              : api,
          ),
        )
        return property(JSON.parse(output.join("")))
      }),
    )
  return { ...f, doctor: run }
}

function addUnreadySkill(f: ReturnType<typeof fixture>) {
  const fields = library.skills.property_ids
  const rich = (name: string, value: string) => ({
    id: fields[name],
    type: "rich_text",
    rich_text: [{ plain_text: value }],
  })
  f.pages.set(id(1000), {
    object: "page",
    id: id(1000),
    parent: {
      type: "data_source_id",
      database_id: library.skills.database_id,
      data_source_id: library.skills.data_source_id,
    },
    properties: {
      [fields.Name!]: {
        id: fields.Name,
        type: "title",
        title: [{ plain_text: "Enabled unready Skill" }],
      },
      [fields.Description!]: rich(
        "Description",
        "Directory metadata does not prove content readiness.",
      ),
      [fields.Kind!]: { id: fields.Kind, type: "select", select: { name: "skill" } },
      [fields.Enabled!]: { id: fields.Enabled, type: "checkbox", checkbox: true },
      [fields["Default Context"]!]: {
        id: fields["Default Context"],
        type: "checkbox",
        checkbox: false,
      },
      [fields["Skill ID"]!]: rich("Skill ID", "unready"),
      [fields["Main File ID"]!]: rich("Main File ID", "unready-main"),
      [fields.Members!]: { id: fields.Members, type: "relation", relation: [], has_more: false },
      [fields.Requires!]: { id: fields.Requires, type: "relation", relation: [], has_more: false },
    },
  })
}

test("doctor without a selected database only checks authentication", async () => {
  const f = fixture()
  const report = await f.doctor([])
  expect(report).toMatchObject({
    ok: true,
    authentication: "available",
    discovery: { checked: false },
    skill_read: { checked: false },
  })
  expect(f.calls).toEqual([])
})

test("doctor inspects catalog and schema without probing an arbitrary enabled Skill's content", async () => {
  const f = fixture()
  addUnreadySkill(f)
  const report = await f.doctor(["--library", library.library_id])
  expect(report).toMatchObject({
    ok: true,
    authentication: "available",
    discovery: { checked: true },
    skills_databases: 1,
    skill_count: 1,
    skill_read: { checked: false },
    coverage: { exhaustive: true, failed_sources: [] },
    native_relations: [{ ready: true }],
  })
  expect(
    f.calls.some((call) => call.path === `v1/data_sources/${library.skills.data_source_id}`),
  ).toBe(true)
  expect(
    f.calls.some(
      (call) => call.path.startsWith("v1/pages/") && call.path !== `v1/pages/${library.library_id}`,
    ),
  ).toBe(false)
  expect(f.downloads).toEqual([])
  expect(f.objects.size).toBe(0)
  expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  expect(f.mutations()).toEqual([])
  await expect(
    f.run(openSkill(id(1000), { library: library.library_id, refresh: true })),
  ).rejects.toMatchObject({ code: "CURRENT_SCHEMA_REQUIRED" })
})

test("doctor reports an empty catalog without claiming a content probe", async () => {
  const f = fixture()
  expect(await f.doctor(["--library", library.library_id])).toMatchObject({
    skill_count: 0,
    skill_read: { checked: false },
    coverage: { exhaustive: true, failed_sources: [] },
  })
  expect(
    f.calls.some(
      (call) => call.path.startsWith("v1/pages/") && call.path !== `v1/pages/${library.library_id}`,
    ),
  ).toBe(false)
})

test("doctor preserves authentication and selected schema failures", async () => {
  const denied = fixture()
  await expect(denied.doctor(["--library", library.library_id], true)).rejects.toMatchObject({
    code: "AUTH_REQUIRED",
  })
  expect(denied.calls).toEqual([])
  const invalid = fixture()
  invalid.rewrite((path, response) => {
    if (path === `v1/data_sources/${library.skills.data_source_id}`)
      delete property(response.properties).Content
    return response
  })
  await expect(invalid.doctor(["--library", library.library_id])).rejects.toMatchObject({
    code: "LIBRARY_SCHEMA_CONFLICT",
  })
  expect(invalid.mutations()).toEqual([])
})

test("doctor preserves incomplete catalog coverage instead of certifying missing metadata", async () => {
  const f = fixture()
  f.rewrite((path, response) =>
    path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
      ? { ...response, has_more: true, next_cursor: null }
      : response,
  )
  expect(await f.doctor(["--library", library.library_id])).toMatchObject({
    skill_read: { checked: false },
    coverage: { exhaustive: false, failed_sources: [{ code: "INVALID_RESPONSE" }] },
  })
  expect(
    f.calls.some(
      (call) => call.path.startsWith("v1/pages/") && call.path !== `v1/pages/${library.library_id}`,
    ),
  ).toBe(false)
})
