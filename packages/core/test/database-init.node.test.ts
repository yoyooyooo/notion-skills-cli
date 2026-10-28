import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Crypto, Effect, FileSystem, Path } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  initializeDatabases,
  contentProperties,
  subscriptionProperties,
  resolveDatabasePropertyIds,
  listDatabaseInitOperations,
  showDatabaseInitOperation,
  reconcileDatabaseInitOperation,
  resumeDatabaseInitOperation,
} from "../src/database-init.ts"
import { Store, StoreLive } from "../src/store.ts"
import { Notion } from "../src/notion.ts"
import { ConfigSchema, fail, property, SkillsError } from "../src/model.ts"

const parent = "11111111-1111-4111-8111-111111111111"
const content = "22222222-2222-4222-8222-222222222222"
const upstream = "33333333-3333-4333-8333-333333333333"
const contentDs = "44444444-4444-4444-8444-444444444444"
const upstreamDs = "55555555-5555-4555-8555-555555555555"
const fields = (input: Record<string, unknown>, title: string) =>
  Object.fromEntries(
    Object.entries(input).map(([name, raw]) => {
      const type = Object.keys(property(raw))[0]!
      return [
        name === "Name" ? title : name,
        { ...property(raw), type, id: type === "title" ? "title" : name },
      ]
    }),
  )

interface InitFixture {
  readonly api: {
    readonly version: Effect.Effect<string, SkillsError>
    readonly credentialIdentity: Effect.Effect<string, SkillsError>
    readonly request: (
      path: string,
      body?: unknown,
      options?: { readonly method?: "GET" | "POST" | "PATCH"; readonly file?: string },
    ) => Effect.Effect<unknown, SkillsError>
  }
  readonly tables: Map<
    string,
    {
      id: string
      parent: { database_id: string }
      title: readonly unknown[]
      properties: Record<string, unknown>
    }
  >
  readonly counts: () => { creates: number; patches: number }
  readonly switchScope: () => void
  readonly loseCreate: () => void
}

function fixture(): InitFixture {
  const tables: InitFixture["tables"] = new Map([
    [
      content,
      {
        id: contentDs,
        parent: { database_id: content },
        title: [],
        properties: fields(contentProperties, "Skill name"),
      },
    ],
  ])
  let credential = "fixture",
    creates = 0,
    patches = 0,
    loseCreate = false
  const api = Notion.of({
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, body, options) =>
      Effect.try({
        try: () => {
          if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
          if (path === `v1/pages/${parent}`) return { id: parent }
          if (path.startsWith(`v1/blocks/${parent}/children`))
            return {
              results: tables.has(upstream) ? [{ id: upstream, type: "child_database" }] : [],
              has_more: false,
            }
          if (path === "v1/databases") {
            creates++
            expect(property(property(body).parent).page_id).toBe(parent)
            const table = {
              id: upstreamDs,
              parent: { database_id: upstream },
              title: [],
              properties: fields(
                property(property(body).initial_data_source).properties as Record<string, unknown>,
                "Subscription name",
              ),
            }
            tables.set(upstream, table)
            if (loseCreate) {
              loseCreate = false
              throw fail("WRITE_OUTCOME_UNKNOWN", "Lost create response")
            }
            return { id: upstream, data_sources: [{ id: upstreamDs }] }
          }
          const dbId = path.startsWith("v1/databases/")
            ? path.slice("v1/databases/".length)
            : undefined
          if (dbId && tables.has(dbId))
            return {
              id: dbId,
              database_type: null,
              title: [],
              description: [
                {
                  plain_text:
                    dbId === upstream
                      ? "ntn-skills:partial-init:upstream"
                      : "Existing user content",
                },
              ],
              data_sources: [{ id: tables.get(dbId)!.id, name: "fixture" }],
            }
          const table = [...tables.values()].find(
            (candidate) => path === `v1/data_sources/${candidate.id}`,
          )
          if (table) {
            if (options?.method === "PATCH") {
              patches++
              for (const [name, raw] of Object.entries(property(property(body).properties))) {
                const field = property(raw)
                if (field.relation) {
                  const relation = property(field.relation),
                    dual = relation.dual_property !== undefined
                  table.properties[name] = {
                    id: name,
                    type: "relation",
                    relation: {
                      ...relation,
                      type: dual ? "dual_property" : "single_property",
                      ...(dual
                        ? {
                            dual_property: {
                              synced_property_id: "Skills",
                              synced_property_name: "Skills",
                            },
                          }
                        : {}),
                    },
                  }
                  if (dual)
                    tables.get(upstream)!.properties.Skills = {
                      id: "Skills",
                      type: "relation",
                      relation: {
                        data_source_id: contentDs,
                        type: "dual_property",
                        dual_property: {
                          synced_property_id: "Upstream",
                          synced_property_name: "Upstream",
                        },
                      },
                    }
                } else table.properties[name] = { ...field, id: name, type: Object.keys(field)[0] }
              }
            }
            return structuredClone(table)
          }
          throw fail("UNEXPECTED", `Unexpected init request ${path}`)
        },
        catch: (error) => error as SkillsError,
      }),
  })
  return {
    api,
    tables,
    counts: () => ({ creates, patches }),
    switchScope: () => {
      credential = "other"
    },
    loseCreate: () => {
      loseCreate = true
    },
  }
}

