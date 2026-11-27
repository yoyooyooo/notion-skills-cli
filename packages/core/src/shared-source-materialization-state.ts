import { Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { SourceMemberCandidateSchema } from "./shared-source-materialization-model.ts"

export const SOURCE_MEMBER_CACHE_PREFIX = "cache/source-members"
export const SOURCE_MATERIALIZATION_PENDING_PREFIX = "operations/current-source-materialization"
export const sourceMemberCacheKey = (scope: string, library: string) =>
  `${SOURCE_MEMBER_CACHE_PREFIX}/${scope}/${library}.json`
export const SourceMemberCacheSchema = Schema.Struct({
  version: Schema.Literal(1),
  library_id: Schema.String,
  scope: Schema.String,
  candidates: Schema.Array(SourceMemberCandidateSchema),
})

/** A cache address never grants another credential or Library's candidates. */
export function decodeSourceMemberCache(key: string, input: unknown) {
  let value: typeof SourceMemberCacheSchema.Type
  try {
    value = Schema.decodeUnknownSync(SourceMemberCacheSchema)(input, { onExcessProperty: "error" })
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("STATE_CORRUPT", "The Source member cache has an invalid stored shape.")
  }
  if (
    key !== sourceMemberCacheKey(value.scope, value.library_id) ||
    value.candidates.some(
      (candidate) =>
        candidate.scope !== value.scope ||
        candidate.library_id !== value.library_id ||
        (candidate.record !== undefined &&
          (candidate.record.locator.type !== "shared_skill" ||
            candidate.record.locator.library_id !== value.library_id ||
            candidate.record.locator.skill_id !== candidate.expected_skill_id)),
    )
  )
    throw fail(
      "STATE_CONFLICT",
      "Source member candidates differ from their scoped Library cache address.",
    )
  return value
}
