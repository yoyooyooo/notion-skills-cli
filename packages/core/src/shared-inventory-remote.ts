import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { decode, fail, property, SkillsError } from "./model.ts"
import {
  FileOwnershipSchema,
  isResourceFollowing,
  resourceContentForOwnership,
  nativeMetadataForOwnership,
  normalizeObservedBody,
} from "./shared-file-state.ts"
import { SharedFileSourceContextSchema } from "./shared-file-source-context-model.ts"
import { SharedGitSourceBindingSchema } from "./shared-source-binding-model.ts"
import { RetainedSourceSchema } from "./shared-retained-source.ts"
import { inspectSharedSourcePlan } from "./shared-source-plan.ts"
import { decodeSourceDefinition } from "./shared-source-definitions.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  auditReport,
  type AuditItem,
  type AuditRun,
  type AuditInventory,
  type AuditTable,
} from "./shared-audit-model.ts"
import { auditRelationIds, auditRowId, auditSemanticRow } from "./shared-audit-inventory.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { pageId } from "./ref.ts"
import { readAuditRun } from "./shared-audit-store.ts"
import { sha256, Store } from "./store.ts"
import { INVENTORY_RULES } from "./shared-inventory-model.ts"
import { readInventoryArtifact, saveInventoryArtifact } from "./shared-inventory-store.ts"

const SelectedSchema = Schema.Struct({
  kind: Schema.Literals(["git", "retained_bundle", "snapshot", "composition"]),
  source_id: Schema.String,
  revision: Schema.String,
  paths: Schema.Array(Schema.String),
  binding: Schema.Unknown,
})
const SourceFileSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  mode: Schema.optional(Schema.Literals(["100644", "100755"])),
})
export const BaselineFileSchema = Schema.Struct({
  file_id: Schema.NullOr(Schema.String),
  page_id: Schema.NullOr(Schema.String),
  path: Schema.String,
  ownership: Schema.Unknown,
  current_sha256: Schema.NullOr(Schema.String),
  current_bytes: Schema.NullOr(Schema.Number),
  current_mode: Schema.NullOr(Schema.Literals(["100644", "100755"])),
  source_identity: Schema.Unknown,
  comparison: Schema.Literals([
    "exact",
    "normalized_crlf_only",
    "recorded_projection_equal",
    "different",
    "not_in_source",
    "unobserved",
  ]),
  requires_decision: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
})
export const BaselineResourceSchema = Schema.Struct({
  page_id: Schema.String,
  skill_id: Schema.NullOr(Schema.String),
  classification: Schema.Literals([
    "pure_upstream",
    "custom",
    "retained_source",
    "unbound_source",
    "anomalous",
  ]),
  automatic_candidate: Schema.Boolean,
  source_context: Schema.Unknown,
  selected: Schema.Unknown,
  source_definition: Schema.Unknown,
  target_revision: Schema.NullOr(Schema.String),
  reasons: Schema.Array(Schema.String),
  files: Schema.Array(BaselineFileSchema),
  metadata: Schema.Unknown,
  metadata_sha256: Schema.String,
  ownership_sha256: Schema.String,
  content_sha256: Schema.String,
  recovery: Schema.Unknown,
})
const CensusHash = Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))
export const VisibleRegisteredCensusSchema = Schema.Struct({
  version: Schema.Literal(1),
  boundary: Schema.Literal("visible_registered_tables"),
  coverage: Schema.Literals(["full", "partial", "permission_limited"]),
  required_tables: Schema.Array(Schema.Literals(["skills", "files", "records", "sources"])),
  initial_complete: Schema.Boolean,
  final_complete: Schema.Boolean,
  relations_complete: Schema.Boolean,
  metadata_complete: Schema.Boolean,
  stable: Schema.Boolean,
  initial_semantic_sha256: CensusHash,
  final_semantic_sha256: CensusHash,
  endpoint_scope: CensusHash,
  permission_scope: CensusHash,
  reasons: Schema.Array(Schema.String),
})
export type VisibleRegisteredCensus = typeof VisibleRegisteredCensusSchema.Type
export const SharedBaselineInventorySchema = Schema.Struct({
  version: Schema.Literal(1),
  rules_version: Schema.Literal(INVENTORY_RULES),
  plan_id: Schema.String,
  audit_run_id: Schema.String,
  inspection_scope: Schema.optional(
    Schema.Literals([
      "reachable_target",
      "registered_table_census",
      "registered_library",
      "historical_full_table_scan",
    ]),
  ),
  library_id: Schema.String,
  entry_id: Schema.String,
  permission_scope: Schema.NullOr(Schema.String),
  visible_registered_census: Schema.optional(VisibleRegisteredCensusSchema),
  observation_interval: Schema.Unknown,
  coverage: Schema.Literals(["full", "partial", "permission_limited"]),
  native_census_sha256: Schema.String,
  resources: Schema.Array(BaselineResourceSchema),
  findings: Schema.Array(Schema.Unknown),
  counts: Schema.Struct({
    skills: Schema.Number,
    files: Schema.Number,
    record_headers: Schema.Number,
    source_definitions: Schema.Number,
    automatic_candidates: Schema.Number,
    require_decision: Schema.Number,
  }),
  action: Schema.Literal("review_only"),
  remote_writes: Schema.Literal(0),
  global_gc_safe: Schema.Literal(false),
})
export type SharedBaselineInventory = typeof SharedBaselineInventorySchema.Type
type SelectedFile = {
  readonly path: string
  readonly bytes: number
  readonly identity:
    | { readonly kind: "sha256"; readonly sha256: string }
    | { readonly kind: "git"; readonly git_oid: string; readonly sha256?: string }
  readonly mode?: "100644" | "100755"
}

