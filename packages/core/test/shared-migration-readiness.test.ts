import { test } from "bun:test"
import { deepEqual, equal, ok } from "node:assert/strict"
import { createHash } from "node:crypto"
import type { SharedMigrationInput } from "../src/shared-migration-plan.ts"
import type { MigrationBlocker } from "../src/shared-migration-blockers.ts"
import {
  analyzeMigrationReadiness,
  migrationReadinessBasis,
} from "../src/shared-migration-readiness.ts"

type Operation = SharedMigrationInput["preservation"]["operations"]["items"][number]
type Receipt = NonNullable<SharedMigrationInput["readiness_evidence"]>["operations"][number]
const sha = "a".repeat(64)
const A = "legacy-a",
  B = "legacy-b",
  OP = "original-batch"
const unsettled: MigrationBlocker = {
  code: "UNSETTLED_OPERATION",
  subject: `operations:${OP}`,
  message: "Retain and reconcile the original unknown",
}
const outside: MigrationBlocker = {
  code: "SCOPE_NOT_FROZEN",
  subject: B,
  message: "B is not selected",
}

function operation(): Operation {
  return {
    legacy_id: OP,
    complete: true,
    references: [B],
    retention_verified: true,
    retention_ref: "backup:fixture/original-row",
    terminal_verified: false,
    raw: {
      operation_id: OP,
      plan_id: "original-plan",
      subscription_id: "old-subscription-b",
      state: "unknown",
      items: [{ member_key: "original-member", status: "unknown", page_id: "page-b" }],
      retained_extra: { intent: "exact" },
    },
    operation_origin: {
      version: 1,
      table: "upstream_operations",
      row_key: OP,
      database_sha256: sha,
      payload_sha256: sha,
      payload_bytes: 99,
      verified: true,
      receipt_ref: "backup:fixture/origin-receipt",
      row_metadata: { operation_id: OP, plan_id: "original-plan", state: "unknown" },
    },
  }
}
function fixture(row = operation()): SharedMigrationInput {
  const empty = { complete: true, items: [] }
  return {
    version: 1,
    scope: "fixture-observation",
    target_library_id: "fixture-library",
    approved_legacy_ids: [A],
    backup: { verified: true, reference: "backup:fixture" },
    catalog: {
      coverage: {
        method: "explicit_database",
        exhaustive: true,
        queried_data_sources: ["fixture-ds"],
        failed_sources: [],
        search_index_limited: false,
      },
      entries: [A, B].map((id): SharedMigrationInput["catalog"]["entries"][number] => ({
        legacy_id: id,
        record: {
          id,
          kind: "skill",
          entrypoint: "SKILL.md",
          locator: {
            type: "notion_page",
            page_id: id === A ? "page-a" : "page-b",
            database_id: "fixture-db",
          },
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
      })),
    },
    preservation: {
      sources: empty,
      views: empty,
      routers: empty,
      pins: empty,
      operations: { complete: true, items: [row] },
    },
  }
}
// Independent canonicalization of JSON fixtures; the production planner uses canonicalSharedJson.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error("Fixture must contain only JSON values")
    return serialized
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}
const basis = (input: SharedMigrationInput) =>
  createHash("sha256")
    .update(canonical(migrationReadinessBasis(input)))
    .digest("hex")
function receipt(ids: readonly string[] = [B]): Receipt {
  return {
    legacy_id: OP,
    impact: { complete: true, legacy_ids: ids, receipt_ref: "evidence:fixture/complete-impact" },
    isolation: {
      verified: true,
      receipt_ref: "evidence:fixture/isolation",
      recovery: { action: "inspect_original", reference: "audit:fixture/original-operation" },
    },
  }
}
function withReceipts(
  input: SharedMigrationInput,
  receipts: readonly Receipt[] = [receipt()],
): SharedMigrationInput {
  return {
    ...input,
    readiness_evidence: { version: 1, basis_sha256: basis(input), operations: receipts },
  }
}
const analyze = (
  input: SharedMigrationInput,
  blockers: readonly MigrationBlocker[] = [unsettled, outside],
) => analyzeMigrationReadiness(input, blockers, basis(input))
function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error("Missing controlled fixture")
  return value
}

