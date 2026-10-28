import { Clock, Effect, Schema } from "effect"
import {
  CatalogSchema,
  DatabaseSchema,
  DataSourceSchema,
  UserSchema,
  PageSchema,
  listSchema,
  decode,
  fail,
  aliasFor,
  SkillsError,
  recordFromPage,
  property,
  text,
  validateDescription,
  type Catalog,
  type Source,
  type CatalogSource,
  type NotionPageRecord,
  type SourceFailure,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { Store, configuration, configuredSources, sha256 } from "./store.ts"
import { pageId } from "./ref.ts"
import { fileRef } from "./ref.ts"
import {
  publishedSubscriptionFromPage,
  validatePublishedMember,
  SUBSCRIPTION_ROUTER_MIN_MEMBERS,
} from "./upstream-router.ts"
import type { ContentRecord } from "./model.ts"
import {
  effectiveCachePolicy,
  freshness,
  locallySelectedScope,
  recordScope,
  validateReadPolicy,
  type ReadPolicyOptions,
} from "./cache.ts"

export const authScope = Effect.gen(function* () {
  const api = yield* Notion
  const value = yield* api.request("v1/users/me")
  const user = yield* Effect.try({
    try: () => decode(UserSchema, value),
    catch: () => fail("INVALID_RESPONSE", "Invalid authenticated user response."),
  })
  const credential = yield* api.credentialIdentity
  // Only the selected credential digest enters cached authentication scopes.
  const scope = yield* sha256(
    JSON.stringify([
      user.id,
      process.env.NOTION_WORKSPACE_ID ?? "",
      process.env.NOTION_API_BASE_URL ?? "https://api.notion.com",
      credential,
    ]),
  )
  return scope
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

export function databaseId(input: string, sources?: readonly Source[]) {
  return Effect.gen(function* () {
    const id = pageId(input)
    if (id) return id
    const configured = sources ?? (yield* configuredSources)
    const matches = configured.filter((source) => source.alias === input)
    if (!matches.length)
      return yield* Effect.fail(
        fail(
          "DATABASE_NOT_FOUND",
          "No registered database alias matched; use an ID, URL or exact registered alias.",
          { selector: input, candidates: configured },
        ),
      )
    if (matches.some((source) => source.database_id !== matches[0]!.database_id))
      return yield* Effect.fail(
        fail(
          "DATABASE_AMBIGUOUS",
          "The registered alias names multiple databases; use a database ID.",
          { selector: input, candidates: matches },
        ),
      )
    return matches[0]!.database_id
  })
}

export function explicitSource(input: string, sources?: readonly Source[]) {
  return Effect.gen(function* () {
    const configured = sources ?? (yield* configuredSources)
    const id = yield* databaseId(input, configured)
    if ((yield* configuration).upstream_database === id)
      return yield* Effect.fail(
        fail(
          "NOT_CONTENT_DATABASE",
          "The upstream subscription database is not a content source.",
          { database_id: id },
        ),
      )
    const registered = configured.find((source) => source.database_id === id)
    const api = yield* Notion
    const db = yield* Effect.gen(function* () {
      const value = yield* api.request(`v1/databases/${id}`)
      return yield* Effect.try({
        try: () => decode(DatabaseSchema, value),
        catch: () => fail("INVALID_RESPONSE", "Invalid database response."),
      })
    }).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          database_id: id,
          alias: registered?.alias ?? id,
          ...(registered ? { title: registered.title } : {}),
        }),
      ),
    )
    let referencesDatabase = false
    if (db.database_type !== "skills" && !db.in_trash) {
      referencesDatabase = db.data_sources.length > 0
      for (const source of db.data_sources) {
        const raw = yield* api.request(`v1/data_sources/${source.id}`)
        const props = property(property(raw).properties)
        if (
          property(props.References).type !== "rich_text" ||
          property(props.Description).type !== "rich_text"
        )
          referencesDatabase = false
      }
    }
    if (db.in_trash || (db.database_type !== "skills" && !referencesDatabase))
      return yield* Effect.fail(
        fail(
          "NOT_SKILLS_DATABASE",
          "A skill database needs rich-text Description and References properties, or the native Skills type.",
          { database_id: id, alias: registered?.alias ?? id, title: text(db.title) },
        ),
      )
    return {
      alias: registered?.alias ?? id,
      database_id: id,
      title: text(db.title),
      data_source_ids: db.data_sources.map((s) => s.id),
      role: "content",
    } satisfies Source
  })
}