/** A complete metadata census is independent of current-content health. It
 * proves only the registered rows visible under this exact recorded scope. */
function visibleRegisteredCensus(run: AuditRun, library: SharedLibrary) {
  return Effect.gen(function* () {
    const required: readonly AuditTable[] =
      library.sources === undefined
        ? ["skills", "files", "records"]
        : ["skills", "files", "records", "sources"]
    const complete = (inventory: AuditInventory) =>
      required.every((table) => inventory.complete.includes(table))
    const rows = (inventory: AuditInventory) => required.flatMap((table) => inventory[table])
    const relations = (inventory: AuditInventory) =>
      rows(inventory).every((raw) => {
        const errors = property(raw).audit_relation_errors
        if (Array.isArray(errors) && errors.length) return false
        return Object.values(property(property(raw).properties))
          .map(property)
          .filter((field) => field.type === "relation")
          .every(
            (field) =>
              field.has_more === false &&
              Array.isArray(field.relation) &&
              field.relation.every(
                (target) =>
                  typeof property(target).id === "string" &&
                  pageId(String(property(target).id)) !== undefined,
              ) &&
              new Set(field.relation.map((target) => pageId(String(property(target).id)))).size ===
                field.relation.length,
          )
      })
    const metadata = (inventory: AuditInventory) =>
      required.every((table) => {
        const binding = library[table]
        if (binding === undefined) return false
        if (new Set(inventory[table].map(auditRowId)).size !== inventory[table].length) return false
        return inventory[table].every((raw) => {
          const row = property(raw),
            parent = property(row.parent),
            fields = Object.values(property(row.properties)).map(property)
          return (
            row.object === "page" &&
            pageId(auditRowId(raw)) === auditRowId(raw) &&
            parent.type === "data_source_id" &&
            parent.data_source_id === binding.data_source_id &&
            Object.entries(binding.property_ids)
              .filter(([name]) => name !== "Payload")
              .every(
                ([, id]) =>
                  fields.filter((field) => field.id === id && typeof field.type === "string")
                    .length === 1,
              )
          )
        })
      })
    const digest = (inventory: AuditInventory) =>
      sha256(
        canonicalSharedJson({
          library,
          tables: Object.fromEntries(
            required.map((table) => [
              table,
              [...inventory[table]]
                .sort((left, right) => auditRowId(left).localeCompare(auditRowId(right)))
                .map(auditSemanticRow),
            ]),
          ),
        }),
      )
    const initial_complete = complete(run.inventory),
      final_complete = complete(run.census)
    const initial_semantic_sha256 = initial_complete ? yield* digest(run.inventory) : null
    const final_semantic_sha256 = final_complete ? yield* digest(run.census) : null
    const relations_complete =
      initial_complete && final_complete && relations(run.inventory) && relations(run.census)
    const metadata_complete =
      initial_complete && final_complete && metadata(run.inventory) && metadata(run.census)
    const stable =
      initial_semantic_sha256 !== null && initial_semantic_sha256 === final_semantic_sha256
    const reasons: string[] = []
    if (run.execution !== "completed") reasons.push("audit_not_completed")
    if (!initial_complete) reasons.push("initial_census_incomplete")
    if (!final_complete) reasons.push("final_census_incomplete")
    if (!relations_complete) reasons.push("relations_unobserved")
    if (!metadata_complete) reasons.push("registered_metadata_unobserved")
    if (!stable) reasons.push("census_not_stable")
    if (run.endpoint_scope === undefined) reasons.push("endpoint_identity_unestablished")
    if (run.permission_scope === null) reasons.push("permission_identity_unestablished")
    const permissionLimited = [...rows(run.inventory), ...rows(run.census)].some((row) => {
      const errors = property(row).audit_relation_errors
      return (
        Array.isArray(errors) &&
        errors.some((error) =>
          ["AUTH_REQUIRED", "ACCESS_DENIED", "NOT_FOUND"].includes(String(property(error).code)),
        )
      )
    })
    return {
      version: 1,
      boundary: "visible_registered_tables",
      coverage:
        reasons.length === 0 ? "full" : permissionLimited ? "permission_limited" : "partial",
      required_tables: required,
      initial_complete,
      final_complete,
      relations_complete,
      metadata_complete,
      stable,
      initial_semantic_sha256,
      final_semantic_sha256,
      endpoint_scope: run.endpoint_scope ?? null,
      permission_scope: run.permission_scope,
      reasons,
    } satisfies VisibleRegisteredCensus
  })
}
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVENTORY_EVIDENCE_INVALID", "The audit's exact source evidence is malformed."),
  })
