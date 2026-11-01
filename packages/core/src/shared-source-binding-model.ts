import { Schema } from "effect"

export const SharedGitSourceBindingSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("git"),
  source_id: Schema.String.check(Schema.isPattern(/^source-[a-f0-9]{64}$/u)),
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
    }),
  ),
})
export type SharedGitSourceBinding = typeof SharedGitSourceBindingSchema.Type
