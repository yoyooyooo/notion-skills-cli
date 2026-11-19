import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { withCurrentInvocationBudget } from "../src/shared-current-invocation.ts"
import { withCurrentOperation } from "../src/shared-current-operation.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { Store } from "../src/store.ts"
import { recordedFixtureTransport } from "./notion-http-fixture.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "ntn-current-write-failure-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const operationId = "unfinished-current-write"
const input = (body = "# Current\n[Guide](guide.md)\n") => ({
  skill_id: "failure-current",
  kind: "skill" as const,
  name: "Current failure context",
  description: "A complete current input",
  files: [
    { path: "SKILL.md", bytes: testBytes(body) },
    { path: "guide.md", bytes: testBytes("# Complete guide\n") },
  ],
})

async function interrupted() {
  const f = currentWriteFixture(root)
  const plan = await f.run(prepareCurrentSkillWrite(input()))
  f.failNext({ kind: "append", outcome: "accepted" })
  const stopped = await f.run(
    writeCurrentSkill(library, { plan, operation_id: operationId }).pipe(Effect.result),
  )
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  const page = String(f.table("skills")[0]!.id)
  const pending = [...f.json.keys()].filter((key) => key.includes("current-write-pending"))
  expect(pending).toHaveLength(1)
  return {
    f,
    plan,
    page,
    pendingKey: pending[0]!,
    intent: {
      operation_id: operationId,
      skill_id: plan.skill_id,
      input_sha256: plan.input_sha256,
    },
  }
}

