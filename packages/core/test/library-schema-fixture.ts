import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { sharedSkillProperties, sharedFileProperties, sharedRecordProperties, sharedRelationProperty } from "../src/shared-library.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { property } from "../src/model.ts"

/** Independent Notion topology for reader/writer boundary fixtures. */
export function librarySchemaResponse(path: string, library: SharedLibrary): unknown | undefined {
  const route = path.split("?")[0]!
  const roles = ["skills", "files", "records", "sources"] as const
  if (route === `v1/pages/${library.library_id}`)
    return { object: "page", id: library.library_id, parent: { type: "workspace", workspace: true }, in_trash: false, properties: {} }
  if (route === `v1/blocks/${library.library_id}/children`)
    return { results: roles.map(role => ({ id: library[role].database_id, type: "child_database" })), has_more: false, next_cursor: null }
  for (const role of roles) {
    const binding = library[role]
    if (route === `v1/databases/${binding.database_id}`)
      return { object: "database", id: binding.database_id, parent: { type: "page_id", page_id: library.library_id }, database_type: null, title: [{ plain_text: role }], data_sources: [{ id: binding.data_source_id, name: role }], description: role === "skills" ? [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }] : [], in_trash: false }
    if (route !== `v1/data_sources/${binding.data_source_id}`) continue
    const origin = (field: "Skills" | "Records") => ({ relation: { data_source_id: library.sources.data_source_id, dual_property: { synced_property_id: library.sources.property_ids[field] } } })
    const sourceLayout = sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id)
    const layouts = {
      skills: { ...sharedSkillProperties, Members: sharedRelationProperty(library.skills.data_source_id), Requires: sharedRelationProperty(library.skills.data_source_id), Origin: origin("Skills") },
      files: { ...sharedFileProperties(library.skills.data_source_id), Origin: { rollup: { relation_property_id: library.files.property_ids.Skill, rollup_property_id: library.skills.property_ids.Origin, function: "show_unique" } } },
      records: { ...sharedRecordProperties(library.skills.data_source_id), Origin: origin("Records") },
      sources: { ...sourceLayout, ...Object.fromEntries((["Skills", "Records"] as const).map(field => [field, { relation: { data_source_id: library[field === "Skills" ? "skills" : "records"].data_source_id, dual_property: { synced_property_id: library[field === "Skills" ? "skills" : "records"].property_ids.Origin } } }])) },
    }
    const properties = Object.fromEntries(Object.entries(layouts[role]).map(([name, raw]) => {
      const field = property(raw), type = Object.keys(field)[0]!
      const relation = property(field.relation)
      return [name, { ...field, id: binding.property_ids[name], name, type, ...(type === "relation" ? { relation: { ...relation, type: relation.single_property === undefined ? "dual_property" : "single_property" } } : {}) }]
    }))
    return { object: "data_source", id: binding.data_source_id, parent: { database_id: binding.database_id }, properties, title: [{ plain_text: role }], in_trash: false }
  }
  return undefined
}
