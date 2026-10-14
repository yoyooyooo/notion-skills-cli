import { Clock, Crypto, Effect, Schema } from "effect"
import {
  CatalogSchema,
  SnapshotSchema,
  SkillsError,
  aliasFor,
  fail,
  resolveSkill,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId, parseTarget, normalizePath } from "./ref.ts"
import { Store, configuration, publicConfiguration, sha256 } from "./store.ts"

export interface ReadPolicyOptions {
  readonly refresh?: boolean
  readonly offline?: boolean
  readonly maxAge?: number
}
export const DEFAULT_CACHE_POLICY = {
  read_max_age_ms: 300_000,
  catalog_max_age_ms: 60_000,
} as const
export function parseDuration(input: string): number {
  const match = /^(0|[0-9]+[smhd])$/.exec(input)
  if (!match)
    throw fail("INVALID_ARGUMENT", "Duration must be 0 or an integer followed by s, m, h or d.")
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const multiplier = multipliers[input.at(-1)!] ?? 1
  const value = Number(input === "0" ? input : input.slice(0, -1)) * multiplier
  if (!Number.isSafeInteger(value) || value < 0)
    throw fail("INVALID_ARGUMENT", "Duration exceeds the supported integer range.")
  return value
}
export function validateReadPolicy(options: ReadPolicyOptions, pinned = false) {
  if (
    Number(Boolean(options.refresh)) +
      Number(Boolean(options.offline)) +
      Number(options.maxAge !== undefined) >
    1
  )
    throw fail("INVALID_ARGUMENT", "refresh, offline and maxAge are mutually exclusive.")
  if (options.maxAge !== undefined && (!Number.isSafeInteger(options.maxAge) || options.maxAge < 0))
    throw fail("INVALID_ARGUMENT", "maxAge must be a finite nonnegative integer in milliseconds.")
  if (pinned && (options.refresh || options.maxAge !== undefined))
    throw fail("INVALID_ARGUMENT", "Pinned snapshots do not accept refresh or maxAge.")
}
export const effectiveCachePolicy = configuration.pipe(
  Effect.flatMap((config) =>
    Effect.try({
      try: () => {
        const policy = config.cache_policy ?? DEFAULT_CACHE_POLICY
        for (const value of Object.values(policy))
          if (!Number.isSafeInteger(value) || value < 0)
            throw fail("STATE_CORRUPT", "Configured cache durations are invalid.")
        return policy
      },
      catch: (error) => error as SkillsError,
    }),
  ),
)
export function configureCachePolicy(options: { readMaxAge?: number; catalogMaxAge?: number }) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        if (options.readMaxAge === undefined && options.catalogMaxAge === undefined)
          throw fail("INVALID_ARGUMENT", "Specify at least one cache duration.")
        for (const value of [options.readMaxAge, options.catalogMaxAge])
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw fail(
              "INVALID_ARGUMENT",
              "Cache durations must be nonnegative integer milliseconds.",
            )
      },
      catch: (error) => error as SkillsError,
    })
    const config = yield* configuration
    const previous = yield* effectiveCachePolicy
    const next = {
      ...config,
      cache_policy: {
        read_max_age_ms: options.readMaxAge ?? previous.read_max_age_ms,
        catalog_max_age_ms: options.catalogMaxAge ?? previous.catalog_max_age_ms,
      },
    }
    yield* (yield* Store).writeJson("config.json", next)
    return { ...publicConfiguration(next), effective_cache_policy: next.cache_policy }
  })
}
export const clearCachePolicy = Effect.gen(function* () {
  const { cache_policy: _previous, ...config } = yield* configuration
  yield* (yield* Store).writeJson("config.json", config)
  return { ...publicConfiguration(config), effective_cache_policy: DEFAULT_CACHE_POLICY }
})

