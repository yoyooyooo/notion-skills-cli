import { Schema } from "effect"
export const SharedSkillRelationFieldSchema = Schema.Literals(["Members", "Requires"])
export type SharedSkillRelationField = typeof SharedSkillRelationFieldSchema.Type

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
  sources: Schema.optional(TableBindingSchema),
})
export type SharedLibrary = typeof SharedLibrarySchema.Type
export type TableBinding = typeof TableBindingSchema.Type

/** Additive registrations do not replace any identity frozen by an older operation. */
export function preservesSharedLibraryBindings(
  original: SharedLibrary,
  current: SharedLibrary,
): boolean {
  if (
    original.version !== current.version ||
    original.library_id !== current.library_id ||
    original.operation_id !== current.operation_id ||
    original.parent_page_id !== current.parent_page_id
  )
    return false
  for (const role of ["skills", "files", "records", "sources"] as const) {
    const before = original[role],
      after = current[role]
    if (before === undefined) continue
    if (
      after === undefined ||
      before.database_id !== after.database_id ||
      before.data_source_id !== after.data_source_id
    )
      return false
    for (const [name, id] of Object.entries(before.property_ids)) {
      if (after.property_ids[name] !== id) return false
    }
  }
  return true
}
