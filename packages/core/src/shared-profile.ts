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
import {
  appendSharedProfileRecord,
  canonicalSharedJson,
  querySharedProfileRecords,
  validateSharedRecordEnvelope,
  type SharedProfileRecord,
} from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { retrieveView, viewId } from "./views.ts"

const stableId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u
const revisionId = /^profile-[a-f0-9]{64}$/u
const control = /[\u0000-\u001f\u007f-\u009f]/u
const RevisionIdSchema = Schema.String.check(Schema.isPattern(revisionId))
export const SharedProfileRulesSchema = Schema.Struct({
  profile_id: Schema.String.check(Schema.isPattern(stableId)),
  name: Schema.String,
  enabled: Schema.Boolean,
  default_view_id: Schema.optional(Schema.String),
})
export type SharedProfileRules = typeof SharedProfileRulesSchema.Type
export const SharedProfileRevisionSchema = Schema.Struct({
  version: Schema.Literal(1),
  library_id: Schema.String.check(Schema.isPattern(stableId)),
  ...SharedProfileRulesSchema.fields,
  parent_revision_id: Schema.NullOr(RevisionIdSchema),
})
export const SharedProfilePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision_id: RevisionIdSchema,
  operation_id: Schema.String,
  payload: SharedProfileRevisionSchema,
})
export type SharedProfilePlan = typeof SharedProfilePlanSchema.Type
export const SharedProfilePendingSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  library_id: Schema.String,
  profile_id: Schema.String,
  plan: SharedProfilePlanSchema,
})
export const SharedProfileSchema = Schema.Struct({
  ...SharedProfileRulesSchema.fields,
  library_id: Schema.String.check(Schema.isPattern(stableId)),
  revision_id: RevisionIdSchema,
  parent_revision_id: Schema.NullOr(RevisionIdSchema),
  record_page_id: Schema.String,
})
export type SharedProfile = typeof SharedProfileSchema.Type
export const SharedProfileObservationSchema = Schema.Struct({
  domain: Schema.Literal("shared_profile_v1"),
  scope: Schema.String,
  selection_id: Schema.String,
  profile_id: Schema.String,
  fetched_at: Schema.Number,
  generation: Schema.Number,
  library: SharedLibrarySchema,
  profile: SharedProfileSchema,
})
type Revision = { readonly plan: SharedProfilePlan; readonly record: SharedProfileRecord }

function invalid(message: string, details?: unknown) {
  return fail("SHARED_PROFILE_INVALID", message, details)
}
function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("The Profile does not match its versioned rule contract."),
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
  }
}

/** Freeze an exact rule revision; this requires Crypto only and performs no I/O. */
export function prepareSharedProfileChange(
  library: SharedLibrary,
  input: {
    readonly profile: unknown
    readonly expectedRevision: string | null
  },
) {
  return Effect.gen(function* () {
    const profile = yield* checked(() => normalizedRules(input.profile))
    if (
      !stableId.test(library.library_id) ||
      (input.expectedRevision !== null &&
        (typeof input.expectedRevision !== "string" || !revisionId.test(input.expectedRevision)))
    )
      return yield* Effect.fail(
        invalid(
          "Profile changes require the exact library and a prior revision, or explicit null for initial creation.",
        ),
      )
    const payload = {
      version: 1 as const,
      library_id: library.library_id,
      ...profile,
      parent_revision_id: input.expectedRevision,
    }
    const revision = `profile-${yield* sha256(canonicalSharedJson(payload))}`
    const operation = `set-${revision}`
    yield* checked(() => validateSharedRecordEnvelope(operation, payload))
    return {
      version: 1 as const,
      revision_id: revision,
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
      expectedRevision: plan.payload.parent_revision_id,
    })
    if (canonicalSharedJson(expected) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        invalid("The Profile revision differs from its exact frozen rule content."),
      )
    return plan
  })
}

