import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { readSharedFileRequest, submitSharedFileRequest } from "../src/shared-file-request.ts"
import {
  automaticSourceStops,
  reportSourceUpdateRun,
  listSourceUpdateRuns,
  runSourceUpdate,
  resumeSourceUpdateRun,
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
  const taskHooks = {
    loseBodyResponse: false,
    rejectVerifiedFeedback: false,
    rejectDisplayCheckpoint: false,
  }
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
        const store = yield* Store,
          original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) => {
            if (
              taskHooks.rejectVerifiedFeedback &&
              path === `v1/pages/${skillPage}` &&
              options?.method === "PATCH"
            ) {
              const receipt = text(
                property(property(property(body).properties).management_receipt).rich_text,
              )
              if (receipt.includes('"status":"verified_applied"')) {
                taskHooks.rejectVerifiedFeedback = false
                return Effect.fail(
                  fail("NOTION_REQUEST_FAILED", "Controlled feedback rejection", {
                    http_status: 400,
                    notion_code: "validation_error",
                    phase: "definitive_rejection",
                  }),
                )
              }
            }
            if (requests && path === `v1/databases/${library.skills.database_id}`)
              return original.request(path, body, options).pipe(
                Effect.map((value) => ({
                  ...property(value),
                  description: [
                    { plain_text: "ntn-skills-library:v1 " + JSON.stringify(activeLibrary) },
                  ],
                })),
              )
            if (
              requests &&
              path === `v1/pages/${skillPage}/markdown` &&
              options?.method === "PATCH"
            )
              return Effect.try({
                try: () => {
                  f.calls.push({ path, body, method: "PATCH" })
                  const before = f.bodies.get(skillPage)!,
                    updates = property(property(body).update_content).content_updates
                  if (!Array.isArray(updates) || updates.length !== 1)
                    throw fail("TEST_RESTORE_MATCH", "Expected one complete body match")
                  const change = property(updates[0])
                  if (
                    typeof change.old_str !== "string" ||
                    !change.old_str ||
                    typeof change.new_str !== "string" ||
                    before.split(change.old_str).length !== 2
                  )
                    throw fail("TEST_RESTORE_MATCH", "The complete original body no longer matches")
                  const markdown = before.replace(change.old_str, change.new_str)
                  f.bodies.set(skillPage, markdown)
                  if (taskHooks.loseBodyResponse) {
                    taskHooks.loseBodyResponse = false
                    throw fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "Controlled lost source display body response",
                    )
                  }
                  return { id: skillPage, markdown, truncated: false, unknown_block_ids: [] }
                },
                catch: (error) =>
                  error instanceof SkillsError
                    ? error
                    : fail("TEST_RESTORE_MATCH", "Controlled restore failed"),
              })
            return original.request(path, body, options)
          },
        }
        return yield* action.pipe(
          Effect.provideService(Store, {
            ...store,
            root,
            writeJson: (key, value) => {
              if (
                taskHooks.rejectDisplayCheckpoint &&
                key.startsWith("operations/shared-source-runs/") &&
                Array.isArray(property(value).application) &&
                (property(value).application as unknown[]).some(
                  (entry) =>
                    Array.isArray(property(entry).display) &&
                    (property(entry).display as unknown[]).some(
                      (file) =>
                        property(file).status === "applied" &&
                        typeof property(file).operation_id === "string",
                    ),
                )
              ) {
                taskHooks.rejectDisplayCheckpoint = false
                return Effect.fail(
                  fail("LOCAL_IO_ERROR", "Controlled display checkpoint interruption"),
                )
              }
              return store.writeJson(key, value)
            },
          }),
          Effect.provideService(Notion, api),
        )
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
  return { ...f, run, execute, activeLibrary, taskHooks }
}

async function followingMain() {
  const f = await fixture("auto", true, true)
  await f.execute()
  await f.run(
    submitSharedFileRequest({ library: f.activeLibrary, skillPageId: skillPage, path: "SKILL.md" }),
  )
  await f.execute({ dueOnly: true })
  property(property(f.main.properties).management_request).select = { name: "none" }
  const beforeCustom = new Map(f.bodies)
  f.replaceSnapshot({
    ...f.snapshot,
    revision: "b".repeat(40),
    members: f.snapshot.members.map((member) => ({
      ...member,
      upstream_hash: "c".repeat(64),
      content_hash: "d".repeat(64),
      portable: {
        ...member.portable,
        files: member.portable.files.map((file) =>
          file.path === "SKILL.md"
            ? {
                ...file,
                bytes: new TextEncoder().encode(
                  "---\nname: source\ndescription: upstream\nlicense: MIT\n---\n\nNew fixed B following main\n",
                ),
              }
            : file,
        ),
      },
    })),
  })
  f.clearCalls()
  return { f, beforeCustom }
}

