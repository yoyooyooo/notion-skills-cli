import { Clock, Effect, Schema } from "effect"
import { authScope, databaseId, discoverDatabases, explicitSource } from "./catalog.ts"
import {
  effectiveCachePolicy,
  freshness,
  locallySelectedScope,
  recordScope,
  validateReadPolicy,
  type ReadPolicyOptions,
} from "./cache.ts"
import {
  CatalogSchema,
  PageSchema,
  SourceSchema,
  SkillsError,
  decode,
  fail,
  property,
  recordFromPage,
  type ContentRecord,
  type Source,
  type SourceFailure,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { Store, configuredSources, sha256 } from "./store.ts"

const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
)
export const ViewSchema = Schema.Struct({
  id: UUID,
  name: Schema.String,
  type: Schema.String,
  database_id: UUID,
  data_source_id: UUID,
  url: Schema.String,
})
export type View = typeof ViewSchema.Type
const RawViewSchema = Schema.Struct({
  id: UUID,
  name: Schema.String,
  type: Schema.String,
  data_source_id: UUID,
  parent: Schema.Struct({ type: Schema.Literal("database_id"), database_id: UUID }),
  url: Schema.String,
})
const ReferenceSchema = Schema.Struct({ id: UUID, object: Schema.String })
const ReferencesSchema = Schema.Struct({
  results: Schema.Array(ReferenceSchema),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
  request_status: Schema.optional(Schema.Unknown),
})
const QuerySchema = Schema.Struct({
  ...ReferencesSchema.fields,
  id: UUID,
  view_id: UUID,
  expires_at: Schema.String,
  total_count: Schema.Number,
})
const ViewListSchema = Schema.Struct({
  scope: Schema.String,
  fetched_at: Schema.Number,
  database: SourceSchema,
  views: Schema.Array(ViewSchema),
})
const ViewCatalogSchema = Schema.Struct({
  ...CatalogSchema.fields,
  view: Schema.NullOr(ViewSchema),
  view_selection: Schema.Literals(["explicit", "first", "none"]),
  view_query: Schema.NullOr(
    Schema.Struct({ id: UUID, expires_at: Schema.String, total_count: Schema.Number }),
  ),
})

export interface ViewOptions extends ReadPolicyOptions {
  readonly database?: string
}
export interface ViewCatalogOptions extends ViewOptions {
  readonly view?: string
}

/** A Notion URL's v parameter is the view identity, never the database in its path. */
export function viewId(input: string): string {
  let value = input
  if (input.includes("://")) {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      throw fail("INVALID_VIEW", "Use a View ID or a Notion URL containing one v parameter.")
    }
    if (
      url.protocol !== "https:" ||
      !/(^|\.)notion\.(so|com|site)$/.test(url.hostname) ||
      url.searchParams.getAll("v").length !== 1
    )
      throw fail("INVALID_VIEW", "Use a View ID or a Notion URL containing one v parameter.")
    value = url.searchParams.get("v") ?? ""
  }
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value))
    throw fail("INVALID_VIEW", "A view selector must be an exact ID, not its name.")
  const id = pageId(value)
  if (!id) throw fail("INVALID_VIEW", "Invalid View ID.")
  return id
}

function parse<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) {
  return Effect.try({
    try: () => decode(schema, value),
    catch: () => fail("INVALID_RESPONSE", "Invalid Notion View response."),
  })
}
function complete(value: { readonly request_status?: unknown }) {
  if (
    property(value.request_status).type === "incomplete" ||
    property(value.request_status).incomplete_reason !== undefined
  )
    throw fail(
      "VIEW_INCOMPLETE",
      "Notion returned an incomplete View result; narrow the View and retry.",
      value.request_status,
    )
}
function nextCursor(
  page: { readonly has_more: boolean; readonly next_cursor: string | null },
  seen: Set<string>,
): string | undefined {
  if (!page.has_more) return undefined
  if (!page.next_cursor || seen.has(page.next_cursor))
    throw fail("INVALID_RESPONSE", "Notion returned a missing or repeating View cursor.")
  seen.add(page.next_cursor)
  return page.next_cursor
}
function check<A>(f: () => A) {
  return Effect.try({
    try: f,
    catch: (error) =>
      error instanceof SkillsError ? error : fail("INVALID_RESPONSE", "Invalid View response."),
  })
}

