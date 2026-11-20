import { createHash } from "node:crypto"
import { Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient } from "effect/http"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { decode, fail, property, SkillsError, text, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { prepareCurrentSharedResource } from "../src/shared-current-resource.ts"
import type { CurrentFileContent } from "../src/shared-current-file.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import {
  sharedFileProperties,
  sharedRecordProperties,
  sharedSkillProperties,
} from "../src/shared-library.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "../src/shared-snapshot.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"
import { Store } from "../src/store.ts"

export const currentId = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
export const currentDigest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex")
export const currentBytes = (value: string) => new TextEncoder().encode(value)
export const currentSkillPage = currentId(1)
export const currentScope = currentDigest(
  JSON.stringify(["current-principal", "", "https://api.notion.com", "current-fixture"]),
)
export const currentRich = (id: string, value: string) => ({
  id,
  type: "rich_text",
  has_more: false,
  rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
})
const selection = (id: string, name: string) => ({ id, type: "select", select: { name } })
const relation = (id: string, targets: readonly string[] = [currentSkillPage]) => ({
  id,
  type: "relation",
  has_more: false,
  relation: targets.map((id) => ({ id })),
})
const propertyIds = (layout: Record<string, unknown>, overrides: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.keys(layout).map((name) => [
      name,
      overrides[name] ?? (name === "Name" ? "title" : name.toLowerCase().replaceAll(" ", "-")),
    ]),
  )
const skillFields = propertyIds(
  { ...sharedSkillProperties, Members: {}, Requires: {}, Origin: {} },
  { "Default Context": "default", "Main File ID": "main-id", "Current State": "state" },
)
const fileFields = propertyIds({ ...sharedFileProperties(currentId(4)), Origin: {} })
const recordFields = propertyIds(
  { ...sharedRecordProperties(currentId(4)), Origin: {} },
  { "Record ID": "record", "Entity ID": "entity" },
)
export const currentLibrary = {
  version: 1,
  library_id: "library-current",
  operation_id: "library-current",
  parent_page_id: currentId(2),
  skills: { database_id: currentId(3), data_source_id: currentId(4), property_ids: skillFields },
  files: { database_id: currentId(5), data_source_id: currentId(6), property_ids: fileFields },
  records: { database_id: currentId(7), data_source_id: currentId(8), property_ids: recordFields },
  sources: {
    database_id: currentId(20),
    data_source_id: currentId(21),
    property_ids: propertyIds(sourceDefinitionLayout(currentId(4), currentId(8))),
  },
} satisfies SharedLibrary
const frontmatter = "---\nname: authored-name\ndescription: Authored description.\n---\n\n"
const native = { kind: "native", mode: "100644", frontmatter: "" } satisfies CurrentFileContent
const initialTime = "2026-11-18T00:00:00.000Z"
export type CurrentFixtureCall = {
  readonly path: string
  readonly body: unknown
  readonly method: string
}

