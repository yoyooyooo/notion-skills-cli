import { Crypto, Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sourceDefinitionLayout } from "./shared-sources-model.ts"

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
const TABLE_MARKER = "ntn-skills-table:v1 "
const tableRoles = ["Skills", "Files", "Records"] as const
type TableRole = (typeof tableRoles)[number]
const TableInitializationSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  parent_page_id: Schema.String,
  role: Schema.Literals(tableRoles),
})
function tableDescription(operation: string, parent: string, role: TableRole): string {
  return (
    TABLE_MARKER +
    JSON.stringify({
      version: 1,
      operation_id: operation,
      parent_page_id: parent,
      role,
    })
  )
}
function tableInitialization(raw: unknown) {
  const database = property(raw)
  const description = text(database.description)
  if (!description.startsWith(TABLE_MARKER)) return undefined
  const identity = decode(
    TableInitializationSchema,
    JSON.parse(description.slice(TABLE_MARKER.length)),
  )
  if (
    !/^library-[a-zA-Z0-9-]{1,80}$/.test(identity.operation_id) ||
    exactId(identity.parent_page_id) !== property(database.parent).page_id ||
    database.in_trash === true
  )
    throw fail(
      "LIBRARY_INIT_CONFLICT",
      "The table initialization identity does not match its actual parent.",
    )
  return identity
}
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
export const sharedRelationProperty = (skillsDataSourceId: string) => ({
  relation: { data_source_id: skillsDataSourceId, single_property: {} },
})
export function registeredSkillProperties(skills: TableBinding) {
  return {
    ...sharedSkillProperties,
    ...Object.fromEntries(
      ["Members", "Requires"]
        .filter((field) => skills.property_ids[field] !== undefined)
        .map((field) => [field, sharedRelationProperty(skills.data_source_id)]),
    ),
  }
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
  Kind: select(["file_event", "object", "source", "snapshot", "profile", "operation", "archive"]),
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
  for (const field of ["Members", "Requires"]) {
    const members = library.skills.property_ids[field]
    if (
      members !== undefined &&
      (!/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(members) ||
        Object.entries(library.skills.property_ids).some(
          ([name, id]) => name !== field && id === members,
        ))
    )
      throw fail(
        "LIBRARY_INVALID",
        `The optional ${field} binding is not a unique stable property identity.`,
      )
  }
  const tables = [
    library.skills,
    library.files,
    library.records,
    ...(library.sources ? [library.sources] : []),
  ]
  if (library.sources) {
    exactId(library.sources.database_id)
    exactId(library.sources.data_source_id)
    const ids = Object.keys(
      sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
    ).map((key) => library.sources!.property_ids[key])
    if (
      library.sources.property_ids.Name !== "title" ||
      ids.some((id) => !id) ||
      new Set(ids).size !== ids.length ||
      !library.skills.property_ids.Origin ||
      !library.skills.property_ids["Source Member"] ||
      !library.records.property_ids.Origin
    )
      throw fail(
        "LIBRARY_INVALID",
        "Sources requires complete stable table, member and relation bindings.",
      )
    for (const table of tables) {
      const bindings = Object.values(table.property_ids)
      if (
        bindings.some((id) => !/^(?:[A-Za-z0-9._~-]|%[0-9a-f]{2})+$/iu.test(id)) ||
        new Set(bindings).size !== bindings.length
      )
        throw fail(
          "LIBRARY_INVALID",
          "Four-table bindings must have unique, safe stable property identities.",
        )
    }
  }
  if (
    new Set(tables.map((table) => table.database_id)).size !== tables.length ||
    new Set(tables.map((table) => table.data_source_id)).size !== tables.length
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

export function validateSharedRelationField(value: unknown, skillsDataSourceId: string): string {
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
      "Members and Requires must be registered native relations to this same Skills data source.",
    )
  return field.id
}

export function inspectTable(
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
      if (name === "Members" || name === "Requires")
        yield* checked(() => validateSharedRelationField(actual, dataSourceId))
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
    if (library.sources) {
      yield* inspectTable(
        library.sources.database_id,
        sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
        library.parent_page_id,
        library.sources,
      )
      for (const table of [library.skills, library.records]) {
        yield* inspectTable(
          table.database_id,
          {
            Origin: {
              relation: { data_source_id: library.sources.data_source_id, single_property: {} },
            },
            ...(table === library.skills ? { "Source Member": { rich_text: {} } } : {}),
          },
          library.parent_page_id,
          table,
        )
      }
    }
    return library
  })
}

