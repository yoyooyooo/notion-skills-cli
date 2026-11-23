import { CatalogSchema, decode, fail, property } from "./model.ts"
import { bindTarget, fileRef, parseTarget } from "./ref.ts"
import { validateSharedRecordIdentity } from "./shared-content.ts"

/** Pure exact selection from a complete catalog. A short ref needs an entry scope. */
export function resolveCatalogReference(input: string, value: unknown, contextLibraryId?: string) {
  const target = bindTarget(parseTarget(input), contextLibraryId)
  if (target.snapshot !== undefined)
    throw fail("INVALID_ARGUMENT", "Resolve a fixed reference from its snapshot manifest.")
  const envelope = property(value)
  if (envelope.ok !== undefined && envelope.ok !== true)
    throw fail("INVALID_RESPONSE", "A failed catalog response cannot select a Skill.")
  const directory = (() => {
    try {
      return decode(CatalogSchema, value)
    } catch {
      throw fail("INVALID_RESPONSE", "Expected a complete Skill catalog response.")
    }
  })()
  const projections = [
    "view",
    "view_selection",
    "view_query",
    "profile",
    "capability_directory",
    "query",
    "limit",
    "cursor",
    "has_more",
    "next_cursor",
    "total_count",
  ].filter((key) => key in envelope)
  if (
    projections.length ||
    directory.coverage.method === "explicit_view" ||
    !directory.coverage.exhaustive ||
    directory.coverage.search_index_limited ||
    directory.coverage.failed_sources.length ||
    (envelope.count !== undefined && envelope.count !== directory.records.length)
  )
    throw fail(
      "CATALOG_INCOMPLETE",
      "Exact selection requires a complete ordinary catalog or an explicit database.",
      {
        selector: target.selector,
        coverage: directory.coverage,
        projections,
      },
    )
  const libraries = new Map<string, string>()
  for (const source of directory.databases) {
    const library = source.shared_library
    if (library === undefined)
      throw fail("CURRENT_SCHEMA_REQUIRED", "Catalog entries require a current Library descriptor.")
    if (
      source.database_id !== library.skills.database_id ||
      source.data_source_ids.length !== 1 ||
      source.data_source_ids[0] !== library.skills.data_source_id
    )
      throw fail(
        "LIBRARY_INVALID",
        "The catalog Library descriptor differs from its physical source.",
      )
    const physical = `${library.skills.database_id}/${library.skills.data_source_id}`
    const previous = libraries.get(library.library_id)
    if (previous !== undefined && previous !== physical)
      throw fail("LIBRARY_ID_CONFLICT", "One Library ID is bound to different Notion databases.", {
        library_id: library.library_id,
      })
    libraries.set(library.library_id, physical)
  }
  if (
    target.kind === "skill" &&
    target.reference.scope.kind === "library" &&
    !libraries.has(target.reference.scope.libraryId)
  )
    throw fail(
      "LIBRARY_SCOPE_MISMATCH",
      "The complete selected catalog belongs to a different Library.",
      { library_id: target.reference.scope.libraryId },
    )
  const identities = new Set<string>()
  for (const record of directory.records) {
    validateSharedRecordIdentity(record)
    const locator = record.locator
    if (
      locator.type !== "shared_skill" ||
      libraries.get(locator.library_id) !== `${locator.database_id}/${locator.data_source_id}`
    )
      throw fail("LIBRARY_INVALID", "The catalog Skill has no exact Library binding.")
    if (identities.has(record.id))
      throw fail("SKILL_ID_CONFLICT", "The catalog repeats a Skill identity.", { id: record.id })
    identities.add(record.id)
  }
  const matches = directory.records.filter((record) =>
    target.kind === "page"
      ? record.locator.type === "shared_skill" && record.locator.page_id === target.selector
      : record.id === target.selector,
  )
  const record = matches[0]
  if (matches.length > 1)
    throw fail("SKILL_ID_CONFLICT", "The target has more than one physical binding.")
  if (record === undefined)
    throw fail("SKILL_NOT_FOUND", "The exact Skill identity was not found.", {
      selector: target.selector,
    })
  if (record.enabled === false) throw fail("CONTENT_DISABLED", "The selected Skill is disabled.")
  return {
    record,
    scope: directory.scope,
    ref: fileRef(record.id, target.path || record.entrypoint),
  }
}
