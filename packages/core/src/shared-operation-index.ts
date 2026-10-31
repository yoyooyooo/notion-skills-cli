import { Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

/** Compact discovery only. A header does not prove the referenced Payload. */
export type SharedOperationHeader = {
  readonly page_id: string
  readonly record_id: string
  readonly entity_id: string
  readonly hash: string
}

const fields = ["Record ID", "Entity ID", "Kind", "Skill", "Hash"] as const
type Field = (typeof fields)[number]
const invalid = (message: string) => fail("SHARED_OPERATION_INDEX_INVALID", message)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("Shared operation metadata could not be decoded."),
  })

function identity(value: unknown) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw invalid("Shared operation metadata has an invalid identity.")
  return value
}

function ids(library: SharedLibrary): Readonly<Record<Field, string>> {
  const result = {
    "Record ID": identity(library.records.property_ids["Record ID"]),
    "Entity ID": identity(library.records.property_ids["Entity ID"]),
    Kind: identity(library.records.property_ids.Kind),
    Skill: identity(library.records.property_ids.Skill),
    Hash: identity(library.records.property_ids.Hash),
  }
  if (new Set(Object.values(result)).size !== fields.length)
    throw invalid("Operation index property IDs must be distinct.")
  return result
}

function field(row: Record<string, unknown>, id: string) {
  const matches = Object.entries(property(row.properties)).flatMap(([key, raw]) => {
    const value = property(raw)
    return value.id === id || key === id ? [value] : []
  })
  const value = matches[0]
  if (matches.length !== 1 || value === undefined || (value.id !== undefined && value.id !== id))
    throw invalid("Operation index omitted a registered property identity.")
  return value
}

function rich(row: Record<string, unknown>, id: string) {
  const value = field(row, id)
  if (
    value.type !== "rich_text" ||
    !Array.isArray(value.rich_text) ||
    (value.has_more !== undefined && value.has_more !== false)
  )
    throw invalid("Operation index rich text is incomplete.")
  for (const raw of value.rich_text) {
    const span = property(raw)
    if (
      typeof span.plain_text !== "string" &&
      !(span.type === "text" && typeof property(span.text).content === "string")
    )
      throw invalid("Operation index contains an unreadable text span.")
  }
  return text(value.rich_text)
}

function header(
  raw: unknown,
  library: SharedLibrary,
  skillPageId: string,
  properties: Readonly<Record<Field, string>>,
): SharedOperationHeader {
  const row = property(raw),
    parent = property(row.parent)
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    row.archived === true ||
    row.in_trash === true ||
    row.is_archived === true ||
    parent.type !== "data_source_id" ||
    parent.data_source_id !== library.records.data_source_id ||
    (parent.database_id !== undefined && parent.database_id !== library.records.database_id)
  )
    throw invalid("Operation index returned an unavailable or foreign page.")
  const relation = field(row, properties.Skill)
  if (
    relation.type !== "relation" ||
    !Array.isArray(relation.relation) ||
    relation.relation.length !== 1 ||
    relation.has_more !== false ||
    property(relation.relation[0]).id !== skillPageId
  )
    throw invalid("Operation index returned a foreign or incomplete Skill relation.")
  const kind = field(row, properties.Kind)
  if (kind.type !== "select" || property(kind.select).name !== "operation")
    throw invalid("Operation index returned another record kind.")
  const hash = rich(row, properties.Hash)
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw invalid("Operation index contains an invalid envelope hash.")
  return {
    page_id: row.id,
    record_id: identity(rich(row, properties["Record ID"])),
    entity_id: identity(rich(row, properties["Entity ID"])),
    hash,
  }
}

/** One paginated metadata query shared by observation and explicit-write discovery. */
export function querySharedOperationIndex(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const prepared = yield* checked(() => {
      if (
        pageId(skillPageId) !== skillPageId ||
        pageId(library.records.data_source_id) !== library.records.data_source_id
      )
        throw invalid("Operation index requires canonical Notion identities.")
      const properties = ids(library),
        parameters = new URLSearchParams()
      for (const name of fields) parameters.append("filter_properties", properties[name])
      return {
        properties,
        path: `v1/data_sources/${library.records.data_source_id}/query?${parameters}`,
      }
    })
    const api = yield* Notion
    const headers = new Map<string, SharedOperationHeader>(),
      pages = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        prepared.path,
        {
          page_size: 100,
          filter: {
            and: [
              { property: prepared.properties.Skill, relation: { contains: skillPageId } },
              { property: prepared.properties.Kind, select: { equals: "operation" } },
            ],
          },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const value = property(raw)
        if (
          value.object !== "list" ||
          (value.request_status !== undefined && property(value.request_status).type !== "complete")
        )
          throw invalid("Operation index did not return a complete list.")
        const decoded = decode(listSchema(Schema.Unknown), value)
        if (!decoded.has_more && decoded.next_cursor !== null)
          throw invalid("A complete operation index retains an unexpected cursor.")
        if (
          decoded.has_more &&
          (typeof decoded.next_cursor !== "string" ||
            decoded.next_cursor === "" ||
            cursors.has(decoded.next_cursor))
        )
          throw invalid("Operation index pagination failed to advance.")
        return decoded
      })
      for (const rawRow of list.results) {
        const entry = yield* checked(() =>
          header(rawRow, library, skillPageId, prepared.properties),
        )
        if (pages.has(entry.page_id))
          return yield* Effect.fail(invalid("Operation index repeated a page."))
        pages.add(entry.page_id)
        const previous = headers.get(entry.record_id)
        if (previous && (previous.hash !== entry.hash || previous.entity_id !== entry.entity_id))
          return yield* Effect.fail(
            fail("SHARED_RECORD_CONFLICT", "One operation identity has incompatible metadata.", {
              operation_id: entry.record_id,
            }),
          )
        if (previous === undefined || entry.page_id < previous.page_id)
          headers.set(entry.record_id, entry)
      }
      if (!list.has_more)
        return [...headers.values()].sort((left, right) =>
          left.record_id < right.record_id ? -1 : left.record_id > right.record_id ? 1 : 0,
        )
      cursor = list.next_cursor ?? undefined
      if (cursor !== undefined) cursors.add(cursor)
    }
  })
}
