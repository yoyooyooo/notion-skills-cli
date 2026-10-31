import { Effect, Schema } from "effect"
import { CoverageSchema, fail, property, SkillsError } from "./model.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { sharedSkillId } from "./shared-content.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { makeSourceBinding } from "./shared-source-binding.ts"
import { sha256 } from "./store.ts"

const BodySchema = Schema.Struct({
  complete: Schema.Boolean,
  sha256: Schema.String,
  bytes: Schema.Number,
  retention_ref: Schema.String,
  retention_verified: Schema.Boolean,
  normalization_version: Schema.optional(Schema.Literal(1)),
})
const FileSchema = Schema.Struct({
  legacy_id: Schema.String,
  path: Schema.String,
  ownership: Schema.Literals(["native", "custom", "following", "tombstone", "unknown"]),
  body: Schema.optional(BodySchema),
  source_id: Schema.optional(Schema.String),
  projection_sha256: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.Unknown),
})
const EntrySchema = Schema.Struct({
  legacy_id: Schema.String,
  record: Schema.Unknown,
  metadata: Schema.optional(Schema.Unknown),
  metadata_complete: Schema.Boolean,
  files_complete: Schema.Boolean,
  files: Schema.Array(FileSchema),
  legacy_mode: Schema.optional(Schema.Literals(["tracked", "fork", "local", "native", "unknown"])),
  legacy_layout: Schema.optional(
    Schema.Literals(["ordinary_page", "literal_file", "source_zip", "release", "local", "unknown"]),
  ),
})
const PreservedItemSchema = Schema.Struct({
  legacy_id: Schema.String,
  raw: Schema.Unknown,
  complete: Schema.Boolean,
  references: Schema.Array(Schema.String),
  retention_ref: Schema.optional(Schema.String),
  retention_verified: Schema.optional(Schema.Boolean),
  terminal_verified: Schema.optional(Schema.Boolean),
  terminal_evidence: Schema.optional(Schema.String),
  source_semantics: Schema.optional(Schema.Literals(["fixed_git_v1", "unsupported", "unknown"])),
  fixed_source: Schema.optional(Schema.Unknown),
})
const InventorySchema = Schema.Struct({
  complete: Schema.Boolean,
  items: Schema.Array(PreservedItemSchema),
})
export const SharedMigrationInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  target_library_id: Schema.String,
  /** Comes from an explicitly frozen migration scope, never from the number discovered. */
  approved_legacy_ids: Schema.Array(Schema.String),
  backup: Schema.Struct({ verified: Schema.Boolean, reference: Schema.String }),
  catalog: Schema.Struct({ coverage: CoverageSchema, entries: Schema.Array(EntrySchema) }),
  preservation: Schema.Struct({
    sources: InventorySchema,
    views: InventorySchema,
    routers: InventorySchema,
    pins: InventorySchema,
    operations: InventorySchema,
  }),
})
export type SharedMigrationInput = typeof SharedMigrationInputSchema.Type

export type MigrationBlocker = {
  readonly code: string
  readonly subject: string
  readonly message: string
}
export type MigrationFileMapping = {
  readonly legacy_id: string
  readonly file_id: string
  readonly path: string
  readonly state: "following" | "custom" | "tombstone" | "unresolved"
  readonly source_id?: string
  readonly body?: typeof BodySchema.Type
  readonly preserve_as_user_candidate: boolean
}
export type MigrationRecordMapping = {
  readonly legacy_id: string
  readonly approved: boolean
  readonly skill_id: string
  readonly record_id: string
  readonly kind: string | null
  readonly legacy_mode: string
  readonly legacy_layout: string
  readonly files: readonly MigrationFileMapping[]
}
export type MigrationPreservationMapping = {
  readonly domain: keyof SharedMigrationInput["preservation"]
  readonly legacy_id: string
  readonly disposition: "mapped_source" | "retain_original" | "retain_and_reconcile"
  readonly source_id?: string
  readonly references: readonly { readonly legacy_id: string; readonly record_id: string | null }[]
  readonly operation?: {
    readonly operation_id: unknown
    readonly scope: unknown
    readonly database_id: unknown
    readonly state: unknown
    readonly phase: unknown
    readonly automatic_replay: false
  }
}

