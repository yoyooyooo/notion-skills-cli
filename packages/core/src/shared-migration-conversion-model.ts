import { Schema } from "effect"
import { ContentKindSchema } from "./model.ts"
import { FileEventSchema, RetainedContentSchema } from "./shared-file-state.ts"
import { SharedLibrarySchema } from "./shared-library-model.ts"
import { SharedMigrationActivationSchema } from "./shared-migration-activation.ts"
import { SharedNotionMarkdownProjectionSchema } from "./shared-notion-projection.ts"
import { SharedGitSourceBindingSchema } from "./shared-source-binding.ts"

// The retained wire schema has no dependency on migration execution. Native
// create origins can decode it while the conversion workflow is being loaded.
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Size = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const TextObject = Schema.Struct({
  text: Schema.String,
  sha256: Hash,
  bytes: Size,
  retention_ref: Schema.String,
})
const NativeFields = {
  kind: Schema.Literal("notion_page_markdown"),
  page_id: Schema.String,
  api_version: Schema.Literal("2026-03-11"),
  markdown_version: Schema.Literals(["default", "v2"]),
  request_path: Schema.String,
  retention_ref: Schema.String,
}
export const MigrationNativePreimageSchema = Schema.Struct({
  ...NativeFields,
  response_json: Schema.String,
})
export type MigrationNativePreimage = typeof MigrationNativePreimageSchema.Type
const NativeEvidenceSchema = Schema.Struct({
  ...NativeFields,
  response_json: Schema.String,
  response_sha256: Hash,
  response_bytes: Size,
  body_sha256: Hash,
})
const SourceFileSchema = Schema.Struct({
  path: Schema.String,
  retention_ref: Schema.String,
  sha256: Hash,
  bytes: Size,
  base64: Schema.String,
})
const MetadataSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  kind: ContentKindSchema,
  enabled: Schema.Literal(true),
  default_context: Schema.Boolean,
  entrypoint: Schema.String,
})
const MemberSchema = Schema.Struct({
  legacy_id: Schema.String,
  skill_id: Identity,
  record_id: Schema.String,
  page_id: Schema.Null,
})
const ConvertedFileSchema = Schema.Struct({
  legacy_id: Schema.String,
  file_id: Identity,
  path: Schema.String,
  selection: Schema.Literals(["current", "source"]),
  original: TextObject,
  native_preimage: NativeEvidenceSchema,
  input: TextObject,
  projection: SharedNotionMarkdownProjectionSchema,
  content: RetainedContentSchema,
  initial_event: FileEventSchema,
})
export const SharedMigrationConversionCandidateSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("migration_create_candidate"),
  conversion_policy: Schema.Literals(["legacy_page_to_native_v1", "legacy_page_to_native_v2"]),
  /** Absent in saved candidates: retain their original full-plan execution gate. */
  execution_policy: Schema.optional(
    Schema.Literals(["copy_to_new_native_v1", "copy_to_new_native_v2"]),
  ),
  activation: Schema.optional(SharedMigrationActivationSchema),
  candidate_id: Schema.String.check(Schema.isPattern(/^migration-create-[a-f0-9]{64}$/u)),
  migration_plan_id: Schema.String,
  migration_input_sha256: Hash,
  legacy_id: Schema.String,
  skill_id: Identity,
  record_id: Schema.String,
  library: SharedLibrarySchema,
  metadata: MetadataSchema,
  legacy_entry: Schema.Unknown,
  legacy_source: Schema.NullOr(Schema.Unknown),
  legacy_router: Schema.NullOr(Schema.Unknown),
  source: Schema.NullOr(SharedGitSourceBindingSchema),
  source_files: Schema.Array(SourceFileSchema),
  files: Schema.Array(ConvertedFileSchema),
  member_bindings: Schema.Array(MemberSchema),
  reference_check: Schema.Struct({ checked_files: Size, local_references: Size }),
  execution: Schema.Struct({
    apply_allowed: Schema.Literal(false),
    original_migration_input_required: Schema.Literal(true),
    physical_bindings_verified: Schema.Literal(false),
    native_receipt_verified: Schema.Literal(false),
  }),
})
export type SharedMigrationConversionCandidate =
  typeof SharedMigrationConversionCandidateSchema.Type
