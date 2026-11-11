import { Effect } from "effect"
import { fail } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalFixedGithubInput, fetchFixedGithubFile } from "./shared-github-source.ts"
import { makeSourceBinding } from "./shared-source-binding.ts"
import { cacheVerifiedFixedGithubFiles } from "./shared-source-materialization.ts"
import type { SourceDefinitionInput } from "./shared-sources-model.ts"
import type { SourceSnapshot } from "./upstream-source.ts"
import { sha256 } from "./store.ts"

export type SourceMemberStorage = "auto" | "retained" | "fixed-git"

/** Creation and refresh share one complete member observation and the same public-access proof. */
export function prepareSourceMember(
  definition: SourceDefinitionInput,
  acquired: SourceSnapshot,
  memberKey: string,
  storage: SourceMemberStorage = "auto",
) {
  return Effect.gen(function* () {
    if (!acquired.revision || (acquired.unavailable?.length ?? 0) !== 0)
      return yield* Effect.fail(
        fail("SOURCE_REFRESH_INCOMPLETE", "Source has unresolved deterministic resources."),
      )
    const matches = acquired.members.filter((member) => member.member_key === memberKey)
    if (matches.length !== 1)
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_UNAVAILABLE", "Source did not return the exact bound member."),
      )
    const member = matches[0]!
    if (member.portable.main !== "SKILL.md")
      return yield* Effect.fail(
        fail("SOURCE_ENTRYPOINT_CHANGED", "A fixed Skill member requires SKILL.md."),
      )
    const manifest = member.git_manifest
    const files = member.portable.files.map((file) => {
      const mode = manifest?.files.find((entry) => entry.path === file.path)?.mode ?? file.mode
      return {
        path: file.path,
        bytes: new Uint8Array(file.bytes),
        ...(mode === undefined ? {} : { mode }),
      }
    })
    const url =
      acquired.provenance.git_url ??
      (definition.adapter.type === "git" ? definition.adapter.url : "")
    const eligible =
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url) &&
      manifest !== undefined &&
      member.patch_hash === undefined &&
      member.git_materialization === undefined &&
      manifest.files.length === files.length &&
      files.every((file) => manifest.files.some((entry) => entry.path === file.path))
    if (storage === "retained" || !eligible || manifest === undefined) {
      if (storage === "fixed-git")
        return yield* Effect.fail(
          fail(
            "SOURCE_FIXED_GIT_UNAVAILABLE",
            "Fixed Git requires an unchanged complete public GitHub member; choose retained for transformed or other sources.",
          ),
        )
      return { kind: "retained" as const, member, files, revision: acquired.revision }
    }
    if (manifest.commit !== acquired.revision)
      return yield* Effect.fail(
        fail(
          "SOURCE_REFRESH_INVALID",
          "The original Git manifest differs from the acquired revision or entrypoint.",
        ),
      )
    const canonical = yield* canonicalFixedGithubInput({
      url,
      commit: manifest.commit,
      root: manifest.root,
    })
    const hashes = new Map(
      yield* Effect.forEach(files, (file) =>
        sha256(file.bytes).pipe(Effect.map((hash) => [file.path, hash] as const)),
      ),
    )
    const binding = yield* makeSourceBinding({
      url: canonical.url,
      ...manifest,
      files: manifest.files.map((file) => ({ ...file, sha256: hashes.get(file.path)! })),
    })
    const main = binding.files.find((file) => file.path === "SKILL.md")
    if (main === undefined)
      return yield* Effect.fail(
        fail("SOURCE_ENTRYPOINT_CHANGED", "The complete Git member requires SKILL.md."),
      )
    // A credentialed manager checkout does not prove anonymous consumer retrieval.
    yield* fetchFixedGithubFile(binding, main, { metrics: (yield* Notion).metrics })
    const verified = yield* cacheVerifiedFixedGithubFiles(binding, files)
    return {
      kind: "fixed_git" as const,
      member,
      files,
      revision: acquired.revision,
      binding,
      manifest: verified,
    }
  })
}
