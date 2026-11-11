import { Effect } from "effect"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { readSourceDefinition, sourceField } from "./shared-source-definitions.ts"
import type { SharedFileSourceContext } from "./shared-file-source-context-model.ts"

const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_FILE_SOURCE_CONTEXT_INVALID",
            "The file's exact source binding is unavailable.",
          ),
  })

export function readSharedFileSourceContext(
  library: SharedLibrary,
  skillPageId: string,
  suppliedPage?: unknown,
) {
  return Effect.gen(function* () {
    const raw = suppliedPage ?? (yield* (yield* Notion).request(`v1/pages/${skillPageId}`))
    const native = yield* checked(() => {
      const row = property(raw)
      if (
        row.object !== "page" ||
        row.id !== skillPageId ||
        row.archived === true ||
        row.in_trash === true ||
        property(row.parent).data_source_id !== library.skills.data_source_id
      )
        throw fail(
          "SHARED_FILE_SCOPE",
          "The source binding is outside this exact Skill and library.",
        )
      const rich = (name: string) => {
        const id = library.skills.property_ids[name]
        if (!id)
          throw fail(
            "SHARED_FILE_SOURCE_CONTEXT_INVALID",
            "The source binding lacks a registered property.",
            { property: name },
          )
        const value = sourceField(row, id)
        if (
          value.type !== "rich_text" ||
          !Array.isArray(value.rich_text) ||
          value.has_more === true ||
          value.rich_text.length >= 25
        )
          throw fail(
            "SHARED_FILE_SOURCE_CONTEXT_INVALID",
            "The source binding property is incomplete.",
            { property: name },
          )
        return text(value.rich_text)
      }
      const selected = rich("Source")
      if (library.sources === undefined) return { selected, origin: undefined, member: "" }
      const originId = library.skills.property_ids.Origin
      if (!originId)
        throw fail(
          "SHARED_FILE_SOURCE_CONTEXT_INVALID",
          "Sources is attached without an Origin identity.",
        )
      const origin = sourceField(row, originId),
        member = rich("Source Member")
      if (
        origin.type !== "relation" ||
        origin.has_more === true ||
        !Array.isArray(origin.relation) ||
        origin.relation.length > 1
      )
        throw fail(
          "SHARED_FILE_SOURCE_CONTEXT_INVALID",
          "Origin must be a complete single Source relation.",
        )
      const source = origin.relation[0]
      if (source === undefined) {
        if (member)
          throw fail(
            "SHARED_FILE_SOURCE_CONTEXT_INVALID",
            "An unbound Skill cannot retain a live Source Member.",
          )
        return { selected, origin: undefined, member }
      }
      const id = property(source).id
      if (typeof id !== "string" || !member)
        throw fail(
          "SHARED_FILE_SOURCE_CONTEXT_INVALID",
          "A live Source requires its exact member identity.",
        )
      return { selected, origin: id, member }
    })
    if (native.origin === undefined)
      return {
        selected_version: native.selected,
        definition: null,
      } satisfies SharedFileSourceContext
    const definition = yield* readSourceDefinition(library, native.origin)
    return {
      selected_version: native.selected,
      definition: {
        page_id: definition.page_id,
        source_id: definition.source_id,
        fingerprint: definition.fingerprint,
        member: native.member,
      },
    } satisfies SharedFileSourceContext
  })
}
