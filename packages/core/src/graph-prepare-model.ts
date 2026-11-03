import { Schema } from "effect"
import { ContentKindSchema, ContentRecordSchema, FileEntrySchema } from "./model.ts"
import {
  NativeReferenceIndexSchema,
  NativeReferenceSchema,
} from "./shared-native-reference-model.ts"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const SnapshotId = Schema.String.check(Schema.isPattern(/^s_[a-f0-9]{64}$/u))
const Natural = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Positive = Natural.check(Schema.isGreaterThan(0))

export const PreparePurposeSchema = Schema.Literals(["use", "inspect"])
export const PrepareRoleSchema = Schema.Literals(["root", "required", "member", "reference"])
export type PrepareRole = typeof PrepareRoleSchema.Type
export const PrepareFreshnessSchema = Schema.Union([
  Schema.Struct({ policy: Schema.Literal("default") }),
  Schema.Struct({ policy: Schema.Literal("refresh") }),
  Schema.Struct({ policy: Schema.Literal("offline") }),
  Schema.Struct({ policy: Schema.Literal("max_age"), max_age_ms: Natural }),
])
export const PrepareBudgetSchema = Schema.Struct({
  maxNodes: Schema.optional(Positive),
  maxDepth: Schema.optional(Natural),
  maxInstructionBytes: Schema.optional(Positive),
  maxContextBytes: Schema.optional(Positive),
})
export const PREPARE_DEFAULT_BUDGET = {
  maxNodes: 64,
  maxDepth: 16,
  maxInstructionBytes: 1024 * 1024,
  maxContextBytes: 256 * 1024,
} as const

/** A binding is a selected immutable main file, never evidence of delivery or activation. */
export const PrepareBindingSchema = Schema.Struct({
  record: ContentRecordSchema,
  scope: Sha,
  snapshot_id: SnapshotId,
  version_id: Schema.String,
  body_sha256: Sha,
  ref: Schema.String,
})
export type PrepareBinding = typeof PrepareBindingSchema.Type
export const PrepareSessionBindingsSchema = Schema.Array(PrepareBindingSchema)
export const PrepareInputSchema = Schema.Struct({
  roots: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)),
  purpose: PreparePurposeSchema,
  sessionBindings: Schema.optional(PrepareSessionBindingsSchema),
  freshness: Schema.optional(PrepareFreshnessSchema),
  budget: Schema.optional(PrepareBudgetSchema),
})
export type PrepareInput = typeof PrepareInputSchema.Type

export const PrepareDirectoryEntrySchema = Schema.Struct({
  id: Schema.String,
  ref: Schema.String,
  kind: Schema.Union([ContentKindSchema, Schema.Literal("file")]),
  name: Schema.String,
  description: Schema.String,
  availability: Schema.Literals(["available", "disabled", "tombstone", "metadata_only"]),
})
export type PrepareDirectoryEntry = typeof PrepareDirectoryEntrySchema.Type
export const PrepareFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
})
const NodeIdentity = {
  id: Schema.String,
  ref: Schema.String,
  roles: Schema.Array(PrepareRoleSchema),
}
const Freshness = Schema.Struct({
  policy: Schema.Literals(["default", "refresh", "offline", "max_age", "pinned"]),
  validated_at: Schema.optional(Schema.String),
  age_ms: Schema.optional(Schema.Number),
  max_age_ms: Schema.optional(Schema.Number),
  stale: Schema.optional(Schema.Boolean),
  validation: Schema.optional(Schema.Literal("metadata")),
})
export const PreparedNodeSchema = Schema.Struct({
  ...NodeIdentity,
  state: Schema.Literal("prepared"),
  kind: ContentKindSchema,
  record: ContentRecordSchema,
  binding: PrepareBindingSchema,
  path: Schema.String,
  content: Schema.String,
  bytes: Natural,
  body_sha256: Sha,
  files: Schema.Array(Schema.Struct({ ...FileEntrySchema.fields, ref: Schema.String })),
  required: Schema.Array(PrepareDirectoryEntrySchema),
  candidates: Schema.Array(PrepareDirectoryEntrySchema),
  references: Schema.Array(NativeReferenceSchema),
  unresolved_references: NativeReferenceIndexSchema.fields.unresolved,
  source: Schema.optional(Schema.Literals(["notion", "local_cache", "local_snapshot"])),
  freshness: Schema.optional(Freshness),
})
export type PreparedNode = typeof PreparedNodeSchema.Type
export const PrepareNodeSchema = Schema.Union([
  PreparedNodeSchema,
  Schema.Struct({
    ...PrepareDirectoryEntrySchema.fields,
    ...NodeIdentity,
    state: Schema.Literal("known"),
  }),
  Schema.Struct({
    ...NodeIdentity,
    state: Schema.Literals(["failed", "deferred"]),
    error: PrepareFailureSchema,
  }),
])
export type PrepareNode = typeof PrepareNodeSchema.Type
const Root = Schema.Struct({
  target: Schema.String,
  id: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  readiness: Schema.Literals(["ready", "not_ready"]),
})
const RequiredEdge = Schema.Struct({ from: Schema.String, to: Schema.String, ref: Schema.String })
export const PrepareGraphLockSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("observed_version_vector"),
  purpose: PreparePurposeSchema,
  scope: Sha,
  roots: Schema.Array(Schema.String),
  required: Schema.Array(RequiredEdge),
  bindings: PrepareSessionBindingsSchema,
  sha256: Sha,
})
const ResultFields = {
  version: Schema.Literal(1),
  purpose: PreparePurposeSchema,
  scope: Sha,
  roots: Schema.Array(Root),
  nodes: Schema.Array(PrepareNodeSchema),
  required: Schema.Array(RequiredEdge),
  required_closure: Schema.Array(Schema.String),
  budget: Schema.Struct({
    maxNodes: Positive,
    maxDepth: Natural,
    maxInstructionBytes: Positive,
    maxContextBytes: Positive,
  }),
  usage: Schema.Struct({
    prepared_nodes: Natural,
    instruction_bytes: Natural,
    context_bytes: Natural,
    max_depth: Natural,
  }),
}
export const PrepareReadySchema = Schema.Struct({
  ...ResultFields,
  status: Schema.Literal("ready"),
  session_bindings: PrepareSessionBindingsSchema,
  graph_lock: PrepareGraphLockSchema,
  /** Optional diagnostic telemetry, excluded from the model-context byte budget. */
  preparation_metrics: Schema.optional(
    Schema.Struct({
      version: Schema.Literal(1),
      root_ready_ms: Natural,
      required_ready_ms: Natural,
      elapsed_ms: Natural,
      derived_cache_hits: Natural,
      derived_cache_misses: Natural,
    }),
  ),
})
export type PrepareReady = typeof PrepareReadySchema.Type
export const PrepareIncompleteSchema = Schema.Struct({
  ...ResultFields,
  status: Schema.Literals(["failed", "partial", "deferred"]),
  observed_bindings: PrepareSessionBindingsSchema,
  errors: Schema.Array(Schema.Struct({ target: Schema.String, ...PrepareFailureSchema.fields })),
})
export type PrepareIncomplete = typeof PrepareIncompleteSchema.Type
export const PrepareResultSchema = Schema.Union([PrepareReadySchema, PrepareIncompleteSchema])
