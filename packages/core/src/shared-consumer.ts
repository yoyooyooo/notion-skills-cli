import { Effect } from "effect"
import { fail, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import { planSelectedSharedSource } from "./shared-selected-source.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "./shared-snapshot.ts"
import { sharedSkillMetadataFor } from "./shared-metadata-inventory.ts"
import { isSharedAuthoringTarget } from "./shared-authoring-context.ts"
import { openGitOnlySharedConsumer } from "./shared-git-only-consumer.ts"
import { isGitOnlyProjection } from "./shared-git-only-marker.ts"

/** Resolve only the immutable source explicitly selected in the current Skills row. */
export function openSharedConsumer(
  input: Omit<OpenSharedSnapshotInput, "fixedSource"> & {
    readonly sourceOptions?: SharedSourcePlanOptions
  },
) {
  return Effect.gen(function* () {
    const { sourceOptions, ...snapshotInput } = input
    const skillsMetadata = input.skillsMetadata
    if (skillsMetadata !== undefined)
      yield* Effect.try({
        try: () => sharedSkillMetadataFor(skillsMetadata, input.library, input.scope),
        catch: (error) => error as SkillsError,
      })
    const api = yield* Notion
    const selected = pageId(input.target)
    if (!selected)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Shared consumption requires an exact Skill page."),
      )
    const rawPage = input.rawPage ?? (yield* api.request(`v1/pages/${selected}`))
    const authoring = yield* isSharedAuthoringTarget(selected)
    const { requestedPaths: _paths, requestedFileIds: _fileIds, ...completeInput } = snapshotInput
    const acquisitionInput = authoring ? { ...completeInput, forceFull: true } : snapshotInput
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
        if (
          input.expectedSkillId !== undefined &&
          record.locator.skill_id !== input.expectedSkillId
        )
          throw fail(
            "SHARED_SKILL_ID_CONFLICT",
            "The selected Skill identity changed after directory resolution.",
          )
        if (!record.enabled && !authoring)
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
    if (!sourceId) return yield* openSharedSnapshot({ ...acquisitionInput, rawPage })
    const fixedSource = yield* planSelectedSharedSource(
      input.library,
      selected,
      sourceId,
      sourceOptions,
    )
    const projectionField = sharedSkillProperty(rawPage, input.library, "Projection")
    if (
      projectionField.type === "rich_text" &&
      Array.isArray(projectionField.rich_text) &&
      isGitOnlyProjection(text(projectionField.rich_text))
    ) {
      if (authoring)
        return yield* Effect.fail(
          fail(
            "GIT_ONLY_AUTHORING_REVIEW",
            "Git-only source bodies require an explicit Notion takeover before native authoring.",
          ),
        )
      return yield* openGitOnlySharedConsumer({
        library: input.library,
        target: selected,
        rawPage,
        scope: input.scope,
        startedAt: input.startedAt,
        fixedSource,
        ...(input.expectedSkillId === undefined ? {} : { expectedSkillId: input.expectedSkillId }),
      })
    }
    return yield* openSharedSnapshot({
      ...acquisitionInput,
      rawPage,
      fixedSource,
    })
  })
}
