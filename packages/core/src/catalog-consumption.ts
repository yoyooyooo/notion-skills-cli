import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { catalogWithProfile, type ProfileCatalogOptions } from "./shared-profile-config.ts"
import { validateReadPolicy } from "./cache.ts"
import { withSharedDirectoryMetadata } from "./shared-metadata-inventory.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

export type ListCatalogOptions = ProfileCatalogOptions
export const CATALOG_DIRECTORY_CONTRACT_VERSION = 1
export type CatalogDirectorySelection =
  | { readonly view: string; readonly profile?: never }
  | { readonly profile?: string; readonly view?: never }
export type ListCatalogDirectoryOptions = Omit<
  ListCatalogOptions,
  "view" | "defaultView" | "profile"
> & {
  readonly directory: CatalogDirectorySelection
  readonly view?: never
  readonly defaultView?: never
  readonly profile?: never
}
const CatalogDirectorySelectionSchema = Schema.Union([
  Schema.Struct({ view: Schema.String }),
  Schema.Struct({ profile: Schema.optional(Schema.String) }),
])
export interface ListPageOptions {
  readonly query?: string
  readonly limit?: number
  readonly cursor?: string
}
export type ListSkillsOptions = ListCatalogOptions & ListPageOptions
export const LIST_DEFAULT_LIMIT = 50
export const LIST_MAX_LIMIT = 500

/** Full metadata for default directories. It shares the catalog cache and never reads bodies. */
function listSingleCatalog(options: ListCatalogOptions = {}) {
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
export type ListCatalogResult = Effect.Success<ReturnType<typeof listSingleCatalog>>
export type CatalogReadOutcome =
  | { readonly ok: true; readonly value: ListCatalogResult }
  | {
      readonly ok: false
      readonly error: {
        readonly code: string
        readonly message: string
        readonly details?: unknown
      }
    }
export interface ListCatalogDirectoryResult {
  readonly version: typeof CATALOG_DIRECTORY_CONTRACT_VERSION
  readonly catalog: CatalogReadOutcome
  readonly directory: CatalogReadOutcome
}

function observeCatalog(operation: ReturnType<typeof listSingleCatalog>) {
  return operation.pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed<CatalogReadOutcome>({ ok: true, value }),
      onFailure: (error) =>
        error.code === "CANCELLED"
          ? Effect.fail(error)
          : Effect.succeed<CatalogReadOutcome>({
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                ...(error.details === undefined ? {} : { details: error.details }),
              },
            }),
    }),
  )
}

function listCatalogDirectory(options: ListCatalogDirectoryOptions) {
  return withSharedDirectoryMetadata(
    Effect.gen(function* () {
      const selection = yield* Effect.try({
        try: () => {
          validateReadPolicy(options)
          if (
            options.view !== undefined ||
            options.defaultView !== undefined ||
            options.profile !== undefined
          )
            throw fail("INVALID_ARGUMENT", "Select the combined directory inside directory.")
          const selection = Schema.decodeUnknownSync(CatalogDirectorySelectionSchema)(
            options.directory,
            {
              onExcessProperty: "error",
            },
          )
          if (
            "profile" in selection &&
            selection.profile !== undefined &&
            options.database === undefined
          )
            throw fail("INVALID_ARGUMENT", "A directory Profile requires an explicit database.")
          return selection
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail(
                "INVALID_ARGUMENT",
                "directory accepts one View or an optional Profile selector.",
              ),
      })
      const policy: ListCatalogOptions = {
        database: options.database,
        refresh: options.refresh,
        offline: options.offline,
        maxAge: options.maxAge,
      }
      const catalog = yield* observeCatalog(listSingleCatalog(policy))
      const directory = yield* observeCatalog(
        listSingleCatalog({
          ...policy,
          ...selection,
          ...("view" in selection ? {} : { defaultView: true }),
        }),
      )
      if (catalog.ok && directory.ok) {
        if (catalog.value.scope !== directory.value.scope)
          return yield* Effect.fail(
            fail("ACCESS_DENIED", "Credential scope changed between directory projections."),
          )
        for (const source of directory.value.databases) {
          const previous = catalog.value.databases.find(
            (candidate) => candidate.database_id === source.database_id,
          )
          if (
            previous !== undefined &&
            canonicalSharedJson(
              "shared_library" in previous ? (previous.shared_library ?? null) : null,
            ) !==
              canonicalSharedJson(
                "shared_library" in source ? (source.shared_library ?? null) : null,
              )
          )
            return yield* Effect.fail(
              fail(
                "SHARED_LIBRARY_ID_CONFLICT",
                "Library descriptor changed between directory projections.",
              ),
            )
        }
      }
      return {
        version: CATALOG_DIRECTORY_CONTRACT_VERSION,
        catalog,
        directory,
      } satisfies ListCatalogDirectoryResult
    }),
  )
}

export function listCatalog(
  options: ListCatalogDirectoryOptions,
): ReturnType<typeof listCatalogDirectory>
export function listCatalog(options?: ListCatalogOptions): ReturnType<typeof listSingleCatalog>
export function listCatalog(options: ListCatalogOptions | ListCatalogDirectoryOptions = {}) {
  return "directory" in options ? listCatalogDirectory(options) : listSingleCatalog(options)
}

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
