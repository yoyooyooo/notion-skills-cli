import { Schema } from "effect"
import { RetainedContentSchema } from "./shared-file-state.ts"
import { SharedMigrationConversionCandidateSchema } from "./shared-migration-conversion-model.ts"

// Retained origin data is shared by creation plans and migration execution.
// Keep its schema independent of the workflow that validates its evidence.
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const MemberBindingSchema = Schema.Struct({
  legacy_id: Schema.String,
  skill_id: Schema.String,
  record_id: Schema.String,
  page_id: Schema.String,
})
export type MigrationMemberBinding = typeof MemberBindingSchema.Type
export const SharedMigrationOriginArchiveSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("migration_create_origin"),
  candidate_id: Schema.String,
  sha256: Hash,
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  chunks: Schema.Array(RetainedContentSchema),
})
export const SharedMigrationOriginManifestSchema = Schema.Struct({
  archive: SharedMigrationOriginArchiveSchema,
  member_bindings: Schema.Array(MemberBindingSchema),
})
export const SharedMigrationCreateOriginSchema = Schema.Struct({
  archive: SharedMigrationOriginArchiveSchema,
  member_bindings: Schema.Array(MemberBindingSchema),
  candidate: SharedMigrationConversionCandidateSchema,
})
export type SharedMigrationCreateOrigin = typeof SharedMigrationCreateOriginSchema.Type
export type SharedMigrationOriginManifest = typeof SharedMigrationOriginManifestSchema.Type
