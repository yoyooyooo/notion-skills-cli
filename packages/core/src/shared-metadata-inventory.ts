import { Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

export interface CompleteSharedMetadataInventory {
  readonly data_source_id: string
  readonly complete: true
  readonly pages: readonly unknown[]
}

/** A complete metadata observation carried only through its current read. */
export interface SharedSkillMetadataObservation {
  readonly scope: string
  readonly library: SharedLibrary
  readonly inventory: CompleteSharedMetadataInventory
}

export function sharedSkillMetadataFor(
  observation: SharedSkillMetadataObservation,
  library: SharedLibrary,
  scope: string,
): CompleteSharedMetadataInventory {
  if (observation.scope !== scope)
    throw fail("ACCESS_DENIED", "The Skill metadata observation belongs to another account scope.")
  if (
    canonicalSharedJson(observation.library) !== canonicalSharedJson(library) ||
    observation.inventory.data_source_id !== library.skills.data_source_id
  )
    throw fail(
      "SHARED_REFERENCE_SCOPE",
      "The Skill metadata observation belongs to another library descriptor.",
    )
  if (observation.inventory.complete !== true)
    throw fail("SHARED_REFERENCE_INCOMPLETE", "The Skill metadata observation is incomplete.")
  return observation.inventory
}

/** Exhaust the narrow projection, retaining disabled and otherwise unselected rows.
 * Callers still own record decoding, identity claims and selected-target validation. */
export function querySharedMetadataInventory(
  library: SharedLibrary,
  kind: "skills" | "files",
  boundary: "catalog" | "reference" = "reference",
) {
  return Effect.gen(function* () {
    const source = library[kind]
    const fields =
      kind === "skills"
        ? ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"]
        : ["File ID", "Skill", "Path", "Projection", "Status"]
    const query = new URLSearchParams()
    for (const name of fields) {
      const id = source.property_ids[name]
      if (!id)
        return yield* Effect.fail(
          fail("LIBRARY_INVALID", "A registered metadata property is missing.", {
            kind,
            property: name,
          }),
        )
      query.append("filter_properties", id)
    }
    const invalid = boundary === "catalog" ? "INVALID_RESPONSE" : "SHARED_REFERENCE_INVALID"
    const incomplete = boundary === "catalog" ? "INVALID_RESPONSE" : "SHARED_REFERENCE_INCOMPLETE"
    const api = yield* Notion
    const pages: unknown[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(`v1/data_sources/${source.data_source_id}/query?${query}`, {
        page_size: 100,
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const result = yield* Effect.try({
        try: () => {
          if (property(raw).object !== "list")
            throw fail(incomplete, "Metadata inventory is not a complete data-source list.")
          return decode(listSchema(Schema.Unknown), raw)
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail(invalid, "Metadata inventory could not be decoded."),
      })
      pages.push(...result.results)
      if (!result.has_more) {
        if (result.next_cursor !== null)
          return yield* Effect.fail(
            fail(incomplete, "A terminal metadata inventory retains a cursor."),
          )
        return { data_source_id: source.data_source_id, complete: true as const, pages }
      }
      if (!result.next_cursor || cursors.has(result.next_cursor) || cursors.size >= 1000)
        return yield* Effect.fail(
          fail(incomplete, "Metadata inventory pagination did not advance."),
        )
      cursor = result.next_cursor
      cursors.add(cursor)
    }
  })
}
