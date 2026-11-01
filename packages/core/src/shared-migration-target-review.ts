import type { MigrationBlocker } from "./shared-migration-blockers.ts"
import type { SharedMigrationInput } from "./shared-migration-plan.ts"
import type { analyzeMigrationReadiness } from "./shared-migration-readiness.ts"

type Plan = {
  readonly evidence: SharedMigrationInput
  readonly blockers: readonly MigrationBlocker[]
  readonly readiness: ReturnType<typeof analyzeMigrationReadiness>
}
type Entry = SharedMigrationInput["catalog"]["entries"][number]
const entryCodes = new Set<MigrationBlocker["code"]>([
  "CONTENT_KIND_UNSUPPORTED",
  "METADATA_INCOMPLETE",
  "FILE_INVENTORY_INCOMPLETE",
  "LEGACY_CLASSIFICATION_UNKNOWN",
  "FILE_TREE_INVALID",
])
const fileCodes = new Set<MigrationBlocker["code"]>([
  "FILE_IDENTITY_UNCERTAIN",
  "BODY_UNVERIFIED",
  "USER_EDIT_CANDIDATE",
  "FOLLOWING_SOURCE_UNRESOLVED",
  "FOLLOWING_PATH_MISSING",
  "FOLLOWING_BINDING_UNVERIFIED",
  "OWNERSHIP_CLASSIFICATION_CONFLICT",
  "PROJECTION_BASELINE_UNKNOWN",
])
const isolatedOperationCodes = new Set<MigrationBlocker["code"]>([
  "UNSETTLED_OPERATION",
  "REFERENCE_UNRESOLVED",
  "LEGACY_SOURCE_OPTIONS_UNSUPPORTED",
])
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function field(value: unknown, key: string): unknown {
  return object(value) ? value[key] : undefined
}
function physicalIds(entry: Entry) {
  const locator = field(entry.record, "locator")
  const values = [
    field(locator, "page_id"),
    field(locator, "subscription_id"),
    ...entry.files.map((file) => field(field(file.raw, "native_preimage"), "page_id")),
  ]
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) =>
      /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(
        value,
      )
        ? value.replace(/-/gu, "").toLowerCase()
        : value,
    )
}
function dependencies(input: SharedMigrationInput, target: string) {
  const ids = new Set([target]),
    pending = [target]
  const physical = input.catalog.entries.map((entry) => ({ entry, ids: physicalIds(entry) }))
  const add = (id: string) => {
    if (!ids.has(id)) {
      ids.add(id)
      pending.push(id)
    }
  }
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]
    for (const selected of physical.filter(({ entry }) => entry.legacy_id === current)) {
      // Aliases of the same physical page cannot establish independent objects.
      for (const other of physical)
        if (other.ids.some((id) => selected.ids.includes(id))) add(other.entry.legacy_id)
      if (field(selected.entry.record, "kind") === "router")
        for (const router of input.preservation.routers.items.filter(
          (item) => item.legacy_id === current,
        ))
          for (const member of router.references) add(member)
    }
  }
  return ids
}

/** Structural target dependencies for read-only review and the explicit v2
 * copy-to-new-pages boundary. This does not check approval or external receipts;
 * execution-capable callers must do both. The complete input, full plan readiness
 * and all original diagnostics remain unchanged. Unknown diagnostic ownership,
 * Source/preservation gaps and unknown operation impact are never inferred away. */
export function migrationTargetReviewBlockers(plan: Plan, target: string) {
  const required = dependencies(plan.evidence, target)
  const blocking = new Set<number>(),
    deferred: number[] = []
  for (const index of plan.readiness.global_blocker_indexes) {
    const blocker = plan.blockers[index]
    const owners =
      blocker === undefined
        ? []
        : plan.evidence.catalog.entries.filter(
            (entry) =>
              (entryCodes.has(blocker.code) && blocker.subject === entry.legacy_id) ||
              (fileCodes.has(blocker.code) &&
                entry.files.some(
                  (file) => blocker.subject === `${entry.legacy_id}:${file.legacy_id}`,
                )),
          )
    const owner = owners[0]
    // Exact generated subjects, not prefix parsing. Ambiguous colon-containing
    // identities or duplicate records retain the original conservative blocker.
    if (
      owners.length === 1 &&
      owner !== undefined &&
      owner.legacy_id !== "" &&
      field(owner.record, "id") === owner.legacy_id &&
      !required.has(owner.legacy_id)
    )
      deferred.push(index)
    else blocking.add(index)
  }
  for (const item of plan.readiness.items) {
    if (!required.has(item.legacy_id)) continue
    for (const index of item.local_blocker_indexes) {
      const blocker = plan.blockers[index]
      // Referenced objects acquire no write approval through dependency analysis.
      // The executing caller separately requires approval of the selected target.
      if (blocker?.code !== "SCOPE_NOT_FROZEN" || blocker.subject !== item.legacy_id)
        blocking.add(index)
    }
  }
  return {
    dependency_legacy_ids: [...required].sort(),
    blocking_indexes: [...blocking].sort((a, b) => a - b),
    deferred_indexes: deferred.sort((a, b) => a - b),
  }
}

/** Structural receipts can explain a read-only plan, but their booleans and
 * references are not external verification. Until the real receipt reader is
 * connected, execution-capable preparation must stop if readiness relies on one.
 * Decorative receipts for operations with no localized blocker do not unlock
 * anything and are not treated as evidence that creation depends on them. */
export function unverifiedMigrationIsolationReceipts(plan: Plan) {
  const global = new Set(plan.readiness.global_blocker_indexes)
  return (plan.evidence.readiness_evidence?.operations ?? []).flatMap((receipt) => {
    if (
      !plan.readiness.operations.some(
        (operation) =>
          operation.legacy_id === receipt.legacy_id &&
          operation.impact_scope === "declared_complete",
      )
    )
      return []
    const indexes = plan.blockers.flatMap((blocker, index) =>
      blocker.subject === `operations:${receipt.legacy_id}` &&
      isolatedOperationCodes.has(blocker.code) &&
      !global.has(index)
        ? [index]
        : [],
    )
    return indexes.length === 0
      ? []
      : [
          {
            operation_id: receipt.legacy_id,
            blocker_indexes: indexes,
            impact_receipt_ref: receipt.impact.receipt_ref,
            isolation_receipt_ref: receipt.isolation.receipt_ref,
            recovery: receipt.isolation.recovery,
          },
        ]
  })
}
