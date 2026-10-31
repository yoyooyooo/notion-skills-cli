import { Crypto, Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"

import {
  LIBRARY_MARKER,
  SharedLibrarySchema,
  type SharedLibrary,
  type TableBinding,
} from "./shared-library-model.ts"
export {
  LIBRARY_MARKER,
  SharedLibrarySchema,
  TableBindingSchema,
  type SharedLibrary,
  type TableBinding,
} from "./shared-library-model.ts"

const checked = <A>(fn: () => A) =>
  Effect.try({
    try: fn,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("LIBRARY_INVALID", "Invalid shared library response."),
  })
const rich = { rich_text: {} }
const select = (names: readonly string[]) => ({
  select: { options: names.map((name) => ({ name })) },
})
const title = (content: string) => [{ type: "text", text: { content } }]
export const sharedSkillProperties = {
  Name: { title: {} },
  Description: rich,
  Kind: select(["skill", "router", "prompt"]),
  Tags: { multi_select: { options: [] } },
  Enabled: { checkbox: {} },
  "Default Context": { checkbox: {} },
  References: rich,
  "Skill ID": rich,
  "Main File ID": rich,
  Projection: rich,
  Source: rich,
}
const sharedMembersProperty = (skillsDataSourceId: string) => ({
  relation: { data_source_id: skillsDataSourceId, single_property: {} },
})
function registeredSkillProperties(skills: TableBinding) {
  return skills.property_ids.Members === undefined
    ? sharedSkillProperties
    : { ...sharedSkillProperties, Members: sharedMembersProperty(skills.data_source_id) }
}
export const sharedFileProperties = (skillsDataSourceId: string) => ({
  Name: { title: {} },
  "File ID": rich,
  Path: rich,
  Projection: rich,
  Status: select(["following", "custom", "tombstone"]),
  Skill: { relation: { data_source_id: skillsDataSourceId, dual_property: {} } },
})
export const sharedRecordProperties = (skillsDataSourceId: string) => ({
  Name: { title: {} },
  "Record ID": rich,
  Kind: select(["file_event", "object", "source", "snapshot", "profile", "operation"]),
  "Entity ID": rich,
  Hash: rich,
  Payload: rich,
  Skill: { relation: { data_source_id: skillsDataSourceId, single_property: {} } },
})

function exactId(value: string): string {
  const id = pageId(value)
  if (!id) throw fail("INVALID_ARGUMENT", "Use an exact Notion page or database ID.")
  return id
}

export function libraryFromDatabase(raw: unknown): SharedLibrary | undefined {
  const value = property(raw),
    description = text(value.description)
  if (!description.startsWith(LIBRARY_MARKER)) return undefined
  const library = decode(SharedLibrarySchema, JSON.parse(description.slice(LIBRARY_MARKER.length)))
  if (value.in_trash === true || value.id !== library.skills.database_id)
    throw fail(
      "LIBRARY_INVALID",
      "The library entry does not match its registered Skills database.",
    )
  exactId(library.parent_page_id)
  if (
    !/^library-[a-zA-Z0-9-]{1,80}$/.test(library.library_id) ||
    !/^library-[a-zA-Z0-9-]{1,80}$/.test(library.operation_id)
  )
    throw fail("LIBRARY_INVALID", "The library has an invalid initialization identity.")
  for (const [table, expected] of [
    [library.skills, registeredSkillProperties(library.skills)],
    [library.files, sharedFileProperties(library.skills.data_source_id)],
    [library.records, sharedRecordProperties(library.skills.data_source_id)],
  ] as const) {
    exactId(table.database_id)
    exactId(table.data_source_id)
    if (table.property_ids.Name !== "title")
      throw fail("LIBRARY_INVALID", "A shared table has no stable title binding.")
    const ids = Object.keys(expected).map((name) => table.property_ids[name])
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
      throw fail("LIBRARY_INVALID", "A shared table has missing or overlapping property bindings.")
  }
  const members = library.skills.property_ids.Members
  if (
    members !== undefined &&
    (!/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(members) ||
      Object.entries(library.skills.property_ids).some(
        ([name, id]) => name !== "Members" && id === members,
      ))
  )
    throw fail(
      "LIBRARY_INVALID",
      "The optional Members binding is not a unique stable property identity.",
    )
  if (
    new Set([library.skills.database_id, library.files.database_id, library.records.database_id])
      .size !== 3 ||
    new Set([
      library.skills.data_source_id,
      library.files.data_source_id,
      library.records.data_source_id,
    ]).size !== 3
  )
    throw fail("LIBRARY_INVALID", "Shared table identities overlap.")
  return library
}

export function loadSharedLibrary(entry: string) {
  return Effect.gen(function* () {
    const id = yield* checked(() => exactId(entry))
    const raw = yield* (yield* Notion).request(`v1/databases/${id}`)
    const library = yield* checked(() => libraryFromDatabase(raw))
    if (!library)
      return yield* Effect.fail(
        fail("NOT_SHARED_LIBRARY", "The selected entry is not a registered shared library."),
      )
    return library
  })
}

function validateMembersField(value: unknown, skillsDataSourceId: string): string {
  const field = property(value)
  const relation = property(field.relation)
  const mode = relation.type
  if (
    field.type !== "relation" ||
    typeof field.id !== "string" ||
    !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(field.id) ||
    relation.data_source_id !== skillsDataSourceId ||
    (mode !== "single_property" && mode !== "dual_property") ||
    typeof relation[mode] !== "object" ||
    relation[mode] === null ||
    Array.isArray(relation[mode])
  )
    throw fail(
      "LIBRARY_SCHEMA_CONFLICT",
      "Members must be a registered native relation to this same Skills data source.",
    )
  return field.id
}

function inspectTable(
  id: string,
  expected: Readonly<Record<string, unknown>>,
  expectedParent: string,
  registered?: TableBinding,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const db = property(yield* api.request(`v1/databases/${id}`))
    const sources = db.data_sources
    if (
      db.id !== id ||
      db.in_trash === true ||
      property(db.parent).page_id !== expectedParent ||
      !Array.isArray(sources) ||
      sources.length !== 1
    )
      return yield* Effect.fail(
        fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "The table has an unexpected parent or data-source identity.",
        ),
      )
    const dataSourceId = property(sources[0]).id
    if (typeof dataSourceId !== "string")
      return yield* Effect.fail(fail("LIBRARY_INVALID", "Missing table data source."))
    if (registered && dataSourceId !== registered.data_source_id)
      return yield* Effect.fail(
        fail("LIBRARY_SCHEMA_CONFLICT", "The registered data source was replaced."),
      )
    const ds = property(yield* api.request(`v1/data_sources/${dataSourceId}`))
    if (ds.id !== dataSourceId || ds.in_trash === true || property(ds.parent).database_id !== id)
      return yield* Effect.fail(
        fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "Data source ownership differs from its registered database.",
        ),
      )
    const fields = property(ds.properties),
      ids: Record<string, string> = {}
    for (const [name, expectedValue] of Object.entries(expected)) {
      const candidates = registered
        ? Object.values(fields).filter(
            (field) => property(field).id === registered.property_ids[name],
          )
        : [fields[name]]
      if (candidates.length !== 1)
        return yield* Effect.fail(
          fail("LIBRARY_SCHEMA_CONFLICT", "A registered property is missing or duplicated.", {
            database_id: id,
            property: name,
          }),
        )
      const actual = property(candidates[0]),
        shape = property(expectedValue)
      const type = Object.keys(shape)[0]
      if (actual.type !== type || typeof actual.id !== "string")
        return yield* Effect.fail(
          fail("LIBRARY_SCHEMA_CONFLICT", "A shared table property has the wrong type.", {
            database_id: id,
            property: name,
          }),
        )
      if (
        type === "relation" &&
        property(actual.relation).data_source_id !== property(shape.relation).data_source_id
      )
        return yield* Effect.fail(
          fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "A file or record relation targets a different Skills table.",
          ),
        )
      if (name === "Members") yield* checked(() => validateMembersField(actual, dataSourceId))
      ids[name] = actual.id
    }
    return {
      database_id: id,
      data_source_id: dataSourceId,
      property_ids: ids,
    } satisfies TableBinding
  })
}

