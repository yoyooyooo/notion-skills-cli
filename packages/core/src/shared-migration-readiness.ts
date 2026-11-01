import type { SharedMigrationInput } from "./shared-migration-plan.ts"
import type { MigrationBlocker } from "./shared-migration-blockers.ts"
import { inspectMigrationOperation } from "./shared-migration-operation.ts"

type Operation = SharedMigrationInput["preservation"]["operations"]["items"][number]
type Receipt = NonNullable<SharedMigrationInput["readiness_evidence"]>["operations"][number]

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compare)

/** Receipts bind every original field and the approved scope, never themselves. */
export function migrationReadinessBasis(input: SharedMigrationInput) {
  const basis = { ...input }
  delete basis.readiness_evidence
  return basis
}

function physicalIdentity(value: string) {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(
    value,
  )
    ? value.replace(/-/gu, "").toLowerCase()
    : value
}

/** Known original fields are a lower bound, not a reconstructed complete impact set. */
function knownImpact(input: SharedMigrationInput, operation: Operation): string[] {
  const physical = new Map<string, Set<string>>()
  for (const entry of input.catalog.entries) {
    const locator = object(object(entry.record).locator)
    for (const key of ["page_id", "subscription_id"]) {
      const value = locator[key]
      if (!text(value)) continue
      const identity = physicalIdentity(value)
      const ids = physical.get(identity) ?? new Set<string>()
      ids.add(entry.legacy_id)
      physical.set(identity, ids)
    }
  }
  const known = new Set(operation.references)
  const observe = (value: unknown) => {
    const raw = object(value)
    if (text(raw.record_identity)) known.add(raw.record_identity)
    for (const key of ["page_id", "subscription_id", "publisher_subscription_id"]) {
      const id = raw[key]
      if (text(id)) for (const legacy of physical.get(physicalIdentity(id)) ?? []) known.add(legacy)
    }
  }
  observe(operation.raw)
  observe(operation.operation_origin?.row_metadata)
  const raw = object(operation.raw)
  if (Array.isArray(raw.items)) for (const item of raw.items) observe(item)
  return sorted(known)
}

function assessOperation(
  input: SharedMigrationInput,
  rows: readonly Operation[],
  receipts: readonly Receipt[],
  basisMatches: boolean,
) {
  const row = rows[0]
  if (row === undefined) throw new Error("Operation assessment requires an observed original row")
  const issues: string[] = []
  const receipt = receipts.length === 1 ? receipts[0] : undefined
  const known = sorted(rows.flatMap((item) => knownImpact(input, item)))
  if (rows.length !== 1) issues.push("OPERATION_IDENTITY_AMBIGUOUS")
  if (!basisMatches) issues.push("READINESS_BASIS_UNVERIFIED")
  if (receipts.length !== 1)
    issues.push(receipts.length === 0 ? "OPERATION_RECEIPT_MISSING" : "OPERATION_RECEIPT_DUPLICATE")
  if (!row.complete) issues.push("OPERATION_EVIDENCE_INCOMPLETE")
  if (!row.retention_verified || !text(row.retention_ref))
    issues.push("OPERATION_RETENTION_UNVERIFIED")
  if (row.operation_origin === undefined || !inspectMigrationOperation(row).identity_verified)
    issues.push("OPERATION_ORIGIN_UNVERIFIED")
  if (receipt !== undefined) {
    if (!receipt.impact.complete || !text(receipt.impact.receipt_ref))
      issues.push("OPERATION_IMPACT_INCOMPLETE")
    if (
      receipt.impact.legacy_ids.some((id) => !text(id)) ||
      new Set(receipt.impact.legacy_ids).size !== receipt.impact.legacy_ids.length
    )
      issues.push("OPERATION_IMPACT_INVALID")
    const declared = new Set(receipt.impact.legacy_ids)
    if (known.some((id) => !declared.has(id))) issues.push("OPERATION_IMPACT_CONTRADICTS_ORIGINAL")
    if (!receipt.isolation.verified || !text(receipt.isolation.receipt_ref))
      issues.push("OPERATION_ISOLATION_UNVERIFIED")
    if (
      !text(receipt.isolation.recovery.reference) ||
      !["inspect_original", "reconcile_original"].includes(receipt.isolation.recovery.action)
    )
      issues.push("OPERATION_RECOVERY_UNSPECIFIED")
  }
  // These fields attest to a complete dependency closure in the supplied receipt.
  // Neither verified:true nor a reference proves the actual external receipt here.
  const scoped = issues.length === 0 && receipt !== undefined
  const impact = scoped ? sorted(receipt.impact.legacy_ids) : null
  const approved = sorted(input.approved_legacy_ids)
  return {
    legacy_id: row.legacy_id,
    impact_scope: scoped ? ("declared_complete" as const) : ("unknown" as const),
    known_legacy_ids: known,
    declared_impact_legacy_ids: impact,
    affected_approved_legacy_ids:
      impact === null ? approved : approved.filter((id) => impact.includes(id)),
    issues,
  }
}

