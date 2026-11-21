import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import type { PreparedCurrentSourceInput } from "../src/shared-current-source-input.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import {
  sharedFileProperties,
  sharedRecordProperties,
  sharedRelationProperty,
  sharedSkillProperties,
} from "../src/shared-library.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { Store } from "../src/store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"

export const id = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0")
const properties = (layout: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(layout).map((name) => [
      name,
      name === "Name" ? "title" : name.toLowerCase().replaceAll(" ", "-"),
    ]),
  )
export const library = {
  version: 1,
  library_id: "library-writer-current",
  operation_id: "library-writer-current",
  parent_page_id: id(1),
  skills: {
    database_id: id(2),
    data_source_id: id(3),
    property_ids: properties({ ...sharedSkillProperties, Origin: {}, Members: {}, Requires: {} }),
  },
  files: {
    database_id: id(4),
    data_source_id: id(5),
    property_ids: properties({ ...sharedFileProperties(id(3)), Origin: {} }),
  },
  records: {
    database_id: id(6),
    data_source_id: id(7),
    property_ids: properties({ ...sharedRecordProperties(id(3)), Origin: {} }),
  },
  sources: {
    database_id: id(8),
    data_source_id: id(9),
    property_ids: properties(sourceDefinitionLayout(id(3), id(7))),
  },
} satisfies SharedLibrary
const roles = ["skills", "files", "records", "sources"] as const
const origin = (field: "Skills" | "Records") => ({
  relation: {
    data_source_id: library.sources.data_source_id,
    dual_property: { synced_property_id: library.sources.property_ids[field] },
  },
})
const sourceLayout = sourceDefinitionLayout(
  library.skills.data_source_id,
  library.records.data_source_id,
)
const layouts = {
  skills: {
    ...sharedSkillProperties,
    Members: sharedRelationProperty(library.skills.data_source_id),
    Requires: sharedRelationProperty(library.skills.data_source_id),
    Origin: origin("Skills"),
  },
  files: {
    ...sharedFileProperties(library.skills.data_source_id),
    Origin: {
      rollup: {
        relation_property_id: library.files.property_ids.Skill,
        rollup_property_id: library.skills.property_ids.Origin,
        function: "show_unique",
      },
    },
  },
  records: { ...sharedRecordProperties(library.skills.data_source_id), Origin: origin("Records") },
  sources: {
    ...sourceLayout,
    ...Object.fromEntries(
      (["Skills", "Records"] as const).map((field) => [
        field,
        {
          relation: {
            ...sourceLayout[field].relation,
            dual_property: {
              ...sourceLayout[field].relation.dual_property,
              synced_property_id:
                library[field === "Skills" ? "skills" : "records"].property_ids.Origin,
            },
          },
        },
      ]),
    ),
  },
}
export const testBytes = (value: string) => new TextEncoder().encode(value)
type Row = Record<string, unknown>
type FaultKind =
  | "skill-create"
  | "source-create"
  | "source-properties"
  | "source-enabled"
  | "source-owner-retirement"
  | "source-ready"
  | "source-progress"
  | "source-retirement"
  | "file-create"
  | "resource-create"
  | "append"
  | "native-body"
  | "retire-file"
  | "retire-resource"
  | "relations"
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
  if (filter.rich_text !== undefined) {
    const selector = property(filter.rich_text)
    const value = text(raw.rich_text)
    if (typeof selector.equals === "string") return value === selector.equals
    if (typeof selector.contains === "string") return value.includes(selector.contains)
    if (typeof selector.starts_with === "string") return value.startsWith(selector.starts_with)
    throw new Error("Unexpected current rich text query filter: " + JSON.stringify(selector))
  }
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
  const observedPage = (raw: unknown): unknown => {
    const row = property(raw)
    if (row.object !== "page") return raw
    return {
      ...row,
      properties: Object.fromEntries(
        Object.entries(property(row.properties)).map(([key, raw]) => {
          const field = property(raw)
          return [
            key,
            field.type === "relation" && Array.isArray(field.relation)
              ? {
                  ...field,
                  relation: field.relation.slice(0, 25),
                  has_more: field.relation.length > 25,
                }
              : field,
          ]
        }),
      ),
    }
  }
  const response = (path: string, raw: Row) => clone(rewrite ? rewrite(path, raw) : raw)
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
          type = [
            "title",
            "rich_text",
            "select",
            "multi_select",
            "relation",
            "rollup",
            "files",
            "checkbox",
            "date",
          ].find((kind) => kind in field)
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
      results = values.slice(offset, offset + 100).map(observedPage),
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
        const schemaRole = roles.find(
          (role) => route === `v1/data_sources/${library[role].data_source_id}`,
        )
        if (schemaRole !== undefined && method === "GET")
          return Effect.succeed(
            response(path, {
              object: "data_source",
              id: library[schemaRole].data_source_id,
              parent: { type: "database_id", database_id: library[schemaRole].database_id },
              properties: Object.fromEntries(
                Object.entries(layouts[schemaRole]).map(([field, layout]) => {
                  const [type, value] = Object.entries(layout)[0]!
                  return [
                    field,
                    {
                      id: library[schemaRole].property_ids[field],
                      name: field,
                      type,
                      [type]:
                        type === "relation"
                          ? {
                              ...property(value),
                              type:
                                "single_property" in property(value)
                                  ? "single_property"
                                  : "dual_property",
                            }
                          : value,
                    },
                  ]
                }),
              ),
            }),
          )
        const databaseRole = roles.find(
          (role) => route === `v1/databases/${library[role].database_id}`,
        )
        if (databaseRole !== undefined && method === "GET")
          return Effect.succeed(
            response(path, {
              object: "database",
              id: library[databaseRole].database_id,
              database_type: null,
              title: [{ plain_text: "Current library" }],
              parent: { type: "page_id", page_id: library.parent_page_id },
              data_sources: [
                { id: library[databaseRole].data_source_id, name: "Current data source" },
              ],
              description: [
                {
                  plain_text:
                    databaseRole === "skills" ? LIBRARY_MARKER + JSON.stringify(library) : "",
                },
              ],
            }),
          )
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
              : table === library.sources.data_source_id
                ? "source-create"
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
              parent: {
                ...property(clone(input.parent)),
                database_id: roles
                  .map((role) => library[role])
                  .find((role) => role.data_source_id === table)?.database_id,
              },
              properties: normalize({
                ...(table === library.skills.data_source_id
                  ? {
                      members: { relation: [] },
                      requires: { relation: [] },
                      origin: { relation: [] },
                      tags: { multi_select: [] },
                    }
                  : table === library.records.data_source_id
                    ? { origin: { relation: [] } }
                    : table === library.files.data_source_id
                      ? {
                          origin: { rollup: { type: "array", array: [], function: "show_unique" } },
                        }
                      : table === library.sources.data_source_id
                        ? {
                            operation: { rich_text: [] },
                            skills: { relation: [] },
                            records: { relation: [] },
                          }
                        : {}),
                ...property(input.properties),
              }),
              in_trash: false,
              archived: false,
              last_edited_time: timestamp(),
              url: `https://www.notion.so/${page.replaceAll("-", "")}`,
            }
          pages.set(page, row)
          blocks.set(page, [])
          markdown.set(page, "")
          return chosen ? unknown() : Effect.succeed(response(path, property(observedPage(row))))
        }
        const page = /^v1\/pages\/([^/]+)$/u.exec(route)
        if (page) {
          const row = pages.get(page[1]!)
          if (!row) return Effect.fail(fail("NOT_FOUND", "Unknown current page."))
          if (method === "PATCH") {
            const table = property(row.parent).data_source_id
            const fields = property(input.properties)
            let startsSourceChild = false
            if (
              table === library.records.data_source_id &&
              property(property(property(row.properties).kind).select).name === "operation" &&
              text(property(property(row.properties)["entity-id"]).rich_text).startsWith(
                "current-source:",
              ) &&
              fields.payload !== undefined
            ) {
              const before = property(
                  property(JSON.parse(text(property(property(row.properties).payload).rich_text)))
                    .payload,
                ),
                after = property(
                  property(JSON.parse(text(property(fields.payload).rich_text))).payload,
                )
              startsSourceChild =
                after.in_flight === null &&
                property(before.source_progress).child_started === false &&
                property(after.source_progress).child_started === true &&
                property(before.source_progress).next_index ===
                  property(after.source_progress).next_index
            }
            const kind = startsSourceChild
              ? "source-progress"
              : input.in_trash === true
                ? table === library.sources.data_source_id
                  ? "source-owner-retirement"
                  : table === library.files.data_source_id
                    ? "retire-file"
                    : table === library.records.data_source_id &&
                        property(property(property(row.properties).kind).select).name ===
                          "operation" &&
                        text(property(property(row.properties)["entity-id"]).rich_text).startsWith(
                          "current-source:",
                        )
                      ? "source-retirement"
                      : table === library.records.data_source_id &&
                          property(property(property(row.properties).kind).select).name ===
                            "resource"
                        ? "retire-resource"
                        : undefined
                : table === library.sources.data_source_id &&
                    property(property(property(input.properties).status).select).name === "ready"
                  ? "source-ready"
                  : table === library.sources.data_source_id &&
                      ("content" in property(input.properties) ||
                        "contributions" in property(input.properties))
                    ? "source-properties"
                    : table === library.sources.data_source_id &&
                        "enabled" in property(input.properties)
                      ? "source-enabled"
                      : "members" in property(input.properties) ||
                          "requires" in property(input.properties)
                        ? "relations"
                        : undefined
            const chosen = kind === undefined ? undefined : selectedFault(kind)
            if (chosen?.outcome === "absent") return unknown()
            if (input.properties !== undefined)
              row.properties = {
                ...property(row.properties),
                ...normalize(
                  chosen?.outcome === "partial" && kind === "relations"
                    ? Object.fromEntries(Object.entries(property(input.properties)).slice(0, 1))
                    : input.properties,
                ),
              }
            if (input.in_trash !== undefined) row.in_trash = input.in_trash
            touch(page[1]!)
            if (chosen) return unknown()
          }
          return Effect.succeed(response(path, property(observedPage(row))))
        }
        const relation = /^v1\/pages\/([^/]+)\/properties\/([^/]+)$/u.exec(route)
        if (relation) {
          const field = property(property(pages.get(relation[1]!)?.properties)[relation[2]!])
          if (field.type !== "relation" || !Array.isArray(field.relation))
            return Effect.fail(fail("NOT_FOUND", "Unknown current relation."))
          const offset = Number(uri.searchParams.get("start_cursor") ?? 0),
            selected = field.relation.slice(offset, offset + 100)
          const more = offset + selected.length < field.relation.length
          return Effect.succeed(
            response(path, {
              object: "list",
              type: "property_item",
              has_more: more,
              next_cursor: more ? String(offset + selected.length) : null,
              property_item: {
                id: relation[2],
                type: "relation",
                relation: {},
                next_url: more
                  ? `https://api.notion.test/${path}&start_cursor=${offset + selected.length}`
                  : null,
              },
              results: selected.map((value) => ({
                object: "property_item",
                id: relation[2],
                type: "relation",
                relation: value,
              })),
            }),
          )
        }
        const md = /^v1\/pages\/([^/]+)\/markdown$/u.exec(route)
        if (md) {
          if (method === "PATCH") {
            const chosen = selectedFault("native-body")
            if (chosen?.outcome === "absent") return unknown()
            markdown.set(md[1]!, String(property(input.replace_content).new_str))
            blocks.set(md[1]!, [])
            touch(md[1]!)
            if (chosen) return unknown()
          }
          return Effect.succeed(
            response(path, {
              object: "page_markdown",
              id: md[1],
              markdown: markdown.get(md[1]!) ?? "",
              truncated: false,
              unknown_block_ids: [],
            }),
          )
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
    listKeys: (prefix) => Effect.succeed([...json.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          json.has(key) ? Schema.decodeUnknownSync(schema)(clone(json.get(key))) : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid fixture state.", { key }),
      }),
    writeJson: (key, value, options) =>
      Effect.try({
        try: () => {
          const previous = json.get(key)
          const before = property(previous),
            after = property(value)
          if (options !== undefined) {
            if (
              !/^operations\/current-write-pending\/[a-f0-9]{64}\/pending\.json$/u.test(key) ||
              previous === undefined ||
              canonicalSharedJson(previous) !==
                canonicalSharedJson(options.expectedCurrentWritePending) ||
              canonicalSharedJson(property(after.predecessor).intent) !==
                canonicalSharedJson(before.intent) ||
              canonicalSharedJson([
                before.version,
                before.scope,
                before.library_id,
                before.record_id,
                property(before.intent).owner,
              ]) !==
                canonicalSharedJson([
                  after.version,
                  after.scope,
                  after.library_id,
                  after.record_id,
                  property(after.intent).owner,
                ])
            )
              throw fail("STATE_CONFLICT", "The fixture predecessor changed.")
          } else if (
            previous !== undefined &&
            key.startsWith("operations/current-write-pending/")
          ) {
            const identity = (row: Record<string, unknown>) =>
              canonicalSharedJson([
                row.version,
                row.scope,
                row.library_id,
                row.record_id,
                row.intent,
                row.completion,
                row.predecessor ?? null,
              ])
            if (identity(before) !== identity(after))
              throw fail("STATE_CONFLICT", "A fixture pending intent is immutable.")
          }
          json.set(key, clone(value))
        },
        catch: () => fail("STATE_CONFLICT", "The current fixture state replacement was rejected."),
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
  const table = (kind: (typeof roles)[number], live = true) =>
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

/** Existing reading rows are explicit fixture state, independent of Source apply. */
export async function seedSourceFileRows(
  f: ReturnType<typeof currentWriteFixture>,
  prepared: PreparedCurrentSourceInput,
) {
  for (const target of prepared.targets) {
    const owner = f
      .table("skills")
      .find(
        (row) =>
          text(
            property(property(row.properties)[library.skills.property_ids["Skill ID"]!]).rich_text,
          ) === target.skill_id,
      )
    if (owner === undefined) continue
    const index = await f.run(queryCurrentSkillIndex(library, String(owner.id)))
    for (const file of target.files) {
      if (file.path === "SKILL.md" || index.files.some((binding) => binding.path === file.path))
        continue
      const fields = library.files.property_ids
      const content = {
        ...file.authority,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        bytes: file.bytes.byteLength,
        mode: file.mode ?? "100644",
      }
      const fileId =
        "projected-" +
        createHash("sha256")
          .update(
            JSON.stringify([
              prepared.declaration.definition.source_id,
              target.skill_id,
              file.authority.source_path,
            ]),
          )
          .digest("hex")
      await f.run(
        Effect.flatMap(Notion, (api) =>
          api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
              properties: {
                [fields.Name!]: { title: sourceRich(file.path) },
                [fields["File ID"]!]: { rich_text: sourceRich(fileId) },
                [fields.Path!]: { rich_text: sourceRich(file.path) },
                [fields.Skill!]: { relation: [{ id: index.page_id }] },
                [fields.Content!]: { rich_text: sourceRich(JSON.stringify(content)) },
              },
            },
            { method: "POST" },
          ),
        ),
      )
    }
  }
}
