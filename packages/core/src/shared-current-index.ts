import { Effect, Schema } from "effect"
import {
  decode,
  fail,
  listSchema,
  SkillsError,
  text,
  validateDisplayName,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { planSharedFiles } from "./shared-composition.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import {
  currentSchemaRequired,
  parseCurrentFileContent,
  parseCurrentSkillState,
  type CurrentFileContent,
  type CurrentSkillState,
} from "./shared-current-file.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export type CurrentFileBinding = {
  readonly file_id: string
  readonly page_id: string
  readonly skill_page_id: string
  readonly path: string
  readonly last_edited_time: string
  readonly content: CurrentFileContent
}
export type CurrentSkillIndex = {
  readonly skill_id: string
  readonly page_id: string
  readonly kind: "skill" | "router" | "prompt"
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly default_context: boolean
  readonly state: CurrentSkillState
  readonly main: CurrentFileBinding
  readonly files: readonly CurrentFileBinding[]
}

const fileFields = ["File ID", "Skill", "Path", "Content"] as const
type PropertyIds = Readonly<Record<string, string>>
type QueryCurrentFilesInput = {
  readonly dataSourceId: string
  readonly skillPageIds: readonly string[]
  readonly propertyIds?: PropertyIds
}
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_INDEX_INVALID", message, details)
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Current file metadata could not be decoded."),
  })

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} must be an object.`)
  return Object.fromEntries(Object.entries(value))
}
function exactPage(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)
  )
    throw invalid(`${label} must be an exact Notion page or data-source ID.`)
  const id = pageId(value)
  if (id === undefined) throw invalid(`${label} must be a Notion identity.`)
  return id
}
function identity(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value))
    throw invalid(`${label} must be a stable bounded identity.`)
  return value
}
function binding(ids: PropertyIds | undefined, name: string): string {
  const id = ids?.[name]
  if (id === undefined || id === "") throw currentSchemaRequired(name)
  if (!/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(id))
    throw invalid("A registered current property has an invalid identity.", { property: name })
  return id
}
function fileProperties(ids: PropertyIds | undefined) {
  const result = Object.fromEntries(fileFields.map((name) => [name, binding(ids, name)]))
  if (new Set(Object.values(result)).size !== fileFields.length)
    throw invalid("Current Files properties must have distinct registered identities.")
  return result
}
function field(row: Record<string, unknown>, ids: PropertyIds, name: string, type: string) {
  const id = binding(ids, name)
  const matches = Object.entries(object(row.properties, "Page properties")).flatMap(
    ([key, raw]) => {
      const value = object(raw, "Page property")
      return value.id === id || key === id ? [value] : []
    },
  )
  const selected = matches[0]
  if (matches.length === 0 && ["Content", "Current State", "Operation"].includes(name))
    throw currentSchemaRequired(name)
  if (
    matches.length !== 1 ||
    selected === undefined ||
    (selected.id !== undefined && selected.id !== id) ||
    selected.type !== type
  )
    throw invalid("A registered current property is missing, duplicated or has a different type.", {
      property: name,
    })
  return selected
}
function rich(row: Record<string, unknown>, ids: PropertyIds, name: string): string {
  const value = field(row, ids, name, "rich_text")
  if (!Array.isArray(value.rich_text) || (value.has_more !== undefined && value.has_more !== false))
    throw invalid("A current property is incomplete.", { property: name })
  for (const raw of value.rich_text) {
    const part = object(raw, "Rich text part")
    if (typeof part.plain_text === "string") continue
    if (part.type === "text" && typeof object(part.text, "Rich text").content === "string") continue
    throw invalid("A current property contains unreadable text.", { property: name })
  }
  return text(value.rich_text)
}
function editedTime(value: unknown): string {
  if (typeof value !== "string") throw invalid("A current body has no observation timestamp.")
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value)
  const timestamp = Date.parse(value)
  if (
    parts === null ||
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    new Date(timestamp).toISOString() !== `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0")}Z`
  )
    throw invalid("A current body has an invalid observation timestamp.")
  return value
}
function fileOwner(row: Record<string, unknown>, ids: PropertyIds): string {
  const owner = field(row, ids, "Skill", "relation")
  if (
    !Array.isArray(owner.relation) ||
    owner.relation.length !== 1 ||
    (owner.has_more !== undefined && owner.has_more !== false)
  )
    throw invalid("Every current File must have exactly one complete Skill relation.")
  return exactPage(object(owner.relation[0], "File owner").id, "File owner")
}

