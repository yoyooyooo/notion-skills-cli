import { CatalogSchema, decode, fail, property, resolveRecord } from "./model.ts"
import { fileRef, pageId, parseTarget, type SkillTarget } from "./ref.ts"

/** Exact and fixed targets retain their direct owner admission path. */
export function isCurrentNameTarget(target: SkillTarget) {
  return (
    target.snapshot === undefined &&
    pageId(target.selector) === undefined &&
    !/^(shared_skill:[^:]+:.+|(?:notion_subscription|upstream):[a-f0-9-]+)$/u.test(target.selector)
  )
}

/** Pure selection from the complete ordinary catalog; this does not prepare a Skill. */
export function resolveCatalogReference(input: string, value: unknown) {
  const target = parseTarget(input)
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
      "Name uniqueness requires complete ordinary discovery; select an exact returned ref or specify a database.",
      { selector: target.selector, coverage: directory.coverage, projections },
    )
  const identities = new Set<string>()
  for (const record of directory.records) {
    if (identities.has(record.id))
      throw fail("CATALOG_INCOMPLETE", "The catalog repeats a content identity.", {
        id: record.id,
      })
    identities.add(record.id)
  }
  const record = resolveRecord(target.selector, {
    ...directory,
    records: directory.records.filter((candidate) => candidate.enabled !== false),
  })
  return {
    record,
    scope: directory.scope,
    ref: fileRef(record.id, target.path || record.entrypoint, undefined, target.file_id),
  }
}