const domains = ["sources", "views", "routers", "pins", "operations"] as const
const validSha = (value: string) => /^[a-f0-9]{64}$/u.test(value)
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const byId = <T extends { readonly legacy_id: string }>(left: T, right: T) =>
  compare(left.legacy_id, right.legacy_id) ||
  compare(canonicalSharedJson(left), canonicalSharedJson(right))

function unsupportedSourceOptions(value: unknown, prefix = "source"): string[] {
  if (value === null || typeof value !== "object") return []
  if (Array.isArray(value))
    return value.flatMap((item, index) => unsupportedSourceOptions(item, `${prefix}[${index}]`))
  const hasValue = (item: unknown) =>
    Array.isArray(item)
      ? item.length > 0
      : item !== null && typeof item === "object"
        ? Object.keys(item).length > 0
        : item !== null && item !== false && item !== ""
  return Object.entries(property(value)).flatMap(([key, item]) =>
    key === "external_assets" ||
    key === "external_markdown" ||
    (["include", "exclude", "patch", "sharedTargetSet", "shared_target_set", "mapping"].includes(
      key,
    ) &&
      hasValue(item)) ||
    (key === "roots" && Array.isArray(item) && item.length > 1)
      ? [`${prefix}.${key}`]
      : unsupportedSourceOptions(item, `${prefix}.${key}`),
  )
}

/**
 * A deterministic read-only planner. Its only service is Crypto; it never reads
 * Notion, providers, local state or clocks. The collector supplies credential-free
 * original JSON and explicit evidence, including false/incomplete observations.
 */
