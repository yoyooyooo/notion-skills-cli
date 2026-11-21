import { Effect, Schema } from "effect"
import { fail, listSchema, property, SkillsError, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { parseCurrentSourceManagement } from "./shared-current-source-management.ts"
import { currentSharedSourceRevision } from "./shared-current-source.ts"
import type { SharedLibrary, TableBinding } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

export type CurrentDailyReason =
  | { readonly kind: "skill_daily" | "default_context" }
  | { readonly kind: "source_daily"; readonly source_id: string }

export type CurrentDailySkill = {
  readonly skill_id: string
  readonly page_id: string
  readonly name: string
  readonly enabled: boolean
  readonly default_context: boolean
  readonly daily: boolean
  readonly desired_delete: boolean
  readonly reasons: readonly CurrentDailyReason[]
}

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_DAILY_SELECTION_INVALID", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The daily selection metadata is invalid."),
  })

function exactPage(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)
  )
    throw invalid("The daily selection requires exact Notion page identities.")
  const id = pageId(value)
  if (id === undefined) throw invalid("The daily selection has an invalid page identity.")
  return id
}

function checkbox(row: unknown, id: string, name: string): boolean {
  const values = Object.entries(property(property(row).properties)).flatMap(([key, raw]) =>
    key === id || property(raw).id === id ? [property(raw)] : [],
  )
  const selected = values[0]
  if (
    values.length !== 1 ||
    selected?.type !== "checkbox" ||
    typeof selected.checkbox !== "boolean"
  )
    throw invalid("A daily selection checkbox is missing, ambiguous or has a different type.", {
      property: name,
      property_id: id,
    })
  return selected.checkbox
}

