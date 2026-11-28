import { Schema } from "effect"
import {
  CatalogSchema,
  SourceFailureSchema,
  aliasFor,
  fail,
  validateDescription,
  type Catalog,
  type Source,
} from "./model.ts"
import { validateSharedRecordIdentity } from "./shared-content.ts"

export const CatalogRejectionSchema = Schema.Struct({
  page_id: Schema.String,
  id: Schema.optional(Schema.String),
  reason: Schema.Literals(["disabled", "unavailable"]),
  observed_at: Schema.Number,
  generation: Schema.Number,
})

/** One catalog slot retains its last complete directory separately from the
 * latest observation. These fields are discovery facts, never body authority. */
export const CatalogObservationSchema = Schema.Struct({
  ...CatalogSchema.fields,
  generation: Schema.optional(Schema.Number),
  invalidated: Schema.optional(Schema.Boolean),
  rejected_records: Schema.optional(Schema.Array(CatalogRejectionSchema)),
  denied_sources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...SourceFailureSchema.fields,
        observed_at: Schema.Number,
        generation: Schema.Number,
      }),
    ),
  ),
  last_complete: Schema.optional(CatalogSchema),
  last_failure: Schema.optional(Schema.Struct({ code: Schema.String, observed_at: Schema.Number })),
})
export type CatalogObservation = typeof CatalogObservationSchema.Type

export const catalogSelection = (library: string | undefined, sources: readonly Source[]) => [
  "root-library-directory-v2",
  library ?? "all",
  sources,
]

export function validateCachedCatalog(catalog: Catalog, scope: string, library?: string) {
  if (
    catalog.scope !== scope ||
    catalog.library_id !== library ||
    !Number.isFinite(catalog.fetched_at) ||
    catalog.fetched_at < 0
  )
    throw fail("STATE_CORRUPT", "Cached catalog identity or timestamp differs from its selection.")
  const identities = new Set<string>()
  const pages = new Set<string>()
  for (const record of catalog.records) {
    if (aliasFor(record.name) !== record.alias)
      throw fail("INVALID_SKILL_NAME", "Cached skill name differs from its Notion Name.", {
        page_id: record.id,
        name: record.name,
      })
    if (record.locator.type !== "shared_skill")
      throw fail("STATE_CORRUPT", "The catalog contains a noncurrent remote record.")
    validateDescription(record.description)
    validateSharedRecordIdentity(record)
    if (identities.has(record.id) || pages.has(record.locator.page_id))
      throw fail("STATE_CORRUPT", "Cached shared catalog repeats a Skill identity.", {
        id: record.id,
      })
    identities.add(record.id)
    pages.add(record.locator.page_id)
    const locator = record.locator
    const source = catalog.databases.find((entry) => entry.database_id === locator.database_id)
    if (
      source?.shared_library === undefined ||
      source.shared_library.library_id !== locator.library_id ||
      source.shared_library.skills.data_source_id !== locator.data_source_id ||
      (library !== undefined && locator.library_id !== library)
    )
      throw fail("STATE_CORRUPT", "Cached shared Skill no longer matches its catalog descriptor.", {
        id: record.id,
      })
  }
}

export function completeCatalog(observation: CatalogObservation): Catalog | undefined {
  if (
    observation.invalidated ||
    observation.last_failure !== undefined ||
    !observation.coverage.exhaustive ||
    observation.coverage.failed_sources.length > 0
  )
    return observation.last_complete
  return Schema.decodeUnknownSync(CatalogSchema)(observation)
}

/** Called inside the existing SQLite publication transaction, after its
 * generation fence. A partial/failed attempt cannot retire a complete directory. */
export function retainCompleteCatalog(value: unknown, previous?: unknown): CatalogObservation {
  const incoming = Schema.decodeUnknownSync(CatalogObservationSchema)(value)
  if (previous === undefined) return incoming
  const before = Schema.decodeUnknownSync(CatalogObservationSchema)(previous)
  if (incoming.scope !== before.scope || incoming.library_id !== before.library_id)
    throw fail("STATE_CORRUPT", "A catalog slot cannot change Library or credential scope.")
  const { last_complete: _retained, ...current } =
    incoming.last_failure === undefined
      ? incoming
      : {
          ...before,
          generation: incoming.generation,
          invalidated: true,
          last_failure: incoming.last_failure,
        }
  if (
    !incoming.invalidated &&
    incoming.last_failure === undefined &&
    incoming.coverage.exhaustive &&
    incoming.coverage.failed_sources.length === 0
  )
    return current
  const retained = completeCatalog(before)
  const rejected = new Map(
    (before.rejected_records ?? [])
      .filter(
        (entry) =>
          !current.records.some(
            (record) =>
              record.id === entry.id ||
              (record.locator.type === "shared_skill" && record.locator.page_id === entry.page_id),
          ),
      )
      .map((entry) => [entry.page_id, entry]),
  )
  for (const entry of current.rejected_records ?? []) rejected.set(entry.page_id, entry)
  const denied = new Map(
    (before.denied_sources ?? [])
      .filter(
        (entry) =>
          !current.coverage.queried_data_sources.includes(entry.data_source_id ?? entry.id),
      )
      .map((entry) => [entry.id, entry]),
  )
  for (const entry of current.denied_sources ?? []) denied.set(entry.id, entry)
  return {
    ...current,
    ...(retained === undefined ? {} : { last_complete: retained }),
    rejected_records: [...rejected.values()],
    denied_sources: [...denied.values()],
  }
}
