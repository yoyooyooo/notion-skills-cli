import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { appendSharedRecord, canonicalSharedJson } from "../src/shared-records.ts"
import { prepareSharedBodyWrite, executeSharedBodyWrite } from "../src/shared-body-write.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "../src/shared-pending-file-operations.ts"
import {
  isSharedMaintenanceOperation,
  showSharedMaintenanceOperation,
  reconcileSharedMaintenanceOperation,
} from "../src/shared-maintenance-operations.ts"
import { sharedSnapshotFixture, library, skillPage } from "./shared-snapshot-fixture.ts"
import { Store } from "../src/store.ts"

async function original() {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  await f.open()
  const plan = await f.run(
    prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId: "file-main",
      action: "write",
      candidateMarkdown: "# Reviewed original write\n",
    }),
  )
  const scope = await f.run(authScope)
  const pending = {
    scope,
    library_id: library.library_id,
    skill_id: plan.skill_id,
    skill_page_id: skillPage,
    prefix: await f.run(sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id)),
  }
  await f.run(retainPendingFileOperation(pending, plan))
  f.clearCalls()
  return { f, plan, pending }
}

test("maintenance show uses the original exact local intent without publishing its body or replaying it", async () => {
  const { f, plan } = await original()
  const before = canonicalSharedJson({
    main: f.main,
    files: f.files,
    bodies: [...f.bodies],
    records: [...f.records],
  })
  const result = await f.run(showSharedMaintenanceOperation({ operationId: plan.operation_id }))
  expect(result).toMatchObject({
    domain: "shared_maintenance",
    family: "body_write",
    operation_id: plan.operation_id,
    state: "original_intent_recorded",
    verified: false,
    resume_supported: false,
    remote_writes: 0,
    target: { page_id: skillPage, file_id: plan.file_id },
    coverage: { terminal_outcome: "not_checked" },
  })
  expect(JSON.stringify(result)).not.toContain(plan.candidate.markdown)
  expect(f.calls.every((call) => call.method === "GET" || call.path.includes("/query"))).toBe(true)
  expect(
    canonicalSharedJson({
      main: f.main,
      files: f.files,
      bodies: [...f.bodies],
      records: [...f.records],
    }),
  ).toBe(before)
})

test("shared operation IDs containing a content hash stay exact; path and wrong scope are rejected", async () => {
  const { f, plan } = await original()
  expect(isSharedMaintenanceOperation(plan.operation_id)).toBe(true)
  expect(isSharedMaintenanceOperation(plan.operation_id + "/../other")).toBe(false)
  const result = await f.run(
    showSharedMaintenanceOperation({
      operationId: plan.operation_id,
      target: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "OPERATION_SCOPE_MISMATCH" } })
  expect(f.writeCount()).toBe(0)
})

test("missing local state does not start a replacement or consult unrelated operation domains", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  const result = await f.run(
    showSharedMaintenanceOperation({ operationId: "metadata-write-" + "a".repeat(64) }).pipe(
      Effect.result,
    ),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "OPERATION_CONTEXT_REQUIRED" } })
  expect(f.calls.every((call) => !call.path.includes("/data_sources/"))).toBe(true)
  expect(f.writeCount()).toBe(0)
})

test("the shared route refuses an original intent with incomplete retained evidence", async () => {
  const { f, plan, pending } = await original()
  await f.run(
    appendSharedRecord(library, {
      mode: "create",
      recordId: plan.operation_id,
      operationId: plan.operation_id,
      skillPageId: skillPage,
      kind: "operation",
      entityId: plan.file_id,
      payload: plan,
      payloadContainsBody: true,
    }),
  )
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(pending.prefix, plan)])
    }),
  )
  f.bodies.set(skillPage, plan.candidate.markdown)
  f.clearCalls()
  const selection = {
    operationId: plan.operation_id,
    target: skillPage,
    entry: library.skills.database_id,
  }
  const shown = await f.run(showSharedMaintenanceOperation(selection))
  expect(shown.coverage.original_intent).toBe("original_shared_intent")
  expect(shown.verified).toBe(false)
  const result = await f.run(reconcileSharedMaintenanceOperation(selection).pipe(Effect.result))
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "SHARED_RECORD_UNRESOLVED" } })
  expect(f.calls.every((call) => call.method === "GET" || call.path.includes("/query"))).toBe(true)
  expect(f.writeCount()).toBe(0)
})

test("an applied body with a lost response remains unknown through the unified original-operation route", async () => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  await f.open()
  const plan = await f.run(
    prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId: "file-main",
      action: "write",
      candidateMarkdown: "# Exact original candidate\n",
    }),
  )
  const dispatched = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            if (path === `v1/pages/${skillPage}/markdown` && options?.method === "PATCH") {
              const updates = property(property(body).update_content).content_updates
              expect(Array.isArray(updates)).toBe(true)
              const change = property(Array.isArray(updates) ? updates[0] : undefined)
              expect(typeof change.old_str).toBe("string")
              expect(typeof change.new_str).toBe("string")
              f.calls.push({ path, body, method: "PATCH" })
              f.bodies.set(
                skillPage,
                String(f.bodies.get(skillPage)).replace(
                  String(change.old_str),
                  String(change.new_str),
                ),
              )
              return Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "The source applied the exact request but its response was lost",
                ),
              )
            }
            return api.request(path, body, options)
          },
        }),
      )
    }).pipe(Effect.result),
  )
  expect(dispatched).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
  expect(f.bodies.get(skillPage)).toBe(plan.candidate.markdown)
  const records = canonicalSharedJson([...f.records])
  f.clearCalls()
  const result = await f.run(
    reconcileSharedMaintenanceOperation({
      operationId: plan.operation_id,
      target: skillPage,
      entry: library.skills.database_id,
    }).pipe(Effect.result),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "SHARED_BODY_WRITE_UNRESOLVED" },
  })
  if (result._tag === "Failure")
    expect(property(result.failure.details).body_matches_candidate).toBe(true)
  expect(f.calls.every((call) => call.method === "GET" || call.path.includes("/query"))).toBe(true)
  expect(canonicalSharedJson([...f.records])).toBe(records)
})
