import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { observeSharedFile } from "../src/shared-file-observer.ts"
import type { FileEvent } from "../src/shared-file-state.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import {
  commitSharedObservationPlan,
  loadPendingSharedObservationPlans,
  makeSharedObservationPlan,
  validateSharedObservationPlan,
  type SharedObservationPlan,
} from "../src/shared-observation-operation.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillId = id(1),
  dataSourceId = id(2),
  databaseId = id(3),
  bodyPageId = id(4)
const fields = {
  Name: "title",
  "Record ID": "record",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-operations",
  operation_id: "library-operations",
  parent_page_id: id(5),
  skills: { database_id: id(6), data_source_id: id(7), property_ids: {} },
  files: { database_id: id(8), data_source_id: id(9), property_ids: {} },
  records: { database_id: databaseId, data_source_id: dataSourceId, property_ids: fields },
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const originalBody = "original user edit\n"

function responseProperty(key: string, value: unknown) {
  const field = property(value)
  if (Array.isArray(field.title)) return { ...field, id: key, type: "title" }
  if (Array.isArray(field.rich_text))
    return { ...field, id: key, type: "rich_text", has_more: false }
  if (Array.isArray(field.relation)) return { ...field, id: key, type: "relation", has_more: false }
  if (field.select !== undefined) return { ...field, id: key, type: "select" }
  throw new Error("Invalid fixture property")
}

function matches(row: Record<string, unknown>, raw: unknown): boolean {
  const filter = property(raw)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  if (typeof filter.property !== "string") return false
  const field = property(property(row.properties)[filter.property])
  if (filter.relation !== undefined)
    return (
      Array.isArray(field.relation) &&
      field.relation.some((entry) => property(entry).id === property(filter.relation).contains)
    )
  if (filter.select !== undefined)
    return property(field.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(field.rich_text) === property(filter.rich_text).equals
  return false
}

function remote(markdown = originalBody) {
  return {
    markdown,
    rows: new Map<string, Record<string, unknown>>(),
    hidden: new Set<string>(),
    nextPage: 100,
  }
}
type Remote = ReturnType<typeof remote>
type Kind = "operation" | "object" | "file_event"

function client(shared: Remote, options: { unknownOn?: Kind; invisible?: boolean } = {}) {
  const calls: Array<{
    path: string
    body: unknown
    method: string | undefined
    content: string | undefined
  }> = []
  let injected = false
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("independent-observer"),
    request: (path, body, requestOptions) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({ path, body, method: requestOptions?.method, content: requestOptions?.content })
        const url = new URL(path, "https://api.notion.com/")
        if (url.pathname === `/v1/pages/${bodyPageId}/markdown`)
          return Effect.succeed({
            id: bodyPageId,
            markdown: shared.markdown,
            truncated: false,
            unknown_block_ids: [],
          })
        if (url.pathname === `/v1/data_sources/${dataSourceId}/query`) {
          const input = property(body)
          const selected = [...shared.rows.values()].filter(
            (row) =>
              typeof row.id === "string" &&
              !shared.hidden.has(row.id) &&
              matches(row, input.filter),
          )
          const start =
            typeof input.start_cursor === "string"
              ? Number(input.start_cursor.replace("cursor-", ""))
              : 0
          const page = selected.slice(start, start + 100)
          const projection = new Set(url.searchParams.getAll("filter_properties"))
          const results = page.map((row) => ({
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
          const input = property(body),
            page = id(shared.nextPage++)
          const properties = Object.fromEntries(
            Object.entries(property(input.properties)).map(([key, value]) => [
              key,
              responseProperty(key, value),
            ]),
          )
          const row = {
            object: "page",
            id: page,
            parent: { ...property(input.parent), database_id: databaseId },
            properties,
          }
          shared.rows.set(page, row)
          const kind = property(property(properties[fields.Kind]).select).name
          if (!injected && kind === options.unknownOn) {
            injected = true
            if (options.invisible) shared.hidden.add(page)
            return Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "The server accepted the record, but the client did not receive its result.",
              ),
            )
          }
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED", "Observation recovery attempted an unrelated request.", { path }),
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

const observerInput = (
  events: readonly FileEvent[] = [],
  plans: readonly SharedObservationPlan[] = [],
) => ({
  library,
  skillPageId: skillId,
  fileId: "file-main",
  pageId: bodyPageId,
  events,
  plans,
  // The production consumer has already checked body writes in its shared batch.
  bodyWrites: [],
  initialNative: true,
})
const writes = (calls: ReturnType<typeof client>["calls"]) =>
  calls.filter((call) => call.path === "v1/pages")
const bodyReads = (calls: ReturnType<typeof client>["calls"]) =>
  calls.filter((call) => call.path.includes(`/pages/${bodyPageId}/markdown`))

function planned(fileId = "file-main", markdown = originalBody, downloadedAt = 1234) {
  const hash = digest(markdown),
    bytes = new TextEncoder().encode(markdown).byteLength
  const content = { object_id: `body-${hash}`, sha256: hash, bytes }
  const eventHash = digest(
    canonicalSharedJson({ version: 1, file_id: fileId, parents: [], content }),
  )
  return makeSharedObservationPlan({
    skillPageId: skillId,
    fileId,
    pageId: bodyPageId,
    body: {
      page_id: bodyPageId,
      markdown,
      fingerprint: { normalization_version: 1, sha256: hash },
      bytes,
      downloaded_at: downloadedAt,
    },
    event: {
      event_id: `adopt-${eventHash}`,
      file_id: fileId,
      parents: [],
      kind: "adopted",
      content,
    },
  })
}

function seedPlan(shared: Remote, plan: SharedObservationPlan) {
  const page = id(shared.nextPage++)
  const payload = canonicalSharedJson({
    version: 1,
    operation_id: plan.operation_id,
    payload: plan,
  })
  const rich = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] })
  const values = {
    [fields.Name]: { title: [{ type: "text", text: { content: "Original observation" } }] },
    [fields["Record ID"]]: rich(plan.operation_id),
    [fields["Entity ID"]]: rich(plan.file_id),
    [fields.Kind]: { select: { name: "operation" } },
    [fields.Skill]: { relation: [{ id: skillId }] },
    [fields.Hash]: rich(digest(payload)),
    [fields.Payload]: rich(payload),
  }
  const row = {
    object: "page",
    id: page,
    parent: { type: "data_source_id", data_source_id: dataSourceId, database_id: databaseId },
    properties: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, responseProperty(key, value)]),
    ),
  }
  shared.rows.set(page, row)
  return row
}

