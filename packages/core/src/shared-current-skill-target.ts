import { Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { bindSkillRef, parseSkillRef } from "./skill-ref.ts"
import { validateCurrentSourceContributions } from "./shared-current-source-input.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

type Table = "skills" | "files" | "sources" | "records"
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SKILL_MANAGEMENT_CONFLICT", message, details)
export const checkedSkillManagement = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current Skill management input."),
  })

export function currentSkillProperty(library: SharedLibrary, table: Table, name: string): string {
  const id = library[table].property_ids[name]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A current table property is not registered.", {
      table,
      property: name,
    })
  return id
}

export function currentSkillField(
  library: SharedLibrary,
  table: Table,
  raw: unknown,
  name: string,
  type: string,
): Record<string, unknown> {
  const id = currentSkillProperty(library, table, name)
  const matches = Object.entries(property(property(raw).properties)).flatMap(([key, raw]) => {
    const field = property(raw)
    return key === id || field.id === id ? [field] : []
  })
  const field = matches[0]
  if (matches.length !== 1 || field?.type !== type || (field.id !== undefined && field.id !== id))
    throw invalid("A registered property is missing, repeated or has a different type.", {
      table,
      property: name,
    })
  return field
}

export function currentSkillText(
  library: SharedLibrary,
  table: Table,
  raw: unknown,
  name: string,
  kind = "rich_text",
): string {
  const field = currentSkillField(library, table, raw, name, kind)
  const parts = field[kind]
  if (!Array.isArray(parts) || parts.length > 100 || field.has_more === true)
    throw invalid("A current text property is incomplete.", { table, property: name })
  for (const raw of parts) {
    const part = property(raw)
    const value =
      typeof part.plain_text === "string" ? part.plain_text : property(part.text).content
    if (typeof value !== "string" || value.length > 2000)
      throw invalid("A current text fragment is invalid.", { table, property: name })
  }
  return text(parts)
}

export function assertCurrentSkillPage(
  library: SharedLibrary,
  table: Table,
  raw: unknown,
  expectedPage?: string,
  allowTrash = false,
): string {
  const row = property(raw),
    parent = property(row.parent)
  const id = typeof row.id === "string" ? pageId(row.id) : undefined
  const dataSource =
    typeof parent.data_source_id === "string" ? pageId(parent.data_source_id) : undefined
  if (
    row.object !== "page" ||
    !id ||
    (expectedPage !== undefined && id !== expectedPage) ||
    parent.type !== "data_source_id" ||
    dataSource !== library[table].data_source_id ||
    (!allowTrash && (row.in_trash === true || row.archived === true || row.is_archived === true))
  )
    throw invalid("The selected page is unavailable or belongs to another current table.", {
      table,
      page_id: id ?? expectedPage,
    })
  return id
}

/** Exhaust one scoped query before absence can authorize a mutation. */
export function queryCurrentTablePages(
  library: SharedLibrary,
  table: Table,
  filter?: unknown,
  fields: readonly string[] = [],
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const query = new URLSearchParams()
    for (const name of fields)
      query.append("filter_properties", currentSkillProperty(library, table, name))
    const suffix = fields.length === 0 ? "" : "?" + query
    const pages: unknown[] = [],
      ids = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        "v1/data_sources/" + library[table].data_source_id + "/query" + suffix,
        {
          page_size: 100,
          ...(filter === undefined ? {} : { filter }),
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const result = yield* checkedSkillManagement(() => {
        const envelope = property(raw)
        if (
          envelope.object !== "list" ||
          (envelope.request_status !== undefined &&
            property(envelope.request_status).type !== "complete")
        )
          throw invalid("Current management requires a complete table query.", { table })
        const list = decode(listSchema(Schema.Unknown), raw)
        if (
          list.has_more
            ? !list.next_cursor || list.next_cursor.length > 2048 || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw invalid("Current table pagination did not complete or advance.", { table })
        for (const row of list.results) {
          const id = assertCurrentSkillPage(library, table, row)
          if (ids.has(id))
            throw invalid("A current table query repeated a page.", { table, page_id: id })
          ids.add(id)
          pages.push(row)
        }
        return list
      })
      if (!result.has_more) break
      cursor = result.next_cursor!
      cursors.add(cursor)
    }
    return pages
  })
}

