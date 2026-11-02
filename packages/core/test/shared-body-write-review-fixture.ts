import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { decode, fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import type { FileEvent } from "../src/shared-file-state.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { prepareSharedBodyWrite } from "../src/shared-body-write.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillPage = id(1),
  recordsDs = id(2),
  recordsDb = id(3),
  skillsDs = id(4),
  filesDs = id(5)
const fileId = "file-main",
  original = "# Original\n\nUser instructions.\n",
  candidate = "# Changed\n\nNew instructions.\n"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const r = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
const s = {
  Name: "name",
  Description: "description",
  Kind: "kind",
  Enabled: "enabled",
  "Default Context": "default",
  "Skill ID": "skill-id",
  "Main File ID": "main-file",
  Source: "source",
  References: "references",
  Projection: "projection",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-body-write",
  operation_id: "library-body-write",
  parent_page_id: id(6),
  skills: { database_id: id(7), data_source_id: skillsDs, property_ids: s },
  files: {
    database_id: id(8),
    data_source_id: filesDs,
    property_ids: {
      "File ID": "file",
      Skill: "skill",
      Path: "path",
      Projection: "projection",
      Status: "status",
    },
  },
  records: { database_id: recordsDb, data_source_id: recordsDs, property_ids: r },
}
const rich = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] })

function responseProperty(key: string, raw: unknown) {
  const value = property(raw)
  if (Array.isArray(value.title)) return { ...value, id: key, type: "title" }
  if (Array.isArray(value.rich_text))
    return { ...value, id: key, type: "rich_text", has_more: false }
  if (Array.isArray(value.relation)) return { ...value, id: key, type: "relation", has_more: false }
  if (value.select !== undefined) return { ...value, id: key, type: "select" }
  if (value.checkbox !== undefined) return { ...value, id: key, type: "checkbox" }
  throw new Error("Invalid fixture property")
}

function matches(row: Record<string, unknown>, raw: unknown): boolean {
  const filter = property(raw)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  const field = property(property(row.properties)[String(filter.property)])
  if (filter.relation !== undefined)
    return (
      Array.isArray(field.relation) &&
      field.relation.some((value) => property(value).id === property(filter.relation).contains)
    )
  if (filter.select !== undefined)
    return property(field.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(field.rich_text) === property(filter.rich_text).equals
  return false
}

export interface Remote {
  local: Map<string, unknown>
  retired: Map<string, unknown>
  generation: number
  enabled: boolean
  skillId: string
  markdown: string
  source: string
  nextPage: number
  rows: Map<string, Record<string, unknown>>
  hidden: Set<string>
  initial: FileEvent
  support?: { page_id: string; file_id: string; path: string; markdown: string }
}
function remote(markdown = original): Remote {
  const normalized = markdown.replace(/\r\n/g, "\n")
  const content = {
    object_id: `body-${hash(normalized)}`,
    sha256: hash(normalized),
    bytes: new TextEncoder().encode(normalized).byteLength,
  }
  const event: FileEvent = {
    event_id: "initial-custom",
    file_id: fileId,
    parents: [],
    kind: "adopted",
    content,
  }
  const shared: Remote = {
    markdown,
    local: new Map<string, unknown>(),
    retired: new Map<string, unknown>(),
    generation: 0,
    enabled: true,
    skillId: "skill-write",
    source: "",
    nextPage: 100,
    rows: new Map<string, Record<string, unknown>>(),
    hidden: new Set<string>(),
    initial: event,
  }
  seed(shared, "file_event", event.event_id, event.event_id, fileId, event)
  return shared
}
type Kind = "file_event" | "object" | "operation" | "source"

function seed(
  shared: Remote,
  kind: Kind,
  recordId: string,
  operationId: string,
  entityId: string,
  payload: unknown,
) {
  const envelope = canonicalSharedJson({ version: 1, operation_id: operationId, payload })
  const page = id(shared.nextPage++)
  const properties = {
    [r.Name]: { title: [{ type: "text", text: { content: "Frozen fact" } }] },
    [r["Record ID"]]: rich(recordId),
    [r.Kind]: { select: { name: kind } },
    [r["Entity ID"]]: rich(entityId),
    [r.Hash]: rich(hash(envelope)),
    [r.Payload]: rich(envelope),
    [r.Skill]: { relation: [{ id: skillPage }] },
  }
  const row = {
    object: "page",
    id: page,
    parent: { type: "data_source_id", data_source_id: recordsDs, database_id: recordsDb },
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, responseProperty(key, value)]),
    ),
  }
  shared.rows.set(page, row)
  return row
}

