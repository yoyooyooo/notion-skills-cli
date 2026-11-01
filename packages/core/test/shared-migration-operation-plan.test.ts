import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { planSharedMigration, type SharedMigrationInput } from "../src/shared-migration-plan.ts"

test("verified original integrity identity removes only the wrong envelope blocker and preserves unknown outcome and complete gates", async () => {
  const sha = "a".repeat(64)
  const raw = {
    version: 1,
    operation_id: "original-integrity",
    intended_hash: sha,
    marker: {
      version: 2,
      operation_id: "original-integrity",
      intended_hash: sha,
      state: "committed",
      revision: sha,
      manifest_hash: sha,
      ownership_hash: sha,
      creation: { exact_original_extra: "retained" },
    },
  }
  const empty = { complete: true, items: [] }
  const input: SharedMigrationInput = {
    version: 1,
    scope: "inventory-scope",
    target_library_id: "fixture-library",
    approved_legacy_ids: [],
    backup: { verified: true, reference: "backup:fixture" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: [],
        failed_sources: [],
        search_index_limited: false,
      },
      entries: [],
    },
    preservation: {
      sources: empty,
      views: empty,
      routers: empty,
      pins: empty,
      operations: {
        complete: false,
        items: [
          {
            legacy_id: "original-integrity",
            raw,
            complete: false,
            references: [],
            retention_verified: true,
            retention_ref: "backup:fixture/integrity-row",
            terminal_verified: false,
            operation_origin: {
              version: 1,
              table: "integrity_operations",
              row_key: "original-integrity",
              database_sha256: sha,
              payload_sha256: sha,
              payload_bytes: 100,
              verified: true,
              receipt_ref: "backup:fixture/verified-receipt",
              row_metadata: {
                operation_id: "original-integrity",
                publication_operation_id: "original-integrity",
                intended_hash: sha,
                state: "committed",
                page_id: null,
              },
            },
          },
        ],
      },
    },
  }
  const before = structuredClone(input)
  const actual = await Effect.runPromise(
    planSharedMigration(input).pipe(Effect.provide(NodeServices.layer)),
  )
  expect(input).toEqual(before)
  expect(actual.evidence).toEqual(before)
  expect(actual.blockers.map((blocker) => blocker.code).sort()).toEqual([
    "INVENTORY_INCOMPLETE",
    "PRESERVATION_INCOMPLETE",
    "UNSETTLED_OPERATION",
  ])
  expect(actual.preservation[0]?.disposition).toBe("retain_and_reconcile")
  expect(actual.preservation[0]?.operation).toEqual({
    operation_id: "original-integrity",
    scope: null,
    database_id: null,
    state: "committed",
    phase: null,
    table: "integrity_operations",
    identity_verified: true,
    state_field: "marker.state",
    automatic_replay: false,
  })
  expect(actual.apply_allowed).toBe(false)
  expect(actual.data_ready).toBe(false)
  expect(actual.blocker_summary.total).toBe(3)
})

function batchFixture(): SharedMigrationInput {
  const sha = "a".repeat(64),
    empty = { complete: true, items: [] }
  return {
    version: 1,
    scope: "fixture-observation",
    target_library_id: "fixture-library",
    approved_legacy_ids: ["legacy-a"],
    backup: { verified: true, reference: "backup:fixture" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: ["fixture-ds"],
        failed_sources: [],
        search_index_limited: false,
      },
      entries: ["legacy-a", "legacy-b"].map(
        (id): SharedMigrationInput["catalog"]["entries"][number] => ({
          legacy_id: id,
          record: {
            id,
            kind: "skill",
            entrypoint: "SKILL.md",
            locator: { type: "notion_page", page_id: id, database_id: "fixture-db" },
          },
          metadata: { name: id },
          metadata_complete: true,
          files_complete: true,
          legacy_mode: "native",
          legacy_layout: "ordinary_page",
          files: [
            {
              legacy_id: `${id}-file`,
              path: "SKILL.md",
              ownership: "native",
              body: {
                complete: true,
                sha256: sha,
                bytes: 3,
                retention_ref: `backup:fixture/${id}`,
                retention_verified: true,
              },
            },
          ],
        }),
      ),
    },
    preservation: {
      sources: empty,
      views: empty,
      routers: empty,
      pins: empty,
      operations: {
        complete: true,
        items: [
          {
            legacy_id: "original-batch",
            complete: true,
            references: ["legacy-b"],
            retention_verified: true,
            retention_ref: "backup:fixture/original-row",
            terminal_verified: false,
            raw: {
              operation_id: "original-batch",
              plan_id: "original-plan",
              subscription_id: "legacy-b",
              state: "unknown",
              items: [{ member_key: "member-b", page_id: "legacy-b", status: "unknown" }],
              exact_original_intent: { retained: true },
            },
            operation_origin: {
              version: 1,
              table: "upstream_operations",
              row_key: "original-batch",
              database_sha256: sha,
              payload_sha256: sha,
              payload_bytes: 100,
              verified: true,
              receipt_ref: "backup:fixture/verified-origin",
              row_metadata: {
                operation_id: "original-batch",
                plan_id: "original-plan",
                state: "unknown",
              },
            },
          },
        ],
      },
    },
  }
}
const migrationPlan = (input: unknown) =>
  Effect.runPromise(planSharedMigration(input).pipe(Effect.provide(NodeServices.layer)))
