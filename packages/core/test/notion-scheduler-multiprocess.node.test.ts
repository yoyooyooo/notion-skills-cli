import { spawn, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { Clock, Effect, Random } from "effect"
import { expect, test } from "vitest"
import { notionEndpoint, notionRetryDelay } from "../src/notion-request-scheduler.ts"

const repository = resolve(import.meta.dirname, "../../..")
const schedulerUrl = pathToFileURL(
  resolve(import.meta.dirname, "../src/notion-request-scheduler.ts"),
).href
const workerSource = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Clock, Effect, Semaphore } from "effect";
import { NotionRequestScheduler, NotionRequestSchedulerLive } from ${JSON.stringify(schedulerUrl)};
const input = JSON.parse(process.env.SCHEDULER_INPUT);
const program = Effect.gen(function* () {
  const scheduler = yield* NotionRequestScheduler;
  const permits = yield* Semaphore.make(input.mode === "hold" ? 0 : 1);
  const options = { apiOrigin: input.origin, connection: input.connection, workspace: input.workspace, priority: input.priority, endpoint: "GET test" };
  let cooldown = null;
  if (input.cooldown) {
    const started = Date.now();
    yield* scheduler.cooldown(input.credential, input.cooldown, { ...options, reason: input.reason });
    cooldown = { millis: input.cooldown, started, completed: Date.now() };
  }
  if (input.mode === "cooldown") return cooldown;
  const requests = Array.from({length: input.count ?? 1}, (_, item) => ({
    item, prepared: new Request(input.origin + "/" + input.label + "/" + item),
  }));
  if (input.waitForRelease) yield* Effect.promise(() => new Promise((resolve, reject) => {
    process.once("message", message => message === "release" ? resolve() : reject(new Error("Unexpected receiver release")));
    process.send({ type: "ready", pid: process.pid, time: Date.now() });
  }));
  return yield* Effect.all(requests.map(({ item, prepared }) => Effect.gen(function* () {
    const deadline = (yield* Clock.monotonicTimeNanos) + 60_000_000_000n;
    const submitted = Date.now();
    return yield* scheduler.withAdmission(input.credential, deadline, permits, Effect.tryPromise(async () => {
      const dispatched = Date.now();
      const response = await fetch(prepared);
      await response.text();
      return { item, status: response.status, submitted, dispatched, received: Date.now() };
    }), options);
  })), { concurrency: "unbounded" });
}).pipe(Effect.provide(NotionRequestSchedulerLive), Effect.provide(NodeServices.layer), Effect.scoped, Effect.result);
const result = await Effect.runPromise(program);
console.log(JSON.stringify({ pid:process.pid, cache:process.env.NTN_SKILLS_CACHE_HOME,
  result: result._tag === "Success" ? { ok:true, value:result.success } : { ok:false, code:result.failure.code, details:result.failure.details } }));
