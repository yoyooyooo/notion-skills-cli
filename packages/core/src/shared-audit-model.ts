import { Schema } from "effect"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

export const AUDIT_RULES_VERSION = "resource-audit-v3"
export const READABLE_AUDIT_RULES = ["resource-audit-v1", "resource-audit-v2"] as const
export const AuditDepthSchema = Schema.Literals(["metadata", "content", "history"])
export type AuditDepth = typeof AuditDepthSchema.Type
export const AuditCoverageSchema = Schema.Literals(["full", "partial", "permission_limited"])
export type AuditCoverage = typeof AuditCoverageSchema.Type
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const AuditRunIdSchema = Schema.String.check(Schema.isPattern(/^audit-[a-f0-9-]{36}$/u))
export const AuditSelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("library") }),
  Schema.Struct({ kind: Schema.Literal("census") }),
  Schema.Struct({ kind: Schema.Literal("skill"), page_id: Schema.String }),
])
export type AuditSelector = typeof AuditSelectorSchema.Type

export const AuditFindingSchema = Schema.Struct({
  key: Schema.String,
  code: Schema.String,
  severity: Schema.Literals(["error", "warning", "info"]),
  object_id: Schema.String,
  scope_key: Schema.String,
  location: Schema.String,
  message: Schema.String,
  evidence: Schema.Unknown,
  coverage: AuditCoverageSchema,
})
export type AuditFinding = typeof AuditFindingSchema.Type

/** Stable across observation times and message wording; locations include the
 * exact path/reference/record identity, never a display title. */
export function auditFinding(input: Omit<AuditFinding, "key">): AuditFinding {
  return {
    ...input,
    key: canonicalSharedJson([input.code, input.scope_key, input.object_id, input.location]),
  }
}

export const AuditTreeFileSchema = Schema.Struct({
  path: Schema.String,
  file_id: Schema.NullOr(Schema.String),
  page_id: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["native", "fixed_source", "resource"]),
  bytes: Schema.NullOr(Count),
  sha256: Schema.NullOr(Hash),
  byte_status: Schema.Literals(["unobserved", "verified", "unavailable"]),
  remote_status: Schema.Literals(["unobserved", "verified", "unavailable", "cached_available"]),
  cached_available: Schema.NullOr(Schema.Boolean),
  ownership: Schema.Unknown,
})
export type AuditTreeFile = typeof AuditTreeFileSchema.Type
export const AuditHistoryObjectSchema = Schema.Struct({
  object_id: Schema.String,
  owner_page_id: Schema.String,
  kind: Schema.String,
  cached_available: Schema.NullOr(Schema.Boolean),
  remote_status: Schema.Literals(["verified", "unavailable", "unverified"]),
  sha256: Schema.NullOr(Hash),
  bytes: Schema.NullOr(Count),
  retained_by: Schema.Array(Schema.String),
})
export type AuditHistoryObject = typeof AuditHistoryObjectSchema.Type
export const AuditItemSchema = Schema.Struct({
  scope_key: Schema.String,
  page_id: Schema.String,
  skill_id: Schema.NullOr(Schema.String),
  signature: Hash,
  checked_at: Schema.Number,
  observed_from: Schema.Number,
  coverage: AuditCoverageSchema,
  findings: Schema.Array(AuditFindingSchema),
  tree: Schema.Array(AuditTreeFileSchema),
  history: Schema.Array(AuditHistoryObjectSchema),
  requires: Schema.Array(Schema.String),
  state: Schema.Unknown,
  reused_from: Schema.NullOr(Schema.String),
})
export type AuditItem = typeof AuditItemSchema.Type

