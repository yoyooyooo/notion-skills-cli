import { Effect, Schema } from "effect"
import { fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { parseCurrentFileContent, parseCurrentSkillState } from "./shared-current-file.ts"
import {
  queryCurrentFilesForSkills,
  queryCurrentSkillIndex,
  type CurrentSkillIndex,
} from "./shared-current-index.ts"
import { sharedSkillTextProperty } from "./shared-content.ts"
import {
  currentSharedSourceRevision,
  validateCurrentSharedSourceContent,
  validateCurrentSourceId,
  type CurrentSharedSourceContent,
} from "./shared-current-source.ts"
import {
  validateCurrentSourceContributions,
  type CurrentSourceDeclaration,
} from "./shared-current-source-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sourceRich, validateSourceDefinition } from "./shared-source-definitions.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_MANAGEMENT_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current Source metadata."),
  })

export function currentSourceProperty(library: SharedLibrary, name: string): string {
  const id = library.sources.property_ids[name]
  if (!id)
    throw fail("CURRENT_SCHEMA_REQUIRED", "A current Sources property is not registered.", {
      table: "sources",
      property: name,
      next: "migrate_current_content",
    })
  return id
}

function physicalId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("The current Source has no exact physical identity.")
  const id = pageId(input)
  if (id === undefined) throw invalid("The current Source has an invalid physical identity.")
  return id
}

function livePage(library: SharedLibrary, input: unknown) {
  const row = property(input),
    parent = property(row.parent),
    id = physicalId(row.id)
  if (
    row.object !== "page" ||
    row.in_trash === true ||
    row.archived === true ||
    parent.type !== "data_source_id" ||
    physicalId(parent.data_source_id) !== physicalId(library.sources.data_source_id) ||
    (parent.database_id !== undefined &&
      physicalId(parent.database_id) !== physicalId(library.sources.database_id))
  )
    throw invalid("The current Source is unavailable or belongs to another table.")
  return { row, id }
}

function field(library: SharedLibrary, row: unknown, name: string, kind: string) {
  const id = currentSourceProperty(library, name)
  const values = Object.entries(property(property(row).properties)).flatMap(([key, value]) =>
    key === id || property(value).id === id ? [property(value)] : [],
  )
  const value = values[0]
  if (values.length !== 1 || value?.type !== kind || value.has_more === true)
    throw invalid("A current Sources property is missing, ambiguous or incomplete.", {
      property: name,
    })
  return value
}

function rich(library: SharedLibrary, row: unknown, name: string, kind = "rich_text") {
  const value = field(library, row, name, kind)[kind]
  if (!Array.isArray(value) || value.length > 100)
    throw invalid("A current Sources text property is incomplete.", { property: name })
  for (const part of value) {
    const item = property(part),
      content = typeof item.plain_text === "string" ? item.plain_text : property(item.text).content
    if (typeof content !== "string" || content.length > 2000)
      throw invalid("A current Sources text fragment is incomplete.", { property: name })
  }
  return text(value)
}

/** Read current configuration by registered identities. Status and Operation
 * describe the finite writer; they are not declaration input. */
export function parseCurrentSourceManagement(library: SharedLibrary, input: unknown) {
  const { id } = livePage(library, input)
  const source_id = validateCurrentSourceId(rich(library, input, "Source ID"))
  const provider = property(field(library, input, "Provider", "select").select).name
  if (provider !== "git")
    throw fail(
      "CURRENT_SOURCE_MANAGEMENT_UNSUPPORTED",
      "Current Source management requires a Git source with a supported exact cold-read route.",
      { source_id, provider },
    )
  const state = property(field(library, input, "Status", "select").select).name
  if (typeof state !== "string") throw invalid("The current Source state is missing.")
  const policy = property(field(library, input, "Policy", "select").select).name
  const definition = validateSourceDefinition({
    version: 1,
    source_id,
    name: rich(library, input, "Name", "title"),
    description: rich(library, input, "Description"),
    enabled: field(library, input, "Enabled", "checkbox").checkbox,
    policy,
    adapter: {
      type: "git",
      url: rich(library, input, "Location"),
      ref: rich(library, input, "Ref"),
    },
    selection: JSON.parse(rich(library, input, "Selection")),
    options: JSON.parse(rich(library, input, "Options")),
  })
  const contributions = validateCurrentSourceContributions(
    JSON.parse(rich(library, input, "Contributions")),
  )
  const content = validateCurrentSharedSourceContent(JSON.parse(rich(library, input, "Content")))
  const revision = rich(library, input, "Last Revision")
  if (!/^[a-f0-9]{64}$/u.test(revision)) throw invalid("The current Source has no exact revision.")
  return {
    page_id: id,
    declaration: { version: 1 as const, definition, contributions },
    content,
    revision,
    state: parseCurrentSkillState(state, rich(library, input, "Operation")),
  }
}

