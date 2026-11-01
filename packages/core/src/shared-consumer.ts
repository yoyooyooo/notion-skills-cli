import { Effect } from "effect"
import { fail, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import { resolveSelectedSharedSource } from "./shared-selected-source.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "./shared-snapshot.ts"

/** Resolve only the immutable source explicitly selected in the current Skills row. */
export function openSharedConsumer(
  input: Omit<OpenSharedSnapshotInput, "fixedSource"> & {
    readonly sourceOptions?: SharedSourcePlanOptions
  },
) {
  return Effect.gen(function* () {
    const { sourceOptions, ...snapshotInput } = input
    const api = yield* Notion
    const selected = pageId(input.target)
    if (!selected)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Shared consumption requires an exact Skill page."),
      )
    const rawPage = input.rawPage ?? (yield* api.request(`v1/pages/${selected}`))
    const sourceId = yield* Effect.try({
      try: () => {
        const record = sharedRecordFromPage(
          rawPage,
          {
            alias: input.library.library_id,
            database_id: input.library.skills.database_id,
            title: "",
            data_source_ids: [input.library.skills.data_source_id],
            role: "content",
            shared_library: input.library,
          },
          input.library.skills.data_source_id,
        )
        if (record.locator.page_id !== selected)
          throw fail("SHARED_FILE_SCOPE", "The selected page differs from its returned identity.")
        if (!record.enabled)
          throw fail("CONTENT_DISABLED", "The selected Skill is disabled in Notion.")
        const field = sharedSkillProperty(rawPage, input.library, "Source")
        if (
          field.type !== "rich_text" ||
          !Array.isArray(field.rich_text) ||
          field.has_more === true
        )
          throw fail(
            "INVALID_SHARED_SKILL",
            "The Source selection must be a complete rich-text identity.",
          )
        return text(field.rich_text)
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_SHARED_SKILL", "Invalid shared source selection."),
    })
    if (!sourceId) return yield* openSharedSnapshot({ ...snapshotInput, rawPage })
    const fixedSource = yield* resolveSelectedSharedSource(
      input.library,
      selected,
      sourceId,
      sourceOptions,
    )
    return yield* openSharedSnapshot({
      ...snapshotInput,
      rawPage,
      fixedSource,
    })
  })
}
