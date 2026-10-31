import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  type AppendSharedRecordInput,
} from "../src/shared-records.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillId = id(1)
const dataSourceId = id(2)
const databaseId = id(3)
const propertyIds = {
  Name: "title",
  "Record ID": "r%3Aid",
  Kind: "kind",
  "Entity ID": "entity",
  Hash: "hash",
  Payload: "payload",
  Skill: "skill",
}
const library: SharedLibrary = {
  version: 1,
  library_id: "library-fixture",
  operation_id: "library-init-fixture",
  parent_page_id: id(4),
  skills: { database_id: id(5), data_source_id: id(6), property_ids: {} },
  files: { database_id: id(7), data_source_id: id(8), property_ids: {} },
  records: { database_id: databaseId, data_source_id: dataSourceId, property_ids: propertyIds },
}
const envelope = '{"operation_id":"op-1","payload":{"a":1,"b":2},"version":1}'
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const defaultInput: AppendSharedRecordInput = {
  mode: "create",
  recordId: "record-1",
  operationId: "op-1",
  skillPageId: skillId,
  kind: "file_event",
  entityId: "file-1",
  payload: { b: 2, a: 1 },
}

function rich(propertyId: string, value: string) {
  return {
    id: propertyId,
    type: "rich_text",
    rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
  }
}

function row(
  options: {
    n?: number
    recordId?: string
    entityId?: string
    encoded?: string
    hash?: string
    skillIds?: readonly string[]
    relationHasMore?: boolean
    dataSourceId?: string
  } = {},
) {
  const properties: Record<string, unknown> = {
    Name: {
      id: propertyIds.Name,
      type: "title",
      title: [{ plain_text: "Unimportant display name" }],
    },
    "Record ID": rich(propertyIds["Record ID"], options.recordId ?? "record-1"),
    Kind: { id: propertyIds.Kind, type: "select", select: { name: "file_event" } },
    "Entity ID": rich(propertyIds["Entity ID"], options.entityId ?? "file-1"),
    Hash: rich(propertyIds.Hash, options.hash ?? digest(envelope)),
    Payload: rich(propertyIds.Payload, options.encoded ?? envelope),
    Skill: {
      id: propertyIds.Skill,
      type: "relation",
      relation: (options.skillIds ?? [skillId]).map((value) => ({ id: value })),
      has_more: options.relationHasMore ?? false,
    },
  }
  return {
    object: "page",
    id: id(100 + (options.n ?? 1)),
    parent: {
      type: "data_source_id",
      data_source_id: options.dataSourceId ?? dataSourceId,
      database_id: databaseId,
    },
    properties,
  }
}

const page = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})

function client(responses: readonly unknown[]) {
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        const index = calls.length
        calls.push({ path, body, method: options?.method })
        if (index >= responses.length)
          return Effect.fail(fail("UNEXPECTED_REQUEST", "Unexpected extra Notion request."))
        const response = responses[index]
        return response instanceof SkillsError ? Effect.fail(response) : Effect.succeed(response)
      }),
  }
  const layer = Layer.mergeAll(NodeServices.layer, Layer.succeed(Notion, api))
  return {
    calls,
    run: <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
  }
}

