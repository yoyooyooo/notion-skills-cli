import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, text } from "../src/model.ts"
import {
  automaticSourceStops,
  reportSourceUpdateRun,
  listSourceUpdateRuns,
  runSourceUpdate,
  type SourceUpdateInput,
} from "../src/shared-source-run.ts"
import { readSourceDefinition, validateSourceDefinition } from "../src/shared-source-definitions.ts"
import { sourceRunDecision } from "../src/shared-source-policy.ts"
import { discoverSourceDefinition } from "../src/shared-source-adapters.ts"
import { prepareRetainedSourceRefresh } from "../src/shared-source-refresh.ts"
import { Store } from "../src/store.ts"
import {
  sourceRefreshFixture,
  definition,
  library,
  sourceIds,
} from "./shared-source-refresh-fixture.ts"
import { id, skillPage } from "./shared-snapshot-fixture.ts"

async function fixture(
  policy: "manual" | "pinned" | "auto" = "manual",
  enabled = true,
  requests = false,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-source-run-"))
  const f = await sourceRefreshFixture({
    definition: {
      ...definition,
      enabled,
      policy,
      adapter: {
        type: "git",
        url: "https://gitlab.com/org/repo.git",
        ref: policy === "pinned" ? "a".repeat(40) : "main",
      },
      options: policy === "auto" ? { check_interval_ms: 60_000 } : {},
    },
  })
  f.clearCalls()
  const activeLibrary = requests
    ? {
        ...library,
        skills: {
          ...library.skills,
          property_ids: {
            ...library.skills.property_ids,
            "Management Request": "management_request",
            "Management Result": "management_result",
            "Management Receipt": "management_receipt",
          },
        },
      }
    : library
  if (requests) {
    const fields = property(f.main.properties)
    fields.management_request = {
      id: "management_request",
      type: "select",
      select: { name: "none" },
    }
    fields.management_result = { id: "management_result", type: "rich_text", rich_text: [] }
    fields.management_receipt = { id: "management_receipt", type: "rich_text", rich_text: [] }
  }
  const run = <A, E, R>(action: Effect.Effect<A, E, R>) =>
    f.run(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* action.pipe(Effect.provideService(Store, { ...store, root }))
      }),
    )
  const execute = (
    settings: Partial<SourceUpdateInput> = {},
    acquire: typeof discoverSourceDefinition = f.acquire,
  ) =>
    run(
      runSourceUpdate(
        {
          entry: library.skills.database_id,
          source: id(82),
          scope: { kind: "all_bound" },
          ...settings,
        },
        acquire,
        () => Effect.succeed(activeLibrary),
      ),
    )
  return { ...f, run, execute }
}

test("policy and interval are explicit native configuration; disabled and pinned skip provider discovery", async () => {
  expect(() => validateSourceDefinition({ ...definition, policy: "auto" })).toThrow(
    "check_interval_ms",
  )
  expect(() =>
    validateSourceDefinition({ ...definition, options: { check_interval_ms: 0 } }),
  ).toThrow()
  for (const [policy, enabled, reason] of [
    ["manual", false, "disabled"],
    ["pinned", true, "pinned"],
  ] as const) {
    const f = await fixture(policy, enabled)
    const result = await f.execute()
    expect(result.execution).toBe("completed")
    expect(result.decision).toEqual({ kind: "skip", reason })
    expect(f.acquisitions()).toBe(0)
    expect(f.writeCount()).toBe(0)
  }
})

test("readonly check and prepare expose separate complete candidates without publishing native status", async () => {
  for (const mode of ["check", "prepare"] as const) {
    const f = await fixture()
    const result = await f.execute({ mode })
    expect(result.execution).toBe("completed")
    expect(result.check.status).toBe("completed")
    expect(result.plan === null).toBe(mode === "check")
    expect(result.application).toHaveLength(0)
    expect(f.acquisitions()).toBe(1)
    expect(f.writeCount()).toBe(0)
    expect((await f.run(readSourceDefinition(library, id(82)))).last_checked).toBeNull()
  }
})

test("manual policy records check success and candidate while leaving selected content and native bodies unchanged", async () => {
  const f = await fixture()
  const bodies = new Map(f.bodies)
  const result = await f.execute()
  expect(result.execution).toBe("completed")
  expect(result.application).toHaveLength(0)
  expect(result.plan?.kind).toBe("source_refresh_batch")
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
  expect(f.bodies).toEqual(bodies)
  const observed = await f.run(readSourceDefinition(library, id(82)))
  expect(observed.last_checked).not.toBeNull()
  expect(observed.last_result).toContain("候选待确认")
  expect(observed.last_result).toContain("已确认 0/1")
  expect(observed.last_result).toContain(result.run_id)
  expect(
    f.calls
      .filter((call) => call.method === "PATCH")
      .every((call) => call.path === `v1/pages/${id(82)}`),
  ).toBe(true)
})

test("auto preserves custom files and repeated unchanged checks create no content records", async () => {
  const f = await fixture("auto")
  const first = await f.execute()
  expect(first.execution).toBe("completed")
  expect(first.application.map((item) => item.status)).toEqual(["confirmed"])
  expect(f.calls.some((call) => call.path.endsWith("/markdown") && call.method === "PATCH")).toBe(
    false,
  )
  f.clearCalls()
  const second = await f.execute()
  expect(second.application.map((item) => item.status)).toEqual(["confirmed"])
  expect(f.calls.some((call) => call.path === "v1/pages")).toBe(false)
  expect(
    f.calls
      .filter((call) => call.method === "PATCH")
      .every((call) => call.path === `v1/pages/${id(82)}`),
  ).toBe(true)
  const due = await f.execute({ dueOnly: true })
  expect(due.decision).toMatchObject({ kind: "skip", reason: "not_due" })
  expect(f.acquisitions()).toBe(2)
})

