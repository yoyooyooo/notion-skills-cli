import {
  aliasFor,
  ContentKindSchema,
  decode,
  entrypointFor,
  fail,
  property,
  text,
  validateDescription,
  type ContentRecord,
  type SharedSkillRecord,
  type Source,
} from "./model.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

function invalid(message: string, details?: unknown) {
  return fail("INVALID_SHARED_SKILL", message, details)
}

function exactPage(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(value)
  )
    throw invalid(`${label} must be a Notion UUID.`)
  const id = pageId(value)
  if (id === undefined || id === null) throw invalid(`${label} must be a Notion UUID.`)
  return id
}

function stableIdentity(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value))
    throw invalid(`${label} must be a stable bounded identity.`)
  return value
}

export function sharedSkillId(libraryId: string, skillId: string): string {
  return `shared_skill:${encodeURIComponent(stableIdentity(libraryId, "Library ID"))}:${encodeURIComponent(stableIdentity(skillId, "Skill ID"))}`
}

/** Address a Skills property by descriptor ID; display names are not identities. */
export function sharedSkillProperty(
  row: unknown,
  library: SharedLibrary,
  name: string,
): Record<string, unknown> {
  const id = library.skills.property_ids[name]
  if (typeof id !== "string" || id === "")
    throw invalid("The library has no registered Skills property.", { property: name })
  const matches = Object.entries(property(property(row).properties)).flatMap(([key, value]) => {
    const candidate = property(value)
    return candidate.id === id || key === id ? [candidate] : []
  })
  const match = matches[0]
  if (matches.length !== 1 || match === undefined || (match.id !== undefined && match.id !== id))
    throw invalid("A registered Skills property is missing or duplicated.", {
      property: name,
      property_id: id,
    })
  return match
}

function readableText(value: Record<string, unknown>, type: "title" | "rich_text", name: string) {
  const parts = value[type]
  if (
    value.type !== type ||
    !Array.isArray(parts) ||
    (value.has_more !== undefined && value.has_more !== false)
  )
    throw invalid(`${name} must contain a complete ${type} value.`)
  for (const part of parts) {
    const entry = property(part)
    if (typeof entry.plain_text === "string") continue
    if (entry.type === "text" && typeof property(entry.text).content === "string") continue
    throw invalid(`${name} contains unreadable text.`)
  }
  return text(parts)
}

function checkbox(value: Record<string, unknown>, name: string) {
  if (value.type !== "checkbox" || typeof value.checkbox !== "boolean")
    throw invalid(`${name} must be a checkbox.`)
  return value.checkbox
}

/** Metadata only. No body, resource, Files, or shared Records request is involved. */
export function sharedRecordFromPage(
  raw: unknown,
  source: Source,
  dataSourceId: string,
): SharedSkillRecord {
  const library = source.shared_library
  if (library === undefined)
    throw invalid("Shared content requires a registered library descriptor.")
  const row = property(raw)
  if (
    (row.object !== undefined && row.object !== "page") ||
    row.in_trash === true ||
    row.archived === true ||
    row.is_archived === true
  )
    throw invalid("The shared Skill page is unavailable.")
  const page = exactPage(row.id, "Skill page ID")
  const database = exactPage(source.database_id, "Skills database ID")
  const dataSource = exactPage(dataSourceId, "Skills data source ID")
  if (
    database !== exactPage(library.skills.database_id, "Registered Skills database ID") ||
    dataSource !== exactPage(library.skills.data_source_id, "Registered Skills data source ID")
  )
    throw invalid("The shared Skill source does not match its descriptor.")
  const parent = property(row.parent)
  if (
    parent.type !== "data_source_id" ||
    exactPage(parent.data_source_id, "Skill parent data source ID") !== dataSource ||
    (parent.database_id !== undefined &&
      exactPage(parent.database_id, "Skill parent database ID") !== database)
  )
    throw invalid("The shared Skill belongs to another source.", { page_id: page })

  const name = readableText(sharedSkillProperty(row, library, "Name"), "title", "Name")
  const description = validateDescription(
    readableText(sharedSkillProperty(row, library, "Description"), "rich_text", "Description"),
  )
  const skillId = stableIdentity(
    readableText(sharedSkillProperty(row, library, "Skill ID"), "rich_text", "Skill ID"),
    "Skill ID",
  )
  const kindField = sharedSkillProperty(row, library, "Kind")
  if (kindField.type !== "select") throw invalid("Kind must be a select property.")
  const kind = decode(ContentKindSchema, property(kindField.select).name)
  const enabled = checkbox(sharedSkillProperty(row, library, "Enabled"), "Enabled")
  const defaultContext = checkbox(
    sharedSkillProperty(row, library, "Default Context"),
    "Default Context",
  )
  const id = sharedSkillId(library.library_id, skillId)
  const entrypoint = entrypointFor(kind)
  return {
    id,
    kind,
    locator: {
      type: "shared_skill",
      page_id: page,
      database_id: database,
      data_source_id: dataSource,
      library_id: library.library_id,
      skill_id: skillId,
    },
    name,
    alias: aliasFor(name),
    description,
    default_context: defaultContext,
    enabled,
    entrypoint,
    ref: `skill://${encodeURIComponent(id)}/${entrypoint}`,
  }
}

/** Validate a cached shared record without loading its body or changing its page binding. */
export function validateSharedRecordIdentity(record: ContentRecord): void {
  if (record.locator.type !== "shared_skill") return
  const id = sharedSkillId(record.locator.library_id, record.locator.skill_id)
  if (
    record.id !== id ||
    record.entrypoint !== entrypointFor(record.kind) ||
    record.ref !== `skill://${encodeURIComponent(id)}/${record.entrypoint}` ||
    typeof record.enabled !== "boolean"
  )
    throw fail("STATE_CORRUPT", "Cached shared Skill identity differs from its stable locator.", {
      id: record.id,
    })
  exactPage(record.locator.page_id, "Cached page ID")
  exactPage(record.locator.database_id, "Cached database ID")
  exactPage(record.locator.data_source_id, "Cached data source ID")
}
