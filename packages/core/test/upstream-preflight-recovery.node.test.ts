import { expect, test, vi } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, FileSystem } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authScope } from "../src/catalog.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store, StoreLive, sha256 } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import {
  applySubscriptionPreparation,
  planSubscriptionPreparation,
  type SubscriptionPreparationEvidence,
} from "../src/upstream-preflight-recovery.ts"

const db = "22222222-2222-4222-8222-222222222222"
const ds = "33333333-3333-4333-8333-333333333333"
const target = "44444444-4444-4444-8444-444444444444"
const operationId = "migration_add_original_preflight"
const sourceLines = [
  "function propertyIds(dataSourceId, values) {",
  "  return Effect12.gen(function* () {",
  "    const raw = yield* (yield* Notion).request(`v1/data_sources/${dataSourceId}`);",
  "    return values;",
  "  });",
  "}",
  "function addSubscription(input) {",
  "  return Effect12.gen(function* () {",
  '    yield* state.saveCommand(id, { ...evidence, input_hash: inputHash, state: "running" });',
  "    const mapped = yield* propertyIds(db.data_source_id, {",
  "      ...properties(input)",
  "    });",
  '    const result = yield* (yield* Notion).request("v1/pages", {',
  '      parent: { type: "data_source_id", data_source_id: db.data_source_id },',
  "      properties: mapped",
  "    }).pipe(Effect12.result);",
  "  });",
  "}",
]