function selectedDatabase(selector?: string) {
  return Effect.gen(function* () {
    if (selector !== undefined) return yield* databaseId(selector)
    const configured = [...new Set((yield* configuredSources).map((source) => source.database_id))]
    if (configured.length === 1) return configured[0]!
    if (configured.length > 1)
      return yield* Effect.fail(
        fail("DATABASE_AMBIGUOUS", "Select a content database with --database.", {
          databases: configured,
        }),
      )
    const found = yield* discoverDatabases()
    if (found.failures.length)
      return yield* Effect.fail(
        fail("CATALOG_INCOMPLETE", "Cannot select a database from incomplete discovery."),
      )
    if (found.databases.length !== 1)
      return yield* Effect.fail(
        fail("DATABASE_AMBIGUOUS", "Select a content database with --database.", {
          databases: found.databases,
        }),
      )
    return found.databases[0]!.database_id
  })
}

/** Complete observations are cached separately from the full explicit Skill catalog. */
function observe<S extends Schema.ConstraintDecoder<unknown>, R>(
  selection: unknown,
  schema: S,
  options: ReadPolicyOptions,
  read: (scope: string) => Effect.Effect<S["Type"], SkillsError, R>,
) {
  return Effect.gen(function* () {
    yield* check(() => validateReadPolicy(options))
    const local = !options.refresh
      ? yield* locallySelectedScope(Boolean(options.offline))
      : undefined
    const scope = local ?? (yield* authScope)
    const store = yield* Store
    const keyFor = (identity: string) => `cache/views/${identity}/${digest}.json`
    const digest = yield* sha256(JSON.stringify(["notion-views-v1", selection]))
    const now = yield* Clock.currentTimeMillis
    const maxAge = options.maxAge ?? (yield* effectiveCachePolicy).catalog_max_age_ms
    if (!options.refresh) {
      const cached = yield* store.readJson(keyFor(scope), schema)
      if (cached !== undefined) {
        const envelope = property(cached)
        const at = envelope.fetched_at
        const failures = property(envelope.coverage).failed_sources
        const completeObservation = !Array.isArray(failures) || failures.length === 0
        if (
          completeObservation &&
          envelope.scope === scope &&
          typeof at === "number" &&
          Number.isFinite(at) &&
          at <= now &&
          (options.offline || now - at < maxAge)
        ) {
          return {
            value: cached,
            source: "local_cache" as const,
            freshness: freshness(options, at, now, maxAge),
          }
        }
      }
      if (options.offline)
        return yield* Effect.fail(
          fail(
            "CACHE_MISSING",
            "No complete View observation exists in this credential and selection scope.",
          ),
        )
    }
    const validated = local ? yield* authScope : scope
    const generation = yield* store.reserveCacheGeneration(validated, `views-${digest}`)
    const value = yield* read(validated)
    const at = property(value).fetched_at
    if (typeof at !== "number")
      return yield* Effect.fail(fail("INVALID_RESPONSE", "View observation has no timestamp."))
    yield* store.writeJson(keyFor(validated), { ...property(value), generation })
    yield* recordScope(validated)
    return {
      value,
      source: "notion" as const,
      freshness: freshness(options, at, yield* Clock.currentTimeMillis, maxAge),
    }
  })
}

function retrieveView(id: string, database?: string) {
  return Effect.gen(function* () {
    const raw = yield* parse(RawViewSchema, yield* (yield* Notion).request(`v1/views/${id}`))
    if (raw.id !== id || (database !== undefined && raw.parent.database_id !== database))
      return yield* Effect.fail(
        fail("VIEW_SCOPE_MISMATCH", "The View does not belong to the selected database.", {
          view_id: id,
          database_id: database,
        }),
      )
    return {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      database_id: raw.parent.database_id,
      data_source_id: raw.data_source_id,
      url: raw.url,
    }
  })
}

