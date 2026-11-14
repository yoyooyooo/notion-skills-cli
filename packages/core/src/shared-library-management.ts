import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { sharedSkillId } from "./shared-content.ts"
import { fail, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  guardedSourceMutation,
  listSourceDefinitions,
  readSourceDefinition,
  sourceRich,
} from "./shared-source-definitions.ts"
import { sha256, Store } from "./store.ts"
import {
  SourceMutationAcknowledgementSchema,
  type SourceDefinition,
} from "./shared-sources-model.ts"

type Table = "skills" | "files" | "records" | "sources"
const tables = ["skills", "files", "records", "sources"] as const
const common = {
  page_id: Schema.String,
  table: Schema.Literals(tables),
  before: Schema.Record(Schema.String, Schema.Unknown),
}
const Action = Schema.Union([
  Schema.Struct({ ...common, kind: Schema.Literal("trash") }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("properties"),
    properties: Schema.Record(Schema.String, Schema.Unknown),
  }),
])
const Plan = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["remove_source", "consolidate_sources"]),
  operation_id: Schema.String,
  scope: Schema.String,
  library_id: Schema.String,
  entry: Schema.String,
  source_pages: Schema.Array(Schema.String),
  skill_pages: Schema.Array(Schema.String),
  keep_source: Schema.NullOr(Schema.String),
  actions: Schema.Array(Action),
  summary: Schema.Record(Schema.String, Schema.Unknown),
})
export type LibraryManagementPlan = typeof Plan.Type
type ManagementAction = typeof Action.Type
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("LIBRARY_MANAGEMENT_INVALID", "Invalid complete management metadata."),
  })
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const relation = (ids: readonly string[]) => ({ relation: ids.map((id) => ({ id })) })