async function isolated(
  body: (
    f: InitFixture,
  ) => Effect.Effect<
    void,
    unknown,
    Store | Notion | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >,
) {
  const root = await mkdtemp(join(tmpdir(), "ntn-native-init-"))
  const roots = {
    NTN_SKILLS_HOME: join(root, "state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "config"),
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
  }
  const f = fixture()
  const isolatedBody = Effect.gen(function* () {
    const store = yield* Store
    expect(store.root).toBe(roots.NTN_SKILLS_HOME)
    expect(store.configRoot).toBe(roots.NTN_SKILLS_CONFIG_HOME)
    expect(store.cacheRoot).toBe(roots.NTN_SKILLS_CACHE_HOME)
    yield* body(f)
  })
  try {
    await Effect.runPromise(
      Effect.scoped(isolatedBody).pipe(
        Effect.provideService(Notion, f.api),
        Effect.provide(StoreLive),
        Effect.provide(NodeServices.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(roots))),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test(
  "native Skill name title and parent plus existing content create only missing upstream, retain IDs and replay exact operation",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson("config.json", {
          default_database: content,
          sources: [
            {
              role: "content",
              alias: "mine",
              title: "User title",
              database_id: content,
              data_source_ids: [contentDs],
            },
          ],
        })
        const initial = structuredClone(f.tables.get(content)!.properties)
        const input = { parent, contentDatabase: content, operation: "partial-init" }
        const result = yield* initializeDatabases(input)
        expect(result.content!.database_id).toBe(content)
        expect(result.content!.data_source_id).toBe(contentDs)
        expect(result.content!.property_ids["Skill name"]).toBe("title")
        expect(result.upstream!.database_id).toBe(upstream)
        expect(f.counts().creates).toBe(1)
        expect(f.tables.get(content)!.properties["Skill name"]).toEqual(initial["Skill name"])
        expect(f.tables.get(content)!.properties.Name).toBeUndefined()
        expect((yield* resolveDatabasePropertyIds(contentDs)).Name).toBe("title")
        const config = yield* store.readJson("config.json", ConfigSchema)
        expect(config!.sources![0]).toMatchObject({
          alias: "mine",
          title: "User title",
          database_id: content,
        })
        expect(config!.upstream_database).toBe(upstream)
        const counts = f.counts()
        expect((yield* initializeDatabases(input)).content!.database_id).toBe(content)
        expect(f.counts()).toEqual(counts)
        const changed = yield* initializeDatabases({ ...input, upstreamDatabase: upstream }).pipe(
          Effect.result,
        )
        expect(changed._tag === "Failure" && changed.failure.code).toBe("OPERATION_CONFLICT")
        f.switchScope()
        const scoped = yield* initializeDatabases(input).pipe(Effect.result)
        expect(scoped._tag === "Failure" && scoped.failure.code).toBe("OPERATION_CONFLICT")
        expect(f.counts()).toEqual(counts)
      }),
    ),
  30000,
)

test(
  "a published initialization upgrades missing origin fields on the exact same tables",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const input = { parent, contentDatabase: content, operation: "source-upgrade" }
        const initial = yield* initializeDatabases(input)
        const schema = f.tables.get(content)!.properties
        delete schema["Source Type"]
        delete schema["Builtin ID"]
        const before = f.counts()
        const upgraded = yield* initializeDatabases(input)
        expect(upgraded.operation_id).toBe(initial.operation_id)
        expect(upgraded.content!.database_id).toBe(content)
        expect(upgraded.content!.data_source_id).toBe(contentDs)
        expect(f.counts()).toEqual({ creates: before.creates, patches: before.patches + 1 })
        expect(property(property(schema["Source Type"]).select).options).toEqual([
          { name: "builtin" },
          { name: "upstream" },
          { name: "manual" },
        ])
        expect(property(schema["Builtin ID"]).type).toBe("rich_text")
        expect(schema["Skill name"]).toHaveProperty("id", "title")
      }),
    ),
  30000,
)

