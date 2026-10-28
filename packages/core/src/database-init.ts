import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import {
  ConfigSchema,
  DatabaseSchema,
  DataSourceSchema,
  decode,
  fail,
  property,
  SkillsError,
  text,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { Store, sha256 } from "./store.ts"
import { withLocalLocks } from "./local-locks.ts"

const rich = { rich_text: {} }
const select = (names: readonly string[]) => ({
  select: { options: names.map((name) => ({ name })) },
})
export const contentProperties = {
  Name: { title: {} },
  Description: rich,
  Kind: select(["skill", "router", "prompt"]),
  "Default Context": { checkbox: {} },
  References: rich,
  Files: { files: {} },
  "Source Type": select(["builtin", "upstream", "manual"]),
  "Builtin ID": rich,
  "Sync Mode": select(["tracked", "fork"]),
  "Upstream Key": rich,
  "Upstream Revision": rich,
  "Published Hash": rich,
  "Fork Baseline": rich,
  Publication: rich,
}
export const subscriptionProperties = {
  Name: { title: {} },
  Description: rich,
  Source: rich,
  "Source URL": { url: {} },
  Ref: rich,
  Roots: rich,
  Include: rich,
  Exclude: rich,
  Mapping: rich,
  "Published Members": rich,
  "Target Database ID": rich,
  Enabled: { checkbox: {} },
  "Default Context": { checkbox: {} },
  Status: select(["pending", "verified", "partial", "failed", "disabled"]),
  "Sync Status": select(["running", "succeeded", "partial", "failed"]),
  "Last Sync Attempt": { date: {} },
  "Last Synced": { date: {} },
  "Sync Summary": rich,
}
const TableSchema = Schema.Struct({
  database_id: Schema.String,
  data_source_id: Schema.String,
  property_ids: Schema.Record(Schema.String, Schema.String),
})
const InitSchema = Schema.Struct({
  operation_id: Schema.String,
  scope: Schema.String,
  parent_page_id: Schema.optional(Schema.String),
  content_database_id: Schema.optional(Schema.String),
  upstream_database_id: Schema.optional(Schema.String),
  content: Schema.optional(TableSchema),
  upstream: Schema.optional(TableSchema),
  pending: Schema.optional(Schema.String),
  set_default: Schema.optional(Schema.Boolean),
  phase: Schema.Literals(["prepared", "applying", "verified", "published"]),
  event_index: Schema.Number,
})
type Init = typeof InitSchema.Type
type Table = typeof TableSchema.Type
export interface DatabaseInitOptions {
  readonly parent?: string
  readonly contentDatabase?: string
  readonly upstreamDatabase?: string
  readonly operation?: string
  readonly setDefault?: boolean
}
const exactId = (input: string) => {
  const id = pageId(input)
  if (!id) throw fail("INVALID_ARGUMENT", "An exact Notion UUID or URL is required.")
  return id
}
const checked = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (error) =>
      error instanceof SkillsError ? error : fail("INVALID_RESPONSE", "Invalid database schema."),
  })
const RelationSchema = Schema.Struct({
  type: Schema.Literal("relation"),
  relation: Schema.Struct({
    data_source_id: Schema.String,
    type: Schema.Literals(["single_property", "dual_property"]),
    single_property: Schema.optional(Schema.Struct({})),
    dual_property: Schema.optional(
      Schema.Struct({ synced_property_id: Schema.String, synced_property_name: Schema.String }),
    ),
  }),
})

export function resolveDatabasePropertyIds(dataSourceId: string, expectedDatabaseId?: string) {
  return Effect.gen(function* () {
    const id = yield* checked(() => exactId(dataSourceId))
    const raw = yield* (yield* Notion).request(`v1/data_sources/${id}`)
    const source = yield* checked(() => decode(DataSourceSchema, raw))
    if (
      source.id !== id ||
      source.in_trash ||
      (expectedDatabaseId !== undefined && source.parent.database_id !== expectedDatabaseId)
    )
      return yield* Effect.fail(
        fail("DATABASE_SCHEMA_CONFLICT", "The requested data source is unavailable."),
      )
    return yield* checked(() => {
      const titles = Object.values(source.properties ?? {})
        .map(property)
        .filter((field) => field.type === "title")
      if (titles.length !== 1 || titles[0]!.id !== "title")
        throw fail(
          "DATABASE_SCHEMA_CONFLICT",
          "A table requires exactly one native title property.",
        )
      const ids: Record<string, string> = Object.fromEntries(
        Object.entries(property(source.properties)).map(([name, field]) => {
          const fieldId = property(field).id
          if (typeof fieldId !== "string" || !fieldId)
            throw fail("INVALID_RESPONSE", "A database field has no confirmed property ID.", {
              property: name,
            })
          return [name, fieldId]
        }),
      )
      ids.Name = "title"
      return ids
    })
  })
}

