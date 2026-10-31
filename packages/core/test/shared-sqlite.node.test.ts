import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const scope = "a".repeat(64)
const keys = {
  observations: `cache/shared-file-observations/${"b".repeat(64)}/00000000000000000001.json`,
  page: `cache/shared-page-identities/${scope}/00000000-0000-4000-8000-000000000001.json`,
  github: `cache/shared-github-blobs/${"c".repeat(40)}.json`,
  observationPending: `operations/shared-observation-pending/${"d".repeat(64)}/${"e".repeat(64)}.json`,
  historyPending: `operations/shared-snapshot-history/${scope}/snapshot-${"f".repeat(64)}.json`,
  profilePending: `operations/shared-profile-pending/${scope}/${"b".repeat(64)}/profile-${"c".repeat(64)}.json`,
}
const pendingPayload = {
  version: 1,
  scope,
  operation_id: "original-operation",
  plan: { body: "original bytes\r\n", downloaded_at: 1234 },
}
const restrictedHash = "9".repeat(64)
const restrictionKey = `content-restrictions/local/${restrictedHash}.json`
const restriction = { version: 1, sha256: restrictedHash, reason: "local_resource" }

function processProgram(root: string, body: string) {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};
import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(error=>{console.error(String(error));process.exitCode=1})`
}

function start(program: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function runProgram(program: string) {
  const worker = start(program)
  let stdout = "",
    stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(worker, "close")
  return { stdout, stderr, exit }
}

const child = (root: string, body: string) => runProgram(processProgram(root, body))

async function isolated(action: (root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-shared-sqlite-"))
  try {
    await action(join(directory, "state"))
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

test("shared cache and three dispatch domains persist across real Node restarts", async () => {
  await isolated(async (root) => {
    const entries = Object.values(keys).map((key, index) => ({
      key,
      payload: { version: 1, sequence: index, frozen: "original" },
    }))
    const writer = await child(
      root,
      `for(const entry of ${JSON.stringify(entries)}) yield* state.write(entry.key,entry.payload);yield* state.write('database-init/legacy/0.json',{legacy:true});console.log('written')`,
    )
    expect(writer.exit, writer.stderr).toBe(0)
    const reader = await child(
      root,
      `const values=[];for(const entry of ${JSON.stringify(entries)}) values.push(yield* state.read(entry.key));console.log(JSON.stringify({values,cache:yield* state.list('cache'),dispatch:yield* state.list('operations'),legacy:yield* state.read('database-init/legacy/0.json')}));`,
    )
    expect(reader.exit, reader.stderr).toBe(0)
    expect(JSON.parse(reader.stdout)).toEqual({
      values: entries.map((entry) => entry.payload),
      cache: [keys.observations, keys.page, keys.github].sort(),
      dispatch: [keys.observationPending, keys.historyPending, keys.profilePending].sort(),
      legacy: { legacy: true },
    })
    const schema = await child(
      root,
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT category,retired,count(*) AS count FROM shared_local_records GROUP BY category,retired ORDER BY category\`))}))`,
    )
    expect(schema.exit, schema.stderr).toBe(0)
    expect(JSON.parse(schema.stdout)).toEqual([
      { category: "cache", retired: 0, count: 3 },
      { category: "dispatch", retired: 0, count: 3 },
    ])
  })
}, 30_000)

test("a frozen key is idempotent across processes and rejects different content without overwriting", async () => {
  await isolated(async (root) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await child(
        root,
        `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)})`,
      )
      expect(result.exit, result.stderr).toBe(0)
    }
    const conflicting = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify({ ...pendingPayload, operation_id: "replacement-operation" })})`,
    )
    expect(conflicting.exit).not.toBe(0)
    expect(conflicting.stderr).toContain("cannot be overwritten")
    const retained = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.observationPending)})));yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT count(*) AS count FROM shared_local_records\`))}))`,
    )
    expect(retained.exit, retained.stderr).toBe(0)
    const output = retained.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(output).toEqual([pendingPayload, [{ count: 1 }]])
  })
}, 30_000)

test("competing real processes cannot replace one dispatch key with two different plans", async () => {
  await isolated(async (root) => {
    expect((await child(root, "console.log('initialized')")).exit).toBe(0)
    const contenders = await Promise.all(
      ["first", "second"].map((candidate) =>
        child(
          root,
          `yield* state.write(${JSON.stringify(keys.historyPending)},${JSON.stringify({ ...pendingPayload, candidate })});console.log(${JSON.stringify(candidate)})`,
        ),
      ),
    )
    expect(contenders.filter((result) => result.exit === 0)).toHaveLength(1)
    expect(contenders.filter((result) => result.exit !== 0)).toHaveLength(1)
    const winner = contenders.find((result) => result.exit === 0)?.stdout.trim()
    const saved = await child(
      root,
      `console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.historyPending)})))`,
    )
    expect(saved.exit, saved.stderr).toBe(0)
    expect(JSON.parse(saved.stdout)).toEqual({ ...pendingPayload, candidate: winner })
  })
}, 30_000)

