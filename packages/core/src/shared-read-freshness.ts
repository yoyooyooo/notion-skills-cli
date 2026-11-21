import { Effect } from "effect"
import { effectiveCachePolicy, type ReadPolicyOptions } from "./cache.ts"
import type { ContentRecord } from "./model.ts"
import { fail, SkillsError } from "./model.ts"
import { loadSharedProfileEntryCached } from "./shared-profile.ts"
import { resolveSharedFreshness } from "./shared-freshness-policy.ts"
import { configuration } from "./store.ts"

/** Shared rules are resolved through the existing bounded Profile observation.
 * Cached rules keep their original validation time and a local binding owns no rules. */
export function sharedReadFreshness(record: ContentRecord, options: ReadPolicyOptions = {}) {
  return Effect.gen(function* () {
    const product = yield* effectiveCachePolicy
    const binding = (yield* configuration).shared_profile
    const locator = record.locator
    const selected =
      options.maxAge === undefined &&
      binding !== undefined &&
      locator.type === "shared_skill" &&
      binding.library_entry === locator.database_id
        ? yield* loadSharedProfileEntryCached(binding.library_entry, binding.profile_id, {
            ...(options.offline ? { offline: true } : {}),
            ...(options.refresh ? { refresh: true } : {}),
          })
        : undefined
    if (selected !== undefined && !selected.profile.enabled)
      return yield* Effect.fail(
        fail("SHARED_PROFILE_DISABLED", "The selected freshness Profile is disabled."),
      )
    const resolved = yield* Effect.try({
      try: () =>
        resolveSharedFreshness({
          ...(locator.type === "shared_skill" ? { skillId: locator.skill_id } : {}),
          ...(selected?.profile.freshness === undefined
            ? {}
            : { policy: selected.profile.freshness }),
          ...(options.maxAge === undefined ? {} : { explicitMaxAge: options.maxAge }),
          productReadMaxAge: product.read_max_age_ms,
        }),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("SHARED_FRESHNESS_INVALID", "Could not resolve shared freshness."),
    })
    return {
      ...resolved,
      profile:
        selected === undefined
          ? null
          : {
              profile_id: selected.profile.profile_id,
              fingerprint: selected.profile.fingerprint,
              freshness: selected.freshness,
            },
    }
  })
}