describe("append-only shared Records", () => {
  test("creates one verified record using canonical envelope bytes and stable property IDs", async () => {
    const api = client([page([]), row()])
    const result = await api.run(appendSharedRecord(library, defaultInput))
    expect(result).toMatchObject({
      record_id: "record-1",
      operation_id: "op-1",
      skill_page_id: skillId,
      hash: digest(envelope),
      payload: { a: 1, b: 2 },
    })
    expect(api.calls).toHaveLength(2)
    expect(api.calls[0]?.body).toEqual({
      page_size: 100,
      filter: {
        and: [
          { property: propertyIds.Skill, relation: { contains: skillId } },
          { property: propertyIds["Record ID"], rich_text: { equals: "record-1" } },
        ],
      },
    })
    const create = api.calls[1]
    expect(create?.path).toBe("v1/pages")
    expect(create?.method).toBe("POST")
    const body = property(create?.body)
    expect(body.parent).toEqual({ type: "data_source_id", data_source_id: dataSourceId })
    const props = property(body.properties)
    expect(text(property(props[propertyIds.Payload]).rich_text)).toBe(envelope)
    expect(text(property(props[propertyIds.Hash]).rich_text)).toBe(digest(envelope))
    expect(props).not.toHaveProperty("Record ID")
  })

  test("reattaches an identical fact without a write even when display properties are renamed", async () => {
    const original = row({ encoded: '{"version":1,"payload":{"b":2,"a":1},"operation_id":"op-1"}' })
    const renamed = {
      ...original,
      properties: Object.fromEntries(
        Object.entries(original.properties).map(([key, value]) => [`renamed-${key}`, value]),
      ),
    }
    const api = client([page([renamed])])
    expect((await api.run(appendSharedRecord(library, defaultInput))).page_id).toBe(id(101))
    expect(api.calls).toHaveLength(1)
  })

  test("does not replay an unknown create; reconcile reads the original IDs", async () => {
    const api = client([page([]), fail("WRITE_OUTCOME_UNKNOWN", "Response lost."), page([row()])])
    const first = await api.run(appendSharedRecord(library, defaultInput).pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    if (first._tag !== "Failure") throw new Error("Expected unknown outcome")
    expect(first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(first.failure.details).toMatchObject({
      record_id: "record-1",
      operation_id: "op-1",
      next_mode: "reconcile",
    })
    expect(api.calls).toHaveLength(2)
    const reconciled = await api.run(
      appendSharedRecord(library, { ...defaultInput, mode: "reconcile" }),
    )
    expect(reconciled.record_id).toBe("record-1")
    expect(api.calls.filter((call) => call.path === "v1/pages")).toHaveLength(1)
  })

  test("reconcile absence remains unresolved and never creates a replacement", async () => {
    const api = client([page([])])
    const result = await api.run(
      appendSharedRecord(library, { ...defaultInput, mode: "reconcile" }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected unresolved outcome")
    expect(result.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(result.failure.details).toMatchObject({ record_id: "record-1", operation_id: "op-1" })
    expect(api.calls).toHaveLength(1)
  })

  test("the same Record ID with another valid payload is a conflict, not an update", async () => {
    const changed = '{"operation_id":"op-1","payload":{"a":9},"version":1}'
    const api = client([page([row({ encoded: changed, hash: digest(changed) })])])
    const result = await api.run(appendSharedRecord(library, defaultInput).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected conflict")
    expect(result.failure.code).toBe("SHARED_RECORD_CONFLICT")
    expect(api.calls).toHaveLength(1)
  })

  test("the Record ID lookup does not hide a conflicting kind or entity behind its filter", async () => {
    const api = client([page([row({ entityId: "another-file" })])])
    await expect(api.run(appendSharedRecord(library, defaultInput))).rejects.toThrow(
      "different shared fact",
    )
    const filters = property(property(api.calls[0]?.body).filter).and
    expect(filters).toEqual([
      { property: propertyIds.Skill, relation: { contains: skillId } },
      { property: propertyIds["Record ID"], rich_text: { equals: "record-1" } },
    ])
  })

  test("verifies hashes locally and rejects tampering", async () => {
    const api = client([page([row({ hash: "a".repeat(64) })])])
    await expect(api.run(querySharedRecords(library, { skillPageId: skillId }))).rejects.toThrow(
      "does not match",
    )
    expect(api.calls).toHaveLength(1)
  })

  test("ownership discovery never queries object bodies without an explicit entity", async () => {
    const api = client([page([])])
    await api.run(querySharedRecords(library, { skillPageId: skillId }))
    expect(property(api.calls[0]?.body).filter).toEqual({
      and: [
        { property: propertyIds.Skill, relation: { contains: skillId } },
        { property: propertyIds.Kind, select: { equals: "file_event" } },
      ],
    })
    const blocked = client([])
    await expect(
      blocked.run(querySharedRecords(library, { skillPageId: skillId, kind: "object" })),
    ).rejects.toThrow("explicit Entity ID")
    expect(blocked.calls).toHaveLength(0)
  })

  test("unverifiable create response preserves an unknown outcome", async () => {
    const api = client([page([]), row({ dataSourceId: id(999) })])
    const result = await api.run(appendSharedRecord(library, defaultInput).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected unknown outcome")
    expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(result.failure.details).toMatchObject({
      record_id: "record-1",
      operation_id: "op-1",
      next_mode: "reconcile",
    })
    expect(api.calls).toHaveLength(2)
  })

  test("queries 101 selected facts with two metadata pages and no individual GETs", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      row({ n: index + 1, recordId: `record-${index + 1}` }),
    )
    const api = client([page(first, "next-page"), page([row({ n: 101, recordId: "record-101" })])])
    const records = await api.run(
      querySharedRecords(library, { skillPageId: skillId, kind: "file_event", entityId: "file-1" }),
    )
    expect(records).toHaveLength(101)
    expect(api.calls).toHaveLength(2)
    for (const call of api.calls) {
      expect(call.method).toBe("POST")
      const url = new URL(call.path, "https://api.notion.com/")
      expect(url.pathname).toBe(`/v1/data_sources/${dataSourceId}/query`)
      expect(url.searchParams.getAll("filter_properties")).toEqual([
        propertyIds["Record ID"],
        propertyIds.Kind,
        propertyIds["Entity ID"],
        propertyIds.Hash,
        propertyIds.Payload,
        propertyIds.Skill,
      ])
    }
    expect(property(api.calls[1]?.body).start_cursor).toBe("next-page")
  })

  test("coalesces duplicate immutable facts across different page IDs", async () => {
    const api = client([page([row({ n: 2 }), row({ n: 1 })])])
    const records = await api.run(querySharedRecords(library, { skillPageId: skillId }))
    expect(records).toHaveLength(1)
    expect(records[0]?.page_id).toBe(id(101))
  })

  test("rejects incompatible duplicates even when both payloads have valid hashes", async () => {
    const changed = '{"operation_id":"op-2","payload":{"a":1,"b":2},"version":1}'
    const api = client([page([row(), row({ n: 2, encoded: changed, hash: digest(changed) })])])
    await expect(api.run(querySharedRecords(library, { skillPageId: skillId }))).rejects.toThrow(
      "incompatible",
    )
  })

  test.each([
    { dataSourceId: id(999) },
    { skillIds: [] },
    { skillIds: [id(999)] },
    { skillIds: [skillId, id(999)] },
    { relationHasMore: true },
  ])("rejects foreign or incomplete ownership %j", async (options) => {
    const api = client([page([row(options)])])
    await expect(api.run(querySharedRecords(library, { skillPageId: skillId }))).rejects.toThrow()
    expect(api.calls).toHaveLength(1)
  })

  test("rejects missing relation completeness and unknown envelope versions", async () => {
    const original = row()
    const skill = property(original.properties.Skill)
    const { has_more: _hasMore, ...incompleteSkill } = skill
    const incomplete = {
      ...original,
      properties: { ...original.properties, Skill: incompleteSkill },
    }
    await expect(
      client([page([incomplete])]).run(querySharedRecords(library, { skillPageId: skillId })),
    ).rejects.toThrow("complete Skill relation")
    const future = '{"operation_id":"op-1","payload":{},"version":2}'
    await expect(
      client([page([row({ encoded: future, hash: digest(future) })])]).run(
        querySharedRecords(library, { skillPageId: skillId }),
      ),
    ).rejects.toThrow()
  })

  test("rejects partial query results, missing cursors, and repeated pages or cursors", async () => {
    const cases = [
      [{ ...page([]), request_status: { type: "incomplete" } }],
      [{ ...page([]), has_more: true }],
      [page([row()], "next"), page([row()])],
      [page([row()], "same"), page([row({ n: 2, recordId: "record-2" })], "same")],
    ]
    for (const responses of cases) {
      const api = client(responses)
      await expect(api.run(querySharedRecords(library, { skillPageId: skillId }))).rejects.toThrow()
      expect(api.calls.length).toBeLessThanOrEqual(2)
    }
  })

  test("validates payloads and size before any remote request", async () => {
    const bad: unknown[] = [
      undefined,
      { missing: undefined },
      { value: Number.NaN },
      new Date(),
      { large: "界".repeat(23_000) },
    ]
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    bad.push(cycle)
    for (const payload of bad) {
      const api = client([])
      await expect(
        api.run(appendSharedRecord(library, { ...defaultInput, payload })),
      ).rejects.toThrow()
      expect(api.calls).toHaveLength(0)
    }
  })

  test("chunks Unicode Payload into at most 2000 UTF-16 units without splitting surrogate pairs", async () => {
    const payload = { value: "😀".repeat(2_100) }
    const encoded = JSON.stringify({ operation_id: "op-1", payload, version: 1 })
    const api = client([page([]), row({ encoded, hash: digest(encoded) })])
    await api.run(appendSharedRecord(library, { ...defaultInput, payload }))
    const props = property(property(api.calls[1]?.body).properties)
    const chunks = property(props[propertyIds.Payload]).rich_text
    if (!Array.isArray(chunks)) throw new Error("Missing payload chunks")
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const content = property(property(chunk).text).content
      if (typeof content !== "string") throw new Error("Invalid payload chunk")
      expect(content.length).toBeLessThanOrEqual(2000)
      expect(/[\uD800-\uDBFF]$/u.test(content)).toBe(false)
      expect(/^[\uDC00-\uDFFF]/u.test(content)).toBe(false)
    }
    expect(text(chunks)).toBe(encoded)
  })

  test("canonical JSON orders object keys without changing arrays or body text", () => {
    expect(canonicalSharedJson({ z: [3, 1], a: { beta: "line\r\n", alpha: "  code  " } })).toBe(
      '{"a":{"alpha":"  code  ","beta":"line\\r\\n"},"z":[3,1]}',
    )
  })
})