function revisionFromRecord(library: SharedLibrary, record: SharedProfileRecord) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedProfilePlan(library, {
      version: 1,
      revision_id: record.record_id,
      operation_id: record.operation_id,
      payload: record.payload,
    })
    if (
      record.kind !== "profile" ||
      record.skill_page_id !== null ||
      record.entity_id !== plan.payload.profile_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_PROFILE_SCOPE",
          "The Profile record has a different library scope or entity identity.",
        ),
      )
    return { plan, record } satisfies Revision
  })
}
function readRevisions(library: SharedLibrary, profileId?: string) {
  return Effect.gen(function* () {
    if (profileId !== undefined && !stableId.test(profileId))
      return yield* Effect.fail(invalid("Use an exact stable Profile ID."))
    const records = yield* querySharedProfileRecords(
      library,
      profileId === undefined ? {} : { entityId: profileId },
    )
    return yield* Effect.forEach(records, (record) => revisionFromRecord(library, record))
  })
}

function resolveProfile(profileId: string, revisions: readonly Revision[]): SharedProfile {
  const chosen = revisions.filter((revision) => revision.plan.payload.profile_id === profileId)
  if (chosen.length === 0)
    throw fail(
      "SHARED_PROFILE_NOT_FOUND",
      "The selected Profile has no visible shared rule revision.",
      { profile_id: profileId },
    )
  const byId = new Map(chosen.map((revision) => [revision.plan.revision_id, revision]))
  const parents = new Set<string>()
  const complete = new Set<string>()
  for (const start of chosen) {
    let next: Revision | undefined = start
    const chain = new Set<string>()
    while (next !== undefined && !complete.has(next.plan.revision_id)) {
      const id = next.plan.revision_id
      if (chain.has(id))
        throw invalid("Profile revision history contains a cycle.", { profile_id: profileId })
      chain.add(id)
      const parent = next.plan.payload.parent_revision_id
      if (parent === null) break
      parents.add(parent)
      next = byId.get(parent)
      if (next === undefined)
        throw fail(
          "SHARED_PROFILE_BASELINE_MISSING",
          "A Profile parent revision is unavailable; missing history does not authorize selecting a replacement.",
          { profile_id: profileId, missing_revision_id: parent },
        )
    }
    for (const id of chain) complete.add(id)
  }
  // Collect every direct edge even when its parent's chain was already visited.
  for (const revision of chosen)
    if (revision.plan.payload.parent_revision_id !== null)
      parents.add(revision.plan.payload.parent_revision_id)
  const heads = chosen.filter((revision) => !parents.has(revision.plan.revision_id))
  const head = heads[0]
  if (heads.length !== 1 || head === undefined)
    throw fail(
      "SHARED_PROFILE_CONFLICT",
      "Profile revisions have incompatible heads; no timestamp or page order selects a winner.",
      {
        profile_id: profileId,
        revision_ids: heads.map((revision) => revision.plan.revision_id).sort(),
      },
    )
  return {
    library_id: head.plan.payload.library_id,
    ...rules(head.plan.payload),
    revision_id: head.plan.revision_id,
    parent_revision_id: head.plan.payload.parent_revision_id,
    record_page_id: head.record.page_id,
  }
}

/** One metadata query sequence across all Profiles; never one GET per Profile. */
export function listSharedProfiles(library: SharedLibrary) {
  return Effect.gen(function* () {
    const revisions = yield* readRevisions(library)
    const ids = [...new Set(revisions.map((revision) => revision.plan.payload.profile_id))].sort()
    const profiles = yield* checked(() => ids.map((id) => resolveProfile(id, revisions)))
    return {
      library_id: library.library_id,
      profiles,
      source: "notion" as const,
      metadata_only: true as const,
    }
  })
}

/** Load the selected durable Profile without a local copy of its rules or members. */
export function loadSharedProfile(library: SharedLibrary, profileId: string) {
  return Effect.gen(function* () {
    const revisions = yield* readRevisions(library, profileId)
    return yield* checked(() => resolveProfile(profileId, revisions))
  })
}

