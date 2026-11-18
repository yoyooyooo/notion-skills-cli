import { Clock, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import {
  effectiveCachePolicy,
  freshness,
  locallySelectedScope,
  recordScope,
  validateReadPolicy,
  type ReadPolicyOptions,
} from "./cache.ts"
import { fail, property, SkillsError } from "./model.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import { libraryFromDatabase, LIBRARY_MARKER, loadSharedLibrary } from "./shared-library.ts"
import { pageId } from "./ref.ts"
import { withLocalLocks } from "./local-locks.ts"
import {
  writeCurrentSharedProfileRecord,
  canonicalSharedJson,
  querySharedProfileRecords,
  validateSharedRecordEnvelope,
  type SharedProfileRecord,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { retrieveView, viewId } from "./views.ts"
import { SharedFreshnessPolicySchema, normalizeSharedFreshness } from "./shared-freshness-policy.ts"

const stableId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u
const fingerprintPattern = /^[a-f0-9]{64}$/u
const recordIdPattern = /^profile-current-[a-f0-9]{64}$/u
const control = /[\u0000-\u001f\u007f-\u009f]/u
const FingerprintSchema = Schema.String.check(Schema.isPattern(fingerprintPattern))
const RecordIdSchema = Schema.String.check(Schema.isPattern(recordIdPattern))
export const SharedProfileRulesSchema = Schema.Struct({
  profile_id: Schema.String.check(Schema.isPattern(stableId)),
  name: Schema.String,
  enabled: Schema.Boolean,
  default_view_id: Schema.optional(Schema.String),
  freshness: Schema.optional(SharedFreshnessPolicySchema),
})
export type SharedProfileRules = typeof SharedProfileRulesSchema.Type
export const SharedProfilePayloadSchema = Schema.Struct({
  version: Schema.Literal(2),
  library_id: Schema.String.check(Schema.isPattern(stableId)),
  ...SharedProfileRulesSchema.fields,
})
export const SharedProfilePlanSchema = Schema.Struct({
  version: Schema.Literal(2),
  record_id: RecordIdSchema,
  fingerprint: FingerprintSchema,
  expected_fingerprint: Schema.NullOr(FingerprintSchema),
  operation_id: Schema.String,
  payload: SharedProfilePayloadSchema,
})
export type SharedProfilePlan = typeof SharedProfilePlanSchema.Type
export const SharedProfilePendingSchema = Schema.Struct({
  version: Schema.Literal(2),
  scope: Schema.String,
  library_id: Schema.String,
  profile_id: Schema.String,
  target_page_id: Schema.NullOr(Schema.String),
  plan: SharedProfilePlanSchema,
})
export const SharedProfileSchema = Schema.Struct({
  ...SharedProfileRulesSchema.fields,
  library_id: Schema.String.check(Schema.isPattern(stableId)),
  record_id: RecordIdSchema,
  fingerprint: FingerprintSchema,
  record_page_id: Schema.String,
})
export type SharedProfile = typeof SharedProfileSchema.Type
export const SharedProfileObservationSchema = Schema.Struct({
  domain: Schema.Literal("shared_profile_v2"),
  scope: Schema.String,
  selection_id: Schema.String,
  profile_id: Schema.String,
  fetched_at: Schema.Number,
  generation: Schema.Number,
  library: SharedLibrarySchema,
  profile: SharedProfileSchema,
})
type CurrentProfile = {
  readonly profile: SharedProfile
  readonly record: SharedProfileRecord
}

function invalid(message: string, details?: unknown) {
  return fail("SHARED_PROFILE_INVALID", message, details)
}
function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("The Profile does not match its current rule contract."),
  })
}
function strict<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema)(input, { onExcessProperty: "error" })
}
function rules(payload: SharedProfileRules): SharedProfileRules {
  return {
    profile_id: payload.profile_id,
    name: payload.name,
    enabled: payload.enabled,
    ...(payload.default_view_id === undefined ? {} : { default_view_id: payload.default_view_id }),
    ...(payload.freshness === undefined ? {} : { freshness: payload.freshness }),
  }
}
function normalizedRules(input: unknown): SharedProfileRules {
  const value = strict(SharedProfileRulesSchema, input)
  if (
    value.name.trim() !== value.name ||
    value.name.length === 0 ||
    value.name.length > 200 ||
    control.test(value.name)
  )
    throw invalid(
      "Profile Name must be nonempty, trimmed and at most 200 characters without control characters.",
    )
  return {
    profile_id: value.profile_id,
    name: value.name,
    enabled: value.enabled,
    ...(value.default_view_id === undefined
      ? {}
      : { default_view_id: viewId(value.default_view_id) }),
    ...(value.freshness === undefined
      ? {}
      : { freshness: normalizeSharedFreshness(value.freshness) }),
  }
}

