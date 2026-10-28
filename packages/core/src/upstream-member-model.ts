import { Schema } from "effect"
import { GitMaterializationSchema } from "./upstream-source-model.ts"

export const SourcePrerequisiteUnavailableSchema = Schema.Struct({
  from_path: Schema.String,
  href: Schema.String,
  reason: Schema.Literal("outside_source_root"),
})
export type SourcePrerequisiteUnavailable = typeof SourcePrerequisiteUnavailableSchema.Type
export const SourceLinkUnavailableSchema = Schema.Struct({
  from_path: Schema.String,
  href: Schema.String,
  reason: Schema.Literals([
    "outside_source_root",
    "published_map_unavailable",
    "target_unavailable",
  ]),
})
export type SourceLinkUnavailable = typeof SourceLinkUnavailableSchema.Type

export const SourceExternalResourceSchema = Schema.Struct({
  source_path: Schema.String,
  git_oid: Schema.String,
  sha256: Schema.String,
})
export const SourceMemberManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  source_id: Schema.String,
  revision: Schema.String,
  external_resources: Schema.optional(Schema.Array(SourceExternalResourceSchema)),
  unavailable: Schema.optional(Schema.Array(SourcePrerequisiteUnavailableSchema)),
  members: Schema.Array(
    Schema.Struct({
      member_key: Schema.String,
      source_path: Schema.String,
      upstream_hash: Schema.optional(Schema.String),
      git_materialization: Schema.optional(GitMaterializationSchema),
      main: Schema.optional(Schema.String),
      resources: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    }),
  ),
})
export type SourceMemberManifest = typeof SourceMemberManifestSchema.Type
export const SourceProjectionSchema = Schema.Struct({
  source_id: Schema.String,
  revision: Schema.String,
  manifest_hash: Schema.String,
  unavailable: Schema.optional(Schema.Array(SourceLinkUnavailableSchema)),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, source_hash: Schema.String, derived_hash: Schema.String }),
  ),
})
