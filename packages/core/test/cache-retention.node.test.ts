import { expect, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Crypto, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cacheRetentionReport,
  configureCacheCapacity,
  previewCacheReclamation,
  reclaimCache,
} from "../src/cache-retention.ts"
import { trashPath } from "../src/local-locks.ts"
import type { SkillsError, Snapshot } from "../src/model.ts"
import { sqliteState } from "../src/sqlite-state.ts"
import { Store, StoreLive } from "../src/store.ts"

const key = (id: string) => `cache/shared-github-blobs/${id.repeat(40)}.json`
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const payload = { version: 1, git_oid: "a".repeat(40), sha256: hash("retained"), bytes: 8 }
const journal = `operations/current-write-pending/${"c".repeat(64)}/pending.json`
const pending = {
  completion: "ready",
  owner_page_id: null,
  version: 1,
  scope: "c".repeat(64),
  library_id: "library-current",
  record_id: "current-cache-test",
  intent: {
    operation_id: "cache-test",
    owner: { kind: "skill", id: "one" },
    input_sha256: payload.sha256,
  },
  lifecycle: { phase: "active", record_page_id: "00000000-0000-4000-8000-000000000009" },
}
const core = new URL("../src/", import.meta.url).pathname

async function isolated(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-cache-retention-"))
  try {
    await operation(directory)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
}

function run<A, E>(
  directory: string,
  program: Effect.Effect<A, E, Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(
    program.pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            NTN_SKILLS_HOME: join(directory, "state"),
            NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
            NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
          }),
        ),
      ),
    ),
  )
}

async function child(root: string, body: string, maxBytes: number) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem,{max_bytes:${maxBytes},retention_ms:604800000});${body}})).pipe(Effect.provide(NodeServices.layer)));`
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  process.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  process.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const [exit] = await once(process, "close")
  return { exit, stdout, stderr }
}

test("two independent writers admit only the shared capacity, including retired payloads, while original pending intents persist", async () =>
  isolated(async (directory) => {
    const root = join(directory, "state")
    const maximum = Buffer.byteLength(JSON.stringify(payload)) + 1
    expect((await child(root, "console.log('ready')", maximum)).exit).toBe(0)
    const writes = await Promise.all(
      ["a", "b"].map((id) =>
        child(
          root,
          `yield* state.write(${JSON.stringify(key(id))},${JSON.stringify(payload)});`,
          maximum,
        ),
      ),
    )
    for (const result of writes) expect(result, result.stderr).toMatchObject({ exit: 0 })
    const inspect = await child(
      root,
      `const rows=yield* state.rebuildableCacheRecords();yield* state.retire(rows.map(row=>row.key));yield* state.write(${JSON.stringify(key("c"))},${JSON.stringify(payload)});yield* state.write(${JSON.stringify(journal)},${JSON.stringify(pending)});console.log(JSON.stringify({rows:yield* state.rebuildableCacheRecords(),journal:yield* state.read(${JSON.stringify(journal)})}));`,
      maximum,
    )
    expect(inspect.exit, inspect.stderr).toBe(0)
    const result = JSON.parse(inspect.stdout)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].retired).toBe(1)
    expect(result.rows[0].admitted_at).toBeGreaterThan(0)
    expect(result.journal).toEqual(pending)
  }))

test.skipIf(process.platform !== "darwin")(
  "exact preview uses system Trash, preserves current fixed bytes and permits fixed-index reconstruction",
  async () =>
    isolated(async (directory) => {
      const snapshots: Snapshot[] = ["one", "two"].map((id) => ({
        snapshot_id: `s_${id}`,
        scope: "scope",
        version_id: "v_1",
        entrypoint: "SKILL.md",
        created_at: 1,
        record: {
          id: `shared_skill:library-current:${id}`,
          kind: "skill",
          entrypoint: "SKILL.md",
          locator: {
            type: "shared_skill",
            page_id: "00000000-0000-4000-8000-000000000001",
            database_id: "00000000-0000-4000-8000-000000000003",
            data_source_id: "00000000-0000-4000-8000-000000000004",
            library_id: "library-current",
            skill_id: id,
          },
          name: id,
          alias: id,
          description: id,
          ref: `skill://${encodeURIComponent(`shared_skill:library-current:${id}`)}/SKILL.md`,
          default_context: false,
        },
        files: [{ path: "SKILL.md", bytes: 8, sha256: payload.sha256 }],
      }))
      await run(
        directory,
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.writeJson("config.json", {
            token: "preserved-secret",
            custom: { preserve: true },
          })
          yield* store.writeBytes(`objects/${payload.sha256}`, new TextEncoder().encode("retained"))
          for (const snapshot of snapshots)
            yield* store.writeJson(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
          yield* store.writeJson(key("a"), payload)
          yield* store.writeJson(journal, pending)
          yield* configureCacheCapacity({ maxBytes: 0, retentionMs: 0 })
        }),
      )
      const preview = await run(directory, previewCacheReclamation())
      expect(preview.candidates.map((row) => row.key)).toEqual([key("a")])
      expect(preview.objects).toHaveLength(1)
      expect(preview.objects[0]).toMatchObject({
        bytes: 8,
        snapshots: ["s_one", "s_two"],
        owners: ["shared_skill:library-current:one", "shared_skill:library-current:two"],
      })
      expect(preview.objects[0]?.protected_by).toContain("shared_object")
      expect(preview.database.length).toBeGreaterThan(0)
      const reclaimed = await run(directory, reclaimCache({ planId: preview.plan_id }))
      expect(reclaimed.reclaimed).toEqual([key("a")])
      expect(reclaimed.archive?.trash_confirmed).toBe(true)
      expect(reclaimed.physical_disk_limit).toBe(false)
      const after = await run(
        directory,
        Effect.gen(function* () {
          const store = yield* Store
          expect(yield* store.readJson(journal, Schema.Unknown)).toEqual(pending)
          expect(yield* store.readJson("config.json", Schema.Unknown)).toMatchObject({
            token: "preserved-secret",
            custom: { preserve: true },
          })
          expect(
            new TextDecoder().decode(yield* store.readBytes(`objects/${payload.sha256}`)),
          ).toBe("retained")
          for (const snapshot of snapshots)
            expect(
              yield* store.readJson(`snapshots/${snapshot.snapshot_id}.json`, Schema.Unknown),
            ).toEqual(snapshot)
          return yield* cacheRetentionReport()
        }),
      )
      expect(after.totals.rebuildable_logical_bytes).toBe(0)
      expect(after.totals.unique_object_bytes).toBe(8)
      expect(after.database.reduce((sum, row) => sum + row.bytes, 0)).toBeGreaterThan(0)
      await run(directory, configureCacheCapacity({ maxBytes: 1000 }))
      await run(
        directory,
        Effect.gen(function* () {
          const store = yield* Store
          yield* store.writeJson(key("a"), payload)
          expect(yield* store.readJson(key("a"), Schema.Unknown)).toEqual(payload)
        }),
      )
    }),
)