function profileRecordId(library: SharedLibrary, profileId: string) {
  return sha256(canonicalSharedJson([library.library_id, profileId])).pipe(
    Effect.map((hash) => `profile-current-${hash}`),
  )
}

/** Prepare the current intent. The fingerprint contains no predecessor or operation identity. */
export function prepareSharedProfileChange(
  library: SharedLibrary,
  input: {
    readonly profile: unknown
    readonly expectedFingerprint: string | null
  },
) {
  return Effect.gen(function* () {
    const profile = yield* checked(() => normalizedRules(input.profile))
    if (
      !stableId.test(library.library_id) ||
      (input.expectedFingerprint !== null &&
        (typeof input.expectedFingerprint !== "string" ||
          !fingerprintPattern.test(input.expectedFingerprint)))
    )
      return yield* Effect.fail(
        invalid("Profile changes require a current fingerprint, or explicit null for creation."),
      )
    const payload = {
      version: 2 as const,
      library_id: library.library_id,
      ...profile,
    }
    const recordId = yield* profileRecordId(library, profile.profile_id)
    const fingerprint = yield* sha256(canonicalSharedJson(payload))
    const operation = `set-profile-${yield* sha256(canonicalSharedJson([recordId, input.expectedFingerprint, fingerprint]))}`
    yield* checked(() => validateSharedRecordEnvelope(operation, payload))
    return {
      version: 2 as const,
      record_id: recordId,
      fingerprint,
      expected_fingerprint: input.expectedFingerprint,
      operation_id: operation,
      payload,
    } satisfies SharedProfilePlan
  })
}

export function validateSharedProfilePlan(library: SharedLibrary, value: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() => strict(SharedProfilePlanSchema, value))
    if (plan.payload.library_id !== library.library_id)
      return yield* Effect.fail(
        fail("SHARED_PROFILE_SCOPE", "The Profile belongs to a different library."),
      )
    const expected = yield* prepareSharedProfileChange(library, {
      profile: rules(plan.payload),
      expectedFingerprint: plan.expected_fingerprint,
    })
    if (canonicalSharedJson(expected) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        invalid("The Profile intent differs from its current rule content."),
      )
    return plan
  })
}

function profileFromRecord(library: SharedLibrary, record: SharedProfileRecord) {
  return Effect.gen(function* () {
    const payload = yield* checked(() => strict(SharedProfilePayloadSchema, record.payload))
    const current = yield* prepareSharedProfileChange(library, {
      profile: rules(payload),
      expectedFingerprint: null,
    })
    if (
      canonicalSharedJson(payload) !== canonicalSharedJson(current.payload) ||
      payload.library_id !== library.library_id ||
      record.kind !== "profile" ||
      record.skill_page_id !== null ||
      record.entity_id !== payload.profile_id ||
      record.record_id !== current.record_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_PROFILE_SCOPE",
          "The current Profile has a different owner or stable identity.",
        ),
      )
    return {
      record,
      profile: {
        library_id: library.library_id,
        ...rules(payload),
        record_id: record.record_id,
        fingerprint: current.fingerprint,
        record_page_id: record.page_id,
      },
    } satisfies CurrentProfile
  })
}

function readCurrentProfiles(library: SharedLibrary, profileId?: string) {
  return Effect.gen(function* () {
    if (profileId !== undefined && !stableId.test(profileId))
      return yield* Effect.fail(invalid("Use an exact stable Profile ID."))
    const records = yield* querySharedProfileRecords(
      library,
      profileId === undefined
        ? {}
        : { entityId: profileId, recordId: yield* profileRecordId(library, profileId) },
    )
    return yield* Effect.forEach(records, (record) => profileFromRecord(library, record))
  })
}

/** One complete metadata query across current Profiles, with no per-Profile GETs. */
export function listSharedProfiles(library: SharedLibrary) {
  return Effect.gen(function* () {
    const current = yield* readCurrentProfiles(library)
    return {
      library_id: library.library_id,
      profiles: current
        .map(({ profile }) => profile)
        .sort((a, b) => (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : 0)),
      source: "notion" as const,
      metadata_only: true as const,
    }
  })
}