test(
  "repeating initialization adds the upstream URL column without replacing tables or accepting a wrong existing type",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const input = { parent, contentDatabase: content, operation: "source-url-upgrade" }
        const initial = yield* initializeDatabases(input)
        const schema = f.tables.get(upstream)!.properties
        delete schema["Source URL"]
        const before = f.counts()
        const upgraded = yield* initializeDatabases(input)
        expect(upgraded.upstream!.data_source_id).toBe(initial.upstream!.data_source_id)
        expect(schema["Source URL"]).toMatchObject({ type: "url" })
        expect(f.counts()).toEqual({ creates: before.creates, patches: before.patches + 1 })
        schema["Source URL"] = { id: "Source URL", type: "rich_text", rich_text: {} }
        const after = f.counts()
        const refused = yield* initializeDatabases(input).pipe(Effect.result)
        expect(refused._tag === "Failure" && refused.failure.code).toBe("DATABASE_SCHEMA_CONFLICT")
        expect(f.counts()).toEqual(after)
      }),
    ),
  30000,
)

test(
  "origin schema refuses extra choices without changing either table",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const schema = f.tables.get(content)!.properties
        property(schema["Source Type"]).select = {
          options: [
            { name: "builtin" },
            { name: "upstream" },
            { name: "manual" },
            { name: "guessed" },
          ],
        }
        const before = f.counts()
        const result = yield* initializeDatabases({ parent, contentDatabase: content }).pipe(
          Effect.result,
        )
        expect(result._tag === "Failure" && result.failure.code).toBe("DATABASE_SCHEMA_CONFLICT")
        expect(f.counts()).toEqual(before)
      }),
    ),
  30000,
)

test(
  "unknown missing-table create reconciles exact operation marker without another create",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        f.loseCreate()
        const input = { parent, contentDatabase: content, operation: "partial-init" }
        const first = yield* initializeDatabases(input).pipe(Effect.result)
        expect(first._tag === "Failure" && first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        const recovered = yield* initializeDatabases(input)
        expect(recovered.content!.database_id).toBe(content)
        expect(recovered.upstream!.database_id).toBe(upstream)
        expect(f.counts().creates).toBe(1)
      }),
    ),
  30000,
)

