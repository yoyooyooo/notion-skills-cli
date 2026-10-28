import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlClient } from "effect/sql"
import { sqliteState } from "../src/sqlite-state.ts"
import type { UpstreamBinding, UpstreamOperation, UpstreamPlan } from "../src/upstream-model.ts"

const subscription = "11111111-1111-4111-8111-111111111111"
const portable = {
  kind: "skill" as const,
  name: "Alpha",
  description: "Use for SQL baseline acceptance",
  main: "SKILL.md",
  files: [{ path: "SKILL.md", hash: "a".repeat(64) }],
}
const plan: UpstreamPlan = {
  version: 1,
  plan_id: "up_controlled",
  plan_hash: "b".repeat(64),
  created_at: 1,
  subscription_id: subscription,
  subscription_version: "v1",
  config_hash: "config",
  revision: "commit",
  provenance: {},
  publisher_subscription_id: subscription,
  target_database_id: "db",
  items: [],
}
const operation: UpstreamOperation = {
  operation_id: "uo_controlled",
  plan_id: plan.plan_id,
  subscription_id: subscription,
  state: "running",
  items: [{ member_key: "skills/alpha", status: "verified", page_id: "page" }],
}
const binding: UpstreamBinding = {
  subscription_id: subscription,
  member_key: "skills/alpha",
  target_key: "shared:alpha",
  page_id: "page",
  generation: 1,
  mode: "tracked",
  active: true,
  revision: "commit",
  published_hash: "a".repeat(64),
  accepted: portable,
  materialized: portable,
}
const core = new URL("../src/", import.meta.url).pathname
async function child(root: string, body: string) {
  const program = `import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};import {Effect,FileSystem} from ${JSON.stringify(import.meta.resolve("effect"))};import {sqliteState} from ${JSON.stringify(core + "sqlite-state.ts")};Effect.runPromise(Effect.scoped(Effect.gen(function*(){const state=yield* sqliteState(${JSON.stringify(root)},yield* FileSystem.FileSystem);${body}})).pipe(Effect.provide(NodeServices.layer))).catch(e=>{console.error(String(e));process.exitCode=1})`
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  process.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text
  })
  process.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text
  })
  const [exit] = await once(process, "close")
  return { exit, stdout, stderr }
}
test("real SQLite advances only verified member baselines and retains one operation per frozen plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-upstream-state-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = (yield* sqliteState(root, yield* FileSystem.FileSystem)).upstream
          yield* state.savePlan(plan)
          yield* state.saveOperation(operation)
          const invalid = yield* state
            .advance(binding, 0, subscription, {
              ...operation,
              items: [{ member_key: binding.member_key, status: "unknown" }],
            })
            .pipe(Effect.result)
          expect(invalid._tag).toBe("Failure")
          expect(yield* state.bindings(subscription)).toEqual([])
          yield* state.advance(binding, 0, subscription, operation)
          expect((yield* state.bindings(subscription))[0]).toEqual(binding)
          expect(yield* state.target(binding.target_key)).toEqual({
            page_id: "page",
            publisher_subscription_id: subscription,
          })
          expect(yield* state.command(`materialized:${binding.target_key}`)).toEqual({
            portable: binding.materialized,
            content_hash: binding.published_hash,
            revision: binding.revision,
          })
          expect(
            (yield* state.advance(binding, 0, subscription, operation).pipe(Effect.result))._tag,
          ).toBe("Failure")
          expect(
            (yield* state
              .saveOperation({ ...operation, operation_id: "uo_competing" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure")
          yield* state.saveCommand("create-command", {
            state: "unknown",
            operation_id: "create-command",
          })
          expect(yield* state.command("create-command")).toEqual({
            state: "unknown",
            operation_id: "create-command",
          })
          const scoped = { ...operation, scope: "scope-a", database_id: "database-a" }
          yield* state.saveOperation(scoped)
          expect(yield* state.scopedOperations("scope-a", "database-a")).toEqual([scoped])
          expect(yield* state.scopedOperations("scope-b", "database-a")).toEqual([])
          expect(yield* state.scopedOperations("scope-a", "database-b")).toEqual([])
          const removal = {
            operation_id: "ur_scoped",
            domain: "subscription_remove",
            scope: "scope-a",
            database_id: "database-a",
            page_id: subscription,
            expected_version: "v1",
            state: "unknown",
          }
          yield* state.saveCommand(removal.operation_id, removal)
          yield* state.saveCommand("materialized:scoped", {
            scope: "scope-a",
            database_id: "database-a",
            portable,
          })
          yield* state.saveCommand("unknown-shape", {
            scope: "scope-a",
            database_id: "database-a",
            state: "unknown",
          })
          expect(yield* state.scopedCommands("scope-a", "database-a")).toEqual([removal])
          expect(yield* state.scopedCommands("scope-b", "database-a")).toEqual([])
          expect(yield* state.scopedCommands("scope-a", "database-b")).toEqual([])
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("two real processes cannot advance the same upstream accepted generation twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-upstream-race-"))
  try {
    const initialized = await child(
      root,
      `yield* state.upstream.savePlan(${JSON.stringify(plan)});yield* state.upstream.saveOperation(${JSON.stringify(operation)});console.log('ready')`,
    )
    expect(initialized.exit).toBe(0)
    const results = await Promise.all(
      [1, 2].map(() =>
        child(
          root,
          `yield* state.upstream.advance(${JSON.stringify(binding)},0,${JSON.stringify(subscription)},${JSON.stringify(operation)});console.log('advanced')`,
        ),
      ),
    )
    expect(results.filter((r) => r.exit === 0)).toHaveLength(1)
    expect(results.filter((r) => r.exit !== 0)).toHaveLength(1)
    const verified = await child(
      root,
      `console.log(JSON.stringify(yield* state.upstream.bindings(${JSON.stringify(subscription)})))`,
    )
    expect(verified.exit).toBe(0)
    expect(JSON.parse(verified.stdout.trim())).toEqual([binding])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("real SQLite commitRebuild replaces one exact member and rolls drift back", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-upstream-rebuild-"))
  const next = {
    ...binding,
    page_id: "rebuilt",
    generation: 2,
    published_hash: "c".repeat(64),
    revision: "rebuilt",
  }
  const other: UpstreamBinding = {
    ...binding,
    member_key: "skills/beta",
    target_key: "shared:beta",
    page_id: "beta",
    generation: 2,
  }
  const receipt = {
    format: 1,
    operation_id: "p_rebuild",
    operation: "create",
    state: "completed",
    page_id: next.page_id,
    context: {
      source_intent: { mode: "set", value: { type: "upstream" } },
      ownership: {
        subscription_id: subscription,
        member_key: "alpha",
        mode: next.mode,
        published_hash: next.published_hash,
        revision: next.revision,
      },
    },
    portable: {
      kind: next.materialized.kind,
      name: next.materialized.name,
      description: next.materialized.description,
      main: next.materialized.main,
      files: next.materialized.files.map((file) => ({ path: file.path, sha256: file.hash })),
    },
    guards: {},
    intents: [],
    stages: [],
  }
  const integrityHash = "e".repeat(64)
  const integrity = {
    version: 1,
    operation_id: receipt.operation_id,
    intended_hash: integrityHash,
    page_id: next.page_id,
    marker: {
      version: 2,
      operation_id: receipt.operation_id,
      intended_hash: integrityHash,
      state: "committed",
      revision: "1".repeat(64),
      manifest_hash: "2".repeat(64),
      ownership_hash: "3".repeat(64),
    },
  }
  const oldTarget = { page_id: binding.page_id, publisher_subscription_id: subscription }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* sqliteState(root, yield* FileSystem.FileSystem)
          const state = opened.upstream
          yield* state.savePlan(plan)
          yield* state.saveOperation(operation)
          yield* state.advance(binding, 0, subscription, operation)
          yield* state.advance({ ...other, generation: 1 }, 0, subscription, {
            ...operation,
            items: [{ member_key: other.member_key, status: "verified", page_id: other.page_id }],
          })
          yield* state.setMode(other, 1)
          yield* opened.run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`INSERT INTO publications(id,operation,state,scope,page_id,payload) VALUES(${receipt.operation_id},${receipt.operation},${receipt.state},${null},${receipt.page_id},${JSON.stringify(receipt)})`,
            ),
          )
          yield* opened.run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql`INSERT INTO integrity_operations(operation_id,publication_operation_id,intended_hash,state,page_id,payload) VALUES(${integrity.operation_id},${integrity.operation_id},${integrity.intended_hash},${integrity.marker.state},${integrity.page_id},${JSON.stringify(integrity)})`,
            ),
          )
          const drifted = yield* state
            .commitRebuild(
              { ...next, page_id: "other-page" },
              binding,
              oldTarget,
              subscription,
              receipt.operation_id,
              "alpha",
            )
            .pipe(Effect.result)
          expect(drifted._tag).toBe("Failure")
          expect(yield* state.bindings(subscription)).toEqual([binding, other])
          expect(yield* state.target(binding.target_key)).toEqual(oldTarget)
          yield* state.commitRebuild(
            next,
            binding,
            oldTarget,
            subscription,
            receipt.operation_id,
            "alpha",
          )
          yield* state.commitRebuild(
            next,
            binding,
            oldTarget,
            subscription,
            receipt.operation_id,
            "alpha",
          )
          expect(yield* state.bindings(subscription)).toEqual([next, other])
          expect(yield* state.target(next.target_key)).toEqual({
            page_id: next.page_id,
            publisher_subscription_id: subscription,
          })
          expect(yield* state.command(`materialized:${next.target_key}`)).toEqual({
            portable: next.materialized,
            content_hash: next.published_hash,
            revision: next.revision,
          })
          const stale = yield* state
            .commitRebuild(
              { ...next, generation: 3, page_id: "third" },
              binding,
              oldTarget,
              subscription,
              receipt.operation_id,
              "alpha",
            )
            .pipe(Effect.result)
          expect(stale._tag).toBe("Failure")
          expect(
            (yield* state.bindings(subscription)).find(
              (item) => item.member_key === next.member_key,
            ),
          ).toEqual(next)
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
