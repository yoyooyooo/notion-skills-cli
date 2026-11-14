import { property } from "./model.ts"
import {
  auditReport,
  type AuditFinding,
  type AuditRun,
  type AuditTreeFile,
} from "./shared-audit-model.ts"
import { auditField, auditRelationIds, auditRich, auditRowId } from "./shared-audit-inventory.ts"

const HELP = ["ntn-skills", "ctl", "audit", "run", "--help"] as const

export interface AuditNextStep {
  readonly state: string
  readonly argv: readonly string[]
  readonly read_only: true
  readonly reason: string
}

function recordHeader(raw: unknown, library: NonNullable<AuditRun["library"]>) {
  return {
    page_id: auditRowId(raw),
    record_id: auditRich(raw, library.records, "Record ID"),
    kind: String(property(auditField(raw, library.records, "Kind").select).name ?? ""),
    entity_id: auditRich(raw, library.records, "Entity ID"),
    hash: auditRich(raw, library.records, "Hash"),
    owners: auditRelationIds(raw, library.records, "Skill"),
  }
}

/** Header facts only. Payload bytes stay unread unless an explicit history
 * object already retained them. */
export function auditGrowthDiagnostic(run: AuditRun) {
  const library = run.library
  const items = run.items
  const active_files: Array<{
    owner_page_id: string
    path: string
    file_id: string | null
    page_id: string | null
  }> = []
  const tombstones: Array<{ owner_page_id: string; path: string | null; file_id: string | null }> =
    []
  const scripts: Array<{ owner_page_id: string; path: string; orphan: false }> = []
  for (const item of items) {
    for (const file of item.tree)
      classifyFile(file, item.page_id, active_files, tombstones, scripts)
    const retained = property(item.state).retained_files
    if (Array.isArray(retained))
      for (const value of retained) {
        const file = property(value)
        if (file.ownership !== "tombstone" || typeof file.file_id !== "string") continue
        if (
          !tombstones.some(
            (existing) =>
              existing.owner_page_id === item.page_id && existing.file_id === file.file_id,
          )
        )
          tombstones.push({
            owner_page_id: item.page_id,
            path: typeof file.path === "string" ? file.path : null,
            file_id: file.file_id,
          })
      }
  }
  const headers =
    library === null ? [] : run.inventory.records.map((raw) => recordHeader(raw, library))
  const operations = items.flatMap((item) =>
    operationHeaders(item.state).map((row) => ({ ...row, owner_page_id: item.page_id })),
  )
  const snapshots = [
    ...headers
      .filter((row) => row.kind === "snapshot")
      .map((row) => ({ ...row, payload: "header_only" as const })),
    ...items.flatMap((item) =>
      item.history
        .filter((object) => object.kind.startsWith("snapshot"))
        .map((object) => ({
          object_id: object.object_id,
          owner_page_id: object.owner_page_id,
          remote_status: object.remote_status,
          retained_by: object.retained_by,
        })),
    ),
  ]
  const byHash = new Map<string, Set<string>>()
  for (const row of headers) {
    if (!/^[a-f0-9]{64}$/u.test(row.hash)) continue
    const owners = byHash.get(row.hash) ?? new Set<string>()
    for (const owner of row.owners) owners.add(owner)
    byHash.set(row.hash, owners)
  }
  const crossOwnerGroups = [...byHash.values()].filter((owners) => owners.size > 1).length
  const bodyFacts = headers.filter((row) => row.kind === "object")
  const bounded = <A>(values: readonly A[]) => ({
    count: values.length,
    entries: values.slice(0, 100),
    details_complete: values.length <= 100,
  })
  return {
    depth: run.depth,
    payload_policy: "headers_only" as const,
    live_library_state: "not_claimed" as const,
    active_files: bounded(active_files),
    tombstones: bounded(tombstones),
    original_operations: bounded(operations),
    snapshots: bounded(snapshots),
    body_facts: bounded(bodyFacts.map((row) => ({ ...row, payload: "header_only" as const }))),
    known_retainers:
      run.depth === "history"
        ? [
            ...new Set(
              items.flatMap((item) => item.history.flatMap((object) => object.retained_by)),
            ),
          ].sort()
        : ("unobserved_until_history_depth" as const),
    private_pins: "unobserved" as const,
    scripts: bounded(scripts),
    script_classification: "unlinked_script_is_not_an_orphan" as const,
    cross_owner_equal_header_hash: {
      observed_groups: crossOwnerGroups,
      body_equality: "not_verified" as const,
      action: "no_cross_owner_merge" as const,
    },
    remote_gc: "not_performed" as const,
    deletion: "not_performed" as const,
    merge: "not_performed" as const,
    repair: "not_performed" as const,
  }
}

