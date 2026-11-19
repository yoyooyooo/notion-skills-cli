import { expect, it, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqliteState } from "../src/sqlite-state.ts"
import { Store, StoreLive, sha256 } from "../src/store.ts"
import { assertKnownSnapshotAccess, ObservationSchema } from "../src/cache.ts"
import { SnapshotSchema, decode } from "../src/model.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { aliasFor, type SharedSkillRecord } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const pendingKey = `operations/current-write-pending/${"a".repeat(64)}/pending.json`
const pending = {
  version: 1,
  lifecycle: { phase: "active", record_page_id: "00000000-0000-4000-8000-000000000002" },
  scope: "a".repeat(64),
  library_id: "library-current",
  record_id: "operation-current",
  intent: {
    operation_id: "current-test",
    owner: { kind: "skill", id: "retained" },
    input_sha256: "b".repeat(64),
  },
}
function currentRecord({ skillId, name }: { skillId: string; name: string }): SharedSkillRecord {
  const id = sharedSkillId("library-current", skillId)
  return {
    id,
    kind: "skill",
    locator: {
      type: "shared_skill",
      page_id: "00000000-0000-4000-8000-000000000001",
      database_id: "00000000-0000-4000-8000-000000000003",
      data_source_id: "00000000-0000-4000-8000-000000000004",
      library_id: "library-current",
      skill_id: skillId,
    },
    name,
    alias: aliasFor(name),
    description: "Current local state fixture",
    enabled: true,
    default_context: false,
    entrypoint: "SKILL.md",
    ref: `skill://${encodeURIComponent(id)}/SKILL.md`,
  }
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

test("repeated online observations reuse one causal slot and preserve durable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-observation-reuse-"))
  const root = join(directory, "state")
  try {
    const refreshed = await child(
      root,
      `
      yield* state.write(${JSON.stringify(pendingKey)},${JSON.stringify(pending)});
      for(let attempt=0;attempt<40;attempt++) {
        const generation=yield* state.reserve('scope','page');
        yield* state.write('cache/latest/scope/page/refresh-'+generation+'.json',{
          scope:'scope',record_identity:'page',generation,started_at:attempt,validated_at:attempt,
          invalidated:false,snapshot_id:'same-fixed-snapshot',shared_body_valid_until:1000
        });
      }
      const keys=yield* state.list('cache/latest/scope/page');
      console.log(JSON.stringify({keys,latest:yield* state.read(keys[0]),pending:yield* state.read(${JSON.stringify(pendingKey)})}));
      `,
    )
    expect(refreshed.exit).toBe(0)
    const state = JSON.parse(refreshed.stdout)
    expect(state.keys).toHaveLength(1)
    expect(state.keys[0]).toBe("cache/latest/scope/page/refresh-1.json")
    expect(state.latest).toMatchObject({
      generation: 40,
      validated_at: 39,
      snapshot_id: "same-fixed-snapshot",
      shared_body_valid_until: 1000,
    })
    expect(state.pending).toEqual(pending)

    const denied = await child(
      root,
      `
      const older=yield* state.reserve('scope','page');
      const generation=yield* state.reserve('scope','page');
      yield* state.write('cache/latest/scope/page/denied.json',{
        scope:'scope',record_identity:'page',generation,started_at:50,validated_at:50,
        invalidated:true,access_denied:'ACCESS_DENIED'
      });
      console.log(older);
      `,
    )
    expect(denied.exit).toBe(0)
    const delayed = await child(
      root,
      `
      yield* state.write('cache/latest/scope/page/delayed.json',{
        scope:'scope',record_identity:'page',generation:${Number(denied.stdout)},
        started_at:49,validated_at:99999,invalidated:false,snapshot_id:'same-fixed-snapshot'
      });
      const keys=yield* state.list('cache/latest/scope/page');
      console.log(JSON.stringify({keys,latest:yield* state.read(keys[0]),pending:yield* state.read(${JSON.stringify(pendingKey)})}));
      `,
    )
    expect(delayed.exit).toBe(0)
    const retained = JSON.parse(delayed.stdout)
    expect(retained.keys).toHaveLength(1)
    expect(retained.keys).toEqual(state.keys)
    expect(retained.latest).toMatchObject({
      generation: 42,
      validated_at: 50,
      access_denied: "ACCESS_DENIED",
    })
    expect(retained.pending).toEqual(pending)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

it.live("explicit retirement during observation reads never returns a partial old grant", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ntn-observation-race-")))
    if (process.platform === "darwin")
      yield* Effect.addFinalizer(() => trashPath(directory).pipe(Effect.orDie))
    for (const scenario of ["replaced-denial", "continuous"] as const) {
      const root = join(directory, scenario)
      yield* Effect.gen(function* () {
        const store = yield* Store
        const state = yield* sqliteState(join(root, "state"), yield* FileSystem.FileSystem)
        const snapshot = decode(SnapshotSchema, {
          snapshot_id: "s_retained",
          scope: "scope",
          version_id: "retained-version",
          entrypoint: "SKILL.md",
          created_at: 0,
          record: currentRecord({ skillId: "retained", name: "retained" }),
          files: [],
        })
        yield* store.writeJson("snapshots/s_retained.json", snapshot)
        const prefix = `cache/latest/scope/${snapshot.record.id}`
        const grantKey = `${prefix}/0-grant.json`
        const grantGeneration = yield* store.reserveCacheGeneration("scope", snapshot.record.id)
        const grant = {
          scope: "scope",
          record_identity: snapshot.record.id,
          generation: grantGeneration,
          started_at: 1,
          validated_at: 1,
          invalidated: false,
          snapshot_id: snapshot.snapshot_id,
        }
        yield* store.writeJson(grantKey, grant)
        const publishDenial = () =>
          Effect.gen(function* () {
            const generation = yield* store.reserveCacheGeneration("scope", snapshot.record.id)
            yield* store.writeJson(`${prefix}/denial-${generation}.json`, {
              scope: "scope",
              record_identity: snapshot.record.id,
              generation,
              started_at: generation,
              validated_at: generation,
              invalidated: true,
              access_denied: "ACCESS_DENIED",
            })
          })
        yield* publishDenial()
        const retireAndReject = () =>
          Effect.gen(function* () {
            const generation = yield* store.reserveCacheGeneration("scope", snapshot.record.id)
            yield* store.writeJson(`${prefix}/revalidated-${generation}.json`, {
              ...grant,
              generation,
            })
            yield* state.retire([`${prefix}/.fence`])
            yield* publishDenial()
          })
        let enumerations = 0,
          missingReads = 0,
          raced = false
        const observed: Store["Service"] = {
          ...store,
          listKeys: (selected) =>
            Effect.gen(function* () {
              const keys = yield* store.listKeys(selected)
              if (selected === prefix) {
                enumerations++
                if (scenario === "continuous" || (scenario === "replaced-denial" && !raced)) {
                  raced = true
                  yield* retireAndReject()
                }
              }
              return [...keys].sort()
            }),
          readJson: (key, schema) =>
            Effect.gen(function* () {
              const value = yield* store.readJson(key, schema)
              if (key.startsWith(prefix + "/") && value === undefined) missingReads++
              return value
            }),
        }
        const gate = yield* assertKnownSnapshotAccess(snapshot).pipe(
          Effect.provideService(Store, observed),
          Effect.result,
        )
        expect(gate._tag).toBe("Failure")
        if (gate._tag !== "Failure") throw new Error(`Known denial escaped during ${scenario}`)
        expect(gate.failure.code).toBe(
          scenario === "continuous" ? "CACHE_INVALIDATED" : "ACCESS_DENIED",
        )
        expect(enumerations).toBe(scenario === "continuous" ? 3 : 2)
        expect(missingReads).toBe(scenario === "continuous" ? 3 : 1)
        const keys = yield* store.listKeys(prefix)
        expect(keys).toHaveLength(1)
        expect(yield* store.readJson(keys[0]!, ObservationSchema)).toMatchObject({
          access_denied: "ACCESS_DENIED",
        })
        expect(yield* store.readJson("snapshots/s_retained.json", SnapshotSchema)).toEqual(snapshot)
      }).pipe(
        Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              NTN_SKILLS_HOME: join(root, "state"),
              NTN_SKILLS_CONFIG_HOME: join(root, "config"),
              NTN_SKILLS_CACHE_HOME: join(root, "cache"),
            }),
          ),
        ),
      )
    }
  }).pipe(Effect.provide(NodeServices.layer)),
)

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

