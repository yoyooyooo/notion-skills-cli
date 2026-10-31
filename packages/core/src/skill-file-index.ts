import { Effect, Schema } from "effect"
import { decode, fail, listSchema, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"

export type FileBaseline = {
  readonly normalization_version: 1
  readonly sha256: string
  readonly source_revision?: string
}

/** Status is a display mirror. Shared state facts determine ownership. */
export type FileRecord = {
  readonly file_id: string
  readonly page_id: string
  readonly skill_page_id: string
  readonly path: string
  readonly last_edited_time: string
  readonly display_status: "following" | "custom" | "tombstone"
  readonly baseline?: FileBaseline
}

export type QuerySkillFilesInput = {
  readonly dataSourceId: string
  readonly skillPageId: string
  readonly propertyIds?: Readonly<Record<string, string>>
}

const fields = ["File ID", "Skill", "Path", "Projection", "Status"] as const
type Field = (typeof fields)[number]
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u

const invalid = (message: string, details?: unknown): SkillsError =>
  fail("INVALID_FILE_INDEX", message, details)

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function identifier(value: unknown, label: string, limit = 256): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value ||
    controlCharacters.test(value)
  ) {
    throw invalid(`${label} must be a non-empty, bounded identifier`)
  }
  return value
}

function notionId(value: unknown, label: string): string {
  const id = identifier(value, label, 36)
  if (
    !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.test(id)
  ) {
    throw invalid(`${label} must be a Notion UUID`)
  }
  const compact = id.replaceAll("-", "").toLowerCase()
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function fieldValue(
  properties: Record<string, unknown>,
  field: Field,
  propertyIds: QuerySkillFilesInput["propertyIds"],
): Record<string, unknown> {
  const id = propertyIds?.[field]
  if (id === undefined) return object(properties[field], `Missing ${field} property`)
  const matches = Object.entries(properties).flatMap(([key, value]) => {
    const candidate = object(value, `Property ${key}`)
    return candidate.id === id || key === id ? [candidate] : []
  })
  if (matches.length !== 1) {
    throw invalid(`Expected exactly one ${field} property with ID ${id}`, { count: matches.length })
  }
  const match = matches[0]
  if (match === undefined) throw invalid(`Missing ${field} property`)
  return match
}

function richText(property: Record<string, unknown>, field: string): string {
  if (property.type !== "rich_text" || !Array.isArray(property.rich_text)) {
    throw invalid(`${field} must be a rich_text property`)
  }
  for (const entry of property.rich_text) {
    const item = object(entry, `${field} rich text`)
    if (typeof item.plain_text === "string") continue
    if (item.type === "text" && typeof object(item.text, `${field} text`).content === "string")
      continue
    throw invalid(`${field} contains unreadable rich text`)
  }
  return text(property.rich_text)
}

export function readProjectionBaseline(value: string): FileBaseline | undefined {
  if (value === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw invalid("Projection must be valid JSON")
  }
  const data = object(parsed, "Projection")
  if (
    Object.keys(data).some(
      (key) => !["normalization_version", "sha256", "source_revision"].includes(key),
    ) ||
    data.normalization_version !== 1 ||
    typeof data.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(data.sha256)
  ) {
    throw invalid("Projection must contain normalization_version=1 and a lowercase SHA-256 digest")
  }
  return {
    normalization_version: 1,
    sha256: data.sha256,
    ...(data.source_revision === undefined
      ? {}
      : {
          source_revision: identifier(data.source_revision, "Projection source_revision", 1024),
        }),
  }
}

function fileRecord(
  value: unknown,
  skillId: string,
  dataSourceId: string,
  propertyIds: QuerySkillFilesInput["propertyIds"],
): FileRecord {
  const page = object(value, "File page")
  if (
    page.object !== "page" ||
    page.in_trash === true ||
    page.is_archived === true ||
    page.archived === true
  ) {
    throw invalid("Files query returned a non-page or inactive page")
  }
  const pageId = notionId(page.id, "File page ID")
  const parent = object(page.parent, "File page parent")
  if (
    parent.type !== "data_source_id" ||
    notionId(parent.data_source_id, "File parent data source ID") !== dataSourceId
  ) {
    throw invalid("Files query returned a row from another data source", { page_id: pageId })
  }
  const properties = object(page.properties, "File page properties")
  const fileId = identifier(
    richText(fieldValue(properties, "File ID", propertyIds), "File ID"),
    "File ID",
  )
  const rawPath = richText(fieldValue(properties, "Path", propertyIds), "Path")
  if (rawPath.length === 0 || controlCharacters.test(rawPath))
    throw invalid("Path must be non-empty and contain no control characters")
  const path = normalizePath(rawPath)
  if (path !== rawPath || path === "" || path === ".") {
    throw invalid("File Path must be canonical", { path: rawPath })
  }
  const relation = fieldValue(properties, "Skill", propertyIds)
  if (
    relation.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    relation.relation.length !== 1 ||
    (relation.has_more !== undefined && relation.has_more !== false)
  ) {
    throw invalid("Every File must have exactly one complete Skill relation")
  }
  const relatedId = notionId(object(relation.relation[0], "Skill relation").id, "Related Skill ID")
  if (relatedId !== skillId)
    throw invalid("Files query returned a row belonging to another Skill", { page_id: pageId })
  const status = fieldValue(properties, "Status", propertyIds)
  if (status.type !== "select") throw invalid("Status must be a select property")
  const displayStatus = object(status.select, "Status selection").name
  if (
    displayStatus !== "following" &&
    displayStatus !== "custom" &&
    displayStatus !== "tombstone"
  ) {
    throw invalid("Files query returned an unknown display status")
  }
  const editedAt = identifier(page.last_edited_time, "last_edited_time", 64)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(editedAt) ||
    !Number.isFinite(Date.parse(editedAt))
  ) {
    throw invalid("last_edited_time must be an ISO timestamp")
  }
  const projection = readProjectionBaseline(
    richText(fieldValue(properties, "Projection", propertyIds), "Projection"),
  )
  return {
    file_id: fileId,
    page_id: pageId,
    skill_page_id: relatedId,
    path,
    last_edited_time: editedAt,
    display_status: displayStatus,
    ...(projection === undefined ? {} : { baseline: projection }),
  }
}

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Could not decode Files metadata"),
  })
}

