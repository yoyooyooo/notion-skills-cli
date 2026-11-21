import { Schema } from "effect"

export const SourcePrerequisiteUnavailableSchema = Schema.Struct({
  from_path: Schema.String,
  href: Schema.String,
  reason: Schema.Literal("outside_source_root"),
})
export type SourcePrerequisiteUnavailable = typeof SourcePrerequisiteUnavailableSchema.Type

export const SourceExternalResourceSchema = Schema.Struct({
  source_path: Schema.String,
  git_oid: Schema.String,
  sha256: Schema.String,
  mode: Schema.Literals(["100644", "100755"]),
  bytes: Schema.Uint8Array,
})