describe("frozen shared observation operations", () => {
  test("freezes bytes, parent frontier and original download time in a content-verified plan", async () => {
    const api = client(remote())
    const first = await api.run(planned())
    const second = await api.run(planned("file-main", originalBody, 5678))
    expect(first.event.event_id).toBe(second.event.event_id)
    expect(first.operation_id).not.toBe(second.operation_id)
    expect((await api.run(validateSharedObservationPlan(first))).body.downloaded_at).toBe(1234)
    await expect(
      api.run(
        validateSharedObservationPlan({ ...first, body: { ...first.body, downloaded_at: 5678 } }),
      ),
    ).rejects.toThrow()
    await expect(
      api.run(
        validateSharedObservationPlan({
          ...first,
          body: { ...first.body, markdown: "replacement" },
        }),
      ),
    ).rejects.toThrow()
    expect(api.calls).toHaveLength(0)
  })

  test("records a local dispatch receipt before the shared plan, object and event writes", async () => {
    const shared = remote(),
      api = client(shared)
    let receipt: SharedObservationPlan | undefined
    const observed = await api.run(
      observeSharedFile({
        ...observerInput(),
        beforePlanWrite: (plan) =>
          Effect.sync(() => {
            expect(writes(api.calls)).toHaveLength(0)
            receipt = plan
          }),
      }),
    )
    if (!observed.changed) throw new Error("Expected initial observation")
    expect(receipt).toEqual(observed.operation)
    expect(
      writes(api.calls).map(
        (call) => property(property(property(call.body).properties)[fields.Kind]).select,
      ),
    ).toEqual([{ name: "operation" }, { name: "object" }, { name: "file_event" }])
    const prechecks = api.calls.filter((call) => call.path.includes("/query?"))
    expect(prechecks.map((call) => call.content)).toEqual(["body", "body", undefined])
  })

  test("a failed local receipt write prevents every shared write", async () => {
    const shared = remote(),
      api = client(shared)
    const result = await api.run(
      observeSharedFile({
        ...observerInput(),
        beforePlanWrite: () =>
          Effect.fail(fail("RECEIPT_UNAVAILABLE", "Cannot durably preserve the dispatch receipt.")),
      }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(writes(api.calls)).toHaveLength(0)
    expect(shared.rows.size).toBe(0)
  })

  test("oversized canonical envelopes fail before a local pending receipt is saved", async () => {
    const shared = remote("\n".repeat(40_000)),
      api = client(shared)
    let receipts = 0
    const result = await api.run(
      observeSharedFile({
        ...observerInput(),
        beforePlanWrite: () =>
          Effect.sync(() => {
            receipts += 1
          }),
      }).pipe(Effect.result),
    )
    if (result._tag !== "Failure") throw new Error("Expected bounded shared envelope")
    expect(result.failure.code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(receipts).toBe(0)
    expect(writes(api.calls)).toHaveLength(0)
    expect(bodyReads(api.calls)).toHaveLength(1)
    expect(shared.rows.size).toBe(0)
  })

  test("an invisible unknown first plan uses the original receipt and does not reread or resend", async () => {
    const shared = remote(),
      first = client(shared, { unknownOn: "operation", invisible: true })
    const result = await first.run(observeSharedFile(observerInput()).pipe(Effect.result))
    if (result._tag !== "Failure") throw new Error("Expected unknown plan")
    expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(property(result.failure.details).first_plan_visibility_boundary).toBe(true)
    const plan = await first.run(
      validateSharedObservationPlan(property(property(result.failure.details).recovery).plan),
    )
    shared.markdown = "later page edit\n"
    const next = client(shared)
    const recovery = await next.run(
      observeSharedFile(observerInput([], [plan])).pipe(Effect.result),
    )
    if (recovery._tag !== "Failure") throw new Error("Expected unresolved original plan")
    expect(recovery.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(property(recovery.failure.details).observation_operation_id).toBe(plan.operation_id)
    expect(writes(next.calls)).toHaveLength(0)
    expect(bodyReads(next.calls)).toHaveLength(0)
    expect(writes(first.calls)).toHaveLength(1)
  })

  test.each(["object", "file_event"] satisfies Kind[])(
    "another client discovers an unknown %s plan without replacing its body or IDs",
    async (unknownOn) => {
      const shared = remote(),
        first = client(shared, { unknownOn, invisible: true })
      const result = await first.run(observeSharedFile(observerInput()).pipe(Effect.result))
      if (result._tag !== "Failure") throw new Error("Expected unknown target fact")
      const original = await first.run(
        validateSharedObservationPlan(property(property(result.failure.details).recovery).plan),
      )
      shared.markdown = "later current body\n"
      const second = client(shared)
      const plans = await second.run(
        loadPendingSharedObservationPlans(library, { skillPageId: skillId, events: [] }),
      )
      expect(plans).toEqual([original])
      expect(second.calls).toHaveLength(2)
      expect(
        new URL(second.calls[0]?.path ?? "", "https://notion.test/").searchParams.getAll(
          "filter_properties",
        ),
      ).not.toContain(fields.Payload)
      expect(second.calls[0]?.content).toBeUndefined()
      expect(second.calls[1]?.content).toBe("body")
      const recovery = await second.run(
        observeSharedFile(observerInput([], plans)).pipe(Effect.result),
      )
      if (recovery._tag !== "Failure") throw new Error("Expected unresolved original target")
      expect(recovery.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
      expect(property(recovery.failure.details).observation_operation_id).toBe(
        original.operation_id,
      )
      expect(property(property(recovery.failure.details).recovery).plan).toEqual(original)
      expect(writes(second.calls)).toHaveLength(0)
      expect(bodyReads(second.calls)).toHaveLength(0)
    },
  )

  test("successful original reconciliation requires a new read and cannot publish old bytes with a new time", async () => {
    const shared = remote(),
      first = client(shared, { unknownOn: "file_event", invisible: true })
    const failed = await first.run(observeSharedFile(observerInput()).pipe(Effect.result))
    if (failed._tag !== "Failure") throw new Error("Expected unknown event")
    const original = await first.run(
      validateSharedObservationPlan(property(property(failed.failure.details).recovery).plan),
    )
    shared.hidden.clear()
    shared.markdown = "new current body after original plan\n"
    const next = client(shared)
    const recovered = await next.run(
      observeSharedFile(observerInput([], [original])).pipe(Effect.result),
    )
    if (recovered._tag !== "Failure")
      throw new Error("Recovery must not publish a current observation")
    expect(recovered.failure.code).toBe("SHARED_OBSERVATION_RECONCILED")
    expect(property(recovered.failure.details).original_downloaded_at).toBe(
      original.body.downloaded_at,
    )
    expect(writes(next.calls)).toHaveLength(0)
    expect(bodyReads(next.calls)).toHaveLength(0)
    const pending = await next.run(
      loadPendingSharedObservationPlans(library, {
        skillPageId: skillId,
        events: [original.event],
      }),
    )
    expect(pending).toEqual([])
    const current = await next.run(observeSharedFile(observerInput([original.event], pending)))
    if (!current.changed) throw new Error("Expected later user edit to be retained")
    expect(current.body.markdown).toBe(shared.markdown)
    expect(current.event.parents).toEqual([original.event.event_id])
    expect(current.operation.operation_id).not.toBe(original.operation_id)
    expect(bodyReads(next.calls)).toHaveLength(1)
  })

  test("a persisted plan alone cannot authorize replay of missing downstream facts", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(planned())
    seedPlan(shared, plan)
    const result = await api.run(
      commitSharedObservationPlan(library, { mode: "reconcile", plan }).pipe(Effect.result),
    )
    if (result._tag !== "Failure") throw new Error("Expected unobserved original object")
    expect(result.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(property(result.failure.details).observation_stage).toBe("object")
    expect(writes(api.calls)).toHaveLength(0)
  })

  test("101 completed operation plans scan two compact metadata pages and zero historical bodies", async () => {
    const shared = remote(),
      api = client(shared)
    const events: FileEvent[] = []
    for (let index = 0; index < 101; index++) {
      const plan = await api.run(
        planned(`file-${index}`, `${index}: ${"body".repeat(1024)}`, 1000 + index),
      )
      seedPlan(shared, plan)
      events.push(plan.event)
    }
    const pending = await api.run(
      loadPendingSharedObservationPlans(library, { skillPageId: skillId, events }),
    )
    expect(pending).toEqual([])
    expect(api.calls).toHaveLength(2)
    expect(
      api.calls.every(
        (call) =>
          call.content === undefined &&
          !new URL(call.path, "https://notion.test/").searchParams
            .getAll("filter_properties")
            .includes(fields.Payload),
      ),
    ).toBe(true)
    expect(property(api.calls[1]?.body).start_cursor).toBe("cursor-100")
    expect(writes(api.calls)).toHaveLength(0)
  })

  test("foreign indexed rows cannot be used to declare an operation resolved", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(planned())
    const row = seedPlan(shared, plan)
    row.parent.data_source_id = id(999)
    await expect(
      api.run(
        loadPendingSharedObservationPlans(library, { skillPageId: skillId, events: [plan.event] }),
      ),
    ).rejects.toThrow("foreign")
    expect(api.calls).toHaveLength(1)
  })

  test("conflicting duplicate index identities fail before reading or writing plan bodies", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(planned())
    seedPlan(shared, plan)
    const duplicate = seedPlan(shared, plan)
    property(duplicate.properties)[fields.Hash] = responseProperty(fields.Hash, {
      rich_text: [{ plain_text: "a".repeat(64) }],
    })
    const result = await api.run(
      loadPendingSharedObservationPlans(library, {
        skillPageId: skillId,
        events: [plan.event],
      }).pipe(Effect.result),
    )
    if (result._tag !== "Failure") throw new Error("Expected conflicting plan headers")
    expect(result.failure.code).toBe("SHARED_RECORD_CONFLICT")
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.content).toBeUndefined()
  })
})
