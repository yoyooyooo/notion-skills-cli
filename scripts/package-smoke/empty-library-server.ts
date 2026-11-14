import assert from "node:assert/strict"
import { property, text } from "../../packages/core/src/model.ts"
import { createRelationsLibrary } from "../../packages/core/test/shared-create-fixture.ts"
import { id } from "../../packages/core/test/shared-snapshot-fixture.ts"

/** A schema-only extension of the existing authoring HTTP fixture. It starts
 * with no databases and stores only what the public initializer actually sends.
 * Business rows, consumer snapshots and operation receipts are never seeded. */
export function emptyLibraryServer() {
  const parent = id(97_000),
    sources = { database_id: id(97_001), data_source_id: id(97_002) }
  const roles = {
    Skills: createRelationsLibrary.skills,
    Files: createRelationsLibrary.files,
    Records: createRelationsLibrary.records,
    Sources: sources,
  }
  const databases = new Map<string, Record<string, unknown>>()
  const schemas = new Map<string, Record<string, unknown>>()
  const observedRichText = (value: unknown) =>
    Array.isArray(value)
      ? value.map((part) => ({ ...property(part), plain_text: text([part]) }))
      : []
  let fieldCounter = 0
  const setFields = (schema: Record<string, unknown>, updates: unknown) => {
    const fields = property(schema.properties)
    for (const [key, raw] of Object.entries(property(updates))) {
      const currentName =
        Object.keys(fields).find((name) => property(fields[name]).id === key) ?? key
      const sourceRole = Object.values(roles).find((role) => role.data_source_id === schema.id)
      const registered = sourceRole && "property_ids" in sourceRole ? sourceRole.property_ids : {}
      const fieldId =
        property(fields[currentName]).id ??
        registered[currentName] ??
        (currentName === "Name" ? "title" : `empty-field-${++fieldCounter}`)
      const input = property(raw),
        type = Object.keys(input)[0]!
      const value = structuredClone(property(input[type]))
      if (type === "relation") {
        value.type = Object.hasOwn(value, "dual_property") ? "dual_property" : "single_property"
        if (value.type === "dual_property") {
          const target = schemas.get(String(value.data_source_id))
          const desired = String(
            property(value.dual_property).synced_property_name ?? `reverse-${fieldId}`,
          )
          if (target) {
            const targetFields = property(target.properties),
              reverseId = property(targetFields[desired]).id ?? `empty-field-${++fieldCounter}`
            targetFields[desired] = {
              id: reverseId,
              name: desired,
              type: "relation",
              relation: {
                type: "dual_property",
                data_source_id: schema.id,
                dual_property: { synced_property_id: fieldId, synced_property_name: currentName },
              },
            }
            value.dual_property = {
              ...property(value.dual_property),
              synced_property_id: reverseId,
              synced_property_name: desired,
            }
          }
        }
      }
      if (type === "rollup") {
        const relationName = value.relation_property_name
        const relation =
          relationName === undefined
            ? Object.values(fields).find((x) => property(x).id === value.relation_property_id)
            : fields[String(relationName)]
        if (relation) {
          value.relation_property_id = property(relation).id
          const target = schemas.get(String(property(property(relation).relation).data_source_id))
          if (target && value.rollup_property_name !== undefined)
            value.rollup_property_id = property(
              property(target.properties)[String(value.rollup_property_name)],
            ).id
        }
      }
      fields[currentName] = { id: fieldId, name: currentName, type, [type]: value }
    }
  }
  const request = (
    path: string,
    body: unknown,
    method: string,
  ): { handled: true; value: unknown } | undefined => {
    const pathname = new URL(path, "http://127.0.0.1").pathname
    if (pathname === `/v1/blocks/${parent}/children`)
      return {
        handled: true,
        value: {
          object: "list",
          results: [...databases.values()].map((db) => ({
            object: "block",
            id: db.id,
            type: "child_database",
            child_database: { title: text(db.title) },
          })),
          has_more: false,
          next_cursor: null,
        },
      }
    if (pathname === "/v1/databases" && method === "POST") {
      const input = property(body),
        name = text(input.title)
      assert.ok(Object.hasOwn(roles, name))
      assert.equal(property(input.parent).page_id, parent)
      const role = Object.entries(roles).find(([key]) => key === name)![1]
      assert.equal(databases.has(role.database_id), false, "Initializer must not duplicate a table")
      const db = {
        object: "database",
        id: role.database_id,
        database_type: null,
        parent: { type: "page_id", page_id: parent },
        title: observedRichText(input.title),
        description: observedRichText(input.description),
        in_trash: false,
        is_inline: false,
        data_sources: [{ id: role.data_source_id, name }],
      }
      const schema = {
        object: "data_source",
        id: role.data_source_id,
        parent: { type: "database_id", database_id: role.database_id },
        in_trash: false,
        properties: {},
      }
      databases.set(role.database_id, db)
      schemas.set(role.data_source_id, schema)
      setFields(schema, property(input.initial_data_source).properties)
      return { handled: true, value: structuredClone(db) }
    }
    const db = databases.get(pathname.replace(/^\/v1\/databases\//u, ""))
    if (db) {
      if (method === "PATCH") {
        Object.assign(db, property(body))
        db.title = observedRichText(db.title)
        db.description = observedRichText(db.description)
      }
      return { handled: true, value: structuredClone(db) }
    }
    const schema = schemas.get(pathname.replace(/^\/v1\/data_sources\//u, ""))
    if (schema) {
      if (method === "PATCH") setFields(schema, property(body).properties)
      return { handled: true, value: structuredClone(schema) }
    }
    if (pathname === `/v1/data_sources/${sources.data_source_id}/query`)
      return {
        handled: true,
        value: { object: "list", results: [], has_more: false, next_cursor: null },
      }
    return undefined
  }
  return { parent, request, count: () => databases.size }
}
