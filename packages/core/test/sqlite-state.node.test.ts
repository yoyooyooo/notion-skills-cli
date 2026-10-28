import { expect, it, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteState } from "../src/sqlite-state.ts"
import { Store, StoreLive, sha256 } from "../src/store.ts"
import { BaseSchema } from "../src/sync.ts"
import { ObservationSchema } from "../src/cache.ts"
import { SnapshotSchema, decode } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const binding = {
  id: "b_process",
  label: "process",
  scope: "scope",
  page_id: "page",
  database_id: "db",
  data_source_id: "ds",
  logical_path: "/fixture",
  active: true,
  revision: 1,
}
const base = {
  format: "ntn-skills-sync-base" as const,
  version: 1 as const,
  binding_id: binding.id,
  generation: 0,
  initialized: false,
}
function processProgram(root: string, body: string) {
  return `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};import {SqlClient} from ${JSON.stringify(import.meta.resolve("effect/sql"))};import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(e=>{console.error(String(e));process.exitCode=1})`
}
async function child(root: string, body: string) {
  const worker = spawn(
    process.execPath,
    ["--input-type=module", "-e", processProgram(root, body)],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  worker.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  worker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = (await once(worker, "close")) as [number | null]
  return { stdout, stderr, exit }
}

test("two real processes cannot register the same binding generation twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-process-"))
  const root = join(directory, "state")
  try {
    await child(root, "console.log('ready')")
    const results = await Promise.all(
      [1, 2].map(() =>
        child(
          root,
          `yield* state.registerBindingWithBase(${JSON.stringify(binding)},${JSON.stringify(base)});console.log('registered')`,
        ),
      ),
    )
    expect(results.filter((r) => r.exit === 0)).toHaveLength(1)
    expect(results.filter((r) => r.exit !== 0)).toHaveLength(1)
    const observed = await child(
      root,
      `console.log(JSON.stringify(yield* state.bindings()));console.log(JSON.stringify(yield* state.read('sync/bases/b_process.json')))`,
    )
    expect(observed.exit).toBe(0)
    expect(observed.stdout).toContain('"generation":0')
    const generations = await Promise.all(
      [1, 2].map(() => child(root, `console.log(yield* state.reserve('scope','page'))`)),
    )
    expect(generations.map((r) => Number(r.stdout.trim())).sort()).toEqual([1, 2])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

test("View observations remain outside full catalogs and obey publication and retirement fences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-view-observation-"))
  const root = join(directory, "state")
  try {
    const first = await child(root, "console.log(yield* state.reserve('scope','views-fixture'))")
    const second = await child(root, "console.log(yield* state.reserve('scope','views-fixture'))")
    expect(first.exit).toBe(0)
    expect(second.exit).toBe(0)
    const key = "cache/views/scope/fixture.json"
    expect(
      (
        await child(
          root,
          `yield* state.write('${key}',{scope:'scope',generation:${Number(second.stdout)},fetched_at:2,view:'new'})`,
        )
      ).exit,
    ).toBe(0)
    expect(
      (
        await child(
          root,
          `yield* state.write('${key}',{scope:'scope',generation:${Number(first.stdout)},fetched_at:1,view:'old'})`,
        )
      ).exit,
    ).toBe(0)
    const current = await child(
      root,
      `console.log(JSON.stringify(yield* state.read('${key}')));console.log(JSON.stringify(yield* state.list('cache/catalogs')))`,
    )
    expect(current.exit).toBe(0)
    expect(JSON.parse(current.stdout.split("\n")[0]!)).toMatchObject({ view: "new" })
    expect(JSON.parse(current.stdout.split("\n")[1]!)).toEqual([])
    expect((await child(root, `yield* state.retire(['${key}'])`)).exit).toBe(0)
    const late = await child(
      root,
      `yield* state.write('${key}',{scope:'scope',generation:${Number(second.stdout)},fetched_at:2})`,
    )
    expect(late.exit).not.toBe(0)
    expect(late.stderr).toContain("retired before publication")
    expect(
      (
        await child(root, `console.log(JSON.stringify(yield* state.list('cache/views')))`)
      ).stdout.trim(),
    ).toBe("[]")
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

test("a separate clearing process fences an observation still held by its original publisher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-clear-"))
  const root = join(directory, "state")
  try {
    const reserved = await child(root, "console.log(yield* state.reserve('scope','page'))")
    expect(reserved.exit).toBe(0)
    const generation = Number(reserved.stdout.trim())
    expect(
      (await child(root, "yield* state.retire(['cache/latest/scope/page/.fence'])")).exit,
    ).toBe(0)
    const late = await child(
      root,
      `yield* state.write('cache/latest/scope/page/late.json',{generation:${generation},validated_at:1})`,
    )
    expect(late.exit).not.toBe(0)
    expect(late.stderr).toContain("retired before publication")
    const observed = await child(
      root,
      "console.log(JSON.stringify(yield* state.list('cache/latest')))",
    )
    expect(observed.exit).toBe(0)
    expect(JSON.parse(observed.stdout)).toEqual([])
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

test("killing a process during the official SQL transaction leaves the prior baseline for a new process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-crash-"))
  const root = join(directory, "state")
  try {
    expect(
      (
        await child(
          root,
          `yield* state.registerBindingWithBase(${JSON.stringify(binding)},${JSON.stringify(base)})`,
        )
      ).exit,
    ).toBe(0)
    const crashed = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        processProgram(
          root,
          `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;yield* sql.withTransaction(Effect.gen(function*(){yield* sql\`UPDATE bases SET generation=99 WHERE binding_id='b_process'\`;console.log('transaction-held');yield* Effect.sleep('1 minute')}))}))`,
        ),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const closed = once(crashed, "close")
    const [first] = (await once(crashed.stdout, "data")) as [Buffer]
    expect(first.toString()).toContain("transaction-held")
    const busy = await child(root, "yield* state.reserve('scope','page')")
    expect(busy.exit).not.toBe(0)
    expect(busy.stderr).toContain("bounded SQLite wait expired")
    crashed.kill("SIGKILL")
    await closed
    const after = await child(
      root,
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT generation FROM bases WHERE binding_id='b_process'\`))}))`,
    )
    expect(after.exit).toBe(0)
    expect(JSON.parse(after.stdout)[0].generation).toBe(0)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

test("missing objects never produce visible snapshot pointers and standalone backup restores referenced bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-content-"))
  const original = Object.fromEntries(
    ["NTN_SKILLS_HOME", "NTN_SKILLS_CONFIG_HOME", "NTN_SKILLS_CACHE_HOME"].map((key) => [
      key,
      process.env[key],
    ]),
  )
  Object.assign(process.env, {
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store
        const bytes = new TextEncoder().encode("durable content")
        const hash = yield* sha256(bytes)
        const snapshot = {
          snapshot_id: "s_fixture",
          scope: "scope",
          version_id: "v_fixture",
          entrypoint: "SKILL.md",
          created_at: 0,
          record: {
            id: "notion_page:page",
            kind: "skill",
            entrypoint: "SKILL.md",
            locator: {
              type: "notion_page",
              page_id: "page",
              database_id: "db",
              data_source_id: "ds",
            },
            name: "fixture",
            alias: "fixture",
            description: "fixture",
            ref: "skill://page/SKILL.md",
            default_context: false,
          },
          files: [{ path: "SKILL.md", bytes: bytes.length, sha256: hash }],
        }
        expect(
          (yield* store.writeJson("snapshots/s_fixture.json", snapshot).pipe(Effect.result))._tag,
        ).toBe("Failure")
        expect(yield* store.readJson("snapshots/s_fixture.json", SnapshotSchema)).toBeUndefined()
        yield* store.writeBytes(`objects/${hash}`, bytes)
        yield* store.writeJson("snapshots/s_fixture.json", snapshot)
        yield* store.registerBindingWithBase(binding, base)
        yield* store.backup(join(directory, "backup"))
        expect(yield* store.readJson("sync/bases/b_process.json", BaseSchema)).toEqual(base)
      }).pipe(
        Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
    const restored = await child(
      join(directory, "backup"),
      `console.log(JSON.stringify(yield* state.read('snapshots/s_fixture.json')))`,
    )
    expect(restored.exit).toBe(0)
    const snapshot = JSON.parse(restored.stdout)
    expect(
      new TextDecoder().decode(
        await readFile(join(directory, "backup/objects", snapshot.files[0].sha256)),
      ),
    ).toBe("durable content")
    await writeFile(join(directory, "backup/state.sqlite"), "corrupt")
    expect((await child(join(directory, "backup"), "console.log('must not reach')")).exit).not.toBe(
      0,
    )
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

it.live("official Node driver owns migrations, record schema and typed SQL failures", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ntn-sqlite-errors-")))
    if (process.platform === "darwin")
      yield* Effect.addFinalizer(() => trashPath(directory).pipe(Effect.orDie))
    const fs = yield* FileSystem.FileSystem
    const state = yield* sqliteState(join(directory, "state"), fs)
    const inspect = yield* state.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          migrations: yield* sql`SELECT migration_id, name FROM effect_sql_migrations`,
          snapshots: yield* sql<{ name: string }>`PRAGMA table_info(snapshots)`,
          observations: yield* sql<{ name: string }>`PRAGMA table_info(observations)`,
          wal: yield* sql`PRAGMA journal_mode`,
          synchronous: yield* sql`PRAGMA synchronous`,
          foreignKeys: yield* sql`PRAGMA foreign_keys`,
          busyTimeout: yield* sql`PRAGMA busy_timeout`,
        }
      }),
    )
    expect(inspect.migrations).toEqual([
      { migration_id: 1, name: "local_state" },
      { migration_id: 2, name: "database_init_events" },
      { migration_id: 3, name: "upstream_state" },
      { migration_id: 4, name: "content_record_identity" },
      { migration_id: 5, name: "publication_integrity_ledgers" },
      { migration_id: 6, name: "typed_publication_integrity" },
      { migration_id: 7, name: "operation_reviews" },
      { migration_id: 8, name: "view_observations" },
    ])
    expect(inspect.wal).toEqual([{ journal_mode: "wal" }])
    expect(inspect.synchronous).toEqual([{ synchronous: 2 }])
    expect(inspect.foreignKeys).toEqual([{ foreign_keys: 1 }])
    expect(inspect.busyTimeout).toEqual([{ timeout: 2000 }])
    expect(inspect.snapshots.map((column) => column.name)).toEqual([
      "id",
      "scope",
      "record_identity",
      "version_id",
      "manifest",
      "locator",
    ])
    expect(inspect.observations.map((column) => column.name)).toEqual([
      "id",
      "scope",
      "record_identity",
      "generation",
      "validated_at",
      "snapshot_id",
      "payload",
    ])
    const identity = "notion_page:99999999-9999-4999-8999-999999999999"
    const record = {
      id: identity,
      kind: "skill" as const,
      locator: {
        type: "notion_page" as const,
        page_id: "99999999-9999-4999-8999-999999999999",
        database_id: "db",
        data_source_id: "ds",
      },
      name: "Fixture Skill",
      alias: "fixture-skill",
      description: "fixture",
      default_context: false,
      entrypoint: "SKILL.md",
      ref: "skill://99999999-9999-4999-8999-999999999999/SKILL.md",
    }
    const snapshotId = `s_${yield* sha256(JSON.stringify(["scope", identity, "v_current"]))}`
    const snapshot = {
      snapshot_id: snapshotId,
      scope: "scope",
      record,
      entrypoint: "SKILL.md",
      version_id: "v_current",
      created_at: 42,
      files: [],
    }
    const observationKey = `cache/latest/scope/${identity}/1.json`
    yield* Effect.scoped(
      Effect.gen(function* () {
        const publisher = yield* sqliteState(join(directory, "state"), fs)
        yield* publisher.write(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
        const generation = yield* publisher.reserve("scope", identity)
        expect(generation).toBe(1)
        yield* publisher.write(observationKey, {
          record_identity: identity,
          scope: "scope",
          started_at: 1,
          validated_at: 2,
          generation,
          snapshot_id: snapshot.snapshot_id,
          default_context: false,
          invalidated: false,
        })
      }),
    )
    const reopened = yield* Effect.scoped(
      Effect.gen(function* () {
        const consumer = yield* sqliteState(join(directory, "state"), fs)
        return {
          snapshot: yield* consumer.read(`snapshots/${snapshot.snapshot_id}.json`),
          observation: yield* consumer.read(observationKey),
          snapshotRow: yield* consumer.run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`SELECT record_identity, locator FROM snapshots WHERE id=${snapshot.snapshot_id}`,
            ),
          ),
          observationRow: yield* consumer.run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`SELECT record_identity, snapshot_id FROM observations WHERE id=${observationKey}`,
            ),
          ),
        }
      }),
    )
    const restored = decode(SnapshotSchema, reopened.snapshot)
    expect(restored.snapshot_id).toBe(snapshot.snapshot_id)
    expect(restored.record.id).toBe(identity)
    expect(restored.record.locator).toEqual(record.locator)
    expect(restored.record.entrypoint).toBe("SKILL.md")
    expect(restored.entrypoint).toBe("SKILL.md")
    expect(restored.version_id).toBe("v_current")
    const observation = decode(ObservationSchema, reopened.observation)
    expect(observation.record_identity).toBe(identity)
    expect(observation.snapshot_id).toBe(snapshot.snapshot_id)
    expect(observation.generation).toBe(1)
    expect(reopened.snapshotRow).toEqual([
      { record_identity: identity, locator: JSON.stringify(record.locator) },
    ])
    expect(reopened.observationRow).toEqual([
      { record_identity: identity, snapshot_id: snapshot.snapshot_id },
    ])
    const schemaFailure = yield* state
      .run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT missing FROM no_such_table`))
      .pipe(Effect.result)
    expect(schemaFailure._tag === "Failure" && schemaFailure.failure.code).toBe(
      "STATE_CONFIG_ERROR",
    )
    expect(schemaFailure._tag === "Failure" && schemaFailure.failure.details).toMatchObject({
      native_code: "ERR_SQLITE_ERROR",
      sqlite_code: 1,
    })
    yield* state.registerBindingWithBase(binding, base)
    const conflict = yield* state
      .run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`INSERT INTO bindings SELECT * FROM bindings`,
        ),
      )
      .pipe(Effect.result)
    expect(conflict._tag === "Failure" && conflict.failure.code).toBe("STATE_CONFLICT")
    const unavailablePath = join(directory, "file-as-directory")
    yield* Effect.promise(() => writeFile(unavailablePath, "retained bytes"))
    const unavailable = yield* sqliteState(unavailablePath, fs).pipe(Effect.result)
    expect(unavailable._tag === "Failure" && unavailable.failure.code).toBe("STATE_UNAVAILABLE")
    expect(yield* Effect.promise(() => readFile(unavailablePath, "utf8"))).toBe("retained bytes")
    const damagedRoot = join(directory, "damaged")
    yield* Effect.promise(() => mkdir(damagedRoot))
    const damaged = Buffer.concat([Buffer.from("SQLite format 3\u0000"), Buffer.alloc(496)])
    yield* Effect.promise(() => writeFile(join(damagedRoot, "state.sqlite"), damaged))
    const corrupt = yield* sqliteState(damagedRoot, fs).pipe(Effect.result)
    expect(corrupt._tag === "Failure" && corrupt.failure.code).toBe("STATE_CORRUPT")
    expect(yield* Effect.promise(() => readFile(join(damagedRoot, "state.sqlite")))).toEqual(
      damaged,
    )
  }).pipe(Effect.provide(NodeServices.layer)),
)

it.live("closing the owner Scope closes the official database connection", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ntn-sqlite-scope-")))
    if (process.platform === "darwin")
      yield* Effect.addFinalizer(() => trashPath(directory).pipe(Effect.orDie))
    const state = yield* Effect.scoped(sqliteState(directory, yield* FileSystem.FileSystem))
    const closed = yield* state.read("sync/bases/b_process.json").pipe(Effect.result)
    expect(closed._tag === "Failure" && closed.failure.code).toBe("STATE_CONFIG_ERROR")
    expect(closed._tag === "Failure" && closed.failure.details).toMatchObject({
      native_code: "ERR_INVALID_STATE",
    })
  }).pipe(Effect.provide(NodeServices.layer)),
)
