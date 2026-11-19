import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

export const id = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0")
const properties = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, name.toLowerCase().replaceAll(" ", "-")]))
export const library: SharedLibrary = {
  version: 1,
  library_id: "writer-current",
  operation_id: "library-writer-current",
  parent_page_id: id(1),
  skills: {
    database_id: id(2),
    data_source_id: id(3),
    property_ids: properties([
      "Name",
      "Description",
      "Kind",
      "Enabled",
      "Default Context",
      "Skill ID",
      "Main File ID",
      "Content",
      "Current State",
      "Operation",
      "Origin",
    ]),
  },
  files: {
    database_id: id(4),
    data_source_id: id(5),
    property_ids: properties(["Name", "File ID", "Path", "Content", "Skill"]),
  },
  records: {
    database_id: id(6),
    data_source_id: id(7),
    property_ids: properties([
      "Name",
      "Record ID",
      "Entity ID",
      "Kind",
      "Hash",
      "Payload",
      "Skill",
      "Resource",
      "Origin",
    ]),
  },
}
export const testBytes = (value: string) => new TextEncoder().encode(value)
type Row = Record<string, unknown>
type FaultKind =
  | "skill-create"
  | "file-create"
  | "resource-create"
  | "append"
  | "retire-file"
  | "retire-resource"
