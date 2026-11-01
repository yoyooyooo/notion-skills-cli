import { Effect, Schema } from "effect"
import {
  ContentKindSchema,
  entrypointFor,
  fail,
  property,
  SkillsError,
  validateDescription,
  validateDisplayName,
} from "./model.ts"
import { pageId } from "./ref.ts"
import { planSharedMigration } from "./shared-migration-plan.ts"
import {
  FileEventSchema,
  FileOwnershipSchema,
  normalizeObservedBody,
  resolveFileState,
  RetainedContentSchema,
  type FileEvent,
} from "./shared-file-state.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import {
  projectSharedNotionMarkdown,
  SharedNotionMarkdownProjectionSchema,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson, validateSharedRecordEnvelope } from "./shared-records.ts"
import {
  makeSourceBinding,
  SharedGitSourceBindingSchema,
  type SharedGitSourceBinding,
} from "./shared-source-binding.ts"
import { sharedCreateBodyPayload, sharedCreateInputPayload } from "./shared-create-model.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const BaselineSchema = Schema.Struct({
  normalization_version: Schema.Literal(1),
  sha256: Hash,
  source_revision: Identity,
})
const FileCandidateSchema = Schema.Struct({
  legacy_id: Schema.String,
  file_id: Identity,
  path: Schema.String,
  input: Schema.Struct({
    text: Schema.String,
    sha256: Hash,
    bytes: Schema.Number,
    retention_ref: Schema.String,
  }),
  content: RetainedContentSchema,
  projection: SharedNotionMarkdownProjectionSchema,
  ownership: FileOwnershipSchema,
  initial_event: FileEventSchema,
  binding: Schema.Struct({
    role: Schema.Literals(["main", "supporting"]),
    data_source_id: Schema.String,
    page_id: Schema.Null,
    display_status: Schema.Literals(["custom", "following"]),
    projection_baseline: Schema.NullOr(BaselineSchema),
  }),
})
export const SharedMigrationCreateCandidateSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration_create_candidate"),
  candidate_id: Schema.String.check(Schema.isPattern(/^migration-create-[a-f0-9]{64}$/u)),
  migration_plan_id: Schema.String,
  migration_input_sha256: Hash,
  legacy_id: Schema.String,
  skill_id: Identity,
  record_id: Schema.String,
  library: SharedLibrarySchema,
  metadata: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    kind: ContentKindSchema,
    default_context: Schema.Boolean,
    entrypoint: Schema.String,
  }),
  legacy_entry: Schema.Unknown,
  legacy_source: Schema.NullOr(Schema.Unknown),
  legacy_router: Schema.NullOr(Schema.Unknown),
  source: Schema.NullOr(SharedGitSourceBindingSchema),
  files: Schema.Array(FileCandidateSchema),
  member_bindings: Schema.Array(
    Schema.Struct({
      legacy_id: Schema.String,
      skill_id: Identity,
      record_id: Schema.String,
      page_id: Schema.Null,
    }),
  ),
  binding: Schema.Struct({
    page_id: Schema.Null,
    data_source_id: Schema.String,
    main_file_id: Identity,
    enabled_until_verified: Schema.Literal(false),
    source_reference: Schema.String,
  }),
  execution: Schema.Struct({
    state: Schema.Literal("not_implemented"),
    apply_allowed: Schema.Literal(false),
    receipt_content_verified: Schema.Literal(false),
    physical_bindings_verified: Schema.Literal(false),
    required_binding_reader: Schema.Literal("querySharedSkillIndex_and_querySkillFiles"),
    legacy_relations: Schema.Literal("retained_not_translated"),
  }),
})
export type SharedMigrationCreateCandidate = typeof SharedMigrationCreateCandidateSchema.Type
export type MigrationRetainedFile = {
  readonly legacy_id: string
  readonly retention_ref: string
  /** Exact bytes supplied by the caller; a true retention flag cannot substitute for these. */
  readonly bytes: Uint8Array
}
export type MigrationCreateBindingInput = {
  readonly migration_input: unknown
  readonly legacy_id: string
  readonly library: SharedLibrary
  /** Only the frozen managed file inventory. Additional Git resources stay in Source. */
  readonly files: readonly MigrationRetainedFile[]
}
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_MIGRATION_CREATE_INVALID", "Invalid retained migration creation input."),
  })
function reject(code: string, message: string, details?: unknown): never {
  throw fail(code, message, details)
}

/**
 * Pure identity/body/ownership conversion. This is deliberately not SharedCreatePlan:
 * no dispatcher accepts it, no page UUID is invented, and no receipt is verified.
 * Existing Source resources are retained as a complete immutable manifest, never
 * expanded into body pages. Real binding and relation conversion remain explicit.
 * This candidate is a new authoring intent, so it uses policy 3. Historical
 * create/write records retain their original policy in their own validators.
 */
