import { Schema } from "effect"
export const SharedSkillRelationFieldSchema = Schema.Literals(["Members", "Requires"])
export type SharedSkillRelationField = typeof SharedSkillRelationFieldSchema.Type

/** Pure descriptor schemas. This module must not import model or a Notion service. */
export const LIBRARY_MARKER = "ntn-skills-library:v2 "
export const LibraryIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
export const TableBindingSchema = Schema.Struct({
  database_id: Schema.String,
  data_source_id: Schema.String,
  property_ids: Schema.Record(Schema.String, Schema.String),
})
export const SharedLibrarySchema = Schema.Struct({
  version: Schema.Literal(2),
  library_id: LibraryIdSchema,
  operation_id: Schema.String,
  skills: TableBindingSchema,
  files: TableBindingSchema,
  records: TableBindingSchema,
  sources: TableBindingSchema,
})
export type SharedLibrary = typeof SharedLibrarySchema.Type
export type TableBinding = typeof TableBindingSchema.Type

export const LibraryTableRoleSchema = Schema.Literals(["Skills", "Files", "Records", "Sources"])
export type LibraryTableRole = typeof LibraryTableRoleSchema.Type
export const LibraryInitializationActionSchema = Schema.Literals([
  "create:root",
  "create:Skills",
  "create:Files",
  "create:Records",
  "create:Sources",
  "members",
  "origins",
  "descriptor",
])
export type LibraryInitializationAction = typeof LibraryInitializationActionSchema.Type
const InitializationHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const LibraryInitializationPendingSchema = Schema.Struct({
  version: Schema.Literal(2),
  scope: InitializationHash,
  operation_id: Schema.String.check(Schema.isPattern(/^library-[a-zA-Z0-9-]{1,80}$/u)),
  parent_page_id: Schema.String.check(
    Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
  ),
  root_page_id: Schema.NullOr(LibraryIdSchema),
  tables: Schema.Struct({
    Skills: Schema.optional(TableBindingSchema),
    Files: Schema.optional(TableBindingSchema),
    Records: Schema.optional(TableBindingSchema),
    Sources: Schema.optional(TableBindingSchema),
  }),
  in_flight: Schema.NullOr(
    Schema.Struct({
      action: LibraryInitializationActionSchema,
      request_sha256: InitializationHash,
    }),
  ),
})
export type LibraryInitializationPending = typeof LibraryInitializationPendingSchema.Type

export function preservesTableBinding(before: TableBinding, after: TableBinding): boolean {
  return (
    before.database_id === after.database_id &&
    before.data_source_id === after.data_source_id &&
    Object.entries(before.property_ids).every(([name, id]) => after.property_ids[name] === id)
  )
}

/** Only unfinished initialization is retained. Known table identities can grow, never change. */
export function preservesLibraryInitialization(
  before: LibraryInitializationPending,
  after: LibraryInitializationPending,
): boolean {
  return (
    before.version === after.version &&
    before.scope === after.scope &&
    before.operation_id === after.operation_id &&
    before.parent_page_id === after.parent_page_id &&
    (before.root_page_id === null || before.root_page_id === after.root_page_id) &&
    (["Skills", "Files", "Records", "Sources"] as const).every((role) => {
      const table = before.tables[role],
        next = after.tables[role]
      return table === undefined || (next !== undefined && preservesTableBinding(table, next))
    })
  )
}

/** Additive registrations do not replace any identity frozen by an older operation. */
export function preservesSharedLibraryBindings(
  original: SharedLibrary,
  current: SharedLibrary,
): boolean {
  if (
    original.version !== current.version ||
    original.library_id !== current.library_id ||
    original.operation_id !== current.operation_id
  )
    return false
  for (const role of ["skills", "files", "records", "sources"] as const) {
    const before = original[role],
      after = current[role]
    if (before.database_id !== after.database_id || before.data_source_id !== after.data_source_id)
      return false
    for (const [name, id] of Object.entries(before.property_ids)) {
      if (after.property_ids[name] !== id) return false
    }
  }
  return true
}