export function discoverDatabases() {
  return Effect.gen(function* () {
    const databases = new Map<string, Source>()
    const failures: SourceFailure[] = []
    const upstreamDatabase = (yield* configuration).upstream_database
    const sources = yield* paginate("v1/search", DataSourceSchema, {
      filter: { property: "object", value: "data_source" },
    })
    for (const source of sources) {
      const props = property(source.properties)
      if (
        source.in_trash ||
        source.parent.database_id === upstreamDatabase ||
        (source.database_type !== "skills" &&
          (property(props.References).type !== "rich_text" ||
            property(props.Description).type !== "rich_text"))
      )
        continue
      const id = source.parent.database_id
      const previous = databases.get(id)
      databases.set(id, {
        alias: id,
        database_id: id,
        title: previous?.title ?? text(source.title),
        data_source_ids: [...new Set([...(previous?.data_source_ids ?? []), source.id])],
        role: "content",
      })
    }
    const configured = yield* configuredSources
    for (const source of configured) {
      const result = yield* explicitSource(source.database_id, configured).pipe(Effect.result)
      if (result._tag === "Failure")
        failures.push({
          id: source.database_id,
          code: result.failure.code,
          database_id: source.database_id,
          alias: source.alias,
          title: source.title,
        })
      else databases.set(source.database_id, result.success)
    }
    return { databases: [...databases.values()], failures }
  })
}

export function creationSource(database?: string) {
  return Effect.gen(function* () {
    if (database !== undefined) return yield* explicitSource(database)
    const config = yield* configuration
    if (config.default_database !== undefined) return yield* explicitSource(config.default_database)
    const discovered = yield* discoverDatabases()
    if (discovered.failures.length)
      return yield* Effect.fail(
        fail(
          "CATALOG_INCOMPLETE",
          "Database discovery failed; specify --database or configure a default.",
          discovered,
        ),
      )
    if (discovered.databases.length !== 1)
      return yield* Effect.fail(
        fail(
          discovered.databases.length ? "DATABASE_AMBIGUOUS" : "DATABASE_NOT_FOUND",
          "Create requires one discovered Skills Database, a configured default, or --database.",
          { candidates: discovered.databases },
        ),
      )
    return yield* explicitSource(discovered.databases[0]!.database_id)
  })
}

export function setDefaultDatabase(database?: string) {
  return Effect.gen(function* () {
    const config = yield* configuration
    const source = database === undefined ? undefined : yield* explicitSource(database)
    const { default_database: _previous, ...rest } = config
    const next = { ...rest, ...(source ? { default_database: source.database_id } : {}) }
    const store = yield* Store
    yield* store.writeJson("config.json", next)
    return next
  })
}