test("failed provider checks do not advance the last successful observation", async () => {
  const f = await fixture()
  await f.execute()
  const prior = await f.run(readSourceDefinition(library, id(82)))
  f.clearCalls()
  const failed = await f.execute({}, () =>
    Effect.fail(fail("PROVIDER_UNAVAILABLE", "Provider unavailable.")),
  )
  expect(failed.execution).toBe("failed")
  expect(failed.error?.code).toBe("PROVIDER_UNAVAILABLE")
  const current = await f.run(readSourceDefinition(library, id(82)))
  expect(current.last_checked).toBe(prior.last_checked)
  expect(current.last_revision).toBe(prior.last_revision)
  expect(f.writeCount()).toBe(0)
})

test("native projection changes and new Markdown stop automatic application before any dispatch", async () => {
  const f = await fixture("auto")
  const plan = await f.run(prepareRetainedSourceRefresh(library, id(82), skillPage, f.acquire))
  const existing = plan.projected_files.find((file) => file.path === "references/1.md")!
  const inspected = {
    ...plan,
    custom_files_preserved: [],
    projected_files: [
      { ...existing, sha256: "f".repeat(64) },
      { path: "references/new.md", sha256: "e".repeat(64), bytes: 9 },
    ],
  }
  const stops = await f.run(automaticSourceStops(inspected))
  expect(stops.map((item) => item.code)).toEqual([
    "BODY_REPLACEMENT_UNSAFE",
    "INITIAL_PROJECTION_REQUIRED",
  ])
  expect(f.writeCount()).toBe(0)
})

test("same-root overlapping invocations are fenced before a second provider acquisition", async () => {
  const f = await fixture()
  let entered!: () => void
  const atProvider = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const allowed = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = f.execute({ mode: "check" }, () =>
    Effect.gen(function* () {
      entered()
      yield* Effect.promise(() => allowed)
      return yield* f.acquire()
    }),
  )
  await atProvider
  const overlapping = await f.execute({ mode: "check" })
  expect(overlapping.execution).toBe("failed")
  expect(overlapping.error?.code).toBe("SYNC_LOCKED")
  expect(f.acquisitions()).toBe(0)
  release()
  expect((await first).execution).toBe("completed")
  expect(f.acquisitions()).toBe(1)
})

test("deadline retains a paused original run whose offline report cannot start another provider read", async () => {
  const f = await fixture()
  const paused = await f.execute({ budget: { duration_ms: 25 } }, () => Effect.never)
  expect(paused.execution).toBe("paused")
  expect(paused.error?.code).toBe("REQUEST_BUDGET_EXHAUSTED")
  expect(paused.plan).toBeNull()
  f.clearCalls()
  const report = await f.run(reportSourceUpdateRun(paused.run_id))
  expect(report.execution).toBe("paused")
  expect(report.offline).toBe(true)
  expect(report.remote_writes).toBe(0)
  expect((await f.run(listSourceUpdateRuns())).items.map((item) => item.run_id)).toEqual([
    paused.run_id,
  ])
  expect(f.calls).toHaveLength(0)
})

test("a process interruption leaves an offline lower-bound checkpoint and does not authorize resending work", async () => {
  const f = await fixture()
  const run = await f.execute({ mode: "check" })
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Store).writeJson(`operations/shared-source-runs/${run.run_id}.json`, {
        ...run,
        execution: "running",
        phase: "applying",
      })
    }),
  )
  f.clearCalls()
  const report = await f.run(reportSourceUpdateRun(run.run_id))
  expect(report.checkpoint_status).toBe("possibly_running_or_interrupted")
  expect(report.metrics_completeness).toBe("lower_bound_since_last_checkpoint")
  expect((await f.run(listSourceUpdateRuns())).items[0]?.execution).toBe("running")
  expect(f.calls).toHaveLength(0)
})

test("untrusted future display time cannot postpone a configured check indefinitely", async () => {
  const f = await fixture("auto")
  property(f.source.properties)[sourceIds["Last Checked"]!] = {
    id: sourceIds["Last Checked"],
    type: "date",
    date: { start: "2099-01-01T00:00:00Z" },
  }
  const observed = await f.run(readSourceDefinition(library, id(82)))
  expect(sourceRunDecision(observed, Date.now(), "policy", true).kind).toBe("check")
})

test("a pinned or not-due Source still processes an explicit file request without another provider acquisition", async () => {
  for (const policy of ["pinned", "auto"] as const) {
    const f = await fixture(policy, true, true)
    if (policy === "auto") await f.execute()
    const beforeAcquisitions = f.acquisitions()
    property(f.main.properties).management_request = {
      id: "management_request",
      type: "select",
      select: { name: "restore-follow" },
    }
    f.clearCalls()
    const result = await f.execute({ dueOnly: true })
    expect(result.decision).toMatchObject({
      kind: "skip",
      reason: policy === "pinned" ? "pinned" : "not_due",
    })
    expect(result.request_results).toHaveLength(2)
    expect(property(result.request_results[1]).page_id).toBe(skillPage)
    expect(
      property(result.request_results[1]).result !== undefined ||
        property(result.request_results[1]).error !== undefined,
    ).toBe(true)
    expect(f.acquisitions()).toBe(beforeAcquisitions)
    expect(f.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/markdown"))).toBe(
      false,
    )
    expect(property(property(f.main.properties).management_request).select).toEqual({
      name: "restore-follow",
    })
  }
})