/** Validate property type and exact relation direction/target before any schema write. */
export function checkRelation(value: unknown, target: string, dual: boolean, counterpart?: string) {
  const field = decode(RelationSchema, value)
  const relation = field.relation
  if (
    field.type !== "relation" ||
    relation.data_source_id !== target ||
    relation.type !== (dual ? "dual_property" : "single_property") ||
    (counterpart !== undefined &&
      property(relation.dual_property).synced_property_id !== counterpart)
  )
    throw fail(
      "DATABASE_SCHEMA_CONFLICT",
      "Relation target or direction does not match the registered two-table schema.",
    )
}

function inspectDatabase(id: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const rawDatabase = yield* api.request(`v1/databases/${id}`)
    const database = yield* checked(() => decode(DatabaseSchema, rawDatabase))
    if (
      database.id !== id ||
      database.in_trash === true ||
      !Array.isArray(database.data_sources) ||
      database.data_sources.length !== 1
    )
      return yield* Effect.fail(
        fail(
          "DATABASE_SCHEMA_CONFLICT",
          "Initialization requires one accessible data source per exact database.",
        ),
      )
    const dsId = property(database.data_sources[0]).id
    if (typeof dsId !== "string")
      return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing data source ID."))
    const rawDataSource = yield* api.request(`v1/data_sources/${dsId}`)
    const ds = yield* checked(() => decode(DataSourceSchema, rawDataSource))
    if (ds.id !== dsId || property(ds.parent).database_id !== id || ds.in_trash === true)
      return yield* Effect.fail(
        fail("DATABASE_SCHEMA_CONFLICT", "Data source parent does not match the exact database."),
      )
    const propertyIds = yield* checked(() =>
      Object.fromEntries(
        Object.entries(property(ds.properties)).map(([name, field]) => {
          const fieldId = property(field).id
          if (typeof fieldId !== "string" || !fieldId)
            throw fail("INVALID_RESPONSE", "A database field has no confirmed property ID.", {
              property: name,
            })
          return [name, fieldId]
        }),
      ),
    )
    return {
      table: { database_id: id, data_source_id: dsId, property_ids: propertyIds } satisfies Table,
      properties: property(ds.properties),
    }
  })
}