export function currentFileRecord(
  raw: unknown,
  skillId: string,
  dataSourceId: string,
  ids: PropertyIds,
): CurrentFileBinding {
  const row = object(raw, "Current File page")
  const parent = object(row.parent, "Current File parent")
  if (
    row.object !== "page" ||
    row.in_trash === true ||
    row.archived === true ||
    row.is_archived === true ||
    parent.type !== "data_source_id" ||
    exactPage(parent.data_source_id, "File data source") !== dataSourceId
  )
    throw invalid("The current Files query returned an unavailable or foreign page.")
  const owner = fileOwner(row, ids)
  if (owner !== skillId) throw invalid("A current File belongs to another Skill.")
  const file = {
    file_id: identity(rich(row, ids, "File ID"), "File ID"),
    page_id: exactPage(row.id, "File page"),
    skill_page_id: owner,
    path: rich(row, ids, "Path"),
    last_edited_time: editedTime(row.last_edited_time),
    content: parseCurrentFileContent(rich(row, ids, "Content")),
  }
  validateBindings([file], owner)
  return file
}

/** Reuse the directory validator for safe paths, portable spelling and file/directory collisions. */
function validateBindings(files: readonly CurrentFileBinding[], owner: string): void {
  const pages = new Set<string>(),
    ids = new Set<string>()
  for (const file of files) {
    if (file.skill_page_id !== owner) throw invalid("A current File belongs to another Skill.")
    if (pages.has(file.page_id)) throw invalid("Current Files repeat a physical page.")
    if (ids.has(file.file_id)) throw invalid("Current Files repeat a File ID.")
    pages.add(file.page_id)
    ids.add(file.file_id)
  }
  const entry = files[0]
  if (entry !== undefined)
    planSharedFiles({ base: files, mounts: [], overrides: [], entrypoint: entry.path })
}

/** Complete metadata for the selected owners. It never reads bodies, events or operation history. */
export function queryCurrentFilesForSkills(input: QueryCurrentFilesInput) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const { owners, dataSourceId, ids, endpoint } = yield* checked(() => {
      const owners = input.skillPageIds.map((id) => exactPage(id, "Skill owner"))
      if (owners.length === 0 || new Set(owners).size !== owners.length)
        throw invalid("Select distinct nonempty Skill owners.")
      const dataSourceId = exactPage(input.dataSourceId, "Files data source")
      const ids = fileProperties(input.propertyIds)
      const parameters = new URLSearchParams()
      for (const name of fileFields) parameters.append("filter_properties", binding(ids, name))
      return {
        owners,
        dataSourceId,
        ids,
        endpoint: `v1/data_sources/${dataSourceId}/query?${parameters}`,
      }
    })
    const result = new Map<string, CurrentFileBinding[]>(owners.map((owner) => [owner, []]))
    const pages = new Set<string>()
    for (let offset = 0; offset < owners.length; offset += 80) {
      const selected = owners.slice(offset, offset + 80)
      const filters = selected.map((owner) => ({
        property: binding(ids, "Skill"),
        relation: { contains: owner },
      }))
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const raw = yield* api.request(
          endpoint,
          {
            page_size: 100,
            filter: filters.length === 1 ? filters[0] : { or: filters },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
          { method: "POST" },
        )
        const page = yield* checked(() => {
          if (object(raw, "Current Files query").object !== "list")
            throw invalid("Current Files query did not return a complete list.")
          const list = decode(listSchema(Schema.Unknown), raw)
          if (
            (!list.has_more && list.next_cursor !== null) ||
            (list.has_more &&
              (!list.next_cursor ||
                list.next_cursor.length > 2048 ||
                cursors.has(list.next_cursor)))
          )
            throw invalid("Current Files pagination is incomplete or did not advance.")
          for (const value of list.results) {
            const owner = fileOwner(object(value, "Current File page"), ids)
            const file = currentFileRecord(value, owner, dataSourceId, ids)
            const bucket = result.get(file.skill_page_id)
            if (!selected.includes(file.skill_page_id) || bucket === undefined)
              throw invalid("Current Files query returned an unselected owner.")
            if (pages.has(file.page_id))
              throw invalid("Current Files query repeated a physical page.")
            pages.add(file.page_id)
            bucket.push(file)
          }
          return list
        })
        if (!page.has_more) break
        const next = page.next_cursor
        if (next === null)
          return yield* Effect.fail(invalid("Current Files pagination has no next cursor."))
        cursor = next
        cursors.add(next)
      }
    }
    yield* checked(() => {
      for (const [owner, files] of result) validateBindings(files, owner)
    })
    const complete: ReadonlyMap<string, readonly CurrentFileBinding[]> = result
    return complete
  })
}

