import { Schema } from "effect"
import { FileEntrySchema } from "./model.ts"
import { ResourceContentSchema } from "./shared-file-state.ts"
import { PreparedSharedResourceSchema } from "./shared-resource-content.ts"
import { SharedGitSourceBindingSchema } from "./shared-source-binding-model.ts"

const fields = { baseline: SharedGitSourceBindingSchema, manifest: Schema.Array(FileEntrySchema) }
export const SharedCreateLocalSchema = Schema.Struct({
  ...fields,
  baseline_inputs: Schema.Array(
    Schema.Struct({ path: Schema.String, prepared: PreparedSharedResourceSchema }),
  ),
})
export const SharedCreateLocalManifestSchema = Schema.Struct({
  ...fields,
  baseline_inputs: Schema.Array(
    Schema.Struct({ path: Schema.String, content: ResourceContentSchema }),
  ),
})
export type SharedCreateLocal = typeof SharedCreateLocalSchema.Type
export type SharedCreateLocalManifest = typeof SharedCreateLocalManifestSchema.Type
