import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { resolveFileState, type FileEvent } from "../src/shared-file-state.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { makeSourceBinding } from "../src/shared-source-binding.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import {
  bodyWriteObservationId,
  bodyWriteOutcomeId,
  bodyWriteOutcomesEntity,
  makeSharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import {
  executeSharedBodyWrite,
  loadPendingSharedBodyWrites,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "../src/shared-body-write.ts"

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

interface Remote {
  markdown: string
  source: string
  nextPage: number
  rows: Map<string, Record<string, unknown>>
  hidden: Set<string>
  initial: FileEvent
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
            [s.Enabled]: { checkbox: true },
            [s["Default Context"]]: { checkbox: false },
            [s["Skill ID"]]: rich("skill-write"),
            [s["Main File ID"]]: rich(fileId),
            [s.Source]: rich(shared.source),
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
        if (url.pathname === `/v1/pages/${skillPage}/markdown`) {
          if (requestOptions?.method === "PATCH") {
            options.beforeBody?.()
            if (options.bodyError !== undefined) return Effect.fail(options.bodyError)
            const updates = property(property(body).update_content).content_updates
            if (!Array.isArray(updates) || updates.length !== 1)
              return Effect.fail(fail("BAD_PATCH", "Expected exactly one whole-body update"))
            const change = property(updates[0]),
              oldText = String(change.old_str),
              newText = String(change.new_str)
            const first = shared.markdown.indexOf(oldText)
            if (
              !oldText ||
              first < 0 ||
              shared.markdown.indexOf(oldText, first + oldText.length) >= 0
            )
              return Effect.fail(
                fail("NOTION_REQUEST_FAILED", "The official API rejected this request.", {
                  http_status: 400,
                  notion_code: "validation_error",
                  phase: "definitive_rejection",
                }),
              )
            shared.markdown =
              shared.markdown.slice(0, first) +
              newText +
              shared.markdown.slice(first + oldText.length)
            if (options.unknownBody)
              return Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "The original write result was lost."),
              )
          }
          const response = {
            id: skillPage,
            markdown: shared.markdown,
            truncated: false,
            unknown_block_ids: [],
          }
          return Effect.succeed(
            requestOptions?.method === "PATCH" && options.response
              ? options.response(response)
              : response,
          )
        }
        if (url.pathname === `/v1/data_sources/${filesDs}/query`)
          return Effect.succeed({ object: "list", results: [], has_more: false, next_cursor: null })
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
          const results = selected
            .slice(start, start + 100)
            .map((row) => ({
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
  const layer = Layer.mergeAll(NodeServices.layer, Layer.succeed(Notion, api))
  return {
    calls,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto>) =>
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

describe("explicit shared whole-body writes", () => {
  test("freezes exact old/candidate bytes and retains them before one complete update", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare())
    let journal: SharedBodyWritePlan | undefined
    const result = await api.run(
      executeSharedBodyWrite(library, {
        plan,
        mode: "create",
        beforePlanWrite: (value) =>
          Effect.sync(() => {
            expect(creates(api)).toHaveLength(0)
            expect(patches(api)).toHaveLength(0)
            journal = value
          }),
      }),
    )
    expect(result.status).toBe("applied")
    expect(journal).toEqual(plan)
    expect(result.requires_fresh_read).toBe(true)
    expect(patches(api)).toHaveLength(1)
    expect(patches(api)[0]?.body).toEqual({
      markdown_version: "v2",
      type: "update_content",
      update_content: { content_updates: [{ old_str: original, new_str: candidate }] },
    })
    expect(payloadFor(shared, `body-${hash(original)}`)).toEqual({
      version: 1,
      kind: "normalized_markdown",
      normalization_version: 1,
      markdown: original,
    })
    expect(payloadFor(shared, `body-${hash(candidate)}`)).toEqual({
      version: 1,
      kind: "normalized_markdown",
      normalization_version: 1,
      markdown: candidate,
    })
    expect(resolveFileState(fileId, eventRows(shared)).ownership).toEqual({
      kind: "custom",
      content: plan.candidate.content,
    })
    expect(shared.markdown).toBe(candidate)
  })

  test("preserves exact raw matching whitespace, CRLF, code and links", async () => {
    const raw = "# A\r\n\r\n```ts\r\nlet x =  1;\r\n```\r\n[a_b](https://example.test/a_b)\r\n"
    const shared = remote(raw),
      api = client(shared)
    const plan = await api.run(prepare())
    expect(plan.before.raw_markdown).toBe(raw)
    expect(plan.before.markdown).toBe(raw.replace(/\r\n/g, "\n"))
    await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))
    expect(property(property(patches(api)[0]?.body).update_content).content_updates).toEqual([
      { old_str: raw, new_str: candidate },
    ])
  })

  test("an identical ordinary write is read-only and keeps its ownership", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare(original))
    let saved = false
    const result = await api.run(
      executeSharedBodyWrite(library, {
        plan,
        mode: "create",
        beforePlanWrite: () =>
          Effect.sync(() => {
            saved = true
          }),
      }),
    )
    expect(result.status).toBe("unchanged")
    expect(saved).toBe(false)
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test("empty old body and oversized plans fail before dispatch journalling", async () => {
    for (const initial of ["", "x".repeat(30_000)]) {
      const shared = remote(initial),
        api = client(shared)
      const error = failure(await api.run(prepare("y".repeat(30_000)).pipe(Effect.result)))
      expect(["SHARED_BODY_WRITE_UNSUPPORTED", "SHARED_RECORD_TOO_LARGE"]).toContain(error.code)
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
    }
  })

  test("changed full body or stale pinned heads fail before a new plan is retained", async () => {
    const shared = remote(),
      api = client(shared)
    shared.markdown = "A natural user edit\n"
    expect(failure(await api.run(prepare().pipe(Effect.result))).code).toBe(
      "SHARED_BODY_WRITE_STALE",
    )
    shared.markdown = original
    const stale = prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId,
      candidateMarkdown: candidate,
      action: "write",
      expected: { heads: ["other-head"], body_sha256: hash(original) },
    })
    expect(failure(await api.run(stale.pipe(Effect.result))).code).toBe("SHARED_BODY_WRITE_STALE")
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test("outside append survives and prevents accepting the candidate as a complete write", async () => {
    const shared = remote(),
      api = client(shared, {
        beforeBody: () => {
          shared.markdown += "\nOutside user addition\n"
        },
      })
    const plan = await api.run(prepare())
    const error = failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(error.code).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
    expect(shared.markdown).toBe(candidate + "\nOutside user addition\n")
    expect(eventRows(shared)).toEqual([shared.initial])
    const observed = property(payloadFor(shared, bodyWriteObservationId(plan.operation_id)))
    expect(property(observed.response).markdown).toBe(shared.markdown)
    expect(property(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).status).toBe(
      "needs_review",
    )
    const fresh = client(shared)
    const pending = await fresh.run(
      loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
    )
    expect(pending).toEqual([plan])
    expect(
      failure(await fresh.run(reconcileSharedBodyWrite(library, plan).pipe(Effect.result))).code,
    ).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
    expect(creates(fresh)).toHaveLength(0)
    expect(patches(fresh)).toHaveLength(0)
  })

  test("an oversized actual response stays pending and is never claimed to be retained", async () => {
    const shared = remote(),
      api = client(shared, {
        beforeBody: () => {
          shared.markdown += "x".repeat(70_000)
        },
      })
    const plan = await api.run(prepare())
    const error = failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(error.code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(property(error.details).observed_result_retention).toBe("not_stored")
    expect(payloadFor(shared, bodyWriteObservationId(plan.operation_id))).toBeUndefined()
    expect(
      property(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).observed_result_retention,
    ).toBe("not_stored")
    const next = client(shared)
    expect(
      await next.run(
        loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
      ),
    ).toEqual([plan])
    const recovered = failure(
      await next.run(reconcileSharedBodyWrite(library, plan).pipe(Effect.result)),
    )
    expect(recovered.code).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
    expect(property(recovered.details).observed_result_retention).toBe("not_stored")
    expect(creates(next)).toHaveLength(0)
    expect(patches(next)).toHaveLength(0)
  })

  test("an inside edit causes a verified rejection, preserving the user's complete body", async () => {
    const shared = remote(),
      edited = original.replace("User", "Later user")
    const api = client(shared, {
      beforeBody: () => {
        shared.markdown = edited
      },
    })
    const plan = await api.run(prepare())
    const error = failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(error.code).toBe("NOTION_REQUEST_FAILED")
    expect(shared.markdown).toBe(edited)
    expect(eventRows(shared)).toEqual([shared.initial])
    const next = client(shared)
    expect(
      await next.run(
        loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
      ),
    ).toEqual([])
    expect((await next.run(reconcileSharedBodyWrite(library, plan))).status).toBe("not_applied")
    expect(creates(next)).toHaveLength(0)
    expect(patches(next)).toHaveLength(0)
  })

  test("a generic request error is not upgraded into a known no-effect rejection", async () => {
    const shared = remote(),
      api = client(shared, {
        bodyError: fail("NOTION_REQUEST_FAILED", "Unproven failure.", { http_status: 400 }),
      })
    const plan = await api.run(prepare())
    failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    expect(patches(api)).toHaveLength(1)
  })

  test.each(["warnings", "truncated", "unknown_block_ids"])(
    "retains a %s response without an ownership event or rollback",
    async (field) => {
      const shared = remote(),
        api = client(shared, {
          response: (raw) => ({
            ...raw,
            [field]:
              field === "warnings"
                ? [{ type: "partial_match" }]
                : field === "truncated"
                  ? true
                  : [id(99)],
          }),
        })
      const plan = await api.run(prepare())
      expect(
        failure(
          await api.run(
            executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
          ),
        ).code,
      ).toBe("SHARED_BODY_WRITE_REVIEW_REQUIRED")
      expect(shared.markdown).toBe(candidate)
      expect(eventRows(shared)).toEqual([shared.initial])
      expect(payloadFor(shared, bodyWriteObservationId(plan.operation_id))).toBeDefined()
      expect(patches(api)).toHaveLength(1)
    },
  )

  test("rechecks Source before body dispatch and records a no-send outcome", async () => {
    const shared = remote()
    const api = client(shared, {
      afterRecord: (kind, recordId) => {
        if (kind === "object" && recordId === `body-${hash(candidate)}`)
          shared.source = "source-changed"
      },
    })
    const plan = await api.run(prepare())
    expect(
      failure(
        await api.run(
          executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("SHARED_BODY_WRITE_STALE")
    expect(patches(api)).toHaveLength(0)
    expect(property(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).status).toBe(
      "not_sent",
    )
    expect((await client(shared).run(reconcileSharedBodyWrite(library, plan))).status).toBe(
      "not_applied",
    )
  })

  test.each(["operation", "object"] satisfies Kind[])(
    "an unknown %s write stops before the page write and only reads original IDs on recovery",
    async (unknownRecord) => {
      const shared = remote(),
        api = client(shared, { unknownRecord, invisible: true })
      const plan = await api.run(prepare())
      const error = failure(
        await api.run(
          executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
        ),
      )
      expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(property(error.details).body_write_operation_id).toBe(plan.operation_id)
      if (unknownRecord === "operation")
        expect(property(error.details).first_plan_visibility_boundary).toBe(true)
      expect(patches(api)).toHaveLength(0)
      const next = client(shared)
      expect(
        failure(await next.run(reconcileSharedBodyWrite(library, plan).pipe(Effect.result))).code,
      ).toBe("SHARED_RECORD_UNRESOLVED")
      expect(patches(next)).toHaveLength(0)
      expect(creates(next)).toHaveLength(0)
      expect(reads(next)).toHaveLength(0)
    },
  )

  test("an unknown applied body request is never resent or converted into acceptance from current bytes", async () => {
    const shared = remote(),
      api = client(shared, { unknownBody: true })
    const plan = await api.run(prepare())
    expect(
      failure(
        await api.run(
          executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(shared.markdown).toBe(candidate)
    const next = client(shared)
    const pending = await next.run(
      loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
    )
    expect(pending).toEqual([plan])
    const error = failure(
      await next.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(error.code).toBe("SHARED_BODY_WRITE_UNRESOLVED")
    expect(property(error.details).body_matches_candidate).toBe(true)
    expect(patches(next)).toHaveLength(0)
    expect(creates(next)).toHaveLength(0)
    expect(eventRows(shared)).toEqual([shared.initial])
  })

  test("a visible original completion reconciles across independent clients without reading a later body", async () => {
    const shared = remote(),
      api = client(shared, { unknownRecord: "operation", unknownRecordPrefix: "outcome-" })
    const plan = await api.run(prepare())
    failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    shared.markdown = "A later user edit after the accepted response\n"
    const next = client(shared)
    const result = await next.run(reconcileSharedBodyWrite(library, plan))
    expect(result.status).toBe("applied")
    expect(result.requires_fresh_read).toBe(true)
    expect(reads(next)).toHaveLength(0)
    expect(patches(next)).toHaveLength(0)
    expect(creates(next)).toHaveLength(0)
    expect(shared.markdown).toContain("later user edit")
  })

  test("a content event without original completion cannot settle an unknown event response", async () => {
    const shared = remote(),
      api = client(shared, { unknownRecord: "file_event" })
    const plan = await api.run(prepare())
    failure(
      await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)),
    )
    expect(eventRows(shared).some((event) => event.event_id === plan.event.event_id)).toBe(true)
    const next = client(shared)
    expect(
      await next.run(
        loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
      ),
    ).toEqual([plan])
    expect(
      failure(await next.run(reconcileSharedBodyWrite(library, plan).pipe(Effect.result))).code,
    ).toBe("SHARED_BODY_WRITE_UNRESOLVED")
    expect(creates(next)).toHaveLength(0)
    expect(patches(next)).toHaveLength(0)
  })

  test("restores following only after the fixed source projection matches and keeps the custom bytes", async () => {
    const shared = remote(),
      api = client(shared)
    const fixed = await api.run(
      makeSourceBinding({
        url: "https://github.com/owner/repo",
        commit: "c".repeat(40),
        tree: "d".repeat(40),
        root: "skill",
        files: [
          {
            path: "SKILL.md",
            source_path: "skill/SKILL.md",
            git_oid: "e".repeat(40),
            bytes: candidate.length,
          },
        ],
      }),
    )
    seed(shared, "source", fixed.source_id, `register-${fixed.source_id}`, fixed.source_id, fixed)
    shared.source = fixed.source_id
    const plan = await api.run(
      prepareSharedBodyWrite({
        library,
        skillPageId: skillPage,
        fileId,
        action: "restore_follow",
        candidateMarkdown: candidate,
        source: { source_id: fixed.source_id, revision: fixed.commit, path: "SKILL.md" },
      }),
    )
    const result = await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))
    expect(result.status).toBe("applied")
    expect(plan.event.kind).toBe("following_restored")
    expect(resolveFileState(fileId, eventRows(shared)).ownership).toEqual({
      kind: "following",
      source_revision: fixed.commit,
      projection: { normalization_version: 1, sha256: hash(candidate) },
    })
    expect(property(payloadFor(shared, `body-${hash(original)}`)).markdown).toBe(original)
    expect(shared.source).toBe(fixed.source_id)
    expect(patches(api)).toHaveLength(1)
  })

  test("plan identities reject changed source, page, parents, bytes and original time", async () => {
    const api = client(remote()),
      plan = await api.run(prepare())
    const variants = [
      { ...plan, source_id: "other" },
      { ...plan, page_id: id(900) },
      { ...plan, event: { ...plan.event, parents: ["other"] } },
      { ...plan, candidate: { ...plan.candidate, markdown: "different" } },
      { ...plan, before: { ...plan.before, downloaded_at: plan.before.downloaded_at + 1 } },
    ]
    for (const value of variants)
      expect(
        failure(await api.run(validateSharedBodyWritePlan(value).pipe(Effect.result))).code,
      ).toBe("SHARED_BODY_WRITE_INVALID")
    expect(creates(api)).toHaveLength(0)
  })

  test("completed writes use the compact shared index and small outcomes without old body plans", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare())
    await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))
    const next = client(shared)
    const headers = await next.run(querySharedOperationIndex(library, skillPage))
    expect(
      await next.run(
        loadPendingSharedBodyWrites(library, {
          skillPageId: skillPage,
          events: eventRows(shared),
          headers,
        }),
      ),
    ).toEqual([])
    expect(next.calls).toHaveLength(2)
    expect(
      new URL(next.calls[0]?.path ?? "", "https://notion.test").searchParams.getAll(
        "filter_properties",
      ),
    ).not.toContain(r.Payload)
    expect(next.calls[0]?.content).toBeUndefined()
    expect(next.calls.every((call) => call.content !== "body")).toBe(true)
  })

  test.each([true, false])(
    "a second original plan with the same content event remains pending (review outcome: %s)",
    async (withReview) => {
      const shared = remote(),
        api = client(shared)
      const first = await api.run(prepare())
      await api.run(executeSharedBodyWrite(library, { plan: first, mode: "create" }))
      const second = await api.run(
        makeSharedBodyWritePlan({
          library_id: first.library_id,
          skill_page_id: first.skill_page_id,
          skill_id: first.skill_id,
          file_id: first.file_id,
          page_id: first.page_id,
          path: first.path,
          source_id: first.source_id,
          action: first.action,
          before: { ...first.before, downloaded_at: first.before.downloaded_at + 1 },
          candidateMarkdown: first.candidate.markdown,
          parents: first.event.parents,
        }),
      )
      expect(second.operation_id).not.toBe(first.operation_id)
      expect(second.event.event_id).toBe(first.event.event_id)
      seed(shared, "operation", second.operation_id, second.operation_id, fileId, second)
      if (withReview)
        seed(
          shared,
          "operation",
          bodyWriteOutcomeId(second.operation_id),
          second.operation_id,
          bodyWriteOutcomesEntity,
          {
            version: 1,
            kind: "body_write_outcome",
            operation_id: second.operation_id,
            file_id: fileId,
            status: "needs_review",
            reason_code: "SHARED_BODY_WRITE_MISMATCH",
            observed_result_retention: "not_stored",
          },
        )
      const next = client(shared)
      expect(
        await next.run(
          loadPendingSharedBodyWrites(library, {
            skillPageId: skillPage,
            events: eventRows(shared),
          }),
        ),
      ).toEqual([second])
      expect(
        failure(await next.run(reconcileSharedBodyWrite(library, second).pipe(Effect.result))).code,
      ).toBe(withReview ? "SHARED_BODY_WRITE_REVIEW_REQUIRED" : "SHARED_BODY_WRITE_UNRESOLVED")
      expect(creates(next)).toHaveLength(0)
      expect(patches(next)).toHaveLength(0)
    },
  )

  test("meeting transcript placeholders fail before any shared plan or page write", async () => {
    const shared = remote(
        "<meeting-notes-section-transcript>Transcript omitted.</meeting-notes-section-transcript>\n",
      ),
      api = client(shared)
    expect(failure(await api.run(prepare().pipe(Effect.result))).code).toBe(
      "SHARED_BODY_WRITE_UNSUPPORTED",
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test("compact operation index paginates 101 unrelated facts without bodies", async () => {
    const shared = remote()
    for (let index = 0; index < 101; index++)
      seed(shared, "operation", `other-${index}`, `other-${index}`, "unrelated", {
        version: 1,
        note: index,
      })
    const api = client(shared)
    expect(
      await api.run(
        loadPendingSharedBodyWrites(library, { skillPageId: skillPage, events: eventRows(shared) }),
      ),
    ).toEqual([])
    expect(api.calls).toHaveLength(2)
    expect(
      api.calls.every(
        (call) =>
          call.content === undefined &&
          !new URL(call.path, "https://notion.test").searchParams
            .getAll("filter_properties")
            .includes(r.Payload),
      ),
    ).toBe(true)
  })

  test("a conflicting same-ID operation header fails before reading any original Payload", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare())
    seed(shared, "operation", plan.operation_id, plan.operation_id, fileId, plan)
    seed(shared, "operation", plan.operation_id, plan.operation_id, "foreign-file", plan)
    const next = client(shared)
    expect(
      failure(await next.run(querySharedOperationIndex(library, skillPage).pipe(Effect.result)))
        .code,
    ).toBe("SHARED_RECORD_CONFLICT")
    expect(next.calls.every((call) => call.content === undefined)).toBe(true)
  })
})