function sourceManifest(selected: typeof SelectedSchema.Type): readonly SelectedFile[] {
  if (selected.kind === "git")
    return decode(SharedGitSourceBindingSchema, selected.binding).files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      identity: {
        kind: "git" as const,
        git_oid: file.git_oid,
        ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
      },
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    }))
  if (selected.kind === "composition")
    return inspectSharedSourcePlan(property(selected.binding).plan).manifest
  const raw =
    selected.kind === "retained_bundle"
      ? decode(RetainedSourceSchema, selected.binding).files
      : property(property(selected.binding).manifest).files
  return decode(Schema.Array(SourceFileSchema), raw).map((file) => ({
    path: file.path,
    bytes: file.bytes,
    identity: { kind: "sha256" as const, sha256: file.sha256 },
    ...(file.mode === undefined ? {} : { mode: file.mode }),
  }))
}

/** Offline review preparation from the formal audit's exact observation. No
 * provider, Notion, moving branch, name lookup or mutation is performed. */
export function prepareSharedBaselineInventory(auditRunId: string) {
  return Effect.gen(function* () {
    const run = yield* readAuditRun(auditRunId)
    if (run.library === null)
      return yield* Effect.fail(
        fail(
          "INVENTORY_AUDIT_INCOMPLETE",
          "The audit has not established an exact registered library.",
        ),
      )
    const library = run.library,
      report = auditReport(run),
      store = yield* Store
    const resources: SharedBaselineInventory["resources"][number][] = []
    const items = new Map(run.items.map((item) => [item.page_id, item]))
    const ids = [...new Set([...run.inventory.skills.map(auditRowId), ...items.keys()])].sort()
    for (const id of ids) {
      const item = items.get(id)
      const reasons: string[] = []
      if (run.execution !== "completed" || report.coverage !== "full")
        reasons.push("audit_coverage_incomplete")
      if (run.depth === "metadata") reasons.push("content_unobserved")
      if (item === undefined || item.coverage !== "full")
        reasons.push("resource_coverage_incomplete")
      const state = property(item?.state)
      const source =
        state.selected == null
          ? undefined
          : yield* checked(() => decode(SelectedSchema, state.selected)).pipe(Effect.result)
      const context =
        state.source_context == null
          ? undefined
          : yield* checked(() => decode(SharedFileSourceContextSchema, state.source_context)).pipe(
              Effect.result,
            )
      const selected = source?._tag === "Success" ? source.success : null
      const sourceContext = context?._tag === "Success" ? context.success : null
      if (selected === null) reasons.push("exact_selected_source_unavailable")
      if (sourceContext?.definition == null) reasons.push("source_definition_unbound")
      const origin = sourceContext?.definition?.page_id
      const definitionRaw =
        origin === undefined
          ? undefined
          : run.inventory.sources.find((row) => auditRowId(row) === origin)
      const definition =
        definitionRaw === undefined
          ? undefined
          : yield* checked(() => decodeSourceDefinition(library, definitionRaw)).pipe(Effect.result)
      if (
        origin !== undefined &&
        (definition?._tag !== "Success" ||
          definition.success.source_id !== sourceContext?.definition?.source_id)
      )
        reasons.push("source_definition_unverified")
      const manifest =
        selected === null
          ? undefined
          : yield* checked(() => sourceManifest(selected)).pipe(Effect.result)
      if (manifest?._tag === "Failure") reasons.push("source_manifest_unavailable")
      const files: SharedBaselineInventory["resources"][number]["files"][number][] = []
      let custom = false
      for (const file of item?.tree ?? []) {
        const own = property(file.ownership)
        const owner =
          own.kind === "fixed_source" || own.kind === "unknown"
            ? undefined
            : yield* checked(() => decode(FileOwnershipSchema, own)).pipe(Effect.result)
        const ownership = owner?._tag === "Success" ? owner.success : undefined
        const fileReasons: string[] = []
        if (ownership?.kind === "custom" || ownership?.kind === "tombstone") {
          custom = true
          fileReasons.push("custom_ownership_requires_explicit_decision")
        }
        if (own.kind === "unknown" || owner?._tag === "Failure")
          fileReasons.push("ownership_unobserved")
        const sourcePath =
          ownership !== undefined && isResourceFollowing(ownership)
            ? ownership.source_path
            : file.path
        const expected =
          manifest?._tag === "Success"
            ? manifest.success.find((entry) => entry.path === sourcePath)
            : undefined
        const currentMode =
          file.origin === "fixed_source" ||
          (ownership !== undefined && isResourceFollowing(ownership))
            ? (expected?.mode ?? null)
            : ownership === undefined
              ? null
              : (resourceContentForOwnership(ownership)?.mode ??
                nativeMetadataForOwnership(ownership).mode ??
                null)
        if (currentMode === null) fileReasons.push("mode_unestablished")
        else if (expected?.mode !== undefined && expected.mode !== currentMode)
          fileReasons.push("source_mode_different")
        let comparison: typeof BaselineFileSchema.Type.comparison =
          expected === undefined
            ? selected === null || manifest?._tag !== "Success"
              ? "unobserved"
              : "not_in_source"
            : "unobserved"
        if (expected !== undefined && file.byte_status === "verified" && file.sha256 !== null) {
          if (
            expected.identity.kind === "sha256" &&
            expected.identity.sha256 === file.sha256 &&
            expected.bytes === file.bytes
          )
            comparison = "exact"
          else {
            const current = yield* store.readBytes(`objects/${file.sha256}`).pipe(Effect.result)
            if (
              current._tag === "Success" &&
              current.success.length === file.bytes &&
              (yield* sha256(current.success)) === file.sha256
            ) {
              if (expected.identity.kind === "git")
                comparison =
                  current.success.length === expected.bytes &&
                  (expected.identity.sha256 === undefined ||
                    expected.identity.sha256 === file.sha256) &&
                  createHash("sha1")
                    .update(`blob ${current.success.length}\0`)
                    .update(current.success)
                    .digest("hex") === expected.identity.git_oid
                    ? "exact"
                    : "different"
              else {
                const upstream = yield* store
                  .readBytes(`objects/${expected.identity.sha256}`)
                  .pipe(Effect.result)
                if (
                  upstream._tag === "Success" &&
                  upstream.success.length === expected.bytes &&
                  (yield* sha256(upstream.success)) === expected.identity.sha256
                ) {
                  const normalized = yield* checked(
                    () =>
                      normalizeObservedBody(
                        new TextDecoder("utf-8", { fatal: true }).decode(upstream.success),
                      ) ===
                      normalizeObservedBody(
                        new TextDecoder("utf-8", { fatal: true }).decode(current.success),
                      ),
                  ).pipe(Effect.result)
                  comparison =
                    normalized._tag === "Success" && normalized.success
                      ? "normalized_crlf_only"
                      : "different"
                } else comparison = "different"
              }
            }
          }
          if (
            comparison !== "exact" &&
            ownership?.kind === "following" &&
            !isResourceFollowing(ownership) &&
            selected?.revision === ownership.source_revision &&
            ownership.projection.sha256 === file.sha256
          )
            comparison = "recorded_projection_equal"
        }
        if (["unobserved", "different", "not_in_source"].includes(comparison))
          fileReasons.push(`source_comparison_${comparison}`)
        files.push({
          file_id: file.file_id,
          page_id: file.page_id,
          path: file.path,
          ownership: file.ownership,
          current_sha256: file.sha256,
          current_bytes: file.bytes,
          current_mode: currentMode,
          source_identity: expected ?? null,
          comparison,
          requires_decision: fileReasons.length > 0,
          reasons: fileReasons,
        })
      }
      if (
        item?.findings.some((finding) =>
          /OPERATION|CONFLICT|UNOBSERVED|UNAVAILABLE/u.test(finding.code),
        )
      )
        reasons.push("unresolved_resource_findings")
      if (files.some((file) => file.requires_decision)) reasons.push("file_decisions_required")
      if (selected !== null && selected.kind !== "git")
        reasons.push("upstream_repository_commit_unestablished")
      const metadata = {
        skill: auditSemanticRow(run.inventory.skills.find((row) => auditRowId(row) === id) ?? null),
        files: run.inventory.files
          .filter((row) => auditRelationIds(row, library.files, "Skill").includes(id))
          .sort((a, b) => auditRowId(a).localeCompare(auditRowId(b)))
          .map(auditSemanticRow),
      }
      const classification =
        item === undefined || item.coverage !== "full"
          ? ("anomalous" as const)
          : custom
            ? ("custom" as const)
            : selected === null || sourceContext?.definition == null
              ? ("unbound_source" as const)
              : selected.kind !== "git"
                ? ("retained_source" as const)
                : ("pure_upstream" as const)
      resources.push({
        page_id: id,
        skill_id: item?.skill_id ?? null,
        classification,
        automatic_candidate: reasons.length === 0 && classification === "pure_upstream",
        source_context: sourceContext,
        selected,
        source_definition: definition?._tag === "Success" ? definition.success : null,
        target_revision: selected?.revision ?? null,
        reasons: [...new Set(reasons)].sort(),
        files,
        metadata,
        metadata_sha256: yield* sha256(canonicalSharedJson(metadata)),
        ownership_sha256: yield* sha256(
          canonicalSharedJson(files.map((file) => [file.file_id, file.ownership])),
        ),
        content_sha256: yield* sha256(
          canonicalSharedJson(
            files.map((file) => [
              file.path,
              file.current_sha256,
              file.current_bytes,
              file.current_mode,
            ]),
          ),
        ),
        recovery: {
          explicit_pin_id: run.pin_id,
          history: item?.history ?? [],
          private_session_references: "not_globally_enumerable",
          original_operation_headers: property(item?.state).operations ?? [],
        },
      })
    }
    const semanticRows = (rows: readonly unknown[]) =>
      [...rows].sort((a, b) => auditRowId(a).localeCompare(auditRowId(b))).map(auditSemanticRow)
    const native_census_sha256 = yield* sha256(
      canonicalSharedJson({
        skills: semanticRows(run.inventory.skills),
        files: semanticRows(run.inventory.files),
        records: semanticRows(run.inventory.records),
      }),
    )
    const visible_registered_census = yield* visibleRegisteredCensus(run, library)
    const frozen = {
      rules_version: INVENTORY_RULES,
      library_id: library.library_id,
      entry_id: run.entry_id,
      inspection_scope: report.inspection_scope,
      permission_scope: run.permission_scope,
      visible_registered_census,
      native_census_sha256,
      resources,
      findings: report.findings.map(({ status: _status, ...finding }) => finding),
    } as const
    const plan_id = `baseline-${yield* sha256(canonicalSharedJson(frozen))}`
    const output: SharedBaselineInventory = {
      version: 1,
      ...frozen,
      plan_id,
      audit_run_id: run.run_id,
      observation_interval: report.observation_interval,
      coverage:
        report.coverage !== "full"
          ? report.coverage
          : run.depth === "metadata" ||
              resources.some(
                (resource) =>
                  resource.reasons.includes("resource_coverage_incomplete") ||
                  resource.files.some(
                    (file) =>
                      file.current_sha256 === null ||
                      file.current_bytes === null ||
                      file.current_mode === null ||
                      (file.source_identity !== null && file.comparison === "unobserved"),
                  ),
              )
            ? "partial"
            : "full",
      counts: {
        skills: resources.length,
        files: run.inventory.files.length,
        record_headers: run.inventory.records.length,
        source_definitions: run.inventory.sources.length,
        automatic_candidates: resources.filter((resource) => resource.automatic_candidate).length,
        require_decision: resources.filter((resource) => !resource.automatic_candidate).length,
      },
      action: "review_only",
      remote_writes: 0,
      global_gc_safe: false,
    }
    return { inventory_id: yield* saveInventoryArtifact("remote", output), ...output }
  })
}

export function readSharedBaselineInventory(id: string) {
  return readInventoryArtifact(id, "remote").pipe(
    Effect.flatMap((value) => checked(() => decode(SharedBaselineInventorySchema, value.payload))),
  )
}