if (process.connected) process.disconnect();
`

type ChildReceipt = {
  readonly pid: number
  readonly cache: string
  readonly result: { readonly ok: boolean; readonly code?: string; readonly value?: unknown }
}
type ReadyObservation = { readonly pid: number; readonly time: number }
type Input = {
  readonly mode?: "send" | "hold" | "cooldown"
  readonly label: string
  readonly credential: string
  readonly connection: string
  readonly workspace: string
  readonly origin: string
  readonly count?: number
  readonly priority?: "foreground" | "prefetch"
  readonly cooldown?: number
  readonly reason?: string
  readonly waitForRelease?: boolean
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "notion-scheduler-process-"))
  const directory = join(root, "machine")
  const arrivals: { path: string; time: number }[] = []
  const server = createServer((request, response) => {
    arrivals.push({ path: request.url ?? "", time: Date.now() })
    response.end("observed")
  })
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No loopback port")
  const origin = `http://127.0.0.1:${address.port}`
  const children: ReturnType<typeof spawn>[] = []
  let sequence = 0
  function child(input: Omit<Input, "origin">, extra: Record<string, string> = {}) {
    const cache = join(root, `cache-${sequence++}`)
    const process = spawn(
      globalThis.process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", workerSource],
      {
        cwd: join(repository, "packages/core"),
        env: {
          PATH: globalThis.process.env.PATH,
          NTN_SKILLS_SCHEDULER_ROOT: directory,
          NTN_SKILLS_CACHE_HOME: cache,
          NTN_SKILLS_HOME: join(cache, "state"),
          XDG_CACHE_HOME: cache,
          SCHEDULER_INPUT: JSON.stringify({ ...input, origin }),
          ...extra,
        },
        stdio: input.waitForRelease
          ? ["ignore", "pipe", "pipe", "ipc"]
          : ["ignore", "pipe", "pipe"],
      },
    )
    children.push(process)
    let stdout = ""
    let stderr = ""
    process.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    process.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveClose, reject) => {
        process.on("error", reject)
        process.on("close", (code) => resolveClose({ code, stdout, stderr }))
      },
    )
    const ready = input.waitForRelease
      ? new Promise<ReadyObservation>((resolveReady, rejectReady) => {
          process.once("message", (message) => {
            if (
              typeof message !== "object" ||
              message === null ||
              !("type" in message) ||
              message.type !== "ready" ||
              !("pid" in message) ||
              typeof message.pid !== "number" ||
              !("time" in message) ||
              typeof message.time !== "number"
            ) {
              rejectReady(new Error("Invalid receiver readiness observation"))
              return
            }
            resolveReady({ pid: message.pid, time: message.time })
          })
          void closed.then(
            () => rejectReady(new Error("Receiver closed before readiness")),
            rejectReady,
          )
        })
      : undefined
    return {
      process,
      closed,
      ready() {
        if (ready === undefined) throw new Error("Receiver has no readiness barrier")
        return ready
      },
      release() {
        const send = process.send?.bind(process)
        if (!process.connected || send === undefined)
          throw new Error("Receiver has no connected release channel")
        return new Promise<void>((resolveRelease, rejectRelease) => {
          send("release", (error) => (error ? rejectRelease(error) : resolveRelease()))
        })
      },
      async receipt(): Promise<ChildReceipt> {
        const result = await closed
        if (result.code !== 0) throw new Error(`Worker failed: ${result.stderr}`)
        return JSON.parse(result.stdout.trim())
      },
    }
  }
  function waiters() {
    const filename = join(directory, "notion-requests.sqlite")
    if (!existsSync(filename)) return []
    const database = new DatabaseSync(filename, { readOnly: true })
    try {
      return database.prepare("SELECT id,lease_until_ms FROM request_waiters").all()
    } catch {
      return []
    } finally {
      database.close()
    }
  }
  return {
    root,
    directory,
    origin,
    child,
    arrivals,
    waiters,
    workspaceCooldownUntil(workspace: string) {
      const filename = join(directory, "notion-requests.sqlite")
      if (!existsSync(filename)) return null
      const database = new DatabaseSync(filename, { readOnly: true })
      try {
        const row = database
          .prepare("SELECT cooldown_until_ms FROM request_schedule WHERE credential=?")
          .get(JSON.stringify(["workspace", origin, workspace]))
        return typeof row?.cooldown_until_ms === "number" ? row.cooldown_until_ms : null
      } finally {
        database.close()
      }
    },
    async close() {
      for (const process of children)
        if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL")
      server.closeAllConnections()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      if (existsSync("/usr/bin/trash")) execFileSync("/usr/bin/trash", [root])
    },
  }
}

async function until(check: () => boolean, timeout = 8_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("The observable condition did not settle")
    await new Promise((resume) => setTimeout(resume, 25))
  }
}