function databaseCreateCandidates(
  parentId: string,
  operationId: string,
  role: "content" | "upstream",
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const marker = `ntn-skills:${operationId}:${role}`
    let cursor: string | undefined
    const cursors = new Set<string>()
    const candidates = new Set<string>()
    do {
      const result = property(
        yield* api.request(
          `v1/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      )
      if (!Array.isArray(result.results))
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "Invalid initialization parent inventory."),
        )
      for (const block of result.results) {
        const value = property(block)
        if (value.type !== "child_database" || typeof value.id !== "string") continue
        const db = property(yield* api.request(`v1/databases/${value.id}`))
        if (db.id === value.id && db.in_trash !== true && text(db.description) === marker)
          candidates.add(value.id)
      }
      if (result.has_more !== true) break
      if (typeof result.next_cursor !== "string" || cursors.has(result.next_cursor))
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid parent inventory cursor."))
      cursor = result.next_cursor
      cursors.add(cursor)
    } while (true)
    return [...candidates]
  })
}

function expectedFields(properties: Record<string, unknown>, expected: Record<string, unknown>) {
  const titles = Object.entries(properties).filter(([, value]) => property(value).type === "title")
  if (titles.length !== 1 || property(titles[0]![1]).id !== "title")
    throw fail("DATABASE_SCHEMA_CONFLICT", "A table requires exactly one native title property.")
  return Object.fromEntries(
    Object.entries(expected).map(([name, value]) => [
      name === "Name" ? titles[0]![0] : name,
      value,
    ]),
  )
}

function validateFields(
  fields: Record<string, unknown>,
  expected: Record<string, unknown>,
  required = false,
) {
  for (const [name, specification] of Object.entries(expected)) {
    if (fields[name] === undefined) {
      if (required) throw fail("DATABASE_SCHEMA_CONFLICT", `Missing ${name}.`)
      continue
    }
    const expectedType = Object.keys(property(specification))[0]
    if (property(fields[name]).type !== expectedType)
      throw fail("DATABASE_SCHEMA_CONFLICT", `Property ${name} has an incompatible type.`)
    if (expectedType === "select") {
      const allowed = property(property(fields[name]).select).options
      const requiredOptions = property(property(specification).select).options as { name: string }[]
      if (
        !Array.isArray(allowed) ||
        (name === "Source Type" && allowed.length !== requiredOptions.length) ||
        requiredOptions.some(
          (item) => !allowed.some((option) => property(option).name === item.name),
        )
      )
        throw fail(
          "DATABASE_SCHEMA_CONFLICT",
          `Property ${name} is missing required select options.`,
        )
    }
  }
}

interface InspectedTable {
  readonly table: Table
  readonly properties: Record<string, unknown>
}

function validateExistingTables(content?: InspectedTable, upstream?: InspectedTable) {
  if (content) {
    validateFields(content.properties, expectedFields(content.properties, contentProperties))
    if (content.properties.Members !== undefined)
      checkRelation(content.properties.Members, content.table.data_source_id, false)
  }
  if (upstream)
    validateFields(upstream.properties, expectedFields(upstream.properties, subscriptionProperties))
  for (const [observed, other, name, counterpart] of [
    [content, upstream, "Upstream", "Skills"],
    [upstream, content, "Skills", "Upstream"],
  ] as const) {
    const field = observed?.properties[name]
    if (field !== undefined) {
      if (!other)
        throw fail(
          "DATABASE_SCHEMA_CONFLICT",
          `Existing ${name} relation cannot target a table that has not been created.`,
        )
      checkRelation(field, other.table.data_source_id, true, other.table.property_ids[counterpart])
    }
  }
  if (content && upstream && !!content.properties.Upstream !== !!upstream.properties.Skills)
    throw fail("DATABASE_SCHEMA_CONFLICT", "Both sides of the Upstream/Skills relation must agree.")
}

export function initializeDatabases(options: DatabaseInitOptions) {
  return Effect.gen(function* () {
    const store = yield* Store
    const scope = yield* authScope
    const input = yield* checked(() => {
      if (!options.parent && (!options.contentDatabase || !options.upstreamDatabase))
        throw fail(
          "INVALID_ARGUMENT",
          "Provide --parent or both --content-database and --upstream-database.",
        )
      if (
        options.contentDatabase &&
        options.upstreamDatabase &&
        exactId(options.contentDatabase) === exactId(options.upstreamDatabase)
      )
        throw fail("INVALID_ARGUMENT", "Content and upstream require distinct databases.")
      return {
        ...(options.parent ? { parent_page_id: exactId(options.parent) } : {}),
        ...(options.contentDatabase
          ? { content_database_id: exactId(options.contentDatabase) }
          : {}),
        ...(options.upstreamDatabase
          ? { upstream_database_id: exactId(options.upstreamDatabase) }
          : {}),
      }
    })
    const digest = yield* sha256(JSON.stringify([scope, input]))
    const operationId = options.operation ?? `dbinit_${digest}`
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Invalid database initialization operation ID."),
      )
    return yield* withLocalLocks(
      store.root,
      [`database-init:${scope}`],
      Effect.gen(function* () {
        const api = yield* Notion
        const keys = yield* store.listKeys(`database-init/${operationId}/`)
        const latest = keys
          .slice()
          .sort(
            (a, b) =>
              Number(a.split("/").at(-1)?.replace(".json", "")) -
              Number(b.split("/").at(-1)?.replace(".json", "")),
          )
          .at(-1)
        let state: Init = latest
          ? (yield* store.readJson(latest, InitSchema))!
          : {
              operation_id: operationId,
              scope,
              ...input,
              set_default: options.setDefault ?? false,
              phase: "prepared",
              event_index: -1,
            }
        if (
          state.scope !== scope ||
          JSON.stringify([
            state.parent_page_id,
            state.content_database_id,
            state.upstream_database_id,
          ]) !==
            JSON.stringify([
              input.parent_page_id,
              input.content_database_id,
              input.upstream_database_id,
            ])
        )
          return yield* Effect.fail(
            fail(
              "OPERATION_CONFLICT",
              "The operation belongs to another scope or initialization target.",
            ),
          )
        if (
          options.setDefault !== undefined &&
          state.set_default !== undefined &&
          options.setDefault !== state.set_default
        )
          return yield* Effect.fail(
            fail("OPERATION_CONFLICT", "The operation has a different default-database intent."),
          )
        if (state.set_default === undefined)
          state = { ...state, set_default: options.setDefault ?? false }
        const save = (patch: Partial<Init>) =>
          Effect.gen(function* () {
            state = { ...state, ...patch, event_index: state.event_index + 1 }
            yield* store.writeJson(`database-init/${operationId}/${state.event_index}.json`, state)
          })
        if (!latest) yield* save({})
        const inspect = inspectDatabase
        if (state.parent_page_id) {
          const parent = property(yield* api.request(`v1/pages/${state.parent_page_id}`))
          if (parent.id !== state.parent_page_id || parent.in_trash === true)
            return yield* Effect.fail(
              fail("ACCESS_DENIED", "Initialization parent is unavailable."),
            )
        }
        const reconcileCreate = (role: "content" | "upstream") =>
          Effect.gen(function* () {
            const candidates = yield* databaseCreateCandidates(
              state.parent_page_id!,
              operationId,
              role,
            )
            if (candidates.length !== 1)
              return yield* Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "The pending database creation cannot be uniquely reconciled. No creation was replayed.",
                  { operation_id: operationId, role, candidates },
                ),
              )
            return candidates[0]!
          })
        // Preflight every known identity before creating a missing table, including on resume.
        const known: { content?: InspectedTable; upstream?: InspectedTable } = {}
        for (const role of ["content", "upstream"] as const) {
          const provided =
            role === "content" ? state.content_database_id : state.upstream_database_id
          const recorded = state[role]
          if (recorded && provided && recorded.database_id !== provided)
            return yield* Effect.fail(
              fail(
                "DATABASE_SCHEMA_CONFLICT",
                "Recorded database does not match the explicit target.",
              ),
            )
          let id = provided ?? recorded?.database_id
          if (!id && state.pending === `create:${role}`) id = yield* reconcileCreate(role)
          if (!id) continue
          const observed = yield* inspect(id)
          if (recorded && recorded.data_source_id !== observed.table.data_source_id)
            return yield* Effect.fail(
              fail("DATABASE_SCHEMA_CONFLICT", "The recorded data source identity has changed."),
            )
          known[role] = observed
        }
        yield* checked(() => validateExistingTables(known.content, known.upstream))
        for (const role of ["content", "upstream"] as const) {
          if (state[role]) continue
          const provided =
            role === "content" ? state.content_database_id : state.upstream_database_id
          let id = provided
          if (!id) {
            if (state.pending === `create:${role}`) id = yield* reconcileCreate(role)
            else {
              yield* save({ phase: "applying", pending: `create:${role}` })
              const response = property(
                yield* api.request("v1/databases", {
                  parent: { type: "page_id", page_id: state.parent_page_id },
                  is_inline: false,
                  title: [
                    {
                      type: "text",
                      text: { content: role === "content" ? "Agent Content" : "Agent Upstream" },
                    },
                  ],
                  description: [
                    { type: "text", text: { content: `ntn-skills:${operationId}:${role}` } },
                  ],
                  initial_data_source: {
                    properties: role === "content" ? contentProperties : subscriptionProperties,
                  },
                }),
              )
              if (typeof response.id !== "string")
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Database creation returned no exact ID.", {
                    operation_id: operationId,
                  }),
                )
              id = response.id
              const dataSources = response.data_sources
              const createdSource = Array.isArray(dataSources)
                ? property(dataSources[0]).id
                : undefined
              if (typeof createdSource !== "string")
                return yield* Effect.fail(
                  fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "Created database has no confirmed data source identity.",
                    { operation_id: operationId, database_id: id },
                  ),
                )
              yield* save({
                [role]: { database_id: id, data_source_id: createdSource, property_ids: {} },
                pending: `inspect:${role}`,
              })
            }
          }
          const observed = yield* inspect(id)
          yield* save({ [role]: observed.table, pending: undefined })
        }
        // Inspect both tables before changing either. Existing incompatible fields are never rewritten.
        const content = yield* inspect(state.content!.database_id)
        const upstream = yield* inspect(state.upstream!.database_id)
        const contentExpected = yield* checked(() =>
          expectedFields(content.properties, contentProperties),
        )
        const upstreamExpected = yield* checked(() =>
          expectedFields(upstream.properties, subscriptionProperties),
        )
        yield* checked(() => validateExistingTables(content, upstream))
        for (const [role, observed, expected] of [
          ["content", content, contentExpected],
          ["upstream", upstream, upstreamExpected],
        ] as const) {
          const missing = Object.fromEntries(
            Object.entries(expected).filter(([name]) => observed.properties[name] === undefined),
          )
          if (Object.keys(missing).length) {
            yield* save({ pending: `fields:${role}` })
            yield* api.request(
              `v1/data_sources/${observed.table.data_source_id}`,
              { properties: missing },
              { method: "PATCH" },
            )
            yield* save({ pending: undefined })
          }
        }
        if (!content.properties.Members) {
          yield* save({ pending: "relation:members" })
          yield* api.request(
            `v1/data_sources/${content.table.data_source_id}`,
            {
              properties: {
                Members: {
                  relation: { data_source_id: content.table.data_source_id, single_property: {} },
                },
              },
            },
            { method: "PATCH" },
          )
          yield* save({ pending: undefined })
        }
        if (!content.properties.Upstream) {
          yield* save({ pending: "relation:upstream" })
          yield* api.request(
            `v1/data_sources/${content.table.data_source_id}`,
            {
              properties: {
                Upstream: {
                  relation: {
                    data_source_id: upstream.table.data_source_id,
                    dual_property: { synced_property_name: "Skills" },
                  },
                },
              },
            },
            { method: "PATCH" },
          )
          yield* save({ pending: undefined })
        }
        const finalContent = yield* inspect(content.table.database_id)
        const finalUpstream = yield* inspect(upstream.table.database_id)
        yield* checked(() => {
          validateFields(finalContent.properties, contentExpected, true)
          validateFields(finalUpstream.properties, upstreamExpected, true)
          checkRelation(finalContent.properties.Members, finalContent.table.data_source_id, false)
          checkRelation(
            finalContent.properties.Upstream,
            finalUpstream.table.data_source_id,
            true,
            finalUpstream.table.property_ids.Skills,
          )
          checkRelation(
            finalUpstream.properties.Skills,
            finalContent.table.data_source_id,
            true,
            finalContent.table.property_ids.Upstream,
          )
        })
        yield* save({
          phase: "verified",
          content: finalContent.table,
          upstream: finalUpstream.table,
          pending: undefined,
        })
        const config = (yield* store.readJson("config.json", ConfigSchema)) ?? {}
        const sources = (config.sources ?? []).filter(
          (source) =>
            source.database_id !== finalContent.table.database_id &&
            source.database_id !== finalUpstream.table.database_id,
        )
        const existingSource = config.sources?.find(
          (source) => source.database_id === finalContent.table.database_id,
        )
        const alias =
          existingSource?.alias ?? `content-${finalContent.table.database_id.slice(0, 8)}`
        if (sources.some((source) => source.alias === alias))
          return yield* Effect.fail(
            fail(
              "CONFIG_CONFLICT",
              "The content registration alias is already used by another database.",
              { alias },
            ),
          )
        yield* store.writeJson("config.json", {
          ...config,
          sources: [
            ...sources,
            {
              alias,
              title: existingSource?.title ?? "Agent Content",
              role: "content",
              database_id: finalContent.table.database_id,
              data_source_ids: [finalContent.table.data_source_id],
            },
          ],
          upstream_database: finalUpstream.table.database_id,
          ...(state.set_default ? { default_database: finalContent.table.database_id } : {}),
        })
        yield* save({ phase: "published" })
        return {
          operation: "database_init",
          operation_id: operationId,
          status: "published",
          scope,
          content: state.content,
          upstream: state.upstream,
          verified: true,
        }
      }),
    )
  })
}

export const DatabaseInitOperationResultSchema = Schema.Struct({
  content: Schema.optional(TableSchema),
  upstream: Schema.optional(TableSchema),
  pending: Schema.optional(Schema.String),
  observations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        role: Schema.Literals(["content", "upstream"]),
        state: Schema.Literals(["confirmed", "missing", "ambiguous"]),
        candidates: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
})
export type DatabaseInitOperationResult = typeof DatabaseInitOperationResultSchema.Type

const DatabaseInitOperationFields = {
  domain: Schema.Literal("database_init"),
  operation_id: Schema.String,
  next: Schema.Struct({ argv: Schema.Array(Schema.String), reason: Schema.String }),
  resume_supported: Schema.Boolean,
}
export const DatabaseInitOperationSchema = Schema.Union([
  Schema.Struct({
    ...DatabaseInitOperationFields,
    state: Schema.Literal("published"),
    verified: Schema.Literal(true),
    result: Schema.Struct({
      ...DatabaseInitOperationResultSchema.fields,
      content: TableSchema,
      upstream: TableSchema,
    }),
  }),
  Schema.Struct({
    ...DatabaseInitOperationFields,
    state: Schema.Literals(["prepared", "applying", "verified"]),
    verified: Schema.Literal(false),
    result: Schema.NullOr(DatabaseInitOperationResultSchema),
  }),
])
export type DatabaseInitOperation = typeof DatabaseInitOperationSchema.Type

function databaseInitOperation(
  state: Init,
  result?: DatabaseInitOperationResult,
): DatabaseInitOperation {
  const summary = result ?? {
    ...(state.content ? { content: state.content } : {}),
    ...(state.upstream ? { upstream: state.upstream } : {}),
    ...(state.pending ? { pending: state.pending } : {}),
  }
  const complete = state.phase === "published"
  const status =
    state.phase === "published"
      ? {
          state: "published" as const,
          verified: true as const,
          result: { ...summary, content: summary.content!, upstream: summary.upstream! },
        }
      : { state: state.phase, verified: false as const, result: summary }
  return {
    domain: "database_init",
    operation_id: state.operation_id,
    ...status,
    next: {
      argv: ["ntn-skills", "operation", complete ? "reconcile" : "resume", state.operation_id],
      reason: complete
        ? "Inspect the confirmed database identities without replaying writes."
        : "Continue the recorded initialization, reconciling any pending creation before writing.",
    },
    resume_supported: true,
  }
}

function readDatabaseInitState(operationId: string, scope: string) {
  return Effect.gen(function* () {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Invalid database initialization operation ID."),
      )
    const store = yield* Store
    const keys = yield* store.listKeys(`database-init/${operationId}/`)
    const latest = keys
      .filter((key) => /^\d+\.json$/.test(key.split("/").at(-1)!))
      .sort(
        (a, b) =>
          Number(a.split("/").at(-1)!.replace(".json", "")) -
          Number(b.split("/").at(-1)!.replace(".json", "")),
      )
      .at(-1)
    if (!latest) return undefined
    const state = yield* store.readJson(latest, InitSchema)
    return state?.scope === scope && state.operation_id === operationId ? state : undefined
  })
}

export function listDatabaseInitOperations() {
  return Effect.gen(function* () {
    const scope = yield* authScope
    const store = yield* Store
    const keys = yield* store.listKeys("database-init/")
    const ids = [...new Set(keys.map((key) => key.split("/")[1]!).filter(Boolean))].sort()
    const operations: DatabaseInitOperation[] = []
    for (const id of ids) {
      const state = yield* readDatabaseInitState(id, scope)
      if (state) operations.push(databaseInitOperation(state))
    }
    return operations
  })
}

export function showDatabaseInitOperation(operationId: string) {
  return Effect.gen(function* () {
    const state = yield* readDatabaseInitState(operationId, yield* authScope)
    return state ? databaseInitOperation(state) : undefined
  })
}

function requireDatabaseInitState(operationId: string) {
  return Effect.gen(function* () {
    const state = yield* readDatabaseInitState(operationId, yield* authScope)
    if (!state)
      return yield* Effect.fail(
        fail(
          "OPERATION_NOT_FOUND",
          "No database initialization operation has this identity in the selected authentication scope.",
          { operation_id: operationId },
        ),
      )
    return state
  })
}

export function reconcileDatabaseInitOperation(operationId: string) {
  return Effect.gen(function* () {
    const state = yield* requireDatabaseInitState(operationId)
    const result: {
      content?: Table
      upstream?: Table
      pending?: string
      observations: NonNullable<DatabaseInitOperationResult["observations"]>[number][]
    } = {
      ...(state.pending ? { pending: state.pending } : {}),
      observations: [],
    }
    const observedTables: Partial<
      Record<"content" | "upstream", { table: Table; properties: Record<string, unknown> }>
    > = {}
    const requireComplete = state.phase === "published" || state.phase === "verified"
    for (const role of ["content", "upstream"] as const) {
      let id =
        state[role]?.database_id ??
        (role === "content" ? state.content_database_id : state.upstream_database_id)
      if (!id && state.pending === `create:${role}` && state.parent_page_id) {
        const candidates = yield* databaseCreateCandidates(state.parent_page_id, operationId, role)
        if (candidates.length !== 1) {
          result.observations.push({
            role,
            state: candidates.length === 0 ? "missing" : "ambiguous",
            candidates,
          })
          continue
        }
        id = candidates[0]!
      }
      if (!id) {
        result.observations.push({ role, state: "missing" })
        continue
      }
      const observed = yield* inspectDatabase(id)
      if (state[role] && state[role].data_source_id !== observed.table.data_source_id)
        return yield* Effect.fail(
          fail(
            "DATABASE_SCHEMA_CONFLICT",
            "The database data source no longer matches its recorded identity.",
          ),
        )
      yield* checked(() => {
        validateFields(
          observed.properties,
          expectedFields(
            observed.properties,
            role === "content" ? contentProperties : subscriptionProperties,
          ),
          requireComplete,
        )
        if (role === "content" && (observed.properties.Members !== undefined || requireComplete))
          checkRelation(observed.properties.Members, observed.table.data_source_id, false)
      })
      observedTables[role] = observed
      result[role] = observed.table
      result.observations.push({ role, state: "confirmed" })
    }
    yield* checked(() => {
      const content = observedTables.content
      const upstream = observedTables.upstream
      if (requireComplete && (!content || !upstream))
        throw fail(
          "DATABASE_SCHEMA_CONFLICT",
          "The confirmed initialization tables could not both be inspected.",
        )
      if (
        content?.properties.Upstream !== undefined ||
        upstream?.properties.Skills !== undefined ||
        requireComplete
      ) {
        if (!content || !upstream || !content.properties.Upstream || !upstream.properties.Skills)
          throw fail(
            "DATABASE_SCHEMA_CONFLICT",
            "Both sides of the Upstream/Skills relation must agree.",
          )
        checkRelation(
          content.properties.Upstream,
          upstream.table.data_source_id,
          true,
          upstream.table.property_ids.Skills,
        )
        checkRelation(
          upstream.properties.Skills,
          content.table.data_source_id,
          true,
          content.table.property_ids.Upstream,
        )
      }
    })
    return databaseInitOperation(state, result)
  })
}

export function resumeDatabaseInitOperation(operationId: string) {
  return Effect.gen(function* () {
    const state = yield* requireDatabaseInitState(operationId)
    yield* initializeDatabases({
      operation: operationId,
      ...(state.parent_page_id ? { parent: state.parent_page_id } : {}),
      ...(state.content_database_id ? { contentDatabase: state.content_database_id } : {}),
      ...(state.upstream_database_id ? { upstreamDatabase: state.upstream_database_id } : {}),
      ...(state.set_default !== undefined ? { setDefault: state.set_default } : {}),
    })
    return databaseInitOperation(yield* requireDatabaseInitState(operationId))
  })
}