test(
  "mismatching relation and ambiguous native title reject before schema mutation",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        f.tables.set(upstream, {
          id: upstreamDs,
          parent: { database_id: upstream },
          title: [],
          properties: fields(subscriptionProperties, "Subscription name"),
        })
        f.tables.get(content)!.properties.Members = {
          id: "Members",
          type: "relation",
          relation: { data_source_id: upstreamDs, type: "single_property", single_property: {} },
        }
        const input = { contentDatabase: content, upstreamDatabase: upstream, operation: "attach" }
        const conflict = yield* initializeDatabases(input).pipe(Effect.result)
        expect(conflict._tag === "Failure" && conflict.failure.code).toBe(
          "DATABASE_SCHEMA_CONFLICT",
        )
        expect(f.counts()).toEqual({ creates: 0, patches: 0 })
        delete f.tables.get(content)!.properties.Members
        f.tables.get(content)!.properties.Name = { id: "other", type: "title", title: {} }
        const title = yield* initializeDatabases(input).pipe(Effect.result)
        expect(title._tag === "Failure" && title.failure.code).toBe("DATABASE_SCHEMA_CONFLICT")
        expect(f.counts()).toEqual({ creates: 0, patches: 0 })
      }),
    ),
  30000,
)

test.each([
  "content field type",
  "content title",
  "content select",
  "content Members target",
  "content Upstream without target",
  "upstream inaccessible",
  "upstream database identity",
  "upstream field type",
  "upstream Skills without target",
  "both database identity",
  "both data source identity",
  "both data source parent",
  "both multiple data sources",
  "both trashed database",
  "both trashed data source",
  "both relation target",
  "both relation counterpart",
  "both one sided relation",
] as const)("initialization preflights %s before any remote mutation", async (scenario) =>
  isolated((f) =>
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.writeJson("config.json", { default_database: parent })
      const both = scenario.startsWith("both")
      const upstreamOnly = scenario.startsWith("upstream")
      if (both || upstreamOnly)
        f.tables.set(upstream, {
          id: upstreamDs,
          parent: { database_id: upstream },
          title: [],
          properties: fields(subscriptionProperties, "Subscription name"),
        })
      const contentFields = f.tables.get(content)!.properties
      const upstreamFields = f.tables.get(upstream)?.properties
      if (scenario === "content field type")
        contentFields.Description = { id: "Description", type: "checkbox", checkbox: {} }
      if (scenario === "content title")
        contentFields.Name = { id: "other", type: "title", title: {} }
      if (scenario === "content select")
        contentFields.Kind = { id: "Kind", type: "select", select: { options: [] } }
      if (scenario === "content Members target")
        contentFields.Members = {
          id: "Members",
          type: "relation",
          relation: { data_source_id: upstreamDs, type: "single_property", single_property: {} },
        }
      if (scenario === "upstream field type")
        upstreamFields!.Enabled = { id: "Enabled", type: "rich_text", rich_text: {} }
      if (
        scenario === "content Upstream without target" ||
        scenario.startsWith("both relation") ||
        scenario === "both one sided relation"
      )
        contentFields.Upstream = {
          id: "Upstream",
          type: "relation",
          relation: {
            data_source_id: scenario === "both relation target" ? contentDs : upstreamDs,
            type: "dual_property",
            dual_property: { synced_property_id: "Skills", synced_property_name: "Skills" },
          },
        }
      if (scenario === "upstream Skills without target" || scenario.startsWith("both relation"))
        upstreamFields!.Skills = {
          id: "Skills",
          type: "relation",
          relation: {
            data_source_id: contentDs,
            type: "dual_property",
            dual_property: {
              synced_property_id: scenario === "both relation counterpart" ? "wrong" : "Upstream",
              synced_property_name: "Upstream",
            },
          },
        }
      const mutations: string[] = []
      const outcome = yield* initializeDatabases({
        parent,
        ...(!upstreamOnly ? { contentDatabase: content } : {}),
        ...(upstreamOnly || both ? { upstreamDatabase: upstream } : {}),
        operation: "preflight",
      }).pipe(
        Effect.provideService(Notion, {
          ...f.api,
          request: (path, body, options) => {
            if (body !== undefined || (options?.method !== undefined && options.method !== "GET"))
              mutations.push(path)
            if (scenario === "upstream inaccessible" && path === `v1/databases/${upstream}`)
              return Effect.fail(fail("ACCESS_DENIED", "Upstream is inaccessible"))
            return f.api.request(path, body, options).pipe(
              Effect.map((raw) => {
                if (path === `v1/databases/${upstream}`) {
                  if (
                    scenario === "both database identity" ||
                    scenario === "upstream database identity"
                  )
                    return { ...property(raw), id: content }
                  if (scenario === "both multiple data sources")
                    return {
                      ...property(raw),
                      data_sources: [
                        { id: upstreamDs, name: "Upstream" },
                        { id: contentDs, name: "Content" },
                      ],
                    }
                  if (scenario === "both trashed database")
                    return { ...property(raw), in_trash: true }
                }
                if (path === `v1/data_sources/${upstreamDs}`) {
                  if (scenario === "both data source identity")
                    return { ...property(raw), id: contentDs }
                  if (scenario === "both data source parent")
                    return { ...property(raw), parent: { database_id: content } }
                  if (scenario === "both trashed data source")
                    return { ...property(raw), in_trash: true }
                }
                return raw
              }),
            )
          },
        }),
        Effect.result,
      )
      expect(outcome._tag === "Failure" && outcome.failure.code).toBe(
        scenario === "upstream inaccessible" ? "ACCESS_DENIED" : "DATABASE_SCHEMA_CONFLICT",
      )
      expect(mutations).toEqual([])
      expect(f.counts()).toEqual({ creates: 0, patches: 0 })
      expect(yield* store.readJson("config.json", ConfigSchema)).toEqual({
        default_database: parent,
      })
    }),
  ),
)

