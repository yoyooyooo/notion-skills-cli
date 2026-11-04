import { Schema } from "effect"
import {
  PrepareBindingSchema,
  PrepareFailureSchema,
  PrepareInputSchema,
  PrepareReadySchema,
  PreparedNodeSchema,
} from "./graph-prepare-model.ts"
import { SnapshotSchema } from "./model.ts"

export const CONSUMER_CONTRACT_VERSION = 1
export const SOURCE_IDENTITY_COMPILER = "source-identity/v1"

/** Versioned boundary input. Nonempty requestedFiles is reserved, not silently ignored. */
export const ConsumeInputSchema = Schema.Struct({
  version: Schema.Literal(CONSUMER_CONTRACT_VERSION),
  targets: PrepareInputSchema.fields.roots,
  purpose: PrepareInputSchema.fields.purpose,
  sessionBindings: PrepareInputSchema.fields.sessionBindings,
  freshness: PrepareInputSchema.fields.freshness,
  budget: PrepareInputSchema.fields.budget,
  requestedFiles: Schema.optional(Schema.Array(PreparedNodeSchema.fields.ref)),
  projection: Schema.optional(Schema.Struct({ compiler: Schema.String })),
})
export type ConsumeInput = typeof ConsumeInputSchema.Type

/** Complete immutable file metadata; completeness does not imply every file is local. */
export const VerifiedManifestSchema = Schema.Struct({
  complete: Schema.Literal(true),
  scope: PrepareBindingSchema.fields.scope,
  snapshot_id: PrepareBindingSchema.fields.snapshot_id,
  historical_snapshot_id: SnapshotSchema.fields.historical_snapshot_id,
  version_id: PrepareBindingSchema.fields.version_id,
  record: SnapshotSchema.fields.record,
  entrypoint: SnapshotSchema.fields.entrypoint,
  files: SnapshotSchema.fields.files,
  file_bindings: SnapshotSchema.fields.file_bindings,
  // This describes upstream source provenance, not a model-context compiler.
  source_projection: SnapshotSchema.fields.source_projection,
})
export type VerifiedManifest = typeof VerifiedManifestSchema.Type

const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Sha = PrepareBindingSchema.fields.body_sha256
export const ConsumeEntrySchema = Schema.Struct({
  id: PreparedNodeSchema.fields.id,
  manifest: VerifiedManifestSchema,
  manifest_sha256: Sha,
  source_body: Schema.Struct({
    kind: Schema.Literal("verified_snapshot_entry"),
    ref: PreparedNodeSchema.fields.ref,
    path: PreparedNodeSchema.fields.path,
    bytes: PreparedNodeSchema.fields.bytes,
    sha256: Sha,
    range: Schema.Struct({ start: Schema.Literal(1), end: Positive, total_lines: Positive }),
    has_more: Schema.Literal(false),
  }),
  materialization: Schema.Struct({
    status: Schema.Literals(["entry_ready", "all_files_ready"]),
    paths: Schema.Array(Schema.String),
  }),
  projection: Schema.Struct({
    status: Schema.Literal("identity"),
    compiler: Schema.Literal(SOURCE_IDENTITY_COMPILER),
    source_body_sha256: Sha,
    relations_sha256: Sha,
    projection_sha256: Sha,
    bytes: PreparedNodeSchema.fields.bytes,
  }),
})
export type ConsumeEntry = typeof ConsumeEntrySchema.Type

/** Body text occurs once, in preparation.nodes. Entries are machine evidence for those bytes. */
export const ConsumeReadySchema = Schema.Struct({
  version: Schema.Literal(CONSUMER_CONTRACT_VERSION),
  status: Schema.Literal("ready"),
  preparation: PrepareReadySchema,
  entries: Schema.Array(ConsumeEntrySchema),
  export: Schema.Struct({ status: Schema.Literal("not_requested") }),
  delivery: Schema.Struct({ status: Schema.Literal("not_observed") }),
  activation: Schema.Struct({ status: Schema.Literal("not_evaluated") }),
})
export type ConsumeReady = typeof ConsumeReadySchema.Type
export const ConsumeResultSchema = Schema.Union([
  ConsumeReadySchema,
  Schema.Struct({
    version: Schema.Literal(CONSUMER_CONTRACT_VERSION),
    status: Schema.Literal("failed"),
    error: PrepareFailureSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(CONSUMER_CONTRACT_VERSION),
    status: Schema.Literal("cancelled"),
    reason: Schema.Literal("interrupted"),
  }),
])
export type ConsumeResult = typeof ConsumeResultSchema.Type
