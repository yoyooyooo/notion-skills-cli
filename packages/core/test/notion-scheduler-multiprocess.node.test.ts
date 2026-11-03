import { spawn, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, stat, symlink } from "node:fs/promises"
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
  if (input.cooldown) yield* scheduler.cooldown(input.credential, input.cooldown, { ...options, reason: input.reason });
  if (input.mode === "cooldown") return { cooldown: input.cooldown };
  return yield* Effect.all(Array.from({length: input.count ?? 1}, (_, item) => Effect.gen(function* () {
    const prepared = new Request(input.origin + "/" + input.label + "/" + item);
    const deadline = (yield* Clock.monotonicTimeNanos) + 60_000_000_000n;
    return yield* scheduler.withAdmission(input.credential, deadline, permits, Effect.tryPromise(async () => {
      const dispatched = Date.now();
      const response = await fetch(prepared);
      await response.text();
      return { item, status: response.status, dispatched, received: Date.now() };
    }), options);
  })), { concurrency: "unbounded" });
}).pipe(Effect.provide(NotionRequestSchedulerLive), Effect.provide(NodeServices.layer), Effect.scoped, Effect.result);
const result = await Effect.runPromise(program);
console.log(JSON.stringify({ pid:process.pid, cache:process.env.NTN_SKILLS_CACHE_HOME,
  result: result._tag === "Success" ? { ok:true, value:result.success } : { ok:false, code:result.failure.code, details:result.failure.details } }));
`

type ChildReceipt = {
  readonly pid: number
  readonly cache: string
  readonly result: { readonly ok: boolean; readonly code?: string; readonly value?: unknown }
}
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
        stdio: ["ignore", "pipe", "pipe"],
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
    return {
      process,
      closed,
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

test("three real Node processes with distinct content roots share the machine send budget", async () => {
  const run = await fixture()
  try {
    const workers = Array.from({ length: 3 }, (_, index) =>
      run.child({
        label: `worker-${index}`,
        credential: "credential-a",
        connection: "connection-a",
        workspace: "workspace-a",
        count: 2,
      }),
    )
    const receipts = await Promise.all(workers.map((worker) => worker.receipt()))
    expect(receipts.every((receipt) => receipt.result.ok)).toBe(true)
    expect(new Set(receipts.map((receipt) => receipt.pid)).size).toBe(3)
    expect(new Set(receipts.map((receipt) => receipt.cache)).size).toBe(3)
    expect(run.arrivals.length).toBe(6)
    const times = run.arrivals.map((arrival) => arrival.time).sort((a, b) => a - b)
    const gaps = times.slice(1).map((time, index) => time - times[index]!)
    const dispatched = receipts
      .flatMap((receipt) => {
        if (!Array.isArray(receipt.result.value))
          throw new Error("Missing worker dispatch observations")
        return receipt.result.value.map((value) => {
          if (typeof value !== "object" || value === null || typeof value.dispatched !== "number")
            throw new Error("Invalid worker dispatch observation")
          return value.dispatched
        })
      })
      .sort((a, b) => a - b)
    const dispatchGaps = dispatched.slice(1).map((time, index) => time - dispatched[index]!)
    expect(Math.min(...dispatchGaps)).toBeGreaterThanOrEqual(325)
    // Socket arrival is independently observed. Cold fetch initialization and
    // OS delivery may compress arrival gaps after correctly spaced dispatches.
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(1_650)
    expect((await stat(run.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(run.directory, "notion-requests.sqlite"))).mode & 0o777).toBe(0o600)
    console.log(
      JSON.stringify({
        case: "cross-process-spacing",
        processes: receipts.length,
        requests: times.length,
        minimum_dispatch_gap_ms: Math.min(...dispatchGaps),
        minimum_arrival_gap_ms: Math.min(...gaps),
      }),
    )
  } finally {
    await run.close()
  }
}, 20_000)

test("workspace cooldown crosses connections while another workspace continues", async () => {
  const run = await fixture()
  try {
    const start = Date.now()
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
    expect(cooled.result.ok).toBe(true)
    const receivers = [
      run.child({ label: "shared", credential: "b", connection: "b", workspace: "shared" }),
      run.child({ label: "other", credential: "c", connection: "c", workspace: "other" }),
    ]
    expect(
      (await Promise.all(receivers.map((worker) => worker.receipt()))).every(
        (receipt) => receipt.result.ok,
      ),
    ).toBe(true)
    const held = run.arrivals.find((entry) => entry.path.startsWith("/shared/"))!
    const free = run.arrivals.find((entry) => entry.path.startsWith("/other/"))!
    expect(held.time - free.time).toBeGreaterThan(600)
    expect(held.time - start).toBeGreaterThanOrEqual(1_500)
    console.log(
      JSON.stringify({ case: "workspace-cooldown", independent_lead_ms: held.time - free.time }),
    )
  } finally {
    await run.close()
  }
}, 15_000)

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
