import { Clock, Effect } from "effect"
import {
  catalogSelection,
  CatalogObservationSchema,
  completeCatalog,
  validateCachedCatalog,
} from "./catalog-cache.ts"
import {
  credentialLocalIdentity,
  effectiveCachePolicy,
  knownAccessDenials,
  ScopeSchema,
} from "./cache.ts"
import { selectedLibraryId } from "./library-selection.ts"
import { fail, SkillsError, type ContentRecord } from "./model.ts"
import { NotionCredentialProvider, NotionCredentialProviderLive } from "./notion-credential.ts"
import { configuredSources, sha256, Store } from "./store.ts"

export interface CandidateDenial {
  readonly kind: "scope" | "library" | "record" | "physical"
  readonly identity: string
  readonly code: string
  readonly verifiedAt: number
  readonly generation: number
}

export type CandidateSnapshotResult =
  | {
      readonly kind: "miss"
      readonly reason:
        | "library_unavailable"
        | "credential_unavailable"
        | "scope_unavailable"
        | "catalog_unavailable"
      readonly libraryId?: string
    }
  | {
      readonly kind: "blocked"
      readonly libraryId: string
      readonly scope: string
      readonly denials: readonly CandidateDenial[]
    }
  | {
      readonly kind: "snapshot"
      readonly libraryId: string
      readonly scope: string
      /** Original directory observation time, never the time this cache was read. */
      readonly verifiedAt: number
      readonly fetched_at: number
      readonly stale: boolean
      readonly coverage: "complete" | "partial"
      readonly records: readonly ContentRecord[]
      readonly denials: readonly CandidateDenial[]
      readonly generation: number
      readonly lastFailure?: { readonly code: string; readonly observed_at: number }
    }

/** Discovery metadata only. No HTTP transport, scheduler, View, body, projection,
 * acquisition, or remote repair is available inside this local operation. */
