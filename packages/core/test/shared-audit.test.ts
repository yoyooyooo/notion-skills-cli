import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { property } from "../src/model.ts"
import {
  runSharedAudit,
  resumeSharedAudit,
  reportSharedAudit,
  listSharedAudits,
} from "../src/shared-audit.ts"
import { readAuditRun, saveAuditRun } from "../src/shared-audit-store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sharedCreateManifestEntity } from "../src/shared-create-model.ts"
import { prepareSharedBaselineInventory } from "../src/shared-inventory-remote.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { library, rich, skillPage } from "./shared-snapshot-fixture.ts"

test("census scope retains complete registered metadata without inspecting individual Skill states", async () => {
  const f = await auditFixture()
  const report = await f.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "census" } }),
  )
  expect(report.execution).toBe("completed")
  expect(report.items).toEqual([])
  expect(report).toMatchObject({
    inspection_scope: "registered_table_census",
    skill_states: "unobserved",
  })
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect(
    f.ledger.filter((call) =>
      call.path.includes(`/data_sources/${library.records.data_source_id}/query`),
    ),
  ).toHaveLength(2)
  expect(f.ledger.some((call) => call.path.includes("filter_properties=payload"))).toBe(false)
  const inventory = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(inventory.visible_registered_census?.coverage).toBe("full")
  expect(inventory.coverage).toBe("partial")
  expect(inventory.resources.every((resource) => !resource.automatic_candidate)).toBe(true)
})

test("census resumes its original read checkpoint and rejects content or graph claims before transport", async () => {
  const f = await auditFixture()
  for (const extra of [
    { depth: "content" as const },
    { depth: "history" as const },
    { graph_id: "graph-" + "a".repeat(64) },
  ]) {
    await expect(
      f.run(
        runSharedAudit({
          entry: library.skills.database_id,
          selector: { kind: "census" },
          ...extra,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  }
  expect(f.ledger).toHaveLength(0)
  let report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "census" },
      budget: { requests: 1 },
    }),
  )
  const id = report.run_id
  for (let i = 0; i < 20 && report.execution === "paused"; i++)
    report = await f.run(resumeSharedAudit(id, { budget: { requests: 2 } }))
  expect(report.execution).toBe("completed")
  expect(report.run_id).toBe(id)
  expect(report.selector).toEqual({ kind: "census" })
  expect(report.items).toEqual([])
  expect(f.writeCount()).toBe(0)
})

test("census drift stays incomplete instead of replacing the first observation with the second", async () => {
  const f = await auditFixture()
  let queries = 0
  f.intercept((path) => {
    if (path.includes(`/data_sources/${library.skills.data_source_id}/query`) && ++queries === 2)
      property(f.main.properties).description = rich("description", "Changed during census")
    return undefined
  })
  const report = await f.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "census" } }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("partial")
  expect(report.items).toEqual([])
  const inventory = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(inventory.visible_registered_census?.stable).toBe(false)
  expect(inventory.visible_registered_census?.coverage).toBe("partial")
  expect(f.writeCount()).toBe(0)
})

test("metadata audit independently inventories all three tables without bodies or object Payloads", async () => {
  const f = await auditFixture()
  const before = canonicalSharedJson([...f.records.values()])
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  expect(report.inventory.reverse_tables).toEqual(["skills", "files", "records"])
  expect(report.items[0]?.tree).toHaveLength(3)
  expect(report.items[0]?.tree.every((file) => file.byte_status === "unobserved")).toBe(true)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
  const census = f.ledger.filter(
    (call) =>
      call.path.includes(`/data_sources/${library.records.data_source_id}/query`) &&
      property(call.body).filter === undefined,
  )
  expect(census).toHaveLength(2)
  expect(census.every((call) => !call.path.includes("filter_properties=payload"))).toBe(true)
})

test("one-attempt budgets resume inside one Skill without resetting confirmed progress", async () => {
  const f = await auditFixture(5)
  let report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      depth: "content",
      budget: { requests: 1 },
    }),
  )
  expect(report.execution).toBe("paused")
  const runId = report.run_id
  let prior = report.request_totals.confirmed_requests
  for (let attempt = 0; attempt < 60 && report.execution === "paused"; attempt++) {
    report = await f.run(resumeSharedAudit(runId, { budget: { requests: 1 } }))
    expect(report.request_totals.confirmed_requests).toBeGreaterThanOrEqual(prior)
    expect(property(report.last_budget).attempts).toBeLessThanOrEqual(1)
    prior = report.request_totals.confirmed_requests
  }
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  expect(report.items[0]?.tree.every((file) => file.byte_status === "verified")).toBe(true)
  expect(f.readBodyCount()).toBe(5)
  expect(f.writeCount()).toBe(0)
  expect(report.request_totals.replayed_requests).toBeGreaterThan(0)
}, 30_000)

