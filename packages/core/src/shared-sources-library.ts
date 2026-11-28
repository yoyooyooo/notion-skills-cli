import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { matchesNotionRollup } from "./notion-rollup.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"

const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("LIBRARY_SCHEMA_CONFLICT", "Sources relation metadata is invalid."),
  })
function dataSource(raw: unknown, table: TableBinding) {
  const row = property(raw)
  if (
    row.object !== "data_source" ||
    row.id !== table.data_source_id ||
    row.in_trash === true ||
    row.archived === true ||
    property(row.parent).database_id !== table.database_id
  )
    throw fail("LIBRARY_SCHEMA_CONFLICT", "A Sources relation refers to another data-source owner.")
  return property(row.properties)
}
function fieldById(fields: Record<string, unknown>, id: string | undefined) {
  const found = Object.values(fields)
    .map(property)
    .filter((field) => field.id === id)
  if (!id || found.length !== 1)
    throw fail("LIBRARY_SCHEMA_CONFLICT", "A registered Sources property is missing or ambiguous.")
  return found[0]!
}
function propertyId(field: Record<string, unknown>): string {
  if (typeof field.id !== "string" || !field.id || field.id.length > 256)
    throw fail("LIBRARY_SCHEMA_CONFLICT", "A Sources relation has no bounded property identity.")
  return field.id
}

/** Complete the one current four-table initialization. Reconciliation only reads
 * visible schema; missing or unknown writes never authorize another PATCH. */
export function initializeCurrentSourceRelations(library: SharedLibrary, reconcile: boolean) {
  return Effect.gen(function* () {
    const sources = library.sources
    const details = {
      operation_id: library.operation_id,
      parent_page_id: library.library_id,
      role: "Sources",
      stage: "origins",
    }
    if (sources === undefined)
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_INCOMPLETE",
          "Current initialization requires the exact Sources table.",
          details,
        ),
      )
    const api = yield* Notion
    const sourceRaw = yield* api.request(`v1/data_sources/${sources.data_source_id}`)
    const sourceFields = yield* checked(() => dataSource(sourceRaw, sources))
    const bindings: Record<"skills" | "records", string> = { skills: "", records: "" }
    for (const [role, name] of [
      ["skills", "Skills"],
      ["records", "Records"],
    ] as const) {
      const target = library[role]
      const forward = yield* checked(() => fieldById(sourceFields, sources.property_ids[name]))
      const reverseId = yield* checked(() => {
        const relation = property(forward.relation),
          dual = property(relation.dual_property)
        if (
          forward.type !== "relation" ||
          relation.type !== "dual_property" ||
          relation.data_source_id !== target.data_source_id ||
          typeof dual.synced_property_id !== "string" ||
          !dual.synced_property_id
        )
          throw fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "Sources must bind the exact Skills and Records tables through complete dual relations.",
          )
        return dual.synced_property_id
      })
      const targetRaw = yield* api.request(`v1/data_sources/${target.data_source_id}`)
      const reverse = yield* checked(() => fieldById(dataSource(targetRaw, target), reverseId))
      yield* checked(() => {
        const relation = property(reverse.relation)
        if (
          reverse.type !== "relation" ||
          relation.type !== "dual_property" ||
          relation.data_source_id !== sources.data_source_id ||
          property(relation.dual_property).synced_property_id !== propertyId(forward)
        )
          throw fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "A reverse Origin relation does not identify its exact Sources property.",
          )
        if (target.property_ids.Origin !== undefined && target.property_ids.Origin !== reverseId)
          throw fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "Initialization cannot replace a registered Origin property.",
          )
      })
      bindings[role] = reverseId
    }
    const expected = {
      relation_property_id: library.files.property_ids.Skill,
      rollup_property_id: bindings.skills,
      function: "show_unique",
    }
    const fileRaw = yield* api.request(`v1/data_sources/${library.files.data_source_id}`)
    const fileFields = yield* checked(() => dataSource(fileRaw, library.files))
    const existing = yield* checked(() =>
      library.files.property_ids.Origin === undefined
        ? property(fileFields.Origin)
        : fieldById(fileFields, library.files.property_ids.Origin),
    )
    const validateOrigin = (field: Record<string, unknown>) => {
      if (field.type !== "rollup" || !matchesNotionRollup(field.rollup, expected))
        throw fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "Files Origin must derive the selected Skills Origin through its existing Skill relation.",
        )
      return propertyId(field)
    }
    let fileOrigin: string
    if (existing.id !== undefined) fileOrigin = yield* checked(() => validateOrigin(existing))
    else {
      if (Object.keys(existing).length !== 0)
        return yield* Effect.fail(
          fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "Files Origin has an incomplete existing property.",
            details,
          ),
        )
      if (reconcile)
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_INCOMPLETE",
            "The original Files Origin schema write is not visible; reconciliation cannot repeat it.",
            details,
          ),
        )
      const result = yield* api.request(
        `v1/data_sources/${library.files.data_source_id}`,
        { properties: { Origin: { rollup: expected } } },
        { method: "PATCH" },
      )
      fileOrigin = yield* checked(() =>
        validateOrigin(property(dataSource(result, library.files).Origin)),
      )
    }
    return {
      ...library,
      skills: {
        ...library.skills,
        property_ids: { ...library.skills.property_ids, Origin: bindings.skills },
      },
      records: {
        ...library.records,
        property_ids: { ...library.records.property_ids, Origin: bindings.records },
      },
      files: {
        ...library.files,
        property_ids: { ...library.files.property_ids, Origin: fileOrigin },
      },
    }
  }).pipe(
    Effect.mapError((error) =>
      fail(error.code, error.message, {
        ...property(error.details),
        operation_id: library.operation_id,
        parent_page_id: library.library_id,
        role: "Sources",
        stage: "origins",
      }),
    ),
  )
}