/** Load the unique current rules. Old payloads and duplicate physical rows are errors. */
export function loadSharedProfile(library: SharedLibrary, profileId: string) {
  return Effect.gen(function* () {
    const current = (yield* readCurrentProfiles(library, profileId))[0]
    if (current === undefined)
      return yield* Effect.fail(
        fail("SHARED_PROFILE_NOT_FOUND", "The selected Profile has no current rule record.", {
          profile_id: profileId,
        }),
      )
    return current.profile
  })
}

function profileSelection(library: SharedLibrary, profileId: string) {
  return sha256(canonicalSharedJson(["shared-profile-v2", library, profileId]))
}
function profileEntrySelection(entry: string, profileId: string) {
  return sha256(canonicalSharedJson(["shared-profile-entry-v2", entry, profileId]))
}
function profileObservationKey(scope: string, selection: string) {
  return `cache/views/${scope}/${selection}.json`
}
function invalidateProfileObservation(library: SharedLibrary, profileId: string, scope: string) {
  return Effect.gen(function* () {
    const descriptor = yield* profileSelection(library, profileId)
    const entry = yield* profileEntrySelection(library.skills.database_id, profileId)
    yield* (yield* Store).retireKeys([
      profileObservationKey(scope, descriptor),
      profileObservationKey(scope, entry),
    ])
  })
}

/**
 * Profile rules use the existing View-observation cache and generation fences.
 * Only a complete, unique current record is cached; local preferences still
 * contain only the selected library entry and Profile ID.
 */
export function loadSharedProfileCached(
  library: SharedLibrary,
  profileId: string,
  options: ReadPolicyOptions = {},
) {
  return Effect.gen(function* () {
    const selection = yield* profileSelection(library, profileId)
    return yield* observeProfile(selection, library.skills.database_id, profileId, options, library)
  })
}

/**
 * A machine binding contains only two IDs. Cache the validated descriptor with
 * its Profile observation so a warm or explicit offline startup needs no GET.
 */
export function loadSharedProfileEntryCached(
  input: string,
  profileId: string,
  options: ReadPolicyOptions = {},
) {
  return Effect.gen(function* () {
    const entry = pageId(input)
    if (!entry)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Use an exact shared library entry ID or Notion URL."),
      )
    const selection = yield* profileEntrySelection(entry, profileId)
    return yield* observeProfile(selection, entry, profileId, options)
  })
}

