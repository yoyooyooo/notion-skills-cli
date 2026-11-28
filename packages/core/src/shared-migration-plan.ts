import { Schema } from "effect"
import { CoverageSchema } from "./model.ts"

/** Offline inventory DTO for extracting retained legacy bytes. No runtime migration or writer is provided. */
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
  operation_origin: Schema.optional(
    Schema.Struct({
      version: Schema.Literal(1),
      table: Schema.Literals(["upstream_commands", "upstream_operations", "integrity_operations"]),
      row_key: Schema.String,
      database_sha256: Schema.String,
      payload_sha256: Schema.String,
      payload_bytes: Schema.Number,
      row_metadata: Schema.Unknown,
      verified: Schema.Boolean,
      receipt_ref: Schema.String,
    }),
  ),
  source_semantics: Schema.optional(
    Schema.Literals(["fixed_git_v1", "legacy_fixed_git_member_v1", "unsupported", "unknown"]),
  ),
  fixed_source: Schema.optional(Schema.Unknown),
})
const InventorySchema = Schema.Struct({
  complete: Schema.Boolean,
  items: Schema.Array(PreservedItemSchema),
})
export { InventorySchema as SharedMigrationPreservationInventorySchema }
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
  /** Optional supplied receipts; the read-only planner cannot verify their external contents. */
  readiness_evidence: Schema.optional(
    Schema.Struct({
      version: Schema.Literal(1),
      /** Canonical SHA-256 of this entire input without readiness_evidence. */
      basis_sha256: Schema.String,
      operations: Schema.Array(
        Schema.Struct({
          legacy_id: Schema.String,
          impact: Schema.Struct({
            /** Complete affected-target closure, including indirect binding/member effects. */
            complete: Schema.Boolean,
            legacy_ids: Schema.Array(Schema.String),
            receipt_ref: Schema.String,
          }),
          isolation: Schema.Struct({
            verified: Schema.Boolean,
            receipt_ref: Schema.String,
            recovery: Schema.Struct({
              action: Schema.Literals(["inspect_original", "reconcile_original"]),
              reference: Schema.String,
            }),
          }),
        }),
      ),
    }),
  ),
})
export type SharedMigrationInput = typeof SharedMigrationInputSchema.Type