/**
 * Structural analysis of supplied frozen evidence only; no writes, authorization,
 * completed migration or external receipt verification. An executor must verify
 * the real receipts and hashes before using any result. All v1 diagnostics stay.
 *
 * Only operation effects with complete bound isolation/recovery receipts are
 * localized. Other unresolved preservation/dependency diagnostics stay global;
 * neither opaque Metadata nor an unapproved record proves an independent graph.
 */
export function analyzeMigrationReadiness(
  input: SharedMigrationInput,
  blockers: readonly MigrationBlocker[],
  basisSha256: string,
) {
  const approved = new Set(input.approved_legacy_ids)
  const observed = new Set(input.catalog.entries.map((entry) => entry.legacy_id))
  const ids = sorted([...observed, ...approved])
  const local = new Map(ids.map((id) => [id, new Set<number>()]))
  const global = new Set<number>()
  const evidenceIssues: { code: string; subject: string }[] = []
  const evidence = input.readiness_evidence
  const basisMatches =
    evidence !== undefined &&
    /^[a-f0-9]{64}$/u.test(evidence.basis_sha256) &&
    evidence.basis_sha256 === basisSha256
  if (evidence !== undefined && !basisMatches)
    evidenceIssues.push({ code: "READINESS_BASIS_MISMATCH", subject: "readiness_evidence" })

  const rowsById = new Map<string, Operation[]>()
  for (const row of input.preservation.operations.items) {
    const rows = rowsById.get(row.legacy_id) ?? []
    rows.push(row)
    rowsById.set(row.legacy_id, rows)
  }
  const receiptsById = new Map<string, Receipt[]>()
  for (const receipt of evidence?.operations ?? []) {
    const receipts = receiptsById.get(receipt.legacy_id) ?? []
    receipts.push(receipt)
    receiptsById.set(receipt.legacy_id, receipts)
  }
  for (const [id, receipts] of receiptsById) {
    if (!rowsById.has(id))
      evidenceIssues.push({ code: "OPERATION_RECEIPT_UNOBSERVED", subject: id })
    if (receipts.length > 1)
      evidenceIssues.push({ code: "OPERATION_RECEIPT_DUPLICATE", subject: id })
  }
  const operations = [...rowsById]
    .sort(([a], [b]) => compare(a, b))
    .map(([id, rows]) => assessOperation(input, rows, receiptsById.get(id) ?? [], basisMatches))
  const bySubject = new Map(
    operations.map((operation) => [`operations:${operation.legacy_id}`, operation]),
  )
  for (const [index, blocker] of blockers.entries()) {
    if (
      blocker.code === "SCOPE_NOT_FROZEN" &&
      observed.has(blocker.subject) &&
      !approved.has(blocker.subject)
    ) {
      local.get(blocker.subject)?.add(index)
      continue
    }
    const operation = bySubject.get(blocker.subject)
    if (
      operation?.impact_scope === "declared_complete" &&
      ["UNSETTLED_OPERATION", "REFERENCE_UNRESOLVED", "LEGACY_SOURCE_OPTIONS_UNSUPPORTED"].includes(
        blocker.code,
      )
    ) {
      for (const id of operation.declared_impact_legacy_ids ?? []) local.get(id)?.add(index)
      continue
    }
    // Unknown or future diagnostic codes, inventory gaps and incomplete effects
    // cannot be waived by a receipt for a different operation.
    global.add(index)
  }
  evidenceIssues.sort((a, b) => compare(a.subject, b.subject) || compare(a.code, b.code))
  const items = ids.map((legacy_id) => ({
    legacy_id,
    observed: observed.has(legacy_id),
    approved: approved.has(legacy_id),
    evidence_ready:
      approved.has(legacy_id) &&
      observed.has(legacy_id) &&
      global.size === 0 &&
      evidenceIssues.length === 0 &&
      (local.get(legacy_id)?.size ?? 0) === 0,
    // Global indexes apply to every item in addition to these local indexes.
    local_blocker_indexes: [...(local.get(legacy_id) ?? [])].sort((a, b) => a - b),
  }))
  const ready = items.filter((item) => item.evidence_ready).map((item) => item.legacy_id)
  const blocked = items
    .filter((item) => item.approved && !item.evidence_ready)
    .map((item) => item.legacy_id)
  return {
    version: 1 as const,
    basis_sha256: basisSha256,
    meaning: "frozen_evidence_structure_only" as const,
    receipt_content_verified: false as const,
    apply_allowed: false as const,
    approved_batch: {
      legacy_ids: sorted(approved),
      evidence_ready: approved.size > 0 && blocked.length === 0,
      ready_legacy_ids: ready,
      blocked_legacy_ids: blocked,
    },
    global_blocker_indexes: [...global].sort((a, b) => a - b),
    evidence_issues: evidenceIssues,
    items,
    operations,
  }
}