test("a committed pending receipt survives abrupt process death and is readable without its creator", async () => {
  await isolated(async (root) => {
    const worker = start(
      processProgram(
        root,
        `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)});console.log('dispatch-durable');yield* Effect.never`,
      ),
    )
    const closed = once(worker, "close")
    let stderr = ""
    worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    try {
      const ready = await Promise.race([
        once(worker.stdout, "data").then(([chunk]) => String(chunk)),
        closed.then(() => {
          throw new Error(`Dispatch process exited before its receipt committed: ${stderr}`)
        }),
      ])
      expect(ready).toContain("dispatch-durable")
    } finally {
      worker.kill("SIGKILL")
      await closed
    }
    const reopened = await child(
      root,
      `console.log(JSON.stringify({pending:yield* state.read(${JSON.stringify(keys.observationPending)}),keys:yield* state.list('operations/shared-observation-pending')}))`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({
      pending: pendingPayload,
      keys: [keys.observationPending],
    })
  })
}, 30_000)

test("dispatch retirement hides active work but retains its exact payload and never silently reactivates it", async () => {
  await isolated(async (root) => {
    const dispatched = [keys.observationPending, keys.historyPending, keys.profilePending]
    const retired = await child(
      root,
      `for(const key of ${JSON.stringify(dispatched)}) yield* state.write(key,${JSON.stringify(pendingPayload)});yield* state.retire(${JSON.stringify(dispatched)});yield* state.retire(${JSON.stringify(dispatched)});console.log(JSON.stringify({active:yield* state.list('operations'),read:yield* state.read(${JSON.stringify(keys.observationPending)})}));yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT key,payload,retired FROM shared_local_records ORDER BY key\`))}))`,
    )
    expect(retired.exit, retired.stderr).toBe(0)
    const [active, rows] = retired.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(active).toEqual({ active: [] })
    expect(rows).toEqual(
      dispatched
        .sort()
        .map((key) => ({ key, payload: JSON.stringify(pendingPayload), retired: 1 })),
    )
    const reopened = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},${JSON.stringify(pendingPayload)})`,
    )
    expect(reopened.exit).not.toBe(0)
    expect(reopened.stderr).toContain("retired shared dispatch receipt")
    const conflict = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.observationPending)},{version:2})`,
    )
    expect(conflict.exit).not.toBe(0)
    expect(conflict.stderr).toContain("cannot be overwritten")
  })
}, 30_000)

test("public cache clear removes shared derived lookups and preserves unfinished dispatch domains", async () => {
  await isolated(async (root) => {
    const all = Object.values(keys)
    const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {ConfigProvider,Effect,Layer,Schema} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(core + "store.ts")};
import {clearCache} from ${JSON.stringify(core + "cache.ts")};
process.env.NTN_SKILLS_HOME=${JSON.stringify(root)};
process.env.NTN_SKILLS_CONFIG_HOME=${JSON.stringify(root + "-config")};
process.env.NTN_SKILLS_CACHE_HOME=${JSON.stringify(root + "-cache")};
Effect.runPromise(Effect.gen(function*(){const store=yield* Store;for(const key of ${JSON.stringify(all)}) yield* store.writeJson(key,${JSON.stringify(pendingPayload)});const result=yield* clearCache(undefined,{all:true});console.log(JSON.stringify({entries:result.entries,cache:yield* store.listKeys('cache'),dispatch:yield* store.listKeys('operations'),receipt:yield* store.readJson(${JSON.stringify(keys.observationPending)},Schema.Unknown)}))}).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))).catch(error=>{console.error(String(error));process.exitCode=1})`
    const cleared = await runProgram(program)
    expect(cleared.exit, cleared.stderr).toBe(0)
    const result = JSON.parse(cleared.stdout)
    expect(result.entries.sort()).toEqual([keys.observations, keys.page, keys.github].sort())
    expect(result.cache).toEqual([])
    expect(result.dispatch).toEqual(
      [keys.observationPending, keys.historyPending, keys.profilePending].sort(),
    )
    expect(result.receipt).toEqual(pendingPayload)
    const rebuilt = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.github)},${JSON.stringify(pendingPayload)});console.log(JSON.stringify(yield* state.read(${JSON.stringify(keys.github)})))`,
    )
    expect(rebuilt.exit, rebuilt.stderr).toBe(0)
    expect(JSON.parse(rebuilt.stdout)).toEqual(pendingPayload)
    const changed = await child(
      root,
      `yield* state.write(${JSON.stringify(keys.page)},{replacement:true})`,
    )
    expect(changed.exit).not.toBe(0)
    expect(changed.stderr).toContain("cannot be overwritten")
  })
}, 30_000)