function rowRecordId(row: Record<string, unknown>) {
  return text(property(property(row.properties)[r["Record ID"]]).rich_text)
}
function eventRows(shared: Remote): FileEvent[] {
  return [...shared.rows.values()]
    .filter(
      (row) =>
        property(property(property(row.properties)[r.Kind]).select).name === "file_event" &&
        !shared.hidden.has(String(row.id)),
    )
    .map((row) => JSON.parse(text(property(property(row.properties)[r.Payload]).rich_text)).payload)
}
function payloadFor(shared: Remote, recordId: string): unknown {
  const row = [...shared.rows.values()].find((row) => rowRecordId(row) === recordId)
  return row === undefined
    ? undefined
    : property(JSON.parse(text(property(property(row.properties)[r.Payload]).rich_text))).payload
}

function client(
  shared: Remote,
  options: {
    unknownRecord?: Kind
    unknownRecordPrefix?: string
    invisible?: boolean
    unknownBody?: boolean
    beforeBody?: () => void
    afterRecord?: (kind: string, recordId: string) => void
    response?: (raw: Record<string, unknown>) => unknown
    bodyError?: SkillsError
    readback?: (wire: string) => string
  } = {},
) {
  const calls: Array<{
    path: string
    body: unknown
    method: string | undefined
    content: string | undefined
  }> = []
  let recordUnknown = false
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled-writer"),
    request: (path, body, requestOptions) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({ path, body, method: requestOptions?.method, content: requestOptions?.content })
        const url = new URL(path, "https://api.notion.com/")
        if (url.pathname === `/v1/pages/${skillPage}`) {
          const props = {
            [s.Name]: { title: [{ type: "text", text: { content: "Write fixture" } }] },
            [s.Description]: rich("Whole-file write fixture"),
            [s.Kind]: { select: { name: "skill" } },
            [s.Enabled]: { checkbox: shared.enabled },
            [s["Default Context"]]: { checkbox: false },
            [s["Skill ID"]]: rich(shared.skillId),
            [s["Main File ID"]]: rich(fileId),
            [s.Source]: rich(shared.source),
            [s.References]: rich(""),
            [s.Projection]: rich(""),
          }
          return Effect.succeed({
            object: "page",
            id: skillPage,
            parent: { type: "data_source_id", data_source_id: skillsDs },
            last_edited_time: "2026-10-31T00:00:00.000Z",
            properties: Object.fromEntries(
              Object.entries(props).map(([key, value]) => [key, responseProperty(key, value)]),
            ),
          })
        }
        const selectedBody =
          url.pathname === `/v1/pages/${skillPage}/markdown`
            ? skillPage
            : shared.support !== undefined &&
                url.pathname === `/v1/pages/${shared.support.page_id}/markdown`
              ? shared.support.page_id
              : undefined
        if (selectedBody !== undefined) {
          const support = selectedBody === skillPage ? undefined : shared.support
          const currentBody = () => (support === undefined ? shared.markdown : support.markdown)
          if (requestOptions?.method === "PATCH") {
            options.beforeBody?.()
            if (options.bodyError !== undefined) return Effect.fail(options.bodyError)
            const updates = property(property(body).update_content).content_updates
            if (!Array.isArray(updates) || updates.length !== 1)
              return Effect.fail(fail("BAD_PATCH", "Expected exactly one whole-body update"))
            const change = property(updates[0]),
              oldText = String(change.old_str),
              newText = String(change.new_str)
            const prior = currentBody(),
              first = prior.indexOf(oldText)
            if (!oldText || first < 0 || prior.indexOf(oldText, first + oldText.length) >= 0)
              return Effect.fail(
                fail("NOTION_REQUEST_FAILED", "The official API rejected this request.", {
                  http_status: 400,
                  notion_code: "validation_error",
                  phase: "definitive_rejection",
                }),
              )
            const changed =
              prior.slice(0, first) +
              (options.readback?.(newText) ?? newText) +
              prior.slice(first + oldText.length)
            if (support === undefined) shared.markdown = changed
            else support.markdown = changed
            if (options.unknownBody)
              return Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "The original write result was lost."),
              )
          }
          const response = {
            id: selectedBody,
            markdown: currentBody(),
            truncated: false,
            unknown_block_ids: [],
          }
          return Effect.succeed(
            requestOptions?.method === "PATCH" && options.response
              ? options.response(response)
              : response,
          )
        }
        if (url.pathname === `/v1/data_sources/${filesDs}/query`) {
          const support = shared.support
          const fields =
            support === undefined
              ? {}
              : {
                  file: rich(support.file_id),
                  path: rich(support.path),
                  projection: rich(""),
                  status: { select: { name: "custom" } },
                  skill: { relation: [{ id: skillPage }] },
                }
          const results =
            support === undefined
              ? []
              : [
                  {
                    object: "page",
                    id: support.page_id,
                    parent: { type: "data_source_id", data_source_id: filesDs },
                    last_edited_time: "2026-10-31T00:00:00.000Z",
                    properties: Object.fromEntries(
                      Object.entries(fields).map(([key, value]) => [
                        key,
                        responseProperty(key, value),
                      ]),
                    ),
                  },
                ]
          return Effect.succeed({ object: "list", results, has_more: false, next_cursor: null })
        }
        if (url.pathname === `/v1/data_sources/${recordsDs}/query`) {
          const request = property(body)
          const selected = [...shared.rows.values()].filter(
            (row) => !shared.hidden.has(String(row.id)) && matches(row, request.filter),
          )
          const start =
            typeof request.start_cursor === "string"
              ? Number(request.start_cursor.replace("cursor-", ""))
              : 0
          const projection = new Set(url.searchParams.getAll("filter_properties"))
          const results = selected.slice(start, start + 100).map((row) => ({
            ...row,
            properties: Object.fromEntries(
              Object.entries(property(row.properties)).filter(
                ([key]) => projection.size === 0 || projection.has(key),
              ),
            ),
          }))
          const more = start + 100 < selected.length
          return Effect.succeed({
            object: "list",
            results,
            has_more: more,
            next_cursor: more ? `cursor-${start + 100}` : null,
          })
        }
        if (url.pathname === "/v1/pages" && requestOptions?.method === "POST") {
          const request = property(body),
            page = id(shared.nextPage++)
          const properties = Object.fromEntries(
            Object.entries(property(request.properties)).map(([key, value]) => [
              key,
              responseProperty(key, value),
            ]),
          )
          const row = {
            object: "page",
            id: page,
            parent: { ...property(request.parent), database_id: recordsDb },
            properties,
          }
          shared.rows.set(page, row)
          const kind = String(property(property(properties[r.Kind]).select).name),
            recordId = rowRecordId(row)
          options.afterRecord?.(kind, recordId)
          if (
            !recordUnknown &&
            kind === options.unknownRecord &&
            (options.unknownRecordPrefix === undefined ||
              recordId.startsWith(options.unknownRecordPrefix))
          ) {
            recordUnknown = true
            if (options.invisible) shared.hidden.add(page)
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "The shared record result was lost."))
          }
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED_REQUEST", "The fixture received an unrelated request.", { path }),
        )
      }),
  }
  const store: Store["Service"] = {
    root: "/unused",
    configRoot: "/unused",
    cacheRoot: "/unused",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    output: () => Effect.die(new Error("Unexpected export")),
    reserveCacheGeneration: () => Effect.sync(() => ++shared.generation),
    listKeys: (prefix) =>
      Effect.sync(() => [...shared.local.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          shared.local.has(key)
            ? decode(schema, structuredClone(shared.local.get(key)))
            : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid local fixture state"),
      }),
    writeJson: (key, value) =>
      Effect.try({
        try: () => {
          if (key.startsWith("operations/shared-observation-pending/")) {
            if (shared.retired.has(key))
              throw fail("STATE_CONFLICT", "A retired dispatch cannot reopen")
            const previous = shared.local.get(key)
            if (
              previous !== undefined &&
              canonicalSharedJson(previous) !== canonicalSharedJson(value)
            )
              throw fail("STATE_CONFLICT", "An original dispatch cannot change")
          }
          shared.local.set(key, structuredClone(value))
        },
        catch: (error) =>
          error instanceof SkillsError ? error : fail("STATE_CORRUPT", "Invalid local write"),
      }),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          if (shared.local.has(key)) shared.retired.set(key, shared.local.get(key))
          shared.local.delete(key)
          return { key, retention_path: `retired/${key}` }
        }),
      ),
    readBytes: () => Effect.die(new Error("Unexpected local content read")),
    writeBytes: () => Effect.die(new Error("Unexpected local content write")),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, store),
  )
  return {
    calls,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}
const patches = (api: ReturnType<typeof client>) =>
  api.calls.filter((call) => call.method === "PATCH")
const creates = (api: ReturnType<typeof client>) =>
  api.calls.filter((call) => call.path === "v1/pages")
const reads = (api: ReturnType<typeof client>) =>
  api.calls.filter((call) => call.path.includes("/markdown") && call.method !== "PATCH")
const prepare = (candidateMarkdown = candidate) =>
  prepareSharedBodyWrite({
    library,
    skillPageId: skillPage,
    fileId,
    candidateMarkdown,
    action: "write",
  })

function failure<A>(
  result:
    | { readonly _tag: "Failure"; readonly failure: unknown }
    | { readonly _tag: "Success"; readonly success: A },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed SkillsError")
  return result.failure
}

export {
  id,
  skillPage,
  fileId,
  original,
  candidate,
  hash,
  library,
  client,
  remote,
  seed,
  rowRecordId,
  eventRows,
  payloadFor,
  patches,
  creates,
  reads,
  prepare,
  failure,
}