test("one explicit source task updates an existing following body and preserves custom files", async () => {
  const { f, beforeCustom } = await followingMain()
  const run = await f.execute({ updateFollowing: true })
  expect(run.execution).toBe("completed")
  expect(run.application.filter((item) => item.status !== "confirmed")).toEqual([])
  expect(run.application.map((item) => item.status)).toEqual(["confirmed"])
  expect(run.application[0]?.display?.find((file) => file.path === "SKILL.md")?.status).toBe(
    "applied",
  )
  expect(f.bodies.get(skillPage)).toBe("New fixed B following main")
  for (const [page, content] of beforeCustom)
    if (page !== skillPage) expect(f.bodies.get(page)).toBe(content)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(1)
  const acquisitions = f.acquisitions()
  f.clearCalls()
  const repeated = await f.run(
    resumeSourceUpdateRun({ runId: run.run_id }, () => Effect.succeed(f.activeLibrary)),
  )
  expect(repeated.application).toEqual(run.application)
  expect(f.acquisitions()).toBe(acquisitions)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
})

test("an unknown original display request cannot become a new body request when the source task resumes", async () => {
  const { f } = await followingMain()
  f.taskHooks.loseBodyResponse = true
  const run = await f.execute({ updateFollowing: true })
  expect(run.application[0]?.status).toBe("unknown")
  expect(run.next.argv.slice(0, 4)).toEqual(["ntn-skills", "ctl", "operation", "show"])
  expect(run.next.read_only).toBe(true)
  expect(
    run.application[0]?.display?.find((file) => file.path === "SKILL.md")?.operation_id,
  ).toMatch(/^body-write-follow-/u)
  f.clearCalls()
  const resumed = await f.run(
    resumeSourceUpdateRun({ runId: run.run_id }, () => Effect.succeed(f.activeLibrary)),
  )
  expect(resumed.application[0]?.status).not.toBe("confirmed")
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
})

test("the next source invocation reconciles a recorded restore and only repairs its failed feedback", async () => {
  const f = await fixture("auto", true, true)
  await f.execute()
  await f.run(
    submitSharedFileRequest({ library: f.activeLibrary, skillPageId: skillPage, path: "SKILL.md" }),
  )
  f.taskHooks.rejectVerifiedFeedback = true
  const first = await f.execute({ dueOnly: true })
  expect(first.request_results.some((item) => property(item).error !== undefined)).toBe(true)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(1)
  f.clearCalls()
  const resumed = await f.execute({ dueOnly: true })
  expect(resumed.request_results.filter((item) => property(item).error !== undefined)).toEqual([])
  expect(resumed.request_results.map((item) => property(item).result)).toContainEqual(
    expect.objectContaining({ status: "verified_applied" }),
  )
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
})

test("same source run repairs rejected request feedback with its frozen request identity", async () => {
  const f = await fixture("auto", true, true)
  await f.execute()
  await f.run(
    submitSharedFileRequest({ library: f.activeLibrary, skillPageId: skillPage, path: "SKILL.md" }),
  )
  f.taskHooks.rejectVerifiedFeedback = true
  const first = await f.execute({ dueOnly: true })
  expect(first.outcome.task_completed).toBe(false)
  expect(first.request_scope?.[0]?.request_id).toMatch(/^file-request-/u)
  expect(first.next.argv).toEqual([
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "run-resume",
    first.run_id,
  ])
  expect(first.next.read_only).toBe(false)
  f.clearCalls()
  const resumed = await f.run(
    resumeSourceUpdateRun({ runId: first.run_id }, () => Effect.succeed(f.activeLibrary)),
  )
  expect(resumed.request_results.filter((item) => property(item).error !== undefined)).toEqual([])
  expect(resumed.request_results.map((item) => property(item).result)).toContainEqual(
    expect.objectContaining({ status: "verified_applied" }),
  )
  expect(resumed.outcome.task_completed).toBe(true)
  expect(resumed.continuations?.[0]?.request_results).toEqual(first.request_results)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
})

test("display checkpoint interruption preserves the acknowledged original body for same-run recovery", async () => {
  const { f } = await followingMain()
  f.taskHooks.rejectDisplayCheckpoint = true
  const first = await f.execute({ updateFollowing: true })
  const body = first.application[0]?.display?.find((file) => file.path === "SKILL.md")
  expect(body?.operation_id).toMatch(/^body-write-follow-/u)
  expect(body?.status).toBe("applied")
  expect(first.outcome.task_completed).toBe(false)
  f.clearCalls()
  const resumed = await f.run(
    resumeSourceUpdateRun({ runId: first.run_id }, () => Effect.succeed(f.activeLibrary)),
  )
  expect(resumed.application.map((item) => item.status)).toEqual(["confirmed"])
  expect(
    resumed.application[0]?.display?.find((file) => file.path === "SKILL.md")?.operation_id,
  ).toBe(body?.operation_id)
  expect(resumed.outcome.task_completed).toBe(true)
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
})

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