test("unregistered shared namespaces, traversal and malformed known keys cannot become generic SQLite records", async () => {
  await isolated(async (root) => {
    const invalid = [
      `cache/shared-anything/${scope}.json`,
      `operations/shared-anything/${scope}.json`,
      `operations/shared-observation-pending/${scope}/../other.json`,
      `operations/shared-snapshot-history/${scope}/latest.json`,
      `cache/shared-page-identities/${scope}/page.json`,
      `cache/shared-github-blobs/${"c".repeat(40)}`,
      `cache/shared-file-observations/${scope}/1.json`,
      `operations/shared-profile-pending/${scope}/profile-${"c".repeat(64)}.json`,
      `content-restrictions/other/${scope}.json`,
      `content-restrictions/local/${scope}.json/extra`,
    ]
    const result = await child(
      root,
      `const results=[];for(const key of ${JSON.stringify(invalid)}){const written=yield* state.write(key,{invalid:true}).pipe(Effect.result);const read=yield* state.read(key).pipe(Effect.result);results.push({write:written._tag,read:read._tag});}console.log(JSON.stringify({results,cache:yield* state.list('cache'),dispatch:yield* state.list('operations')}))`,
    )
    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      results: invalid.map(() => ({ write: "Failure", read: "Failure" })),
      cache: [],
      dispatch: [],
    })
  })
}, 30_000)

test("local-content restrictions survive restarts and cache retirement, and cannot be cleared or changed", async () => {
  await isolated(async (root) => {
    const written = await child(
      root,
      `yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify(restriction)});yield* state.write(${JSON.stringify(keys.github)},{version:1});yield* state.retire(yield* state.list('cache'));console.log('retained')`,
    )
    expect(written.exit, written.stderr).toBe(0)
    const reopened = await child(
      root,
      `yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify({ reason: "local_resource", sha256: restrictedHash, version: 1 })});const removed=yield* state.retire([${JSON.stringify(restrictionKey)}]).pipe(Effect.result);const changed=yield* state.write(${JSON.stringify(restrictionKey)},{...${JSON.stringify(restriction)},reason:'public'}).pipe(Effect.result);console.log(JSON.stringify({record:yield* state.read(${JSON.stringify(restrictionKey)}),keys:yield* state.list('content-restrictions'),cache:yield* state.list('cache'),removed:removed._tag,changed:changed._tag}));`,
    )
    expect(reopened.exit, reopened.stderr).toBe(0)
    expect(JSON.parse(reopened.stdout)).toEqual({
      record: restriction,
      keys: [restrictionKey],
      cache: [],
      removed: "Failure",
      changed: "Failure",
    })
  })
}, 30_000)

test("local-content restriction schema and persisted corruption fail closed without replacing evidence", async () => {
  await isolated(async (root) => {
    const invalid = [
      null,
      {},
      { ...restriction, sha256: "8".repeat(64) },
      { ...restriction, absolute_root: "/private" },
    ]
    const rejected = await child(
      root,
      `const outcomes=[];for(const value of ${JSON.stringify(invalid)}) outcomes.push((yield* state.write(${JSON.stringify(restrictionKey)},value).pipe(Effect.result))._tag);console.log(JSON.stringify({outcomes,keys:yield* state.list('content-restrictions')}));`,
    )
    expect(rejected.exit, rejected.stderr).toBe(0)
    expect(JSON.parse(rejected.stdout)).toEqual({
      outcomes: invalid.map(() => "Failure"),
      keys: [],
    })
    const corrupt = await child(
      root,
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;yield* sql\`INSERT INTO local_content_restrictions(sha256,payload) VALUES(\${${JSON.stringify(restrictedHash)}},\${${JSON.stringify(JSON.stringify({ ...restriction, reason: "public" }))}})\`;}));const read=yield* state.read(${JSON.stringify(restrictionKey)}).pipe(Effect.result);const write=yield* state.write(${JSON.stringify(restrictionKey)},${JSON.stringify(restriction)}).pipe(Effect.result);console.log(JSON.stringify({read:read._tag,write:write._tag}));`,
    )
    expect(corrupt.exit, corrupt.stderr).toBe(0)
    expect(JSON.parse(corrupt.stdout)).toEqual({ read: "Failure", write: "Failure" })
  })
}, 30_000)
