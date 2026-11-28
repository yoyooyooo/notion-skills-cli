import { Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { SourceMemberCandidateSchema } from "./shared-source-materialization-model.ts"

export const SOURCE_MEMBER_CACHE_PREFIX = "cache/source-members"
/** v1 predated member-specific fixed-Git eligibility. Its original address stays
 * valid for older readers, but current reads, writes and retirement use only v2. */
export const SOURCE_MEMBER_CACHE_VERSION = 2
export const SOURCE_MATERIALIZATION_PENDING_PREFIX = "operations/current-source-materialization"
const sourceMemberCacheAddress = (scope: string, library: string, version: 1 | 2) =>
  `${SOURCE_MEMBER_CACHE_PREFIX}/${scope}/${library}${version === SOURCE_MEMBER_CACHE_VERSION ? ".v2" : ""}.json`
export const sourceMemberCacheKey = (scope: string, library: string) =>
  sourceMemberCacheAddress(scope, library, SOURCE_MEMBER_CACHE_VERSION)
export const SourceMemberCacheSchema = Schema.Struct({
  version: Schema.Literals([1, SOURCE_MEMBER_CACHE_VERSION]),
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
    key !== sourceMemberCacheAddress(value.scope, value.library_id, value.version) ||
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