const AuditOwnerStatusSchema = Schema.Literals([
  "full",
  "partial",
  "permission_limited",
  "unobserved",
  "not_configured",
])
export const AuditDirectFindingSchema = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["error", "warning", "info"]),
  object_id: Schema.String,
  location: Schema.String,
  message: Schema.String,
  evidence: Schema.Unknown,
  coverage: AuditCoverageSchema,
})
export type AuditDirectFinding = typeof AuditDirectFindingSchema.Type
export const AuditInventoryScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("library") }),
  Schema.Struct({
    kind: Schema.Literal("reachable"),
    root_page_id: Schema.String,
    dependencies: Schema.Array(Schema.String),
    owner_coverage: Schema.Array(
      Schema.Struct({
        owner_page_id: Schema.String,
        files: AuditOwnerStatusSchema,
        records: AuditOwnerStatusSchema,
        sources: AuditOwnerStatusSchema,
      }),
    ),
    direct_findings: Schema.Array(AuditDirectFindingSchema),
  }),
])
export type AuditInventoryScope = typeof AuditInventoryScopeSchema.Type
export const AuditInventorySchema = Schema.Struct({
  skills: Schema.Array(Schema.Unknown),
  files: Schema.Array(Schema.Unknown),
  records: Schema.Array(Schema.Unknown),
  sources: Schema.Array(Schema.Unknown),
  complete: Schema.Array(Schema.Literals(["skills", "files", "records", "sources"])),
  scope: Schema.optional(AuditInventoryScopeSchema),
})
export type AuditInventory = typeof AuditInventorySchema.Type
export type AuditTable = "skills" | "files" | "records" | "sources"
export const AuditTaskSchema = Schema.Union([
  Schema.Struct({ key: Schema.String, kind: Schema.Literal("library") }),
  Schema.Struct({ key: Schema.String, kind: Schema.Literal("identity") }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal("inventory"),
    table: Schema.Literals(["skills", "files", "records", "sources"]),
    phase: Schema.Literals(["initial", "final"]),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal("reachable"),
    phase: Schema.Literals(["initial", "final"]),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal("skill"),
    page_id: Schema.String,
  }),
  Schema.Struct({ key: Schema.String, kind: Schema.Literal("plan") }),
  Schema.Struct({ key: Schema.String, kind: Schema.Literal("graph") }),
  Schema.Struct({ key: Schema.String, kind: Schema.Literal("finish") }),
])
export type AuditTask = typeof AuditTaskSchema.Type
const ObservationSchema = Schema.Struct({
  task_key: Schema.String,
  path: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  observed_at: Schema.Number,
  response_sha256: Hash,
  value: Schema.Unknown,
})
export const AuditTotalsSchema = Schema.Struct({
  attempts: Count,
  request_bytes: Count,
  response_bytes: Count,
  elapsed_ms: Schema.Number,
  invocations: Count,
  confirmed_requests: Count,
  replayed_requests: Count,
})
export const AuditRunSchema = Schema.Struct({
  version: Schema.Literal(1),
  rules_version: Schema.String,
  run_id: AuditRunIdSchema,
  entry_id: Schema.String,
  credential_scope: Hash,
  endpoint_scope: Schema.optional(Hash),
  permission_scope: Schema.NullOr(Hash),
  library: Schema.NullOr(SharedLibrarySchema),
  selector: AuditSelectorSchema,
  depth: AuditDepthSchema,
  pin_id: Schema.NullOr(Schema.String),
  graph_id: Schema.NullOr(Schema.String),
  graph_result: Schema.Unknown,
  graph_findings: Schema.Array(AuditFindingSchema),
  graph_history: Schema.Array(AuditHistoryObjectSchema),
  incremental: Schema.Boolean,
  recheck_after_ms: Count,
  retain_runs: Count,
  execution: Schema.Literals(["running", "completed", "paused", "execution_failed"]),
  pause_reason: Schema.NullOr(Schema.String),
  started_at: Schema.Number,
  updated_at: Schema.Number,
  tasks: Schema.Array(AuditTaskSchema),
  completed_tasks: Schema.Array(Schema.String),
  observations: Schema.Record(Schema.String, ObservationSchema),
  inventory: AuditInventorySchema,
  census: AuditInventorySchema,
  items: Schema.Array(AuditItemSchema),
  findings: Schema.Array(AuditFindingSchema),
  totals: AuditTotalsSchema,
  invocation_open: Schema.Boolean,
  unclean_invocations: Count,
  last_budget: Schema.Unknown,
  baseline_run_id: Schema.NullOr(AuditRunIdSchema),
  validation_round: Count,
})
export type AuditRun = typeof AuditRunSchema.Type
export const AuditCheckpointSchema = Schema.Struct({
  sha256: Hash,
  run: AuditRunSchema,
})