test("content audit reports an unconfirmed edit and an exact broken link without adoption", async () => {
  const f = await auditFixture(2)
  f.bodies.set(skillPage, "# Changed\n\n[missing](references/missing.md)\n")
  const before = canonicalSharedJson([...f.records.values()])
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("partial")
  expect(report.findings.some((finding) => finding.code === "REQUIRES_OBSERVATION_COMMIT")).toBe(
    true,
  )
  expect(
    report.findings.some(
      (finding) =>
        finding.code === "REFERENCE_TARGET_MISSING" &&
        finding.location.includes("references/missing.md"),
    ),
  ).toBe(true)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
  expect(f.writeCount()).toBe(0)
})

test("offline report performs zero network calls and rejects unknown/wrong-scope/corrupt checkpoints", async () => {
  const f = await auditFixture(1)
  const report = await f.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "library" } }),
  )
  f.clearLedger()
  const offline = await f.run(reportSharedAudit(report.run_id))
  expect(offline.run_id).toBe(report.run_id)
  expect(f.ledger).toHaveLength(0)
  expect(
    (await f.run(reportSharedAudit(report.run_id, "different-entry").pipe(Effect.flip))).code,
  ).toBe("AUDIT_SCOPE_MISMATCH")
  const key = `audit/runs/${report.run_id}.json`
  f.json.set(key, { ...property(f.json.get(key)), sha256: "0".repeat(64) })
  expect((await f.run(reportSharedAudit(report.run_id).pipe(Effect.flip))).code).toBe(
    "AUDIT_CHECKPOINT_CORRUPT",
  )
  expect((await f.run(reportSharedAudit("../config.json").pipe(Effect.flip))).code).toBe(
    "INVALID_ARGUMENT",
  )
  expect(f.ledger).toHaveLength(0)
})

test("incremental reuse checks child metadata and preserves stable finding lifecycle", async () => {
  const f = await auditFixture(2)
  const first = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  f.clearLedger()
  const unchanged = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
      incremental: true,
    }),
  )
  expect(unchanged.items[0]?.reused_from).toBe(first.run_id)
  expect(f.readBodyCount()).toBe(0)
  const child = f.files[0]!
  property(child.properties).path = rich("path", "references/renamed.md")
  child.last_edited_time = new Date(Date.now() + 1000).toISOString()
  f.clearLedger()
  const changed = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
      incremental: true,
    }),
  )
  expect(changed.items[0]?.reused_from).toBeNull()
  expect(f.readBodyCount()).toBeGreaterThan(0)
})

test("a denied body is checkpointed once and cannot starve later files with one-attempt budgets", async () => {
  const f = await auditFixture(3)
  const denied = `v1/pages/${skillPage}/markdown?markdown_version=v2`
  f.deny(denied)
  let report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
      budget: { requests: 1 },
    }),
  )
  for (let i = 0; i < 60 && report.execution === "paused"; i++)
    report = await f.run(resumeSharedAudit(report.run_id, { budget: { requests: 1 } }))
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("permission_limited")
  expect(f.ledger.filter((call) => call.path === denied)).toHaveLength(1)
  expect(report.items[0]?.tree.filter((file) => file.byte_status === "verified")).toHaveLength(2)
  expect(report.findings.some((finding) => finding.code === "CURRENT_BODY_UNAVAILABLE")).toBe(true)
  expect(f.writeCount()).toBe(0)
}, 30_000)