function observeProfile(
  selection: string,
  entry: string,
  profileId: string,
  options: ReadPolicyOptions,
  suppliedLibrary?: SharedLibrary,
) {
  return Effect.gen(function* () {
    yield* checked(() => validateReadPolicy(options))
    if (!stableId.test(profileId))
      return yield* Effect.fail(invalid("Use an exact stable Profile ID."))
    const local = options.refresh
      ? undefined
      : yield* locallySelectedScope(Boolean(options.offline))
    const scope = local ?? (yield* authScope)
    const store = yield* Store
    const now = yield* Clock.currentTimeMillis
    const maxAge = options.maxAge ?? (yield* effectiveCachePolicy).catalog_max_age_ms
    let cached: typeof SharedProfileObservationSchema.Type | undefined
    if (!options.refresh) {
      const saved = yield* store.readJson(
        profileObservationKey(scope, selection),
        SharedProfileObservationSchema,
      )
      if (saved !== undefined) {
        if (
          saved.domain !== "shared_profile_v2" ||
          saved.scope !== scope ||
          saved.selection_id !== selection ||
          saved.profile_id !== profileId ||
          saved.profile.profile_id !== profileId ||
          saved.profile.library_id !== saved.library.library_id ||
          saved.library.skills.database_id !== entry ||
          !Number.isSafeInteger(saved.generation) ||
          saved.generation <= 0 ||
          !Number.isFinite(saved.fetched_at) ||
          saved.fetched_at < 0 ||
          saved.fetched_at > now
        )
          return yield* Effect.fail(
            fail(
              "STATE_CORRUPT",
              "The cached Profile observation has invalid scope, identity, generation or time.",
            ),
          )
        if (
          suppliedLibrary !== undefined &&
          canonicalSharedJson(saved.library) !== canonicalSharedJson(suppliedLibrary)
        )
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The cached Profile uses a different library descriptor."),
          )
        if (suppliedLibrary === undefined) {
          // Reuse descriptor validation on the retained observed marker; this is
          // a local shape check, not a claim of current remote availability.
          yield* checked(() =>
            libraryFromDatabase({
              id: entry,
              description: [
                { plain_text: `${LIBRARY_MARKER}${canonicalSharedJson(saved.library)}` },
              ],
            }),
          ).pipe(
            Effect.mapError(() =>
              fail("STATE_CORRUPT", "The cached Profile has an invalid shared library descriptor."),
            ),
          )
        }
        const frozen = yield* prepareSharedProfileChange(saved.library, {
          profile: rules(saved.profile),
          expectedFingerprint: null,
        })
        const observedPage = yield* checked(() => viewId(saved.profile.record_page_id)).pipe(
          Effect.mapError(() =>
            fail(
              "STATE_CORRUPT",
              "The cached Profile has an invalid observed record page identity.",
            ),
          ),
        )
        if (
          frozen.fingerprint !== saved.profile.fingerprint ||
          frozen.record_id !== saved.profile.record_id ||
          observedPage !== saved.profile.record_page_id
        )
          return yield* Effect.fail(
            fail(
              "STATE_CORRUPT",
              "The cached Profile fingerprint no longer matches its observed rules.",
            ),
          )
        cached = saved
      }
    }
    const knownLibrary = suppliedLibrary ?? cached?.library
    if (!options.offline && knownLibrary !== undefined) {
      const pending = yield* pendingProfile(knownLibrary, scope, profileId)
      if (pending !== undefined)
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_PROFILE_PENDING",
              "A known original Profile change is unresolved; reconcile it before using a current default.",
            ),
            pending.plan,
            pending.key,
          ),
        )
    }
    if (cached !== undefined && (options.offline || now - cached.fetched_at < maxAge))
      return {
        library: cached.library,
        scope,
        profile: cached.profile,
        source: "local_cache" as const,
        metadata_only: true as const,
        freshness: freshness(options, cached.fetched_at, now, maxAge, true),
      }
    if (options.offline)
      return yield* Effect.fail(
        fail(
          "CACHE_MISSING",
          "No complete Profile observation exists for this credential, library and Profile selection.",
        ),
      )

    const validated = local === undefined ? scope : yield* authScope
    if (local !== undefined && local !== validated)
      yield* store.retireKeys([profileObservationKey(local, selection)])
    const generation = yield* store.reserveCacheGeneration(validated, `views-${selection}`)
    const startedAt = yield* Clock.currentTimeMillis
    let refreshedLibrary: SharedLibrary | undefined
    const observed = yield* Effect.gen(function* () {
      const library = suppliedLibrary ?? (yield* loadSharedLibrary(entry))
      if (library.skills.database_id !== entry)
        return yield* Effect.fail(
          fail(
            "SHARED_PROFILE_SCOPE",
            "The selected entry returned a different shared library descriptor.",
          ),
        )
      refreshedLibrary = library
      const pending = yield* pendingProfile(library, validated, profileId)
      if (pending !== undefined)
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_PROFILE_PENDING",
              "The current credential has an unresolved original Profile change.",
            ),
            pending.plan,
            pending.key,
          ),
        )
      return { library, profile: yield* loadSharedProfile(library, profileId) }
    }).pipe(Effect.result)
    if (observed._tag === "Failure") {
      if (observed.failure.code !== "SHARED_PROFILE_PENDING") {
        const failedLibrary = refreshedLibrary ?? knownLibrary
        if (failedLibrary !== undefined)
          yield* invalidateProfileObservation(failedLibrary, profileId, validated)
        else yield* store.retireKeys([profileObservationKey(validated, selection)])
      }
      return yield* Effect.fail(observed.failure)
    }
    const newlyPending = yield* pendingProfile(observed.success.library, validated, profileId)
    if (newlyPending !== undefined)
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_PROFILE_PENDING",
            "A Profile dispatch became unresolved during this observation; reconcile it before current discovery.",
          ),
          newlyPending.plan,
          newlyPending.key,
        ),
      )
    yield* store.writeJson(profileObservationKey(validated, selection), {
      domain: "shared_profile_v2",
      scope: validated,
      selection_id: selection,
      profile_id: profileId,
      fetched_at: startedAt,
      generation,
      ...observed.success,
    })
    yield* recordScope(validated)
    return {
      ...observed.success,
      scope: validated,
      source: "notion" as const,
      metadata_only: true as const,
      freshness: freshness(options, startedAt, yield* Clock.currentTimeMillis, maxAge, true),
    }
  })
}

