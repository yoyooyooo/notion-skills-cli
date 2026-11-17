import { Effect } from "effect"
import { fail, property, SkillsError, text } from "./model.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { sharedRecordFromPage, sharedSkillProperty } from "./shared-content.ts"
import type { PlannedSharedSource } from "./shared-selected-source.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "./shared-snapshot.ts"
import { isSharedAuthoringTarget } from "./shared-authoring-context.ts"
import { assertGitOnlyAdmissionOwner, isGitOnlyProjection } from "./shared-git-only-marker.ts"

export { gitOnlyProjection } from "./shared-git-only-marker.ts"

/** A sparse Git admission is an initial source choice, not a Skill-wide
 * read-only ownership mode. The existing shared file observer/placement/
 * recovery pipeline owns every Notion document override and restore-follow. */
export function openGitOnlySharedConsumer(
  input: Omit<OpenSharedSnapshotInput, "fixedSource"> & {
    readonly rawPage: unknown
    readonly fixedSource: PlannedSharedSource
  },
) {
  return Effect.gen(function* () {
    const owner = yield* Effect.try({
      try: () => {
        const record = sharedRecordFromPage(
          input.rawPage,
          {
            alias: input.library.library_id,
            title: "",
            role: "content",
            database_id: input.library.skills.database_id,
            data_source_ids: [input.library.skills.data_source_id],
            shared_library: input.library,
          },
          input.library.skills.data_source_id,
        )
        const rich = (name: string) => {
          const field = sharedSkillProperty(input.rawPage, input.library, name)
          if (
            field.type !== "rich_text" ||
            !Array.isArray(field.rich_text) ||
            field.has_more === true
          )
            throw fail("GIT_ONLY_SCOPE", "The original source metadata is incomplete.")
          return text(field.rich_text)
        }
        const origin = sharedSkillProperty(input.rawPage, input.library, "Origin")
        if (
          origin.type !== "relation" ||
          origin.has_more !== false ||
          !Array.isArray(origin.relation) ||
          origin.relation.length !== 1 ||
          record.locator.page_id !== input.target ||
          record.kind !== "skill" ||
          (input.expectedSkillId !== undefined && input.expectedSkillId !== record.locator.skill_id)
        )
          throw fail(
            "GIT_ONLY_SCOPE",
            "Sparse Git content requires one exact Skill and original Source owner.",
          )
        const projection = rich("Projection"),
          member = rich("Source Member")
        if (
          !isGitOnlyProjection(projection) ||
          rich("Source") !== input.fixedSource.source_id ||
          input.fixedSource.git_member_root === undefined ||
          member !== (input.fixedSource.git_member_root || ".") ||
          !input.fixedSource.manifest.length ||
          input.fixedSource.manifest.some(
            (file) => file.identity.kind !== "git" || file.identity.sha256 === undefined,
          )
        )
          throw fail(
            "GIT_ONLY_SCOPE",
            "Sparse Git requires its complete exact original manifest and member root.",
          )
        return {
          projection,
          library_id: input.library.library_id,
          skill_id: record.locator.skill_id,
          origin_page_id: String(property(origin.relation[0]).id ?? ""),
          member,
        }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("GIT_ONLY_SCOPE", "The sparse Git source identity is invalid."),
    })
    yield* assertGitOnlyAdmissionOwner(owner)
    const authoring = yield* isSharedAuthoringTarget(input.target)
    return yield* openSharedSnapshot({
      ...input,
      sparseGit: true,
      requestedPaths: authoring ? undefined : (input.requestedPaths ?? []),
    })
  })
}
