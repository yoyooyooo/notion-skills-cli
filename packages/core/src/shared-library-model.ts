import { Schema } from "effect"

/** Pure descriptor schemas. This module must not import model or a Notion service. */
export const LIBRARY_MARKER = "ntn-skills-library:v1 "
export const TableBindingSchema = Schema.Struct({
  database_id: Schema.String,
  data_source_id: Schema.String,
  property_ids: Schema.Record(Schema.String, Schema.String),
})
export const SharedLibrarySchema = Schema.Struct({
  version: Schema.Literal(1),
  library_id: Schema.String,
  operation_id: Schema.String,
  parent_page_id: Schema.String,
  skills: TableBindingSchema,
  files: TableBindingSchema,
  records: TableBindingSchema,
})
export type SharedLibrary = typeof SharedLibrarySchema.Type
export type TableBinding = typeof TableBindingSchema.Type