/** Selection policy only. A View is presentation/filtering, never authorization. */
export function selectProfileView(profile?: SharedProfile, explicitView?: string) {
  if (explicitView !== undefined)
    return { selection: "explicit" as const, view: viewId(explicitView) }
  if (profile !== undefined && !profile.enabled)
    throw fail(
      "SHARED_PROFILE_DISABLED",
      "The selected Profile is disabled; choose an enabled Profile or an explicit session View.",
      { profile_id: profile.profile_id },
    )
  if (profile?.default_view_id !== undefined)
    return {
      selection: "profile" as const,
      view: viewId(profile.default_view_id),
      profile_id: profile.profile_id,
      profile_fingerprint: profile.fingerprint,
    }
  return { selection: "first" as const }
}

export function sharedProfilePendingPrefix(scope: string, libraryId: string, profileId: string) {
  return Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/u.test(scope) || !stableId.test(libraryId) || !stableId.test(profileId))
      return yield* Effect.fail(
        invalid(
          "A pending Profile write needs its exact credential, library and Profile identities.",
        ),
      )
    return `operations/shared-profile-pending/${scope}/${yield* sha256(canonicalSharedJson([libraryId, profileId]))}/`
  })
}
function pendingProfile(library: SharedLibrary, scope: string, profileId: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const prefix = yield* sharedProfilePendingPrefix(scope, library.library_id, profileId)
    const keys = yield* store.listKeys(prefix)
    if (keys.some((key) => key !== `${prefix}pending.json`))
      return yield* Effect.fail(
        fail(
          "STATE_MIGRATION_REQUIRED",
          "Remove incompatible Profile write state before continuing.",
          {
            profile_id: profileId,
            next_action: "resolve_current_profile",
          },
        ),
      )
    const key = `${prefix}pending.json`
    const saved = yield* store.readJson(key, SharedProfilePendingSchema)
    if (saved === undefined) return undefined
    const plan = yield* validateSharedProfilePlan(library, saved.plan)
    if (
      saved.scope !== scope ||
      saved.library_id !== library.library_id ||
      saved.profile_id !== profileId ||
      plan.payload.profile_id !== profileId ||
      (saved.target_page_id !== null && pageId(saved.target_page_id) !== saved.target_page_id) ||
      (plan.expected_fingerprint === null) !== (saved.target_page_id === null)
    )
      return yield* Effect.fail(
        fail(
          "STATE_CORRUPT",
          "The pending Profile write has a different scope or target identity.",
        ),
      )
    return { key, plan, target_page_id: saved.target_page_id }
  })
}
function recovery(error: SkillsError, plan: SharedProfilePlan, key?: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    profile_id: plan.payload.profile_id,
    fingerprint: plan.fingerprint,
    operation_id: plan.operation_id,
    next_mode: "reconcile",
    ...(key === undefined ? {} : { pending_journal: key }),
    recovery: { plan },
  })
}
function currentResult(
  current: CurrentProfile,
  plan: SharedProfilePlan,
  status: "applied" | "unchanged" | "current_matches",
) {
  return {
    profile: current.profile,
    fingerprint: current.profile.fingerprint,
    operation_id: plan.operation_id,
    status,
    current: true as const,
    metadata_only: true as const,
  }
}
function confirmCurrent(
  library: SharedLibrary,
  plan: SharedProfilePlan,
  scope: string,
  targetPageId: string | null,
  key: string | undefined,
  status: "applied" | "current_matches",
) {
  return Effect.gen(function* () {
    const current = (yield* readCurrentProfiles(library, plan.payload.profile_id))[0]
    if (
      current !== undefined &&
      targetPageId !== null &&
      current.profile.record_page_id !== targetPageId
    )
      return yield* Effect.fail(
        fail("SHARED_PROFILE_CONFLICT", "The current Profile is on a different page.", {
          expected_page_id: targetPageId,
          current_page_id: current.profile.record_page_id,
        }),
      )
    if (current?.profile.fingerprint !== plan.fingerprint)
      return yield* Effect.fail(
        fail(
          current === undefined || current.profile.fingerprint === plan.expected_fingerprint
            ? "SHARED_PROFILE_UNRESOLVED"
            : "SHARED_PROFILE_CONFLICT",
          "The intended current rules have not been observed. Reconcile without repeating the write.",
          { current_fingerprint: current?.profile.fingerprint ?? null },
        ),
      )
    // Current rules are sufficient. No predecessor or original-execution proof is required.
    // Keep the pending barrier if cache invalidation itself fails.
    yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
    if (key !== undefined) yield* (yield* Store).retireKeys([key])
    return currentResult(current, plan, status)
  })
}