test("three real Node processes with distinct content roots share the machine admission budget", async () => {
  const run = await fixture()
  let observations: DatabaseSync | undefined
  try {
    const workers = Array.from({ length: 3 }, (_, index) =>
      run.child({
        label: `worker-${index}`,
        credential: "credential-a",
        connection: "connection-a",
        workspace: "workspace-a",
        count: 2,
        waitForRelease: true,
      }),
    )
    await Promise.all(workers.map((worker) => worker.ready()))
    observations = new DatabaseSync(join(run.directory, "notion-requests.sqlite"))
    // Audit the committed budget in this fixture only. A callback runs after
    // transaction commit and OS scheduling, so it cannot timestamp admission.
    observations.exec(`
      CREATE TABLE admission_observations (credential TEXT NOT NULL, next_start_ms REAL NOT NULL);
      CREATE TRIGGER record_admission AFTER UPDATE OF next_start_ms ON request_schedule
      BEGIN
        INSERT INTO admission_observations VALUES (NEW.credential, NEW.next_start_ms);
      END;
    `)
    await Promise.all(workers.map((worker) => worker.release()))
    const receipts = await Promise.all(workers.map((worker) => worker.receipt()))
    const admissions = observations
      .prepare("SELECT next_start_ms FROM admission_observations WHERE credential=? ORDER BY rowid")
      .all(JSON.stringify(["credential", run.origin, "credential-a"]))
      .map((row) => {
        if (typeof row.next_start_ms !== "number") throw new Error("Invalid admission budget")
        return { admitted: row.next_start_ms - 350, next_start_ms: row.next_start_ms }
      })
    const admitted = admissions.map((entry) => entry.admitted)
    const admissionGaps = admitted.flatMap((time, index) => {
      const next = admitted[index + 1]
      return next === undefined ? [] : [next - time]
    })
    const admissionSpan = Math.max(...admitted) - Math.min(...admitted)
    expect(receipts.every((receipt) => receipt.result.ok)).toBe(true)
    expect(new Set(receipts.map((receipt) => receipt.pid)).size).toBe(3)
    expect(new Set(receipts.map((receipt) => receipt.cache)).size).toBe(3)
    expect(run.arrivals.length).toBe(6)
    const times = run.arrivals.map((arrival) => arrival.time).sort((a, b) => a - b)
    const gaps = times.slice(1).map((time, index) => time - times[index]!)
    const sent = receipts.flatMap((receipt, index) => {
      if (!Array.isArray(receipt.result.value))
        throw new Error("Missing worker dispatch observations")
      return receipt.result.value.map((value: unknown) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("dispatched" in value) ||
          typeof value.dispatched !== "number" ||
          !("received" in value) ||
          typeof value.received !== "number" ||
          !("item" in value) ||
          typeof value.item !== "number"
        )
          throw new Error("Invalid worker dispatch observation")
        return {
          path: `/worker-${index}/${value.item}`,
          dispatched: value.dispatched,
          received: value.received,
        }
      })
    })
    const dispatched = sent.map((entry) => entry.dispatched).sort((a, b) => a - b)
    const dispatchGaps = dispatched.slice(1).map((time, index) => time - dispatched[index]!)
    const timeline = {
      case: "cross-process-spacing",
      processes: receipts.length,
      requests: times.length,
      minimum_admission_gap_ms: Math.min(...admissionGaps),
      admission_span_ms: admissionSpan,
      minimum_dispatch_gap_ms: Math.min(...dispatchGaps),
      dispatch_span_ms: dispatched.at(-1)! - dispatched[0]!,
      minimum_arrival_gap_ms: Math.min(...gaps),
      arrival_span_ms: times.at(-1)! - times[0]!,
      admissions,
      receipts,
      arrivals: run.arrivals,
    }
    console.log(JSON.stringify(timeline))
    if (process.env.NG04_EVIDENCE !== undefined)
      await writeFile(
        join(process.env.NG04_EVIDENCE, "cross-process-spacing.json"),
        JSON.stringify(timeline, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      )
    expect(admissions).toHaveLength(6)
    expect(Math.min(...admissionGaps)).toBeGreaterThanOrEqual(350)
    expect(admissionSpan).toBeGreaterThanOrEqual(1_750)
    // Dispatch and socket arrival remain independent diagnostics: post-admission
    // delays can compress their gaps without shortening the shared budget.
    for (const entry of sent) {
      const arrival = run.arrivals.filter((item) => item.path === entry.path)
      expect(arrival).toHaveLength(1)
      expect(arrival[0]!.time).toBeGreaterThanOrEqual(entry.dispatched)
      expect(entry.received).toBeGreaterThanOrEqual(arrival[0]!.time)
    }
    expect((await stat(run.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(run.directory, "notion-requests.sqlite"))).mode & 0o777).toBe(0o600)
  } finally {
    observations?.close()
    await run.close()
  }
}, 20_000)

const cooldownCases: readonly {
  readonly name: string
  readonly evidence: string
  readonly sharedWorkspace: string
  readonly otherWorkspace: string
  readonly rejectedBy?: string
}[] = [
  {
    name: "workspace cooldown crosses connections while another workspace continues",
    evidence: "workspace-cooldown",
    sharedWorkspace: "shared",
    otherWorkspace: "other",
  },
  {
    name: "workspace cooldown oracle rejects a receiver deliberately escaping its workspace",
    evidence: "workspace-cooldown-early-shared",
    sharedWorkspace: "other",
    otherWorkspace: "other",
    rejectedBy: "Shared workspace dispatched before its persisted cooldown",
  },
  {
    name: "workspace cooldown oracle rejects an unrelated receiver deliberately sharing the cooldown",
    evidence: "workspace-cooldown-blocked-other",
    sharedWorkspace: "shared",
    otherWorkspace: "shared",
    rejectedBy: "Unrelated workspace did not dispatch during the active cooldown",
  },
]