const ScopeSchema = Schema.Struct({ scope: Schema.String })
const ObservationSchema = Schema.Struct({
  page_id: Schema.String,
  scope: Schema.String,
  started_at: Schema.Number,
  validated_at: Schema.Number,
  snapshot_id: Schema.optional(Schema.String),
  invalidated: Schema.Boolean,
  generation: Schema.Number,
})
export interface Freshness {
  readonly policy: "default" | "refresh" | "offline" | "max_age" | "pinned"
  readonly validated_at?: string
  readonly age_ms?: number
  readonly max_age_ms?: number
  readonly stale?: boolean
}
export interface ObservedSnapshot extends Snapshot {
  readonly source?: "notion" | "local_cache" | "local_snapshot"
  readonly freshness?: Freshness
}
export function freshness(
  options: ReadPolicyOptions,
  validatedAt: number,
  now: number,
  maxAge: number,
): Freshness {
  const age = now - validatedAt
  return {
    policy: options.offline
      ? "offline"
      : options.refresh
        ? "refresh"
        : options.maxAge !== undefined
          ? "max_age"
          : "default",
    validated_at: new Date(validatedAt).toISOString(),
    age_ms: age,
    max_age_ms: maxAge,
    stale: !Number.isFinite(age) || age < 0 || age >= maxAge,
  }
}
export const localIdentity = Effect.gen(function* () {
  const credential = yield* (yield* Notion).credentialIdentity
  const keychain = credential === (yield* sha256("ntn-keychain"))
  const key = yield* sha256(
    JSON.stringify([
      credential,
      process.env.NOTION_WORKSPACE_ID ?? "",
      process.env.NOTION_API_BASE_URL ?? "https://api.notion.com",
    ]),
  )
  return { key, keychain }
})
export function recordScope(scope: string) {
  return Effect.gen(function* () {
    const identity = yield* localIdentity
    if (!identity.keychain)
      yield* (yield* Store).writeJson(`cache/identities/${identity.key}.json`, { scope })
  })
}
export function locallySelectedScope(offline = false) {
  return Effect.gen(function* () {
    const identity = yield* localIdentity
    if (identity.keychain) {
      if (offline)
        return yield* Effect.fail(
          fail(
            "CACHE_SCOPE_UNAVAILABLE",
            "Official-login identity requires online validation; use an explicitly pinned snapshot offline.",
          ),
        )
      return undefined
    }
    const value = yield* (yield* Store).readJson(
      `cache/identities/${identity.key}.json`,
      ScopeSchema,
    )
    if (!value && offline)
      return yield* Effect.fail(
        fail(
          "CACHE_SCOPE_UNAVAILABLE",
          "No locally identifiable cached account scope is available.",
        ),
      )
    return value?.scope
  })
}
export function validateSnapshot(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const alias = yield* Effect.try({
      try: () => aliasFor(snapshot.skill.name),
      catch: () => fail("STATE_CORRUPT", "Snapshot Skill name is invalid."),
    })
    if (
      snapshot.snapshot_id !==
        `s_${yield* sha256(JSON.stringify([snapshot.scope, snapshot.skill.id, snapshot.version_id]))}` ||
      alias !== snapshot.skill.alias ||
      snapshot.skill_name !== snapshot.skill.alias ||
      !snapshot.files.some((file) => file.path === "SKILL.md") ||
      new Set(snapshot.files.map((file) => file.path)).size !== snapshot.files.length
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Snapshot identity or complete file manifest is invalid."),
      )
    const store = yield* Store
    for (const file of snapshot.files) {
      yield* Effect.try({
        try: () => {
          if (
            normalizePath(file.path) !== file.path ||
            !/^[a-f0-9]{64}$/.test(file.sha256) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0
          )
            throw fail("STATE_CORRUPT", "Snapshot file manifest is invalid.")
        },
        catch: () => fail("STATE_CORRUPT", "Snapshot file manifest is invalid."),
      })
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A snapshot object failed its content checksum.", {
            path: file.path,
          }),
        )
    }
    return snapshot
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("STATE_CORRUPT", "Snapshot manifest failed validation."),
    ),
  )
}
export function publishSnapshotObservation(
  snapshot: Snapshot,
  startedAt: number,
  generation: number,
) {
  return Effect.gen(function* () {
    yield* validateSnapshot(snapshot)
    const store = yield* Store
    const validatedAt = yield* Clock.currentTimeMillis
    const id = yield* (yield* Crypto.Crypto).randomUUIDv4()
    // Each publisher owns a new immutable journal entry. An older request cannot overwrite a newer pointer.
    yield* store.writeJson(`cache/latest/${snapshot.scope}/${snapshot.skill.id}/${id}.json`, {
      page_id: snapshot.skill.id,
      scope: snapshot.scope,
      started_at: startedAt,
      generation,
      validated_at: validatedAt,
      snapshot_id: snapshot.snapshot_id,
      invalidated: false,
    })
    yield* recordScope(snapshot.scope)
    return {
      ...snapshot,
      source: "notion" as const,
      freshness: freshness(
        { refresh: true },
        validatedAt,
        validatedAt,
        (yield* effectiveCachePolicy).read_max_age_ms,
      ),
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("CRYPTO_ERROR", "Could not publish the observation identity."),
    ),
  )
}
export function cachedRemoteObservation(page: string, scope: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const keys = yield* store.listKeys(`cache/latest/${scope}/${page}`)
    const entries: Array<typeof ObservationSchema.Type> = []
    for (const key of keys) {
      if (!key.endsWith(".json")) continue
      const entry = yield* store.readJson(key, ObservationSchema)
      if (entry) {
        if (
          entry.scope !== scope ||
          entry.page_id !== page ||
          !Number.isFinite(entry.validated_at) ||
          !Number.isFinite(entry.started_at) ||
          !Number.isSafeInteger(entry.generation) ||
          entry.generation < 1
        )
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "Cache observation scope or timestamp is invalid."),
          )
        entries.push(entry)
      }
    }
    entries.sort((a, b) => b.generation - a.generation)
    const latest = entries[0]
    if (!latest || latest.invalidated) return undefined
    if (!latest.snapshot_id || !/^s_[a-f0-9]{64}$/.test(latest.snapshot_id))
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Latest observation has no valid snapshot identity."),
      )
    const snapshot = yield* store.readJson(`snapshots/${latest.snapshot_id}.json`, SnapshotSchema)
    if (!snapshot || snapshot.scope !== scope || snapshot.skill.id !== page)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Latest observation points to a missing or foreign snapshot."),
      )
    yield* validateSnapshot(snapshot)
    return { snapshot, validated_at: latest.validated_at }
  })
}
export function invalidateSnapshotCache(page: string, scope?: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const scopes = scope
      ? [scope]
      : [...new Set((yield* store.listKeys("cache/latest")).map((key) => key.split("/")[2]!))]
    const now = yield* Clock.currentTimeMillis
    for (const selected of scopes) {
      const generation = yield* store.reserveCacheGeneration(selected, page)
      const id = yield* (yield* Crypto.Crypto).randomUUIDv4()
      yield* store.writeJson(`cache/latest/${selected}/${page}/${id}.json`, {
        page_id: page,
        scope: selected,
        started_at: now,
        validated_at: now,
        generation,
        invalidated: true,
      })
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("CRYPTO_ERROR", "Could not invalidate the observation identity."),
    ),
  )
}