test("a real HTTP budget exhausted on the next Files page retains only a confirmed unfinished owner", async () => {
  const { f, plan, page, intent, pendingKey } = await interrupted()
  const pending = structuredClone(f.json.get(pendingKey))
  const writes = f.mutations().length
  const filesPath = `v1/data_sources/${library.files.data_source_id}/query`
  f.rewrite((path, value) =>
    path.startsWith(filesPath)
      ? { ...value, results: [], has_more: true, next_cursor: "files-next-page" }
      : value,
  )
  await recordedFixtureTransport(await f.run(Notion), async (api, requests) => {
    for (const selectedOperation of [operationId, "unconfirmed-operation"]) {
      const start = requests.length
      const outcome = await f.run(
        withCurrentInvocationBudget(
          writeCurrentSkill(library, { plan, operation_id: selectedOperation, mode: "resume" }),
          { requests: 2 },
        ).pipe(Effect.result, Effect.provideService(Notion, api)),
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag !== "Failure") throw new Error("The Files continuation escaped its budget")
      expect(outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
      expect(property(outcome.failure.details).budget).toMatchObject({
        attempts: 2,
        exhausted: "requests",
      })
      if (selectedOperation === operationId)
        expect(outcome.failure.details).toMatchObject({
          ...intent,
          skill_page_id: page,
          next: "reconcile_current",
        })
      else expect(property(outcome.failure.details).operation_id).toBeUndefined()
      expect(requests.slice(start).map((request) => request.path.split("?")[0])).toEqual([
        `v1/data_sources/${library.skills.data_source_id}/query`,
        filesPath,
      ])
    }
  })
  expect(f.mutations().length).toBe(writes)
  expect(f.json.get(pendingKey)).toEqual(pending)
})

test("a confirmed owner retains context when real HTTP admission stops the kernel's first Operation lookup", async () => {
  const { f, plan, page, intent, pendingKey } = await interrupted()
  f.json.delete(pendingKey) // Another caller has the original input, but no local pending locator.
  const writes = f.mutations().length
  await recordedFixtureTransport(await f.run(Notion), async (api, requests) => {
    const outcome = await f.run(
      withCurrentInvocationBudget(
        writeCurrentSkill(library, { plan, operation_id: operationId, mode: "resume" }),
        { requests: 2 },
      ).pipe(Effect.result, Effect.provideService(Notion, api)),
    )
    expect(outcome._tag).toBe("Failure")
    if (outcome._tag !== "Failure") throw new Error("The Operation lookup escaped its budget")
    expect(outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
    expect(outcome.failure.details).toMatchObject({
      ...intent,
      skill_page_id: page,
      next: "reconcile_current",
      budget: { attempts: 2, exhausted: "requests" },
    })
    expect(requests.map((request) => request.path.split("?")[0])).toEqual([
      `v1/data_sources/${library.skills.data_source_id}/query`,
      `v1/data_sources/${library.files.data_source_id}/query`,
    ])
  })
  expect(f.mutations().length).toBe(writes)
  expect(f.json.has(pendingKey)).toBe(false)
})

test("kernel early budget failures retain an observed pending intent without leaking it across Effect executions", async () => {
  const { f, page, intent, pendingKey } = await interrupted()
  const writes = f.mutations().length
  let entered = false
  const operation = withCurrentOperation(library, {
    intent: {
      operation_id: intent.operation_id,
      input_sha256: intent.input_sha256,
      owner: { kind: "skill", id: intent.skill_id },
    },
    ownerPageId: page,
    mode: "resume",
    run: () =>
      Effect.sync(() => {
        entered = true
      }),
    verify: () => Effect.void,
  })
  await recordedFixtureTransport(await f.run(Notion), async (api, requests) => {
    for (const confirmed of [true, false]) {
      if (!confirmed) f.json.delete(pendingKey)
      const start = requests.length
      const outcome = await f.run(
        withCurrentInvocationBudget(
          Effect.gen(function* () {
            yield* api.request(`v1/pages/${page}`)
            return yield* operation
          }),
          { requests: 1 },
        ).pipe(Effect.result, Effect.provideService(Notion, api)),
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag !== "Failure") throw new Error("The Operation lookup escaped its budget")
      expect(outcome.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
      expect(property(outcome.failure.details).budget).toMatchObject({
        attempts: 1,
        exhausted: "requests",
      })
      if (confirmed)
        expect(outcome.failure.details).toMatchObject({
          ...intent,
          skill_page_id: page,
          next: "reconcile_current",
        })
      else expect(property(outcome.failure.details).operation_id).toBeUndefined()
      expect(requests.slice(start).map((request) => request.path)).toEqual([`v1/pages/${page}`])
    }
  })
  expect(entered).toBe(false)
  expect(f.mutations().length).toBe(writes)
})

test("saving an observed Operation locally retains context before execute and an input mismatch keeps the original fingerprint", async () => {
  const { f, plan, page, intent } = await interrupted()
  const writes = f.mutations().length
  const storageFailure = await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      return yield* withCurrentOperation(library, {
        intent: {
          operation_id: intent.operation_id,
          input_sha256: intent.input_sha256,
          owner: { kind: "skill", id: intent.skill_id },
        },
        ownerPageId: page,
        mode: "resume",
        run: () => Effect.die("Execution must not start after a failed pending save"),
        verify: () => Effect.void,
      }).pipe(
        Effect.provideService(Store, {
          ...store,
          writeJson: (key, value) =>
            key.includes("current-write-pending")
              ? Effect.fail(fail("STORAGE_ERROR", "The local pending file cannot be saved."))
              : store.writeJson(key, value),
        }),
      )
    }).pipe(Effect.result),
  )
  expect(storageFailure._tag).toBe("Failure")
  if (storageFailure._tag === "Failure") {
    expect(storageFailure.failure.code).toBe("STORAGE_ERROR")
    expect(storageFailure.failure.details).toMatchObject({
      ...intent,
      skill_page_id: page,
      next: "reconcile_current",
    })
  }
  const changed = await f.run(
    prepareCurrentSkillWrite(input("# Changed candidate\n[Guide](guide.md)\n")),
  )
  expect(changed.input_sha256).not.toBe(plan.input_sha256)
  const mismatch = await f.run(
    writeCurrentSkill(library, { plan: changed, operation_id: operationId, mode: "resume" }).pipe(
      Effect.result,
    ),
  )
  expect(mismatch._tag).toBe("Failure")
  if (mismatch._tag === "Failure") {
    expect(mismatch.failure.code).toBe("CURRENT_OPERATION_PENDING")
    expect(mismatch.failure.details).toMatchObject({
      ...intent,
      skill_page_id: page,
      next: "reconcile_current",
    })
  }
  expect(f.mutations().length).toBe(writes)
})
