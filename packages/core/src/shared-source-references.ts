import { Effect } from "effect"
import { fail, SkillsError, type Snapshot } from "./model.ts"
import { fileRef, normalizePath, parseRef, resolveRef } from "./ref.ts"
import { skillIdentity } from "./shared-content.ts"
import { resolveCurrentSharedSources } from "./shared-current-source.ts"
import { queryCurrentSourceManagement } from "./shared-current-source-management.ts"
import { isGithubGitUrl } from "./shared-git-origin.ts"

const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CURRENT_SOURCE_REFERENCE_INVALID", "The current Source reference is invalid."),
  })

/** Resolve original repository-relative links through the current contribution
 * map. This does not rewrite upstream bytes, invent Files, or resurrect history. */
export function resolveCurrentSourceReference(
  snapshot: Snapshot,
  from: string,
  relative: string,
  options: { readonly offline?: boolean } = {},
) {
  return Effect.gen(function* () {
    const local = fileRef(snapshot.record.id, from, snapshot.snapshot_id)
    const route = snapshot.shared_acquisition?.files.find(
      (entry) => entry.path === from && entry.kind === "source",
    )
    if (route?.kind !== "source") return yield* checked(() => resolveRef(local, relative))
    if (relative.startsWith("skill://")) return yield* checked(() => resolveRef(local, relative))
    const sourceSelection = yield* checked(() => {
      // Apply the same path grammar before interpreting a repository path.
      if (relative.includes("?") || relative.includes("#") || /^[a-z]+:/iu.test(relative))
        throw fail("INVALID_PATH", "Only relative file paths can be resolved within a skill.")
      return normalizePath(relative, route.source_path)
    }).pipe(Effect.result)
    if (sourceSelection._tag === "Failure") {
      // A mixed tree can explicitly link to a native companion outside its
      // mounted Source root. Retain that owner-local address only when there is
      // no repository-relative address at all; it cannot shadow a Source path.
      if (
        sourceSelection.failure.code === "INVALID_PATH" &&
        sourceSelection.failure.message === "The path escapes the skill root."
      ) {
        const ownerLocal = yield* checked(() => resolveRef(local, relative)).pipe(Effect.result)
        if (ownerLocal._tag === "Success") {
          const path = parseRef(ownerLocal.success).path
          const binding = snapshot.file_bindings?.find((file) => file.path === path)
          if (
            binding &&
            snapshot.files.some((file) => file.path === path) &&
            !snapshot.shared_acquisition!.files.some(
              (file) => file.path === path && file.kind === "source",
            )
          )
            return fileRef(snapshot.record.id, path, snapshot.snapshot_id)
        }
      }
      return yield* Effect.fail(sourceSelection.failure)
    }
    const sourcePath = sourceSelection.success
    // Source bytes were authored in the repository tree. A coincidentally
    // matching mounted/native path must not override that original address.
    const sameOwner = snapshot.shared_acquisition!.files.filter(
      (entry) =>
        entry.kind === "source" &&
        entry.source_id === route.source_id &&
        entry.revision === route.revision &&
        entry.source_path === sourcePath,
    )
    if (sameOwner.length > 1)
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_REFERENCE_AMBIGUOUS",
          "This Source path has several mounted Files in the selected Skill; select one exact File reference.",
          {
            source_id: route.source_id,
            source_path: sourcePath,
            paths: sameOwner.map((file) => file.path),
          },
        ),
      )
    if (sameOwner.length === 1) {
      const target = sameOwner[0]!
      return fileRef(snapshot.record.id, target.path, snapshot.snapshot_id)
    }
    if (options.offline)
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_REFERENCE_UNAVAILABLE",
          "A cross-member Source reference needs its current contribution map online.",
          { source_id: route.source_id, source_path: sourcePath },
        ),
      )
    const library = snapshot.shared_acquisition!.library
    const sources = yield* resolveCurrentSharedSources(library, {
      selections: [{ source_id: route.source_id, revision: route.revision }],
    })
    const source = sources.get(route.source_id)!
    const selected = source.manifest.find((file) => file.path === sourcePath)
    if (selected === undefined)
      return yield* Effect.fail(
        fail(
          "FILE_NOT_FOUND",
          "The reference is absent from the complete selected Source manifest.",
          { source_id: route.source_id, source_path: sourcePath },
        ),
      )
    const current = yield* queryCurrentSourceManagement(library, route.source_id)
    if (
      !current ||
      current.page_id !== source.page_id ||
      current.revision !== route.revision ||
      current.state.state !== "ready" ||
      !current.declaration.definition.enabled
    )
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_CHANGED",
          "The Source changed while its reference was being resolved.",
          { source_id: route.source_id, next: "reselect_current" },
        ),
      )
    const candidates = current.declaration.contributions.flatMap((entry) => {
      const root = entry.member_key === "." ? "" : entry.member_key + "/"
      if (!sourcePath.startsWith(root)) return []
      const path = sourcePath.slice(root.length)
      if (entry.exclude.includes(path)) return []
      const mapped = entry.mapping[path] ?? path
      return [
        {
          skill_id: entry.skill_id,
          path: entry.mount_path ? entry.mount_path + "/" + mapped : mapped,
        },
      ]
    })
    if (candidates.length === 1) {
      const target = candidates[0]!
      return fileRef(skillIdentity(library.library_id, target.skill_id), target.path)
    }
    if (candidates.length > 1)
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_REFERENCE_AMBIGUOUS",
          "This Source path contributes to several Skills; select one exact Skill reference.",
          { source_id: route.source_id, source_path: sourcePath, candidates },
        ),
      )
    const origin = source.git_origin
    return yield* Effect.fail(
      fail(
        "CURRENT_SOURCE_EXTERNAL_REFERENCE",
        "This is a fixed upstream repository reference outside the selected Skill members.",
        {
          source_id: route.source_id,
          source_path: sourcePath,
          sha256: selected.sha256,
          bytes: selected.bytes,
          ...(origin === undefined
            ? {}
            : {
                repository: origin.url,
                commit: origin.commit,
                ...(isGithubGitUrl(origin.url)
                  ? {
                      url: `${origin.url}/blob/${origin.commit}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`,
                    }
                  : {}),
              }),
        },
      ),
    )
  })
}