export interface CatalogOptions extends ReadPolicyOptions {
  readonly database?: string
}
export function catalog(options: CatalogOptions = {}, selection: "all" | "content" = "all") {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateReadPolicy(options),
      catch: (error) => error as SkillsError,
    })
    const selectedScope = !options.refresh
      ? yield* locallySelectedScope(Boolean(options.offline))
      : undefined
    const scope = selectedScope ?? (yield* authScope)
    const store = yield* Store
    const configured = yield* configuredSources
    const catalogSelection = ["database-selection-v5", options.database ?? "auto", configured]
    if (selection === "content") catalogSelection.push("content-only")
    const key = `cache/catalogs/${scope}/${yield* sha256(JSON.stringify(catalogSelection))}.json`
    const now = yield* Clock.currentTimeMillis
    const maxAge = options.maxAge ?? (yield* effectiveCachePolicy).catalog_max_age_ms
    if (!options.refresh) {
      const result = yield* store.readJson(key, CatalogSchema).pipe(Effect.result)
      if (result._tag === "Failure" && options.offline) return yield* Effect.fail(result.failure)
      const cached = result._tag === "Success" ? result.success : undefined
      const age = cached ? now - cached.fetched_at : NaN
      if (
        cached &&
        cached.scope === scope &&
        !cached.coverage.failed_sources.length &&
        (options.offline || (Number.isFinite(age) && age >= 0 && age < maxAge))
      ) {
        const records: ContentRecord[] = []
        const failed: SourceFailure[] = []
        for (const skill of cached.records) {
          const checked = yield* Effect.try({
            try: () => {
              if (aliasFor(skill.name) !== skill.alias)
                throw fail(
                  "INVALID_SKILL_NAME",
                  "Cached skill name differs from its Notion Name.",
                  {
                    page_id:
                      skill.locator.type === "notion_page" ? skill.locator.page_id : skill.id,
                    name: skill.name,
                  },
                )
              if (skill.locator.type === "notion_page") validateDescription(skill.description)
            },
            catch: (error) =>
              error instanceof SkillsError
                ? fail(error.code, error.message, {
                    page_id:
                      skill.locator.type === "notion_page" ? skill.locator.page_id : skill.id,
                    name: skill.name,
                  })
                : fail("STATE_CORRUPT", "Cached Skill title failed validation.", {
                    page_id:
                      skill.locator.type === "notion_page" ? skill.locator.page_id : skill.id,
                  }),
          }).pipe(Effect.result)
          if (checked._tag === "Success") records.push(skill)
          else if (
            skill.locator.type === "notion_subscription" ||
            (skill.locator.type === "notion_page" && checked.failure.code === "INVALID_SKILL")
          )
            failed.push({
              id:
                skill.locator.type === "notion_subscription"
                  ? skill.locator.subscription_id
                  : skill.id,
              code: checked.failure.code,
              database_id: skill.locator.database_id,
              data_source_id: skill.locator.data_source_id,
              alias: skill.locator.database_id,
              title: skill.name,
            })
          else return yield* Effect.fail(checked.failure)
        }
        return {
          ...cached,
          records,
          coverage: {
            ...cached.coverage,
            exhaustive: cached.coverage.exhaustive && !failed.length,
            failed_sources: failed,
          },
          source: "local_cache" as const,
          freshness: freshness(options, cached.fetched_at, now, maxAge),
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
    if (options.database !== undefined) {
      const db = yield* explicitSource(options.database, configured)
      databases.set(db.database_id, db)
    } else {
      const discovered = yield* discoverDatabases()
      for (const source of discovered.databases) databases.set(source.database_id, source)
      failures.push(...discovered.failures)
    }
    const skills = new Map<string, ContentRecord>()
    // Retain parent identity alongside the decoded metadata for shared Router validation.
    const inventory = new Map<
      string,
      { page: unknown; database_id: string; data_source_id: string }
    >()
    const InventoryPageSchema = Schema.Struct({
      ...PageSchema.fields,
      parent: Schema.optional(Schema.Unknown),
    })
    const queried: string[] = []
    for (const db of databases.values()) {
      for (const id of new Set(db.data_source_ids)) {
        const result = yield* paginate(`v1/data_sources/${id}/query`, InventoryPageSchema, {}).pipe(
          Effect.result,
        )
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
          inventory.set(row.id, { page: row, database_id: db.database_id, data_source_id: id })
          if (row.in_trash) continue
          const checked = yield* Effect.try({
            try: () => recordFromPage(row, db, id),
            catch: (e) => e as SkillsError,
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
          skills.set(row.id, checked.success)
        }
      }
    }
    const upstream = (yield* configuration).upstream_database
    const catalogDatabases: CatalogSource[] = [...databases.values()]
    if (upstream && selection === "all") {
      const database = yield* Effect.gen(function* () {
        const raw = yield* (yield* Notion).request(`v1/databases/${upstream}`)
        return yield* Effect.try({
          try: () => {
            const db = decode(DatabaseSchema, raw)
            if (db.id !== upstream || db.in_trash)
              throw fail("INVALID_RESPONSE", "Subscription database identity is unavailable.")
            return db
          },
          catch: () => fail("INVALID_RESPONSE", "Invalid subscription database response."),
        })
      }).pipe(Effect.result)
      if (database._tag === "Failure")
        failures.push({
          id: upstream,
          code: database.failure.code,
          database_id: upstream,
          alias: upstream,
          title: "Upstream subscriptions",
        })
      else {
        catalogDatabases.push({
          alias: upstream,
          database_id: upstream,
          title: text(database.success.title),
          data_source_ids: database.success.data_sources.map((source) => source.id),
          role: "upstream",
        })
        for (const source of database.success.data_sources) {
          const rows = yield* Effect.gen(function* () {
            const raw = yield* (yield* Notion).request(`v1/data_sources/${source.id}`)
            const ds = yield* Effect.try({
              try: () => decode(DataSourceSchema, raw),
              catch: () => fail("INVALID_RESPONSE", "Invalid subscription data source."),
            })
            if (ds.id !== source.id || ds.parent.database_id !== upstream || ds.in_trash)
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Subscription data source identity does not match."),
              )
            return yield* paginate(`v1/data_sources/${source.id}/query`, InventoryPageSchema, {})
          }).pipe(Effect.result)
          if (rows._tag === "Failure") {
            failures.push({
              id: source.id,
              code: rows.failure.code,
              database_id: upstream,
              data_source_id: source.id,
              alias: upstream,
              title: "Upstream subscriptions",
            })
            continue
          }
          queried.push(source.id)
          for (const row of rows.success) {
            if (row.in_trash) continue
            const status = property(property(row.properties.Status).select).name
            if (status !== "verified" && status !== "partial" && status !== "disabled") continue
            const result = yield* Effect.try({
              try: () => {
                const subscription = publishedSubscriptionFromPage(
                  upstream,
                  database.success,
                  row,
                  row.id,
                )
                if (subscription.data_source_id !== source.id)
                  throw fail(
                    "INVALID_RESPONSE",
                    "Subscription locator differs from its queried source.",
                  )
                // An explicit content scope must not fail on another target's members.
                if (
                  options.database !== undefined &&
                  !databases.has(subscription.target_database_id)
                )
                  return undefined
                for (const member of subscription.published.members) {
                  const observed = inventory.get(member.page_id)
                  const target = databases.get(subscription.target_database_id)
                  if (
                    !observed ||
                    !target ||
                    observed.database_id !== target.database_id ||
                    !target.data_source_ids.includes(observed.data_source_id)
                  )
                    throw fail(
                      "UPSTREAM_ROUTER_UNAVAILABLE",
                      "An active member is absent from its target inventory.",
                      { page_id: member.page_id },
                    )
                  const parent = property(property(observed.page).parent)
                  if (
                    parent.data_source_id !== observed.data_source_id ||
                    (parent.database_id !== undefined && parent.database_id !== target.database_id)
                  )
                    throw fail(
                      "UPSTREAM_ROUTER_UNAVAILABLE",
                      "An active member belongs to another target.",
                      { page_id: member.page_id },
                    )
                  validatePublishedMember(subscription, member, observed.page)
                }
                return subscription
              },
              catch: (e) =>
                e instanceof SkillsError
                  ? e
                  : fail("INVALID_RESPONSE", "Invalid subscription Router metadata."),
            }).pipe(Effect.result)
            if (result._tag === "Failure") {
              failures.push({
                id: row.id,
                code: result.failure.code,
                database_id: upstream,
                data_source_id: source.id,
                alias: upstream,
                title: text(property(row.properties.Name).title),
              })
              continue
            }
            const subscription = result.success
            if (!subscription) continue
            const repo = aliasFor(subscription.name)
            for (const member of subscription.published.members) {
              const record = skills.get(member.page_id)
              if (record?.kind === "skill")
                skills.set(member.page_id, { ...record, upstream: { repo } })
            }
            if (subscription.published.members.length < SUBSCRIPTION_ROUTER_MIN_MEMBERS) continue
            const id = `notion_subscription:${subscription.subscription_id}`
            skills.set(id, {
              id,
              kind: "router",
              locator: {
                type: "notion_subscription",
                subscription_id: subscription.subscription_id,
                database_id: subscription.database_id,
                data_source_id: subscription.data_source_id,
                target_database_id: subscription.target_database_id,
              },
              name: subscription.name,
              alias: aliasFor(subscription.name),
              description: subscription.description,
              default_context: subscription.default_context,
              entrypoint: "ROUTER.md",
              ref: fileRef(`upstream:${subscription.subscription_id}`, "ROUTER.md"),
            })
          }
        }
      }
    }
    const output: Catalog = {
      scope: validatedScope,
      fetched_at: yield* Clock.currentTimeMillis,
      databases: catalogDatabases,
      records: [...skills.values()].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
      coverage: {
        method: options.database !== undefined ? "explicit_database" : "search_and_registered",
        exhaustive: options.database !== undefined && failures.length === 0,
        queried_data_sources: queried,
        failed_sources: failures,
        search_index_limited: options.database === undefined,
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
    const source = { ...(yield* explicitSource(input)), alias }
    const config = yield* configuration
    const configured = config.sources ?? []
    const sameAlias = configured.find((s) => s.alias === alias)
    if (sameAlias && sameAlias.database_id !== source.database_id)
      return yield* Effect.fail(
        fail("SOURCE_AMBIGUOUS", "This alias already names another database.", { alias }),
      )
    const sources = configured.filter((s) => s.database_id !== source.database_id)
    sources.push(source)
    const store = yield* Store
    yield* store.writeJson("config.json", { ...config, sources })
    return source
  })
}
