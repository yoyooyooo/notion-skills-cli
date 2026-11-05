import { Effect } from "effect"
import { fail, SkillsError } from "./model.ts"
import { catalogWithProfile, type ProfileCatalogOptions } from "./shared-profile-config.ts"
import { sha256 } from "./store.ts"

export type ListCatalogOptions = ProfileCatalogOptions
export interface ListPageOptions {
  readonly query?: string
  readonly limit?: number
  readonly cursor?: string
}
export type ListSkillsOptions = ListCatalogOptions & ListPageOptions
export const LIST_DEFAULT_LIMIT = 50
export const LIST_MAX_LIMIT = 500

/** Full metadata for default directories. It shares the catalog cache and never reads bodies. */
export function listCatalog(options: ListCatalogOptions = {}) {
  return catalogWithProfile(options).pipe(
    Effect.map((result) => ({
      scope: result.scope,
      fetched_at: result.fetched_at,
      databases: result.databases,
      records: result.records,
      count: result.records.length,
      coverage: result.coverage,
      source: result.source,
      freshness: result.freshness,
      ...("capability_directory" in result
        ? { capability_directory: result.capability_directory }
        : {}),
      ...("profile" in result ? { profile: result.profile } : {}),
      ...("view" in result
        ? {
            view: result.view,
            view_selection: result.view_selection,
            view_query: result.view_query,
          }
        : {}),
    })),
  )
}
export type ListCatalogResult = Effect.Success<ReturnType<typeof listCatalog>>

export function validateListPage(options: ListPageOptions = {}) {
  const limit = options.limit ?? LIST_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT)
    throw fail("INVALID_ARGUMENT", `--limit must be an integer between 1 and ${LIST_MAX_LIMIT}.`)
  if (options.query !== undefined && typeof options.query !== "string")
    throw fail("INVALID_ARGUMENT", "--query must be text.")
  if (options.cursor !== undefined && !/^list-v1:[a-f0-9]{64}:[1-9][0-9]*$/u.test(options.cursor))
    throw fail("INVALID_ARGUMENT", "Use the exact next_cursor returned by list.")
  return limit
}

/** Pagination describes this observation; coverage separately describes authorized source discovery. */
export function pageCatalog(catalog: ListCatalogResult, options: ListPageOptions = {}) {
  return Effect.gen(function* () {
    const limit = yield* Effect.try({
      try: () => validateListPage(options),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Invalid list page options."),
    })
    const query = options.query?.toLocaleLowerCase() ?? ""
    const records = query
      ? catalog.records.filter((record) =>
          `${record.name}\n${record.alias}\n${record.description}`
            .toLocaleLowerCase()
            .includes(query),
        )
      : catalog.records
    const identity = yield* sha256(
      JSON.stringify([
        catalog.scope,
        catalog.fetched_at,
        catalog.databases,
        catalog.view,
        catalog.profile === undefined
          ? undefined
          : {
              library_id: catalog.profile.library_id,
              library_entry: catalog.profile.library_entry,
              profile_id: catalog.profile.profile_id,
              revision_id: catalog.profile.revision_id,
              selection: catalog.profile.selection,
            },
        query,
        records,
      ]),
    )
    const offset = options.cursor === undefined ? 0 : Number(options.cursor.split(":")[2])
    if (
      options.cursor !== undefined &&
      (options.cursor.split(":")[1] !== identity ||
        !Number.isSafeInteger(offset) ||
        offset >= records.length)
    )
      return yield* Effect.fail(
        fail("LIST_CURSOR_STALE", "The directory or query changed; restart list without --cursor."),
      )
    const page = records.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      ...catalog,
      records: page,
      count: page.length,
      total_count: records.length,
      has_more: next < records.length,
      next_cursor: next < records.length ? `list-v1:${identity}:${next}` : null,
    }
  })
}
export type ListSkillsResult = Effect.Success<ReturnType<typeof pageCatalog>>

export function listSkills(options: ListSkillsOptions = {}) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateListPage(options),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Invalid list page options."),
    })
    return yield* pageCatalog(yield* listCatalog(options), options)
  })
}