function tableFor(library: SharedLibrary, table: Table) {
  const found = library[table]
  if (!found)
    throw fail("SOURCES_NOT_ATTACHED", "The exact registered library has no Sources table.")
  return found
}
function observedField(value: unknown): unknown {
  const p = property(value)
  if (Array.isArray(p.title)) return { title: text(p.title) }
  if (Array.isArray(p.rich_text)) return { rich_text: text(p.rich_text) }
  if (Array.isArray(p.relation)) {
    if (p.has_more === true)
      throw fail("LIBRARY_MANAGEMENT_INCOMPLETE", "A relation is incomplete.")
    const ids = p.relation.map((item) => {
      const id = property(item).id
      if (typeof id !== "string" || pageId(id) !== id)
        throw fail("LIBRARY_MANAGEMENT_INVALID", "A relation has no exact page identity.")
      return id
    })
    if (new Set(ids).size !== ids.length)
      throw fail("LIBRARY_MANAGEMENT_INVALID", "A relation repeats a page identity.")
    return { relation: ids.sort() }
  }
  if ("select" in p) return { select: property(p.select).name ?? null }
  if (typeof p.checkbox === "boolean") return { checkbox: p.checkbox }
  if (Array.isArray(p.multi_select))
    return { multi_select: p.multi_select.map((item) => property(item).name).sort() }
  if ("date" in p) return { date: p.date }
  throw fail(
    "LIBRARY_MANAGEMENT_INVALID",
    "An expected native property has an unsupported representation.",
  )
}
function propertiesById(row: unknown) {
  const fields: Record<string, unknown> = {}
  for (const field of Object.values(property(property(row).properties))) {
    const id = property(field).id
    if (typeof id !== "string" || Object.hasOwn(fields, id))
      throw fail("LIBRARY_MANAGEMENT_INVALID", "Native properties require unique stable IDs.")
    fields[id] = field
  }
  return fields
}
function shape(library: SharedLibrary, table: Table, row: unknown) {
  const ids = tableFor(library, table).property_ids,
    fields = propertiesById(row)
  return Object.fromEntries(
    Object.entries(ids)
      .filter(
        ([name]) =>
          !(table === "records" && name === "Payload") &&
          !(table === "sources" && ["Skills", "Records"].includes(name)),
      )
      .map(([name, id]) => {
        if (fields[id] === undefined)
          throw fail("LIBRARY_MANAGEMENT_INCOMPLETE", "Required native property is absent.", {
            table,
            name,
            id,
          })
        return [id, observedField(fields[id])]
      }),
  )
}
function ids(library: SharedLibrary, table: Table, row: unknown, name: string): string[] {
  const id = tableFor(library, table).property_ids[name]
  if (id === undefined) return []
  const value = property(observedField(propertiesById(row)[id])).relation
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw fail("LIBRARY_MANAGEMENT_INVALID", "Expected an exact relation.", { table, name })
  return value as string[]
}
function rowId(row: unknown): string {
  const value = property(row).id
  if (typeof value !== "string" || pageId(value) !== value)
    throw fail("LIBRARY_MANAGEMENT_INVALID", "Expected a canonical page ID.")
  return value
}
function readCompletePage(library: SharedLibrary, table: Table, id: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const query = new URLSearchParams()
    for (const [name, field] of Object.entries(tableFor(library, table).property_ids))
      if (
        !(table === "records" && name === "Payload") &&
        !(table === "sources" && ["Skills", "Records"].includes(name))
      )
        query.append("filter_properties", field)
    const raw = property(yield* api.request(`v1/pages/${id}?${query}`))
    if (
      raw.object !== "page" ||
      raw.id !== id ||
      property(raw.parent).data_source_id !== tableFor(library, table).data_source_id
    )
      return yield* Effect.fail(
        fail("LIBRARY_MANAGEMENT_SCOPE", "A selected page is outside the registered table.", {
          page_id: id,
          table,
        }),
      )
    // Trashed pages remain identifiable, but Notion may deny their separate
    // property-item endpoints. No old properties are needed to observe Trash.
    if (raw.in_trash === true) return raw
    for (const value of Object.values(property(raw.properties))) {
      const field = property(value)
      const kind = field.type
      const extended =
        field.has_more === true ||
        (kind === "rich_text" && Array.isArray(field.rich_text) && field.rich_text.length >= 25)
      if (
        !["relation", "rich_text", "title"].includes(String(kind)) ||
        !extended ||
        typeof field.id !== "string" ||
        (table === "sources" &&
          [library.sources?.property_ids.Skills, library.sources?.property_ids.Records].includes(
            field.id,
          ))
      )
        continue
      const all: unknown[] = [],
        seen = new Set<string>()
      let cursor: string | undefined
      do {
        const q = new URLSearchParams({
          page_size: "100",
          ...(cursor ? { start_cursor: cursor } : {}),
        })
        const response = property(yield* api.request(`v1/pages/${id}/properties/${field.id}?${q}`))
        if (
          response.object !== "list" ||
          !Array.isArray(response.results) ||
          typeof response.has_more !== "boolean"
        )
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_INCOMPLETE",
              "A selected relation could not be read completely.",
            ),
          )
        for (const item of response.results) {
          const value = property(item)
          if (value.type !== kind || value.id !== field.id)
            return yield* Effect.fail(
              fail(
                "LIBRARY_MANAGEMENT_INCOMPLETE",
                "A property response belongs to another field.",
              ),
            )
          all.push(value[String(kind)])
        }
        if (response.has_more) {
          if (typeof response.next_cursor !== "string" || seen.has(response.next_cursor))
            return yield* Effect.fail(
              fail("LIBRARY_MANAGEMENT_INCOMPLETE", "A relation cursor repeated."),
            )
          cursor = response.next_cursor
          seen.add(cursor)
        } else cursor = undefined
      } while (cursor)
      field[String(kind)] = all
      field.has_more = false
    }
    return raw
  })
}