test("explicit frozen GET evidence prepares only the original SQLite add and preserves its audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-preflight-recovery-"))
  vi.stubEnv("NTN_SKILLS_HOME", join(root, "state"))
  vi.stubEnv("NTN_SKILLS_CONFIG_HOME", join(root, "config"))
  vi.stubEnv("NTN_SKILLS_CACHE_HOME", join(root, "cache"))
  const requests: string[] = []
  const notion = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("preflight-fixture-credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        requests.push(`${options?.method ?? (body === undefined ? "GET" : "POST")} ${path}`)
        if (body !== undefined || (options?.method !== undefined && options.method !== "GET"))
          return yield* Effect.fail(
            fail("UNEXPECTED_WRITE", "Preparation must never mutate Notion."),
          )
        if (path === "v1/users/me") return { id: "preflight-fixture-user", object: "user" }
        if (path === `v1/databases/${db}`)
          return {
            id: db,
            database_type: "skills",
            title: [],
            data_sources: [{ id: ds, name: "fixture" }],
          }
        return yield* Effect.fail(fail("UNEXPECTED_REQUEST", path))
      }),
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          const fs = yield* FileSystem.FileSystem
          yield* store.writeJson("config.json", { upstream_database: db, sources: [] })
          yield* Effect.gen(function* () {
            const state = yield* UpstreamState
            const scope = yield* authScope
            // Keep the production input's ordering: schema decoding must not redefine its byte hash.
            const input = {
              name: "Original Source",
              description: "Frozen original input",
              target_database_id: target,
              source: { provider: { type: "git", url: "file:///unused", ref: "main" } },
              roots: ["skills"],
              include: [],
              exclude: [],
              mapping: {},
              enabled: true,
              default_context: false,
            }
            const original = {
              operation_id: operationId,
              domain: "subscription_add",
              scope,
              database_id: db,
              input,
              input_hash: yield* sha256(JSON.stringify(input)),
              state: "running",
            }
            yield* state.saveCommand(operationId, original)
            const receipt = {
              argv: [
                "sync",
                "upstream",
                "add",
                "--input",
                "original.json",
                "--operation",
                operationId,
              ],
              exit_code: 1,
              output: {
                ok: false,
                error: {
                  code: "NOTION_REQUEST_FAILED",
                  details: { path: `v1/data_sources/${ds}` },
                },
              },
            }
            const receiptText = JSON.stringify(receipt)
            const artifact = sourceLines.join("\n")
            const receiptPath = join(root, "original-receipt.json")
            const artifactPath = join(root, "frozen-cli.js")
            yield* fs.writeFileString(receiptPath, receiptText)
            yield* fs.writeFileString(artifactPath, artifact)
            const evidence: SubscriptionPreparationEvidence = {
              operation_id: operationId,
              scope,
              database_id: db,
              data_source_id: ds,
              target_database_id: target,
              source_config_hash: original.input_hash,
              preflight_path: `v1/data_sources/${ds}`,
              error_code: "NOTION_REQUEST_FAILED",
              receipt_path: receiptPath,
              receipt_sha256: yield* sha256(receiptText),
              frozen_artifact_path: artifactPath,
              frozen_artifact_sha256: yield* sha256(artifact),
              original_no_mutation: true,
              source_reference: {
                start_line: 9,
                end_line: 16,
                snippet: sourceLines.slice(8, 16).join("\n"),
              },
            }
            for (const invalid of [
              { ...evidence, receipt_sha256: "0".repeat(64) },
              { ...evidence, frozen_artifact_sha256: "0".repeat(64) },
              { ...evidence, source_config_hash: "0".repeat(64) },
              {
                ...evidence,
                source_reference: { ...evidence.source_reference, snippet: "unrelated source" },
              },
            ]) {
              expect((yield* planSubscriptionPreparation(invalid).pipe(Effect.result))._tag).toBe(
                "Failure",
              )
              expect(yield* state.command(operationId)).toEqual(original)
            }
            const wrongReceipt = JSON.stringify({
              ...receipt,
              output: {
                ok: false,
                error: { code: "NOTION_REQUEST_FAILED", details: { path: "v1/pages" } },
              },
            })
            yield* fs.writeFileString(receiptPath, wrongReceipt)
            expect(
              (yield* planSubscriptionPreparation({
                ...evidence,
                receipt_sha256: yield* sha256(wrongReceipt),
              }).pipe(Effect.result))._tag,
            ).toBe("Failure")
            yield* fs.writeFileString(receiptPath, receiptText)
            const plan = yield* planSubscriptionPreparation(evidence)
            expect(yield* state.command(operationId)).toEqual(original)
            expect(
              (yield* state.scopedCommands(scope, db)).map((command) => command.operation_id),
            ).toEqual([operationId])
            expect(
              (yield* applySubscriptionPreparation(operationId, "0".repeat(64)).pipe(Effect.result))
                ._tag,
            ).toBe("Failure")
            yield* fs.writeFileString(receiptPath, receiptText + "\n")
            expect(
              (yield* applySubscriptionPreparation(operationId, plan.plan_hash).pipe(Effect.result))
                ._tag,
            ).toBe("Failure")
            yield* fs.writeFileString(receiptPath, receiptText)
            yield* fs.writeFileString(artifactPath, artifact + "\n")
            expect(
              (yield* applySubscriptionPreparation(operationId, plan.plan_hash).pipe(Effect.result))
                ._tag,
            ).toBe("Failure")
            yield* fs.writeFileString(artifactPath, artifact)
            yield* state.saveCommand(operationId, { ...original, state: "unknown" })
            expect(
              (yield* applySubscriptionPreparation(operationId, plan.plan_hash).pipe(Effect.result))
                ._tag,
            ).toBe("Failure")
            yield* state.saveCommand(operationId, original)
            const applied = yield* applySubscriptionPreparation(operationId, plan.plan_hash)
            expect(applied).toEqual({
              operation_id: operationId,
              plan_hash: plan.plan_hash,
              state: "ready_for_original_add",
              remote_writes: 0,
            })
            const prepared = property(yield* state.command(operationId))
            expect(prepared.phase).toBe("preparing")
            expect(prepared.state).toBe("running")
            expect(prepared.intent).toBeUndefined()
            expect(property(prepared.preparation_recovery).original_command).toEqual(original)
            expect(property(prepared.preparation_recovery).plan_hash).toBe(plan.plan_hash)
            expect(yield* applySubscriptionPreparation(operationId, plan.plan_hash)).toEqual(
              applied,
            )
            expect(requests.length).toBeGreaterThan(0)
            expect(requests.every((request) => request.startsWith("GET "))).toBe(true)
          }).pipe(
            Effect.provideService(Notion, notion),
            Effect.provideService(UpstreamState, store.upstream),
          )
        }),
      ).pipe(
        Effect.provide(StoreLive),
        Effect.provide(NodeServices.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