test("a complete retained disjoint unknown permits only approved evidence readiness and changes no original facts", () => {
  const input = withReceipts(fixture())
  const before = structuredClone(input),
    blockers = [unsettled, outside],
    beforeBlockers = structuredClone(blockers)
  const actual = analyze(input, blockers)
  deepEqual(actual.approved_batch, {
    legacy_ids: [A],
    evidence_ready: true,
    ready_legacy_ids: [A],
    blocked_legacy_ids: [],
  })
  deepEqual(actual.global_blocker_indexes, [])
  deepEqual(actual.items.find((item) => item.legacy_id === B)?.local_blocker_indexes, [0, 1])
  equal(actual.items.find((item) => item.legacy_id === B)?.evidence_ready, false)
  equal(actual.meaning, "frozen_evidence_structure_only")
  equal(actual.receipt_content_verified, false)
  equal(actual.apply_allowed, false)
  deepEqual(actual, analyze(input, blockers))
  deepEqual(input, before)
  deepEqual(blockers, beforeBlockers)
  equal(first(input.preservation.operations.items).terminal_verified, false)
})

test("a related unknown blocks its complete affected closure while an independent approved target remains structurally ready", () => {
  const input = withReceipts({ ...fixture(), approved_legacy_ids: [A, B] })
  const actual = analyze(input, [unsettled])
  equal(actual.approved_batch.evidence_ready, false)
  deepEqual(actual.approved_batch.ready_legacy_ids, [A])
  deepEqual(actual.approved_batch.blocked_legacy_ids, [B])
  const propagated = analyze(
    withReceipts({ ...fixture(), approved_legacy_ids: [A, B] }, [receipt([A, B])]),
    [unsettled],
  )
  deepEqual(propagated.approved_batch.ready_legacy_ids, [])
  deepEqual(propagated.approved_batch.blocked_legacy_ids, [A, B])
})

test("empty references, absent receipts and explicitly incomplete impact cannot establish disjointness", () => {
  const input = fixture({ ...operation(), references: [] })
  for (const candidate of [
    input,
    withReceipts(input, []),
    withReceipts(input, [{ ...receipt(), impact: { ...receipt().impact, complete: false } }]),
  ]) {
    const actual = analyze(candidate)
    deepEqual(actual.approved_batch.ready_legacy_ids, [])
    equal(first(actual.operations).impact_scope, "unknown")
    ok(actual.global_blocker_indexes.includes(0))
  }
})

test("declared impacts cannot omit original references, known page, subscription, publisher or batch item identities", () => {
  const original = operation(),
    raw = first(fixture().preservation.operations.items).raw
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid fixture raw")
  const variants: Operation[] = [
    { ...original, references: [A] },
    { ...original, raw: { ...raw, record_identity: A } },
    { ...original, raw: { ...raw, page_id: "page-a" } },
    { ...original, raw: { ...raw, subscription_id: "page-a" } },
    { ...original, raw: { ...raw, publisher_subscription_id: "page-a" } },
    {
      ...original,
      raw: { ...raw, items: [{ member_key: "member", status: "unknown", page_id: "page-a" }] },
    },
  ]
  for (const row of variants) {
    const actual = analyze(withReceipts(fixture(row)))
    deepEqual(actual.approved_batch.ready_legacy_ids, [])
    ok(first(actual.operations).issues.includes("OPERATION_IMPACT_CONTRADICTS_ORIGINAL"))
  }
})

