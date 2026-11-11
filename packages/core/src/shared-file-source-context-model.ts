import { Schema } from "effect"

/** Pure identities: importing a body plan must not initialize provider or reader modules. */
export const SharedFileSourceContextSchema = Schema.Struct({
  selected_version: Schema.String,
  definition: Schema.NullOr(
    Schema.Struct({
      page_id: Schema.String,
      source_id: Schema.String,
      fingerprint: Schema.String,
      member: Schema.String,
    }),
  ),
})
export type SharedFileSourceContext = typeof SharedFileSourceContextSchema.Type