export function listViews(options: ViewOptions = {}) {
  return Effect.gen(function* () {
    const database = yield* selectedDatabase(options.database)
    const observed = yield* observe(["list", database], ViewListSchema, options, (scope) =>
      Effect.gen(function* () {
        const source = yield* explicitSource(database)
        const api = yield* Notion
        const ids: string[] = []
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const query = new URLSearchParams({
            database_id: database,
            page_size: "100",
            ...(cursor ? { start_cursor: cursor } : {}),
          })
          const page = yield* parse(ReferencesSchema, yield* api.request(`v1/views?${query}`))
          yield* check(() => complete(page))
          for (const ref of page.results) {
            if (ref.object !== "view" || ids.includes(ref.id))
              return yield* Effect.fail(
                fail("INVALID_RESPONSE", "Invalid or repeated View identity."),
              )
            ids.push(ref.id)
          }
          cursor = yield* check(() => nextCursor(page, cursors))
        } while (cursor)
        const views: View[] = []
        for (const id of ids) {
          const view = yield* retrieveView(id, database)
          if (!source.data_source_ids.includes(view.data_source_id))
            return yield* Effect.fail(
              fail("VIEW_SCOPE_MISMATCH", "View references another data source."),
            )
          views.push(view)
        }
        return { scope, fetched_at: yield* Clock.currentTimeMillis, database: source, views }
      }),
    )
    return {
      ...observed.value,
      count: observed.value.views.length,
      source: observed.source,
      freshness: observed.freshness,
    }
  })
}

function queryView(view: View) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const started = yield* Clock.currentTimeMillis
    const first = yield* parse(
      QuerySchema,
      yield* api.request(`v1/views/${view.id}/queries`, { page_size: 100 }),
    )
    yield* check(() => complete(first))
    const expires = Date.parse(first.expires_at)
    if (
      first.view_id !== view.id ||
      !Number.isSafeInteger(first.total_count) ||
      first.total_count < 0 ||
      !Number.isFinite(expires)
    )
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "Invalid View query identity, count or expiration."),
      )
    const ids: string[] = []
    const cursors = new Set<string>()
    let page: typeof ReferencesSchema.Type = first
    while (true) {
      if ((yield* Clock.currentTimeMillis) >= expires)
        return yield* Effect.fail(
          fail("VIEW_QUERY_EXPIRED", "The View query expired; start a fresh query."),
        )
      yield* check(() => complete(page))
      for (const ref of page.results) {
        if (ref.object !== "page" || ids.includes(ref.id))
          return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid or repeated View member."))
        ids.push(ref.id)
      }
      const cursor = yield* check(() => nextCursor(page, cursors))
      if (!cursor) break
      const query = new URLSearchParams({ start_cursor: cursor, page_size: "100" })
      page = yield* parse(
        ReferencesSchema,
        yield* api.request(`v1/views/${view.id}/queries/${first.id}?${query}`),
      )
    }
    if (ids.length !== first.total_count)
      return yield* Effect.fail(
        fail("VIEW_INCOMPLETE", "View result count does not match its complete query."),
      )
    return {
      ids,
      fetched_at: started,
      query: { id: first.id, expires_at: first.expires_at, total_count: first.total_count },
    }
  })
}