function inspectLibrary(library: SharedLibrary) {
  return Effect.gen(function* () {
    yield* inspectTable(
      library.skills.database_id,
      registeredSkillProperties(library.skills),
      library.parent_page_id,
      library.skills,
    )
    yield* inspectTable(
      library.files.database_id,
      sharedFileProperties(library.skills.data_source_id),
      library.parent_page_id,
      library.files,
    )
    yield* inspectTable(
      library.records.database_id,
      sharedRecordProperties(library.skills.data_source_id),
      library.parent_page_id,
      library.records,
    )
    return library
  })
}

/** New libraries alone add Members; recovery observes the original schema without a PATCH. */
function initializeMembers(
  skills: TableBinding,
  parent: string,
  operation: string,
  reconcile: boolean,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const details = {
      operation_id: operation,
      parent_page_id: parent,
      role: "Skills",
      stage: "members",
      database_id: skills.database_id,
      data_source_id: skills.data_source_id,
    }
    const before = property(yield* api.request(`v1/data_sources/${skills.data_source_id}`))
    if (
      before.id !== skills.data_source_id ||
      before.in_trash === true ||
      property(before.parent).database_id !== skills.database_id
    )
      return yield* Effect.fail(
        fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "Members initialization observed a different data-source owner.",
          details,
        ),
      )
    const existing = property(before.properties).Members
    if (reconcile) {
      if (existing === undefined)
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_INCOMPLETE",
            "The original Members schema write is not visible. Missing schema is not permission to repeat its PATCH.",
            details,
          ),
        )
      const membersId = yield* checked(() => validateMembersField(existing, skills.data_source_id))
      return { ...skills, property_ids: { ...skills.property_ids, Members: membersId } }
    }
    if (existing !== undefined)
      return yield* Effect.fail(
        fail(
          "LIBRARY_SCHEMA_CONFLICT",
          "An unexpected Members property already exists on the new table; preserve it instead of overwriting its schema.",
          details,
        ),
      )
    const response = yield* api
      .request(
        `v1/data_sources/${skills.data_source_id}`,
        { properties: { Members: sharedMembersProperty(skills.data_source_id) } },
        { method: "PATCH" },
      )
      .pipe(
        Effect.mapError((error) =>
          fail(error.code, error.message, { ...property(error.details), ...details }),
        ),
      )
    const membersId = yield* checked(() => {
      const after = property(response)
      if (
        after.id !== skills.data_source_id ||
        after.in_trash === true ||
        property(after.parent).database_id !== skills.database_id
      )
        throw fail(
          "LIBRARY_INIT_UNKNOWN",
          "Members creation returned no confirmed data-source identity.",
          details,
        )
      return validateMembersField(property(after.properties).Members, skills.data_source_id)
    }).pipe(
      Effect.mapError((error) =>
        fail(
          "LIBRARY_INIT_UNKNOWN",
          "The acknowledged Members schema was not confirmed; preserve the original operation.",
          { ...details, cause_code: error.code },
        ),
      ),
    )
    const registered = { ...skills, property_ids: { ...skills.property_ids, Members: membersId } }
    return yield* inspectTable(
      skills.database_id,
      registeredSkillProperties(registered),
      parent,
      registered,
    ).pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          ...details,
          members_property_id: membersId,
        }),
      ),
    )
  })
}