function cachedTarget(target: string, database?: string) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseTarget(target),
      catch: (error) => error as SkillsError,
    })
    if (parsed.snapshot)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Cache operations require a current target."),
      )
    const scope = yield* locallySelectedScope(true)
    const config = yield* configuration
    const matches = config.sources?.filter((source) => source.alias === database) ?? []
    if (
      database !== undefined &&
      !pageId(database) &&
      new Set(matches.map((source) => source.database_id)).size > 1
    )
      return yield* Effect.fail(
        fail("DATABASE_AMBIGUOUS", "Registered database alias is ambiguous."),
      )
    const selectedDatabase =
      database === undefined ? undefined : (pageId(database) ?? matches[0]?.database_id)
    if (database !== undefined && !selectedDatabase)
      return yield* Effect.fail(
        fail("DATABASE_NOT_FOUND", "No registered database matched the selector."),
      )
    const store = yield* Store
    const id = pageId(parsed.selector)
    if (id) {
      const observed = yield* cachedRemoteObservation(id, scope!)
      if (selectedDatabase && observed && observed.snapshot.skill.database_id !== selectedDatabase)
        return yield* Effect.fail(
          fail("SKILL_NOT_FOUND", "Target is outside the selected database."),
        )
      return { page: id, scope: scope! }
    }
    const key = `cache/catalogs/${scope}/${yield* sha256(JSON.stringify(["database-selection-v2", database ?? "auto", config.sources ?? []]))}.json`
    const catalog = yield* store.readJson(key, CatalogSchema)
    if (!catalog || catalog.scope !== scope || catalog.coverage.failed_sources.length)
      return yield* Effect.fail(
        fail(
          "CACHE_MISSING",
          "A complete catalog for this exact scope and database selection is required.",
        ),
      )
    const skill = yield* Effect.try({
      try: () => resolveSkill(parsed.selector, catalog, selectedDatabase),
      catch: (error) => error as SkillsError,
    })
    return { page: skill.id, scope: scope! }
  })
}
export function cacheStatus(target?: string, options: { database?: string } = {}) {
  return Effect.gen(function* () {
    const store = yield* Store
    const selected =
      target === undefined ? undefined : yield* cachedTarget(target, options.database)
    const keys = yield* store.listKeys("cache")
    const pairs = new Map<string, { page: string; scope: string }>()
    for (const key of keys) {
      const parts = key.split("/")
      if (
        parts[1] === "latest" &&
        (!selected || (parts[2] === selected.scope && parts[3] === selected.page))
      )
        pairs.set(`${parts[2]}/${parts[3]}`, { scope: parts[2]!, page: parts[3]! })
    }
    const now = yield* Clock.currentTimeMillis
    const policy = yield* effectiveCachePolicy
    const observations: Array<unknown> = []
    for (const pair of pairs.values()) {
      const observation = yield* cachedRemoteObservation(pair.page, pair.scope)
      if (observation)
        observations.push({
          scope: pair.scope,
          page_id: pair.page,
          snapshot_id: observation.snapshot.snapshot_id,
          version_id: observation.snapshot.version_id,
          source: "local_cache",
          freshness: freshness({}, observation.validated_at, now, policy.read_max_age_ms),
        })
    }
    const catalogs: Array<unknown> = []
    for (const key of keys) {
      if (!key.startsWith("cache/catalogs/") || !key.endsWith(".json")) continue
      const value = yield* store.readJson(key, CatalogSchema)
      if (
        value &&
        (!selected ||
          (value.scope === selected.scope &&
            value.skills.some((skill) => skill.id === selected.page)))
      )
        catalogs.push({
          scope: value.scope,
          fetched_at: value.fetched_at,
          coverage: value.coverage,
          freshness: freshness({}, value.fetched_at, now, policy.catalog_max_age_ms),
        })
    }
    return {
      config_directory: store.configRoot,
      state_directory: store.root,
      cache_directory: store.cacheRoot,
      effective_cache_policy: policy,
      scopes: [
        ...new Set(
          keys
            .filter((key) => /cache\/(latest|catalogs)\//.test(key))
            .map((key) => key.split("/")[2]),
        ),
      ],
      observations,
      catalogs,
    }
  })
}
export function clearCache(
  target?: string,
  options: { all?: boolean; database?: string; dryRun?: boolean } = {},
) {
  return Effect.gen(function* () {
    if (
      Number(target !== undefined) + Number(Boolean(options.all)) !== 1 ||
      (options.all && options.database !== undefined)
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Specify exactly one current target or all; database requires a target.",
        ),
      )
    const store = yield* Store
    const selected = options.all ? undefined : yield* cachedTarget(target!, options.database)
    const keys: string[] = []
    for (const key of yield* store.listKeys("cache")) {
      if (!selected) {
        keys.push(key)
        continue
      }
      if (key.startsWith(`cache/latest/${selected.scope}/${selected.page}/`)) keys.push(key)
      else if (key.startsWith(`cache/catalogs/${selected.scope}/`) && key.endsWith(".json")) {
        const value = yield* store.readJson(key, CatalogSchema)
        if (
          !value ||
          value.skills.some((skill) => skill.id === selected.page) ||
          value.coverage.failed_sources.length ||
          !value.coverage.exhaustive
        )
          keys.push(key)
      }
    }
    // Include reservations whose provider read has not published its first journal entry yet.
    for (const key of yield* store.listKeys("cache-generations")) {
      const parts = key.split("/")
      const scope = parts[1]!
      const identity = parts[2]!.replace(/\.json$/, "")
      if (selected && scope !== selected.scope) continue
      if (identity.startsWith("catalog-")) {
        if (
          !selected ||
          keys.some((entry) => entry === `cache/catalogs/${scope}/${identity.slice(8)}.json`) ||
          !(yield* store.readJson(
            `cache/catalogs/${scope}/${identity.slice(8)}.json`,
            CatalogSchema,
          ))
        )
          keys.push(`cache/catalogs/${scope}/${identity.slice(8)}.json`)
      } else if (!selected || identity === selected.page)
        keys.push(`cache/latest/${scope}/${identity}/.fence`)
    }
    const entries = [...new Set(keys)]
    const retired = options.dryRun ? [] : yield* store.retireKeys(entries)
    return { operation: "cache_clear", dry_run: Boolean(options.dryRun), entries, retired }
  })
}
