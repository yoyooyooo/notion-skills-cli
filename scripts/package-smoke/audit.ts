import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { property } from "../../packages/core/src/model.ts"
import { Notion } from "../../packages/core/src/notion.ts"
import {
  AUDIT_RULES_VERSION,
  AuditRunSchema,
  type AuditRun,
} from "../../packages/core/src/shared-audit-model.ts"
import { canonicalSharedJson } from "../../packages/core/src/shared-records.ts"
import { auditFixture } from "../../packages/core/test/shared-audit-fixture.ts"
import { id, library, rich, skillPage } from "../../packages/core/test/shared-snapshot-fixture.ts"
import type { SmokeContext } from "./context.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
type Boundary = "before_observation" | "after_checkpoint"
type Signal = "SIGINT" | "SIGKILL"
type HttpObservation = {
  method: string
  path: string
  request_bytes: number
  response_bytes: number
  status: number | null
  withheld: boolean
}

async function checkpoint(state: string, runtime: string): Promise<AuditRun> {
  // Each readonly observer gets a fresh SQLite lifetime across writer/WAL closure.
  const { stdout } = await promisify(execFile)(
    runtime,
    [
      "--input-type=module",
      "--eval",
      `import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try { console.log(JSON.stringify(db.prepare("SELECT key,payload FROM shared_local_records WHERE category='cache' AND retired=0 AND key LIKE 'audit/runs/%'").all())); }
finally { db.close(); }`,
      join(state, "state.sqlite"),
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
  const rows: unknown = JSON.parse(stdout)
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 1, "Exactly one original installed audit run must exist")
  const row = property(rows[0])
  assert.equal(typeof row.payload, "string")
  const envelope = property(JSON.parse(String(row.payload)))
  assert.equal(envelope.sha256, hash(canonicalSharedJson(envelope.run)))
  const run = Schema.decodeUnknownSync(AuditRunSchema)(envelope.run)
  assert.equal(row.key, `audit/runs/${run.run_id}.json`)
  for (const observation of Object.values(run.observations))
    assert.equal(observation.response_sha256, hash(canonicalSharedJson(observation.value)))
  return run
}

function preservesPrefix(before: AuditRun, after: AuditRun) {
  for (const key of ["run_id", "entry_id", "credential_scope", "endpoint_scope", "rules_version"])
    assert.equal(property(after)[key], property(before)[key], `Original audit ${key} changed`)
  assert.ok(after.totals.confirmed_requests >= before.totals.confirmed_requests)
  for (const task of before.completed_tasks)
    assert.ok(after.completed_tasks.includes(task), `Confirmed task ${task} was lost`)
  for (const [key, observation] of Object.entries(before.observations))
    assert.deepEqual(after.observations[key], observation, `Confirmed observation ${key} changed`)
}

/** The fixture supplies remote reads only. Signals and every audit action reach the installed bin. */
export async function checkAuditRecovery(context: SmokeContext) {
  const runtime = (await context.run([context.runtime, "--print", "process.execPath"])).trim()
  assert.ok(runtime.length > 0, "Resolve the actual Node executable before sending process signals")
  const root = join(context.scratch, "controlled-audit-signals")
  await mkdir(root)
  console.error(JSON.stringify({ audit_smoke_root: root }))
  const results: unknown[] = []
  let completed = false

  async function scenario(signal: Signal, boundary: Boundary) {
    const label = `${signal.toLowerCase()}-${boundary}`
    const location = join(root, label)
    await mkdir(location)
    const state = join(location, "state")
    const fixture = await auditFixture(3)
    const remoteHash = () =>
      hash(
        canonicalSharedJson({
          main: fixture.main,
          files: fixture.files,
          bodies: [...fixture.bodies],
          records: [...fixture.records],
        }),
      )
    const originalRemoteHash = remoteHash()
    const calls: HttpObservation[] = []
    const commands: unknown[] = []
    const errors: unknown[] = []
    const gate = Promise.withResolvers<AuditRun>()
    const release = Promise.withResolvers<void>()
    let gateUsed = false
    let gateEnabled = true
    const token = "controlled-installed-audit-token"
    const server = createServer(async (incoming, response) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const path = String(incoming.url).replace(/^\//u, "")
      const method = incoming.method
      const observed: HttpObservation = {
        method: String(method),
        path,
        request_bytes: bytes.length,
        response_bytes: 0,
        status: null,
        withheld: false,
      }
      calls.push(observed)
      try {
        assert.equal(incoming.headers.authorization, `Bearer ${token}`)
        assert.ok(
          method === "GET" ||
            (method === "POST" &&
              /^v1\/(?:data_sources|databases)\/[^/]+\/query(?:\?|$)/u.test(path)),
          "The installed audit attempted a semantic remote write",
        )
        const body: unknown = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined
        const result = await fixture.run(
          Effect.flatMap(Notion, (api) => api.request(path, body, { method })),
        )
        if (gateEnabled && !gateUsed) {
          const current = await checkpoint(state, runtime)
          if (
            boundary === "before_observation" ||
            (current.completed_tasks.includes("library") && current.totals.confirmed_requests > 0)
          ) {
            gateUsed = true
            gate.resolve(current)
          }
        }
        if (gateEnabled && gateUsed) {
          observed.withheld = true
          await release.promise
        }
        if (response.destroyed) return
        const serialized = JSON.stringify(result)
        observed.response_bytes = Buffer.byteLength(serialized)
        observed.status = 200
        response.writeHead(200, { "content-type": "application/json" })
        response.end(serialized)
      } catch (error) {
        errors.push({ path, method, error: String(error) })
        gate.reject(error)
        if (response.destroyed) return
        const serialized = JSON.stringify({
          object: "error",
          code: "validation_error",
          message: "Controlled audit fixture rejected an unexpected request",
        })
        observed.response_bytes = Buffer.byteLength(serialized)
        observed.status = 400
        response.writeHead(400, { "content-type": "application/json" })
        response.end(serialized)
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address !== null && typeof address !== "string")
    const env = {
      ...context.env,
      NTN_SKILLS_DEV_ROOT: undefined,
      HOME: join(location, "home"),
      NTN_SKILLS_HOME: state,
      NTN_SKILLS_CONFIG_HOME: join(location, "config"),
      NTN_SKILLS_CACHE_HOME: join(location, "cache"),
      NTN_SKILLS_SCHEDULER_ROOT: join(location, "scheduler"),
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
      NOTION_API_TOKEN: token,
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    }
    const active = new Set<ReturnType<typeof spawn>>()
    const pending: Promise<unknown>[] = []
    const start = (name: string, args: string[], offline = false) => {
      const argv = [runtime, context.executable, ...args]
      const httpStart = calls.length
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: context.scratch,
        env: { ...env, ...(offline ? { NOTION_API_TOKEN: "" } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      })
      active.add(child)
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (value: Buffer) => {
        stdout += value.toString("utf8")
      })
      child.stderr?.on("data", (value: Buffer) => {
        stderr += value.toString("utf8")
      })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, 60_000)
      const done = once(child, "close").then(async ([exit, processSignal]) => {
        clearTimeout(timer)
        active.delete(child)
        const receipt = {
          label: name,
          argv,
          pid: child.pid,
          exit,
          signal: processSignal,
          timed_out: timedOut,
          http_start: httpStart,
          http_count: calls.length - httpStart,
          stdout,
          stderr_sha256: hash(stderr),
          stderr_bytes: Buffer.byteLength(stderr),
        }
        commands.push(receipt)
        await writeFile(join(location, `${name}.json`), JSON.stringify(receipt, null, 2) + "\n")
        assert.equal(timedOut, false, `${name} exceeded its owned process deadline: ${stderr}`)
        return receipt
      })
      pending.push(done)
      return { child, done }
    }
    const invoke = async (name: string, args: string[], offline = false) => {
      const result = await start(name, args, offline).done
      assert.equal(result.signal, null)
      assert.equal(result.stdout.trim().split("\n").length, 1)
      const value = property(JSON.parse(result.stdout))
      assert.equal(value.ok, true, `${name}: ${result.stdout}`)
      const expected =
        value.execution === "paused"
          ? 75
          : value.execution === "execution_failed"
            ? 1
            : value.coverage !== undefined && value.coverage !== "full"
              ? 4
              : typeof property(value.severity).error === "number" &&
                  Number(property(value.severity).error) > 0
                ? 3
                : 0
      assert.equal(result.exit, expected, `${name}: audit execution/coverage exit contract`)
      assert.equal(errors.length, 0, JSON.stringify(errors))
      if (offline) assert.equal(result.http_count, 0, `${name}: offline command made a request`)
      return { receipt: result, value }
    }
    const entryArgs = ["--entry", library.skills.database_id]
    const budgetArgs = (requests: number) => [
      "--max-requests",
      String(requests),
      "--max-bytes",
      "8388608",
      "--duration-ms",
      "30000",
    ]
    let passed = false
    try {
      const original = start("signal-run", [
        "ctl",
        "library",
        "audit",
        "run",
        ...entryArgs,
        "--all",
        "--depth",
        "content",
        ...budgetArgs(200),
      ])
      let gateTimer: ReturnType<typeof setTimeout> | undefined
      const before = await Promise.race([
        gate.promise,
        original.done.then((value) => {
          throw new Error(`Audit exited before the signal gate: ${JSON.stringify(value)}`)
        }),
        new Promise<never>((_, reject) => {
          gateTimer = setTimeout(
            () => reject(new Error("Installed audit did not reach its signal gate")),
            20_000,
          )
        }),
      ]).finally(() => clearTimeout(gateTimer))
      assert.equal(before.invocation_open, true)
      if (boundary === "before_observation") assert.equal(before.totals.confirmed_requests, 0)
      else
        assert.ok(
          before.completed_tasks.includes("library") && before.totals.confirmed_requests > 0,
        )
      await writeFile(
        join(location, "checkpoint-before-signal.json"),
        JSON.stringify(before, null, 2) + "\n",
      )
      const lockPath = join(
        state,
        "sync",
        "locks",
        hash(`audit-run:${before.run_id}`),
        "owner.json",
      )
      const lockOwner = property(JSON.parse(await readFile(lockPath, "utf8")))
      assert.equal(
        lockOwner.pid,
        original.child.pid,
        "The signal must target the actual audit lock owner",
      )
      await writeFile(
        join(location, "signal-intent.json"),
        JSON.stringify(
          {
            runtime,
            pid: original.child.pid,
            lock_owner_pid: lockOwner.pid,
            lock_path: lockPath,
            signal,
            sent_at: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      )
      assert.equal(original.child.kill(signal), true)
      const stopped = await original.done
      if (signal === "SIGINT") {
        assert.equal(stopped.exit, 130)
        assert.equal(stopped.signal, null)
      } else assert.equal(stopped.signal, "SIGKILL")
      gateEnabled = false
      release.resolve()
      const interrupted = await checkpoint(state, runtime)
      preservesPrefix(before, interrupted)
      assert.equal(interrupted.invocation_open, signal === "SIGKILL")
      if (signal === "SIGINT") {
        assert.equal(interrupted.execution, "paused")
        assert.equal(interrupted.pause_reason, "cancelled")
      }
      await writeFile(
        join(location, "checkpoint-after-signal.json"),
        JSON.stringify(interrupted, null, 2) + "\n",
      )
      const listed = await invoke(
        "offline-list",
        ["ctl", "library", "audit", "list", ...entryArgs],
        true,
      )
      assert.equal(listed.value.matching_runs, 1)
      assert.deepEqual(listed.value.unreadable, [])
      assert.ok(Array.isArray(listed.value.runs))
      assert.equal(property(listed.value.runs[0]).run_id, before.run_id)
      const interruptedReport = await invoke(
        "offline-interrupted-report",
        ["ctl", "library", "audit", "report", before.run_id, ...entryArgs],
        true,
      )
      assert.equal(
        property(interruptedReport.value.request_accounting).unfinalized_invocation,
        signal === "SIGKILL",
      )
      const bounded = await invoke("bounded-resume", [
        "ctl",
        "library",
        "audit",
        "resume",
        before.run_id,
        ...entryArgs,
        ...budgetArgs(2),
      ])
      assert.equal(bounded.value.execution, "paused")
      assert.ok(bounded.receipt.http_count <= 2)
      const continued = await checkpoint(state, runtime)
      preservesPrefix(interrupted, continued)
      assert.ok(continued.totals.confirmed_requests > interrupted.totals.confirmed_requests)
      assert.equal(continued.unclean_invocations, signal === "SIGKILL" ? 1 : 0)
      await writeFile(
        join(location, "checkpoint-after-bounded-resume.json"),
        JSON.stringify(continued, null, 2) + "\n",
      )
      const final = await invoke("complete-resume", [
        "ctl",
        "library",
        "audit",
        "resume",
        before.run_id,
        ...entryArgs,
        ...budgetArgs(200),
      ])
      assert.equal(final.value.run_id, before.run_id)
      assert.equal(final.value.execution, "completed")
      assert.equal(final.value.coverage, "full")
      assert.equal(final.value.remote_writes, 0)
      const terminal = await checkpoint(state, runtime)
      preservesPrefix(continued, terminal)
      assert.equal(terminal.tasks.length, 0)
      assert.equal(terminal.items.length, 1)
      assert.equal(terminal.items[0]!.tree.length, 3)
      assert.equal(terminal.invocation_open, false)
      assert.equal(
        property(final.value.request_accounting).cumulative_precision,
        signal === "SIGKILL" ? "lower_bound" : "exact",
      )
      if (signal === "SIGINT") assert.equal(terminal.totals.attempts, calls.length)
      else assert.ok(terminal.totals.attempts < calls.length)
      const offline = await invoke(
        "offline-final-report",
        ["ctl", "library", "audit", "report", before.run_id, ...entryArgs],
        true,
      )
      const { request_metrics: _finalMetrics, ...finalReport } = final.value
      const { request_metrics: _offlineMetrics, ...offlineReport } = offline.value
      assert.deepEqual(offlineReport, finalReport)
      assert.equal(remoteHash(), originalRemoteHash)
      assert.equal(errors.length, 0)
      assert.ok(
        calls.every(
          (call) =>
            call.method === "GET" || (call.method === "POST" && call.path.includes("/query")),
        ),
      )
      await writeFile(
        join(location, "checkpoint-final.json"),
        JSON.stringify(terminal, null, 2) + "\n",
      )
      const result = {
        case: label,
        original_run_id: before.run_id,
        original_pid: original.child.pid,
        signal,
        boundary,
        confirmed_before: before.totals.confirmed_requests,
        confirmed_after_signal: interrupted.totals.confirmed_requests,
        confirmed_after_resume: terminal.totals.confirmed_requests,
        execution: final.value.execution,
        coverage: final.value.coverage,
        request_accounting: final.value.request_accounting,
        actual_http_attempts: calls.length,
        remote_writes: 0,
        remote_before_sha256: originalRemoteHash,
        remote_after_sha256: remoteHash(),
        evidence: location,
      }
      results.push(result)
      passed = true
      console.error(JSON.stringify({ installed_audit_signal_case: result }))
    } finally {
      gateEnabled = false
      release.resolve()
      for (const child of active) child.kill("SIGKILL")
      server.closeAllConnections()
      await Promise.allSettled(pending)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await writeFile(
        join(location, "evidence.json"),
        JSON.stringify(
          {
            passed,
            calls,
            commands,
            errors,
            remote_before_sha256: originalRemoteHash,
            remote_after_sha256: remoteHash(),
          },
          null,
          2,
        ) + "\n",
      )
    }
  }
  try {
    for (const signal of ["SIGINT", "SIGKILL"] as const)
      for (const boundary of ["before_observation", "after_checkpoint"] as const)
        await scenario(signal, boundary)
    completed = true
    return { completed, cases: results, evidence: root }
  } finally {
    await writeFile(
      join(root, "summary.json"),
      JSON.stringify({ completed, cases: results, evidence: root }, null, 2) + "\n",
    )
  }
}

export async function checkAuditDrafts(
  context: Pick<SmokeContext, "scratch" | "runtime" | "executable" | "env">,
) {
  const root = join(context.scratch, "controlled-audit-drafts")
  await mkdir(root)
  const cases = [
    { name: "draft-metadata", depth: "metadata", exit: 0, code: "UNREGISTERED_DRAFT" },
    {
      name: "unfinished-content",
      depth: "content",
      exit: 4,
      code: "UNREGISTERED_CONTENT_UNVERIFIED",
    },
    { name: "partial-identity", depth: "metadata", exit: 4, code: "MAIN_FILE_ID_INVALID" },
    { name: "history-bound", depth: "metadata", exit: 3, code: "UNREGISTERED_LIFECYCLE_BOUND" },
  ] as const
  const results: unknown[] = []
  for (const item of cases) {
    const location = join(root, item.name)
    await mkdir(location)
    const fixture = await auditFixture(1),
      fields = property(fixture.main.properties)
    fields.skill_id = rich("skill_id", item.name === "partial-identity" ? "existing-skill" : "")
    fields.main_file_id = rich("main_file_id", "")
    for (const name of ["source", "projection", "references"]) fields[name] = rich(name, "")
    fields.enabled = { id: "enabled", type: "checkbox", checkbox: item.name === "partial-identity" }
    if (item.name !== "history-bound") fixture.records.clear()
    if (item.name === "unfinished-content") {
      fields.title = { id: "title", type: "title", title: [] }
      fields.description = rich("description", "")
      fields.kind = { id: "kind", type: "select", select: null }
    }
    const remoteHash = () =>
      hash(
        canonicalSharedJson({
          main: fixture.main,
          files: fixture.files,
          bodies: [...fixture.bodies],
          records: [...fixture.records],
        }),
      )
    const before = remoteHash(),
      calls: HttpObservation[] = [],
      errors: string[] = []
    const token = "controlled-draft-audit-no-secret"
    const server = createServer(async (incoming, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks),
        path = String(incoming.url).replace(/^\//u, ""),
        method = String(incoming.method)
      const call: HttpObservation = {
        path,
        method,
        request_bytes: bytes.length,
        response_bytes: 0,
        status: null,
        withheld: false,
      }
      calls.push(call)
      try {
        assert.equal(incoming.headers.authorization, `Bearer ${token}`)
        assert.ok(
          method === "GET" ||
            (method === "POST" &&
              /^v1\/(data_sources|databases)\/[^/]+\/query(?:\?|$)/u.test(path)),
          "Audit attempted a semantic remote write",
        )
        const body: unknown = bytes.length ? JSON.parse(bytes.toString()) : undefined
        const value = await fixture.run(
          Effect.flatMap(Notion, (api) => api.request(path, body, { method })),
        )
        const data = JSON.stringify(value)
        call.response_bytes = Buffer.byteLength(data)
        call.status = 200
        response.writeHead(200, { "content-type": "application/json" })
        response.end(data)
      } catch (error) {
        errors.push(String(error))
        call.status = 400
        const data = JSON.stringify({
          object: "error",
          code: "validation_error",
          message: "Owned draft fixture rejected this request",
        })
        call.response_bytes = Buffer.byteLength(data)
        response.writeHead(400, { "content-type": "application/json" })
        response.end(data)
      }
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const env = {
      ...context.env,
      NTN_SKILLS_DEV_ROOT: undefined,
      HOME: join(location, "home"),
      NTN_SKILLS_HOME: join(location, "state"),
      NTN_SKILLS_CONFIG_HOME: join(location, "config"),
      NTN_SKILLS_CACHE_HOME: join(location, "cache"),
      NTN_SKILLS_SCHEDULER_ROOT: join(location, "scheduler"),
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
      NOTION_API_TOKEN: token,
      NOTION_WORKSPACE_ID: "",
      NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    }
    const argv = [
      context.runtime,
      context.executable,
      "ctl",
      "library",
      "audit",
      "run",
      "--entry",
      library.skills.database_id,
      "--target",
      skillPage,
      "--depth",
      item.depth,
      "--max-requests",
      "100",
      "--duration-ms",
      "30000",
    ]
    let passed = false
    try {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: context.scratch,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = "",
        stderr = "",
        timedOut = false
      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString()
      })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, 60000)
      const terminal = await once(child, "close").finally(() => clearTimeout(timer))
      await writeFile(
        join(location, "command.json"),
        JSON.stringify(
          {
            argv,
            pid: child.pid,
            exit: terminal[0],
            signal: terminal[1],
            timedOut,
            stdout,
            stderr,
          },
          null,
          2,
        ) + "\n",
      )
      assert.equal(timedOut, false)
      assert.equal(terminal[0], item.exit, stdout || stderr)
      assert.equal(terminal[1], null)
      const report = property(JSON.parse(stdout))
      assert.equal(report.ok, true)
      assert.equal(report.execution, "completed")
      assert.equal(report.rules_version, AUDIT_RULES_VERSION)
      assert.ok(
        Array.isArray(report.findings) &&
          report.findings.some((finding) => property(finding).code === item.code),
      )
      assert.equal(report.coverage, item.exit === 4 ? "partial" : "full")
      assert.equal(
        Number(property(report.severity).error) > 0,
        item.name === "partial-identity" || item.name === "history-bound",
      )
      assert.equal(report.remote_writes, 0)
      assert.equal(errors.length, 0, JSON.stringify(errors))
      assert.equal(remoteHash(), before)
      assert.ok(
        calls.every((call) => !call.path.includes("/markdown")),
        "Draft metadata is not an implicit body acquisition",
      )
      results.push({
        name: item.name,
        exit: terminal[0],
        run_id: report.run_id,
        coverage: report.coverage,
        remote_writes: 0,
        requests: calls.length,
        evidence: location,
      })
      passed = true
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await writeFile(
        join(location, "evidence.json"),
        JSON.stringify(
          {
            passed,
            calls,
            errors,
            remote_before_sha256: before,
            remote_after_sha256: remoteHash(),
          },
          null,
          2,
        ) + "\n",
      )
      await writeFile(
        join(root, "summary.json"),
        JSON.stringify({ complete: results.length === cases.length, cases: results }, null, 2) +
          "\n",
      )
    }
  }
  return { complete: true, cases: results, evidence: root }
}

/** Installed Node bin against owned HTTP. Unrelated rows must not add census pages. */
export async function checkAuditTargetBound(
  context: Pick<SmokeContext, "scratch" | "runtime" | "executable" | "env">,
  options: { readonly unrelatedRows?: number; readonly pauseAfterRoot?: boolean } = {},
) {
  const unrelatedRows = options.unrelatedRows ?? 120
  assert.ok(Number.isSafeInteger(unrelatedRows) && unrelatedRows >= 0 && unrelatedRows <= 1000)
  const location = join(
    context.scratch,
    "controlled-audit-target-" + unrelatedRows + (options.pauseAfterRoot ? "-paused" : ""),
  )
  await mkdir(location)
  const fixture = await auditFixture(2)
  if (options.pauseAfterRoot)
    property(fixture.main.properties).main_file_id = rich("main_file_id", "")
  for (let index = 0; index < unrelatedRows; index++) {
    const page = id(600 + index)
    fixture.files.push({
      ...structuredClone(fixture.files[0]!),
      id: page,
      properties: {
        ...structuredClone(fixture.files[0]!.properties),
        file_id: rich("file_id", `foreign-${index}`),
        path: rich("path", `foreign/${index}.md`),
        skill: {
          id: "skill",
          type: "relation",
          relation: [{ id: id(70) }],
          has_more: false,
        },
      },
    })
  }
  const remoteHash = () =>
    hash(
      canonicalSharedJson({
        main: fixture.main,
        files: fixture.files,
        bodies: [...fixture.bodies],
        records: [...fixture.records],
      }),
    )
  const before = remoteHash()
  const calls: HttpObservation[] = []
  const queryFilters: unknown[] = []
  const errors: string[] = []
  const token = "controlled-target-audit-no-secret"
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    const path = String(incoming.url).replace(/^\//u, "")
    const method = String(incoming.method)
    const call: HttpObservation = {
      path,
      method,
      request_bytes: bytes.length,
      response_bytes: 0,
      status: null,
      withheld: false,
    }
    calls.push(call)
    try {
      assert.equal(incoming.headers.authorization, `Bearer ${token}`)
      assert.ok(
        method === "GET" ||
          (method === "POST" && /^v1\/(data_sources|databases)\/[^/]+\/query(?:\?|$)/u.test(path)),
        "Audit attempted a semantic remote write",
      )
      const body: unknown = bytes.length ? JSON.parse(bytes.toString()) : undefined
      if (path.includes("/data_sources/") && path.includes("/query"))
        queryFilters.push({ path, filter: property(body).filter ?? null })
      const value = await fixture.run(
        Effect.flatMap(Notion, (api) => api.request(path, body, { method })),
      )
      const data = JSON.stringify(value)
      call.response_bytes = Buffer.byteLength(data)
      call.status = 200
      response.writeHead(200, { "content-type": "application/json" })
      response.end(data)
    } catch (error) {
      errors.push(String(error))
      call.status = 400
      const data = JSON.stringify({
        object: "error",
        code: "validation_error",
        message: "Owned target fixture rejected this request",
      })
      call.response_bytes = Buffer.byteLength(data)
      response.writeHead(400, { "content-type": "application/json" })
      response.end(data)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const env = {
    ...context.env,
    NTN_SKILLS_DEV_ROOT: undefined,
    HOME: join(location, "home"),
    NTN_SKILLS_HOME: join(location, "state"),
    NTN_SKILLS_CONFIG_HOME: join(location, "config"),
    NTN_SKILLS_CACHE_HOME: join(location, "cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(location, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NOTION_API_TOKEN: token,
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: `http://127.0.0.1:${address.port}`,
  }
  const argv = [
    context.runtime,
    context.executable,
    "ctl",
    "audit",
    "run",
    "--entry",
    library.skills.database_id,
    "--target",
    skillPage,
    "--depth",
    "metadata",
    "--max-requests",
    options.pauseAfterRoot ? "3" : "80",
    "--duration-ms",
    "30000",
  ]
  let passed = false
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: context.scratch,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
    })
    let timeout = false
    const deadline = setTimeout(() => {
      timeout = true
      child.kill("SIGKILL")
    }, 75000)
    const terminal = await once(child, "close").finally(() => clearTimeout(deadline))
    assert.equal(timeout, false, "The actual installed audit exceeded its bounded process deadline")
    await writeFile(
      join(location, "command.json"),
      JSON.stringify(
        { argv, pid: child.pid, exit: terminal[0], signal: terminal[1], stdout, stderr },
        null,
        2,
      ) + "\n",
    )
    assert.equal(terminal[0], options.pauseAfterRoot ? 75 : 0, stdout || stderr)
    const report = property(JSON.parse(stdout))
    assert.equal(report.inspection_scope, "reachable_target")
    assert.equal(report.reverse_table_completeness, "unobserved")
    assert.equal(report.coverage, options.pauseAfterRoot ? "partial" : "full")
    if (options.pauseAfterRoot) {
      assert.equal(report.execution, "paused")
      assert.ok(
        Array.isArray(report.findings) &&
          report.findings.some((value) => property(value).code === "MAIN_FILE_ID_INVALID"),
        "Already observed identity failure must be visible before the owned queries finish",
      )
    }
    assert.equal(report.remote_writes, 0)
    assert.equal(report.rules_version, AUDIT_RULES_VERSION)
    const dataSourceCalls = calls.filter((call) => call.path.includes("/data_sources/"))
    assert.ok(dataSourceCalls.length < 30)
    if (!options.pauseAfterRoot) assert.ok(dataSourceCalls.length > 0)
    assert.ok(queryFilters.length === dataSourceCalls.length)
    assert.ok(queryFilters.every((entry) => property(entry).filter !== null))
    assert.equal(
      calls.some((call) =>
        call.path.includes(`/data_sources/${library.skills.data_source_id}/query`),
      ),
      false,
    )
    assert.equal(errors.length, 0, JSON.stringify(errors))
    assert.equal(remoteHash(), before)
    passed = true
    return {
      passed,
      requests: calls.length,
      data_source_requests: dataSourceCalls.length,
      filtered_queries: queryFilters.length,
      unrelated_rows: unrelatedRows,
      first_identity_finding_preserved: options.pauseAfterRoot ?? false,
      evidence: location,
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await writeFile(
      join(location, "evidence.json"),
      JSON.stringify(
        {
          passed,
          calls,
          query_filters: queryFilters,
          errors,
          remote_before_sha256: before,
          remote_after_sha256: remoteHash(),
        },
        null,
        2,
      ) + "\n",
    )
  }
}
