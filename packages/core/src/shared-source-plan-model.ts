import { Schema } from "effect"
import { FileEntrySchema } from "./model.ts"

/** Pure current provider-plan schemas. No readers, management operations or local bindings. */
const FixedManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(FileEntrySchema),
})
const GitSourceSchema = Schema.Struct({
  url: Schema.String,
  commit: Schema.String,
  root: Schema.String,
  tree: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      source_path: Schema.String,
      git_oid: Schema.String,
      bytes: Schema.Number,
      mode: Schema.optional(Schema.Literals(["100644", "100755"])),
      sha256: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
    }),
  ),
})
const ResourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("git"), source: GitSourceSchema }),
  Schema.Struct({
    kind: Schema.Literal("http"),
    manifest: FixedManifestSchema,
    locations: Schema.Array(Schema.Struct({ sha256: Schema.String, url: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    binding_key: Schema.String,
    machine_scope: Schema.String,
    workspace_scope: Schema.String,
    manifest: FixedManifestSchema,
  }),
])

export const SharedSourcePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("composition"),
  base: Schema.NullOr(ResourceSchema),
  mounts: Schema.Array(Schema.Struct({ mount_path: Schema.String, resource: ResourceSchema })),
})
