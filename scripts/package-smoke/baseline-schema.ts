// Frozen installed-consumer contract from integration1 cli-source-inputs.tar.gz.
// Keep this baseline independent of in-flight product model changes.
import { Effect, Schema } from "effect"

const SourceSchema = Schema.Struct({
  alias: Schema.String,
  database_id: Schema.String,
  title: Schema.String,
  data_source_ids: Schema.Array(Schema.String),
})
export const SkillSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  alias: Schema.String,
  description: Schema.String,
  default_context: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  database_id: Schema.String,
  data_source_id: Schema.String,
  ref: Schema.String,
})
const SourceFailureSchema = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  database_id: Schema.String,
  alias: Schema.String,
  title: Schema.String,
  data_source_id: Schema.optional(Schema.String),
})
const CoverageSchema = Schema.Struct({
  method: Schema.String,
  exhaustive: Schema.Boolean,
  queried_data_sources: Schema.Array(Schema.String),
  failed_sources: Schema.Array(SourceFailureSchema),
  search_index_limited: Schema.Boolean,
})
export const CatalogSchema = Schema.Struct({
  scope: Schema.String,
  fetched_at: Schema.Number,
  databases: Schema.Array(SourceSchema),
  skills: Schema.Array(SkillSchema),
  coverage: CoverageSchema,
})