export const emptyAuditInventory = (): AuditInventory => ({
  skills: [],
  files: [],
  records: [],
  sources: [],
  complete: [],
})

export function auditCoverage(values: readonly AuditCoverage[]): AuditCoverage {
  return values.includes("permission_limited")
    ? "permission_limited"
    : values.includes("partial")
      ? "partial"
      : "full"
}

/** Alternating due/changed lanes prevents a continuous changed prefix from
 * starving an older item. Stable page IDs break ties deterministically. */
export function fairAuditOrder(
  entries: readonly {
    readonly page_id: string
    readonly changed: boolean
    readonly checked_at: number
  }[],
): readonly string[] {
  const order = (a: (typeof entries)[number], b: (typeof entries)[number]) =>
    a.checked_at - b.checked_at || a.page_id.localeCompare(b.page_id)
  const changed = entries.filter((entry) => entry.changed).sort(order)
  const due = [...entries].sort(order)
  const output = new Set<string>()
  for (let i = 0; i < Math.max(changed.length, due.length); i++) {
    const oldest = due[i]
    const fresh = changed[i]
    if (oldest !== undefined) output.add(oldest.page_id)
    if (fresh !== undefined) output.add(fresh.page_id)
  }
  return [...output]
}

const requiredAuditTables = (run: AuditRun): readonly AuditTable[] =>
  run.library?.sources === undefined
    ? ["skills", "files", "records"]
    : ["skills", "files", "records", "sources"]

export function auditTablesComplete(run: AuditRun, inventory: AuditInventory) {
  return requiredAuditTables(run).every((table) => inventory.complete.includes(table))
}

/** Reachable owner queries never fill `complete`. That array remains an
 * unfiltered table census only. */
export function auditReachableReady(inventory: AuditInventory) {
  const scope = inventory.scope
  if (scope?.kind !== "reachable") return false
  const root = scope.owner_coverage.find((row) => row.owner_page_id === scope.root_page_id)
  if (root === undefined) return false
  return (
    root.files === "full" &&
    root.records === "full" &&
    (root.sources === "full" || root.sources === "not_configured")
  )
}

