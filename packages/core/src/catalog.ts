import { Clock, Effect, Schema } from "effect"
import {
  CatalogObservationSchema,
  effectiveCachePolicy,
  freshness,
  invalidateScopeCache,
  locallySelectedScope,
  recordScope,
  recordScopeAccess,
  reserveScopeAccess,
  validateReadPolicy,
  type ReadPolicyOptions,
} from "./cache.ts"
import type { ContentRecord } from "./model.ts"
import {
  DataSourceSchema,
  DatabaseSchema,
  PageSchema,
  SkillsError,
  UserSchema,
  aliasFor,
  decode,
  fail,
  listSchema,
  property,
  text,
  validateDescription,
  type Catalog,
  type Source,
  type SourceFailure,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { bindTarget, pageId, type SkillTarget } from "./ref.ts"
import { sharedMetadataEntryFromPage, validateSharedRecordIdentity } from "./shared-content.ts"
import { sharedGraphInventory } from "./shared-graph-read-context.ts"
import { libraryFromDatabase, loadSharedLibrary } from "./shared-library.ts"
import {
  directorySkillMetadata,
  type SharedSkillMetadataObservation,
} from "./shared-metadata-inventory.ts"
import { Store, configuration, configuredSources, sha256 } from "./store.ts"
import { libraryId, selectedLibraryId } from "./library-selection.ts"
export { libraryId, selectedLibraryId } from "./library-selection.ts"

export const authScope = Effect.gen(function* () {
  const local = yield* locallySelectedScope().pipe(Effect.result)
  const previous = local._tag === "Success" ? local.success : undefined
  const generation = previous === undefined ? undefined : yield* reserveScopeAccess(previous)
  const authenticated = yield* Effect.gen(function* () {
    const api = yield* Notion
    if (api.connectionIdentity !== undefined) {
      const identity = yield* api.connectionIdentity
      return yield* sha256(
        JSON.stringify([identity.principal, "", identity.api_origin, identity.credential]),
      )
    }
    const value = yield* api.request("v1/users/me")
    const user = yield* Effect.try({
      try: () => decode(UserSchema, value),
      catch: () => fail("INVALID_RESPONSE", "Invalid authenticated user response."),
    })
    const credential = yield* api.credentialIdentity
    // Only the selected credential digest enters cached authentication scopes.
    const scope = yield* sha256(JSON.stringify([user.id, "", "https://api.notion.com", credential]))
    return scope
  }).pipe(Effect.result)
  if (authenticated._tag === "Failure") {
    const error = authenticated.failure
    if (
      previous !== undefined &&
      (error.code === "AUTH_REQUIRED" || error.code === "ACCESS_DENIED")
    )
      yield* invalidateScopeCache(previous, error.code, generation)
    return yield* Effect.fail(error)
  }
  if (authenticated.success === previous && generation !== undefined)
    yield* recordScopeAccess(authenticated.success, generation)
  return authenticated.success
})

function paginate<S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  item: S,
  initial: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const items: Array<S["Type"]> = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    while (true) {
      const value = yield* api.request(path, {
        ...initial,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      })
      const page = yield* Effect.try({
        try: () => decode(listSchema(item), value),
        catch: () => fail("INVALID_RESPONSE", "Invalid paginated Notion response.", { path }),
      })
      items.push(...page.results)
      if (!page.has_more) return items
      if (!page.next_cursor || cursors.has(page.next_cursor))
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Notion returned a missing or repeating cursor.", { path }),
        )
      cursors.add(page.next_cursor)
      cursor = page.next_cursor
    }
  })
}

export function explicitSource(input: string, sources?: readonly Source[]) {
  return Effect.gen(function* () {
    const configured = sources ?? (yield* configuredSources)
    const id = yield* libraryId(input, configured)
    const registered = configured.find((source) => source.shared_library?.library_id === id)
    const library = yield* loadSharedLibrary(id)
    const raw = yield* (yield* Notion).request(`v1/databases/${library.skills.database_id}`)
    return {
      alias: registered?.alias ?? id,
      database_id: library.skills.database_id,
      title: text(property(raw).title),
      data_source_ids: [library.skills.data_source_id],
      role: "content" as const,
      shared_library: library,
    } satisfies Source
  })
}

