import { Effect } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalFixedGithubInput } from "./shared-github-source.ts"
import { makeSourceBinding } from "./shared-source-binding.ts"
import {
  cacheVerifiedFixedGithubFiles,
  materializeFixedGithubSource,
} from "./shared-source-materialization.ts"
import type { SourceDefinitionInput } from "./shared-sources-model.ts"
import type { SourceSnapshot } from "./upstream-source.ts"
import { sha256 } from "./store.ts"

export type SourceMemberStorage = "auto" | "retained" | "fixed-git"

/** Transparent planning policy. Retrieval failure never authorizes a complete
 * Notion byte copy; exceptions are explicit configuration or caller intent. */
export function sourceMemberStorageDecision(
  definition: SourceDefinitionInput,
  acquired: SourceSnapshot,
  memberKey: string,
  requested: SourceMemberStorage = "auto",
) {
  const configured = definition.options.storage
  if (
    configured !== undefined &&
    configured !== "auto" &&
    configured !== "retained" &&
    configured !== "fixed-git"
  )
    throw fail(
      "SOURCE_STORAGE_POLICY_INVALID",
      "Source options.storage must be auto, fixed-git or retained.",
    )
  const storage = requested === "auto" ? (configured ?? "auto") : requested
  const matches = acquired.members.filter((member) => member.member_key === memberKey)
  if (matches.length !== 1)
    throw fail("SOURCE_MEMBER_UNAVAILABLE", "Select one exact provider member.")
  const member = matches[0]!,
    manifest = member.git_manifest
  const url =
    acquired.provenance.git_url ?? (definition.adapter.type === "git" ? definition.adapter.url : "")
  const reason = !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(url)
    ? "non_github_origin"
    : member.patch_hash !== undefined
      ? "transformed_member"
      : member.git_materialization !== undefined
        ? "materialized_git_links"
        : manifest === undefined
          ? "fixed_manifest_missing"
          : manifest.files.length !== member.portable.files.length ||
              member.portable.files.some(
                (file) => !manifest.files.some((entry) => entry.path === file.path),
              )
            ? "fixed_manifest_incomplete"
            : undefined
  const common = {
    policy: storage,
    requested,
    configured: configured ?? "auto",
    member: memberKey,
    repository: url,
    revision: acquired.revision,
    files: member.portable.files.length,
    bytes: member.portable.files.reduce((total, file) => total + file.bytes.length, 0),
  }
  if (storage === "retained")
    return {
      ...common,
      kind: "retained" as const,
      reason: "explicit_retention",
      byte_copy_authorized: true,
    }
  if (reason !== undefined)
    return { ...common, kind: "blocked" as const, reason, byte_copy_authorized: false }
  return {
    ...common,
    kind: "fixed_git" as const,
    reason: "complete_original_fixed_git",
    byte_copy_authorized: false,
  }
}

/** Creation and refresh share one complete member observation and the same
 * fixed-byte consumer proof. Retention is a separate explicit storage choice. */
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
    const decision = yield* Effect.try({
      try: () => sourceMemberStorageDecision(definition, acquired, memberKey, storage),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("SOURCE_STORAGE_POLICY_INVALID", "The source storage decision is invalid."),
    })
    if (decision.kind === "blocked")
      return yield* Effect.fail(
        fail(
          storage === "fixed-git"
            ? "SOURCE_FIXED_GIT_UNAVAILABLE"
            : "SOURCE_STORAGE_REVIEW_REQUIRED",
          "The selected member needs an explicit storage decision; unchanged upstream files are not silently archived to Notion.",
          decision,
        ),
      )
    if (decision.kind === "retained") {
      return { kind: "retained" as const, member, files, revision: acquired.revision }
    }
    if (manifest === undefined)
      return yield* Effect.fail(
        fail("SOURCE_FIXED_GIT_UNAVAILABLE", "The complete original Git manifest is missing."),
      )
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
    // Prove the same exact-byte consumer path, not one particular CDN host.
    // Git authentication remains a trusted machine capability, never shared.
    yield* materializeFixedGithubSource(binding, { metrics: (yield* Notion).metrics }, [main.path])
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
