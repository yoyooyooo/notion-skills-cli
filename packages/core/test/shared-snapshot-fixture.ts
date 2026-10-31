import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { decode, fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot, type FixedSharedSource } from "../src/shared-snapshot.ts"
import { createRequestMetrics } from "../src/request-metrics.ts"

export const id = (value: number) =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex")
export const encode = (value: string) => new TextEncoder().encode(value)
export const skillPage = id(1)
const scope = "shared-fixture-scope"
const skillProperties = {
  Name: "title",
  Description: "description",
  Kind: "kind",
  Tags: "tags",
  Enabled: "enabled",
  "Default Context": "default",
  References: "references",
  "Skill ID": "skill_id",
  "Main File ID": "main_file_id",
  Projection: "projection",
  Source: "source",
}
const fileProperties = {
  Name: "title",
  "File ID": "file_id",
  Path: "path",
  Projection: "projection",
  Status: "status",
  Skill: "skill",
}
const recordProperties = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
export const library: SharedLibrary = {
  version: 1,
  library_id: "library-snapshot",
  operation_id: "library-snapshot",
  parent_page_id: id(2),
  skills: { database_id: id(3), data_source_id: id(4), property_ids: skillProperties },
  files: { database_id: id(5), data_source_id: id(6), property_ids: fileProperties },
  records: { database_id: id(7), data_source_id: id(8), property_ids: recordProperties },
}
export const rich = (propertyId: string, value: string) => ({
  id: propertyId,
  type: "rich_text",
  rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
  has_more: false,
})
const title = (value: string) => ({ id: "title", type: "title", title: [{ plain_text: value }] })
const selection = (propertyId: string, name: string) => ({
  id: propertyId,
  type: "select",
  select: { name },
})
const relation = (propertyId: string) => ({
  id: propertyId,
  type: "relation",
  relation: [{ id: skillPage }],
  has_more: false,
})