test("cancellation preserves a discoverable checkpoint and the local lock excludes a second resumer", async () => {
  const f = await auditFixture(2)
  const entered = Promise.withResolvers<void>()
  f.intercept((path) =>
    path === `v1/pages/${skillPage}/markdown?markdown_version=v2`
      ? Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never))
      : undefined,
  )
  const id = await f.run(
    Effect.gen(function* () {
      const fiber = yield* runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "library" },
        depth: "content",
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      const listed = yield* listSharedAudits()
      const runId = listed.runs[0]!.run_id
      expect(listed.runs[0]?.execution).toBe("running")
      const busy = yield* resumeSharedAudit(runId).pipe(Effect.flip)
      expect(busy.code).toBe("SYNC_LOCKED")
      yield* Fiber.interrupt(fiber)
      const paused = yield* reportSharedAudit(runId)
      expect(paused.execution).toBe("paused")
      expect(paused.pause_reason).toBe("cancelled")
      expect(paused.request_accounting.cumulative_precision).toBe("exact")
      return runId
    }),
  )
  f.intercept(undefined)
  f.clearLedger()
  const report = await f.run(resumeSharedAudit(id))
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("full")
  expect(f.ledger.some((call) => call.path === "v1/users/me")).toBe(false)
  expect(f.writeCount()).toBe(0)
}, 15_000)

test("an unclean invocation preserves confirmed reads without claiming exact lost in-flight metrics", async () => {
  const f = await auditFixture(1)
  const paused = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      budget: { requests: 1 },
    }),
  )
  const run = await f.run(readAuditRun(paused.run_id))
  await f.run(saveAuditRun({ ...run, execution: "running", invocation_open: true }))
  const report = await f.run(resumeSharedAudit(paused.run_id))
  expect(report.execution).toBe("completed")
  expect(report.request_accounting.cumulative_precision).toBe("lower_bound")
  expect(report.request_accounting.unclean_invocations).toBe(1)
  expect(report.request_totals.confirmed_requests).toBeGreaterThanOrEqual(
    paused.request_totals.confirmed_requests,
  )
  f.clearLedger()
  const listed = await f.run(listSharedAudits({ entry: library.skills.database_id }))
  expect(listed.runs[0]?.run_id).toBe(paused.run_id)
  expect(f.ledger).toHaveLength(0)
})

test("same credentials cannot resume across a changed API origin or API version", async () => {
  for (const changed of [{ origin: "https://another.notion.test" }, { version: "2099-01-01" }]) {
    const f = await auditFixture(1)
    const paused = await f.run(
      runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "library" },
        budget: { requests: 1 },
      }),
    )
    expect(paused.execution).toBe("paused")
    f.clearLedger()
    f.endpoint(changed)
    const error = await f.run(resumeSharedAudit(paused.run_id).pipe(Effect.flip))
    expect(error.code).toBe("AUDIT_SCOPE_MISMATCH")
    expect(f.ledger).toHaveLength(0)
    expect((await f.run(reportSharedAudit(paused.run_id))).run_id).toBe(paused.run_id)
    expect(f.ledger).toHaveLength(0)
  }
})

test("a historical checkpoint without endpoint proof stays readable but cannot resume", async () => {
  const f = await auditFixture(1)
  const paused = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      budget: { requests: 1 },
    }),
  )
  const { endpoint_scope, ...historical } = await f.run(readAuditRun(paused.run_id))
  expect(endpoint_scope).toMatch(/^[a-f0-9]{64}$/u)
  await f.run(saveAuditRun(historical))
  f.clearLedger()
  expect((await f.run(reportSharedAudit(paused.run_id))).execution).toBe("paused")
  const error = await f.run(resumeSharedAudit(paused.run_id).pipe(Effect.flip))
  expect(error.code).toBe("AUDIT_SCOPE_UNESTABLISHED")
  expect(f.ledger).toHaveLength(0)
})

test("a create-family manifest header without its original completion proof remains incomplete", async () => {
  const f = await auditFixture(1)
  const operation = `skill-create-${"a".repeat(64)}`
  f.seedFact(
    { version: 1, operation_id: operation, kind: "incomplete_create_fixture" },
    "object",
    sharedCreateManifestEntity,
    operation,
  )
  // The fixture exposes raw native rows so a malformed original operation can
  // remain present in the physical census rather than being filtered away.
  const manifest = [...f.records.values()].at(-1)
  if (manifest === undefined) throw new Error("Expected original manifest fixture")
  property(property(manifest.properties).kind).select = { name: "operation" }
  const before = canonicalSharedJson([...f.records.values()])
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  expect(report.execution).toBe("completed")
  expect(report.coverage).toBe("partial")
  expect(
    report.findings.some(
      (finding) =>
        finding.code === "OPERATION_EVIDENCE_UNAVAILABLE" ||
        finding.code === "ORIGINAL_OPERATION_UNRESOLVED",
    ),
  ).toBe(true)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
  expect(f.writeCount()).toBe(0)
})
