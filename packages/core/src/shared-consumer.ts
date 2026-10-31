import { Effect } from "effect"
import { fail, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { materializeFixedGithubSource } from "./shared-source-materialization.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "./shared-snapshot.ts"
import { querySharedRouterMembers } from "./shared-router-members.ts"

/** Resolve only the immutable source explicitly selected in the current Skills row. */
export function openSharedConsumer(
  input: Omit<OpenSharedSnapshotInput, "fixedSource" | "routerMembers">,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const selected = pageId(input.target)
    if (!selected)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Shared consumption requires an exact Skill page."),
      )
    const rawPage = input.rawPage ?? (yield* api.request(`v1/pages/${selected}`))
    const selection = yield* Effect.try({
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
        return { record, sourceId: text(field.rich_text) }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_SHARED_SKILL", "Invalid shared source selection."),
    })
    const { sourceId, record } = selection
    const routerMembers =
      record.kind === "router"
        ? yield* querySharedRouterMembers(input.library, { router: record, rawPage })
        : undefined
    const sharedInput = {
      ...input,
      rawPage,
      ...(routerMembers === undefined ? {} : { routerMembers }),
    }
    if (!sourceId) return yield* openSharedSnapshot(sharedInput)
    const binding = yield* resolveSourceBinding(input.library, { skillPageId: selected, sourceId })
    const files = yield* materializeFixedGithubSource(binding, { metrics: api.metrics })
    return yield* openSharedSnapshot({
      ...sharedInput,
      fixedSource: {
        source_id: binding.source_id,
        revision: binding.commit,
        files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
      },
    })
  })
}