/** One current record and at most one POST/PATCH per intent. Local serialization
 * prevents cooperating same-machine writers from racing; Notion does not provide CAS. */
export function saveSharedProfile(
  library: SharedLibrary,
  input: {
    readonly profile: unknown
    readonly expectedFingerprint: string | null
    readonly mode?: "apply" | "reconcile"
  },
) {
  return Effect.gen(function* () {
    const requested = yield* prepareSharedProfileChange(library, input)
    const mode = input.mode ?? "apply"
    if (mode !== "apply" && mode !== "reconcile")
      return yield* Effect.fail(invalid("Profile save mode must be apply or reconcile."))
    const scope = yield* authScope
    const store = yield* Store
    return yield* withLocalLocks(
      store.root,
      [`profile:${library.records.data_source_id}:${requested.payload.profile_id}`],
      Effect.gen(function* () {
        const pending = yield* pendingProfile(library, scope, requested.payload.profile_id)
        if (
          pending !== undefined &&
          canonicalSharedJson(pending.plan) !== canonicalSharedJson(requested)
        )
          return yield* Effect.fail(
            recovery(
              fail("SHARED_PROFILE_PENDING", "A different Profile write is unresolved."),
              pending.plan,
              pending.key,
            ),
          )
        const plan = pending?.plan ?? requested
        if (pending !== undefined || mode === "reconcile")
          return yield* confirmCurrent(
            library,
            plan,
            scope,
            pending?.target_page_id ?? null,
            pending?.key,
            "current_matches",
          ).pipe(Effect.mapError((error) => recovery(error, plan, pending?.key)))

        const read = yield* readCurrentProfiles(library, plan.payload.profile_id).pipe(
          Effect.result,
        )
        if (read._tag === "Failure") {
          yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
          return yield* Effect.fail(read.failure)
        }
        const current = read.success[0]
        if (current?.profile.fingerprint === plan.fingerprint)
          return currentResult(current, plan, "unchanged")
        if ((current?.profile.fingerprint ?? null) !== plan.expected_fingerprint)
          return yield* Effect.fail(
            fail("SHARED_PROFILE_STALE", "The current rules changed. Review them before writing.", {
              profile_id: plan.payload.profile_id,
              expected_fingerprint: plan.expected_fingerprint,
              current_fingerprint: current?.profile.fingerprint ?? null,
            }),
          )
        if (plan.payload.enabled && plan.payload.default_view_id !== undefined) {
          const view = yield* retrieveView(plan.payload.default_view_id, library.skills.database_id)
          if (view.data_source_id !== library.skills.data_source_id)
            return yield* Effect.fail(
              fail(
                "VIEW_SCOPE_MISMATCH",
                "The Profile View belongs to a different Skills data source.",
                {
                  view_id: view.id,
                  profile_id: plan.payload.profile_id,
                },
              ),
            )
        }
        const prefix = yield* sharedProfilePendingPrefix(
          scope,
          library.library_id,
          plan.payload.profile_id,
        )
        const key = `${prefix}pending.json`
        const targetPageId = current?.record.page_id ?? null
        yield* store.writeJson(key, {
          version: 2,
          scope,
          library_id: library.library_id,
          profile_id: plan.payload.profile_id,
          target_page_id: targetPageId,
          plan,
        })
        const written = yield* writeCurrentSharedProfileRecord(library, {
          current: current?.record ?? null,
          recordId: plan.record_id,
          operationId: plan.operation_id,
          entityId: plan.payload.profile_id,
          payload: plan.payload,
        }).pipe(Effect.result)
        if (written._tag === "Failure") {
          const error = written.failure
          const details = property(error.details)
          // The transport wraps admitted-write uncertainty as WRITE_OUTCOME_UNKNOWN.
          // Its bare budget error and explicit rejection phases did not apply this write.
          if (
            details.phase === "input_rejected" ||
            details.phase === "definitive_rejection" ||
            error.code === "REQUEST_BUDGET_EXHAUSTED"
          ) {
            yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
            yield* store.retireKeys([key])
            return yield* Effect.fail(
              fail(error.code, error.message, {
                ...details,
                profile_id: plan.payload.profile_id,
                next_action: "review_current_profile",
              }),
            )
          }
          return yield* Effect.fail(recovery(error, plan, key))
        }
        return yield* confirmCurrent(library, plan, scope, targetPageId, key, "applied").pipe(
          Effect.mapError((error) => recovery(error, plan, key)),
        )
      }),
    )
  })
}