export function planSharedMigration(input: unknown) {
  return Effect.gen(function* () {
    const frozen = yield* Effect.try({
      try: () => {
        // Canonical JSON rejects cycles/non-JSON values; strict outer decoding
        // cannot quietly discard input. Opaque legacy records keep every field.
        const copy: unknown = JSON.parse(canonicalSharedJson(input))
        return Schema.decodeUnknownSync(SharedMigrationInputSchema)(copy, {
          onExcessProperty: "error",
        })
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "MIGRATION_INPUT_INVALID",
              "Migration input must match the explicit evidence contract; preserve unknown legacy fields inside record/raw.",
            ),
    })
    if (frozen.scope === "" || frozen.target_library_id === "")
      return yield* Effect.fail(
        fail(
          "MIGRATION_INPUT_INVALID",
          "Migration requires an observation scope and a target library identity.",
        ),
      )
    const blockers: MigrationBlocker[] = []
    const block = (code: string, subject: string, message: string) => {
      blockers.push({ code, subject, message })
    }
    const inputHash = yield* sha256(canonicalSharedJson(frozen))
    const approved = new Set(frozen.approved_legacy_ids)
    if (approved.size !== frozen.approved_legacy_ids.length)
      block("DUPLICATE_SCOPE_ID", "scope", "The frozen approval scope repeats a legacy identity.")
    if (!frozen.backup.verified || frozen.backup.reference === "")
      block(
        "BACKUP_UNVERIFIED",
        "backup",
        "A verified recoverable backup is required before the migration plan can be ready.",
      )
    const coverage = frozen.catalog.coverage
    if (!coverage.exhaustive || coverage.search_index_limited || coverage.failed_sources.length > 0)
      block(
        "CATALOG_INCOMPLETE",
        "catalog",
        "Catalog coverage is incomplete; observed row counts do not establish the migration boundary.",
      )
    if (frozen.catalog.entries.length > 0 && coverage.queried_data_sources.length === 0)
      block(
        "CATALOG_SCOPE_UNKNOWN",
        "catalog",
        "Observed catalog records have no declared queried data-source coverage.",
      )

    const recordsById = new Map<string, string>()
    for (const entry of frozen.catalog.entries) {
      if (recordsById.has(entry.legacy_id))
        block(
          "DUPLICATE_LEGACY_ID",
          entry.legacy_id,
          "One legacy content identity appears more than once; no row is discarded.",
        )
      const skillId = `migration-skill-${yield* sha256(canonicalSharedJson([1, frozen.target_library_id, entry.legacy_id]))}`
      const target = yield* Effect.try({
        try: () => sharedSkillId(frozen.target_library_id, skillId),
        catch: () =>
          fail(
            "MIGRATION_INPUT_INVALID",
            "The target library does not have a valid stable identity.",
          ),
      })
      recordsById.set(entry.legacy_id, target)
    }
    for (const id of approved)
      if (!recordsById.has(id))
        block(
          "APPROVED_ID_UNOBSERVED",
          id,
          "An approved legacy object is absent from the current inventory; absence does not authorize removal.",
        )

    const sourceIds = new Map<string, string>()
    const sourcePaths = new Map<string, ReadonlySet<string>>()
    const sourceMembers = new Map<string, ReadonlySet<string>>()
    const preservation: MigrationPreservationMapping[] = []
    for (const domain of domains) {
      const inventory = frozen.preservation[domain]
      if (!inventory.complete)
        block(
          "INVENTORY_INCOMPLETE",
          domain,
          `The ${domain} inventory has not been completely enumerated.`,
        )
      const seen = new Set<string>()
      for (const item of [...inventory.items].sort(byId)) {
        const subject = `${domain}:${item.legacy_id}`
        const duplicate = seen.has(item.legacy_id)
        if (item.legacy_id === "" || duplicate)
          block(
            "DUPLICATE_OR_EMPTY_ID",
            subject,
            "Preservation requires a unique nonempty original identity.",
          )
        if (domain === "sources" && duplicate) {
          sourceIds.delete(item.legacy_id)
          sourcePaths.delete(item.legacy_id)
          sourceMembers.delete(item.legacy_id)
        }
        seen.add(item.legacy_id)
        if (!item.complete)
          block(
            "PRESERVATION_INCOMPLETE",
            subject,
            "The original payload or reference set has not been completely observed.",
          )
        const references = item.references
          .map((id) => {
            const target = recordsById.get(id)
            if (target === undefined)
              block(
                "REFERENCE_UNRESOLVED",
                subject,
                `Referenced legacy content ${id} has no observed identity mapping.`,
              )
            return { legacy_id: id, record_id: target ?? null }
          })
          .sort((a, b) => compare(a.legacy_id, b.legacy_id))
        let sourceId: string | undefined
        const raw = property(item.raw)
        const source =
          domain === "sources" ? item.raw : domain === "operations" ? raw.input : undefined
        const unported = [
          ...unsupportedSourceOptions(source, domain === "operations" ? "input" : "source"),
          ...(domain === "sources"
            ? unsupportedSourceOptions(item.fixed_source, "fixed_source")
            : []),
        ]
        if (unported.length > 0)
          block(
            "LEGACY_SOURCE_OPTIONS_UNSUPPORTED",
            subject,
            `Preserve unported source options: ${unported.sort().join(", ")}.`,
          )
        if (domain === "sources") {
          if (
            !inventory.complete ||
            duplicate ||
            !item.complete ||
            item.source_semantics !== "fixed_git_v1" ||
            item.fixed_source === undefined ||
            unported.length > 0
          ) {
            block(
              "SOURCE_SEMANTICS_UNRESOLVED",
              subject,
              "No complete supported fixed-source interpretation exists; do not default to following.",
            )
          } else {
            const binding = yield* makeSourceBinding(item.fixed_source).pipe(Effect.result)
            if (binding._tag === "Failure")
              block("SOURCE_SEMANTICS_UNRESOLVED", subject, binding.failure.message)
            else {
              sourceId = binding.success.source_id
              sourceIds.set(item.legacy_id, sourceId)
              sourcePaths.set(
                item.legacy_id,
                new Set(binding.success.files.map((file) => file.path)),
              )
              sourceMembers.set(item.legacy_id, new Set(item.references))
            }
          }
        }
        if (domain === "pins" && (!item.retention_verified || !item.retention_ref))
          block(
            "PIN_RETENTION_UNVERIFIED",
            subject,
            "The original pin and its complete exact bytes require recoverable retention evidence.",
          )
        if (domain === "operations") {
          if (
            raw.operation_id !== item.legacy_id ||
            typeof raw.state !== "string" ||
            typeof raw.phase !== "string" ||
            typeof raw.scope !== "string"
          )
            block(
              "OPERATION_IDENTITY_UNCERTAIN",
              subject,
              "Preserve the original command envelope, including operation_id, scope, state and phase.",
            )
          if (!item.terminal_verified || !item.terminal_evidence)
            block(
              "UNSETTLED_OPERATION",
              subject,
              "The original operation has no verified terminal outcome; retain its input and intent and reconcile without replay.",
            )
        }
        preservation.push({
          domain,
          legacy_id: item.legacy_id,
          references,
          disposition:
            domain === "operations" && (!item.terminal_verified || !item.terminal_evidence)
              ? "retain_and_reconcile"
              : sourceId === undefined
                ? "retain_original"
                : "mapped_source",
          ...(sourceId === undefined ? {} : { source_id: sourceId }),
          ...(domain === "operations"
            ? {
                operation: {
                  operation_id: raw.operation_id ?? null,
                  scope: raw.scope ?? null,
                  database_id: raw.database_id ?? null,
                  state: raw.state ?? null,
                  phase: raw.phase ?? null,
                  automatic_replay: false as const,
                },
              }
            : {}),
        })
      }
    }

    const records: MigrationRecordMapping[] = []
    for (const entry of [...frozen.catalog.entries].sort(byId)) {
      const raw = property(entry.record)
      const approvedEntry = approved.has(entry.legacy_id)
      if (!approvedEntry)
        block(
          "SCOPE_NOT_FROZEN",
          entry.legacy_id,
          "This discovered object remains a review candidate and is not in the approved migration scope.",
        )
      if (!entry.legacy_id || raw.id !== entry.legacy_id)
        block(
          "LEGACY_IDENTITY_UNCERTAIN",
          entry.legacy_id,
          "The original record identity is empty or differs from its inventory identity.",
        )
      const kind = typeof raw.kind === "string" ? raw.kind : null
      if (kind !== "skill" && kind !== "router" && kind !== "prompt")
        block(
          "CONTENT_KIND_UNSUPPORTED",
          entry.legacy_id,
          "Preserve the original content kind until its consumption semantics are understood.",
        )
      if (!entry.metadata_complete || entry.metadata === undefined)
        block(
          "METADATA_INCOMPLETE",
          entry.legacy_id,
          "Catalog summaries do not establish complete Metadata preservation.",
        )
      if (!entry.files_complete)
        block(
          "FILE_INVENTORY_INCOMPLETE",
          entry.legacy_id,
          "The complete logical file membership has not been observed.",
        )
      if (
        !entry.legacy_mode ||
        entry.legacy_mode === "unknown" ||
        !entry.legacy_layout ||
        entry.legacy_layout === "unknown"
      )
        block(
          "LEGACY_CLASSIFICATION_UNKNOWN",
          entry.legacy_id,
          "Identify tracked/fork/local ownership and page/literal/source-ZIP/release layout before conversion.",
        )
      try {
        composeSharedFiles({
          base: entry.files.map((file) => ({ path: file.path, bytes: new Uint8Array() })),
          mounts: [],
          overrides: [],
          entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : "",
        })
      } catch {
        block(
          "FILE_TREE_INVALID",
          entry.legacy_id,
          "The observed file paths do not form one complete safe tree with the original entrypoint.",
        )
      }
      const seenFiles = new Set<string>()
      const files: MigrationFileMapping[] = []
      for (const file of [...entry.files].sort(byId)) {
        const subject = `${entry.legacy_id}:${file.legacy_id}`
        if (!file.legacy_id || seenFiles.has(file.legacy_id))
          block(
            "FILE_IDENTITY_UNCERTAIN",
            subject,
            "Every file requires its own unique original stable identity.",
          )
        seenFiles.add(file.legacy_id)
        const fileId = `migration-file-${yield* sha256(canonicalSharedJson([1, frozen.target_library_id, entry.legacy_id, file.legacy_id]))}`
        const body = file.body
        const bodyReady =
          body !== undefined &&
          body.complete &&
          validSha(body.sha256) &&
          Number.isSafeInteger(body.bytes) &&
          body.bytes >= 0 &&
          body.retention_verified &&
          body.retention_ref !== ""
        if (!bodyReady)
          block(
            "BODY_UNVERIFIED",
            subject,
            "Complete original bytes, their checksum and recoverable retention must be observed; unread current bodies cannot fill a frozen plan later.",
          )
        let state: MigrationFileMapping["state"] = "unresolved"
        let userCandidate = file.ownership === "unknown" || !bodyReady
        const sourceId = file.source_id === undefined ? undefined : sourceIds.get(file.source_id)
        if (file.ownership === "unknown")
          block(
            "USER_EDIT_CANDIDATE",
            subject,
            "The origin of current content changes is unresolved; protect the observed candidate without reclassifying history.",
          )
        else if (file.ownership === "following") {
          const sourceHasPath =
            file.source_id !== undefined && sourcePaths.get(file.source_id)?.has(file.path) === true
          const sourceHasMember =
            file.source_id !== undefined &&
            sourceMembers.get(file.source_id)?.has(entry.legacy_id) === true
          if (!approvedEntry) userCandidate = true
          if (sourceId === undefined) {
            userCandidate = true
            block(
              "FOLLOWING_SOURCE_UNRESOLVED",
              subject,
              "Following requires an exact supported selected source, not a default or current upstream branch.",
            )
          } else if (!sourceHasPath) {
            userCandidate = true
            block(
              "FOLLOWING_PATH_MISSING",
              subject,
              "The exact selected source does not contain this logical path.",
            )
          }
          if (sourceId !== undefined && !sourceHasMember) {
            userCandidate = true
            block(
              "FOLLOWING_BINDING_UNVERIFIED",
              subject,
              "The preserved source membership does not establish this exact legacy content binding.",
            )
          }
          if (entry.legacy_mode !== "tracked") {
            userCandidate = true
            block(
              "OWNERSHIP_CLASSIFICATION_CONFLICT",
              subject,
              "Only an explicitly tracked legacy object can preserve following; fork, local, native or unknown classifications require a resolved ownership decision.",
            )
          }
          if (
            !file.projection_sha256 ||
            !validSha(file.projection_sha256) ||
            body?.normalization_version !== 1
          ) {
            userCandidate = true
            block(
              "PROJECTION_BASELINE_UNKNOWN",
              subject,
              "The actual prior projection baseline and matching normalization are not established.",
            )
          } else if (bodyReady && body?.sha256 !== file.projection_sha256) {
            userCandidate = true
            block(
              "USER_EDIT_CANDIDATE",
              subject,
              "Current bytes differ from the prior projection; preserve this candidate and resolve its provenance instead of inferring ownership from a diff.",
            )
          } else if (
            bodyReady &&
            sourceId !== undefined &&
            sourceHasPath &&
            sourceHasMember &&
            approvedEntry &&
            entry.legacy_mode === "tracked"
          )
            state = "following"
        } else if (bodyReady) state = file.ownership === "tombstone" ? "tombstone" : "custom"
        files.push({
          legacy_id: file.legacy_id,
          file_id: fileId,
          path: file.path,
          state,
          ...(sourceId === undefined ? {} : { source_id: sourceId }),
          ...(body === undefined ? {} : { body }),
          preserve_as_user_candidate: userCandidate,
        })
      }
      const skillId = `migration-skill-${yield* sha256(canonicalSharedJson([1, frozen.target_library_id, entry.legacy_id]))}`
      records.push({
        legacy_id: entry.legacy_id,
        approved: approvedEntry,
        skill_id: skillId,
        record_id: recordsById.get(entry.legacy_id)!,
        kind,
        legacy_mode: entry.legacy_mode ?? "unknown",
        legacy_layout: entry.legacy_layout ?? "unknown",
        files,
      })
    }
    blockers.sort(
      (a, b) =>
        compare(a.subject, b.subject) || compare(a.code, b.code) || compare(a.message, b.message),
    )
    return {
      version: 1 as const,
      plan_id: `migration-${inputHash}`,
      input_sha256: inputHash,
      mode: "read_only_plan" as const,
      data_ready: blockers.length === 0,
      status: blockers.length === 0 ? ("reviewable" as const) : ("blocked" as const),
      apply_allowed: false as const,
      production_authorization: "not_requested_by_this_planner" as const,
      active_hosts: ["pro", "mini"] as const,
      other_hosts: "deferred" as const,
      records,
      preservation,
      blockers,
      stop_conditions: [...new Set(blockers.map((blocker) => blocker.code))].sort(),
      // This complete frozen evidence keeps ref/commit/include/exclude/patch,
      // sharedTargetSet, opaque Metadata and original operation input/intent.
      evidence: frozen,
      safeguards: {
        cleanup_allowed: false as const,
        unresolved_operation_replay: false as const,
        prior_pass_inherits_acceptance: false as const,
      },
    }
  })
}