function matches(row: Record<string, unknown>, condition: unknown): boolean {
  const filter = property(condition)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  const key = filter.property
  if (typeof key !== "string") return false
  const value = property(property(row.properties)[key])
  if (filter.relation !== undefined)
    return (
      Array.isArray(value.relation) &&
      value.relation.some((item) => property(item).id === property(filter.relation).contains)
    )
  if (filter.select !== undefined)
    return property(value.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}

function responseProperty(propertyId: string, value: unknown) {
  const field = property(value)
  if (Array.isArray(field.rich_text))
    return { id: propertyId, type: "rich_text", rich_text: field.rich_text, has_more: false }
  if (Array.isArray(field.title)) return { id: propertyId, type: "title", title: field.title }
  if (Array.isArray(field.relation))
    return { id: propertyId, type: "relation", relation: field.relation, has_more: false }
  if (field.select !== undefined) return { id: propertyId, type: "select", select: field.select }
  throw new Error("Unexpected fixture property")
}

export function sharedSnapshotFixture(
  options: { readonly httpClient?: HttpClient.HttpClient; readonly fileCount?: number } = {},
) {
  const fileCount = options.fileCount ?? 3
  if (!Number.isSafeInteger(fileCount) || fileCount < 1)
    throw new Error("Fixture requires at least one main file")
  const editedAt = new Date(Date.now() - 2000).toISOString()
  const main: Record<string, unknown> = {
    object: "page",
    id: skillPage,
    last_edited_time: editedAt,
    parent: {
      type: "data_source_id",
      data_source_id: library.skills.data_source_id,
      database_id: library.skills.database_id,
    },
    properties: {
      title: title("Managed Name"),
      description: rich("description", "Managed description"),
      kind: selection("kind", "skill"),
      enabled: { id: "enabled", type: "checkbox", checkbox: true },
      default: { id: "default", type: "checkbox", checkbox: false },
      skill_id: rich("skill_id", "stable-skill"),
      main_file_id: rich("main_file_id", "file-main"),
      projection: rich("projection", ""),
      source: rich("source", ""),
    },
  }
  const files = Array.from({ length: fileCount - 1 }, (_, offset) => offset + 1).map((index) => ({
    object: "page",
    id: id(10 + index),
    last_edited_time: editedAt,
    parent: {
      type: "data_source_id",
      data_source_id: library.files.data_source_id,
      database_id: library.files.database_id,
    },
    properties: {
      title: title(`Reference ${index}`),
      file_id: rich("file_id", `file-${index}`),
      path: rich("path", `references/${index}.md`),
      projection: rich("projection", ""),
      status: selection("status", "custom"),
      skill: relation("skill"),
    },
  }))
  const bodies = new Map<string, string>([
    [skillPage, "# Native main\n"],
    ...files.map((file, offset): [string, string] => [
      file.id,
      offset === 0
        ? "Reference one\n"
        : offset === 1
          ? "Reference two\n"
          : `Reference ${offset + 1}\n`,
    ]),
  ])
  const records = new Map<string, Record<string, unknown>>()
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  let generation = 0
  let nextPage = 10_000 + fileCount
  let metrics = createRequestMetrics()
  let unknownNextRecord:
    | { readonly kind: "operation" | "object" | "file_event"; readonly accepted: boolean }
    | undefined
  const list = (values: readonly unknown[], request: unknown) => {
    const input = property(request)
    const cursor = input.start_cursor
    if (cursor !== undefined && (typeof cursor !== "string" || !/^offset-[0-9]+$/u.test(cursor)))
      throw new Error("Invalid fixture pagination cursor")
    const offset = cursor === undefined ? 0 : Number(String(cursor).slice("offset-".length))
    const pageSize = typeof input.page_size === "number" ? Math.min(100, input.page_size) : 100
    const end = Math.min(values.length, offset + pageSize)
    return {
      object: "list",
      results: structuredClone(values.slice(offset, end)),
      has_more: end < values.length,
      next_cursor: end < values.length ? `offset-${end}` : null,
    }
  }
  const store: Store["Service"] = {
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected legacy binding")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected legacy baseline")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    reserveCacheGeneration: () => Effect.sync(() => ++generation),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix))),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          if (!key.startsWith("operations/shared-observation-pending/"))
            throw new Error("Unexpected fixture retirement")
          json.delete(key)
          return { key, retention_path: `retired/${key}` }
        }),
      ),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid fixture state"),
      }),
    writeJson: (key, value) =>
      Effect.try({
        try: () => {
          if (
            key.startsWith("snapshots/") &&
            json.has(key) &&
            canonicalSharedJson(json.get(key)) !== canonicalSharedJson(value)
          )
            throw fail("IMMUTABLE_CONFLICT", "A fixed snapshot was overwritten")
          json.set(key, structuredClone(value))
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("FIXTURE_ERROR", "Fixture state write failed"),
      }),
    readBytes: (key) =>
      Effect.suspend(() => {
        const value = objects.get(key)
        return value === undefined
          ? Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture object"))
          : Effect.succeed(new Uint8Array(value))
      }),
    writeBytes: (key, value) =>
      Effect.try({
        try: () => {
          const previous = objects.get(key)
          if (previous !== undefined && digest(previous) !== digest(value))
            throw fail("IMMUTABLE_CONFLICT", "Object bytes changed")
          objects.set(key, new Uint8Array(value))
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("FIXTURE_ERROR", "Fixture object write failed"),
      }),
    output: () => Effect.die(new Error("Unexpected filesystem export")),
  }
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled-credential"),
    get metrics() {
      return metrics
    },
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        const finish = metrics.begin({
          path,
          method,
          content: options?.content,
          key: canonicalSharedJson([path, body ?? null]),
          requestBytes: body === undefined ? 0 : encode(JSON.stringify(body)).byteLength,
        })
        const response = yield* Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
          calls.push({ path, body, method })
          const url = new URL(path, "https://api.notion.com/")
          const pathname = url.pathname
          if (pathname === "/v1/users/me")
            return Effect.succeed({ id: "fixture-user", object: "user" })
          if (pathname === `/v1/databases/${library.skills.database_id}`)
            return Effect.succeed({
              object: "database",
              id: library.skills.database_id,
              database_type: null,
              title: [{ plain_text: "Shared library" }],
              description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
              data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
            })
          if (pathname === `/v1/data_sources/${library.skills.data_source_id}/query`)
            return Effect.succeed({
              object: "list",
              results: [structuredClone(main)],
              has_more: false,
              next_cursor: null,
            })
          if (pathname === `/v1/pages/${skillPage}`) return Effect.succeed(structuredClone(main))
          const filePage = files.find((file) => pathname === `/v1/pages/${file.id}`)
          if (filePage !== undefined) return Effect.succeed(structuredClone(filePage))
          const markdown = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(pathname)
          if (markdown) {
            const page = markdown[1]
            const value = page === undefined ? undefined : bodies.get(page)
            return value === undefined
              ? Effect.fail(fail("NOT_FOUND", "Fixture body unavailable"))
              : Effect.succeed({
                  id: page,
                  markdown: value,
                  truncated: false,
                  unknown_block_ids: [],
                })
          }
          if (pathname === `/v1/data_sources/${library.files.data_source_id}/query`)
            return Effect.succeed(list(files, body))
          if (pathname === `/v1/data_sources/${library.records.data_source_id}/query`) {
            const selectedProperties = new Set(url.searchParams.getAll("filter_properties"))
            const results = [...records.values()]
              .filter((row) => matches(row, property(body).filter))
              .map((row) => ({
                ...row,
                properties:
                  selectedProperties.size === 0
                    ? row.properties
                    : Object.fromEntries(
                        Object.entries(property(row.properties)).filter(([key, value]) =>
                          selectedProperties.has(String(property(value).id ?? key)),
                        ),
                      ),
              }))
            return Effect.succeed(list(results, body))
          }
          if (pathname === "/v1/pages" && method === "POST") {
            const page = id(nextPage++)
            const input = property(body)
            const properties = Object.fromEntries(
              Object.entries(property(input.properties)).map(([key, value]) => [
                key,
                responseProperty(key, value),
              ]),
            )
            const row = {
              object: "page",
              id: page,
              parent: { ...property(input.parent), database_id: library.records.database_id },
              properties,
            }
            const kind = property(property(properties.kind).select).name
            if (unknownNextRecord !== undefined && unknownNextRecord.kind === kind) {
              const accepted = unknownNextRecord.accepted
              unknownNextRecord = undefined
              if (accepted) records.set(page, row)
              return Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "The fixture discarded the original write response"),
              )
            }
            records.set(page, row)
            return Effect.succeed(row)
          }
          return Effect.fail(
            fail("UNEXPECTED_REQUEST", "Shared consumer attempted an unexpected request", {
              path,
              method,
            }),
          )
        }).pipe(Effect.result)
        if (response._tag === "Failure") {
          finish({
            outcome: "failure",
            responseBytes: encode(
              JSON.stringify({ code: response.failure.code, message: response.failure.message }),
            ).byteLength,
          })
          return yield* Effect.fail(response.failure)
        }
        finish({ responseBytes: encode(JSON.stringify(response.success)).byteLength })
        return response.success
      }),
  }
  const unexpectedHttp = HttpClient.make(() =>
    Effect.die(new Error("Unexpected HTTP request in shared Notion snapshot fixture")),
  )
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, api),
    Layer.succeed(HttpClient.HttpClient, options.httpClient ?? unexpectedHttp),
  )
  const run = <A, E>(
    effect: Effect.Effect<A, E, Store | Notion | Crypto.Crypto | HttpClient.HttpClient>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const target = (
    selected: Parameters<typeof targetSnapshot>[0],
    options: Parameters<typeof targetSnapshot>[1] = {},
  ) => Effect.runPromise(targetSnapshot(selected, options).pipe(Effect.provide(layer)))
  const open = (options: { forceFull?: boolean; fixedSource?: FixedSharedSource } = {}) =>
    run(
      openSharedSnapshot({
        library,
        target: skillPage,
        scope,
        startedAt: Date.now(),
        ...options,
      }),
    )
  const seedFact = (
    payload: Record<string, unknown>,
    kind: "file_event" | "object",
    entityId: string,
    recordId: string,
    operationId = recordId,
  ) => {
    const envelope = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
    const page = id(nextPage++)
    records.set(page, {
      object: "page",
      id: page,
      parent: {
        type: "data_source_id",
        data_source_id: library.records.data_source_id,
        database_id: library.records.database_id,
      },
      properties: {
        title: title(recordId),
        record: rich("record", recordId),
        kind: selection("kind", kind),
        entity: rich("entity", entityId),
        hash: rich("hash", digest(envelope)),
        payload: rich("payload", envelope),
        skill: relation("skill"),
      },
    })
  }
  return {
    main,
    files,
    bodies,
    records,
    calls,
    json,
    objects,
    open,
    target,
    run,
    seedFact,
    unknownEvent: () => {
      unknownNextRecord = { kind: "file_event", accepted: true }
    },
    unknownRecord: (kind: "operation" | "object" | "file_event", accepted: boolean) => {
      unknownNextRecord = { kind, accepted }
    },
    requestMetrics: () => metrics.snapshot(),
    readBodyCount: () => calls.filter((call) => call.path.includes("/markdown")).length,
    writeCount: () =>
      calls.filter((call) => call.path === "v1/pages" && call.method === "POST").length,
    clearCalls: () => {
      calls.length = 0
      metrics = createRequestMetrics()
    },
  }
}