/** Internal physical-page routing. A database is never accepted as a public Library selector. */
export function sourceForSkillsDatabase(database: string, sources?: readonly Source[]) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/databases/${database}`)
    const library = yield* Effect.try({
      try: () => libraryFromDatabase(raw),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("LIBRARY_INVALID", "Invalid Library descriptor."),
    })
    if (library === undefined)
      return yield* Effect.fail(
        fail(
          "CURRENT_SCHEMA_REQUIRED",
          "This database is not the Skills table of a current Library.",
        ),
      )
    const source = yield* explicitSource(library.library_id, sources)
    if (source.database_id !== database)
      return yield* Effect.fail(
        fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "The physical Skills table differs from the resolved root binding.",
        ),
      )
    return source
  })
}

/** Search is explicit and never claims workspace-exhaustive coverage. */
export function discoverLibraries() {
  return Effect.gen(function* () {
    const configured = yield* configuredSources
    const candidates = new Map<string, { alias: string; title: string }>()
    const found = yield* paginate("v1/search", DataSourceSchema, {
      filter: { property: "object", value: "data_source" },
    })
    for (const source of found) {
      if (source.in_trash) continue
      const props = property(source.properties)
      if (
        property(props["Skill ID"]).type !== "rich_text" ||
        property(props["Main File ID"]).type !== "rich_text"
      )
        continue
      const id = source.parent.database_id
      const registered = configured.find((entry) => entry.database_id === id)
      candidates.set(id, { alias: registered?.alias ?? id, title: text(source.title) })
    }
    for (const source of configured)
      candidates.set(source.database_id, { alias: source.alias, title: source.title })
    const databases: Source[] = [],
      failures: SourceFailure[] = []
    for (const [id, candidate] of candidates) {
      const result = yield* sourceForSkillsDatabase(id, configured).pipe(Effect.result)
      if (result._tag === "Success") databases.push(result.success)
      else failures.push({ id, database_id: id, code: result.failure.code, ...candidate })
    }
    return { databases, failures }
  })
}

export function setDefaultLibrary(database?: string) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const source = database === undefined ? undefined : yield* explicitSource(database, undefined)
    const { default_library: _previous, ...rest } = config
    const next = {
      ...rest,
      ...(source ? { default_library: source.shared_library.library_id } : {}),
    }
    const store = yield* Store
    yield* store.writeJson("config.json", next)
    return next
  })
}

export interface CatalogOptions extends ReadPolicyOptions {
  readonly library?: string
  readonly all?: boolean
}

/** Bind an authored short ref once, at a tool entry with an explicitly selected Library. */
export function bindEntryTarget(target: SkillTarget, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
    if (target.kind !== "skill") return target
    const scope = target.reference.scope
    if (scope.kind === "library") {
      if (options.library !== undefined && (yield* libraryId(options.library)) !== scope.libraryId)
        return yield* Effect.fail(
          fail(
            "LIBRARY_SCOPE_MISMATCH",
            "The full reference conflicts with the explicitly selected Library.",
          ),
        )
      return target
    }
    const root = yield* selectedLibraryId(options.library)
    return yield* Effect.try({
      try: () => bindTarget(target, root),
      catch: (error) => error as SkillsError,
    })
  })
}

export function catalog(options: CatalogOptions = {}) {
  return readCatalog(options)
}

/** Internal scalar-read handoff; raw inventories never enter the public catalog or its cache. */
export function freshCatalogForRead(options: Pick<CatalogOptions, "library"> = {}) {
  return Effect.gen(function* () {
    const sharedSkills = new Map<string, SharedSkillMetadataObservation>()
    const exactSharedRecords = new Map<string, ContentRecord>()
    const directory = yield* readCatalog(
      { ...options, refresh: true },
      sharedSkills,
      exactSharedRecords,
    )
    return { catalog: directory, sharedSkills, exactSharedRecords }
  })
}

function readCatalog(
  options: CatalogOptions,
  observations?: Map<string, SharedSkillMetadataObservation>,
  exactSharedRecords?: Map<string, ContentRecord>,
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateReadPolicy(options),
      catch: (error) => error as SkillsError,
    })
    if (options.all && options.library !== undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--all and --library are mutually exclusive."),
      )
    const selected = options.all ? undefined : yield* selectedLibraryId(options.library)
    const selectedScope = !options.refresh
      ? yield* locallySelectedScope(Boolean(options.offline))
      : undefined
    const scope = selectedScope ?? (yield* authScope)
    const store = yield* Store
    const configured = yield* configuredSources
    const catalogSelection = ["root-library-directory-v2", selected ?? "all", configured]
    const key = `cache/catalogs/${scope}/${yield* sha256(JSON.stringify(catalogSelection))}.json`
    const now = yield* Clock.currentTimeMillis
    const maxAge = options.maxAge ?? (yield* effectiveCachePolicy).catalog_max_age_ms
    if (!options.refresh) {
      const result = yield* store.readJson(key, CatalogObservationSchema).pipe(Effect.result)
      if (result._tag === "Failure" && options.offline) return yield* Effect.fail(result.failure)
      const cached = result._tag === "Success" ? result.success : undefined
      const age = cached ? now - cached.fetched_at : NaN
      if (
        cached &&
        cached.scope === scope &&
        !cached.coverage.failed_sources.length &&
        (options.offline ||
          (!cached.invalidated && Number.isFinite(age) && age >= 0 && age < maxAge))
      ) {
        const records: ContentRecord[] = []
        const failed: SourceFailure[] = []
        const sharedCachedIds = new Set<string>()
        for (const skill of cached.records) {
          const checked = yield* Effect.try({
            try: () => {
              if (aliasFor(skill.name) !== skill.alias)
                throw fail(
                  "INVALID_SKILL_NAME",
                  "Cached skill name differs from its Notion Name.",
                  {
                    page_id: skill.id,
                    name: skill.name,
                  },
                )
              if (skill.locator.type !== "shared_skill")
                throw fail("STATE_CORRUPT", "The catalog contains a noncurrent remote record.")
              validateDescription(skill.description)
              validateSharedRecordIdentity(skill)
              if (skill.locator.type === "shared_skill") {
                const locator = skill.locator
                if (sharedCachedIds.has(skill.id))
                  throw fail(
                    "STATE_CORRUPT",
                    "Cached shared catalog repeats a stable Skill identity.",
                    { id: skill.id },
                  )
                sharedCachedIds.add(skill.id)
                const source = cached.databases.find(
                  (entry) => entry.database_id === locator.database_id,
                )
                if (
                  source?.shared_library === undefined ||
                  source.shared_library.library_id !== locator.library_id ||
                  source.shared_library.skills.data_source_id !== locator.data_source_id
                )
                  throw fail(
                    "STATE_CORRUPT",
                    "Cached shared Skill no longer matches its catalog descriptor.",
                    { id: skill.id },
                  )
              }
            },
            catch: (error) =>
              error instanceof SkillsError
                ? fail(error.code, error.message, {
                    page_id: skill.id,
                    name: skill.name,
                  })
                : fail("STATE_CORRUPT", "Cached Skill title failed validation.", {
                    page_id: skill.id,
                  }),
          }).pipe(Effect.result)
          if (checked._tag === "Success") {
            if (skill.enabled !== false) records.push(skill)
          } else return yield* Effect.fail(checked.failure)
        }
        const { invalidated, ...retained } = cached
        return {
          ...retained,
          records,
          coverage: {
            ...cached.coverage,
            exhaustive: cached.coverage.exhaustive && !failed.length,
            failed_sources: failed,
          },
          source: "local_cache" as const,
          freshness: {
            ...freshness(options, cached.fetched_at, now, maxAge),
            ...(invalidated ? { stale: true } : {}),
          },
        }
      }
      if (options.offline)
        return yield* Effect.fail(
          fail(
            "CACHE_MISSING",
            "No complete catalog observation is available for the selected scope.",
          ),
        )
    }
    // A local token mapping authorizes cache selection only. Online discovery always validates identity.
    const validatedScope = selectedScope ? yield* authScope : scope
    const catalogIdentity = yield* sha256(JSON.stringify(catalogSelection))
    const catalogGeneration = yield* store.reserveCacheGeneration(
      validatedScope,
      `catalog-${catalogIdentity}`,
    )
    const databases = new Map<string, Source>()
    const failures: SourceFailure[] = []
    if (selected !== undefined) {
      const db = yield* explicitSource(selected, configured)
      databases.set(db.database_id, db)
    } else {
      const discovered = yield* discoverLibraries()
      for (const source of discovered.databases) databases.set(source.database_id, source)
      failures.push(...discovered.failures)
    }
    const skills = new Map<string, ContentRecord>()
    const sharedIdentities = new Map<string, string>()
    const sharedLibraries = new Map<string, string>()
    // Retain parent identity alongside the decoded metadata for shared Router validation.
    const inventory = new Map<
      string,
      { page: unknown; database_id: string; data_source_id: string }
    >()
    const InventoryPageSchema = Schema.Struct({
      ...PageSchema.fields,
      object: Schema.optional(Schema.String),
      parent: Schema.optional(Schema.Unknown),
      archived: Schema.optional(Schema.Boolean),
      is_archived: Schema.optional(Schema.Boolean),
      last_edited_time: Schema.optional(Schema.String),
    })
    const queried: string[] = []
    for (const db of databases.values()) {
      if (db.shared_library !== undefined) {
        const previous = sharedLibraries.get(db.shared_library.library_id)
        if (previous !== undefined && previous !== db.database_id)
          return yield* Effect.fail(
            fail(
              "SHARED_LIBRARY_ID_CONFLICT",
              "Several database entries claim the same shared library identity.",
              {
                library_id: db.shared_library.library_id,
                database_ids: [previous, db.database_id],
              },
            ),
          )
        sharedLibraries.set(db.shared_library.library_id, db.database_id)
      }
      for (const id of new Set(db.data_source_ids)) {
        const result = yield* Effect.gen(function* () {
          if (db.shared_library === undefined)
            return yield* Effect.fail(
              fail("CURRENT_SCHEMA_REQUIRED", "The current library descriptor is missing."),
            )
          const shared =
            (yield* sharedGraphInventory(db.shared_library)) ??
            (yield* directorySkillMetadata(db.shared_library, validatedScope, maxAge, "catalog"))
              .inventory
          const rows = yield* Effect.try({
            try: () => shared.pages.map((row) => decode(InventoryPageSchema, row)),
            catch: () => fail("INVALID_RESPONSE", "Invalid shared metadata inventory."),
          })
          observations?.set(id, {
            scope: validatedScope,
            library: structuredClone(db.shared_library),
            inventory: shared,
          })
          return rows
        }).pipe(Effect.result)
        if (result._tag === "Failure") {
          failures.push({
            id,
            code: result.failure.code,
            database_id: db.database_id,
            alias: db.alias,
            title: db.title,
            data_source_id: id,
          })
          continue
        }
        queried.push(id)
        for (const row of result.success) {
          if (db.shared_library !== undefined && inventory.has(row.id))
            return yield* Effect.fail(
              fail("SHARED_SKILL_ID_CONFLICT", "Shared metadata query repeated a page identity.", {
                page_id: row.id,
              }),
            )
          inventory.set(row.id, { page: row, database_id: db.database_id, data_source_id: id })
          if (row.in_trash || row.archived || row.is_archived) continue
          const checked = yield* Effect.try({
            try: () => {
              if (db.shared_library === undefined)
                throw fail("CURRENT_SCHEMA_REQUIRED", "The current library descriptor is missing.")
              const entry = sharedMetadataEntryFromPage(row, db, id)
              return entry.state === "registered" ? entry.record : undefined
            },
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail("INVALID_RESPONSE", "Invalid content metadata."),
          }).pipe(Effect.result)
          if (checked._tag === "Failure") {
            if (checked.failure.code !== "INVALID_SKILL") return yield* Effect.fail(checked.failure)
            failures.push({
              id: row.id,
              code: checked.failure.code,
              database_id: db.database_id,
              data_source_id: id,
              alias: db.alias,
              title: db.title,
            })
            continue
          }
          const record = checked.success
          if (record === undefined) continue
          if (record.locator.type === "shared_skill") {
            const previous = sharedIdentities.get(record.id)
            if (previous !== undefined)
              return yield* Effect.fail(
                fail(
                  "SHARED_SKILL_ID_CONFLICT",
                  "Several pages claim the same stable Skill identity.",
                  { id: record.id, page_ids: [previous, record.locator.page_id] },
                ),
              )
            sharedIdentities.set(record.id, record.locator.page_id)
            // A private scalar-read handoff preserves the exact registered
            // identity, including disabled records. Public discovery still
            // excludes them; their body/permission gate remains authoritative.
            exactSharedRecords?.set(record.id, record)
            if (record.enabled !== false) skills.set(record.id, record)
          } else skills.set(row.id, record)
        }
      }
    }
    const output: Catalog = {
      scope: validatedScope,
      ...(selected === undefined ? {} : { library_id: selected }),
      fetched_at: yield* Clock.currentTimeMillis,
      databases: [...databases.values()],
      records: [...skills.values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
      coverage: {
        method: selected !== undefined ? "explicit_library" : "search_and_registered",
        exhaustive: selected !== undefined && failures.length === 0,
        queried_data_sources: queried,
        failed_sources: failures,
        search_index_limited: selected === undefined,
      },
    }
    const validatedKey = `cache/catalogs/${validatedScope}/${catalogIdentity}.json`
    yield* store.writeJson(validatedKey, { ...output, generation: catalogGeneration })
    yield* recordScope(validatedScope)
    return {
      ...output,
      source: "notion" as const,
      freshness: freshness(options, output.fetched_at, output.fetched_at, maxAge),
    }
  })
}

export function addSource(alias: string, input: string) {
  return Effect.gen(function* () {
    if (!alias.trim())
      return yield* Effect.fail(fail("INVALID_SOURCE", "Source alias must not be empty."))
    const source = { ...(yield* explicitSource(input, undefined)), alias }
    const config = yield* configuration
    const configured = config.sources ?? []
    const sameAlias = configured.find((s) => s.alias === alias)
    if (sameAlias && sameAlias.shared_library?.library_id !== source.shared_library.library_id)
      return yield* Effect.fail(
        fail("SOURCE_AMBIGUOUS", "This alias already names another database.", { alias }),
      )
    const sources = configured.filter(
      (s) => s.shared_library?.library_id !== source.shared_library.library_id,
    )
    sources.push(source)
    const store = yield* Store
    yield* store.writeJson("config.json", { ...config, sources })
    return source
  })
}
