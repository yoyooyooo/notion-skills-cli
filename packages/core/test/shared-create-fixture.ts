import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { decode, fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import {
  sharedSnapshotFixture,
  library as baseLibrary,
  id,
  rich,
} from "./shared-snapshot-fixture.ts"

export const createLibrary: SharedLibrary = {
  ...baseLibrary,
  skills: {
    ...baseLibrary.skills,
    property_ids: { ...baseLibrary.skills.property_ids, Members: "members" },
  },
}
export const createRelationsLibrary: SharedLibrary = {
  ...createLibrary,
  skills: {
    ...createLibrary.skills,
    property_ids: { ...createLibrary.skills.property_ids, Requires: "requires" },
  },
}
function responseProperty(key: string, value: unknown) {
  const field = property(value)
  if (Array.isArray(field.rich_text))
    return { id: key, type: "rich_text", rich_text: field.rich_text, has_more: false }
  if (Array.isArray(field.title)) return { id: key, type: "title", title: field.title }
  if (Array.isArray(field.relation))
    return { id: key, type: "relation", relation: field.relation, has_more: false }
  if (field.select !== undefined) return { id: key, type: "select", select: field.select }
  if (typeof field.checkbox === "boolean")
    return { id: key, type: "checkbox", checkbox: field.checkbox }
  if (Array.isArray(field.multi_select))
    return { id: key, type: "multi_select", multi_select: field.multi_select }
  throw new Error("Unexpected native create fixture field")
}
function matches(row: Record<string, unknown>, condition: unknown): boolean {
  if (condition === undefined) return true
  const filter = property(condition)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  if (Array.isArray(filter.or)) return filter.or.some((part) => matches(row, part))
  if (typeof filter.property !== "string") throw new Error("Unknown fixture metadata filter")
  const field = property(property(row.properties)[filter.property])
  if (filter.relation !== undefined)
    return (
      Array.isArray(field.relation) &&
      field.relation.some((item) => property(item).id === property(filter.relation).contains)
    )
  if (filter.rich_text !== undefined)
    return text(field.rich_text) === property(filter.rich_text).equals
  if (filter.title !== undefined) return text(field.title) === property(filter.title).equals
  if (filter.select !== undefined)
    return property(field.select).name === property(filter.select).equals
  if (filter.checkbox !== undefined) return field.checkbox === property(filter.checkbox).equals
  throw new Error("Unknown fixture metadata predicate")
}
function listed(rows: readonly unknown[], body: unknown) {
  const request = property(body),
    cursor = request.start_cursor
  if (cursor !== undefined && (typeof cursor !== "string" || !/^offset-[0-9]+$/u.test(cursor)))
    throw new Error("Invalid native fixture cursor")
  const start = cursor === undefined ? 0 : Number(String(cursor).slice(7)),
    end = Math.min(rows.length, start + 100)
  return {
    object: "list",
    results: structuredClone(rows.slice(start, end)),
    has_more: end < rows.length,
    next_cursor: end < rows.length ? `offset-${end}` : null,
  }
}

/** Controlled Notion + memory Store; no user's store, credentials or provider requests. */
export function sharedCreateFixture(
  fixtureOptions: {
    readonly relations?: boolean
    readonly readback?: (wire: string) => string
    readonly recovery?: boolean
    readonly httpClient?: HttpClient.HttpClient
  } = {},
) {
  const base = sharedSnapshotFixture(
    fixtureOptions.httpClient === undefined ? {} : { httpClient: fixtureOptions.httpClient },
  )
  const skills = new Map<string, Record<string, unknown>>([
    [String(base.main.id), structuredClone(base.main)],
  ])
  const emptyRelations = (row: Record<string, unknown>) => {
    property(row.properties).tags ??= { id: "tags", type: "multi_select", multi_select: [] }
    for (const field of ["members", "requires"])
      property(row.properties)[field] ??= {
        id: field,
        type: "relation",
        relation: [],
        has_more: false,
      }
  }
  for (const row of skills.values()) emptyRelations(row)
  const files = new Map<string, Record<string, unknown>>(
    base.files.map((file) => [file.id, structuredClone(file)]),
  )
  const calls: Array<{ path: string; method: string; body: unknown; content?: string }> = []
  const retired = new Map<string, unknown>(),
    dispatch = "operations/shared-native-create/"
  let nextPage = 60_000,
    credential = "native-create-credential"
  let unknown:
    | {
        readonly stage:
          | "skill"
          | "file"
          | "enable"
          | "source_selection"
          | "outcome"
          | "recovery_outcome"
          | "recovery_receipt"
        readonly visible: boolean
      }
    | undefined
  let onCreate: ((page: Record<string, unknown>, kind: "skill" | "file") => void) | undefined
  let afterOutcome: (() => void) | undefined
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Store | Notion | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion,
          store = yield* Store
        const controlledStore: Store["Service"] = {
          ...store,
          writeJson: (key, value) =>
            Effect.gen(function* () {
              if (key.startsWith(dispatch)) {
                if (retired.has(key))
                  return yield* Effect.fail(
                    fail(
                      "STATE_CONFLICT",
                      "A retired native create cannot authorize another dispatch",
                    ),
                  )
                if (
                  base.json.has(key) &&
                  canonicalSharedJson(base.json.get(key)) !== canonicalSharedJson(value)
                )
                  return yield* Effect.fail(
                    fail("STATE_CONFLICT", "A frozen original create plan cannot be overwritten"),
                  )
              }
              yield* store.writeJson(key, value)
            }),
          retireKeys: (keys) =>
            Effect.sync(() =>
              keys.map((key) => {
                if (key.startsWith(dispatch) && base.json.has(key))
                  retired.set(key, structuredClone(base.json.get(key)))
                base.json.delete(key)
                return { key, retention_path: `retired/${key}` }
              }),
            ),
        }
        const controlled: Notion["Service"] = {
          ...api,
          credentialIdentity: Effect.sync(() => credential),
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              calls.push({
                path,
                method,
                body,
                ...(options?.content === undefined ? {} : { content: options.content }),
              })
              const pathname = new URL(path, "https://api.notion.com/").pathname
              if (method === "GET") {
                const retained = [...base.records.values()].find(
                  (row) => pathname === `/v1/pages/${row.id}`,
                )
                if (retained !== undefined) return Effect.succeed(structuredClone(retained))
              }
              if (pathname === `/v1/databases/${createLibrary.skills.database_id}`)
                return Effect.succeed({
                  object: "database",
                  id: createLibrary.skills.database_id,
                  database_type: null,
                  in_trash: false,
                  title: [{ plain_text: "Shared library" }],
                  description: [
                    {
                      plain_text:
                        LIBRARY_MARKER +
                        JSON.stringify(
                          fixtureOptions.relations ? createRelationsLibrary : createLibrary,
                        ),
                    },
                  ],
                  data_sources: [{ id: createLibrary.skills.data_source_id, name: "Skills" }],
                })
              if (pathname === `/v1/data_sources/${createLibrary.skills.data_source_id}/query`)
                return Effect.succeed(
                  listed(
                    [...skills.values()].filter((row) => matches(row, property(body).filter)),
                    body,
                  ),
                )
              if (pathname === `/v1/data_sources/${createLibrary.files.data_source_id}/query`)
                return Effect.succeed(
                  listed(
                    [...files.values()].filter((row) => matches(row, property(body).filter)),
                    body,
                  ),
                )
              const parent = property(property(body).parent).data_source_id
              if (
                pathname === "/v1/pages" &&
                method === "POST" &&
                (parent === createLibrary.skills.data_source_id ||
                  parent === createLibrary.files.data_source_id)
              ) {
                const kind = parent === createLibrary.skills.data_source_id ? "skill" : "file"
                const originalFileAdd =
                  kind === "file" &&
                  [...base.json.entries()].some(([key, value]) => {
                    const plan = property(property(value).plan),
                      properties = property(property(body).properties)
                    const owner = property(
                      properties[createLibrary.files.property_ids.Skill!],
                    ).relation
                    return (
                      key.startsWith("operations/shared-observation-pending/") &&
                      plan.kind === "file_management" &&
                      plan.action === "add" &&
                      plan.file_id ===
                        text(
                          property(properties[createLibrary.files.property_ids["File ID"]!])
                            .rich_text,
                        ) &&
                      Array.isArray(owner) &&
                      owner.length === 1 &&
                      property(owner[0]).id === plan.skill_page_id
                    )
                  })
                if (
                  ![...base.json.keys()].some((key) => key.startsWith(dispatch)) &&
                  !originalFileAdd
                )
                  return Effect.fail(
                    fail("TEST_CREATE_ORDER", "Native create ran before its durable original plan"),
                  )
                const uncertain = unknown?.stage === kind ? unknown : undefined
                if (uncertain) unknown = undefined
                let created: Record<string, unknown> | undefined
                if (uncertain?.visible !== false) {
                  const raw = property(body),
                    page = id(nextPage++)
                  if (typeof raw.markdown !== "string" || raw.markdown_version !== "v2")
                    return Effect.fail(
                      fail(
                        "TEST_NATIVE_BODY",
                        "Native creation did not include its frozen v2 candidate",
                      ),
                    )
                  created = {
                    object: "page",
                    id: page,
                    last_edited_time: new Date().toISOString(),
                    parent: {
                      type: "data_source_id",
                      data_source_id: parent,
                      database_id:
                        kind === "skill"
                          ? createLibrary.skills.database_id
                          : createLibrary.files.database_id,
                    },
                    properties: Object.fromEntries(
                      Object.entries(property(raw.properties)).map(([key, value]) => [
                        key,
                        responseProperty(key, value),
                      ]),
                    ),
                  }
                  if (kind === "skill") emptyRelations(created)
                  if (
                    kind === "skill" &&
                    property(property(created.properties).enabled).checkbox !== false
                  )
                    return Effect.fail(
                      fail(
                        "TEST_ENABLED_EARLY",
                        "A new Skill was enabled before its complete tree",
                      ),
                    )
                  ;(kind === "skill" ? skills : files).set(page, created)
                  // Basic fixtures model the independently observed XML H1
                  // response. Rich Markdown tests supply captured responses;
                  // the production projector is never the fixture's oracle.
                  base.bodies.set(
                    page,
                    fixtureOptions.readback === undefined
                      ? raw.markdown.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
                      : fixtureOptions.readback(raw.markdown),
                  )
                  onCreate?.(created, kind)
                }
                return uncertain === undefined
                  ? Effect.succeed(structuredClone(created))
                  : Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Lost original native page create response"),
                    )
              }
              const pageMatch = /^\/v1\/pages\/([^/]+)$/u.exec(pathname),
                selected =
                  pageMatch === null
                    ? undefined
                    : (skills.get(pageMatch[1] ?? "") ?? files.get(pageMatch[1] ?? ""))
              if (selected !== undefined) {
                if (method === "PATCH") {
                  const changes = property(property(body).properties)
                  const enable =
                    Object.keys(changes).length === 1 &&
                    property(changes[createLibrary.skills.property_ids.Enabled!]).checkbox ===
                      true &&
                    skills.has(String(selected.id))
                  const projectionId = skills.has(String(selected.id))
                    ? createLibrary.skills.property_ids.Projection!
                    : createLibrary.files.property_ids.Projection!
                  const projection =
                    fixtureOptions.recovery === true &&
                    Object.keys(changes).length === 1 &&
                    Array.isArray(property(changes[projectionId]).rich_text)
                  const mainFileId = createLibrary.skills.property_ids["Main File ID"]!
                  const fileIdentityId = createLibrary.files.property_ids["File ID"]!
                  const identityFill =
                    Object.keys(changes).length === 1 &&
                    ((skills.has(String(selected.id)) &&
                      Object.hasOwn(changes, mainFileId) &&
                      text(property(property(selected.properties)[mainFileId]).rich_text) === "") ||
                      (files.has(String(selected.id)) &&
                        Object.hasOwn(changes, fileIdentityId) &&
                        text(property(property(selected.properties)[fileIdentityId]).rich_text) ===
                          ""))
                  const sourceId = createLibrary.skills.property_ids.Source!
                  const sourceSelection =
                    skills.has(String(selected.id)) &&
                    Object.keys(changes).length === 2 &&
                    Array.isArray(property(changes[sourceId]).rich_text) &&
                    Array.isArray(property(changes[projectionId]).rich_text) &&
                    property(property(selected.properties).enabled).checkbox === false &&
                    text(property(property(selected.properties)[sourceId]).rich_text) === "" &&
                    text(property(property(selected.properties)[projectionId]).rich_text) === "" &&
                    /^bundle-[a-f0-9]{64}$/u.test(text(property(changes[sourceId]).rich_text))
                  if (!enable && !projection && !sourceSelection && !identityFill)
                    return Effect.fail(
                      fail(
                        "TEST_EXISTING_MUTATION",
                        "Native create attempted an existing-body or unrelated property replacement",
                      ),
                    )
                  const uncertain =
                    (enable && unknown?.stage === "enable") ||
                    (sourceSelection && unknown?.stage === "source_selection")
                      ? unknown
                      : undefined
                  if (uncertain) unknown = undefined
                  if (uncertain?.visible !== false) {
                    for (const [key, value] of Object.entries(changes))
                      property(selected.properties)[key] = responseProperty(key, value)
                    selected.last_edited_time = new Date().toISOString()
                  }
                  if (uncertain)
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Lost original enable response"),
                    )
                }
                return Effect.succeed(structuredClone(selected))
              }
              const markdown = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(pathname)
              if (markdown !== null && base.bodies.has(markdown[1] ?? "")) {
                if (method !== "GET")
                  return Effect.fail(
                    fail("TEST_BODY_OVERWRITE", "Native create attempted a body replacement"),
                  )
                return Effect.succeed({
                  id: markdown[1],
                  markdown: base.bodies.get(markdown[1] ?? ""),
                  truncated: false,
                  unknown_block_ids: [],
                })
              }
              if (
                pathname === "/v1/pages" &&
                method === "POST" &&
                parent === createLibrary.records.data_source_id
              ) {
                const envelopeText = text(
                  property(
                    property(property(body).properties)[
                      createLibrary.records.property_ids.Payload!
                    ],
                  ).rich_text,
                )
                const payload = property(property(JSON.parse(envelopeText)).payload)
                if (
                  payload.kind === "skill_create_recovery_response" &&
                  payload.action === "create_file_response" &&
                  unknown?.stage === "recovery_receipt"
                ) {
                  const uncertain = unknown
                  unknown = undefined
                  return (uncertain.visible ? api.request(path, body, options) : Effect.void).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Lost response-record publication"),
                      ),
                    ),
                  )
                }
                if (
                  (payload.kind === "skill_create_outcome" ||
                    payload.kind === "skill_create_recovery_outcome") &&
                  payload.status === "applied"
                ) {
                  const stage =
                    payload.kind === "skill_create_outcome" ? "outcome" : "recovery_outcome"
                  if (unknown?.stage !== stage)
                    return api
                      .request(path, body, options)
                      .pipe(Effect.tap(() => Effect.sync(() => afterOutcome?.())))
                  const uncertain = unknown
                  unknown = undefined
                  return (
                    uncertain.visible ? api.request(path, body, options) : Effect.succeed(undefined)
                  ).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        if (uncertain.visible) afterOutcome?.()
                      }),
                    ),
                    Effect.flatMap(() =>
                      Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Lost original create outcome response"),
                      ),
                    ),
                  )
                }
              }
              return api.request(path, body, options)
            }),
        }
        return yield* effect.pipe(
          Effect.provideService(Notion, controlled),
          Effect.provideService(Store, controlledStore),
        )
      }),
    )
  return {
    base,
    library: createLibrary,
    skills,
    files,
    calls,
    retired,
    run,
    clear: () => {
      calls.length = 0
      base.clearCalls()
    },
    unknown: (
      stage:
        | "skill"
        | "file"
        | "enable"
        | "source_selection"
        | "outcome"
        | "recovery_outcome"
        | "recovery_receipt",
      visible: boolean,
    ) => {
      unknown = { stage, visible }
    },
    onCreate: (hook: (page: Record<string, unknown>, kind: "skill" | "file") => void) => {
      onCreate = hook
    },
    afterOutcome: (hook: () => void) => {
      afterOutcome = hook
    },
    credential: (value: string) => {
      credential = value
    },
    pending: () => [...base.json.keys()].filter((key) => key.startsWith(dispatch)),
    writes: () =>
      calls.filter(
        (call) => call.method === "PATCH" || (call.method === "POST" && call.path === "v1/pages"),
      ),
    nativeCreates: () =>
      calls.filter(
        (call) =>
          call.path === "v1/pages" &&
          [createLibrary.skills.data_source_id, createLibrary.files.data_source_id].includes(
            String(property(property(call.body).parent).data_source_id),
          ),
      ),
    enablePatches: () => calls.filter((call) => call.method === "PATCH"),
    currentBodies: () => calls.filter((call) => call.path.includes("/markdown")),
    seedSkill: (
      page: string,
      skillId: string,
      name: string,
      kind: "skill" | "router" | "prompt" = "skill",
      enabled = true,
    ) => {
      const row = structuredClone(base.main)
      row.id = page
      const properties = property(row.properties)
      properties.skill_id = rich("skill_id", skillId)
      properties.title = { id: "title", type: "title", title: [{ plain_text: name }] }
      properties.kind = { id: "kind", type: "select", select: { name: kind } }
      properties.enabled = { id: "enabled", type: "checkbox", checkbox: enabled }
      emptyRelations(row)
      skills.set(page, row)
      return row
    },
    removeCompletion: (operationId: string) => {
      for (const [key, row] of base.records)
        if (text(property(property(row.properties).record).rich_text) === `outcome-${operationId}`)
          base.records.delete(key)
    },
  }
}