/** Query one selected Skill. Pagination is serial; page bodies are never loaded. */
export const querySkillFiles = (
  input: QuerySkillFilesInput,
): Effect.Effect<readonly FileRecord[], SkillsError, Notion> =>
  Effect.gen(function* () {
    const api = yield* Notion
    const { skillId, dataSourceId, endpoint, skillProperty } = yield* checked(() => {
      const skillId = notionId(input.skillPageId, "Skill ID")
      const dataSourceId = notionId(input.dataSourceId, "Files data source ID")
      const references = fields.map((field) =>
        identifier(input.propertyIds?.[field] ?? field, `${field} property reference`),
      )
      if (new Set(references).size !== references.length)
        throw invalid("Files property IDs must be distinct")
      const query = new URLSearchParams()
      for (const reference of references) query.append("filter_properties", reference)
      return {
        skillId,
        dataSourceId,
        endpoint: `v1/data_sources/${dataSourceId}/query?${query.toString()}`,
        skillProperty: input.propertyIds?.Skill ?? "Skill",
      }
    })
    const records: FileRecord[] = []
    const pageIds = new Set<string>()
    const fileIds = new Set<string>()
    const paths = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const response = yield* api.request(
        endpoint,
        {
          page_size: 100,
          filter: { property: skillProperty, relation: { contains: skillId } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const page = yield* checked(() => {
        const raw = object(response, "Files query response")
        if (raw.request_status !== undefined) {
          const status = object(raw.request_status, "Files query request_status")
          if (status.type !== "complete") throw invalid("Files query is incomplete")
        }
        const result = decode(listSchema(Schema.Unknown), raw)
        for (const value of result.results) {
          const record = fileRecord(value, skillId, dataSourceId, input.propertyIds)
          if (pageIds.has(record.page_id))
            throw invalid("Files query repeated a page", { page_id: record.page_id })
          if (fileIds.has(record.file_id))
            throw invalid("Files query repeated a File ID", { file_id: record.file_id })
          if (paths.has(record.path))
            throw invalid("Files query repeated a normalized Path", { path: record.path })
          pageIds.add(record.page_id)
          fileIds.add(record.file_id)
          paths.add(record.path)
          records.push(record)
        }
        if (result.has_more) {
          const nextCursor = identifier(result.next_cursor, "next_cursor", 2048)
          if (cursors.has(nextCursor)) throw invalid("Files query repeated a pagination cursor")
          cursors.add(nextCursor)
        }
        return result
      })
      if (!page.has_more) return records
      cursor = yield* checked(() => identifier(page.next_cursor, "next_cursor", 2048))
    }
  })