/** Complete metadata only. Records Payloads and all content bodies stay unread. */
export function queryManagementRows(library: SharedLibrary, table: Table, filter?: unknown) {
  return Effect.gen(function* () {
    const selected = tableFor(library, table),
      api = yield* Notion,
      query = new URLSearchParams()
    for (const [name, id] of Object.entries(selected.property_ids))
      if (
        !(table === "records" && name === "Payload") &&
        !(table === "sources" && ["Skills", "Records"].includes(name))
      )
        query.append("filter_properties", id)
    const rows: Record<string, unknown>[] = [],
      pages = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const response = property(
        yield* api.request(`v1/data_sources/${selected.data_source_id}/query?${query}`, {
          page_size: 100,
          ...(filter === undefined ? {} : { filter }),
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      )
      if (
        response.object !== "list" ||
        !Array.isArray(response.results) ||
        typeof response.has_more !== "boolean" ||
        (response.request_status !== undefined &&
          property(response.request_status).type !== "complete")
      )
        return yield* Effect.fail(
          fail("LIBRARY_MANAGEMENT_INCOMPLETE", "Management requires complete table pagination."),
        )
      for (const value of response.results) {
        let row = property(value)
        const id = yield* checked(() => rowId(row))
        if (
          pages.has(id) ||
          property(row.parent).data_source_id !== selected.data_source_id ||
          row.in_trash === true
        )
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_INCOMPLETE",
              "A table returned duplicate, trashed or foreign rows.",
            ),
          )
        if (
          Object.values(property(row.properties)).some((field) => property(field).has_more === true)
        )
          row = yield* readCompletePage(library, table, id)
        yield* checked(() => shape(library, table, row))
        rows.push(row)
        pages.add(id)
      }
      if (response.has_more) {
        if (typeof response.next_cursor !== "string" || cursors.has(response.next_cursor))
          return yield* Effect.fail(
            fail("LIBRARY_MANAGEMENT_INCOMPLETE", "The table cursor repeated."),
          )
        cursor = response.next_cursor
        cursors.add(cursor)
      } else {
        if (response.next_cursor !== null)
          return yield* Effect.fail(
            fail("LIBRARY_MANAGEMENT_INCOMPLETE", "Terminal table cursor is invalid."),
          )
        cursor = undefined
      }
    } while (cursor)
    return rows.sort((a, b) => rowId(a).localeCompare(rowId(b)))
  })
}
function relatedFilter(
  library: SharedLibrary,
  table: "files" | "records",
  owners: readonly string[],
  sources: readonly string[] = [],
) {
  const predicates = [
    ...owners.map((id) => ({
      property: tableFor(library, table).property_ids.Skill,
      relation: { contains: id },
    })),
    ...sources.map((id) => ({
      property: library.records.property_ids.Origin,
      relation: { contains: id },
    })),
  ]
  if (predicates.length > 100)
    throw fail(
      "LIBRARY_MANAGEMENT_LIMIT",
      "Use at most 100 explicit owner/source relations per management batch.",
    )
  return predicates.length ? { or: predicates } : undefined
}
function action(
  library: SharedLibrary,
  table: Table,
  row: unknown,
  changes?: Record<string, unknown>,
): ManagementAction {
  const base = { table, page_id: rowId(row), before: shape(library, table, row) }
  return changes === undefined
    ? { ...base, kind: "trash" }
    : { ...base, kind: "properties", properties: changes }
}
function savePlan(
  library: SharedLibrary,
  fields: Omit<
    LibraryManagementPlan,
    "version" | "operation_id" | "scope" | "library_id" | "entry"
  >,
) {
  return Effect.gen(function* () {
    const base = {
      version: 1 as const,
      ...fields,
      scope: yield* authScope,
      library_id: library.library_id,
      entry: library.skills.database_id,
    }
    const plan = {
      ...base,
      operation_id: "library-manage-" + (yield* sha256(canonicalSharedJson(base))),
    }
    yield* (yield* Store).writeJson(
      `operations/library-management/${plan.scope}/${plan.operation_id}.json`,
      plan,
    )
    return plan
  })
}