export type CurrentWriteFault = {
  readonly kind: FaultKind
  readonly outcome: "accepted" | "absent" | "partial"
}
export type CurrentWriteCall = {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

function matches(row: unknown, input: unknown): boolean {
  const filter = property(input)
  if (Array.isArray(filter.or)) return filter.or.some((item) => matches(row, item))
  if (Array.isArray(filter.and)) return filter.and.every((item) => matches(row, item))
  if (Object.keys(filter).length === 0) return true
  const raw = property(property(property(row).properties)[String(filter.property)])
  if (filter.rich_text !== undefined)
    return text(raw.rich_text) === property(filter.rich_text).equals
  if (filter.select !== undefined)
    return property(raw.select).name === property(filter.select).equals
  if (filter.relation !== undefined) {
    const selector = property(filter.relation)
    if (!Array.isArray(raw.relation)) return false
    return selector.is_empty === true
      ? raw.relation.length === 0
      : raw.relation.some((item) => property(item).id === selector.contains)
  }
  if (filter.checkbox !== undefined) return raw.checkbox === property(filter.checkbox).equals
  throw new Error("Unexpected current query filter: " + JSON.stringify(filter))
}

/** Mutable service fixture: every ACK is a detached response to actual saved state. */
export function currentWriteFixture(parent: string) {
  const root = mkdtempSync(join(parent, "case-")),
    json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const pages = new Map<string, Row>(),
    blocks = new Map<string, Row[]>(),
    markdown = new Map<string, string>()
  const uploads = new Map<string, Row>(),
    uploadedBytes = new Map<string, Uint8Array>()
  const calls: CurrentWriteCall[] = [],
    downloads: string[] = [],
    generations = new Map<string, number>()
  let next = 100,
    tick = 0,
    fault: CurrentWriteFault | undefined
  let rewrite: ((path: string, response: Row) => Row) | undefined
  const timestamp = () => new Date(Date.UTC(2026, 10, 19) + tick++ * 1000).toISOString()
  const clone = (raw: unknown): unknown => structuredClone(raw)
  const attachment = (upload: string, name: string) => ({
    type: "file",
    name,
    file: {
      url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/current/${upload}?signature=fixture`,
      expiry_time: "2030-01-01T00:00:00.000Z",
    },
  })
  function normalize(raw: unknown): Row {
    return Object.fromEntries(
      Object.entries(property(raw)).map(([key, input]) => {
        const field = property(input),
          type = ["title", "rich_text", "select", "relation", "files", "checkbox"].find(
            (kind) => kind in field,
          )
        const value =
          type === "files" && Array.isArray(field.files)
            ? {
                ...field,
                files: field.files.map((item) => {
                  const file = property(item)
                  if (file.type !== "file_upload") return file
                  const upload = String(property(file.file_upload).id)
                  if (uploads.get(upload)?.status !== "uploaded")
                    throw new Error("Only a completed upload may attach")
                  return attachment(upload, String(file.name))
                }),
              }
            : field
        return [
          key,
          {
            ...value,
            id: key,
            type,
            ...(["rich_text", "relation", "files"].includes(type ?? "") ? { has_more: false } : {}),
          },
        ]
      }),
    )
  }
  function physical(input: unknown, page: string): Row {
    const row = property(input),
      type = String(row.type),
      body = property(row[type])
    const actual =
      (type === "file" || type === "image") && body.type === "file_upload"
        ? {
            ...body,
            type: "file",
            file_upload: undefined,
            file: attachment(String(property(body.file_upload).id), "").file,
          }
        : body
    return {
      ...row,
      [type]: actual,
      object: "block",
      id: id(next++),
      parent: { type: "page_id", page_id: page },
      has_children: false,
      archived: false,
      in_trash: false,
    }
  }
  const touch = (page: string) => {
    const row = pages.get(page)
    if (row !== undefined) row.last_edited_time = timestamp()
  }
  const selectedFault = (kind: FaultKind) => {
    const selected = fault?.kind === kind ? fault : undefined
    if (selected) fault = undefined
    return selected
  }
  const unknown = () =>
    Effect.fail(
      fail(
        "WRITE_OUTCOME_UNKNOWN",
        "The current service accepted an action but its response was lost.",
        { phase: "outcome_unknown" },
      ),
    )
  function list(path: string, values: readonly unknown[], start: unknown) {
    const offset = Number(start ?? 0),
      results = values.slice(offset, offset + 100),
      more = offset + results.length < values.length
    const response = {
      object: "list",
      results,
      has_more: more,
      next_cursor: more ? String(offset + results.length) : null,
    }
    return clone(rewrite ? rewrite(path, response) : response)
  }
  const service: Notion["Service"] = {
    apiOrigin: "https://current-writer.fixture",
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("writer-fixture"),
    connectionIdentity: Effect.succeed({
      principal: "writer-user",
      credential: "writer-fixture",
      connection: "writer-connection",
      workspace: "writer-workspace",
      api_origin: "https://current-writer.fixture",
    }),
    request: (path, body, options) =>
      Effect.suspend(() => {
        const method = options?.method ?? "GET",
          input = property(body),
          uri = new URL("https://api.notion.test/" + path),
          route = uri.pathname.slice(1)
        calls.push({ path, body: clone(body), method })
        const query = /^v1\/data_sources\/([^/]+)\/query$/u.exec(route)
        if (query)
          return Effect.succeed(
            list(
              path,
              [...pages.values()].filter(
                (row) =>
                  property(row.parent).data_source_id === query[1] &&
                  row.in_trash !== true &&
                  matches(row, input.filter),
              ),
              input.start_cursor,
            ),
          )
        if (route === "v1/pages" && method === "POST") {
          const table = property(input.parent).data_source_id,
            raw = property(input.properties)
          const kind: FaultKind | undefined =
            table === library.skills.data_source_id
              ? "skill-create"
              : table === library.files.data_source_id
                ? "file-create"
                : property(property(raw.kind).select).name === "resource"
                  ? "resource-create"
                  : undefined
          const chosen = kind === undefined ? undefined : selectedFault(kind)
          if (chosen?.outcome === "absent") return unknown()
          const page = id(next++),
            row: Row = {
              object: "page",
              id: page,
              parent: clone(input.parent),
              properties: normalize(input.properties),
              in_trash: false,
              archived: false,
              last_edited_time: timestamp(),
              url: `https://www.notion.so/${page.replaceAll("-", "")}`,
            }
          pages.set(page, row)
          blocks.set(page, [])
          markdown.set(page, "")
          return chosen ? unknown() : Effect.succeed(clone(row))
        }
        const page = /^v1\/pages\/([^/]+)$/u.exec(route)
        if (page) {
          const row = pages.get(page[1]!)
          if (!row) return Effect.fail(fail("NOT_FOUND", "Unknown current page."))
          if (method === "PATCH") {
            const table = property(row.parent).data_source_id
            const kind =
              input.in_trash === true
                ? table === library.files.data_source_id
                  ? "retire-file"
                  : table === library.records.data_source_id &&
                      property(property(property(row.properties).kind).select).name === "resource"
                    ? "retire-resource"
                    : undefined
                : undefined
            const chosen = kind === undefined ? undefined : selectedFault(kind)
            if (chosen?.outcome === "absent") return unknown()
            if (input.properties !== undefined)
              row.properties = { ...property(row.properties), ...normalize(input.properties) }
            if (input.in_trash !== undefined) row.in_trash = input.in_trash
            touch(page[1]!)
            if (chosen) return unknown()
          }
          return Effect.succeed(clone(row))
        }
        const md = /^v1\/pages\/([^/]+)\/markdown$/u.exec(route)
        if (md) {
          if (method === "PATCH") {
            markdown.set(md[1]!, String(property(input.replace_content).new_str))
            blocks.set(md[1]!, [])
            touch(md[1]!)
          }
          return Effect.succeed({
            object: "page_markdown",
            id: md[1],
            markdown: markdown.get(md[1]!) ?? "",
            truncated: false,
            unknown_block_ids: [],
          })
        }
        const children = /^v1\/blocks\/([^/]+)\/children$/u.exec(route)
        if (children) {
          const target = children[1]!,
            existing = blocks.get(target) ?? []
          if (method === "GET")
            return Effect.succeed(list(path, existing, uri.searchParams.get("start_cursor")))
          if (method !== "PATCH" || !Array.isArray(input.children))
            return Effect.fail(fail("TEST_UNEXPECTED", "Invalid block append"))
          const chosen = selectedFault("append")
          if (chosen?.outcome === "absent") return unknown()
          const added = (
            chosen?.outcome === "partial" ? input.children.slice(0, 1) : input.children
          ).map((row) => physical(row, target))
          blocks.set(target, [...existing, ...added])
          touch(target)
          return chosen
            ? unknown()
            : Effect.succeed({
                object: "list",
                results: clone(added),
                has_more: false,
                next_cursor: null,
              })
        }
        if (route === "v1/file_uploads") {
          if (method === "GET")
            return Effect.succeed(
              list(path, [...uploads.values()], uri.searchParams.get("start_cursor")),
            )
          const upload = id(next++),
            row: Row = {
              object: "file_upload",
              id: upload,
              status: "pending",
              filename: input.filename,
              content_type: input.content_type,
              expiry_time: "2030-01-01T00:00:00.000Z",
              content_length: 0,
              number_of_parts:
                input.mode === "multi_part" ? { total: input.number_of_parts, sent: 0 } : null,
            }
          uploads.set(upload, row)
          return Effect.succeed(clone(row))
        }
        const upload = /^v1\/file_uploads\/([^/]+)(?:\/(send|complete))?$/u.exec(route)
        if (upload) {
          const row = uploads.get(upload[1]!)
          if (!row) return Effect.fail(fail("NOT_FOUND", "Unknown upload"))
          if (upload[2] === "send") {
            if (options?.file === undefined)
              return Effect.fail(fail("TEST_UNEXPECTED", "Missing upload body"))
            const bytes = new Uint8Array(readFileSync(options.file)),
              prior = uploadedBytes.get(upload[1]!) ?? new Uint8Array()
            const joined = new Uint8Array(prior.length + bytes.length)
            joined.set(prior)
            joined.set(bytes, prior.length)
            uploadedBytes.set(upload[1]!, joined)
            row.content_length = joined.byteLength
            if (row.number_of_parts === null) row.status = "uploaded"
            else property(row.number_of_parts).sent = Number(property(row.number_of_parts).sent) + 1
          } else if (upload[2] === "complete") row.status = "uploaded"
          return Effect.succeed(clone(row))
        }
        return Effect.fail(
          fail("TEST_UNEXPECTED", "Unexpected current service route.", { path, method }),
        )
      }),
  }
  const store: Store["Service"] = {
    root,
    configRoot: root,
    cacheRoot: root,
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    listKeys: (prefix) => Effect.succeed([...json.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          json.has(key) ? Schema.decodeUnknownSync(schema)(clone(json.get(key))) : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid fixture state.", { key }),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, clone(value))
      }),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          json.delete(key)
          return { key, retention_path: "fixture-cleared" }
        }),
      ),
    reserveCacheGeneration: (scope, identity) =>
      Effect.sync(() => {
        const key = scope + ":" + identity,
          value = (generations.get(key) ?? 0) + 1
        generations.set(key, value)
        return value
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing cached bytes", { key })),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
      }),
    registerBindingWithBase: () => Effect.die("Unexpected old binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected old receipt"),
    backup: () => Effect.die("Unexpected backup"),
    output: () => Effect.die("Use actual portable bytes in these tests"),
  }
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      downloads.push(request.url)
      const upload = new URL(request.url).pathname.split("/").at(-1)!,
        bytes = uploadedBytes.get(upload)
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array(bytes), {
              headers: { "content-length": String(bytes.length) },
            }),
      )
    }),
  )
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, service),
    Layer.succeed(Store, store),
    Layer.succeed(HttpClient.HttpClient, http),
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const table = (kind: "skills" | "files" | "records", live = true) =>
    [...pages.values()].filter(
      (row) =>
        property(row.parent).data_source_id === library[kind].data_source_id &&
        (!live || row.in_trash !== true),
    )
  return {
    run,
    root,
    pages,
    blocks,
    json,
    objects,
    uploads,
    uploadedBytes,
    calls,
    downloads,
    table,
    failNext: (value: CurrentWriteFault) => {
      fault = value
    },
    rewrite: (value?: (path: string, response: Row) => Row) => {
      rewrite = value
    },
    mutations: () => calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    clearCalls: () => {
      calls.length = 0
      downloads.length = 0
    },
  }
}
