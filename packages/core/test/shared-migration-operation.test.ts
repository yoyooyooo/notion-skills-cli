import { describe, expect, test } from "bun:test"
import {
  inspectMigrationOperation,
  type MigrationOperationOrigin,
  type MigrationOperationTable,
} from "../src/shared-migration-operation.ts"

const sha = "a".repeat(64)
function input(table: MigrationOperationTable, raw: Record<string, unknown>) {
  const row =
    table === "upstream_operations"
      ? { operation_id: raw.operation_id, plan_id: raw.plan_id, state: raw.state }
      : table === "integrity_operations"
        ? {
            operation_id: raw.operation_id,
            publication_operation_id: raw.operation_id,
            intended_hash: raw.intended_hash,
            state: "writing",
            page_id: raw.page_id ?? null,
          }
        : { operation_id: raw.operation_id }
  const origin: MigrationOperationOrigin = {
    version: 1,
    table,
    row_key: "fixture-operation",
    database_sha256: sha,
    payload_sha256: sha,
    payload_bytes: 100,
    row_metadata: row,
    verified: true,
    receipt_ref: "backup:fixture/operation-observation",
  }
  return {
    legacy_id: "fixture-operation",
    raw,
    retention_verified: true,
    retention_ref: "backup:fixture/row",
    operation_origin: origin,
  }
}
const fork = () => ({
  operation_id: "fixture-operation",
  domain: "upstream_fork",
  scope: "original-scope",
  database_id: "original-library",
  state: "verified",
  page_id: "original-skill",
  subscription_id: "original-subscription",
  member_key: "original/member",
  expected_version: "original-version",
  publication_required: true,
  baseline_operation_ids: ["original-baseline"],
  baseline_before_ids: [],
  publisher_subscription_id: "original-publisher",
  baseline: { unknown_original_field: true },
})
const batch = () => ({
  operation_id: "fixture-operation",
  plan_id: "original-plan",
  subscription_id: "original-subscription",
  state: "unknown",
  items: [
    {
      member_key: "original/member",
      status: "unknown",
      publication_operation_id: "original-publication",
    },
  ],
})
const integrity = () => ({
  version: 1,
  operation_id: "fixture-operation",
  intended_hash: sha,
  marker: { version: 2, operation_id: "fixture-operation", intended_hash: sha, state: "writing" },
})

describe("original migration operation families", () => {
  test("an original member command retains its genuinely absent optional phase", () => {
    const frozen = input("upstream_commands", fork()),
      before = structuredClone(frozen)
    expect(inspectMigrationOperation(frozen)).toEqual({
      identity_verified: true,
      local_state: "verified",
      state_field: "state",
      table: "upstream_commands",
    })
    expect(frozen).toEqual(before)
    expect("phase" in frozen.raw).toBe(false)
  })

  test("an upstream batch has a plan and item states, without inventing a command phase or optional scope", () => {
    const frozen = input("upstream_operations", batch())
    expect(inspectMigrationOperation(frozen).identity_verified).toBe(true)
    expect("phase" in frozen.raw).toBe(false)
    expect("scope" in frozen.raw).toBe(false)
    expect(
      inspectMigrationOperation({
        ...frozen,
        operation_origin: {
          ...frozen.operation_origin,
          row_metadata: {
            operation_id: "fixture-operation",
            plan_id: "another-plan",
            state: "unknown",
          },
        },
      }).identity_verified,
    ).toBe(false)
  })

  test("integrity state comes from its original marker and has no fabricated scope or top-level state", () => {
    const frozen = input("integrity_operations", integrity())
    expect(inspectMigrationOperation(frozen)).toEqual({
      identity_verified: true,
      local_state: "writing",
      state_field: "marker.state",
      table: "integrity_operations",
    })
    expect("state" in frozen.raw).toBe(false)
    expect("scope" in frozen.raw).toBe(false)
    expect(
      inspectMigrationOperation({
        ...frozen,
        raw: {
          ...frozen.raw,
          marker: {
            version: 2,
            operation_id: "another-operation",
            intended_hash: sha,
            state: "writing",
          },
        },
      }).identity_verified,
    ).toBe(false)
  })

  test("a committed local marker is identity evidence only and retains all original marker hashes", () => {
    const marker = {
      version: 2,
      operation_id: "fixture-operation",
      intended_hash: sha,
      state: "committed",
      revision: "b".repeat(64),
      manifest_hash: "c".repeat(64),
      ownership_hash: "d".repeat(64),
    }
    const frozen = input("integrity_operations", { ...integrity(), marker })
    const origin = {
      ...frozen.operation_origin,
      row_metadata: {
        operation_id: "fixture-operation",
        publication_operation_id: "fixture-operation",
        intended_hash: sha,
        state: "committed",
        page_id: null,
      },
    }
    expect(inspectMigrationOperation({ ...frozen, operation_origin: origin })).toEqual({
      identity_verified: true,
      local_state: "committed",
      state_field: "marker.state",
      table: "integrity_operations",
    })
    expect(
      inspectMigrationOperation({
        ...frozen,
        operation_origin: origin,
        raw: { ...frozen.raw, marker: { ...marker, revision: "missing-hash" } },
      }).identity_verified,
    ).toBe(false)
  })

  test("an asserted family without verified exact original provenance cannot remove uncertainty", () => {
    const frozen = input("upstream_commands", fork())
    for (const change of [
      { verified: false },
      { row_key: "another-operation" },
      { payload_sha256: "unverified" },
      { receipt_ref: "" },
      { payload_bytes: 0 },
    ])
      expect(
        inspectMigrationOperation({
          ...frozen,
          operation_origin: { ...frozen.operation_origin, ...change },
        }).identity_verified,
      ).toBe(false)
    expect(
      inspectMigrationOperation({ ...frozen, retention_verified: false }).identity_verified,
    ).toBe(false)
    expect(
      inspectMigrationOperation({
        ...frozen,
        operation_origin: { ...frozen.operation_origin, table: "integrity_operations" },
      }).identity_verified,
    ).toBe(false)
  })

  test("without source-table evidence the planner does not guess a family from nested fields", () => {
    expect(
      inspectMigrationOperation({ legacy_id: "fixture-operation", raw: integrity() })
        .identity_verified,
    ).toBe(false)
    expect(
      inspectMigrationOperation({ legacy_id: "fixture-operation", raw: batch() }).identity_verified,
    ).toBe(false)
    expect(
      inspectMigrationOperation({
        legacy_id: "fixture-operation",
        raw: {
          operation_id: "fixture-operation",
          scope: "original-scope",
          state: "pending",
          phase: "original-phase",
          extra: true,
        },
      }).identity_verified,
    ).toBe(true)
  })
})