function profileSelection(library: SharedLibrary, profileId: string) {
  return sha256(canonicalSharedJson(["shared-profile-v1", library, profileId]))
}
function profileEntrySelection(entry: string, profileId: string) {
  return sha256(canonicalSharedJson(["shared-profile-entry-v1", entry, profileId]))
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
 * Only a complete, single-head shared result is cached; local preferences still
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
          saved.domain !== "shared_profile_v1" ||
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
          expectedRevision: saved.profile.parent_revision_id,
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
          frozen.revision_id !== saved.profile.revision_id ||
          observedPage !== saved.profile.record_page_id
        )
          return yield* Effect.fail(
            fail(
              "STATE_CORRUPT",
              "The cached Profile revision no longer matches its observed rules.",
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
      domain: "shared_profile_v1",
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
      profile_revision_id: profile.revision_id,
    }
  return { selection: "first" as const }
}

export function sharedProfilePendingPrefix(scope: string, libraryId: string, profileId: string) {
  return Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/u.test(scope) || !stableId.test(libraryId) || !stableId.test(profileId))
      return yield* Effect.fail(
        invalid(
          "A Profile pending journal needs its exact authentication, library and Profile identities.",
        ),
      )
    return `operations/shared-profile-pending/${scope}/${yield* sha256(canonicalSharedJson([libraryId, profileId]))}/`
  })
}
function pendingProfile(library: SharedLibrary, scope: string, profileId: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const prefix = yield* sharedProfilePendingPrefix(scope, library.library_id, profileId)
    const pending: Array<{ key: string; plan: SharedProfilePlan }> = []
    for (const key of yield* store.listKeys(prefix)) {
      const saved = yield* store.readJson(key, SharedProfilePendingSchema)
      if (saved === undefined) continue
      const plan = yield* validateSharedProfilePlan(library, saved.plan)
      if (
        saved.scope !== scope ||
        saved.library_id !== library.library_id ||
        saved.profile_id !== profileId ||
        plan.payload.profile_id !== profileId ||
        key !== `${prefix}${plan.revision_id}.json`
      )
        return yield* Effect.fail(
          fail(
            "STATE_CORRUPT",
            "The original Profile dispatch journal has a different identity or scope.",
          ),
        )
      pending.push({ key, plan })
    }
    if (pending.length > 1)
      return yield* Effect.fail(
        fail(
          "SHARED_PROFILE_PENDING_CONFLICT",
          "Multiple original Profile dispatches require individual reconciliation; none can be silently replaced.",
          {
            profile_id: profileId,
            revision_ids: pending.map((item) => item.plan.revision_id).sort(),
          },
        ),
      )
    return pending[0]
  })
}
function recovery(error: SkillsError, plan: SharedProfilePlan, key?: string) {
  const verified = property(error.details).operation_verified === true
  return fail(error.code, error.message, {
    ...property(error.details),
    profile_id: plan.payload.profile_id,
    revision_id: plan.revision_id,
    operation_id: plan.operation_id,
    ...(verified ? { next_action: "review_profile_conflict" } : { next_mode: "reconcile" }),
    ...(key === undefined ? {} : { pending_journal: key }),
    recovery: { plan },
  })
}
function confirmed(
  library: SharedLibrary,
  plan: SharedProfilePlan,
  mode: "create" | "reconcile",
  scope: string,
  key?: string,
  supplied?: readonly Revision[],
) {
  return Effect.gen(function* () {
    const revisions = supplied ?? (yield* readRevisions(library, plan.payload.profile_id))
    const original = revisions.find((revision) => revision.plan.revision_id === plan.revision_id)
    if (original === undefined || canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "SHARED_PROFILE_UNRESOLVED",
          "The original Profile revision is not yet visible in the shared metadata query; retain its plan and reconcile without replay.",
        ),
      )
    if (key !== undefined) yield* (yield* Store).retireKeys([key])
    yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
    const profile = yield* checked(() => resolveProfile(plan.payload.profile_id, revisions)).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          operation_verified: true,
          revision_id: plan.revision_id,
        }),
      ),
    )
    return {
      profile,
      operation_id: plan.operation_id,
      revision_id: plan.revision_id,
      current: profile.revision_id === plan.revision_id,
      mode,
      verified: true as const,
      metadata_only: true as const,
    }
  })
}

/**
 * At most one POST. Pending state is a replay barrier, not Profile authority.
 * An invisible first write on another empty machine remains an explicit shared
 * visibility boundary; this does not claim Notion has unique keys or a CAS.
 */