/** The exact owner and main descriptor only; this makes no Files inventory claim. */
export function readCurrentSkillMetadata(
  library: SharedLibrary,
  target: string,
  suppliedPage?: unknown,
) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      for (const name of ["Content", "Current State", "Operation"])
        binding(library.skills.property_ids, name)
      for (const name of fileFields) binding(library.files.property_ids, name)
      return exactPage(target, "Skill page")
    })
    const raw =
      suppliedPage === undefined
        ? yield* (yield* Notion).request(`v1/pages/${selected}`)
        : suppliedPage
    const metadata = yield* checked(() => {
      const row = object(raw, "Current Skill page")
      const source: Source = {
        alias: library.library_id,
        database_id: library.skills.database_id,
        data_source_ids: [library.skills.data_source_id],
        title: "",
        role: "content",
        shared_library: library,
      }
      const record = sharedRecordFromPage(raw, source, library.skills.data_source_id)
      if (row.object !== "page" || record.locator.page_id !== selected)
        throw invalid("The selected current Skill differs from its page binding.")
      const stateField = field(row, library.skills.property_ids, "Current State", "select")
      const stateName =
        stateField.select === null ? "" : object(stateField.select, "Current State").name
      if (typeof stateName !== "string") throw invalid("Current State must be a named selection.")
      return {
        skill_id: record.locator.skill_id,
        page_id: selected,
        kind: record.kind,
        name: validateDisplayName(record.name),
        description: record.description,
        enabled: record.enabled,
        default_context: record.default_context,
        state: parseCurrentSkillState(
          stateName,
          rich(row, library.skills.property_ids, "Operation"),
        ),
        main: {
          file_id: identity(rich(row, library.skills.property_ids, "Main File ID"), "Main File ID"),
          page_id: selected,
          skill_page_id: selected,
          path: record.entrypoint,
          last_edited_time: editedTime(row.last_edited_time),
          content: parseCurrentFileContent(rich(row, library.skills.property_ids, "Content")),
        },
      }
    })
    return metadata satisfies Omit<CurrentSkillIndex, "files">
  })
}

/** Main content lives on Skills. Its descriptor uses exactly the supporting-file union. */
export function queryCurrentSkillIndex(
  library: SharedLibrary,
  target: string,
  suppliedPage?: unknown,
  suppliedFiles?: readonly CurrentFileBinding[],
) {
  return Effect.gen(function* () {
    const metadata = yield* readCurrentSkillMetadata(library, target, suppliedPage)
    const selected = metadata.page_id
    let files = suppliedFiles
    if (files === undefined) {
      files = (yield* queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        skillPageIds: [selected],
        propertyIds: library.files.property_ids,
      })).get(selected)
      if (files === undefined)
        return yield* Effect.fail(invalid("The selected current Files inventory is incomplete."))
    }
    yield* checked(() => validateBindings([metadata.main, ...files], selected))
    return { ...metadata, files } satisfies CurrentSkillIndex
  })
}

