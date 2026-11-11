import { Schema } from "effect"
import { FileEntrySchema } from "./model.ts"

/** A complete immutable input before Notion allocates the Skill page. The existing
 * retained_bundle identity is derived only after that original allocation ACK. */
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const fields = {
  mode_policy: Schema.Literal("regular_file_when_unspecified"),
  mode_defaulted_paths: Schema.Array(Schema.String),
  entrypoint: Schema.String,
  files: Schema.Array(FileEntrySchema),
  archive: Schema.Struct({
    format: Schema.Literal("zip"),
    sha256: Hash,
    bytes: Schema.Number,
    chunks: Schema.Array(
      Schema.Struct({ object_id: Schema.String, sha256: Hash, bytes: Schema.Number }),
    ),
  }),
}
export const SharedCreateRetainedManifestSchema = Schema.Struct(fields)
export const SharedCreateRetainedInputSchema = Schema.Struct({
  ...fields,
  archive_base64: Schema.String,
})
export type SharedCreateRetainedInput = typeof SharedCreateRetainedInputSchema.Type
export type SharedCreateRetainedManifest = typeof SharedCreateRetainedManifestSchema.Type
