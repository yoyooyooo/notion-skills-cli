import { Crypto, Effect, Schema } from "effect"
import { decode, fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sourceDefinitionLayout } from "./shared-sources-model.ts"
import { initializeCurrentSourceRelations } from "./shared-sources-library.ts"
import { withLibraryInitialization } from "./shared-library-initialization.ts"
import { Store } from "./store.ts"
import { selectedLibraryId } from "./library-selection.ts"

import {
  LIBRARY_MARKER,
  SharedLibrarySchema,
  preservesSharedLibraryBindings,
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
const tableRoles = ["Skills", "Files", "Records", "Sources"] as const
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
  "Skill ID": rich,
  "Main File ID": rich,
  Content: rich,
  "Current State": select(["ready", "applying", "attention"]),
  Operation: rich,
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
  Content: rich,
  Skill: { relation: { data_source_id: skillsDataSourceId, dual_property: {} } },
})
export const sharedRecordProperties = (skillsDataSourceId: string) => ({
  Name: { title: {} },
  "Record ID": rich,
  Kind: select(["resource", "profile", "operation"]),
  "Entity ID": rich,
  Hash: rich,
  Payload: rich,
  Resource: { files: {} },
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
  const descriptor = JSON.parse(description.slice(LIBRARY_MARKER.length))
  const missing = missingCurrentBindings(descriptor)
  if (missing.length !== 0)
    throw fail(
      "CURRENT_SCHEMA_REQUIRED",
      "The current library requires all four tables and their registered relationships. Explicitly convert the existing library before normal use.",
      { missing, next: "migrate_current_content" },
    )
  const library = decode(SharedLibrarySchema, descriptor)
  if (value.in_trash === true || value.id !== library.skills.database_id)
    throw fail(
      "LIBRARY_INVALID",
      "The library entry does not match its registered Skills database.",
    )
  exactId(library.library_id)
  if (property(value.parent).page_id !== library.library_id)
    throw fail("LIBRARY_SCHEMA_CONFLICT", "The Skills table is not a direct child of its Library root.")
  if (
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
      throw fail(
        "CURRENT_SCHEMA_REQUIRED",
        "The library needs explicit current-content migration before use.",
        { next: "migrate_current_content" },
      )
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
        `The ${field} binding is not a unique stable property identity.`,
      )
  }
  const tables = [library.skills, library.files, library.records, library.sources]
  exactId(library.sources.database_id)
  exactId(library.sources.data_source_id)
  const ids = Object.keys(
    sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
  ).map((key) => library.sources.property_ids[key])
  if (
    library.sources.property_ids.Name !== "title" ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    !library.skills.property_ids.Origin ||
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
  if (
    new Set(tables.map((table) => table.database_id)).size !== tables.length ||
    new Set(tables.map((table) => table.data_source_id)).size !== tables.length
  )
    throw fail("LIBRARY_INVALID", "Shared table identities overlap.")
  return library
}

/** Resolve a root through its complete direct-child inventory and verify every binding. */
export function loadSharedLibrary(root: string) {
  return Effect.gen(function* () {
    const id = yield* checked(() => exactId(root))
    yield* inspectRoot(id)
    const children = yield* ownedTables(id)
    const libraries: SharedLibrary[] = []
    for (const raw of children.values()) {
      const description = text(property(raw).description)
      if (description.startsWith("ntn-skills-library:") && !description.startsWith(LIBRARY_MARKER))
        return yield* Effect.fail(fail("CURRENT_SCHEMA_REQUIRED", "Migrate this Library to the root identity contract before use."))
      const library = yield* checked(() => libraryFromDatabase(raw))
      if (library !== undefined) libraries.push(library)
    }
    if (libraries.length !== 1)
      return yield* Effect.fail(fail(libraries.length ? "LIBRARY_AMBIGUOUS" : "NOT_SHARED_LIBRARY", "The root must contain exactly one registered current Library descriptor."))
    const library = libraries[0]!
    if (library.library_id !== id)
      return yield* Effect.fail(fail("LIBRARY_SCHEMA_CONFLICT", "The descriptor belongs to a different Library root."))
    for (const role of ["skills", "files", "records", "sources"] as const)
      if (!children.has(library[role].database_id))
        return yield* Effect.fail(fail("LIBRARY_SCHEMA_CONFLICT", "A registered table is absent from the complete root inventory.", { role }))
    return yield* inspectLibrary(library)
  })
}

export function resolveLibrary(options: { readonly library?: string } = {}) {
  return selectedLibraryId(options.library).pipe(Effect.flatMap(loadSharedLibrary))
}

/** A preflight observation freezes routing; Notion does not provide a cross-table CAS. */
export function assertSharedLibraryBinding(original: SharedLibrary) {
  return Effect.gen(function* () {
    const current = yield* loadSharedLibrary(original.library_id)
    if (!preservesSharedLibraryBindings(original, current))
      return yield* Effect.fail(fail("LIBRARY_BINDING_CHANGED", "The Library's registered physical bindings changed; the original operation cannot retarget."))
  })
}

function inspectRoot(id: string, parent?: string) {
  return Effect.gen(function* () {
    const root = property(yield* (yield* Notion).request(`v1/pages/${id}`))
    if (root.id !== id || root.in_trash === true || root.archived === true ||
      (parent !== undefined && property(root.parent).page_id !== parent))
      return yield* Effect.fail(fail("LIBRARY_SCHEMA_CONFLICT", "The exact Library root is unavailable or has a different initialization parent."))
    return root
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
    mode !== "single_property" ||
    typeof relation[mode] !== "object" ||
    relation[mode] === null ||
    Array.isArray(relation[mode])
  )
    throw fail(
      "LIBRARY_SCHEMA_CONFLICT",
      "Members and Requires must be registered single-property relations to this same Skills data source.",
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
      library.library_id,
      library.skills,
    )
    yield* inspectTable(
      library.files.database_id,
      sharedFileProperties(library.skills.data_source_id),
      library.library_id,
      library.files,
    )
    yield* inspectTable(
      library.records.database_id,
      sharedRecordProperties(library.skills.data_source_id),
      library.library_id,
      library.records,
    )
    yield* inspectTable(
      library.sources.database_id,
      sourceDefinitionLayout(library.skills.data_source_id, library.records.data_source_id),
      library.library_id,
      library.sources,
    )
    yield* initializeCurrentSourceRelations(library, true)
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
    const relation = (name: "Members" | "Requires") =>
      skills.property_ids[name] === undefined
        ? property(before.properties)[name]
        : Object.values(property(before.properties)).find(
            (field) => property(field).id === skills.property_ids[name],
          )
    const existing = relation("Members")
    const existingRequired = relation("Requires")
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
      if (existingRequired === undefined)
        return yield* Effect.fail(
          fail(
            "LIBRARY_INIT_INCOMPLETE",
            "The original Requires schema is not completely visible; its PATCH cannot be replayed.",
            details,
          ),
        )
      const requiredId = yield* checked(() =>
        validateSharedRelationField(existingRequired, skills.data_source_id),
      )
      return {
        ...skills,
        property_ids: {
          ...skills.property_ids,
          Members: membersId,
          Requires: requiredId,
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

const ROOT_MARKER = "ntn-skills-library-init:v2 "
function rootMarker(operation: string, parent: string) {
  return ROOT_MARKER + JSON.stringify({ version: 2, operation_id: operation, parent_page_id: parent })
}
function directChildren(parent: string) {
  return Effect.gen(function* () {
    const api = yield* Notion, found = new Map<string, Record<string, unknown>>(), cursors = new Set<string>()
    let cursor: string | undefined
    while (true) {
      const raw = yield* api.request(`v1/blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`)
      const page = yield* checked(() => decode(listSchema(Schema.Unknown), raw))
      for (const item of page.results) {
        const row = property(item)
        if (typeof row.id !== "string" || found.has(row.id))
          return yield* Effect.fail(fail("LIBRARY_DISCOVERY_INCOMPLETE", "Direct-child enumeration omitted or repeated an identity."))
        found.set(row.id, row)
      }
      if (!page.has_more) return found
      if (!page.next_cursor || cursors.has(page.next_cursor))
        return yield* Effect.fail(fail("LIBRARY_DISCOVERY_INCOMPLETE", "Missing or repeating direct-child cursor."))
      cursor = page.next_cursor
      cursors.add(cursor)
    }
  })
}
function ownedTables(parent: string) {
  return Effect.gen(function* () {
    const api = yield* Notion, found = new Map<string, unknown>()
    for (const [id, child] of yield* directChildren(parent))
      if (child.type === "child_database" && child.in_trash !== true && child.archived !== true)
        found.set(id, yield* api.request(`v1/databases/${id}`))
    return found
  })
}
function initializationRoots(parent: string, operation: string) {
  return Effect.gen(function* () {
    yield* inspectRoot(parent)
    const matches: string[] = []
    const expected = rootMarker(operation, parent)
    for (const [id, child] of yield* directChildren(parent)) {
      if (child.type !== "child_page" || child.in_trash === true || child.archived === true) continue
      let count = 0
      for (const block of (yield* directChildren(id)).values()) {
        if (block.type === "paragraph" && text(property(block.paragraph).rich_text) === expected) count++
      }
      if (count > 1) return yield* Effect.fail(fail("LIBRARY_INIT_CONFLICT", "An initialization root repeats its operation marker."))
      if (count === 1) { yield* inspectRoot(id, parent); matches.push(id) }
    }
    if (matches.length > 1)
      return yield* Effect.fail(fail("LIBRARY_INIT_CONFLICT", "Several roots claim this initialization operation.", { root_page_ids: matches }))
    return matches[0]
  })
}

function missingCurrentBindings(input: unknown): string[] {
  const library = property(input)
  const missing = [
    ...(library.sources === undefined ? ["Sources"] : []),
    ...["Members", "Requires", "Origin"]
      .filter((field) => property(property(library.skills).property_ids)[field] === undefined)
      .map((field) => `Skills.${field}`),
    ...(property(property(library.records).property_ids).Origin === undefined
      ? ["Records.Origin"]
      : []),
    ...(property(property(library.files).property_ids).Origin === undefined
      ? ["Files.Origin"]
      : []),
  ]
  return missing
}

/** Initialize one four-table library. --operation observes; explicit resume continues known work. */
export function initializeSharedLibrary(input: {
  readonly parent?: string
  readonly library?: string
  readonly operation?: string
  readonly resume?: boolean
}): Effect.Effect<
  { readonly library: SharedLibrary; readonly reused: boolean },
  SkillsError,
  Notion | Crypto.Crypto | Store
> {
  return Effect.gen(function* () {
    if (input.library !== undefined) {
      if (input.parent !== undefined || input.operation !== undefined || input.resume)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Use --library alone to attach an existing library."),
        )
      const library = yield* loadSharedLibrary(input.library)
      yield* inspectLibrary(library)
      return { library, reused: true }
    }
    if (input.resume && input.operation === undefined)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--resume requires the exact --operation and --parent."),
      )
    const selectedParent = input.parent
    if (!selectedParent)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact parent page or an existing library entry."),
      )
    const container = yield* checked(() => exactId(selectedParent))
    const crypto = yield* Crypto.Crypto
    const operation =
      input.operation ??
      `library-${yield* crypto.randomUUIDv4().pipe(Effect.mapError(() => fail("LIBRARY_INIT_UNAVAILABLE", "Could not allocate the current initialization identity; no table creation was attempted.")))}`
    if (!/^library-[a-zA-Z0-9-]{1,80}$/.test(operation))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid library operation identity."))
    const reconcile = input.operation !== undefined && !input.resume
    return yield* withLibraryInitialization(
      container,
      operation,
      input.resume ? "resume" : reconcile ? "reconcile" : "create",
      (session) =>
        Effect.gen(function* () {
          const api = yield* Notion
          const write = (...args: Parameters<Notion["Service"]["request"]>) =>
            Effect.gen(function* () {
              return yield* (yield* Notion).request(...args)
            })
          let parent = yield* initializationRoots(container, operation)
          const knownRoot = session.pending().root_page_id
          if (knownRoot !== null && parent !== knownRoot)
            return yield* Effect.fail(fail("LIBRARY_INIT_CONFLICT", "The known root is missing or its exact operation marker changed.", { root_page_id: knownRoot }))
          if (parent === undefined) {
            if (reconcile)
              return yield* Effect.fail(fail("LIBRARY_INIT_INCOMPLETE", "The original root creation is not visible; reconciliation never repeats CREATE."))
            yield* session.requireResumeState()
            const created = property(yield* session.perform("create:root", "never", write("v1/pages", {
              parent: { type: "page_id", page_id: container },
              properties: { title: { type: "title", title: title("Skill Library") } },
              children: [{ object: "block", type: "paragraph", paragraph: { rich_text: title(rootMarker(operation, container)) } }],
            })))
            if (typeof created.id !== "string" || pageId(created.id) !== created.id)
              return yield* Effect.fail(fail("LIBRARY_INIT_UNKNOWN", "Root creation returned no confirmed identity."))
            parent = created.id
            yield* session.rememberRoot(parent)
            yield* inspectRoot(parent, container)
            const observed = yield* initializationRoots(container, operation)
            if (observed !== parent)
              return yield* Effect.fail(fail("LIBRARY_INIT_UNKNOWN", "The created root and its atomic operation marker are not yet confirmed."))
          }
          yield* session.rememberRoot(parent)
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
              existing.library_id !== parent ||
              (input.operation !== undefined &&
                existing.operation_id !== operation)
            )
              return yield* Effect.fail(
                fail(
                  "LIBRARY_SCHEMA_CONFLICT",
                  "The library entry belongs to a different initialization parent, operation or library identity.",
                ),
              )
            for (const binding of [
              existing.skills,
              existing.files,
              existing.records,
              existing.sources,
            ])
              if (!children.has(binding.database_id))
                return yield* Effect.fail(
                  fail(
                    "LIBRARY_INIT_INCOMPLETE",
                    "A registered table is missing from the complete parent enumeration.",
                  ),
                )
            yield* inspectLibrary(existing)
            for (const [role, table] of [
              ["Skills", existing.skills],
              ["Files", existing.files],
              ["Records", existing.records],
              ["Sources", existing.sources],
            ] as const)
              yield* session.verifyTable(role, table)
            yield* session.finish()
            return { library: existing, reused: true }
          }
          if (reconcile && tableRoles.some((role) => !found.has(role)))
            return yield* Effect.fail(
              fail(
                "LIBRARY_INIT_INCOMPLETE",
                "Recovery cannot prove all table creation outcomes. Missing rows are not permission to replay an unknown create.",
                { operation_id: operation, tables: Object.fromEntries(found) },
              ),
            )
          yield* session.requireResumeState()
          const create = (role: TableRole, properties: Readonly<Record<string, unknown>>) =>
            Effect.gen(function* () {
              let id = found.get(role)
              const known = session.pending().tables[role]
              if (known !== undefined && id !== known.database_id)
                return yield* Effect.fail(
                  fail(
                    "LIBRARY_INIT_CONFLICT",
                    "A known initialization table is missing or replaced.",
                    { role, database_id: known.database_id },
                  ),
                )
              if (id === undefined) {
                // No retries here. Unknown create outcomes must be reconciled by this exact operation.
                const raw = yield* session.perform(
                  `create:${role}`,
                  "never",
                  write("v1/databases", {
                    parent: { type: "page_id", page_id: parent },
                    title: title(role),
                    description: title(tableDescription(operation, parent, role)),
                    is_inline: false,
                    initial_data_source: { properties },
                  }).pipe(
                    Effect.mapError((error) =>
                      fail(error.code, error.message, {
                        ...property(error.details),
                        operation_id: operation,
                        parent_page_id: parent,
                        role,
                      }),
                    ),
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
              const inspected = yield* inspectTable(id, properties, parent, known)
              const table = {
                ...inspected,
                property_ids: { ...known?.property_ids, ...inspected.property_ids },
              }
              yield* session.remember({ [role]: table }, `create:${role}`)
              return table
            })
          const initialSkills = yield* create("Skills", sharedSkillProperties)
          const files = yield* create("Files", sharedFileProperties(initialSkills.data_source_id))
          const records = yield* create(
            "Records",
            sharedRecordProperties(initialSkills.data_source_id),
          )
          const sources = yield* create(
            "Sources",
            sourceDefinitionLayout(initialSkills.data_source_id, records.data_source_id),
          )
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
          const skills = yield* session.perform(
            "members",
            "never",
            initializeMembers(
              initialSkills,
              parent,
              operation,
              reconcile ||
                session.pending().in_flight?.action === "members" ||
                initialSkills.property_ids.Members !== undefined,
            ),
          )
          yield* session.remember({ Skills: skills }, "members")
          const library = yield* session.perform(
            "origins",
            "never",
            initializeCurrentSourceRelations(
              {
                version: 2,
                library_id: parent,
                operation_id: operation,
                skills,
                files,
                records,
                sources,
              },
              reconcile || session.pending().in_flight?.action === "origins",
            ),
          )
          yield* session.remember(
            {
              Skills: library.skills,
              Files: library.files,
              Records: library.records,
              Sources: library.sources,
            },
            "origins",
          )
          if (reconcile)
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
                    Sources: sources.database_id,
                  },
                },
              ),
            )
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
            yield* session.finish()
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
          const updated = yield* session
            .perform(
              "descriptor",
              "idempotent",
              write(
                `v1/databases/${skills.database_id}`,
                { description: title(`${LIBRARY_MARKER}${JSON.stringify(library)}`) },
                { method: "PATCH" },
              ),
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
          yield* loadSharedLibrary(saved.library_id)
          yield* session.finish()
          return { library: saved, reused: false }
        }),
    )
  })
}