/** Complete current library metadata for relationship retirement. Files are
 * enumerated independently, so an orphan or a missing Origin cannot disappear
 * behind an owner filter. No file bodies or resource bytes are fetched. */
export function queryCurrentLibraryIndex(library: SharedLibrary) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const enumerate = (dataSourceId: string, properties: readonly string[] = []) =>
      Effect.gen(function* () {
        const selected = yield* checked(() => exactPage(dataSourceId, "Data source"))
        const parameters = new URLSearchParams()
        for (const id of properties) parameters.append("filter_properties", id)
        const endpoint = `v1/data_sources/${selected}/query${properties.length ? `?${parameters}` : ""}`
        const pages = new Map<string, unknown>(),
          cursors = new Set<string>()
        let cursor: string | undefined
        for (;;) {
          const raw = yield* api.request(
            endpoint,
            {
              page_size: 100,
              ...(cursor === undefined ? {} : { start_cursor: cursor }),
            },
            { method: "POST" },
          )
          const result = yield* checked(() => {
            const envelope = object(raw, "Current library query")
            if (
              envelope.object !== "list" ||
              (envelope.request_status !== undefined &&
                object(envelope.request_status, "Query status").type !== "complete")
            )
              throw invalid("The current library metadata query is incomplete.")
            const list = decode(listSchema(Schema.Unknown), raw)
            if (
              list.has_more
                ? !list.next_cursor ||
                  list.next_cursor.length > 2048 ||
                  cursors.has(list.next_cursor)
                : list.next_cursor !== null
            )
              throw invalid("Current library pagination did not finish or advance.")
            for (const value of list.results) {
              const row = object(value, "Current library page")
              const parent = object(row.parent, "Current library parent")
              const page = exactPage(row.id, "Current page")
              if (
                row.object !== "page" ||
                row.in_trash === true ||
                row.archived === true ||
                row.is_archived === true ||
                parent.type !== "data_source_id" ||
                exactPage(parent.data_source_id, "Current parent") !== selected ||
                pages.has(page)
              )
                throw invalid(
                  "Current library metadata contains a foreign, unavailable or repeated page.",
                  { page_id: page },
                )
              pages.set(page, value)
            }
            return list
          })
          if (!result.has_more) break
          cursor = result.next_cursor!
          cursors.add(cursor)
        }
        return pages
      })
    const pages = yield* enumerate(library.skills.data_source_id)
    const ids = yield* checked(() => fileProperties(library.files.property_ids))
    const filesDataSourceId = yield* checked(() =>
      exactPage(library.files.data_source_id, "Files data source"),
    )
    const filePages = yield* enumerate(filesDataSourceId, Object.values(ids))
    const files = new Map<string, CurrentFileBinding[]>([...pages.keys()].map((page) => [page, []]))
    for (const [page, raw] of filePages) {
      const file = yield* checked(() => {
        const owner = fileOwner(object(raw, "Current File page"), ids)
        if (!pages.has(owner))
          throw invalid("A current File has no available owner in this library.", {
            page_id: page,
            skill_page_id: owner,
          })
        return currentFileRecord(raw, owner, filesDataSourceId, ids)
      })
      files.get(file.skill_page_id)!.push(file)
    }
    const skills = new Map<string, CurrentSkillIndex>()
    for (const [page, raw] of pages) {
      const index = yield* queryCurrentSkillIndex(library, page, raw, files.get(page)!)
      if (skills.has(index.skill_id))
        return yield* Effect.fail(
          invalid("Several current Skills claim the same stable identity.", {
            skill_id: index.skill_id,
          }),
        )
      skills.set(index.skill_id, index)
    }
    return { skills, pages }
  })
}
