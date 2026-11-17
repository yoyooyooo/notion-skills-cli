import { Clock, Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, property, SkillsError, text, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, normalizePath, pageId } from "./ref.ts"
import { sharedSkillProperty } from "./shared-content.ts"
import { openSharedConsumer } from "./shared-consumer.ts"
import { resolveSourceBinding } from "./shared-source-binding.ts"
import { listSourceMembers } from "./shared-source-definitions.ts"
import { assertGitOnlyAdmissionOwner } from "./shared-git-only-marker.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SOURCE_MEMBER_UNAVAILABLE", "The linked Git member identity is invalid."),
  })

/** Resolve a crossing relative Markdown href only after the exact selected
 * Source owner and both frozen Git commit/tree/member identities agree.
 * This never rewrites original Markdown or copies remote resource bytes into
 * Notion. Ordinary same-member paths never enter this discovery path. */
export function resolveGitOnlySibling(snapshot: Snapshot, from: string, relative: string) {
  return Effect.gen(function* () {
    const acquisition = snapshot.shared_acquisition
    const owner = snapshot.record.locator
    if (
      acquisition?.version !== 2 ||
      owner.type !== "shared_skill" ||
      snapshot.scope !== (yield* authScope)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "Cross-member lookup requires an authenticated Git-only snapshot.",
        ),
      )
    const library = acquisition.library
    const source = yield* resolveSourceBinding(library, {
      skillPageId: owner.page_id,
      sourceId: acquisition.source.source_id,
    })
    if (source.commit !== acquisition.source.revision)
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The source pin differs from the frozen snapshot revision.",
        ),
      )
    const page = yield* (yield* Notion).request(`v1/pages/${owner.page_id}`)
    const fields = yield* checked(() => {
      const rich = (name: string) => {
        const field = sharedSkillProperty(page, library, name)
        if (
          field.type !== "rich_text" ||
          !Array.isArray(field.rich_text) ||
          field.has_more === true
        )
          throw fail("SOURCE_MEMBER_UNAVAILABLE", "Git-only Source identity is incomplete.")
        return text(field.rich_text)
      }
      const origin = sharedSkillProperty(page, library, "Origin")
      if (
        origin.type !== "relation" ||
        origin.has_more !== false ||
        !Array.isArray(origin.relation) ||
        origin.relation.length !== 1
      )
        throw fail("SOURCE_MEMBER_UNAVAILABLE", "Git-only owner has no exact Origin relation.")
      return {
        projection: rich("Projection"),
        origin_page_id: property(origin.relation[0]).id,
        member: rich("Source Member"),
        selected_version: rich("Source"),
      }
    })
    const sourcePageId = yield* assertGitOnlyAdmissionOwner({
      projection: fields.projection,
      library_id: library.library_id,
      skill_id: owner.skill_id,
      origin_page_id: String(fields.origin_page_id ?? ""),
      member: fields.member,
    })
    if (
      fields.member !== (source.root || ".") ||
      fields.selected_version !== acquisition.source.source_id
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "The current Git-only owner drifted from its original Source/member pin.",
        ),
      )
    const repositoryPath = yield* checked(() => {
      if (
        relative.startsWith("/") ||
        relative.includes("?") ||
        relative.includes("#") ||
        /^[a-z][a-z\d+.-]*:/iu.test(relative)
      )
        throw fail(
          "INVALID_PATH",
          "Source sibling references must be unqualified relative Git paths.",
        )
      let decoded: string
      try {
        decoded = decodeURIComponent(relative)
      } catch {
        throw fail("INVALID_PATH", "Source sibling reference has invalid percent encoding.")
      }
      if (/[\u0000-\u001f\u007f]/u.test(decoded))
        throw fail("INVALID_PATH", "Source sibling path has control characters.")
      return normalizePath(decoded, (source.root ? source.root + "/" : "") + from)
    })
    const candidates = yield* listSourceMembers(library, sourcePageId)
    const targets = candidates.items.filter(
      (item) =>
        item.kind === "skill" &&
        item.member !== "" &&
        item.member !== fields.member &&
        (item.member === "." || repositoryPath.startsWith(item.member + "/")),
    )
    if (targets.length !== 1)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "The linked resource does not have one exact sibling Skill owner.",
        ),
      )
    const target = targets[0]!
    const relativeTarget =
      target.member === "." ? repositoryPath : repositoryPath.slice(target.member.length + 1)
    if (
      !target.enabled ||
      !relativeTarget ||
      !/^source-[a-f0-9]{64}$/u.test(target.selected_version)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_UNAVAILABLE",
          "The sibling Skill is not enabled with an exact fixed Git pin.",
        ),
      )
    const sibling = yield* resolveSourceBinding(library, {
      skillPageId: target.page_id,
      sourceId: target.selected_version,
    })
    if (
      sibling.url !== source.url ||
      sibling.commit !== source.commit ||
      sibling.tree !== source.tree ||
      sibling.root !== (target.member === "." ? "" : target.member)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The target member does not share the original pinned Git repository and revision.",
        ),
      )
    const descriptor = sibling.files.find((file) => file.path === relativeTarget)
    if (!descriptor?.sha256)
      return yield* Effect.fail(
        fail(
          "SOURCE_RESOURCE_UNAVAILABLE",
          "The linked file is not in the sibling's immutable Git manifest.",
        ),
      )
    const now = yield* Clock.currentTimeMillis
    const opened = yield* openSharedConsumer({
      library,
      target: target.page_id,
      scope: snapshot.scope,
      startedAt: now,
      expectedSkillId: target.skill_id,
    })
    const targetAcquisition = opened.shared_acquisition
    const file = opened.files.find((entry) => entry.path === relativeTarget)
    if (
      !opened.record.enabled ||
      targetAcquisition?.version !== 2 ||
      targetAcquisition.source.source_id !== target.selected_version ||
      targetAcquisition.source.revision !== source.commit ||
      file?.sha256 !== descriptor.sha256 ||
      file?.bytes !== descriptor.bytes ||
      file?.mode !== descriptor.mode
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_REVISION_UNAVAILABLE",
          "The sibling's verified current snapshot differs from the pinned Git target.",
        ),
      )
    return fileRef(opened.record.id, relativeTarget, opened.snapshot_id)
  })
}
