import { Effect } from "effect"
import type { SharedLibrary } from "./shared-library-model.ts"
import { inspectTable, registeredSkillProperties } from "./shared-library.ts"

/** Read-only schema health. Current bindings must be registered explicitly. */
export function inspectSharedRelationSchema(library: SharedLibrary) {
  return Effect.gen(function* () {
    yield* inspectTable(
      library.skills.database_id,
      registeredSkillProperties(library.skills),
      library.parent_page_id,
      library.skills,
    )
    const missing = (["Members", "Requires"] as const).filter(
      (field) => library.skills.property_ids[field] === undefined,
    )
    return {
      library_id: library.library_id,
      data_source_id: library.skills.data_source_id,
      ready: missing.length === 0,
      missing,
      bindings: Object.fromEntries(
        (["Members", "Requires"] as const).flatMap((field) => {
          const id = library.skills.property_ids[field]
          return id === undefined ? [] : [[field, id]]
        }),
      ),
      parent_kinds: ["skill", "router"] as const,
      target_kind: "skill" as const,
      targets_enabled: true as const,
      next_action: missing.length === 0 ? null : "register_current_relation_properties",
    }
  })
}
