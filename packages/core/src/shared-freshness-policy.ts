import { Schema } from "effect"
import { fail } from "./model.ts"

const duration = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const skillId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))

export const SharedFreshnessDurationsSchema = Schema.Struct({
  read_max_age_ms: Schema.optional(duration),
  source_check_max_age_ms: Schema.optional(duration),
})
export const SharedFreshnessPolicySchema = Schema.Struct({
  default: Schema.optional(SharedFreshnessDurationsSchema),
  skills: Schema.Array(
    Schema.Struct({
      skill_id: skillId,
      ...SharedFreshnessDurationsSchema.fields,
    }),
  ),
})
export type SharedFreshnessPolicy = typeof SharedFreshnessPolicySchema.Type
export type SharedFreshnessDurations = typeof SharedFreshnessDurationsSchema.Type

export function normalizeSharedFreshness(input: unknown): SharedFreshnessPolicy {
  let value: SharedFreshnessPolicy
  try {
    value = Schema.decodeUnknownSync(SharedFreshnessPolicySchema)(input, {
      onExcessProperty: "error",
    })
  } catch {
    throw fail(
      "SHARED_FRESHNESS_INVALID",
      "Freshness rules require finite integer durations and stable Skill IDs.",
    )
  }
  if (new Set(value.skills.map((row) => row.skill_id)).size !== value.skills.length)
    throw fail(
      "SHARED_FRESHNESS_CONFLICT",
      "A Profile may define only one freshness override per stable Skill ID.",
    )
  for (const row of [value.default, ...value.skills]) {
    if (row === undefined) continue
    for (const key of ["read_max_age_ms", "source_check_max_age_ms"] as const) {
      const amount = row[key]
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0))
        throw fail(
          "SHARED_FRESHNESS_INVALID",
          "Freshness durations must be nonnegative safe integer milliseconds.",
        )
    }
  }
  return {
    ...(value.default === undefined ? {} : { default: { ...value.default } }),
    skills: [...value.skills].sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
  }
}

/** Selection changes observation deadlines, never immutable bytes or authoring permission. */
export function resolveSharedFreshness(input: {
  readonly skillId?: string
  readonly policy?: SharedFreshnessPolicy
  readonly explicitMaxAge?: number
  readonly productReadMaxAge: number
}) {
  const policy = input.policy === undefined ? undefined : normalizeSharedFreshness(input.policy)
  const skill = policy?.skills.find((row) => row.skill_id === input.skillId)
  const read =
    input.explicitMaxAge ??
    skill?.read_max_age_ms ??
    policy?.default?.read_max_age_ms ??
    input.productReadMaxAge
  if (!Number.isSafeInteger(read) || read < 0)
    throw fail(
      "SHARED_FRESHNESS_INVALID",
      "The effective read duration must be a nonnegative safe integer.",
    )
  return {
    read_max_age_ms: read,
    source_check_max_age_ms:
      skill?.source_check_max_age_ms ?? policy?.default?.source_check_max_age_ms ?? null,
    read_policy_source:
      input.explicitMaxAge !== undefined
        ? ("explicit" as const)
        : skill?.read_max_age_ms !== undefined
          ? ("skill" as const)
          : policy?.default?.read_max_age_ms !== undefined
            ? ("profile" as const)
            : ("product" as const),
    source_policy_source:
      skill?.source_check_max_age_ms !== undefined
        ? ("skill" as const)
        : policy?.default?.source_check_max_age_ms !== undefined
          ? ("profile" as const)
          : ("source_definition" as const),
    notion_visibility_delay_ms: read,
    current_eligibility_max_age_ms: input.productReadMaxAge,
    full_body_max_age_ms: 86_400_000,
    immutable_bytes: "retained" as const,
    permissions: "existing_known_denial_and_authoring_guards" as const,
  }
}