/** Source membership, not display names or repository substrings, owns removal. */
export function prepareSourceRemoval(library: SharedLibrary, selector: string) {
  return Effect.gen(function* () {
    const source = yield* readSourceDefinition(library, selector)
    const skills = yield* queryManagementRows(library, "skills")
    const selected = skills.filter((row) =>
      ids(library, "skills", row, "Origin").includes(source.page_id),
    )
    if (selected.some((row) => ids(library, "skills", row, "Origin").length !== 1))
      return yield* Effect.fail(
        fail(
          "SOURCE_REMOVE_COMPOSITION",
          "A selected Skill has another origin; preserve that composition.",
        ),
      )
    const owners = selected.map(rowId),
      wanted = new Set(owners),
      actions: ManagementAction[] = []
    for (const row of skills.filter((row) => !wanted.has(rowId(row)))) {
      if (ids(library, "skills", row, "Requires").some((id) => wanted.has(id)))
        return yield* Effect.fail(
          fail(
            "SOURCE_REMOVE_REQUIRED",
            "An outside Skill requires this source's content. Resolve that dependency before removal.",
            { page_id: rowId(row) },
          ),
        )
      const members = ids(library, "skills", row, "Members")
      if (members.some((id) => wanted.has(id))) {
        const retained = members.filter((id) => !wanted.has(id))
        if (retained.length > 100)
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_LIMIT",
              "An affected Members relation exceeds the update limit.",
            ),
          )
        actions.push(
          action(library, "skills", row, {
            [library.skills.property_ids.Members!]: relation(retained),
          }),
        )
      }
    }
    const files = owners.length
      ? yield* queryManagementRows(library, "files", relatedFilter(library, "files", owners))
      : []
    for (const row of files)
      if (ids(library, "files", row, "Skill").length !== 1)
        return yield* Effect.fail(
          fail(
            "SOURCE_REMOVE_SHARED_FILE",
            "An affected File is not exclusively owned by one selected Skill.",
          ),
        )
    const records = yield* queryManagementRows(
      library,
      "records",
      relatedFilter(library, "records", owners, [source.page_id]),
    )
    actions.push(...files.map((row) => action(library, "files", row)))
    let sharedRecords = 0
    for (const row of records) {
      const otherOwners = ids(library, "records", row, "Skill").filter((id) => !wanted.has(id))
      const otherOrigins = ids(library, "records", row, "Origin").filter(
        (id) => id !== source.page_id,
      )
      if (otherOwners.length || otherOrigins.length) {
        if (otherOwners.length > 100 || otherOrigins.length > 100)
          return yield* Effect.fail(
            fail("LIBRARY_MANAGEMENT_LIMIT", "A shared Record relation exceeds the update limit."),
          )
        sharedRecords++
        actions.push(
          action(library, "records", row, {
            [library.records.property_ids.Skill!]: relation(otherOwners),
            [library.records.property_ids.Origin!]: relation(otherOrigins),
          }),
        )
      } else actions.push(action(library, "records", row))
    }
    actions.push(...selected.map((row) => action(library, "skills", row)))
    actions.push(
      action(library, "sources", yield* readCompletePage(library, "sources", source.page_id)),
    )
    return yield* savePlan(library, {
      kind: "remove_source",
      source_pages: [source.page_id],
      skill_pages: owners,
      keep_source: null,
      actions,
      summary: {
        source_id: source.source_id,
        source_name: source.name,
        location: source.adapter,
        skills: selected.map((row) => ({
          page_id: rowId(row),
          name: text(property(propertiesById(row)[library.skills.property_ids.Name!]).title),
        })),
        counts: {
          skills: selected.length,
          files: files.length,
          records: records.length,
          sources: 1,
        },
        shared_records_preserved: sharedRecords,
        deletion: "Notion Trash, not permanent erasure",
        input_bodies_read: false,
      },
    })
  })
}

function grouping(definition: SourceDefinition) {
  return canonicalSharedJson({
    adapter: definition.adapter,
    enabled: definition.enabled,
    policy: definition.policy,
    options: definition.options,
    include: definition.selection.include,
    exclude: definition.selection.exclude,
    mapping: definition.selection.mapping,
  })
}
export function prepareSourceConsolidation(
  library: SharedLibrary,
  selector: string,
  name?: string,
) {
  return Effect.gen(function* () {
    const keep = yield* readSourceDefinition(library, selector)
    const label = name ?? keep.name
    if (!label.trim() || label.length > 200 || /[\p{Cc}\p{Cs}]/u.test(label))
      return yield* Effect.fail(
        fail("SOURCE_DEFINITION_INVALID", "Use a nonblank display name of at most 200 characters."),
      )
    const candidates = yield* listSourceDefinitions(library)
    const definitions = [keep]
    for (const candidate of candidates) {
      if (candidate.page_id === keep.page_id || candidate.provider !== keep.adapter.type) continue
      const location =
        keep.adapter.type === "git" || keep.adapter.type === "github-market"
          ? keep.adapter.url
          : undefined
      if (location === undefined || candidate.location !== location) continue
      const found = yield* readSourceDefinition(library, candidate.page_id)
      if (grouping(found) === grouping(keep)) definitions.push(found)
    }
    const sourcePages = definitions.map((definition) => definition.page_id).sort(),
      selected = new Set(sourcePages)
    const roots = [
      ...new Set(definitions.flatMap((definition) => definition.selection.roots)),
    ].sort()
    const skills = (yield* queryManagementRows(library, "skills")).filter((row) =>
      ids(library, "skills", row, "Origin").some((id) => selected.has(id)),
    )
    const members = new Set<string>()
    for (const row of skills) {
      const member = text(
        property(propertiesById(row)[library.skills.property_ids["Source Member"]!]).rich_text,
      )
      if (ids(library, "skills", row, "Origin").length !== 1 || !member || members.has(member))
        return yield* Effect.fail(
          fail(
            "SOURCE_CONSOLIDATION_CONFLICT",
            "Ambiguous origin or duplicate member bindings cannot be merged.",
            { page_id: rowId(row), member },
          ),
        )
      members.add(member)
    }
    const records = yield* queryManagementRows(
      library,
      "records",
      relatedFilter(library, "records", [], sourcePages),
    )
    const actions: ManagementAction[] = []
    const sourceRow = yield* readCompletePage(library, "sources", keep.page_id)
    const sourceIds = tableFor(library, "sources").property_ids
    const fields = {
      [sourceIds.Name!]: { title: sourceRich(label) },
      [sourceIds.Selection!]: {
        rich_text: sourceRich(canonicalSharedJson({ ...keep.selection, roots })),
      },
    }
    if (
      !same(
        shape(library, "sources", sourceRow)[sourceIds.Name!],
        observedField(fields[sourceIds.Name!]),
      ) ||
      !same(
        shape(library, "sources", sourceRow)[sourceIds.Selection!],
        observedField(fields[sourceIds.Selection!]),
      )
    )
      actions.push(action(library, "sources", sourceRow, fields))
    for (const row of skills)
      if (!same(ids(library, "skills", row, "Origin"), [keep.page_id]))
        actions.push(
          action(library, "skills", row, {
            [library.skills.property_ids.Origin!]: relation([keep.page_id]),
          }),
        )
    for (const row of records) {
      const old = ids(library, "records", row, "Origin"),
        next = [...new Set(old.map((id) => (selected.has(id) ? keep.page_id : id)))].sort()
      if (!same(old, next))
        actions.push(
          action(library, "records", row, {
            [library.records.property_ids.Origin!]: relation(next),
          }),
        )
    }
    for (const definition of definitions)
      if (definition.page_id !== keep.page_id)
        actions.push(
          action(
            library,
            "sources",
            yield* readCompletePage(library, "sources", definition.page_id),
          ),
        )
    return yield* savePlan(library, {
      kind: "consolidate_sources",
      source_pages: sourcePages,
      skill_pages: skills.map(rowId),
      keep_source: keep.page_id,
      actions,
      summary: {
        canonical_source_id: keep.source_id,
        name: label,
        source_count_before: definitions.length,
        roots,
        bound_skills: skills.length,
        origin_records: records.length,
        selected_versions_changed: false,
        bodies_changed: false,
        independent_configurations: "different provider/ref/policy/options/filter are not merged",
      },
    })
  })
}