test.each(["check", "prepare", "policy"] as const)(
  "a newly registered empty Source has a normal explicit first-admission route in %s mode",
  async (mode) => {
    const f = await fixture()
    property(property(f.main.properties).origin).relation = []
    const result = await f.execute({ mode })
    expect(result.execution).toBe("completed")
    expect(result.error).toBeNull()
    expect(result.application).toHaveLength(0)
    expect(result.plan).toBeNull()
    expect(property(result).empty_scope).toMatchObject({
      reason: "no_bound_members",
      bound_members: 0,
      next: {
        read_only: true,
        argv: [
          "ntn-skills",
          "ctl",
          "library",
          "sources",
          "check",
          id(82),
          "--entry",
          library.skills.database_id,
        ],
      },
    })
    expect(result.check.status).toBe(mode === "check" ? "completed" : "not_started")
    expect(f.acquisitions()).toBe(mode === "check" ? 1 : 0)
    expect(f.writeCount()).toBe(0)
  },
)

test("all-disabled members are distinct from an empty Source and an incorrect explicit target remains an error", async () => {
  const f = await fixture()
  property(property(f.main.properties).enabled).checkbox = false
  const empty = await f.execute({ mode: "policy" })
  expect(property(empty).empty_scope).toMatchObject({
    reason: "no_enabled_members",
    bound_members: 1,
  })
  const wrong = await f.execute({ scope: { kind: "skill", target: id(999) } })
  expect(wrong.error?.code).toBe("SOURCE_RUN_SCOPE")
  expect(f.writeCount()).toBe(0)
})

for (const [stage, from] of [
  ["current_snapshot", "SKILL.md"],
  ["candidate_file_references", "guide.md"],
] as const) {
  test(`source preparation retains ${stage} reference context in its failed run receipt`, async () => {
    const f = await fixture()
    const href = "../statechart/SKILL.md"
    const markdown = `[Statechart](${href})\n`
    if (stage === "current_snapshot") {
      f.bodies.set(skillPage, markdown)
      await expect(f.open({ forceFull: true })).rejects.toThrow(
        "A local reference escapes the shared Skill root.",
      )
      f.clearCalls()
    } else
      f.replaceSnapshot({
        ...f.snapshot,
        members: f.snapshot.members.map((member) => ({
          ...member,
          portable: {
            ...member.portable,
            files: [
              ...member.portable.files,
              { path: from, bytes: new TextEncoder().encode(markdown) },
            ],
          },
        })),
      })

    const result = await f.execute({ mode: "prepare" })
    expect(result.error).toEqual({
      code: "SHARED_REFERENCE_INVALID",
      message: "A local reference escapes the shared Skill root.",
      details: {
        from,
        href,
        target_page_id: skillPage,
        source_member: "skills/demo",
        preparation_stage: stage,
      },
    })
    expect(result.execution).toBe("failed")
    expect(result.phase).toBe("checking")
    expect(result.plan).toBeNull()
    expect(result.application).toEqual([])
    expect(f.writeCount()).toBe(0)

    f.clearCalls()
    const report = await f.run(reportSourceUpdateRun(result.run_id))
    expect(report.error).toEqual(result.error)
    expect(report.plan).toBeNull()
    expect(report.application).toEqual([])
    expect(f.calls).toHaveLength(0)
  })
}

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

test("a submitted C1 request follows the same Source's verified C2 selection without renewing its custom baseline", async () => {
  const f = await fixture("auto", true, true)
  await f.execute()
  const input = { library: f.activeLibrary, skillPageId: skillPage, path: "SKILL.md" }
  const submitted = await f.run(submitSharedFileRequest(input))
  expect(submitted.status).toBe("submitted")
  if (!("feedback" in submitted) || submitted.feedback === undefined)
    throw new Error("Expected the submitted request receipt")
  const original = submitted.feedback.submitted
  expect(original?.source.definition?.source_id).toBe(definition.source_id)
  const next = {
    ...f.snapshot,
    revision: "b".repeat(40),
    members: f.snapshot.members.map((member) => ({
      ...member,
      upstream_hash: "c".repeat(64),
      content_hash: "d".repeat(64),
      portable: {
        ...member.portable,
        files: member.portable.files.map((file) =>
          file.path === "SKILL.md"
            ? {
                ...file,
                bytes: new TextEncoder().encode(
                  "---\nname: source\ndescription: upstream\nlicense: MIT\n---\n\nSelected C2 body\n",
                ),
              }
            : file,
        ),
      },
    })),
  }
  f.replaceSnapshot(next)
  f.clearCalls()
  const result = await f.execute()
  if (result.check.status !== "completed")
    throw new Error("Expected the C2 Source check to complete")
  expect(result.check.revision).toBe(next.revision)
  expect(f.bodies.get(skillPage)).toBe("Selected C2 body")
  expect(
    result.request_results.map((item) => property(item).result ?? property(item).error),
  ).toContainEqual(expect.objectContaining({ status: "verified_applied" }))
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(1)
  const current = await f.run(readSharedFileRequest(input))
  expect(current.status).toBe("verified_applied")
  expect(current.request_id).toBe(submitted.feedback.request_id)
  expect(current.feedback?.submitted).toEqual(original)
  expect(current.request.source.selected_version).not.toBe(original?.source.selected_version)
})