test("failed explicit preflight can resume after repair and fill missing fields", async () =>
  isolated((f) =>
    Effect.gen(function* () {
      const contentFields = f.tables.get(content)!.properties
      const description = contentFields.Description
      contentFields.Description = { id: "Description", type: "checkbox", checkbox: {} }
      const input = { parent, contentDatabase: content, operation: "partial-init" }
      expect((yield* initializeDatabases(input).pipe(Effect.result))._tag).toBe("Failure")
      expect(f.counts()).toEqual({ creates: 0, patches: 0 })
      contentFields.Description = description
      delete contentFields.References
      const result = yield* initializeDatabases(input)
      expect(result.status).toBe("published")
      expect(result.content!.database_id).toBe(content)
      expect(f.counts().creates).toBe(1)
      expect(property(contentFields.References).type).toBe("rich_text")
      const counts = f.counts()
      yield* initializeDatabases(input)
      expect(f.counts()).toEqual(counts)
    }),
  ))

test("preflight failure retains the pending unknown-create ledger for later recovery", async () =>
  isolated((f) =>
    Effect.gen(function* () {
      const store = yield* Store
      const input = { parent, contentDatabase: content, operation: "partial-init" }
      f.loseCreate()
      const lost = yield* initializeDatabases(input).pipe(Effect.result)
      expect(lost._tag === "Failure" && lost.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      const keys = yield* store.listKeys("database-init/partial-init/")
      const counts = f.counts()
      const contentFields = f.tables.get(content)!.properties
      const original = contentFields.Description
      contentFields.Description = { id: "Description", type: "checkbox", checkbox: {} }
      const rejected = yield* initializeDatabases(input).pipe(Effect.result)
      expect(rejected._tag === "Failure" && rejected.failure.code).toBe("DATABASE_SCHEMA_CONFLICT")
      expect(f.counts()).toEqual(counts)
      expect(yield* store.listKeys("database-init/partial-init/")).toEqual(keys)
      expect((yield* showDatabaseInitOperation("partial-init"))!.result!.pending).toBe(
        "create:upstream",
      )
      contentFields.Description = original
      expect((yield* initializeDatabases(input)).status).toBe("published")
      expect(f.counts().creates).toBe(1)
    }),
  ))

test(
  "database initialization operations expose stable scoped summaries without private journal fields",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const input = { parent, contentDatabase: content, operation: "partial-init" }
        yield* initializeDatabases(input)
        const shown = yield* showDatabaseInitOperation(input.operation)
        expect(shown).toMatchObject({
          domain: "database_init",
          operation_id: input.operation,
          state: "published",
          verified: true,
          resume_supported: true,
          result: { content: { database_id: content }, upstream: { database_id: upstream } },
          next: { argv: ["ntn-skills", "operation", "reconcile", input.operation] },
        })
        expect(shown).not.toHaveProperty("scope")
        expect(shown).not.toHaveProperty("event_index")
        expect(shown!.result).not.toHaveProperty("scope")
        expect(shown!.result).not.toHaveProperty("parent_page_id")
        expect(yield* listDatabaseInitOperations()).toEqual([shown])
        const counts = f.counts()
        const resumed = yield* resumeDatabaseInitOperation(input.operation)
        expect(resumed).toEqual(shown)
        expect(f.counts()).toEqual(counts)
        f.switchScope()
        expect(yield* listDatabaseInitOperations()).toEqual([])
        expect(yield* showDatabaseInitOperation(input.operation)).toBeUndefined()
        for (const action of [reconcileDatabaseInitOperation, resumeDatabaseInitOperation]) {
          const outcome = yield* action(input.operation).pipe(Effect.result)
          expect(outcome._tag === "Failure" && outcome.failure.code).toBe("OPERATION_NOT_FOUND")
        }
        expect(f.counts()).toEqual(counts)
      }),
    ),
  30000,
)