/** Optional user policy fields are resolved once by schema, then read only by ID. */
function policyFields(table: TableBinding) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/data_sources/${table.data_source_id}`)
    return yield* checked(() => {
      const schema = property(raw)
      if (
        schema.object !== "data_source" ||
        exactPage(schema.id) !== exactPage(table.data_source_id)
      )
        throw invalid("The daily checkbox schema belongs to another data source.")
      const resolve = (name: string) => {
        const registered = table.property_ids[name]
        const matches = Object.entries(property(schema.properties)).flatMap(([key, value]) => {
          const field = property(value)
          return registered === undefined
            ? key === name || field.name === name
              ? [field]
              : []
            : key === registered || field.id === registered
              ? [field]
              : []
        })
        const field = matches[0]
        if (
          matches.length !== 1 ||
          field?.type !== "checkbox" ||
          typeof field.id !== "string" ||
          !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(field.id)
        )
          throw invalid(
            "Daily selection requires one existing checkbox with this exact name or registered ID.",
            {
              data_source_id: table.data_source_id,
              property: name,
            },
          )
        return field.id
      }
      const daily = resolve("日用"),
        desiredDelete = resolve("期望删除")
      if (daily === desiredDelete)
        throw invalid("Daily policy checkboxes must have distinct identities.")
      return { daily, desiredDelete }
    })
  })
}

function queryPages(table: TableBinding, filter: unknown, properties: readonly string[] = []) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const parameters = new URLSearchParams()
    for (const id of new Set(properties)) parameters.append("filter_properties", id)
    const endpoint = `v1/data_sources/${table.data_source_id}/query${properties.length ? `?${parameters}` : ""}`
    const pages = new Map<string, unknown>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        endpoint,
        {
          page_size: 100,
          filter,
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
          throw invalid("The daily metadata query is incomplete.")
        const list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          list.has_more
            ? !list.next_cursor || list.next_cursor.length > 2048 || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw invalid("Daily metadata pagination did not finish or advance.")
        for (const value of list.results) {
          const row = property(value),
            parent = property(row.parent),
            id = exactPage(row.id)
          if (
            row.object !== "page" ||
            row.in_trash === true ||
            row.archived === true ||
            row.is_archived === true ||
            parent.type !== "data_source_id" ||
            exactPage(parent.data_source_id) !== exactPage(table.data_source_id) ||
            pages.has(id)
          )
            throw invalid("Daily metadata contains a foreign, unavailable or repeated page.", {
              page_id: id,
            })
          pages.set(id, value)
        }
        return list
      })
      if (!result.has_more) break
      const next = result.next_cursor
      if (next === null) return yield* Effect.fail(invalid("Daily metadata has no next cursor."))
      cursor = next
      cursors.add(next)
    }
    return pages
  })
}

/** Current Source contributions define membership; Origin is only navigation.
 * Selection reads metadata only and retains disabled/deletion-marked choices. */
export function loadCurrentDailySkills(library: SharedLibrary) {
  return Effect.gen(function* () {
    const skillPolicy = yield* policyFields(library.skills)
    const sourcePolicy = yield* policyFields(library.sources)
    const sourceRows = yield* queryPages(library.sources, {
      property: sourcePolicy.daily,
      checkbox: { equals: true },
    })
    const sources: {
      source_id: string
      page_id: string
      name: string
      enabled: boolean
      desired_delete: boolean
    }[] = []
    const membership = new Map<string, string[]>()
    const sourceIds = new Set<string>()
    for (const [page, raw] of sourceRows) {
      const current = yield* checked(() => {
        if (!checkbox(raw, sourcePolicy.daily, "日用"))
          throw invalid("The daily Source query returned an unselected Source.")
        const current = parseCurrentSourceManagement(library, raw)
        if (current.state.state !== "ready")
          throw invalid(
            "Finish the selected Source operation before selecting all daily members.",
            { source_id: current.declaration.definition.source_id },
          )
        return current
      })
      const definition = current.declaration.definition
      if (sourceIds.has(definition.source_id))
        return yield* Effect.fail(
          invalid("Several daily Sources claim the same stable identity.", {
            source_id: definition.source_id,
          }),
        )
      sourceIds.add(definition.source_id)
      if ((yield* currentSharedSourceRevision(current.content)) !== current.revision)
        return yield* Effect.fail(
          invalid("A daily Source has conflicting current content and revision.", {
            source_id: definition.source_id,
          }),
        )
      sources.push({
        source_id: definition.source_id,
        page_id: page,
        name: definition.name,
        enabled: definition.enabled,
        desired_delete: yield* checked(() => checkbox(raw, sourcePolicy.desiredDelete, "期望删除")),
      })
      for (const contribution of current.declaration.contributions) {
        const ids = membership.get(contribution.skill_id) ?? []
        if (!ids.includes(definition.source_id)) ids.push(definition.source_id)
        membership.set(contribution.skill_id, ids)
      }
    }
    const source: Source = {
      alias: library.library_id,
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      title: "",
      role: "content",
      shared_library: library,
    }
    const requiredFields = ["Name", "Description", "Kind", "Enabled", "Default Context", "Skill ID"]
    const fields = yield* checked(() =>
      requiredFields.map((name) => {
        const id = library.skills.property_ids[name]
        if (!id)
          throw invalid("A daily Skill metadata property is not registered.", { property: name })
        return id
      }),
    )
    const ids = [...membership.keys()].sort(),
      selected = new Map<string, CurrentDailySkill>(),
      physical = new Map<string, string>()
    for (let offset = 0; offset < Math.max(ids.length, 1); offset += 80) {
      const batch = ids.slice(offset, offset + 80)
      const filters: unknown[] = batch.map((id) => ({
        property: library.skills.property_ids["Skill ID"],
        rich_text: { equals: id },
      }))
      if (offset === 0)
        filters.push(
          { property: skillPolicy.daily, checkbox: { equals: true } },
          { property: library.skills.property_ids["Default Context"], checkbox: { equals: true } },
        )
      const rows = yield* queryPages(
        library.skills,
        filters.length === 1 ? filters[0] : { or: filters },
        [...fields, skillPolicy.daily, skillPolicy.desiredDelete],
      )
      for (const [page, raw] of rows) {
        const skill = yield* checked(() => {
          const record = sharedRecordFromPage(raw, source, library.skills.data_source_id)
          const daily = checkbox(raw, skillPolicy.daily, "日用"),
            desired_delete = checkbox(raw, skillPolicy.desiredDelete, "期望删除")
          if (
            !batch.includes(record.locator.skill_id) &&
            !(offset === 0 && (daily || record.default_context))
          )
            throw invalid("The daily Skill query returned an unselected identity.", {
              skill_id: record.locator.skill_id,
            })
          const reasons: CurrentDailyReason[] = []
          if (daily) reasons.push({ kind: "skill_daily" })
          if (record.default_context) reasons.push({ kind: "default_context" })
          for (const source_id of membership.get(record.locator.skill_id) ?? [])
            reasons.push({ kind: "source_daily", source_id })
          return {
            skill_id: record.locator.skill_id,
            page_id: page,
            name: record.name,
            enabled: record.enabled,
            default_context: record.default_context,
            daily,
            desired_delete,
            reasons,
          } satisfies CurrentDailySkill
        })
        const previous = selected.get(skill.skill_id),
          previousId = physical.get(page)
        if (
          (previous && canonicalSharedJson(previous) !== canonicalSharedJson(skill)) ||
          (previousId !== undefined && previousId !== skill.skill_id)
        )
          return yield* Effect.fail(
            invalid("A daily Skill identity is duplicated or changed during selection.", {
              skill_id: skill.skill_id,
              page_id: page,
            }),
          )
        selected.set(skill.skill_id, skill)
        physical.set(page, skill.skill_id)
      }
    }
    const missing = ids.filter((id) => !selected.has(id))
    if (missing.length)
      return yield* Effect.fail(
        invalid(
          "Current daily Source contributions name unavailable Skills; synchronize those Sources first.",
          { skill_ids: missing },
        ),
      )
    return {
      library_id: library.library_id,
      complete: true as const,
      sources: sources.sort((a, b) => a.source_id.localeCompare(b.source_id)),
      skills: [...selected.values()].sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
    }
  })
}