async function withIsolationEvidence(input: SharedMigrationInput): Promise<SharedMigrationInput> {
  const base = await migrationPlan(input)
  return {
    ...input,
    readiness_evidence: {
      version: 1,
      basis_sha256: base.readiness.basis_sha256,
      operations: [
        {
          legacy_id: "original-batch",
          impact: {
            complete: true,
            legacy_ids: ["legacy-b"],
            receipt_ref: "evidence:fixture/complete-impact",
          },
          isolation: {
            verified: true,
            receipt_ref: "evidence:fixture/isolation",
            recovery: { action: "inspect_original", reference: "audit:fixture/original-operation" },
          },
        },
      ],
    },
  }
}

test("approved independent batch readiness preserves the original full blocked plan, diagnostics, evidence and unauthorized state", async () => {
  const input = batchFixture(),
    original = await migrationPlan(input)
  const reviewed = await withIsolationEvidence(input),
    before = structuredClone(reviewed)
  const actual = await migrationPlan(reviewed)
  expect(actual.readiness.approved_batch).toEqual({
    legacy_ids: ["legacy-a"],
    evidence_ready: true,
    ready_legacy_ids: ["legacy-a"],
    blocked_legacy_ids: [],
  })
  expect(actual.readiness.receipt_content_verified).toBe(false)
  expect(actual.readiness.apply_allowed).toBe(false)
  expect(actual.status).toBe("blocked")
  expect(actual.data_ready).toBe(false)
  expect(actual.apply_allowed).toBe(false)
  expect(actual.production_authorization).toBe("not_requested_by_this_planner")
  expect(actual.blockers).toEqual(original.blockers)
  expect(actual.blocker_summary).toEqual(original.blocker_summary)
  expect(actual.stop_conditions).toEqual(original.stop_conditions)
  expect(actual.records).toEqual(original.records)
  expect(actual.preservation).toEqual(original.preservation)
  expect(actual.evidence).toEqual(before)
  expect(reviewed).toEqual(before)
  expect(actual.evidence.preservation.operations.items[0]?.terminal_verified).toBe(false)
  expect(actual.preservation[0]?.operation?.state).toBe("unknown")
  expect(actual.preservation[0]?.operation?.automatic_replay).toBe(false)
})

test("related unknown, incomplete inventory and empty approval retain their distinct conservative batch boundaries", async () => {
  const input = batchFixture()
  const related = await migrationPlan(
    await withIsolationEvidence({ ...input, approved_legacy_ids: ["legacy-a", "legacy-b"] }),
  )
  expect(related.readiness.approved_batch.evidence_ready).toBe(false)
  expect(related.readiness.approved_batch.ready_legacy_ids).toEqual(["legacy-a"])
  expect(related.readiness.approved_batch.blocked_legacy_ids).toEqual(["legacy-b"])
  expect(related.status).toBe("blocked")
  const incomplete = await migrationPlan(
    await withIsolationEvidence({
      ...input,
      preservation: {
        ...input.preservation,
        operations: { ...input.preservation.operations, complete: false },
      },
    }),
  )
  expect(incomplete.readiness.approved_batch.ready_legacy_ids).toEqual([])
  expect(incomplete.blockers.some((blocker) => blocker.code === "INVENTORY_INCOMPLETE")).toBe(true)
  const empty = await migrationPlan(
    await withIsolationEvidence({ ...input, approved_legacy_ids: [] }),
  )
  expect(empty.readiness.approved_batch.evidence_ready).toBe(false)
  expect(empty.readiness.approved_batch.ready_legacy_ids).toEqual([])
  expect(empty.apply_allowed).toBe(false)
})