test(
  "reconcile observes lost-create markers read-only and resume retains default intent without another create",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.writeJson("config.json", { default_database: parent })
        f.loseCreate()
        const first = yield* initializeDatabases({
          parent,
          contentDatabase: content,
          operation: "partial-init",
          setDefault: true,
        }).pipe(Effect.result)
        expect(first._tag === "Failure" && first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        const keys = yield* store.listKeys("database-init/")
        const config = yield* store.readJson("config.json", ConfigSchema)
        const counts = f.counts()
        const observed = yield* reconcileDatabaseInitOperation("partial-init")
        expect(observed).toMatchObject({
          domain: "database_init",
          operation_id: "partial-init",
          state: "applying",
          verified: false,
          result: {
            pending: "create:upstream",
            content: { database_id: content },
            upstream: { database_id: upstream },
            observations: [
              { role: "content", state: "confirmed" },
              { role: "upstream", state: "confirmed" },
            ],
          },
        })
        expect(f.counts()).toEqual(counts)
        expect(yield* store.listKeys("database-init/")).toEqual(keys)
        expect(yield* store.readJson("config.json", ConfigSchema)).toEqual(config)
        expect((yield* showDatabaseInitOperation("partial-init"))!.result!.upstream).toBeUndefined()
        const resumed = yield* resumeDatabaseInitOperation("partial-init")
        expect(resumed).toMatchObject({
          domain: "database_init",
          operation_id: "partial-init",
          state: "published",
          verified: true,
          result: { content: { database_id: content }, upstream: { database_id: upstream } },
        })
        expect(f.counts().creates).toBe(1)
        expect((yield* store.readJson("config.json", ConfigSchema))!.default_database).toBe(content)
      }),
    ),
  30000,
)

test(
  "unresolved create reconciliation reports missing evidence and resume never recreates it",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        f.loseCreate()
        yield* initializeDatabases({
          parent,
          contentDatabase: content,
          operation: "partial-init",
        }).pipe(Effect.result)
        f.tables.delete(upstream)
        const store = yield* Store
        const keys = yield* store.listKeys("database-init/")
        const counts = f.counts()
        const observed = yield* reconcileDatabaseInitOperation("partial-init")
        expect(observed.result!.observations).toEqual([
          { role: "content", state: "confirmed" },
          { role: "upstream", state: "missing", candidates: [] },
        ])
        expect(yield* store.listKeys("database-init/")).toEqual(keys)
        const resumed = yield* resumeDatabaseInitOperation("partial-init").pipe(Effect.result)
        expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        expect(f.counts()).toEqual(counts)
      }),
    ),
  30000,
)

test(
  "unknown database initialization IDs are absent and cannot reconcile or resume a new operation",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        expect(yield* showDatabaseInitOperation("missing-init")).toBeUndefined()
        expect(yield* listDatabaseInitOperations()).toEqual([])
        for (const action of [reconcileDatabaseInitOperation, resumeDatabaseInitOperation]) {
          const outcome = yield* action("missing-init").pipe(Effect.result)
          expect(outcome._tag === "Failure" && outcome.failure.code).toBe("OPERATION_NOT_FOUND")
        }
        expect(f.counts()).toEqual({ creates: 0, patches: 0 })
      }),
    ),
  30000,
)