function ownedTables(parent: string, operation?: string) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      found = new Map<string, string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const raw = property(
        yield* api.request(
          `v1/blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      const page = yield* checked(() => decode(listSchema(Schema.Unknown), raw))
      for (const item of page.results) {
        const row = property(item),
          label = property(row.child_database).title
        if (
          row.type !== "child_database" ||
          typeof label !== "string" ||
          typeof row.id !== "string"
        )
          continue
        if (operation === undefined) {
          found.set(row.id, label)
          continue
        }
        for (const role of ["Skills", "Files", "Records"]) {
          if (label !== `${role} [${operation}]`) continue
          if (found.has(role))
            return yield* Effect.fail(
              fail(
                "LIBRARY_INIT_CONFLICT",
                "Multiple tables claim one initialization operation; preserve all candidates.",
                { operation_id: operation, role },
              ),
            )
          found.set(role, row.id)
        }
      }
      if (!page.has_more) break
      if (!page.next_cursor || cursors.has(page.next_cursor))
        return yield* Effect.fail(
          fail("LIBRARY_DISCOVERY_INCOMPLETE", "Missing or repeating initialization cursor."),
        )
      cursor = page.next_cursor
      cursors.add(cursor)
    } while (cursor)
    return found
  })
}

/** Create-only initialization. Existing table descriptions are never guessed or overwritten. */
export function initializeSharedLibrary(input: {
  readonly parent?: string
  readonly entry?: string
  readonly operation?: string
}) {
  return Effect.gen(function* () {
    if (input.entry !== undefined) {
      if (input.parent !== undefined || input.operation !== undefined)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use --entry alone to attach an existing library."),
        )
      const library = yield* loadSharedLibrary(input.entry)
      yield* inspectLibrary(library)
      return { library, reused: true }
    }
    const selectedParent = input.parent
    if (!selectedParent)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact parent page or an existing library entry."),
      )
    const parent = yield* checked(() => exactId(selectedParent))
    const crypto = yield* Crypto.Crypto
    const operation = input.operation ?? `library-${yield* crypto.randomUUIDv4()}`
    if (!/^library-[a-zA-Z0-9-]{1,80}$/.test(operation))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid library operation identity."))
    const api = yield* Notion
    if (input.operation === undefined) {
      const children = yield* ownedTables(parent)
      const libraries: SharedLibrary[] = []
      const unfinished: string[] = []
      for (const [id, name] of children) {
        const raw = yield* api.request(`v1/databases/${id}`)
        const library = yield* checked(() => libraryFromDatabase(raw))
        if (library) libraries.push(library)
        else if (/^(Skills|Files|Records) \[library-[a-zA-Z0-9-]+\]$/.test(name))
          unfinished.push(id)
      }
      if (libraries.length > 1)
        return yield* Effect.fail(
          fail(
            "LIBRARY_AMBIGUOUS",
            "Several shared libraries exist under this parent; attach an exact entry.",
            { entries: libraries.map((library) => library.skills.database_id) },
          ),
        )
      const existing = libraries[0]
      if (existing) {
        if (existing.parent_page_id !== parent)
          return yield* Effect.fail(
            fail(
              "LIBRARY_SCHEMA_CONFLICT",
              "The library entry belongs to a different initialization parent.",
            ),
          )
        yield* inspectLibrary(existing)
        return { library: existing, reused: true }
      }
      if (unfinished.length)
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_INCOMPLETE",
            "An unfinished initialization already owns tables here. Preserve it and inspect its original operation before creating another library.",
            { tables: unfinished },
          ),
        )
    }
    const found = yield* ownedTables(parent, operation)
    if (
      input.operation !== undefined &&
      ["Skills", "Files", "Records"].some((role) => !found.has(role))
    )
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_INCOMPLETE",
          "Recovery cannot prove all table creation outcomes. Missing rows are not permission to replay an unknown create.",
          { operation_id: operation, tables: Object.fromEntries(found) },
        ),
      )
    // A registered original operation is already complete. Inspect its exact
    // IDs, including an optional renamed Members field, before any name-based
    // inspection of an unregistered initialization.
    const knownSkills = found.get("Skills")
    if (input.operation !== undefined && knownSkills !== undefined) {
      const originalEntry = yield* api.request(`v1/databases/${knownSkills}`)
      const previous = yield* checked(() => libraryFromDatabase(originalEntry))
      if (previous !== undefined) {
        if (
          previous.operation_id !== operation ||
          previous.library_id !== operation ||
          previous.parent_page_id !== parent ||
          previous.skills.database_id !== knownSkills ||
          previous.files.database_id !== found.get("Files") ||
          previous.records.database_id !== found.get("Records")
        )
          return yield* Effect.fail(
            fail(
              "LIBRARY_INIT_CONFLICT",
              "The registered library differs from the original initialization identities.",
              { operation_id: operation },
            ),
          )
        yield* inspectLibrary(previous)
        return { library: previous, reused: true }
      }
    }
    const create = (role: string, properties: Readonly<Record<string, unknown>>) =>
      Effect.gen(function* () {
        let id = found.get(role)
        if (id === undefined) {
          // No retries here. Unknown create outcomes must be reconciled by this exact operation.
          const raw = yield* api
            .request("v1/databases", {
              parent: { type: "page_id", page_id: parent },
              title: title(`${role} [${operation}]`),
              initial_data_source: { properties },
            })
            .pipe(
              Effect.mapError((error) =>
                fail(error.code, error.message, {
                  ...property(error.details),
                  operation_id: operation,
                  parent_page_id: parent,
                  role,
                }),
              ),
            )
          const value = property(raw)
          if (typeof value.id !== "string")
            return yield* Effect.fail(
              fail("LIBRARY_INIT_UNKNOWN", "Table creation returned no confirmed identity.", {
                operation_id: operation,
                parent_page_id: parent,
                role,
              }),
            )
          id = value.id
        }
        return yield* inspectTable(id, properties, parent)
      })
    const initialSkills = yield* create("Skills", sharedSkillProperties)
    const files = yield* create("Files", sharedFileProperties(initialSkills.data_source_id))
    const records = yield* create("Records", sharedRecordProperties(initialSkills.data_source_id))
    const current = yield* api.request(`v1/databases/${initialSkills.database_id}`)
    const previous = yield* checked(() => libraryFromDatabase(current))
    if (previous !== undefined)
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_CONFLICT",
          "An unregistered initialization acquired a library descriptor during setup; preserve it and inspect the original operation.",
          { operation_id: operation },
        ),
      )
    if (text(property(current).description).trim() !== "")
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_CONFLICT",
          "The entry description was edited; retain it and reconcile the original operation.",
          { operation_id: operation },
        ),
      )
    const skills = yield* initializeMembers(
      initialSkills,
      parent,
      operation,
      input.operation !== undefined,
    )
    if (input.operation !== undefined)
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_INCOMPLETE",
          "The original Members schema is visible but its library descriptor is not registered. Recovery is read-only and cannot replay a missing description PATCH.",
          {
            operation_id: operation,
            parent_page_id: parent,
            stage: "descriptor",
            members_property_id: skills.property_ids.Members,
            tables: {
              Skills: skills.database_id,
              Files: files.database_id,
              Records: records.database_id,
            },
          },
        ),
      )
    const library: SharedLibrary = {
      version: 1,
      library_id: operation,
      operation_id: operation,
      parent_page_id: parent,
      skills,
      files,
      records,
    }
    const beforeRegistration = yield* api.request(`v1/databases/${skills.database_id}`)
    const registered = yield* checked(() => libraryFromDatabase(beforeRegistration))
    if (registered) {
      if (JSON.stringify(registered) !== JSON.stringify(library))
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_CONFLICT",
            "Initialization facts disagree with the already registered library.",
          ),
        )
      return { library, reused: true }
    }
    if (text(property(beforeRegistration).description).trim() !== "")
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_CONFLICT",
          "The entry description was edited; retain it and reconcile the original operation.",
          { operation_id: operation },
        ),
      )
    const updated = yield* api
      .request(
        `v1/databases/${skills.database_id}`,
        { description: title(`${LIBRARY_MARKER}${JSON.stringify(library)}`) },
        { method: "PATCH" },
      )
      .pipe(
        Effect.mapError((error) =>
          fail(error.code, error.message, {
            ...property(error.details),
            operation_id: operation,
            parent_page_id: parent,
            stage: "descriptor",
            database_id: skills.database_id,
            members_property_id: skills.property_ids.Members,
          }),
        ),
      )
    const saved = yield* checked(() => libraryFromDatabase(updated)).pipe(
      Effect.mapError((error) =>
        fail(
          "LIBRARY_INIT_UNKNOWN",
          "The acknowledged library descriptor could not be verified; preserve its original operation.",
          {
            operation_id: operation,
            parent_page_id: parent,
            stage: "descriptor",
            cause_code: error.code,
            database_id: skills.database_id,
            members_property_id: skills.property_ids.Members,
          },
        ),
      ),
    )
    if (!saved || JSON.stringify(saved) !== JSON.stringify(library))
      return yield* Effect.fail(
        fail("LIBRARY_INIT_UNKNOWN", "Shared entry registration was not confirmed.", {
          operation_id: operation,
          parent_page_id: parent,
          stage: "descriptor",
          database_id: skills.database_id,
          members_property_id: skills.property_ids.Members,
        }),
      )
    return { library: saved, reused: false }
  })
}