test("subscription locators and canonical-equivalent Notion UUIDs remain known lower bounds", () => {
  const original = fixture(),
    firstEntry = first(original.catalog.entries),
    raw = first(original.preservation.operations.items).raw
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid fixture raw")
  const input: SharedMigrationInput = {
    ...original,
    catalog: {
      ...original.catalog,
      entries: [
        {
          ...firstEntry,
          record: {
            id: A,
            locator: {
              type: "notion_subscription",
              subscription_id: "12345678-1234-1234-1234-123456789abc",
            },
          },
        },
        ...original.catalog.entries.slice(1),
      ],
    },
    preservation: {
      ...original.preservation,
      operations: {
        complete: true,
        items: [
          { ...operation(), raw: { ...raw, subscription_id: "12345678123412341234123456789ABC" } },
        ],
      },
    },
  }
  const actual = analyze(withReceipts(input))
  deepEqual(actual.approved_batch.ready_legacy_ids, [])
  ok(first(actual.operations).known_legacy_ids.includes(A))
})

test("retention, original family provenance, complete references, impact and isolation recovery are all required", () => {
  const original = operation(),
    origin = original.operation_origin
  if (origin === undefined) throw new Error("Missing fixture origin")
  const withoutOrigin = { ...original }
  delete withoutOrigin.operation_origin
  const rows: Operation[] = [
    { ...original, complete: false },
    { ...original, retention_verified: false },
    { ...original, retention_ref: "" },
    withoutOrigin,
    { ...original, operation_origin: { ...origin, verified: false } },
    { ...original, operation_origin: { ...origin, payload_sha256: "invalid" } },
    { ...original, operation_origin: { ...origin, row_key: "another-original" } },
    {
      ...original,
      raw: { operation_id: OP, state: "verified", phase: "response_received", scope: "legacy" },
    },
  ]
  for (const row of rows)
    deepEqual(analyze(withReceipts(fixture(row))).approved_batch.ready_legacy_ids, [])
  const originalReceipt = receipt()
  const receipts: Receipt[] = [
    { ...originalReceipt, impact: { ...originalReceipt.impact, receipt_ref: "" } },
    { ...originalReceipt, impact: { ...originalReceipt.impact, legacy_ids: [B, B] } },
    { ...originalReceipt, impact: { ...originalReceipt.impact, legacy_ids: [B, ""] } },
    { ...originalReceipt, isolation: { ...originalReceipt.isolation, verified: false } },
    { ...originalReceipt, isolation: { ...originalReceipt.isolation, receipt_ref: "" } },
    {
      ...originalReceipt,
      isolation: {
        ...originalReceipt.isolation,
        recovery: { action: "reconcile_original", reference: " " },
      },
    },
  ]
  for (const item of receipts)
    deepEqual(analyze(withReceipts(fixture(), [item])).approved_batch.ready_legacy_ids, [])
})

test("receipts cannot be reused after raw, catalog, references or approval scope changes", () => {
  const input = withReceipts(fixture())
  const row = first(input.preservation.operations.items),
    entry = first(input.catalog.entries)
  const variants: SharedMigrationInput[] = [
    {
      ...input,
      preservation: {
        ...input.preservation,
        operations: {
          complete: true,
          items: [{ ...row, raw: { original: row.raw, changed: true } }],
        },
      },
    },
    {
      ...input,
      catalog: {
        ...input.catalog,
        entries: [{ ...entry, metadata: { changed: true } }, ...input.catalog.entries.slice(1)],
      },
    },
    {
      ...input,
      preservation: {
        ...input.preservation,
        operations: { complete: true, items: [{ ...row, references: [A] }] },
      },
    },
    { ...input, approved_legacy_ids: [A, B] },
  ]
  for (const candidate of variants) {
    const actual = analyze(candidate)
    deepEqual(actual.approved_batch.ready_legacy_ids, [])
    ok(actual.evidence_issues.some((issue) => issue.code === "READINESS_BASIS_MISMATCH"))
  }
  deepEqual(migrationReadinessBasis(input), fixture())
})