export function auditReport(run: AuditRun, previous?: AuditRun) {
  const complete = (inventory: AuditInventory) => auditTablesComplete(run, inventory)
  const scopedTarget = run.inventory.scope?.kind === "reachable"
  const forwardReady =
    run.selector.kind === "skill" && scopedTarget
      ? auditReachableReady(run.inventory) && auditReachableReady(run.census)
      : complete(run.inventory) && complete(run.census)
  const inspectionScope =
    run.selector.kind === "census"
      ? ("registered_table_census" as const)
      : scopedTarget
        ? ("reachable_target" as const)
        : run.inventory.scope?.kind === "library"
          ? ("registered_library" as const)
          : run.selector.kind === "skill"
            ? ("historical_full_table_scan" as const)
            : ("registered_library" as const)
  const reverseComplete = complete(run.inventory) && complete(run.census)
  const findings = [
    ...new Map(
      [...run.findings, ...run.graph_findings, ...run.items.flatMap((item) => item.findings)].map(
        (finding) => [finding.key, finding],
      ),
    ).values(),
  ].sort((a, b) => a.key.localeCompare(b.key))
  const comparable =
    previous?.rules_version === run.rules_version &&
    previous.permission_scope === run.permission_scope &&
    canonicalSharedJson(previous.selector) === canonicalSharedJson(run.selector) &&
    previous.depth === run.depth &&
    previous.pin_id === run.pin_id &&
    previous.graph_id === run.graph_id
  const before = new Map(
    (comparable
      ? [
          ...previous.findings,
          ...previous.graph_findings,
          ...previous.items.flatMap((item) => item.findings),
        ]
      : []
    ).map((finding) => [finding.key, finding]),
  )
  const current = new Set(findings.map((finding) => finding.key))
  const checkedScopes = new Set(
    run.items.filter((item) => item.coverage === "full").map((item) => item.scope_key),
  )
  if (
    (scopedTarget ? auditReachableReady(run.census) : complete(run.census)) &&
    run.findings.every(
      (finding) => finding.scope_key !== "inventory" || finding.coverage === "full",
    )
  )
    checkedScopes.add("inventory")
  if (
    run.graph_id !== null &&
    run.graph_result !== null &&
    run.graph_findings.every((finding) => finding.coverage === "full")
  )
    checkedScopes.add(`graph:${run.graph_id}`)
  const coverage = auditCoverage([
    run.execution === "completed" && forwardReady ? "full" : "partial",
    ...findings.map((finding) => finding.coverage),
    ...run.items.map((item) => item.coverage),
  ])
  const changed = findings.map((finding) => ({
    ...finding,
    status: before.has(finding.key) ? ("persistent" as const) : ("added" as const),
  }))
  const recovered = [...before.values()]
    .filter((finding) => !current.has(finding.key) && checkedScopes.has(finding.scope_key))
    .map((finding) => ({ ...finding, status: "recovered" as const }))
  const severity = { error: 0, warning: 0, info: 0 }
  for (const finding of findings) severity[finding.severity] += 1
  return {
    report_version: 1 as const,
    rules_version: run.rules_version,
    run_id: run.run_id,
    library_id: run.library?.library_id ?? null,
    entry_id: run.entry_id,
    permission_scope: run.permission_scope,
    endpoint_scope: run.endpoint_scope ?? null,
    selector: run.selector,
    depth: run.depth,
    inspection_scope: inspectionScope,
    skill_states: run.selector.kind === "census" ? ("unobserved" as const) : ("observed" as const),
    reverse_table_completeness: scopedTarget
      ? ("unobserved" as const)
      : reverseComplete
        ? ("complete" as const)
        : ("partial" as const),
    ownership_coverage:
      run.inventory.scope?.kind === "reachable" ? run.inventory.scope.owner_coverage : null,
    pin_id: run.pin_id,
    graph: { graph_id: run.graph_id, result: run.graph_result, history: run.graph_history },
    execution: run.execution,
    pause_reason: run.pause_reason,
    coverage,
    severity,
    summary: `${run.execution}: ${run.items.length} Skill(s), ${findings.length} finding(s), ${coverage} coverage.`,
    observation_interval: {
      from: Math.min(run.started_at, ...run.items.map((item) => item.observed_from)),
      to: run.updated_at,
      atomic_snapshot: false as const,
    },
    inventory: {
      skills: run.inventory.skills.length,
      files: run.inventory.files.length,
      record_headers: run.inventory.records.length,
      sources: run.inventory.sources.length,
      reverse_tables: run.inventory.complete,
      final_census_tables: run.census.complete,
      library_conflict_claim: reverseComplete
        ? ("complete_census" as const)
        : ("not_claimed" as const),
    },
    items: run.items,
    findings: changed,
    recovered,
    remaining_tasks: run.tasks,
    completed_tasks: run.completed_tasks.length,
    request_totals: run.totals,
    request_accounting: {
      cumulative_precision:
        run.invocation_open || run.unclean_invocations > 0
          ? ("lower_bound" as const)
          : ("exact" as const),
      unfinalized_invocation: run.invocation_open,
      unclean_invocations: run.unclean_invocations,
      scope: "finalized_invocations" as const,
      note: "A killed process may have uncheckpointed in-flight attempts; confirmed read outcomes remain durable.",
    },
    progress: {
      confirmed_read_outcomes: run.totals.confirmed_requests,
      confirmed_source_files: Object.values(run.observations).filter((observation) =>
        observation.path.startsWith("audit-source-bytes:"),
      ).length,
    },
    last_budget: run.last_budget,
    retention: {
      private_session_references: "not_globally_enumerable" as const,
      global_gc_safe: false as const,
      history_limit: run.retain_runs,
      live_library_state: "not_claimed" as const,
      remote_gc: "not_performed" as const,
    },
    historical_comparison: comparable
      ? ("available" as const)
      : ("no_comparable_prior_inventory" as const),
    remote_writes: 0 as const,
  }
}