for (const scenario of cooldownCases) {
  test(scenario.name, async () => {
    const run = await fixture()
    try {
      const receivers = [
        run.child({
          label: "shared",
          credential: "b",
          connection: "b",
          workspace: scenario.sharedWorkspace,
          waitForRelease: true,
        }),
        run.child({
          label: "other",
          credential: "c",
          connection: "c",
          workspace: scenario.otherWorkspace,
          waitForRelease: true,
        }),
      ]
      // Both services and Requests exist before the real cooldown starts.
      const ready = await Promise.all(receivers.map((worker) => worker.ready()))
      const cooled = await run
        .child({
          mode: "cooldown",
          label: "cool",
          credential: "a",
          connection: "a",
          workspace: "shared",
          cooldown: 1_500,
          reason: "public_api_space_request_rate_limit",
        })
        .receipt()
      const cooldownUntil = run.workspaceCooldownUntil("shared")
      const released = Date.now()
      await Promise.all(receivers.map((worker) => worker.release()))
      const receipts = await Promise.all(receivers.map((worker) => worker.receipt()))
      const timeline = {
        case: scenario.evidence,
        fixture_workspaces: [scenario.sharedWorkspace, scenario.otherWorkspace],
        expected_rejection: scenario.rejectedBy ?? null,
        requested_cooldown_ms: 1_500,
        ready,
        cooldown: cooled,
        cooldown_until_ms: cooldownUntil,
        released,
        receipts,
        arrivals: run.arrivals,
      }
      console.log(JSON.stringify(timeline))
      if (process.env.NG04_EVIDENCE !== undefined)
        await writeFile(
          join(process.env.NG04_EVIDENCE, `${scenario.evidence}.json`),
          JSON.stringify(timeline, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        )

      expect(cooled.result.ok).toBe(true)
      const applied = cooled.result.value
      if (
        typeof applied !== "object" ||
        applied === null ||
        !("started" in applied) ||
        typeof applied.started !== "number" ||
        !("completed" in applied) ||
        typeof applied.completed !== "number" ||
        cooldownUntil === null
      )
        throw new Error("Missing actual workspace cooldown observations")
      const cooldownStarted = applied.started
      expect(ready.every((entry) => entry.time <= cooldownStarted)).toBe(true)
      expect(cooldownUntil).toBeGreaterThanOrEqual(cooldownStarted + 1_500)
      expect(cooldownUntil).toBeLessThanOrEqual(applied.completed + 1_500)
      expect(released).toBeLessThan(cooldownUntil)
      expect(receipts.every((receipt) => receipt.result.ok)).toBe(true)
      expect(run.arrivals).toHaveLength(2)
      const dispatched = receipts.map((receipt, index) => {
        const value = receipt.result.value
        if (!Array.isArray(value) || value.length !== 1)
          throw new Error("Missing receiver dispatch")
        const observation: unknown = value[0]
        if (
          typeof observation !== "object" ||
          observation === null ||
          !("dispatched" in observation) ||
          typeof observation.dispatched !== "number" ||
          !("received" in observation) ||
          typeof observation.received !== "number"
        )
          throw new Error("Invalid receiver dispatch")
        const path = index === 0 ? "/shared/0" : "/other/0"
        const arrivals = run.arrivals.filter((entry) => entry.path === path)
        expect(arrivals).toHaveLength(1)
        expect(arrivals[0]!.time).toBeGreaterThanOrEqual(observation.dispatched)
        expect(observation.received).toBeGreaterThanOrEqual(arrivals[0]!.time)
        return observation.dispatched
      })
      const assertBoundaries = () => {
        expect(
          dispatched[0],
          "Shared workspace dispatched before its persisted cooldown",
        ).toBeGreaterThanOrEqual(cooldownUntil)
        expect(
          dispatched[1],
          "Unrelated workspace did not dispatch during the active cooldown",
        ).toBeLessThan(cooldownUntil)
      }
      if (scenario.rejectedBy === undefined) assertBoundaries()
      else expect(assertBoundaries).toThrow(scenario.rejectedBy)
    } finally {
      await run.close()
    }
  }, 15_000)
}

test("network-blocked waiters keep their leases, bound another process, and expire after a crash", async () => {
  const run = await fixture()
  try {
    const held = run.child(
      {
        mode: "hold",
        label: "held",
        credential: "a",
        connection: "same",
        workspace: "same",
        count: 2,
      },
      { NTN_SKILLS_NOTION_QUEUE_LIMIT: "2" },
    )
    await until(() => run.waiters().length === 2)
    const original = run.waiters().map((row) => Number(row.lease_until_ms))
    await new Promise((resume) => setTimeout(resume, 2_500))
    const renewed = run.waiters()
    expect(renewed.length).toBe(2)
    expect(renewed.every((row) => Number(row.lease_until_ms) > Date.now())).toBe(true)
    expect(Math.min(...renewed.map((row) => Number(row.lease_until_ms)))).toBeGreaterThan(
      Math.max(...original),
    )
    const rejected = await run
      .child(
        { label: "overflow", credential: "b", connection: "same", workspace: "same" },
        { NTN_SKILLS_NOTION_QUEUE_LIMIT: "2" },
      )
      .receipt()
    expect(rejected.result).toMatchObject({ ok: false, code: "NOTION_QUEUE_FULL" })
    expect(run.arrivals.length).toBe(0)
    held.process.kill("SIGKILL")
    await held.closed
    await until(() => run.waiters().every((row) => Number(row.lease_until_ms) <= Date.now()), 4_000)
    const recovered = await run
      .child(
        { label: "recovered", credential: "c", connection: "same", workspace: "same" },
        { NTN_SKILLS_NOTION_QUEUE_LIMIT: "2" },
      )
      .receipt()
    expect(recovered.result.ok).toBe(true)
    expect(run.arrivals.length).toBe(1)
    console.log(
      JSON.stringify({
        case: "queue-lease-crash",
        renewed_waiters: renewed.length,
        overflow: "NOTION_QUEUE_FULL",
        recovered: true,
      }),
    )
  } finally {
    await run.close()
  }
}, 20_000)

test("foreground requests overtake recent prefetch waiters in another process", async () => {
  const run = await fixture()
  try {
    const prefetch = run.child({
      mode: "hold",
      label: "prefetch",
      credential: "a",
      connection: "same",
      workspace: "same",
      priority: "prefetch",
    })
    await until(() => run.waiters().length === 1)
    const started = Date.now()
    const foreground = await run
      .child({
        label: "foreground",
        credential: "b",
        connection: "same",
        workspace: "same",
        priority: "foreground",
      })
      .receipt()
    expect(foreground.result.ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(run.arrivals.length).toBe(1)
    expect(run.waiters().length).toBe(1)
    prefetch.process.kill("SIGKILL")
    await prefetch.closed
  } finally {
    await run.close()
  }
}, 10_000)

test("scheduler refuses a symlink ancestor without touching its target", async () => {
  const run = await fixture()
  try {
    const target = join(run.root, "target")
    await mkdir(target)
    await symlink(target, join(run.root, "link"))
    const result = await run
      .child(
        { label: "blocked", credential: "a", connection: "a", workspace: "a" },
        { NTN_SKILLS_SCHEDULER_ROOT: join(run.root, "link", "machine") },
      )
      .receipt()
    expect(result.result).toMatchObject({ ok: false, code: "NOTION_SCHEDULER_UNAVAILABLE" })
    expect(existsSync(join(target, "machine"))).toBe(false)
    expect(run.arrivals.length).toBe(0)
  } finally {
    await run.close()
  }
}, 10_000)

test("retry delay never caps a server minimum and exposes seeded jitter", async () => {
  const run = (attempt: number, retryAfterSeconds?: number) =>
    Effect.runPromise(
      notionRetryDelay({ attempt, retryAfterSeconds }).pipe(Random.withSeed("schedule-delay")),
    )
  const initial = await run(0)
  const later = await run(3)
  const long = await run(8, 120)
  expect(initial).toBeGreaterThanOrEqual(1_000)
  expect(initial).toBeLessThanOrEqual(1_250)
  expect(later).toBeGreaterThanOrEqual(8_000)
  expect(later).toBeLessThanOrEqual(8_250)
  expect(long).toBeGreaterThanOrEqual(120_000)
  expect(long).toBeLessThanOrEqual(120_250)
  expect(await run(0, Number.NaN)).toBe(initial)
  expect(notionEndpoint("v1/data_sources/uuid/query", "POST")).toBe("POST data-source-query")
  expect(notionEndpoint("v1/pages/01234567-89ab-cdef-0123-456789abcdef?x=secret", "GET")).toBe(
    "GET v1/pages/:id",
  )
})