export type CurrentSourceManagement = ReturnType<typeof parseCurrentSourceManagement>

/** Complete one exact identity query before accepting absence or uniqueness. */
function queryCurrentSourceManagementRow(library: SharedLibrary, sourceId: string) {
  return Effect.gen(function* () {
    const source_id = yield* checked(() => validateCurrentSourceId(sourceId))
    const id = yield* checked(() => currentSourceProperty(library, "Source ID"))
    const api = yield* Notion,
      cursors = new Set<string>(),
      physical = new Set<string>(),
      rows: unknown[] = []
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.sources.data_source_id}/query`,
        {
          page_size: 100,
          filter: { property: id, rich_text: { equals: source_id } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const envelope = property(raw)
        if (
          envelope.object !== "list" ||
          (envelope.request_status !== undefined &&
            property(envelope.request_status).type !== "complete")
        )
          throw invalid("Current Sources enumeration is incomplete.")
        const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          result.has_more
            ? !result.next_cursor || cursors.has(result.next_cursor)
            : result.next_cursor !== null
        )
          throw invalid("Current Sources pagination did not finish or advance.")
        for (const value of result.results) {
          const row = property(value),
            parent = property(row.parent),
            page = physicalId(row.id)
          if (
            row.object !== "page" ||
            row.in_trash === true ||
            row.archived === true ||
            parent.type !== "data_source_id" ||
            physicalId(parent.data_source_id) !== physicalId(library.sources.data_source_id) ||
            rich(library, value, "Source ID") !== source_id ||
            physical.has(page)
          )
            throw invalid("The current Source query returned a foreign or repeated page.")
          physical.add(page)
          rows.push(value)
        }
        return result
      })
      if (!list.has_more) break
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
    if (rows.length > 1)
      return yield* Effect.fail(
        fail("CURRENT_SOURCE_DUPLICATE", "Several current rows claim this Source ID.", {
          source_id,
          page_ids: rows.map((row) => property(row).id),
        }),
      )
    return rows[0]
  })
}

export function queryCurrentSourceManagement(library: SharedLibrary, sourceId: string) {
  return Effect.gen(function* () {
    const raw = yield* queryCurrentSourceManagementRow(library, sourceId)
    const row =
      raw === undefined
        ? undefined
        : yield* checked(() => parseCurrentSourceManagement(library, raw))
    if (row !== undefined && (yield* currentSharedSourceRevision(row.content)) !== row.revision)
      return yield* Effect.fail(
        fail("SHARED_SOURCE_CONFLICT", "Source Content and Last Revision disagree.", {
          source_id: sourceId,
        }),
      )
    return row
  })
}

export function currentSourceWriteProperties(
  library: SharedLibrary,
  input: {
    readonly declaration: CurrentSourceDeclaration
    readonly content: CurrentSharedSourceContent
    readonly revision: string
    readonly creatingOperation?: string
  },
) {
  const definition = input.declaration.definition
  if (definition.adapter.type !== "git")
    throw invalid("Current Source publication requires the supported Git adapter.")
  const rich = (value: string) => ({ rich_text: sourceRich(value) })
  const values: Record<string, unknown> = {
    Name: { title: sourceRich(definition.name) },
    "Source ID": rich(definition.source_id),
    Description: rich(definition.description),
    Provider: { select: { name: "git" } },
    Location: rich(definition.adapter.url),
    Ref: rich(definition.adapter.ref),
    Selection: rich(canonicalSharedJson(definition.selection)),
    Options: rich(canonicalSharedJson(definition.options)),
    Contributions: rich(canonicalSharedJson(input.declaration.contributions)),
    Content: rich(canonicalSharedJson(input.content)),
    "Last Revision": rich(input.revision),
    Enabled: { checkbox: definition.enabled },
    Policy: { select: { name: definition.policy } },
    ...(input.creatingOperation === undefined
      ? {}
      : {
          Status: { select: { name: "applying" } },
          Operation: rich(input.creatingOperation),
        }),
  }
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [currentSourceProperty(library, name), value]),
  )
}

export function currentSourceManagementMatches(
  current: CurrentSourceManagement,
  input: {
    readonly declaration: CurrentSourceDeclaration
    readonly content: CurrentSharedSourceContent
    readonly revision: string
  },
) {
  return (
    canonicalSharedJson(current.declaration) === canonicalSharedJson(input.declaration) &&
    canonicalSharedJson(current.content) === canonicalSharedJson(input.content) &&
    current.revision === input.revision
  )
}

/** One complete metadata inventory for the declared and reverse-linked scope.
 * Files are fetched in the existing batched owner query, never one body per row. */
export function queryCurrentSourceTargets(
  library: SharedLibrary,
  input: {
    readonly skillIds: readonly string[]
    readonly sourcePageId?: string
    readonly sourceId?: string
  },
) {
  return Effect.gen(function* () {
    const ids = [...new Set(input.skillIds)].sort(),
      byPage = new Map<string, unknown>(),
      bySkill = new Map<string, string>()
    const skillProperty = library.skills.property_ids["Skill ID"],
      originProperty = library.skills.property_ids.Origin
    if (!skillProperty || !originProperty)
      return yield* Effect.fail(invalid("Current target identities and Origin must be registered."))
    const api = yield* Notion
    for (
      let offset = 0;
      offset < Math.max(ids.length, input.sourcePageId || input.sourceId ? 1 : 0);
      offset += 80
    ) {
      const batch = ids.slice(offset, offset + 80)
      const filters: unknown[] = batch.map((id) => ({
        property: skillProperty,
        rich_text: { equals: id },
      }))
      if (offset === 0 && input.sourcePageId !== undefined)
        filters.push({ property: originProperty, relation: { contains: input.sourcePageId } })
      if (offset === 0 && input.sourceId !== undefined)
        filters.push({
          property: library.skills.property_ids.Content,
          rich_text: { contains: input.sourceId },
        })
      const cursors = new Set<string>(),
        physical = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const raw = yield* api.request(
          `v1/data_sources/${library.skills.data_source_id}/query`,
          {
            page_size: 100,
            filter: filters.length === 1 ? filters[0] : { or: filters },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
          { method: "POST" },
        )
        const result = yield* checked(() => {
          const envelope = property(raw)
          if (
            envelope.object !== "list" ||
            (envelope.request_status !== undefined &&
              property(envelope.request_status).type !== "complete")
          )
            throw invalid("The affected Skill scope is incomplete.")
          const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
          if (
            result.has_more
              ? !result.next_cursor || cursors.has(result.next_cursor)
              : result.next_cursor !== null
          )
            throw invalid("The affected Skill scope did not finish or advance.")
          for (const row of result.results) {
            const page = property(row),
              parent = property(page.parent),
              page_id = physicalId(page.id)
            if (
              page.object !== "page" ||
              page.in_trash === true ||
              page.archived === true ||
              parent.type !== "data_source_id" ||
              physicalId(parent.data_source_id) !== physicalId(library.skills.data_source_id) ||
              physical.has(page_id)
            )
              throw invalid("An affected Skill is foreign, unavailable or repeated.")
            const skill_id = sharedSkillTextProperty(row, library, "Skill ID")
            if (
              !ids.includes(skill_id) &&
              !(offset === 0 && (input.sourcePageId !== undefined || input.sourceId !== undefined))
            )
              throw invalid("The affected Skill query returned an unselected identity.")
            const previous = bySkill.get(skill_id)
            if (previous !== undefined && previous !== page_id)
              throw invalid("Several current Skills claim the same stable target identity.", {
                skill_id,
              })
            const earlier = byPage.get(page_id)
            if (earlier !== undefined && canonicalSharedJson(earlier) !== canonicalSharedJson(row))
              throw invalid("An affected Skill changed during its metadata inventory.")
            physical.add(page_id)
            byPage.set(page_id, row)
            bySkill.set(skill_id, page_id)
          }
          return result
        })
        if (!result.has_more) break
        cursor = result.next_cursor!
        cursors.add(cursor)
      }
    }
    for (const [skill_id, page] of bySkill) {
      if (ids.includes(skill_id)) continue
      const semantic =
        input.sourceId === undefined
          ? false
          : yield* checked(() => {
              const main = parseCurrentFileContent(
                sharedSkillTextProperty(byPage.get(page), library, "Content"),
              )
              return main.kind === "source" && main.source_id === input.sourceId
            })
      if (semantic) continue
      const origin =
        input.sourcePageId === undefined
          ? false
          : yield* currentSourceOriginContains(library, page, byPage.get(page), input.sourcePageId)
      if (origin) continue
      if (input.sourceId === undefined)
        return yield* Effect.fail(invalid("The reverse Source query returned an unrelated Skill."))
      // A Content substring filter may also return a different Source identity.
      bySkill.delete(skill_id)
      byPage.delete(page)
    }
    if (byPage.size === 0) return new Map<string, CurrentSkillIndex>()
    const files = yield* queryCurrentFilesForSkills({
      dataSourceId: library.files.data_source_id,
      skillPageIds: [...byPage.keys()],
      propertyIds: library.files.property_ids,
    })
    const targets = new Map<string, CurrentSkillIndex>()
    for (const [skill_id, page] of bySkill) {
      const rows = files.get(page)
      if (rows === undefined)
        return yield* Effect.fail(invalid("An affected Files scope is missing."))
      const index = yield* queryCurrentSkillIndex(library, page, byPage.get(page), rows)
      targets.set(skill_id, index)
    }
    return targets
  })
}

export function currentSourceOriginContains(
  library: SharedLibrary,
  page: string,
  rawPage: unknown,
  sourcePage: string,
) {
  return Effect.gen(function* () {
    const id = library.skills.property_ids.Origin!
    const relation = yield* checked(() => {
      if (!/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(id))
        throw invalid("The Origin property has an invalid registered identity.")
      const values = Object.entries(property(property(rawPage).properties)).flatMap(([key, raw]) =>
        key === id || property(raw).id === id ? [property(raw)] : [],
      )
      const field = values[0]
      if (
        values.length !== 1 ||
        field?.type !== "relation" ||
        !Array.isArray(field.relation) ||
        typeof field.has_more !== "boolean"
      )
        throw invalid("The reverse Origin relation is incomplete.")
      const inline = field.relation.map((item) => physicalId(property(item).id))
      if (new Set(inline).size !== inline.length)
        throw invalid("The reverse Origin relation repeats a Source.")
      return { inline, hasMore: field.has_more }
    })
    if (relation.inline.includes(sourcePage)) return true
    if (!relation.hasMore) return false
    const api = yield* Notion,
      cursors = new Set<string>(),
      seen = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const params = new URLSearchParams({
        page_size: "100",
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const raw = yield* api.request(`v1/pages/${page}/properties/${id}?${params}`)
      const result = yield* checked(() => {
        const value = property(raw),
          metadata = property(value.property_item)
        if (
          value.object !== "list" ||
          value.type !== "property_item" ||
          metadata.id !== id ||
          metadata.type !== "relation"
        )
          throw invalid("Origin pagination belongs to another property.")
        const list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          list.has_more
            ? !list.next_cursor || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw invalid("Origin pagination did not finish or advance.")
        const ids = list.results.map((raw) => {
          const item = property(raw)
          if (item.object !== "property_item" || item.id !== id || item.type !== "relation")
            throw invalid("An Origin property item has a different identity.")
          const found = physicalId(property(item.relation).id)
          if (seen.has(found)) throw invalid("Origin pagination repeats a Source.")
          seen.add(found)
          return found
        })
        return { ...list, ids }
      })
      if (result.ids.includes(sourcePage)) return true
      if (!result.has_more) return false
      cursor = result.next_cursor!
      cursors.add(cursor)
    }
  })
}