export function makeSharedMigrationCreateCandidate(input: MigrationCreateBindingInput) {
  return Effect.gen(function* () {
    const plan = yield* planSharedMigration(input.migration_input)
    const library = yield* checked(() =>
      Schema.decodeUnknownSync(SharedLibrarySchema)(
        JSON.parse(canonicalSharedJson(input.library)),
        { onExcessProperty: "error" },
      ),
    )
    const prepared = yield* checked(() => {
      if (library.library_id !== plan.evidence.target_library_id)
        reject(
          "SHARED_MIGRATION_CREATE_SCOPE",
          "The descriptor differs from the frozen target library.",
        )
      for (const id of [
        library.parent_page_id,
        ...[library.skills, library.files, library.records].flatMap((table) => [
          table.database_id,
          table.data_source_id,
        ]),
      ])
        if (!id || pageId(id) !== id)
          reject(
            "SHARED_MIGRATION_CREATE_SCOPE",
            "The supplied descriptor requires canonical Notion identities; their actual existence is not verified here.",
          )
      const entries = plan.evidence.catalog.entries.filter(
        (entry) => entry.legacy_id === input.legacy_id,
      )
      const mappings = plan.records.filter((record) => record.legacy_id === input.legacy_id)
      const entry = entries[0],
        mapping = mappings[0]
      if (
        entries.length !== 1 ||
        mappings.length !== 1 ||
        entry === undefined ||
        mapping === undefined ||
        !mapping.approved
      )
        reject(
          "SHARED_MIGRATION_CREATE_NOT_APPROVED",
          "Select one observed object from the explicit frozen approval scope.",
        )
      if (mapping.files.some((file) => file.state === "tombstone"))
        reject(
          "SHARED_MIGRATION_CREATE_TOMBSTONE_UNSUPPORTED",
          "The frozen tombstone is retained. A deleted initial event needs verifiable prior shared state; this adapter does not invent an adopted predecessor.",
        )
      if (
        plan.readiness.items.find((item) => item.legacy_id === input.legacy_id)?.evidence_ready !==
        true
      )
        reject(
          "SHARED_MIGRATION_CREATE_BLOCKED",
          "The selected mapping still has structural evidence blockers. Readiness is not authorization or receipt verification.",
          { legacy_id: input.legacy_id },
        )
      const record = property(entry.record)
      const kind = Schema.decodeUnknownSync(ContentKindSchema)(record.kind)
      if (typeof record.name !== "string")
        reject("SHARED_MIGRATION_CREATE_METADATA", "The observed name is not complete text.")
      if (kind === "router" && !library.skills.property_ids.Members)
        reject(
          "SHARED_MIGRATION_CREATE_ROUTER_UNRESOLVED",
          "The target descriptor has no registered Members relation; a Router cannot lose its original members.",
        )
      const metadata = {
        name: validateDisplayName(record.name),
        description: validateDescription(record.description),
        kind,
        default_context: record.default_context,
        entrypoint: entrypointFor(kind),
      }
      if (
        typeof metadata.default_context !== "boolean" ||
        record.entrypoint !== metadata.entrypoint
      )
        reject(
          "SHARED_MIGRATION_CREATE_METADATA",
          "Creation needs the exact observed metadata and canonical original main path; it cannot reinterpret or rename retained content.",
        )
      if (
        !Array.isArray(input.files) ||
        input.files.length !== mapping.files.length ||
        new Set(input.files.map((file) => file.legacy_id)).size !== input.files.length ||
        input.files.some(
          (file) => !mapping.files.some((mapped) => mapped.legacy_id === file.legacy_id),
        )
      )
        reject(
          "SHARED_MIGRATION_CREATE_FILES",
          "Supply every exact frozen managed file once, with no extra or omitted file.",
        )
      const retained = input.files.map((file) => {
        if (!(file.bytes instanceof Uint8Array))
          reject(
            "SHARED_MIGRATION_CREATE_FILES",
            "Retained input requires actual bytes, not an asserted checksum.",
          )
        return { ...file, bytes: new Uint8Array(file.bytes) }
      })
      // A custom file's source_id can be historical provenance. Only a complete
      // following mapping establishes a current selection in this bounded slice.
      const sources = [
        ...new Set(
          mapping.files.flatMap((file) =>
            file.state === "following" && file.source_id !== undefined ? [file.source_id] : [],
          ),
        ),
      ]
      if (
        sources.length > 1 ||
        (mapping.legacy_mode === "tracked" && sources.length !== 1) ||
        (mapping.legacy_mode !== "tracked" &&
          mapping.files.some((file) => file.source_id !== undefined))
      )
        reject(
          "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
          "A Skill requires one exact current Source selection. Historical custom references, multiple following sources or wholly custom tracked content need explicit selection evidence.",
        )
      return {
        entry,
        mapping,
        metadata: { ...metadata, default_context: metadata.default_context },
        retained,
        source_id: sources[0],
      }
    })

    let source: SharedGitSourceBinding | null = null
    let legacySource: unknown = null
    if (prepared.source_id !== undefined) {
      const matches = plan.preservation.filter(
        (item) => item.domain === "sources" && item.source_id === prepared.source_id,
      )
      const mapped = matches[0]
      const original =
        mapped === undefined
          ? undefined
          : plan.evidence.preservation.sources.items.find(
              (item) => item.legacy_id === mapped.legacy_id,
            )
      if (matches.length !== 1 || original?.fixed_source === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
            "The selected fixed Source has no unique retained original mapping.",
          ),
        )
      source = yield* makeSourceBinding(original.fixed_source)
      if (source.source_id !== prepared.source_id)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
            "The retained fixed Source differs from the migration mapping.",
          ),
        )
      legacySource = original
    }

    const files: (typeof FileCandidateSchema.Type)[] = []
    for (const file of prepared.mapping.files) {
      const retained = prepared.retained.find((item) => item.legacy_id === file.legacy_id)
      if (
        retained === undefined ||
        file.body === undefined ||
        retained.retention_ref !== file.body.retention_ref
      )
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CREATE_FILES",
            "A file is missing its exact original retention reference.",
          ),
        )
      const hash = yield* sha256(retained.bytes)
      if (hash !== file.body.sha256 || retained.bytes.byteLength !== file.body.bytes)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_CREATE_BODY_MISMATCH",
            "Supplied complete bytes differ from the frozen original file.",
            { file_id: file.file_id },
          ),
        )
      const projected = yield* checked(() => {
        let text: string
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(retained.bytes)
        } catch {
          return reject(
            "SHARED_MIGRATION_CREATE_BINARY_UNSUPPORTED",
            "Binary bytes remain retained; this body-page adapter cannot convert them to Markdown.",
            { file_id: file.file_id },
          )
        }
        if (
          text.includes("\0") ||
          new TextEncoder().encode(text).byteLength !== retained.bytes.byteLength
        )
          reject(
            "SHARED_MIGRATION_CREATE_BINARY_UNSUPPORTED",
            "The retained file is not lossless UTF-8 body text.",
            { file_id: file.file_id },
          )
        const projection = projectSharedNotionMarkdown(text, {
          version: 3,
          purpose: "data_source_create",
        })
        if (normalizeObservedBody(text) !== text || projection.markdown !== text)
          reject(
            "SHARED_MIGRATION_CREATE_PROJECTION_CHANGED",
            "Creating this body would change the frozen original bytes. Preserve them and require an explicit conversion instead of ordinary portable import.",
            { file_id: file.file_id },
          )
        return { text, projection }
      })
      const content = { object_id: `body-${hash}`, sha256: hash, bytes: retained.bytes.byteLength }
      const eventFields = yield* checked(() => {
        if (file.state === "following") {
          if (
            source === null ||
            file.source_id !== source.source_id ||
            !source.files.some((item) => item.path === file.path) ||
            file.body?.normalization_version !== 1
          )
            reject(
              "SHARED_MIGRATION_CREATE_SOURCE_UNRESOLVED",
              "Following requires the exact selected fixed Source, path and retained projection baseline.",
            )
          return {
            kind: "projected" as const,
            file_id: file.file_id,
            parents: [] as readonly string[],
            source_revision: source.commit,
            projection: { normalization_version: 1 as const, sha256: hash },
          }
        }
        if (file.state !== "custom")
          reject(
            "SHARED_MIGRATION_CREATE_BLOCKED",
            "Unresolved or deleted ownership cannot become an adopted body.",
          )
        return {
          kind: "adopted" as const,
          file_id: file.file_id,
          parents: [] as readonly string[],
          content,
        }
      })
      const event: FileEvent = {
        ...eventFields,
        event_id: `migration-event-${yield* sha256(canonicalSharedJson({ version: 1, ...eventFields }))}`,
      }
      const state = yield* checked(() => {
        validateSharedRecordEnvelope(
          `retain-input-${hash}`,
          sharedCreateInputPayload(projected.text),
        )
        validateSharedRecordEnvelope(`retain-${hash}`, sharedCreateBodyPayload(projected.text))
        validateSharedRecordEnvelope(event.event_id, event)
        return resolveFileState(file.file_id, [event])
      })
      files.push({
        legacy_id: file.legacy_id,
        file_id: file.file_id,
        path: file.path,
        input: {
          text: projected.text,
          sha256: hash,
          bytes: retained.bytes.byteLength,
          retention_ref: retained.retention_ref,
        },
        content,
        projection: projected.projection,
        ownership: state.ownership,
        initial_event: event,
        binding: {
          role: file.path === prepared.metadata.entrypoint ? "main" : "supporting",
          data_source_id:
            file.path === prepared.metadata.entrypoint
              ? library.skills.data_source_id
              : library.files.data_source_id,
          page_id: null,
          display_status: file.state === "following" ? "following" : "custom",
          projection_baseline:
            event.kind === "projected"
              ? { ...event.projection, source_revision: event.source_revision }
              : null,
        },
      })
    }
    const router =
      prepared.metadata.kind === "router"
        ? plan.evidence.preservation.routers.items.filter(
            (item) => item.legacy_id === input.legacy_id,
          )
        : []
    const members = yield* checked(() => {
      if (prepared.metadata.kind !== "router") return []
      const original = router[0]
      if (
        router.length !== 1 ||
        original === undefined ||
        !original.complete ||
        new Set(original.references).size !== original.references.length
      )
        reject(
          "SHARED_MIGRATION_CREATE_ROUTER_UNRESOLVED",
          "A Router needs its exact complete original member set; empty discovery does not prove an empty relation.",
        )
      return [...original.references].sort().map((id) => {
        const matches = plan.records.filter((record) => record.legacy_id === id),
          member = matches[0]
        if (matches.length !== 1 || member === undefined)
          reject(
            "SHARED_MIGRATION_CREATE_ROUTER_UNRESOLVED",
            "A Router member has no unique logical migration mapping.",
          )
        return {
          legacy_id: id,
          skill_id: member.skill_id,
          record_id: member.record_id,
          page_id: null,
        }
      })
    })
    const main = files.filter((file) => file.binding.role === "main")
    if (main.length !== 1 || main[0] === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CREATE_FILES",
          "Exactly one retained active main file must bind to the future Skill page.",
        ),
      )
    const candidate = {
      version: 1 as const,
      kind: "migration_create_candidate" as const,
      migration_plan_id: plan.plan_id,
      migration_input_sha256: plan.input_sha256,
      legacy_id: input.legacy_id,
      skill_id: prepared.mapping.skill_id,
      record_id: prepared.mapping.record_id,
      library,
      metadata: prepared.metadata,
      legacy_entry: prepared.entry,
      legacy_source: legacySource,
      legacy_router: router[0] ?? null,
      source,
      files,
      member_bindings: members,
      binding: {
        page_id: null,
        data_source_id: library.skills.data_source_id,
        main_file_id: main[0].file_id,
        enabled_until_verified: false as const,
        source_reference: source?.source_id ?? "",
      },
      execution: {
        state: "not_implemented" as const,
        apply_allowed: false as const,
        receipt_content_verified: false as const,
        physical_bindings_verified: false as const,
        required_binding_reader: "querySharedSkillIndex_and_querySkillFiles" as const,
        legacy_relations: "retained_not_translated" as const,
      },
    }
    const candidateId = `migration-create-${yield* sha256(canonicalSharedJson(candidate))}`
    return yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationCreateCandidateSchema)(
        { ...candidate, candidate_id: candidateId },
        { onExcessProperty: "error" },
      ),
    )
  })
}

/** Rebuild from the original frozen migration input and actual retained text, not claimed IDs/status. */
export function validateSharedMigrationCreateCandidate(migrationInput: unknown, input: unknown) {
  return Effect.gen(function* () {
    const candidate = yield* checked(() =>
      Schema.decodeUnknownSync(SharedMigrationCreateCandidateSchema)(
        JSON.parse(canonicalSharedJson(input)),
        { onExcessProperty: "error" },
      ),
    )
    const expected = yield* makeSharedMigrationCreateCandidate({
      migration_input: migrationInput,
      legacy_id: candidate.legacy_id,
      library: candidate.library,
      files: candidate.files.map((file) => ({
        legacy_id: file.legacy_id,
        retention_ref: file.input.retention_ref,
        bytes: new TextEncoder().encode(file.input.text),
      })),
    })
    if (canonicalSharedJson(candidate) !== canonicalSharedJson(expected))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CREATE_INVALID",
          "The migration candidate differs from its exact frozen mapping, original bytes, ownership or unbound physical slots.",
        ),
      )
    return expected
  })
}
