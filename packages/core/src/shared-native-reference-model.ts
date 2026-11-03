import { Schema } from "effect"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Page = Schema.String.check(Schema.isUUID())
export const NativeFileIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f]+$/u),
)
export const NativeFileBindingSchema = Schema.Struct({
  file_id: NativeFileIdSchema,
  page_id: Page,
  path: Schema.String,
})
export const NativeReferenceSchema = Schema.Struct({
  from: Schema.String,
  href: Schema.String,
  id: Schema.String,
  ref: Schema.String,
  kind: Schema.Literals(["skill", "file"]),
  name: Schema.String,
  description: Schema.String,
  availability: Schema.Literals(["available", "disabled", "tombstone", "metadata_only"]),
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Page,
  page_id: Page,
  file_id: Schema.optional(NativeFileIdSchema),
  path: Schema.String,
  block_id: Schema.optional(Page),
  source_form: Schema.optional(Schema.Literal("link_to_page")),
})
export type NativeReference = typeof NativeReferenceSchema.Type
export const NativeReferenceIndexSchema = Schema.Struct({
  version: Schema.Literal(1),
  parser_version: Schema.Literals([1, 2]),
  parent_id: Schema.String,
  source_files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      body_sha256: Sha,
      input_sha256: Sha,
      completion_sha256: Schema.optional(Sha),
    }),
  ),
  relations_sha256: Sha,
  index_sha256: Sha,
  entries: Schema.Array(NativeReferenceSchema),
  unresolved: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      href: Schema.String,
      page_id: Page,
      availability: Schema.Literal("unmanaged_or_unavailable"),
      block_id: Schema.optional(Page),
      source_form: Schema.optional(Schema.Literal("link_to_page")),
    }),
  ),
})
export type NativeReferenceIndex = typeof NativeReferenceIndexSchema.Type
