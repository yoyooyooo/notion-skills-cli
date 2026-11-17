import { Effect } from "effect"
import { fail } from "./model.ts"
import { pageId } from "./ref.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

/** Bind the Git-only control page to the exact Source that admitted it. */
export const gitOnlyProjection = "git-only/v1"

export function gitOnlyProjectionForSource(sourcePageId: string): string {
  if (pageId(sourcePageId) !== sourcePageId)
    throw fail("GIT_ONLY_SCOPE", "Git-only admission requires the exact Source page identity.")
  return `${gitOnlyProjection}:${sourcePageId}`
}

export function gitOnlySourcePage(value: string): string | undefined {
  if (!value.startsWith(gitOnlyProjection + ":")) return undefined
  const selected = value.slice(gitOnlyProjection.length + 1)
  return pageId(selected) === selected ? selected : undefined
}

export function isGitOnlyProjection(value: string): boolean {
  return value === gitOnlyProjection || value.startsWith(gitOnlyProjection + ":")
}

/** Existing completed Git-only pages may carry the original bare marker.
 * Their deterministic original Skill ID is immutable evidence of precisely
 * which Source page admitted the member. Require that proof for both old and
 * new markers; never treat a mutable current Origin as sufficient. */
export function assertGitOnlyAdmissionOwner(input: {
  readonly projection: string
  readonly library_id: string
  readonly skill_id: string
  readonly origin_page_id: string
  readonly member: string
}) {
  return Effect.gen(function* () {
    const sourcePageId = input.origin_page_id
    if (
      pageId(sourcePageId) !== sourcePageId ||
      !isGitOnlyProjection(input.projection) ||
      (input.projection !== gitOnlyProjection &&
        gitOnlySourcePage(input.projection) !== sourcePageId)
    )
      return yield* Effect.fail(
        fail("GIT_ONLY_SCOPE", "The Git-only page does not match its original Source owner."),
      )
    const expected = `skill-${yield* sha256(
      canonicalSharedJson(["source-onboarding-v1", input.library_id, sourcePageId, input.member]),
    )}`
    if (input.skill_id !== expected)
      return yield* Effect.fail(
        fail(
          "GIT_ONLY_SCOPE",
          "The Git-only Skill ID was not admitted under this exact original Source and member.",
        ),
      )
    return sourcePageId
  })
}
