import { expect, test } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fail, property } from "../src/model.ts"
import { applySync, planSync, stableSyncJson, syncStatus } from "../src/sync.ts"
import {
  checkLocalSync,
  connectLocalSync,
  runLocalSync,
  LocalSyncCheckSchema,
  LocalSyncRunSchema,
} from "../src/local-sync-run.ts"
import type { fixture as controlledFixture } from "./sync-fixture.ts"

function code(result: { readonly _tag: string; readonly failure?: unknown }) {
  return property(result.failure).code
}

export function registerLocalSyncRunCases(fixture: typeof controlledFixture, page: string) {
  test("connect initializes a missing local directory from Notion in one call", async () => {
    const f = await fixture()
    const destination = join(f.scratch, "new-copy")
    const connected = await f.run(connectLocalSync(page, { path: destination, as: "new-copy" }))
    expect(connected.verified).toBe(true)
    expect(await readFile(join(destination, "references/guide.md"), "utf8")).toBe(f.remoteGuide())
    expect(f.mutations()).toBe(0)
  })

  test("connect preserves differing existing local work until a source is selected", async () => {
    const f = await fixture()
    await f.editLocal("# Guide\n\nLocal work to preserve.\n")
    const remote = f.remoteGuide()
    const result = await f.run(connectLocalSync(page, { path: f.root }).pipe(Effect.result))
    expect(code(result)).toBe("SYNC_INITIALIZATION_REQUIRED")
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        details: {
          verified: false,
          outcome: "failed",
          targets: [
            {
              phase: "plan",
              failure: {
                code: "SYNC_INITIALIZATION_REQUIRED",
                details: {
                  applicable: false,
                  conflicts: [{ code: "SYNC_INITIALIZATION_REQUIRED" }],
                },
              },
            },
          ],
        },
      },
    })
    expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toContain(
      "Local work to preserve.",
    )
    expect(f.remoteGuide()).toBe(remote)
    expect(f.mutations()).toBe(0)
    const initialized = await f.run(connectLocalSync(page, { path: f.root, from: "notion" }))
    expect(initialized).toMatchObject({ verified: true, reused: true })
    expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toBe(remote)
    expect(f.mutations()).toBe(0)
  })

  test("connect registers and synchronizes one local edge, then reuses it", async () => {
    const f = await fixture()
    const first = await f.run(connectLocalSync(page, { path: f.root, from: "notion" }))
    expect(first.verified).toBe(true)
    expect(first.reused).toBe(false)
    const repeat = await f.run(connectLocalSync(page, { path: f.root }))
    expect(repeat.verified).toBe(true)
    expect(repeat.reused).toBe(true)
    expect(repeat.binding.id).toBe(first.binding.id)
    expect(f.mutations()).toBe(0)
  })

  test("AH265 check refreshes current remote without changing content or common baseline", async () => {
    const f = await fixture()
    const bound = await f.bind()
    const base = stableSyncJson(f.bases())
    const local = await readFile(join(f.root, "references/guide.md"), "utf8")
    f.remoteEdit("# Guide\n\nCurrent online check.\n")
    const historical = await f.run(syncStatus(bound.binding.id))
    expect(historical.bindings[0]!.status).toBe("unchanged")
    expect(historical.bindings[0]!.authoritative).toBe(false)
    const check = await f.run(checkLocalSync(bound.binding.id))
    expect(Schema.decodeUnknownSync(LocalSyncCheckSchema)(check).mode).toBe("check")
    expect(check.bindings[0]!.status).toBe("pull")
    expect(check.bindings[0]!.remote_freshness).toBe("validated")
    expect(check.bindings[0]!.authoritative).toBe(true)
    expect(check.baseline_advanced).toBe(false)
    expect(stableSyncJson(f.bases())).toBe(base)
    expect(await readFile(join(f.root, "references/guide.md"), "utf8")).toBe(local)
    expect(f.mutations()).toBe(0)
    expect([...f.json.keys()].filter((key) => key.startsWith("sync/plans/"))).toHaveLength(0)
  })

  test("AH265 run requires explicit selection and rejects invalid source combinations before online effects", async () => {
    const f = await fixture()
    await f.bind()
    const before = f.calls.length
    for (const [binding, options] of [
      [undefined, {}],
      ["test", { all: true }],
      [undefined, { all: true, from: "local" as const }],
      [" ", {}],
    ] as const) {
      expect(code(await f.run(runLocalSync(binding, options).pipe(Effect.result)))).toBe(
        "INVALID_ARGUMENT",
      )
    }
    expect(f.calls.length).toBe(before)
  })

  test("AH265 run applies its one frozen plan and returns verified operation readback", async () => {
    const f = await fixture()
    const bound = await f.bind()
    await f.editLocal("# Guide\n\nScheduled local candidate.\n")
    const execution = await f.run(runLocalSync(bound.binding.id).pipe(Effect.result))
    expect(execution._tag === "Failure" ? execution.failure.details : undefined).toBeUndefined()
    if (execution._tag === "Failure") throw execution.failure
    const result = execution.success
    expect(Schema.decodeUnknownSync(LocalSyncRunSchema)(result).outcome).toBe("complete")
    expect(result.verified).toBe(true)
    const target = result.targets[0]!
    const plans = [...f.json.values()].filter(
      (value) => property(value).format === "ntn-skills-sync-plan",
    )
    expect(plans).toHaveLength(1)
    expect(target.plan_id).toBe(property(plans[0]).plan_id)
    expect(target.receipt!.plan_id).toBe(target.plan_id)
    expect(target.receipt!.operation_id).toBe(target.operation_id)
    expect(target.completed_binding_ids).toEqual([bound.binding.id])
    expect(target.bindings).toHaveLength(1)
    expect(target.bindings![0]).toMatchObject({
      binding_id: bound.binding.id,
      page_id: page,
      action: "push",
      verified: true,
      scope: bound.binding.scope,
      database_id: bound.binding.database_id,
      data_source_id: bound.binding.data_source_id,
    })
    expect(Schema.decodeUnknownSync(LocalSyncRunSchema)(result).targets[0]!.bindings).toEqual(
      target.bindings,
    )
    expect(target.receipt!.status).toBe("complete")
    expect(f.remoteGuide()).toContain("Scheduled local candidate")
    expect(property(f.bases()[0]![1]).generation).toBe(2)
  })

  test("AH265 run rejects drift after planning without retrying or replacing the saved plan", async () => {
    const f = await fixture()
    const bound = await f.bind()
    await f.editLocal("# Guide\n\nFrozen candidate.\n")
    const before = stableSyncJson(f.bases())
    f.faults.planSaved = () => f.remoteEdit("# Guide\n\nIndependent concurrent remote edit.\n")
    const result = await f.run(runLocalSync(bound.binding.id).pipe(Effect.result))
    expect(code(result)).toBe("SYNC_PLAN_STALE")
    expect([...f.json.keys()].filter((key) => key.startsWith("sync/plans/"))).toHaveLength(1)
    expect([...f.json.keys()].filter((key) => key.startsWith("sync/receipts/"))).toHaveLength(0)
    expect(stableSyncJson(f.bases())).toBe(before)
    expect(f.mutations()).toBe(0)
    expect(f.remoteGuide()).toContain("Independent concurrent remote edit")
    if (result._tag === "Failure") {
      const report = Schema.decodeUnknownSync(LocalSyncRunSchema)(result.failure.details)
      expect(report.targets[0]!.phase).toBe("apply")
      expect(report.targets[0]!.plan_id).toMatch(/^p_/)
      expect(report.targets[0]!.failure!.code).toBe("SYNC_PLAN_STALE")
      expect(report.targets[0]!.bindings).toBeUndefined()
    }
  })

  test("AH265 run all retains same-page candidate disagreements before writes", async () => {
    const f = await fixture()
    await f.bind()
    const copy = join(f.scratch, "run-copy")
    const content = (await f.run(f.filesystem.inspect(f.root))).content!
    await f.run(
      f.filesystem.commit(
        await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
        content,
        [],
        "run-copy",
      ),
    )
    await f.bind(copy, "run-copy")
    await f.editLocal("# Guide\n\nFirst independent candidate.\n")
    await f.editLocal("# Guide\n\nSecond independent candidate.\n", copy)
    const before = stableSyncJson(f.bases())
    const result = await f.run(runLocalSync(undefined, { all: true }).pipe(Effect.result))
    expect(code(result)).toBe("SYNC_CONFLICT")
    expect(stableSyncJson(f.bases())).toBe(before)
    expect(f.mutations()).toBe(0)
    if (result._tag === "Failure") {
      const report = Schema.decodeUnknownSync(LocalSyncRunSchema)(result.failure.details)
      expect(report.targets).toHaveLength(1)
      expect(report.targets[0]!.binding_ids).toHaveLength(2)
      expect(report.targets[0]!.plan_id).toMatch(/^p_/)
    }
  })

  test("AH265 run all retains a failed fan-out operation and independently completed common bases", async () => {
    const f = await fixture()
    await f.bind()
    const copy = join(f.scratch, "failed-fanout")
    const content = (await f.run(f.filesystem.inspect(f.root))).content!
    await f.run(
      f.filesystem.commit(
        await f.run(f.filesystem.inspect(copy, { allowMissing: true })),
        content,
        [],
        "run-fanout",
      ),
    )
    const sibling = await f.bind(copy, "failed-fanout")
    f.remoteEdit("# Guide\n\nAccepted run fan-out.\n")
    let failedBinding = sibling.binding.id
    f.faults.planSaved = () => {
      const plan = [...f.json.values()].find(
        (value) => property(value).format === "ntn-skills-sync-plan",
      )
      const edges = property(plan).bindings as Array<{
        binding: { id: string }
        local: { resolved_path: string }
      }>
      const last = edges.at(-1)!
      failedBinding = last.binding.id
      f.faults.localBoundary = async (boundary) => {
        if (boundary.path.startsWith(last.local.resolved_path))
          throw fail("LOCAL_IO_ERROR", "Controlled fan-out failure")
      }
    }
    const result = await f.run(runLocalSync(undefined, { all: true }).pipe(Effect.result))
    expect(code(result)).toBe("WRITE_PARTIAL")
    if (result._tag === "Failure") {
      const report = Schema.decodeUnknownSync(LocalSyncRunSchema)(result.failure.details)
      const target = report.targets[0]!
      expect(report.outcome).toBe("partial")
      expect(target.operation_id).toMatch(/^o_/)
      expect(target.receipt!.status).toBe("pending")
      expect(target.receipt!.plan_id).toBe(target.plan_id)
      expect(target.completed_binding_ids).toHaveLength(1)
      expect(target.completed_binding_ids).not.toContain(failedBinding)
      expect(property(f.json.get(`sync/receipts/${target.operation_id}.json`)).status).toBe(
        "pending",
      )
    }
    expect(f.remoteGuide()).toContain("Accepted run fan-out")
    expect(property(f.json.get(`sync/bases/${failedBinding}.json`)).generation).toBe(1)
  })

  test("AH265 run reconciles a retained converged operation before creating a fresh plan", async () => {
    const f = await fixture()
    const bound = await f.bind()
    f.remoteEdit("# Guide\n\nConverged before baseline interruption.\n")
    const plan = await f.run(planSync(bound.binding.id))
    f.faults.baselineStop = true
    const stopped = await f.run(applySync(plan.plan_id).pipe(Effect.result))
    expect(code(stopped)).toBe("STORAGE_ERROR")
    const previous = [...f.json.values()].find(
      (value) => property(value).format === "ntn-skills-sync-receipt",
    )!
    expect(property(previous).status).toBe("pending")
    const result = await f.run(runLocalSync(bound.binding.id))
    expect(result.targets[0]!.reconciled_operation_ids).toEqual([property(previous).operation_id])
    expect(result.targets[0]!.bindings).toHaveLength(1)
    expect(result.targets[0]!.bindings![0]).toMatchObject({
      binding_id: bound.binding.id,
      action: "unchanged",
      verified: true,
      scope: bound.binding.scope,
      database_id: bound.binding.database_id,
    })
    expect(
      property(f.json.get(`sync/receipts/${property(previous).operation_id}.json`)).status,
    ).toBe("complete")
    expect(property(f.bases()[0]![1]).generation).toBe(2)
    expect(f.mutations()).toBe(0)
  })

  test("AH265 run stops on uncertain divergent state before a new plan and never replays mutation", async () => {
    const f = await fixture()
    const bound = await f.bind()
    f.remoteEdit("# Guide\n\nRemote intended candidate.\n")
    const plan = await f.run(planSync(bound.binding.id))
    f.faults.localBoundary = async () => {
      throw fail("LOCAL_IO_ERROR", "Disk unavailable")
    }
    expect(code(await f.run(applySync(plan.plan_id).pipe(Effect.result)))).toBe("WRITE_PARTIAL")
    f.faults.localBoundary = undefined
    const before = [...f.json.keys()].filter((key) => key.startsWith("sync/plans/")).length
    const result = await f.run(runLocalSync(bound.binding.id).pipe(Effect.result))
    expect(code(result)).toBe("SYNC_DIVERGED")
    expect([...f.json.keys()].filter((key) => key.startsWith("sync/plans/"))).toHaveLength(before)
    expect(property(f.bases()[0]![1]).generation).toBe(1)
    expect(f.mutations()).toBe(0)
  })

  test("AH265 run all completes an independent page while retaining a conflicting page plan", async () => {
    const f = await fixture()
    const first = await f.bind()
    const secondPage = "55555555-5555-4555-8555-555555555555"
    const secondGuide = "66666666-6666-4666-8666-666666666666"
    const other = await fixture(false, { page: secondPage, guide: secondGuide }, f)
    f.delegates.set(secondPage, other.provider.request)
    f.delegates.set(secondGuide, other.provider.request)
    const second = await other.bind(other.root, "independent")
    await f.editLocal("# Guide\n\nConflicting local.\n")
    f.remoteEdit("# Guide\n\nConflicting remote.\n")
    other.remoteEdit("# Guide\n\nIndependent pull.\n")
    const result = await f.run(runLocalSync(undefined, { all: true }).pipe(Effect.result))
    expect(code(result)).toBe("SYNC_RUN_PARTIAL")
    if (result._tag === "Failure") {
      const report = Schema.decodeUnknownSync(LocalSyncRunSchema)(result.failure.details)
      expect(report.outcome).toBe("partial")
      expect(report.targets).toHaveLength(2)
      const completed = report.targets.find((target) => target.page_id === secondPage)!
      expect(completed.verified).toBe(true)
      expect(completed.completed_binding_ids).toEqual([second.binding.id])
      expect(completed.bindings).toHaveLength(1)
      expect(completed.bindings![0]).toMatchObject({
        binding_id: second.binding.id,
        page_id: secondPage,
        action: "pull",
        verified: true,
        scope: second.binding.scope,
        database_id: second.binding.database_id,
        data_source_id: second.binding.data_source_id,
      })
      expect(completed.receipt!.status).toBe("complete")
      expect(report.targets.find((target) => target.page_id === page)!.failure!.code).toBe(
        "SYNC_CONFLICT",
      )
    }
    expect(await readFile(join(other.root, "references/guide.md"), "utf8")).toContain(
      "Independent pull",
    )
    expect(property(f.json.get(`sync/bases/${first.binding.id}.json`)).generation).toBe(1)
    expect(property(f.json.get(`sync/bases/${second.binding.id}.json`)).generation).toBe(2)
    expect(f.mutations() + other.mutations()).toBe(0)
  })
}