/** In-memory current service boundary. Unimplemented network operations fail immediately. */
export function currentSnapshotFixture(
  input: { fileCount?: number; httpClient?: HttpClient.HttpClient; root?: string } = {},
) {
  const main = {
    object: "page",
    id: currentSkillPage,
    last_edited_time: initialTime,
    parent: {
      type: "data_source_id",
      data_source_id: currentLibrary.skills.data_source_id,
      database_id: currentLibrary.skills.database_id,
    },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: "Current demo" }] },
      Description: currentRich("description", "Discover current content."),
      Kind: selection("kind", "skill"),
      Tags: { id: "tags", type: "multi_select", multi_select: [] },
      Enabled: { id: "enabled", type: "checkbox", checkbox: true },
      "Default Context": { id: "default", type: "checkbox", checkbox: false },
      "Skill ID": currentRich("skill-id", "demo"),
      "Main File ID": currentRich("main-id", "main-demo"),
      Content: currentRich("content", JSON.stringify({ ...native, frontmatter })),
      "Current State": selection("state", "ready"),
      Operation: currentRich("operation", ""),
      members: relation("members", []),
      requires: relation("requires", []),
      origin: relation("origin", []),
    },
  }
  const files = Array.from({ length: input.fileCount ?? 2 }, (_, n) => ({
    object: "page",
    id: currentId(100 + n),
    last_edited_time: initialTime,
    parent: {
      type: "data_source_id",
      data_source_id: currentLibrary.files.data_source_id,
      database_id: currentLibrary.files.database_id,
    },
    properties: {
      Name: { id: "title", type: "title", title: [{ plain_text: `Supporting ${n}` }] },
      "File ID": currentRich("file-id", `support-${n}`),
      Path: currentRich("path", `references/${n}.md`),
      Skill: relation("skill"),
      Content: currentRich("content", JSON.stringify(native)),
      Origin: {
        id: "origin",
        type: "rollup",
        rollup: { type: "array", array: [], function: "show_unique" },
      },
    },
  }))
  const bodies = new Map([
    [currentSkillPage, "# Current body\n\nKeep the author's content.\n"],
    ...files.map(
      (row, n) => [row.id, `# Supporting ${n}\n\nComplete supporting text ${n}.\n`] as const,
    ),
  ])
  const records = new Map<string, unknown>()
  const sources = new Map<string, unknown>()
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const calls: CurrentFixtureCall[] = []
  let metrics = createRequestMetrics()
  let generation = 0
  let failure: ((call: CurrentFixtureCall) => SkillsError | undefined) | undefined
  let alter: ((call: CurrentFixtureCall, response: unknown) => unknown) | undefined

  const store: Store["Service"] = {
    root: input.root ?? "/unused-current-fixture",
    configRoot: input.root ?? "/unused-current-fixture",
    cacheRoot: input.root ?? "/unused-current-fixture",
    reserveCacheGeneration: () => Effect.sync(() => ++generation),
    listKeys: (prefix) =>
      Effect.sync(() =>
        [...json.keys()].filter((key) => key.startsWith(`${prefix.replace(/\/$/u, "")}/`)),
      ),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          json.delete(key)
          return { key, retention_path: `retired/${key}` }
        }),
      ),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid current fixture cache."),
      }),
    writeJson: (key, value) =>
      Effect.try({
        try: () => {
          if (
            key.startsWith("snapshots/") &&
            json.has(key) &&
            canonicalSharedJson(json.get(key)) !== canonicalSharedJson(value)
          )
            throw fail("IMMUTABLE_CONFLICT", "A selected local artifact was overwritten.")
          json.set(key, structuredClone(value))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("FIXTURE_ERROR", "Local write failed."),
      }),
    readBytes: (key) =>
      Effect.suspend(() => {
        const bytes = objects.get(key)
        return bytes === undefined
          ? Effect.fail(fail("SNAPSHOT_MISSING", "Selected bytes are absent."))
          : Effect.succeed(new Uint8Array(bytes))
      }),
    writeBytes: (key, value) =>
      Effect.try({
        try: () => {
          const previous = objects.get(key)
          if (previous !== undefined && currentDigest(previous) !== currentDigest(value))
            throw fail("IMMUTABLE_CONFLICT", "Cached content identity changed.")
          objects.set(key, new Uint8Array(value))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("FIXTURE_ERROR", "Object write failed."),
      }),
    backup: () => Effect.die(new Error("Unexpected backup.")),
    output: () => Effect.die(new Error("Unexpected export.")),
  }
  function matches(row: unknown, raw: unknown): boolean {
    const filter = property(raw)
    if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
    if (Array.isArray(filter.or)) return filter.or.some((part) => matches(row, part))
    const field = Object.values(property(property(row).properties))
      .map(property)
      .find((value) => value.id === filter.property)
    if (field === undefined) return false
    if (filter.relation !== undefined)
      return (
        Array.isArray(field.relation) &&
        field.relation.some((value) => property(value).id === property(filter.relation).contains)
      )
    if (filter.rich_text !== undefined) {
      const selector = property(filter.rich_text),
        value = text(field.rich_text)
      if (typeof selector.starts_with === "string") return value.startsWith(selector.starts_with)
      return value === selector.equals
    }
    if (filter.select !== undefined)
      return property(field.select).name === property(filter.select).equals
    if (filter.checkbox !== undefined) return field.checkbox === property(filter.checkbox).equals
    return false
  }
  function query(values: readonly unknown[], body: unknown) {
    const request = property(body)
    const offset =
      request.start_cursor === undefined
        ? 0
        : Number(String(request.start_cursor).slice("offset-".length))
    const selected = values.filter(
      (value) => request.filter === undefined || matches(value, request.filter),
    )
    const end = Math.min(selected.length, offset + 100)
    return {
      object: "list",
      results: structuredClone(selected.slice(offset, end)),
      has_more: end < selected.length,
      next_cursor: end < selected.length ? `offset-${end}` : null,
    }
  }
  const api: Notion["Service"] = {
    version: Effect.succeed("current-fixture"),
    credentialIdentity: Effect.succeed("current-fixture"),
    connectionIdentity: Effect.succeed({
      principal: "current-principal",
      credential: "current-fixture",
      connection: "current-fixture",
      workspace: null,
      api_origin: "https://api.notion.com",
    }),
    get metrics() {
      return metrics
    },
    request: (path, body, options) =>
      Effect.gen(function* () {
        const finish = metrics.begin({
          path,
          method: options?.method ?? (body === undefined ? "GET" : "POST"),
          content: options?.content,
          key: canonicalSharedJson([path, body ?? null]),
          requestBytes: body === undefined ? 0 : currentBytes(JSON.stringify(body)).byteLength,
        })
        const result = yield* Effect.suspend(() => {
          const call = {
            path,
            body,
            method: options?.method ?? (body === undefined ? "GET" : "POST"),
          }
          calls.push(call)
          const error = failure?.(call)
          if (error !== undefined) return Effect.fail(error)
          let result: unknown
          if (call.method === "GET" && path === `v1/databases/${currentLibrary.skills.database_id}`)
            result = {
              id: currentLibrary.skills.database_id,
              database_type: null,
              title: [{ plain_text: "Current Skills" }],
              data_sources: [{ id: currentLibrary.skills.data_source_id, name: "Current Skills" }],
              description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(currentLibrary) }],
            }
          else if (call.method === "GET" && path === `v1/pages/${main.id}`)
            result = structuredClone(main)
          else if (call.method === "GET" && /\/markdown(?:\?|$)/u.test(path)) {
            const page = path.split("/")[2]
            const markdown = page === undefined ? undefined : bodies.get(page)
            if (markdown === undefined)
              return Effect.fail(fail("NOTION_NOT_FOUND", "Body unavailable."))
            result = { id: page, markdown, truncated: false, unknown_block_ids: [] }
          } else if (
            call.method === "POST" &&
            path.startsWith(`v1/data_sources/${currentLibrary.skills.data_source_id}/query`)
          )
            result = query([main], body)
          else if (
            call.method === "POST" &&
            path.startsWith(`v1/data_sources/${currentLibrary.files.data_source_id}/query`)
          )
            result = query(files, body)
          else if (
            call.method === "POST" &&
            path.startsWith(`v1/data_sources/${currentLibrary.records.data_source_id}/query`)
          )
            result = query([...records.values()], body)
          else if (
            call.method === "POST" &&
            path.startsWith(`v1/data_sources/${currentLibrary.sources.data_source_id}/query`)
          )
            result = query([...sources.values()], body)
          else
            return Effect.fail(
              fail("UNEXPECTED_REQUEST", "Current reader attempted an unexpected request.", {
                method: call.method,
                path,
              }),
            )
          return Effect.succeed(alter === undefined ? result : alter(call, result))
        }).pipe(Effect.result)
        if (result._tag === "Failure") {
          finish({ outcome: "failure", responseBytes: 0 })
          return yield* Effect.fail(result.failure)
        }
        finish({ responseBytes: currentBytes(JSON.stringify(result.success)).byteLength })
        return result.success
      }),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
    Layer.succeed(
      HttpClient.HttpClient,
      input.httpClient ?? HttpClient.make(() => Effect.die(new Error("Unexpected provider HTTP."))),
    ),
  )
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Store | Notion | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const open = (
    options: Partial<
      Omit<OpenSharedSnapshotInput, "library" | "target" | "scope" | "startedAt">
    > = {},
  ) =>
    run(
      openSharedSnapshot({
        library: currentLibrary,
        target: main.id,
        scope: currentScope,
        startedAt: Date.now(),
        ...options,
      }),
    )
  async function resource(
    n: number,
    path: string,
    bytes: Uint8Array,
    mode: "100644" | "100755" = "100644",
    attachment?: unknown,
  ) {
    const file = files[n]
    if (file === undefined) throw new Error("Missing fixture File.")
    const prepared = await run(
      prepareCurrentSharedResource(bytes, mode, {
        storage: attachment === undefined ? "auto" : "attachment",
      }),
    )
    if (prepared.status !== "inline" && attachment === undefined)
      throw new Error("A fixture attachment requires its current Notion file locator.")
    file.properties.Content = currentRich("content", JSON.stringify(prepared.content))
    file.properties.Path = currentRich("path", path)
    const envelope = canonicalSharedJson({
      version: 1,
      operation_id: `store-${prepared.content.object_id}`,
      payload: prepared.manifest,
    })
    records.set(prepared.content.object_id, {
      object: "page",
      id: currentId(900 + n),
      last_edited_time: initialTime,
      parent: {
        type: "data_source_id",
        data_source_id: currentLibrary.records.data_source_id,
        database_id: currentLibrary.records.database_id,
      },
      properties: {
        Name: { id: "title", type: "title", title: [{ plain_text: prepared.content.object_id }] },
        "Record ID": currentRich("record", prepared.content.object_id),
        Kind: selection("kind", "resource"),
        "Entity ID": currentRich("entity", prepared.content.object_id),
        Hash: currentRich("hash", currentDigest(envelope)),
        Payload: currentRich("payload", envelope),
        Skill: relation("skill"),
        Origin: relation("origin", []),
        Resource: {
          id: "resource",
          type: "files",
          files: attachment === undefined ? [] : [attachment],
        },
      },
    })
    return prepared.content
  }
  return {
    main,
    files,
    bodies,
    records,
    sources,
    json,
    objects,
    calls,
    run,
    open,
    target: (
      target: Parameters<typeof targetSnapshot>[0],
      options: Parameters<typeof targetSnapshot>[1] = {},
    ) => run(targetSnapshot(target, options)),
    resource,
    clearCalls: () => {
      calls.length = 0
      metrics = createRequestMetrics()
    },
    requestMetrics: () => metrics.snapshot(),
    failRequests: (value: typeof failure) => {
      failure = value
    },
    alterResponses: (value: typeof alter) => {
      alter = value
    },
    bodyCalls: () => calls.filter((call) => call.path.includes("/markdown")),
    recordCalls: () =>
      calls.filter((call) => call.path.includes(currentLibrary.records.data_source_id)),
    semanticWrites: () =>
      calls.filter(
        (call) =>
          call.method !== "GET" && !(call.method === "POST" && call.path.includes("/query")),
      ),
    selectedBytes: (snapshot: Snapshot, path: string) => {
      const file = snapshot.files.find((file) => file.path === path)
      const value = file === undefined ? undefined : objects.get(`objects/${file.sha256}`)
      if (value === undefined) throw new Error("No materialized selected file.")
      return value
    },
  }
}