test(
  "published reconciliation inspects exact remote table identities using GET requests only",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        yield* initializeDatabases({ parent, contentDatabase: content, operation: "partial-init" })
        const store = yield* Store
        const keys = yield* store.listKeys("database-init/")
        const config = yield* store.readJson("config.json", ConfigSchema)
        const paths: string[] = []
        const observed = yield* reconcileDatabaseInitOperation("partial-init").pipe(
          Effect.provideService(Notion, {
            ...f.api,
            request: (path, body, options) => {
              expect(body).toBeUndefined()
              expect(options?.method ?? "GET").toBe("GET")
              paths.push(path)
              return f.api.request(path, body, options)
            },
          }),
        )
        expect(observed).toMatchObject({
          domain: "database_init",
          state: "published",
          verified: true,
          result: {
            content: { database_id: content, data_source_id: contentDs },
            upstream: { database_id: upstream, data_source_id: upstreamDs },
            observations: [
              { role: "content", state: "confirmed" },
              { role: "upstream", state: "confirmed" },
            ],
          },
        })
        expect(paths).toEqual([
          "v1/users/me",
          `v1/databases/${content}`,
          `v1/data_sources/${contentDs}`,
          `v1/databases/${upstream}`,
          `v1/data_sources/${upstreamDs}`,
        ])
        expect(yield* store.listKeys("database-init/")).toEqual(keys)
        expect(yield* store.readJson("config.json", ConfigSchema)).toEqual(config)
      }),
    ),
  30000,
)

test(
  "published reconciliation rejects relation, field type, select and missing-field drift without writing",
  async () =>
    isolated((f) =>
      Effect.gen(function* () {
        yield* initializeDatabases({ parent, contentDatabase: content, operation: "partial-init" })
        const store = yield* Store
        const keys = yield* store.listKeys("database-init/")
        const config = yield* store.readJson("config.json", ConfigSchema)
        const counts = f.counts()
        const contentFields = f.tables.get(content)!.properties
        const upstreamFields = f.tables.get(upstream)!.properties
        const cases = [
          {
            fields: contentFields,
            name: "Members",
            value: {
              id: "Members",
              type: "relation",
              relation: {
                data_source_id: upstreamDs,
                type: "single_property",
                single_property: {},
              },
            },
          },
          {
            fields: contentFields,
            name: "Upstream",
            value: {
              id: "Upstream",
              type: "relation",
              relation: {
                data_source_id: upstreamDs,
                type: "single_property",
                single_property: {},
              },
            },
          },
          {
            fields: upstreamFields,
            name: "Skills",
            value: {
              id: "Skills",
              type: "relation",
              relation: {
                data_source_id: contentDs,
                type: "dual_property",
                dual_property: { synced_property_id: "wrong", synced_property_name: "Upstream" },
              },
            },
          },
          {
            fields: contentFields,
            name: "Description",
            value: { id: "Description", type: "checkbox", checkbox: {} },
          },
          {
            fields: upstreamFields,
            name: "Status",
            value: { id: "Status", type: "select", select: { options: [{ name: "pending" }] } },
          },
          { fields: contentFields, name: "Description", value: undefined },
          { fields: upstreamFields, name: "Skills", value: undefined },
        ]
        for (const entry of cases) {
          const original = entry.fields[entry.name]
          if (entry.value === undefined) delete entry.fields[entry.name]
          else entry.fields[entry.name] = entry.value
          const result = yield* reconcileDatabaseInitOperation("partial-init").pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          entry.fields[entry.name] = original
        }
        expect(f.counts()).toEqual(counts)
        expect(yield* store.listKeys("database-init/")).toEqual(keys)
        expect(yield* store.readJson("config.json", ConfigSchema)).toEqual(config)
      }),
    ),
  30000,
)