test("an operation isolation receipt cannot waive backup, catalog, inventory or other unresolved dependency diagnostics", () => {
  const input = withReceipts(fixture())
  const global: MigrationBlocker[] = [
    { code: "BACKUP_UNVERIFIED", subject: "backup", message: "Missing backup" },
    { code: "CATALOG_INCOMPLETE", subject: "catalog", message: "Missing catalog" },
    { code: "INVENTORY_INCOMPLETE", subject: "operations", message: "Missing operations" },
    { code: "METADATA_INCOMPLETE", subject: B, message: "Unknown member dependencies" },
    { code: "REFERENCE_UNRESOLVED", subject: "routers:router", message: "Unknown Router member" },
    {
      code: "BODY_UNVERIFIED",
      subject: `operations:${OP}`,
      message: "Unrecognized operation diagnostic is conservative",
    },
  ]
  for (const blocker of global) {
    const actual = analyze(input, [unsettled, outside, blocker])
    deepEqual(actual.approved_batch.ready_legacy_ids, [])
    deepEqual(actual.global_blocker_indexes, [2])
  }
})

test("duplicate and unobserved operation receipts never silently replace each other", () => {
  for (const receipts of [
    [receipt(), receipt()],
    [receipt(), { ...receipt(), legacy_id: "not-observed" }],
  ]) {
    const actual = analyze(withReceipts(fixture(), receipts))
    deepEqual(actual.approved_batch.ready_legacy_ids, [])
    ok(actual.evidence_issues.length > 0)
  }
  const input = fixture(),
    row = first(input.preservation.operations.items)
  const duplicate = withReceipts({
    ...input,
    preservation: { ...input.preservation, operations: { complete: true, items: [row, row] } },
  })
  const actual = analyze(duplicate)
  equal(first(actual.operations).impact_scope, "unknown")
  deepEqual(actual.approved_batch.ready_legacy_ids, [])
})

test("one isolated operation cannot waive another operation with an unknown impact", () => {
  const input = fixture(),
    other: Operation = { ...operation(), legacy_id: "another-original" }
  const candidate = withReceipts({
    ...input,
    preservation: {
      ...input.preservation,
      operations: { complete: true, items: [operation(), other] },
    },
  })
  const actual = analyze(candidate, [
    unsettled,
    outside,
    { ...unsettled, subject: "operations:another-original" },
  ])
  deepEqual(actual.approved_batch.ready_legacy_ids, [])
  deepEqual(actual.global_blocker_indexes, [2])
})

test("local verified remains an unsettled original without complete impact and recovery evidence", () => {
  const row = operation(),
    origin = row.operation_origin
  if (
    origin === undefined ||
    row.raw === null ||
    typeof row.raw !== "object" ||
    Array.isArray(row.raw)
  )
    throw new Error("Invalid fixture origin")
  const candidate = fixture({
    ...row,
    raw: { ...row.raw, state: "verified" },
    operation_origin: {
      ...origin,
      row_metadata: { operation_id: OP, plan_id: "original-plan", state: "verified" },
    },
  })
  const actual = analyze(candidate)
  deepEqual(actual.approved_batch.ready_legacy_ids, [])
  equal(first(candidate.preservation.operations.items).terminal_verified, false)
  equal(first(actual.operations).impact_scope, "unknown")
})

test("empty approval yields zero ready objects and is never a vacuously ready batch", () => {
  const input = withReceipts({ ...fixture(), approved_legacy_ids: [] })
  const actual = analyze(input, [unsettled, outside, { ...outside, subject: A }])
  equal(actual.approved_batch.evidence_ready, false)
  deepEqual(actual.approved_batch.legacy_ids, [])
  deepEqual(actual.approved_batch.ready_legacy_ids, [])
  ok(actual.items.every((item) => !item.approved && !item.evidence_ready))
  equal(actual.apply_allowed, false)
})