function classifyFile(
  file: AuditTreeFile,
  owner_page_id: string,
  active: Array<{
    owner_page_id: string
    path: string
    file_id: string | null
    page_id: string | null
  }>,
  tombstones: Array<{ owner_page_id: string; path: string | null; file_id: string | null }>,
  scripts: Array<{ owner_page_id: string; path: string; orphan: false }>,
) {
  const ownership = property(file.ownership).kind
  if (ownership === "tombstone")
    tombstones.push({ owner_page_id, path: file.path, file_id: file.file_id })
  else active.push({ owner_page_id, path: file.path, file_id: file.file_id, page_id: file.page_id })
  if (/\.(?:sh|bash|py|js|mjs|cjs)$/iu.test(file.path))
    scripts.push({ owner_page_id, path: file.path, orphan: false })
}

function operationHeaders(state: unknown) {
  const operations = property(state).operations
  if (!Array.isArray(operations)) return []
  return operations.flatMap((value) => {
    const row = property(value)
    return typeof row.record_id === "string"
      ? [
          {
            record_id: row.record_id,
            page_id: row.page_id ?? null,
            payload: "header_only" as const,
          },
        ]
      : []
  })
}

/** Structured read-only recommendations. Broader census is an optional alternative;
 * reporting the current run never expands its scope or executes a recommendation. */
export function auditNextSteps(
  run: AuditRun,
  findings: readonly Pick<AuditFinding, "code">[],
): readonly AuditNextStep[] {
  const steps: AuditNextStep[] = []
  const add = (state: string, argv: readonly string[], reason: string) => {
    if (steps.length >= 4 || steps.some((step) => step.state === state)) return
    if (argv.some((token) => !/^[A-Za-z0-9_.:@/-]+$/u.test(token))) return
    steps.push({ state, argv, read_only: true, reason })
  }
  if (run.execution === "paused")
    add(
      "audit_paused",
      ["ntn-skills", "ctl", "audit", "resume", run.run_id],
      "Continue this exact read-only run without changing its scope.",
    )
  if (
    findings.some((finding) =>
      ["MAIN_FILE_ID_INVALID", "SKILL_TREE_UNAVAILABLE", "TARGET_PAGE_UNAVAILABLE"].includes(
        finding.code,
      ),
    )
  )
    add(
      "diagnosed_target_needs_review",
      HELP,
      "Review the observed identity and scope before a separately authorized repair; this help does not write.",
    )
  if (findings.some((finding) => finding.code === "RECORD_DUPLICATE_COPY"))
    add(
      "record_headers_possible_equivalent",
      HELP,
      "Header equality does not prove equal full payloads or authorize cleanup.",
    )
  if (!steps.length)
    add(
      "inspect_retained_report",
      ["ntn-skills", "ctl", "audit", "report", run.run_id],
      "Inspect this same retained report offline; this does not refresh current state.",
    )
  if (run.inventory.scope?.kind === "reachable")
    add(
      "reverse_census_unobserved",
      ["ntn-skills", "ctl", "audit", "run", "--all", "--entry", run.entry_id],
      "Optional full reverse inventory can find owner relations missing from this target closure. This is a broader read, not an automatic next action.",
    )
  return steps
}

export function presentAuditReport(run: AuditRun, previous?: AuditRun) {
  const report = auditReport(run, previous)
  return {
    ...report,
    growth: auditGrowthDiagnostic(run),
    next: auditNextSteps(run, report.findings)[0] ?? null,
    alternatives: auditNextSteps(run, report.findings).slice(1),
  }
}