export function saveSharedProfile(
  library: SharedLibrary,
  input: {
    readonly profile: unknown
    readonly expectedRevision: string | null
    readonly mode?: "create" | "reconcile"
  },
) {
  return Effect.gen(function* () {
    const requested = yield* prepareSharedProfileChange(library, input)
    const mode = input.mode ?? "create"
    if (mode !== "create" && mode !== "reconcile")
      return yield* Effect.fail(invalid("Profile save mode must be create or reconcile."))
    const scope = yield* authScope
    const store = yield* Store
    const pending = yield* pendingProfile(library, scope, requested.payload.profile_id)
    if (
      pending !== undefined &&
      canonicalSharedJson(pending.plan) !== canonicalSharedJson(requested)
    )
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_PROFILE_PENDING",
            "A different original Profile change is unresolved; new rules cannot replace its frozen plan.",
          ),
          pending.plan,
          pending.key,
        ),
      )
    const plan = pending?.plan ?? requested
    if (pending !== undefined || mode === "reconcile") {
      yield* appendSharedProfileRecord(library, {
        mode: "reconcile",
        recordId: plan.revision_id,
        operationId: plan.operation_id,
        entityId: plan.payload.profile_id,
        payload: plan.payload,
      }).pipe(Effect.mapError((error) => recovery(error, plan, pending?.key)))
      return yield* confirmed(library, plan, "reconcile", scope, pending?.key).pipe(
        Effect.mapError((error) => recovery(error, plan, pending?.key)),
      )
    }

    const read = yield* readRevisions(library, plan.payload.profile_id).pipe(Effect.result)
    if (read._tag === "Failure") {
      yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
      return yield* Effect.fail(read.failure)
    }
    const before = read.success
    if (before.some((revision) => revision.plan.revision_id === plan.revision_id))
      return yield* confirmed(library, plan, "reconcile", scope, undefined, before).pipe(
        Effect.mapError((error) => recovery(error, plan)),
      )
    const resolved = yield* checked(() =>
      before.length === 0 ? undefined : resolveProfile(plan.payload.profile_id, before),
    ).pipe(Effect.result)
    if (resolved._tag === "Failure") {
      yield* invalidateProfileObservation(library, plan.payload.profile_id, scope)
      return yield* Effect.fail(resolved.failure)
    }
    const current = resolved.success
    if ((current?.revision_id ?? null) !== plan.payload.parent_revision_id)
      return yield* Effect.fail(
        fail(
          "SHARED_PROFILE_STALE",
          "The selected Profile has a different current revision; review it before preparing a new change.",
          {
            profile_id: plan.payload.profile_id,
            expected_revision_id: plan.payload.parent_revision_id,
            current_revision_id: current?.revision_id ?? null,
          },
        ),
      )
    if (plan.payload.enabled && plan.payload.default_view_id !== undefined) {
      const view = yield* retrieveView(plan.payload.default_view_id, library.skills.database_id)
      if (view.data_source_id !== library.skills.data_source_id)
        return yield* Effect.fail(
          fail(
            "VIEW_SCOPE_MISMATCH",
            "The Profile default View belongs to a different Skills data source.",
            { view_id: view.id, profile_id: plan.payload.profile_id },
          ),
        )
    }
    const prefix = yield* sharedProfilePendingPrefix(
      scope,
      library.library_id,
      plan.payload.profile_id,
    )
    const key = `${prefix}${plan.revision_id}.json`
    yield* store
      .writeJson(key, {
        version: 1,
        scope,
        library_id: library.library_id,
        profile_id: plan.payload.profile_id,
        plan,
      })
      .pipe(Effect.mapError((error) => recovery(error, plan, key)))
    yield* appendSharedProfileRecord(library, {
      mode: "create",
      recordId: plan.revision_id,
      operationId: plan.operation_id,
      entityId: plan.payload.profile_id,
      payload: plan.payload,
    }).pipe(Effect.mapError((error) => recovery(error, plan, key)))
    return yield* confirmed(library, plan, "create", scope, key).pipe(
      Effect.mapError((error) => recovery(error, plan, key)),
    )
  })
}