export function queryCurrentSkillIdentity(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const id = yield* checkedSkillManagement(() => currentWriteIdentity(skillId, "Skill ID"))
    const rows = yield* queryCurrentTablePages(library, "skills", {
      property: currentSkillProperty(library, "skills", "Skill ID"),
      rich_text: { equals: id },
    })
    for (const row of rows) {
      if (
        (yield* checkedSkillManagement(() =>
          currentSkillText(library, "skills", row, "Skill ID"),
        )) !== id
      )
        return yield* Effect.fail(invalid("An identity query returned another Skill."))
    }
    if (rows.length > 1)
      return yield* Effect.fail(
        fail("SHARED_SKILL_ID_CONFLICT", "Several pages claim this Skill ID.", {
          skill_id: id,
          page_ids: rows.map((row) => property(row).id),
        }),
      )
    return rows[0]
  })
}

export function resolveCurrentSkillPage(
  library: SharedLibrary,
  target: string,
  options: { readonly allowTrash?: boolean } = {},
) {
  return Effect.gen(function* () {
    const exact = pageId(target)
    const stableId = yield* checkedSkillManagement(() => {
      if (!target.startsWith("skill://")) return target
      const reference = bindSkillRef(parseSkillRef(target), library.library_id)
      if (
        reference.owner.libraryId !== library.library_id ||
        reference.path ||
        reference.selection.kind !== "current"
      )
        throw invalid("Management targets must be current root Skills in the selected Library.")
      return reference.owner.skillId
    })
    const raw =
      exact === undefined
        ? yield* queryCurrentSkillIdentity(library, stableId)
        : yield* (yield* Notion).request("v1/pages/" + exact)
    if (raw === undefined)
      return yield* Effect.fail(
        fail("SKILL_NOT_FOUND", "No current Skill has this exact stable identity.", {
          target,
        }),
      )
    const page_id = yield* checkedSkillManagement(() =>
      assertCurrentSkillPage(library, "skills", raw, exact, options.allowTrash === true),
    )
    const stable = yield* checkedSkillManagement(() =>
      currentSkillText(library, "skills", raw, "Skill ID"),
    )
    if (stable) {
      const found = yield* queryCurrentSkillIdentity(library, stable)
      if (found !== undefined && property(found).id !== page_id)
        return yield* Effect.fail(
          fail("SHARED_SKILL_ID_CONFLICT", "Another page claims this Skill ID.", {
            skill_id: stable,
            page_id,
          }),
        )
    }
    return { page_id, raw }
  })
}

/** A Source contribution remains authority even when all its reading rows disappeared. */
export function assertNoCurrentSourceContribution(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const rows = yield* queryCurrentTablePages(library, "sources", undefined, ["Contributions"])
    for (const raw of rows) {
      const contributions = yield* checkedSkillManagement(() => {
        const encoded = currentSkillText(library, "sources", raw, "Contributions")
        // An empty current declaration names no target. Unrelated unbound Source
        // rows must not become a migration prerequisite for native authoring.
        if (encoded === "") return []
        let parsed: unknown
        try {
          parsed = JSON.parse(encoded)
        } catch {
          throw invalid("A nonempty Source contribution declaration is not complete JSON.", {
            source_page_id: property(raw).id,
          })
        }
        return validateCurrentSourceContributions(parsed)
      })
      if (contributions.some((item) => item.skill_id === skillId))
        return yield* Effect.fail(
          fail(
            "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
            "This Skill still has a current Source contribution. Use Source management before native management.",
            {
              skill_id: skillId,
              source_page_id: property(raw).id,
            },
          ),
        )
    }
  })
}