export function readLibraryManagementPlan(library: SharedLibrary, id: string) {
  return Effect.gen(function* () {
    if (!/^library-manage-[a-f0-9]{64}$/u.test(id))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Use the exact returned management operation ID."),
      )
    const scope = yield* authScope
    const plan = yield* (yield* Store).readJson(
      `operations/library-management/${scope}/${id}.json`,
      Plan,
    )
    if (!plan)
      return yield* Effect.fail(
        fail(
          "LIBRARY_MANAGEMENT_NOT_FOUND",
          "The original plan is unavailable in this account's Store.",
        ),
      )
    const { operation_id, ...fields } = plan
    if (
      operation_id !== id ||
      plan.scope !== scope ||
      plan.library_id !== library.library_id ||
      plan.entry !== library.skills.database_id ||
      id !== "library-manage-" + (yield* sha256(canonicalSharedJson(fields)))
    )
      return yield* Effect.fail(
        fail("LIBRARY_MANAGEMENT_SCOPE", "The retained plan identity or library changed."),
      )
    return plan
  })
}
function satisfied(action: ManagementAction, row: Record<string, unknown>) {
  if (action.kind === "trash") return row.in_trash === true
  if (row.in_trash === true) return false
  const current = propertiesById(row)
  return Object.entries(action.before).every(([id, before]) =>
    same(
      observedField(current[id]),
      Object.hasOwn(action.properties, id) ? observedField(action.properties[id]) : before,
    ),
  )
}
export function executeLibraryManagement(
  library: SharedLibrary,
  original: LibraryManagementPlan,
  dryRun = false,
) {
  return Effect.gen(function* () {
    const plan = yield* readLibraryManagementPlan(library, original.operation_id)
    const route = plan.kind === "remove_source" ? "remove" : "consolidate"
    const next = {
      argv: [
        "ntn-skills",
        "ctl",
        "library",
        "sources",
        route,
        "--operation",
        plan.operation_id,
        "--entry",
        plan.entry,
      ],
      read_only: false,
    }
    if (dryRun)
      return {
        status: "planned" as const,
        dry_run: true,
        operation_id: plan.operation_id,
        summary: plan.summary,
        actions: plan.actions.map(({ before: _before, ...action }) => action),
        remote_writes: 0,
        next,
      }
    yield* invalidateSubscriptionCatalog(plan.scope, library.skills.database_id)
    const api = yield* Notion,
      store = yield* Store
    const invalidateCurrent = (change: ManagementAction) =>
      Effect.gen(function* () {
        if (change.table !== "skills") return
        const identity = property(change.before[library.skills.property_ids["Skill ID"]!]).rich_text
        if (typeof identity !== "string" || !identity)
          return yield* Effect.fail(
            fail("LIBRARY_MANAGEMENT_INVALID", "A managed Skill lacks its frozen stable identity."),
          )
        // Retire only current observations, not immutable pins or resource bytes.
        yield* invalidateSnapshotCache(sharedSkillId(library.library_id, identity), plan.scope)
      })
    const namespace = yield* sha256(
      canonicalSharedJson([
        yield* api.credentialIdentity,
        library.library_id,
        library.sources?.data_source_id ?? null,
      ]),
    )
    let acknowledgedAll = plan.actions.length > 0
    for (const change of plan.actions) {
      const body = change.kind === "trash" ? { in_trash: true } : { properties: change.properties }
      const request = {
        identity: `${plan.operation_id}:${change.page_id}`,
        path: `v1/pages/${change.page_id}`,
        method: "PATCH",
        body,
      }
      const operation = "source-op-" + (yield* sha256(canonicalSharedJson(request)))
      const ack = yield* store.readJson(
        `operations/shared-sources/${namespace}/source-ack-${operation.slice("source-op-".length)}.json`,
        SourceMutationAcknowledgementSchema,
      )
      if (ack === undefined) {
        acknowledgedAll = false
        break
      }
      if (
        ack.operation_id !== operation ||
        ack.request_hash !==
          (yield* sha256(canonicalSharedJson({ version: 1, operation, ...request }))) ||
        ack.response_hash !== (yield* sha256(canonicalSharedJson(ack.response))) ||
        property(ack.response).id !== change.page_id ||
        !satisfied(change, property(ack.response))
      )
        return yield* Effect.fail(
          fail(
            "LIBRARY_MANAGEMENT_INVALID",
            "An original action acknowledgement differs from its exact request.",
            { page_id: change.page_id },
          ),
        )
    }
    if (acknowledgedAll) {
      // Repeat/recovery after all writes uses the existing exact ACKs and one
      // complete metadata census, instead of fetching hundreds of trashed pages.
      const active = new Map<string, Record<string, unknown>>()
      for (const table of [...new Set(plan.actions.map((change) => change.table))])
        for (const row of yield* queryManagementRows(library, table)) active.set(rowId(row), row)
      if (plan.kind === "remove_source") {
        const removedSkills = new Set(plan.skill_pages),
          removedSources = new Set(plan.source_pages)
        for (const row of active.values()) {
          const table = tables.find(
            (value) => library[value]?.data_source_id === property(row.parent).data_source_id,
          )
          const lingering =
            table === "skills"
              ? ids(library, table, row, "Origin").some((id) => removedSources.has(id)) ||
                ["Members", "Requires"].some((name) =>
                  ids(library, table, row, name).some((id) => removedSkills.has(id)),
                )
              : table === "files" || table === "records"
                ? ids(library, table, row, "Skill").some((id) => removedSkills.has(id)) ||
                  (table === "records" &&
                    ids(library, table, row, "Origin").some((id) => removedSources.has(id)))
                : false
          if (lingering)
            return yield* Effect.fail(
              fail(
                "LIBRARY_MANAGEMENT_CHANGED",
                "A live relation was added after the original removal; it is not part of the authorized operation.",
                { page_id: rowId(row), next },
              ),
            )
        }
      }
      if (
        plan.actions.every((change) =>
          change.kind === "trash"
            ? !active.has(change.page_id)
            : active.has(change.page_id) && satisfied(change, active.get(change.page_id)!),
        )
      ) {
        for (const change of plan.actions) yield* invalidateCurrent(change)
        return {
          status: "unchanged" as const,
          verified: true,
          operation_id: plan.operation_id,
          summary: plan.summary,
          results: plan.actions.map((change) => ({
            page_id: change.page_id,
            table: change.table,
            kind: change.kind,
            verified: true,
          })),
          writes_dispatched: 0,
          reused: plan.actions.length,
          bodies_changed: false,
          verification: "original_acknowledgements_and_complete_active_table_census" as const,
          deletion:
            "Absent from complete live table census after acknowledged Notion Trash; private historical pins are not revoked",
        }
      }
      return yield* Effect.fail(
        fail(
          "LIBRARY_MANAGEMENT_CHANGED",
          "The completed original operation no longer has all current effects; no write was replayed.",
          { operation_id: plan.operation_id, next },
        ),
      )
    }
    // Do not expand the selected membership after preview. A new child or an
    // outside dependency must stop deletion before its first mutation.
    const currentSkills = yield* queryManagementRows(library, "skills")
    const sourceSet = new Set(plan.source_pages),
      ownerSet = new Set(plan.skill_pages)
    for (const row of currentSkills) {
      if (
        ids(library, "skills", row, "Origin").some((id) => sourceSet.has(id)) &&
        !ownerSet.has(rowId(row))
      )
        return yield* Effect.fail(
          fail(
            "LIBRARY_MANAGEMENT_CHANGED",
            "A new source member appeared after preview; no new scope was assumed.",
            { page_id: rowId(row), next },
          ),
        )
      if (
        plan.kind === "remove_source" &&
        !ownerSet.has(rowId(row)) &&
        ids(library, "skills", row, "Requires").some((id) => ownerSet.has(id))
      )
        return yield* Effect.fail(
          fail("SOURCE_REMOVE_REQUIRED", "An outside dependency appeared after preview.", {
            page_id: rowId(row),
            next,
          }),
        )
      if (plan.kind === "remove_source" && !ownerSet.has(rowId(row))) {
        const selected = text(
          property(propertiesById(row)[library.skills.property_ids.Source!]).rich_text,
        )
        if (
          selected &&
          plan.actions.some(
            (change) =>
              change.table === "records" &&
              change.kind === "trash" &&
              property(change.before[library.records.property_ids["Entity ID"]!]).rich_text ===
                selected,
          )
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_REMOVE_SHARED_PIN",
              "An outside Skill selects a record scheduled for removal; preserve that shared version.",
              { page_id: rowId(row), next },
            ),
          )
      }
    }
    const census = new Map(currentSkills.map((row) => [rowId(row), row]))
    if (plan.kind === "remove_source") {
      const known = new Set(plan.actions.map((change) => change.page_id))
      for (const [table, rows] of [
        [
          "files",
          plan.skill_pages.length
            ? yield* queryManagementRows(
                library,
                "files",
                relatedFilter(library, "files", plan.skill_pages),
              )
            : [],
        ],
        [
          "records",
          yield* queryManagementRows(
            library,
            "records",
            relatedFilter(library, "records", plan.skill_pages, plan.source_pages),
          ),
        ],
      ] as const)
        for (const row of rows) {
          if (!known.has(rowId(row)))
            return yield* Effect.fail(
              fail(
                "LIBRARY_MANAGEMENT_CHANGED",
                "A new related row appeared after preview; it is not silently deleted.",
                { table, page_id: rowId(row), next },
              ),
            )
          census.set(rowId(row), row)
        }
    }
    // Preflight every remaining step together, before changing any page.
    for (const change of plan.actions) {
      const row =
        census.get(change.page_id) ??
        (yield* readCompletePage(library, change.table, change.page_id))
      if (
        !satisfied(change, row) &&
        (row.in_trash === true || !same(shape(library, change.table, row), change.before))
      )
        return yield* Effect.fail(
          fail(
            "LIBRARY_MANAGEMENT_CHANGED",
            "A frozen page changed after preview; no new action was sent.",
            { page_id: change.page_id, next },
          ),
        )
    }
    let writes = 0,
      reused = 0
    const perform = (change: ManagementAction) =>
      Effect.gen(function* () {
        const before = yield* readCompletePage(library, change.table, change.page_id)
        if (satisfied(change, before)) {
          reused++
          yield* invalidateCurrent(change)
          return
        }
        if (before.in_trash === true || !same(shape(library, change.table, before), change.before))
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_CHANGED",
              "The exact selected page changed. Completed work remains; no replacement plan was invented.",
              { operation_id: plan.operation_id, page_id: change.page_id, next },
            ),
          )
        const body =
          change.kind === "trash" ? { in_trash: true } : { properties: change.properties }
        const observed = Effect.gen(function* () {
          const row = yield* readCompletePage(library, change.table, change.page_id)
          return satisfied(change, row)
            ? { page_id: change.page_id, current_effect_verified: true }
            : undefined
        })
        const result = yield* guardedSourceMutation(
          library,
          {
            identity: `${plan.operation_id}:${change.page_id}`,
            path: `v1/pages/${change.page_id}`,
            method: "PATCH",
            body,
            repeat: "never",
            observeAcknowledged: (response) =>
              Effect.gen(function* () {
                const row = property(response)
                if (
                  row.object === "page" &&
                  row.id === change.page_id &&
                  property(row.parent).data_source_id ===
                    tableFor(library, change.table).data_source_id &&
                  satisfied(change, row)
                )
                  return { page_id: change.page_id, current_effect_verified: true }
                return yield* observed
              }),
          },
          observed,
        )
        if (result.status !== "applied" && result.status !== "observed_current")
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_UNRESOLVED",
              "The original metadata mutation has no verified current effect.",
              { operation_id: plan.operation_id, page_id: change.page_id, next },
            ),
          )
        writes += Number(result.status === "applied")
        yield* invalidateCurrent(change)
      })
    // Keep dependency order across tables, using the existing request limiter
    // for independent pages inside each contiguous table group.
    for (let index = 0; index < plan.actions.length; ) {
      const group = [plan.actions[index++]!]
      while (index < plan.actions.length && plan.actions[index]!.table === group[0]!.table)
        group.push(plan.actions[index++]!)
      if (group[0]!.table === "sources" && group.every((change) => change.kind === "trash")) {
        const retired = group.map((change) => change.page_id)
        for (const table of ["skills", "records"] as const) {
          const filter = {
            or: retired.map((id) => ({
              property: library[table].property_ids.Origin,
              relation: { contains: id },
            })),
          }
          const remaining = yield* queryManagementRows(library, table, filter)
          if (remaining.length)
            return yield* Effect.fail(
              fail(
                "LIBRARY_MANAGEMENT_CHANGED",
                "A Source still has live related rows; it was not trashed.",
                { table, pages: remaining.map(rowId), next },
              ),
            )
        }
      }
      const outcomes = yield* Effect.forEach(
        group,
        (change) => perform(change).pipe(Effect.result),
        { concurrency: 3 },
      )
      const failure = outcomes.find((result) => result._tag === "Failure")
      if (failure?._tag === "Failure")
        return yield* Effect.fail(
          fail(failure.failure.code, failure.failure.message, {
            ...property(failure.failure.details),
            operation_id: plan.operation_id,
            next,
          }),
        )
    }
    const finalActive = new Map<string, Record<string, unknown>>()
    const finalSkills = yield* queryManagementRows(library, "skills")
    for (const row of finalSkills) {
      finalActive.set(rowId(row), row)
      if (
        plan.kind === "remove_source" &&
        ids(library, "skills", row, "Origin").some((id) => sourceSet.has(id))
      )
        return yield* Effect.fail(
          fail("LIBRARY_MANAGEMENT_CHANGED", "The final source membership is not empty.", {
            page_id: rowId(row),
            next,
          }),
        )
    }
    for (const table of ["files", "records"] as const) {
      if (table === "files" && !plan.skill_pages.length) continue
      const rows = yield* queryManagementRows(
        library,
        table,
        relatedFilter(
          library,
          table,
          plan.skill_pages,
          table === "records" ? plan.source_pages : [],
        ),
      )
      for (const row of rows) {
        finalActive.set(rowId(row), row)
        if (plan.kind === "remove_source")
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_CHANGED",
              "A final related row still refers to the removed scope.",
              { table, page_id: rowId(row), next },
            ),
          )
      }
    }
    const final = []
    for (const change of plan.actions) {
      const current = finalActive.get(change.page_id)
      // Every trash step already has a verified exact page response or GET.
      // The independent final table census checks that it did not reappear.
      if (change.kind === "trash" && change.table !== "sources") {
        if (current !== undefined)
          return yield* Effect.fail(
            fail("LIBRARY_MANAGEMENT_CHANGED", "A trashed selected row is active again.", {
              page_id: change.page_id,
              next,
            }),
          )
      } else {
        const row = current ?? (yield* readCompletePage(library, change.table, change.page_id))
        if (!satisfied(change, row))
          return yield* Effect.fail(
            fail(
              "LIBRARY_MANAGEMENT_CHANGED",
              "A selected effect no longer matches at final readback.",
              { page_id: change.page_id, operation_id: plan.operation_id, next },
            ),
          )
      }
      final.push({
        page_id: change.page_id,
        table: change.table,
        kind: change.kind,
        verified: true,
      })
    }
    return {
      status: writes ? ("applied" as const) : ("unchanged" as const),
      verified: true,
      operation_id: plan.operation_id,
      summary: plan.summary,
      results: final,
      writes_dispatched: writes,
      reused,
      bodies_changed: false,
      deletion: "Notion Trash only; historical local pins are not a permanent-erasure guarantee",
    }
  })
}
