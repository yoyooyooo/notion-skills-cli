import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  freezeCurrentImportValue,
  thawCurrentImportSkill,
  withCurrentImportPlan,
  type CurrentImportDefinition,
  type CurrentImportSession,
} from "../src/shared-current-import-plan.ts"
import { preservesCurrentImportPlan } from "../src/shared-current-import-plan-model.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { currentWriteFixture, library } from "./shared-current-write-fixture.ts"

async function fixture() {
  const f = currentWriteFixture(await mkdtemp(join(tmpdir(), "ntn-frozen-import-")))
  const prepared = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "frozen",
      kind: "skill",
      name: "Frozen",
      description: "Frozen",
      files: [{ path: "SKILL.md", bytes: new TextEncoder().encode("# Frozen original\n") }],
    }),
  )
  const body = await f.run(freezeCurrentImportValue(prepared))
  const definition: CurrentImportDefinition = {
    version: 1,
    kind: "single",
    mapping: [],
    rewrites: [],
    items: [
      {
        skill_id: "frozen",
        original_input_sha256: prepared.input_sha256,
        body,
        body_input_sha256: prepared.input_sha256,
        create_only: true,
        members_discovery: { member_policy: "first_creation", confirmed: [], unresolved: [] },
      },
    ],
  }
  const request = {
    operation_id: "frozen-op",
    request_sha256: prepared.input_sha256,
    mode: "apply" as const,
  }
  const write = (session: CurrentImportSession) =>
    Effect.gen(function* () {
      const item = session.definition.items[0]!
      const plan = yield* thawCurrentImportSkill(item.body)
      const phase = yield* session.start("body:frozen", {
        skill_id: "frozen",
        operation_id: request.operation_id,
        input_sha256: item.body_input_sha256,
        prepared: item.body,
      })
      return yield* writeCurrentSkill(library, {
        plan,
        operation_id: request.operation_id,
        mode: phase.mode,
        create_only: true,
        frozen_import: phase.proof,
      })
    })
  return { f, prepared, definition, request, write }
}

test("a lost local completion ACK resumes by exact read-only verification without recompilation or CREATE replay", async () => {
  const { f, definition, request, write } = await fixture()
  await expect(
    f.run(
      withCurrentImportPlan(library, request, Effect.succeed(definition), (session) =>
        write(session).pipe(
          Effect.andThen(Effect.fail(fail("TEST_CRASH", "Crash before local completion ACK"))),
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: "TEST_CRASH" })
  expect(f.table("skills")).toHaveLength(1)
  f.clearCalls()
  const result = await f.run(
    withCurrentImportPlan(
      library,
      { ...request, mode: "resume" },
      Effect.die("Resume recompiled its inputs"),
      (session) =>
        Effect.gen(function* () {
          const result = yield* write(session)
          yield* session.complete("body:frozen", result)
          return result
        }),
    ).pipe(Effect.result),
  )
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") throw result.failure
  expect(result.success.state).toBe("ready")
  expect(f.mutations()).toEqual([])
  expect([...f.json.keys()].filter((key) => key.startsWith("operations/import-plan/"))).toEqual([])
})

test("completed import verification rejects changed content instead of overwriting it", async () => {
  const { f, definition, request, write } = await fixture()
  await expect(
    f.run(
      withCurrentImportPlan(library, request, Effect.succeed(definition), (session) =>
        write(session).pipe(Effect.andThen(Effect.fail(fail("TEST_CRASH", "Lost local ACK")))),
      ),
    ),
  ).rejects.toMatchObject({ code: "TEST_CRASH" })
  const owner = f.table("skills")[0]!
  property(owner.properties)[library.skills.property_ids.Name!] = {
    id: library.skills.property_ids.Name,
    type: "title",
    title: [
      { type: "text", text: { content: "Changed by author" }, plain_text: "Changed by author" },
    ],
  }
  f.clearCalls()
  await expect(
    f.run(
      withCurrentImportPlan(
        library,
        { ...request, mode: "resume" },
        Effect.die("Unexpected recompile"),
        write,
      ),
    ),
  ).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
})

test("frozen progress allows only additive phases and cannot change mapping, bytes or a started intent", async () => {
  const { f, definition, request } = await fixture()
  await expect(
    f.run(
      withCurrentImportPlan(library, request, Effect.succeed(definition), (session) =>
        Effect.gen(function* () {
          const item = session.definition.items[0]!
          yield* session.start("body:frozen", {
            skill_id: "frozen",
            operation_id: request.operation_id,
            input_sha256: item.body_input_sha256,
            prepared: item.body,
          })
          return yield* Effect.fail(fail("TEST_CRASH", "Retain started phase"))
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "TEST_CRASH" })
  const state = [...f.json].find(([key]) => key.startsWith("operations/import-plan/"))![1]
  expect(preservesCurrentImportPlan(state, state)).toBe(true)
  const next = structuredClone(state)
  property(property(next).steps)["body:frozen"] = {
    ...property(property(property(next).steps)["body:frozen"]),
    phase: "complete",
    result: { state: "ready" },
  }
  expect(preservesCurrentImportPlan(state, next)).toBe(true)
  expect(preservesCurrentImportPlan(next, state)).toBe(false)
  const changed = structuredClone(state)
  property(property(property(changed).steps)["body:frozen"]).input_sha256 = "0".repeat(64)
  expect(preservesCurrentImportPlan(state, changed)).toBe(false)
  const lost = { ...property(state), steps: {} }
  expect(preservesCurrentImportPlan(state, lost)).toBe(false)
})

test("a started phase with a pre-dispatch read failure remains fenced without inventing a replay authorization", async () => {
  const { f, definition, request, write } = await fixture()
  await expect(
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* withCurrentImportPlan(
          library,
          request,
          Effect.succeed(definition),
          (session) =>
            write(session).pipe(
              Effect.provideService(Notion, {
                ...api,
                request: (path, body, options) =>
                  path.includes("/query")
                    ? Effect.fail(fail("TEST_READ_FAILED", "Read failed before the first dispatch"))
                    : api.request(path, body, options),
              }),
            ),
        )
      }),
    ),
  ).rejects.toMatchObject({ code: "TEST_READ_FAILED" })
  expect(f.mutations()).toEqual([])
  await expect(
    f.run(
      withCurrentImportPlan(
        library,
        { ...request, mode: "resume" },
        Effect.die("Unexpected recompile"),
        write,
      ),
    ),
  ).rejects.toMatchObject({
    code: "CURRENT_IMPORT_PHASE_UNRESOLVED",
    details: { plan_retained: true, next: "inspect_and_reconcile" },
  })
  expect(f.mutations()).toEqual([])
  expect(f.table("skills")).toEqual([])
})