export function viewCatalog(options: ViewCatalogOptions = {}) {
  return Effect.gen(function* () {
    const explicit =
      options.view === undefined ? undefined : yield* check(() => viewId(options.view!))
    const database =
      options.database === undefined ? undefined : yield* databaseId(options.database)
    const configured = yield* configuredSources
    const observed = yield* observe(
      ["members", explicit ?? "first", database ?? configured],
      ViewCatalogSchema,
      options,
      (scope) =>
        Effect.gen(function* () {
          const listing =
            explicit === undefined ? yield* listViews({ database, refresh: true }) : undefined
          if (listing && listing.scope !== scope)
            return yield* Effect.fail(
              fail(
                "ACCESS_DENIED",
                "Credential scope changed while selecting the default View; retry discovery.",
              ),
            )
          const view =
            explicit !== undefined ? yield* retrieveView(explicit, database) : listing?.views[0]
          const source = listing?.database ?? (yield* explicitSource(view!.database_id))
          if (view && !source.data_source_ids.includes(view.data_source_id))
            return yield* Effect.fail(
              fail("VIEW_SCOPE_MISMATCH", "View references another data source."),
            )
          if (!view)
            return {
              scope,
              fetched_at: yield* Clock.currentTimeMillis,
              databases: [source],
              records: [],
              coverage: {
                method: "explicit_view",
                exhaustive: true,
                queried_data_sources: [],
                failed_sources: [],
                search_index_limited: false,
              },
              view: null,
              view_selection: "none" as const,
              view_query: null,
            }
          const selection = yield* queryView(view)
          const wanted = new Set(selection.ids)
          const records = new Map<string, ContentRecord>()
          const failures: SourceFailure[] = []
          const seen = new Set<string>()
          const cursors = new Set<string>()
          const api = yield* Notion
          // A paginated metadata inventory is cheaper than one request per selected Skill.
          // Decode only selected rows: an unrelated malformed record must not poison a View.
          const InventorySchema = Schema.Struct({
            results: Schema.Array(Schema.Unknown),
            has_more: Schema.Boolean,
            next_cursor: Schema.NullOr(Schema.String),
            request_status: Schema.optional(Schema.Unknown),
          })
          let cursor: string | undefined
          if (wanted.size)
            do {
              const page = yield* parse(
                InventorySchema,
                yield* api.request(`v1/data_sources/${view.data_source_id}/query`, {
                  page_size: 100,
                  ...(cursor ? { start_cursor: cursor } : {}),
                }),
              )
              yield* check(() => complete(page))
              for (const raw of page.results) {
                const id = property(raw).id
                if (typeof id !== "string" || !wanted.has(id)) continue
                const checked = yield* check(() => {
                  if (seen.has(id))
                    throw fail("INVALID_RESPONSE", "Repeated selected page metadata.")
                  seen.add(id)
                  const row = decode(PageSchema, raw)
                  const parent = property(property(raw).parent)
                  if (
                    row.in_trash ||
                    parent.database_id !== source.database_id ||
                    parent.data_source_id !== view.data_source_id
                  )
                    throw fail(
                      "VIEW_MEMBER_UNAVAILABLE",
                      "A selected page moved, was removed or changed ownership.",
                    )
                  return recordFromPage(row, source, view.data_source_id)
                }).pipe(Effect.result)
                if (checked._tag === "Success") records.set(id, checked.success)
                else
                  failures.push({
                    id,
                    code: checked.failure.code,
                    database_id: source.database_id,
                    data_source_id: view.data_source_id,
                    alias: source.alias,
                    title: source.title,
                  })
              }
              cursor = yield* check(() => nextCursor(page, cursors))
            } while (cursor)
          for (const id of wanted)
            if (!seen.has(id))
              failures.push({
                id,
                code: "VIEW_MEMBER_UNAVAILABLE",
                database_id: source.database_id,
                data_source_id: view.data_source_id,
                alias: source.alias,
                title: source.title,
              })
          return {
            scope,
            fetched_at: selection.fetched_at,
            databases: [source],
            records: selection.ids.flatMap((id) => {
              const record = records.get(id)
              return record ? [record] : []
            }),
            coverage: {
              method: "explicit_view",
              exhaustive: failures.length === 0,
              queried_data_sources: wanted.size ? [view.data_source_id] : [],
              failed_sources: failures,
              search_index_limited: false,
            },
            view,
            view_selection: explicit ? ("explicit" as const) : ("first" as const),
            view_query: selection.query,
          }
        }),
    )
    return { ...observed.value, source: observed.source, freshness: observed.freshness }
  })
}
