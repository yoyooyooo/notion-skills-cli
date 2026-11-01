/** Planning diagnostics only. Classification never resolves or removes a blocker. */
const requirements = {
  DUPLICATE_SCOPE_ID: "correct_inventory",
  BACKUP_UNVERIFIED: "observe",
  CATALOG_INCOMPLETE: "observe",
  CATALOG_SCOPE_UNKNOWN: "observe",
  DUPLICATE_LEGACY_ID: "correct_inventory",
  APPROVED_ID_UNOBSERVED: "observe",
  INVENTORY_INCOMPLETE: "observe",
  DUPLICATE_OR_EMPTY_ID: "correct_inventory",
  PRESERVATION_INCOMPLETE: "observe",
  REFERENCE_UNRESOLVED: "observe",
  LEGACY_SOURCE_OPTIONS_UNSUPPORTED: "interpret",
  SOURCE_SEMANTICS_UNRESOLVED: "interpret",
  PIN_RETENTION_UNVERIFIED: "observe",
  OPERATION_IDENTITY_UNCERTAIN: "observe",
  UNSETTLED_OPERATION: "reconcile",
  SCOPE_NOT_FROZEN: "scope",
  LEGACY_IDENTITY_UNCERTAIN: "correct_inventory",
  CONTENT_KIND_UNSUPPORTED: "interpret",
  METADATA_INCOMPLETE: "observe",
  FILE_INVENTORY_INCOMPLETE: "observe",
  LEGACY_CLASSIFICATION_UNKNOWN: "review",
  FILE_TREE_INVALID: "correct_inventory",
  FILE_IDENTITY_UNCERTAIN: "observe",
  BODY_UNVERIFIED: "observe",
  USER_EDIT_CANDIDATE: "review",
  FOLLOWING_SOURCE_UNRESOLVED: "interpret",
  FOLLOWING_PATH_MISSING: "interpret",
  FOLLOWING_BINDING_UNVERIFIED: "observe",
  OWNERSHIP_CLASSIFICATION_CONFLICT: "review",
  PROJECTION_BASELINE_UNKNOWN: "observe",
} as const

export type MigrationBlockerCode = keyof typeof requirements
export type MigrationBlockerWork = (typeof requirements)[MigrationBlockerCode]
export type MigrationBlocker = {
  readonly code: MigrationBlockerCode
  readonly subject: string
  readonly message: string
}

const guidance: Record<MigrationBlockerWork, string> = {
  observe:
    "Collect or verify the missing original evidence with read-only inventory; retain failures and replan from the new frozen input.",
  scope:
    "Freeze the intended object scope explicitly; discovery counts do not approve migration or cleanup.",
  interpret:
    "Establish the exact legacy-to-target semantics, including fixed source layout and unsupported options; implement a missing mapping before replanning.",
  review:
    "Preserve the observed user candidate and resolve its provenance or ownership classification without inferring intent from a content diff.",
  reconcile:
    "Inspect the exact original operation and its terminal evidence; do not replay requests or infer completion from current matching values.",
  correct_inventory:
    "Resolve conflicting identities or invalid inventory paths from original evidence; keep every source row rather than dropping the conflicting item.",
}
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/** Small deterministic work index beside the complete unchanged item-level blockers. */
export function summarizeMigrationBlockers(blockers: readonly MigrationBlocker[]) {
  const byCode = new Map<MigrationBlockerCode, { count: number; subjects: Set<string> }>()
  const byWork = new Map<
    MigrationBlockerWork,
    { count: number; subjects: Set<string>; codes: Set<MigrationBlockerCode> }
  >()
  for (const blocker of blockers) {
    const code = byCode.get(blocker.code) ?? { count: 0, subjects: new Set<string>() }
    code.count++
    code.subjects.add(blocker.subject)
    byCode.set(blocker.code, code)
    const work = requirements[blocker.code]
    const group = byWork.get(work) ?? {
      count: 0,
      subjects: new Set<string>(),
      codes: new Set<MigrationBlockerCode>(),
    }
    group.count++
    group.subjects.add(blocker.subject)
    group.codes.add(blocker.code)
    byWork.set(work, group)
  }
  return {
    total: blockers.length,
    affected_subjects: new Set(blockers.map((blocker) => blocker.subject)).size,
    by_code: [...byCode]
      .sort(([left], [right]) => compare(left, right))
      .map(([code, value]) => ({
        code,
        count: value.count,
        affected_subjects: value.subjects.size,
        work: requirements[code],
      })),
    by_work: [...byWork]
      .sort(([left], [right]) => compare(left, right))
      .map(([work, value]) => ({
        work,
        count: value.count,
        affected_subjects: value.subjects.size,
        codes: [...value.codes].sort(compare),
        next_step: guidance[work],
      })),
  }
}