export function readCandidateSnapshot(options: { readonly library?: string } = {}) {
  return Effect.gen(function* () {
    const selected = yield* selectedLibraryId(options.library).pipe(Effect.result)
    if (selected._tag === "Failure") {
      if (
        ["LIBRARY_CONTEXT_REQUIRED", "LIBRARY_NOT_FOUND", "LIBRARY_AMBIGUOUS"].includes(
          selected.failure.code,
        )
      )
        return { kind: "miss", reason: "library_unavailable" } satisfies CandidateSnapshotResult
      return yield* Effect.fail(selected.failure)
    }
    const libraryId = selected.success
    const credential = yield* Effect.flatMap(
      NotionCredentialProvider,
      (provider) => provider.resolve,
    ).pipe(Effect.provide(NotionCredentialProviderLive), Effect.result)
    if (credential._tag === "Failure") {
      if (credential.failure.code === "AUTH_REQUIRED")
        return {
          kind: "miss",
          reason: "credential_unavailable",
          libraryId,
        } satisfies CandidateSnapshotResult
      return yield* Effect.fail(credential.failure)
    }
    const identity = yield* credentialLocalIdentity(credential.success.identity)
    const store = yield* Store
    const mapped = yield* store.readJson(`cache/identities/${identity.key}.json`, ScopeSchema)
    if (mapped === undefined)
      return {
        kind: "miss",
        reason: "scope_unavailable",
        libraryId,
      } satisfies CandidateSnapshotResult
    const scope = mapped.scope
    const configured = yield* configuredSources
    const key = `cache/catalogs/${scope}/${yield* sha256(JSON.stringify(catalogSelection(libraryId, configured)))}.json`
    const observation = yield* store.readJson(key, CatalogObservationSchema)
    const retained = observation === undefined ? undefined : completeCatalog(observation)
    const selectedIdentities = new Set([libraryId])
    for (const record of [...(retained?.records ?? []), ...(observation?.records ?? [])]) {
      selectedIdentities.add(record.id)
      if (record.locator.type === "shared_skill") selectedIdentities.add(record.locator.page_id)
    }
    const access = yield* knownAccessDenials(scope, selectedIdentities)
    const denials: CandidateDenial[] = access.map((entry) => ({
      ...entry,
      kind:
        entry.identity === "access:scope"
          ? "scope"
          : entry.identity === libraryId
            ? "library"
            : entry.identity.startsWith("skill://")
              ? "record"
              : "physical",
    }))
    if (denials.some((entry) => entry.kind === "scope" || entry.kind === "library"))
      return { kind: "blocked", libraryId, scope, denials } satisfies CandidateSnapshotResult
    if (observation === undefined)
      return {
        kind: "miss",
        reason: "catalog_unavailable",
        libraryId,
      } satisfies CandidateSnapshotResult
    yield* Effect.try({
      try: () => {
        validateCachedCatalog(observation, scope, libraryId)
        if (retained !== undefined) validateCachedCatalog(retained, scope, libraryId)
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("STATE_CORRUPT", "Cached candidate metadata failed validation."),
    })
    const verifiedAt = retained?.fetched_at ?? observation.fetched_at
    const generation = observation.generation ?? 0
    for (const rejected of observation.rejected_records ?? [])
      denials.push({
        kind: "physical",
        identity: rejected.page_id,
        code: rejected.reason,
        verifiedAt: rejected.observed_at,
        generation: rejected.generation,
      })
    for (const failure of [
      ...(observation.denied_sources ?? []),
      ...observation.coverage.failed_sources.map((entry) => ({
        ...entry,
        observed_at: observation.fetched_at,
        generation,
      })),
    ]) {
      if (
        ![
          "AUTH_REQUIRED",
          "ACCESS_DENIED",
          "INVALID_SKILL",
          "NOT_FOUND",
          "SKILL_NOT_FOUND",
        ].includes(failure.code)
      )
        continue
      const wholeLibrary =
        failure.id === failure.database_id ||
        failure.id === failure.data_source_id ||
        failure.id === libraryId
      denials.push({
        kind: wholeLibrary ? "library" : "physical",
        identity: wholeLibrary ? libraryId : failure.id,
        code: failure.code,
        verifiedAt: failure.observed_at,
        generation: failure.generation,
      })
    }
    if (
      observation.last_failure !== undefined &&
      ["AUTH_REQUIRED", "ACCESS_DENIED"].includes(observation.last_failure.code)
    )
      denials.push({
        kind: "library",
        identity: libraryId,
        code: observation.last_failure.code,
        verifiedAt: observation.last_failure.observed_at,
        generation,
      })
    if (denials.some((entry) => entry.kind === "library"))
      return { kind: "blocked", libraryId, scope, denials } satisfies CandidateSnapshotResult
    if (observation.fetched_at === 0 && retained === undefined)
      return {
        kind: "miss",
        reason: "catalog_unavailable",
        libraryId,
      } satisfies CandidateSnapshotResult
    const byId = new Map<string, ContentRecord>()
    for (const record of retained?.records ?? []) {
      if (record.locator.type !== "shared_skill") continue
      const locator = record.locator
      // A newly observed root binding cannot borrow old physical table identities.
      if (
        observation.databases.length > 0 &&
        !observation.databases.some(
          (source) =>
            source.database_id === locator.database_id &&
            source.shared_library?.library_id === libraryId &&
            source.shared_library.skills.data_source_id === locator.data_source_id,
        )
      )
        continue
      byId.set(record.id, record)
    }
    for (const record of observation.records) byId.set(record.id, record)
    const denied = new Set(denials.map((entry) => entry.identity))
    const records = [...byId.values()]
      .filter(
        (record) =>
          record.enabled !== false &&
          !denied.has(record.id) &&
          record.locator.type === "shared_skill" &&
          !denied.has(record.locator.page_id),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    const complete =
      observation.coverage.exhaustive &&
      observation.coverage.failed_sources.length === 0 &&
      observation.last_failure === undefined
    const now = yield* Clock.currentTimeMillis
    const age = now - verifiedAt
    const maxAge = (yield* effectiveCachePolicy).catalog_max_age_ms
    return {
      kind: "snapshot",
      libraryId,
      scope,
      verifiedAt,
      fetched_at: verifiedAt,
      stale:
        observation.invalidated === true ||
        !complete ||
        !Number.isFinite(age) ||
        age < 0 ||
        age >= maxAge,
      coverage: complete ? "complete" : "partial",
      records,
      denials,
      generation,
      ...(observation.last_failure === undefined ? {} : { lastFailure: observation.last_failure }),
    } satisfies CandidateSnapshotResult
  })
}