test("a changed preview is rejected before archive creation or index removal", async () =>
  isolated(async (directory) => {
    await run(
      directory,
      Effect.gen(function* () {
        yield* (yield* Store).writeJson(key("a"), payload)
        yield* configureCacheCapacity({ maxBytes: 0 })
      }),
    )
    const preview = await run(directory, previewCacheReclamation())
    await run(directory, configureCacheCapacity({ maxBytes: 1 }))
    const result = await run(
      directory,
      reclaimCache({ planId: preview.plan_id }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "CACHE_RECLAIM_STALE" } })
    expect(
      (await run(directory, cacheRetentionReport())).totals.rebuildable_logical_bytes,
    ).toBeGreaterThan(0)
  }))

test("unavailable system Trash leaves the original row and exact verified archive in place", async () =>
  isolated(async (directory) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const state = yield* sqliteState(join(directory, "state"), fs)
          yield* state.write(key("a"), payload)
          const originalPlatform = process.platform
          const result = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              Object.defineProperty(process, "platform", { value: "linux" })
              return originalPlatform
            }),
            () =>
              state
                .reclaimDerived([{ key: key("a"), sha256: hash(JSON.stringify(payload)) }])
                .pipe(Effect.result),
            (original) =>
              Effect.sync(() => {
                Object.defineProperty(process, "platform", { value: original })
              }),
          )
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { code: "RETENTION_UNAVAILABLE" },
          })
          expect(yield* state.read(key("a"))).toEqual(payload)
          const names = yield* fs.readDirectory(join(directory, "state/cache-recovery"))
          expect(names).toHaveLength(1)
          const archive = JSON.parse(
            yield* fs.readFileString(join(directory, "state/cache-recovery", names[0]!)),
          )
          expect(archive.records[0].payload).toBe(JSON.stringify(payload))
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  }))

test.skipIf(process.platform !== "darwin").each(["payload", "admission", "retirement"] as const)(
  "compare-and-delete preserves a concurrent %s change after the recovery archive reaches Trash",
  async (change) =>
    isolated(async (directory) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            let replace: (() => Effect.Effect<void, SkillsError>) | undefined
            const observedFs: FileSystem.FileSystem = {
              ...fs,
              exists: (location) =>
                Effect.gen(function* () {
                  const exists = yield* fs.exists(location)
                  if (
                    !exists &&
                    location.includes("/cache-recovery/ntn-cache-recovery-") &&
                    replace !== undefined
                  ) {
                    const action = replace
                    replace = undefined
                    yield* action().pipe(Effect.orDie)
                  }
                  return exists
                }),
            }
            const state = yield* sqliteState(join(directory, "state"), observedFs)
            yield* state.write(key("a"), payload)
            const replacement = change === "payload" ? { ...payload, bytes: 9 } : payload
            replace = () =>
              state.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient
                  if (change === "payload")
                    yield* sql`UPDATE shared_local_records SET payload=${JSON.stringify(replacement)} WHERE key=${key("a")}`
                  else if (change === "admission")
                    yield* sql`UPDATE cache_admissions SET admitted_at=admitted_at+1 WHERE key=${key("a")}`
                  else yield* sql`UPDATE shared_local_records SET retired=1 WHERE key=${key("a")}`
                }),
              )
            const result = yield* state.reclaimDerived([
              { key: key("a"), sha256: hash(JSON.stringify(payload)) },
            ])
            expect(result.archive?.trash_confirmed).toBe(true)
            expect(result.reclaimed).toEqual([])
            expect(yield* state.read(key("a"))).toEqual(
              change === "retirement" ? undefined : replacement,
            )
            expect((yield* state.rebuildableCacheRecords()).map((row) => row.key)).toEqual([
              key("a"),
            ])
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      )
    }),
)