/** New libraries add both native relations; recovery never repeats a schema PATCH. */
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
    const existingRequired = property(before.properties).Requires
    if (reconcile) {
      if (existing === undefined)
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_INCOMPLETE",
            "The original Members schema write is not visible. Missing schema is not permission to repeat its PATCH.",
            details,
          ),
        )
      const membersId = yield* checked(() =>
        validateSharedRelationField(existing, skills.data_source_id),
      )
      // Old initialization operations may predate Requires; preserve their exact observed schema.
      const requiredId =
        existingRequired === undefined
          ? undefined
          : yield* checked(() =>
              validateSharedRelationField(existingRequired, skills.data_source_id),
            )
      return {
        ...skills,
        property_ids: {
          ...skills.property_ids,
          Members: membersId,
          ...(requiredId === undefined ? {} : { Requires: requiredId }),
        },
      }
    }
    if (existing !== undefined || existingRequired !== undefined)
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
        {
          properties: {
            Members: sharedRelationProperty(skills.data_source_id),
            Requires: sharedRelationProperty(skills.data_source_id),
          },
        },
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
      return validateSharedRelationField(property(after.properties).Members, skills.data_source_id)
    }).pipe(
      Effect.mapError((error) =>
        fail(
          "LIBRARY_INIT_UNKNOWN",
          "The acknowledged Members schema was not confirmed; preserve the original operation.",
          { ...details, cause_code: error.code },
        ),
      ),
    )
    const requiredId = yield* checked(() =>
      validateSharedRelationField(
        property(property(response).properties).Requires,
        skills.data_source_id,
      ),
    )
    const registered = {
      ...skills,
      property_ids: { ...skills.property_ids, Members: membersId, Requires: requiredId },
    }
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

function ownedTables(parent: string) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      found = new Map<string, unknown>(),
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
        const row = property(item)
        if (row.type !== "child_database" || typeof row.id !== "string") continue
        if (found.has(row.id))
          return yield* Effect.fail(
            fail(
              "LIBRARY_DISCOVERY_INCOMPLETE",
              "Initialization enumeration repeated a database identity.",
            ),
          )
        found.set(row.id, yield* api.request(`v1/databases/${row.id}`))
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
    const children = yield* ownedTables(parent)
    const libraries: SharedLibrary[] = []
    const found = new Map<TableRole, string>()
    for (const [id, raw] of children) {
      const library = yield* checked(() => libraryFromDatabase(raw))
      if (library) libraries.push(library)
      const initialization = yield* checked(() => tableInitialization(raw))
      if (initialization?.operation_id === operation) {
        if (found.has(initialization.role))
          return yield* Effect.fail(
            fail(
              "LIBRARY_INIT_CONFLICT",
              "Multiple tables claim one initialization operation; preserve all candidates.",
              { operation_id: operation, role: initialization.role },
            ),
          )
        found.set(initialization.role, id)
      }
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
      if (
        existing.parent_page_id !== parent ||
        (input.operation !== undefined && existing.operation_id !== operation)
      )
        return yield* Effect.fail(
          fail(
            "LIBRARY_SCHEMA_CONFLICT",
            "The library entry belongs to a different initialization parent or operation.",
          ),
        )
      for (const binding of [existing.skills, existing.files, existing.records])
        if (!children.has(binding.database_id))
          return yield* Effect.fail(
            fail(
              "LIBRARY_INIT_INCOMPLETE",
              "A registered table is missing from the complete parent enumeration.",
            ),
          )
      yield* inspectLibrary(existing)
      return { library: existing, reused: true }
    }
    if (input.operation === undefined && children.size)
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_INCOMPLETE",
          "An unfinished initialization or unregistered database already exists here. Preserve it and inspect its original operation before creating another library; display titles do not establish identity.",
          { tables: [...children.keys()] },
        ),
      )
    if (input.operation !== undefined && tableRoles.some((role) => !found.has(role)))
      return yield* Effect.fail(
        fail(
          "LIBRARY_INIT_INCOMPLETE",
          "Recovery cannot prove all table creation outcomes. Missing rows are not permission to replay an unknown create.",
          { operation_id: operation, tables: Object.fromEntries(found) },
        ),
      )
    const create = (role: TableRole, properties: Readonly<Record<string, unknown>>) =>
      Effect.gen(function* () {
        let id = found.get(role)
        if (id === undefined) {
          // No retries here. Unknown create outcomes must be reconciled by this exact operation.
          const raw = yield* api
            .request("v1/databases", {
              parent: { type: "page_id", page_id: parent },
              title: title(role),
              description: title(tableDescription(operation, parent, role)),
              is_inline: false,
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
    if (text(property(current).description) !== tableDescription(operation, parent, "Skills"))
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
    if (
      text(property(beforeRegistration).description) !==
      tableDescription(operation, parent, "Skills")
    )
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
