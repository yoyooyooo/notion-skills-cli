import { Schema } from "effect"
import { VerifiedManifestSchema } from "./consumer-model.ts"
import { PrepareBindingSchema, PrepareFailureSchema } from "./graph-prepare-model.ts"
import { FileEntrySchema } from "./model.ts"
import { ConsumptionEffectsSchema } from "./consumption-effects.ts"

export const RESOURCE_READ_CONTRACT_VERSION = 1
export const RESOURCE_READ_EFFECTS_VERSION = 1
export const RESOURCE_READ_DEFAULT_BUDGET = {
  maxFiles: 16,
  maxBytes: 1_048_576,
  timeBudgetMs: 30_000,
} as const
export const RESOURCE_READ_MAX_BUDGET = {
  maxFiles: 64,
  maxBytes: 16_777_216,
  timeBudgetMs: 120_000,
} as const

const BudgetFields = {
  maxFiles: Schema.Number,
  maxBytes: Schema.Number,
  timeBudgetMs: Schema.Number,
}
export const ResourceReadInputSchema = Schema.Struct({
  version: Schema.Literal(RESOURCE_READ_CONTRACT_VERSION),
  refs: Schema.Array(Schema.String),
  budget: Schema.optional(
    Schema.Struct({
      maxFiles: Schema.optional(BudgetFields.maxFiles),
      maxBytes: Schema.optional(BudgetFields.maxBytes),
      timeBudgetMs: Schema.optional(BudgetFields.timeBudgetMs),
    }),
  ),
})
export type ResourceReadInput = typeof ResourceReadInputSchema.Type

export const ResourceReadFileSchema = Schema.Struct({
  requested_ref: Schema.String,
  ref: Schema.String,
  file_id: Schema.optional(Schema.String),
  path: Schema.String,
  bytes: Schema.Number,
  sha256: PrepareBindingSchema.fields.body_sha256,
  mode: FileEntrySchema.fields.mode,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
})
export type ResourceReadFile = typeof ResourceReadFileSchema.Type

export const ResourceReadReadySchema = Schema.Struct({
  version: Schema.Literal(RESOURCE_READ_CONTRACT_VERSION),
  status: Schema.Literal("ready"),
  effects: Schema.optional(ConsumptionEffectsSchema),
  manifest: VerifiedManifestSchema,
  manifest_sha256: PrepareBindingSchema.fields.body_sha256,
  selection: Schema.Struct({
    scope: PrepareBindingSchema.fields.scope,
    owner: Schema.String,
    snapshot_id: PrepareBindingSchema.fields.snapshot_id,
    version_id: PrepareBindingSchema.fields.version_id,
  }),
  budget: Schema.Struct(BudgetFields),
  files: Schema.Array(ResourceReadFileSchema),
  totals: Schema.Struct({ files: Schema.Number, bytes: Schema.Number }),
  materialization: Schema.Struct({
    status: Schema.Literal("selected_files_ready"),
    paths: Schema.Array(Schema.String),
  }),
  delivery: Schema.Struct({ status: Schema.Literal("not_observed") }),
})
export type ResourceReadReady = typeof ResourceReadReadySchema.Type
export const ResourceReadResultSchema = Schema.Union([
  ResourceReadReadySchema,
  Schema.Struct({
    version: Schema.Literal(RESOURCE_READ_CONTRACT_VERSION),
    status: Schema.Literal("failed"),
    effects: Schema.optional(ConsumptionEffectsSchema),
    error: PrepareFailureSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(RESOURCE_READ_CONTRACT_VERSION),
    status: Schema.Literal("cancelled"),
    effects: Schema.optional(ConsumptionEffectsSchema),
    reason: Schema.Literal("interrupted"),
  }),
])
export type ResourceReadResult = typeof ResourceReadResultSchema.Type
