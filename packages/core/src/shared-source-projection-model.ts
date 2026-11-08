import { Schema } from "effect"
import { SharedGitSourceBindingSchema } from "./shared-source-binding-model.ts"
import {
  SharedCreateLocalSchema,
  SharedCreateLocalManifestSchema,
} from "./shared-create-local-model.ts"
import {
  SharedCreateRetainedInputSchema,
  SharedCreateRetainedManifestSchema,
} from "./shared-create-retained-model.ts"

/** Frozen source provenance for newly created pages; never authorizes replacement of an existing page. */
const fields = {
  skill_id: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u)),
  ),
  provider_committed_at: Schema.optional(Schema.String),
  definition: Schema.Struct({
    page_id: Schema.String,
    source_id: Schema.String,
    fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    member: Schema.String,
  }),
}
export const SharedSourceProjectionSchema = Schema.Union([
  Schema.Struct({
    ...fields,
    version: Schema.Literal(1),
    binding: SharedGitSourceBindingSchema,
    local: Schema.optional(SharedCreateLocalSchema),
  }),
  Schema.Struct({
    ...fields,
    version: Schema.Literal(2),
    provider_revision: Schema.String,
    retained: SharedCreateRetainedInputSchema,
  }),
])
export const SharedSourceProjectionManifestSchema = Schema.Union([
  Schema.Struct({
    ...fields,
    version: Schema.Literal(1),
    binding: SharedGitSourceBindingSchema,
    local: Schema.optional(SharedCreateLocalManifestSchema),
  }),
  Schema.Struct({
    ...fields,
    version: Schema.Literal(2),
    provider_revision: Schema.String,
    retained: SharedCreateRetainedManifestSchema,
  }),
])
export type SharedSourceProjection = typeof SharedSourceProjectionSchema.Type
