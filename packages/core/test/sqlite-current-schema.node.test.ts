import { expect, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { sqliteState } from "../src/sqlite-state.ts"
import { trashPath } from "../src/local-locks.ts"

const core = new URL("../src/", import.meta.url).pathname
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | import("effect").Scope.Scope
    | import("effect").Crypto.Crypto
    | import("effect").Path.Path
  >,
) => Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(NodeServices.layer)))
async function bytesUnder(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const name of (await readdir(root, { recursive: true, withFileTypes: true })).filter(
    (item) => item.isFile(),
  )) {
    const path = join(name.parentPath, name.name)
    result[path.slice(root.length + 1)] = (await readFile(path)).toString("hex")
  }
  return result
}
async function cleanup(root: string) {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
}

// Keep the legacy owner open so both WAL and SHM are real pre-existing files.
test("an old SQLite root is rejected before driver open without changing database, sidecars or unique objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-old-schema-readonly-"))
  const old = new DatabaseSync(join(root, "state.sqlite"))
  try {
    old.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL); INSERT INTO publications VALUES ('unfinished','retained original intent');",
    )
    await mkdir(join(root, "objects"))
    await writeFile(join(root, "objects", "unique"), new Uint8Array([0, 255, 3, 17]))
    const before = await bytesUnder(root)
    expect(Object.keys(before)).toContain("state.sqlite-wal")
    expect(Object.keys(before)).toContain("state.sqlite-shm")
    const result = await run(
      Effect.gen(function* () {
        return yield* sqliteState(root, yield* FileSystem.FileSystem).pipe(Effect.result)
      }),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CUTOVER_REQUIRED")
    expect(result._tag === "Failure" && result.failure.details).toMatchObject({
      state_root: root,
      next_action: "initialize_new_current_root",
    })
    expect(await bytesUnder(root)).toEqual(before)
    expect(old.prepare("SELECT payload FROM publications").get()).toMatchObject({
      payload: "retained original intent",
    })
  } finally {
    old.close()
    await cleanup(root)
  }
})

test("a legacy file winning the atomic initialization race is checked before any writable open", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-schema-race-old-"))
  let winner: Record<string, string> | undefined
  try {
    const result = await run(
      Effect.gen(function* () {
        const real = yield* FileSystem.FileSystem
        const observed: FileSystem.FileSystem = {
          ...real,
          link: (from, to) =>
            Effect.gen(function* () {
              if (to === join(root, "state.sqlite")) {
                yield* Effect.promise(async () => {
                  const old = new DatabaseSync(to)
                  old.exec(
                    "CREATE TABLE retained (bytes BLOB); INSERT INTO retained VALUES (x'00ff01');",
                  )
                  old.close()
                  winner = await bytesUnder(root)
                  for (const name of Object.keys(winner))
                    if (name.startsWith(".state-")) delete winner[name]
                })
              }
              return yield* real.link(from, to)
            }),
        }
        return yield* sqliteState(root, observed).pipe(Effect.result)
      }),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CUTOVER_REQUIRED")
    expect(winner).toBeDefined()
    expect(await bytesUnder(root)).toEqual(winner)
  } finally {
    await cleanup(root)
  }
})

async function initializeProcess(root: string, suffix: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};
import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);yield* state.write('operations/current-write-pending/'+${JSON.stringify(suffix)}.repeat(64)+'/pending.json',{version:1,intent:{operation_id:${JSON.stringify(suffix)}}});console.log(yield* state.reserve('scope','current'));})).pipe(Effect.provide(NodeServices.layer)));`
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(child, "close")
  return { exit, stdout, stderr }
}

test("two first-run processes share one complete current schema and retain both pending owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-schema-current-race-"))
  try {
    const results = await Promise.all([initializeProcess(root, "a"), initializeProcess(root, "b")])
    for (const result of results) expect(result.exit, result.stderr).toBe(0)
    expect(results.map((result) => Number(result.stdout.trim())).sort()).toEqual([1, 2])
    const current = await run(
      Effect.gen(function* () {
        const state = yield* sqliteState(root, yield* FileSystem.FileSystem)
        return {
          keys: yield* state.list("operations/current-write-pending"),
          tables: yield* state.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql<{
                name: string
              }>`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
            }),
          ),
        }
      }),
    )
    expect(current.keys).toHaveLength(2)
    expect(current.tables.map((row) => row.name)).toEqual([
      "cache_admissions",
      "cache_fences",
      "catalogs",
      "identities",
      "local_content_restrictions",
      "observations",
      "shared_local_records",
      "snapshots",
      "state_format",
      "view_observations",
    ])
    const bytes = await readFile(join(root, "state.sqlite"))
    expect(bytes.readUInt32BE(68)).toBe(0x4e544e43)
    expect((await readdir(root)).some((name) => name.startsWith(".state-"))).toBe(false)
  } finally {
    await cleanup(root)
  }
})