test("killing a process during a current cache transaction preserves its prior generation for a new process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-crash-"))
  const root = join(directory, "state")
  try {
    expect((await child(root, `yield* state.reserve('scope','page')`)).exit).toBe(0)
    const crashed = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        processProgram(
          root,
          `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;yield* sql.withTransaction(Effect.gen(function*(){yield* sql\`UPDATE cache_fences SET generation=99 WHERE scope='scope' AND identity='page'\`;console.log('transaction-held');yield* Effect.sleep('1 minute')}))}))`,
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
      `yield* state.run(Effect.gen(function*(){const sql=yield* SqlClient.SqlClient;console.log(JSON.stringify(yield* sql\`SELECT generation FROM cache_fences WHERE scope='scope' AND identity='page'\`))}))`,
    )
    expect(after.exit).toBe(0)
    expect(JSON.parse(after.stdout)[0].generation).toBe(1)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})

test("cache retirement retains only the latest explicit access denial and fences a late grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ntn-sqlite-access-"))
  const root = join(directory, "state")
  try {
    for (const [identity, code] of [
      ["page", "ACCESS_DENIED"],
      ["access:scope", "AUTH_REQUIRED"],
    ]) {
      const key = `cache/latest/scope/${identity}/denied.json`
      const seeded = await child(
        root,
        `
        const older=yield* state.reserve('scope',${JSON.stringify(identity)});
        const generation=yield* state.reserve('scope',${JSON.stringify(identity)});
        yield* state.write(${JSON.stringify(key)},{record_identity:${JSON.stringify(identity)},scope:'scope',generation,started_at:10,validated_at:1,invalidated:true,access_denied:${JSON.stringify(code)}});
        yield* state.write('cache/identities/credential.json',{scope:'scope'});
        console.log(JSON.stringify({older,generation}));
      `,
      )
      expect(seeded.exit).toBe(0)
      const generations = JSON.parse(seeded.stdout)
      expect((await child(root, `yield* state.retire([${JSON.stringify(key)}])`)).exit).toBe(0)
      const retained = await child(
        root,
        `console.log(JSON.stringify(yield* state.read(${JSON.stringify(key)})))`,
      )
      expect(retained.exit).toBe(0)
      expect(JSON.parse(retained.stdout)).toMatchObject({ access_denied: code, validated_at: 1 })
      const association = await child(
        root,
        `yield* state.retire(['cache/identities/credential.json']);console.log(JSON.stringify((yield* state.read('cache/identities/credential.json'))??null))`,
      )
      expect(association.exit).toBe(0)
      expect(JSON.parse(association.stdout)).toEqual(
        identity === "access:scope" ? { scope: "scope" } : null,
      )
      const late = await child(
        root,
        `yield* state.write('cache/latest/scope/${identity}/late.json',{generation:${generations.older},validated_at:2,invalidated:false})`,
      )
      expect(late.exit).not.toBe(0)
      expect(late.stderr).toContain("retired before publication")
      const cleared = await child(
        root,
        `
        const generation=yield* state.reserve('scope',${JSON.stringify(identity)});
        yield* state.write('cache/latest/scope/${identity}/allowed.json',{record_identity:${JSON.stringify(identity)},scope:'scope',generation,started_at:20,validated_at:20,invalidated:false});
        yield* state.retire(['cache/latest/scope/${identity}/.fence']);
        yield* state.retire(['cache/identities/credential.json']);
        console.log(JSON.stringify(yield* state.list('cache/latest/scope/${identity}')));
        console.log(JSON.stringify((yield* state.read('cache/identities/credential.json'))??null));
      `,
      )
      expect(cleared.exit).toBe(0)
      expect(
        cleared.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([[], null])
    }
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
          record: currentRecord({ skillId: "fixture", name: "fixture" }),
          files: [{ path: "SKILL.md", bytes: bytes.length, sha256: hash }],
        }
        expect(
          (yield* store.writeJson("snapshots/s_fixture.json", snapshot).pipe(Effect.result))._tag,
        ).toBe("Failure")
        expect(yield* store.readJson("snapshots/s_fixture.json", SnapshotSchema)).toBeUndefined()
        yield* store.writeBytes(`objects/${hash}`, bytes)
        yield* store.writeJson("snapshots/s_fixture.json", snapshot)
        yield* store.writeJson(pendingKey, pending)
        yield* store.backup(join(directory, "backup"))
        expect(yield* store.readJson(pendingKey, Schema.Unknown)).toEqual(pending)
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

it.live(
  "official Node driver owns the current schema, physical identity and typed SQL failures",
  () =>
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
            format: yield* sql`SELECT version FROM state_format`,
            snapshots: yield* sql<{ name: string }>`PRAGMA table_info(snapshots)`,
            observations: yield* sql<{ name: string }>`PRAGMA table_info(observations)`,
            wal: yield* sql`PRAGMA journal_mode`,
            synchronous: yield* sql`PRAGMA synchronous`,
            foreignKeys: yield* sql`PRAGMA foreign_keys`,
            busyTimeout: yield* sql`PRAGMA busy_timeout`,
          }
        }),
      )
      expect(inspect.format).toEqual([{ version: 1 }])
      expect(inspect.wal).toEqual([{ journal_mode: "wal" }])
      expect(inspect.synchronous).toEqual([{ synchronous: 2 }])
      expect(inspect.foreignKeys).toEqual([{ foreign_keys: 1 }])
      expect(inspect.busyTimeout).toEqual([{ timeout: 2000 }])
      expect(inspect.snapshots.map((column) => column.name)).toEqual([
        "id",
        "scope",
        "record_identity",
        "locator",
        "version_id",
        "manifest",
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
      const record = currentRecord({ skillId: "fixture", name: "Fixture Skill" })
      const identity = record.id
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
      const conflict = yield* state
        .run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`INSERT INTO cache_fences SELECT * FROM cache_fences`,
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
      damaged.writeUInt32BE(0x4e544e43, 68)
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
    const closed = yield* state.read(pendingKey).pipe(Effect.result)
    expect(closed._tag === "Failure" && closed.failure.code).toBe("STATE_CONFIG_ERROR")
    expect(closed._tag === "Failure" && closed.failure.details).toMatchObject({
      native_code: "ERR_INVALID_STATE",
    })
  }).pipe(Effect.provide(NodeServices.layer)),
)
