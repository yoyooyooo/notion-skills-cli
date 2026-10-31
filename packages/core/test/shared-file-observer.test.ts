import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Crypto, Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { decode, fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library.ts"
import { loadRetainedBody, observeSharedFile } from "../src/shared-file-observer.ts"
import { makeSharedBodyWritePlan } from "../src/shared-body-write-model.ts"
import {
  FileEventSchema,
  resolveFileState,
  type FileEvent,
  type RetainedContent,
} from "../src/shared-file-state.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
} from "../src/shared-records.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const skillId = id(1)
const dataSourceId = id(2)
const databaseId = id(3)
const bodyPageId = id(4)
const fileId = "file-main"
const properties = {
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
  library_id: "lib-observer",
  operation_id: "init-observer",
  parent_page_id: id(5),
  skills: { database_id: id(6), data_source_id: id(7), property_ids: {} },
  files: { database_id: id(8), data_source_id: id(9), property_ids: {} },
  records: { database_id: databaseId, data_source_id: dataSourceId, property_ids: properties },
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function projected(markdown = "upstream\n"): FileEvent {
  return {
    event_id: "projection-1",
    file_id: fileId,
    parents: [],
    kind: "projected",
    source_revision: "git-commit-1",
    projection: { normalization_version: 1, sha256: hash(markdown) },
  }
}

function remote(markdown: string) {
  return {
    bodies: new Map<string, string>([[bodyPageId, markdown]]),
    records: new Map<string, Record<string, unknown>>(),
    nextPage: 100,
  }
}
type Remote = ReturnType<typeof remote>

function responseProperty(propertyId: string, value: unknown) {
  const input = property(value)
  if (Array.isArray(input.rich_text))
    return { id: propertyId, type: "rich_text", rich_text: input.rich_text, has_more: false }
  if (Array.isArray(input.title)) return { id: propertyId, type: "title", title: input.title }
  if (Array.isArray(input.relation))
    return { id: propertyId, type: "relation", relation: input.relation, has_more: false }
  if (input.select !== undefined) return { id: propertyId, type: "select", select: input.select }
  throw new Error("Unexpected fixture property")
}

function matches(row: Record<string, unknown>, condition: unknown): boolean {
  const filter = property(condition)
  if (Array.isArray(filter.and)) return filter.and.every((part) => matches(row, part))
  const key = filter.property
  if (typeof key !== "string") return false
  const value = property(property(row.properties)[key])
  if (filter.relation !== undefined) {
    const target = property(filter.relation).contains
    return (
      Array.isArray(value.relation) && value.relation.some((item) => property(item).id === target)
    )
  }
  if (filter.select !== undefined)
    return property(value.select).name === property(filter.select).equals
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}

function client(
  shared: Remote,
  options: { identity?: string; unknownOn?: "object" | "file_event" } = {},
) {
  const calls: Array<{ path: string; body: unknown; method: string | undefined }> = []
  let injected = false
  const api: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed(options.identity ?? "machine-a"),
    request: (path, body, requestOptions) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        calls.push({ path, body, method: requestOptions?.method })
        const url = new URL(path, "https://api.notion.com/")
        const markdownMatch = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(url.pathname)
        if (markdownMatch) {
          const pageId = markdownMatch[1]
          if (pageId === undefined)
            return Effect.fail(fail("FIXTURE_ERROR", "Missing requested page"))
          const markdown = shared.bodies.get(pageId)
          return markdown === undefined
            ? Effect.fail(fail("NOT_FOUND", "Current body unavailable."))
            : Effect.succeed({ id: pageId, markdown, truncated: false, unknown_block_ids: [] })
        }
        if (url.pathname === `/v1/data_sources/${dataSourceId}/query`) {
          const filter = property(body).filter
          const selected = [...shared.records.values()].filter((row) => matches(row, filter))
          return Effect.succeed({
            object: "list",
            results: selected,
            has_more: false,
            next_cursor: null,
          })
        }
        if (url.pathname === "/v1/pages" && requestOptions?.method === "POST") {
          const pageId = id(shared.nextPage++)
          const input = property(body)
          const recordProperties = Object.fromEntries(
            Object.entries(property(input.properties)).map(([propertyId, value]) => [
              propertyId,
              responseProperty(propertyId, value),
            ]),
          )
          const row = {
            object: "page",
            id: pageId,
            parent: { ...property(input.parent), database_id: databaseId },
            properties: recordProperties,
          }
          shared.records.set(pageId, row)
          const kind = property(property(recordProperties[properties.Kind]).select).name
          if (!injected && kind === options.unknownOn) {
            injected = true
            return Effect.fail(
              fail(
                "WRITE_OUTCOME_UNKNOWN",
                "The fixture accepted the write but dropped its response.",
              ),
            )
          }
          return Effect.succeed(row)
        }
        return Effect.fail(
          fail("UNEXPECTED_REQUEST", "Observer attempted an unrecognized remote operation.", {
            path,
          }),
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

const input = (events: readonly FileEvent[], initialNative?: boolean) => ({
  library,
  skillPageId: skillId,
  fileId,
  pageId: bodyPageId,
  events,
  // Standard snapshot callers supply their single batch-validated operation scan.
  bodyWrites: [],
  ...(initialNative === undefined ? {} : { initialNative }),
})

function retained(state: ReturnType<typeof resolveFileState>): RetainedContent {
  if (state.ownership.kind !== "custom") throw new Error("Expected custom ownership")
  return state.ownership.content
}

function countKind(shared: Remote, kind: string) {
  return [...shared.records.values()].filter(
    (row) => property(property(property(row.properties)[properties.Kind]).select).name === kind,
  ).length
}

function seedProjection(event: FileEvent) {
  return appendSharedRecord(library, {
    mode: "create",
    recordId: event.event_id,
    operationId: event.event_id,
    skillPageId: skillId,
    kind: "file_event",
    entityId: fileId,
    payload: event,
  })
}

describe("shared file body observation", () => {
  test("a standalone caller discovers an original body write before reading or adopting its candidate", async () => {
    const shared = remote("system candidate\n"),
      api = client(shared)
    const baseline = projected()
    const plan = await api.run(
      makeSharedBodyWritePlan({
        library_id: library.library_id,
        skill_page_id: skillId,
        skill_id: "stable-observer-skill",
        file_id: fileId,
        page_id: bodyPageId,
        path: "SKILL.md",
        source_id: "fixed-source",
        action: "write",
        before: {
          page_id: bodyPageId,
          raw_markdown: "upstream\n",
          markdown: "upstream\n",
          fingerprint: { normalization_version: 1, sha256: hash("upstream\n") },
          bytes: 9,
          downloaded_at: 1234,
        },
        candidateMarkdown: "system candidate\n",
        parents: [baseline.event_id],
      }),
    )
    await api.run(
      appendSharedRecord(library, {
        mode: "create",
        recordId: plan.operation_id,
        operationId: plan.operation_id,
        skillPageId: skillId,
        kind: "operation",
        entityId: fileId,
        payload: plan,
        payloadContainsBody: true,
      }),
    )
    api.calls.length = 0
    const result = await api.run(
      observeSharedFile({ ...input([baseline]), bodyWrites: undefined }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected original write barrier")
    expect(result.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(
      api.calls.some((call) => call.path.includes("/markdown") || call.path === "v1/pages"),
    ).toBe(false)
    expect(countKind(shared, "file_event")).toBe(0)
    const projection = new URL(api.calls[0]?.path ?? "", "https://notion.test").searchParams.getAll(
      "filter_properties",
    )
    expect(projection).not.toContain(properties.Payload)
    expect(projection).toContain(properties["Record ID"])
  })

  test("a changed following body freezes its plan and retains bytes before whole-file adoption", async () => {
    const shared = remote("user edit\n")
    const api = client(shared)
    const baseline = projected()
    await api.run(seedProjection(baseline))
    api.calls.length = 0
    const result = await api.run(observeSharedFile(input([baseline])))
    expect(result.changed).toBe(true)
    expect(result.state.ownership.kind).toBe("custom")
    const content = retained(result.state)
    expect(content).toEqual({
      object_id: `body-${hash("user edit\n")}`,
      sha256: hash("user edit\n"),
      bytes: 10,
    })
    if (!result.changed) throw new Error("Expected adoption event")
    expect(result.event).toMatchObject({
      kind: "adopted",
      file_id: fileId,
      parents: [baseline.event_id],
      content,
    })
    const writes = api.calls.filter((call) => call.path === "v1/pages")
    expect(writes).toHaveLength(3)
    const kinds = writes.map(
      (call) => property(property(property(call.body).properties)[properties.Kind]).select,
    )
    expect(kinds).toEqual([{ name: "operation" }, { name: "object" }, { name: "file_event" }])
    expect(result.operation.body).toEqual(result.body)
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false)
    expect(shared.bodies.get(bodyPageId)).toBe("user edit\n")
  })

  test("unchanged body after metadata changes writes no state or body", async () => {
    const shared = remote("upstream\r\n")
    const api = client(shared)
    const result = await api.run(observeSharedFile(input([projected()])))
    expect(result.changed).toBe(false)
    expect(result.state.ownership.kind).toBe("following")
    expect(result.body.markdown).toBe("upstream\n")
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.path).toBe(`v1/pages/${bodyPageId}/markdown?markdown_version=v2`)
    expect(shared.records.size).toBe(0)
  })

  test("custom content changed back to upstream remains custom", async () => {
    const shared = remote("custom content\n")
    const api = client(shared)
    const baseline = projected()
    await api.run(seedProjection(baseline))
    const first = await api.run(observeSharedFile(input([baseline])))
    if (!first.changed) throw new Error("Expected initial customization")
    shared.bodies.set(bodyPageId, "upstream\n")
    const second = await api.run(observeSharedFile(input([baseline, first.event])))
    expect(second.changed).toBe(true)
    expect(second.state.ownership.kind).toBe("custom")
    expect(retained(second.state).sha256).toBe(hash("upstream\n"))
    if (!second.changed) throw new Error("Expected a custom revision")
    expect(second.event.parents).toEqual([first.event.event_id])
    const third = await api.run(observeSharedFile(input([baseline, first.event, second.event])))
    expect(third.changed).toBe(false)
    expect(third.state.ownership.kind).toBe("custom")
  })

  test("two independent services reconstruct native ownership and exact history from shared records", async () => {
    const shared = remote("native body\n")
    const machineA = client(shared, { identity: "machine-a" })
    const first = await machineA.run(observeSharedFile(input([], true)))
    expect(first.changed).toBe(true)
    const content = retained(first.state)

    // The second service has no first-service state, cache, or current body access.
    shared.bodies.delete(bodyPageId)
    const machineB = client(shared, { identity: "machine-b" })
    const records = await machineB.run(
      querySharedRecords(library, { skillPageId: skillId, kind: "file_event", entityId: fileId }),
    )
    const events = records.map((record) => decode(FileEventSchema, record.payload))
    const reconstructed = resolveFileState(fileId, events)
    expect(reconstructed).toEqual(first.state)
    const body = await machineB.run(loadRetainedBody(library, skillId, content))
    expect(body.markdown).toBe("native body\n")
    expect(body.bytes).toBe(new TextEncoder().encode("native body\n").byteLength)
    expect(machineB.calls).toHaveLength(2)
    expect(
      machineB.calls.every((call) =>
        call.path.startsWith(`v1/data_sources/${dataSourceId}/query?`),
      ),
    ).toBe(true)
  })

  test("a repeated observation using complete shared facts creates no replacement operation", async () => {
    const shared = remote("same native\n")
    const first = await client(shared).run(observeSharedFile(input([], true)))
    if (!first.changed) throw new Error("Expected initial native adoption")
    const secondClient = client(shared, { identity: "another-machine" })
    const second = await secondClient.run(observeSharedFile(input([first.event])))
    expect(first.state).toEqual(second.state)
    expect(countKind(shared, "object")).toBe(1)
    expect(countKind(shared, "file_event")).toBe(1)
    expect(countKind(shared, "operation")).toBe(1)
    expect(secondClient.calls.some((call) => call.path === "v1/pages")).toBe(false)
  })

  test.each(["object", "file_event"] satisfies Array<"object" | "file_event">)(
    "unknown %s result prevents successful state publication",
    async (unknownOn) => {
      const shared = remote("retain before adoption\n")
      const api = client(shared, { unknownOn })
      const result = await api.run(observeSharedFile(input([], true)).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") throw new Error("Expected unknown write failure")
      expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(property(result.failure.details).next_mode).toBe("reconcile")
      expect(typeof property(result.failure.details).record_id).toBe("string")
      expect(countKind(shared, "operation")).toBe(1)
      expect(countKind(shared, "object")).toBe(1)
      expect(countKind(shared, "file_event")).toBe(unknownOn === "object" ? 0 : 1)
      expect(api.calls.some((call) => call.method === "PATCH")).toBe(false)
    },
  )

  test("missing baseline cannot infer following or write an initial event", async () => {
    const shared = remote("unproven existing body\n")
    const api = client(shared)
    const result = await api.run(observeSharedFile(input([])).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected missing baseline")
    expect(result.failure.code).toBe("BASELINE_MISSING")
    expect(api.calls).toHaveLength(0)
    expect(shared.records.size).toBe(0)
    expect(shared.bodies.get(bodyPageId)).toBe("unproven existing body\n")
  })

  test("a tombstone never revives because its current page still has a body", async () => {
    const markdown = "native body\n"
    const content: RetainedContent = {
      object_id: `body-${hash(markdown)}`,
      sha256: hash(markdown),
      bytes: new TextEncoder().encode(markdown).byteLength,
    }
    const adopted: FileEvent = {
      event_id: "initial",
      file_id: fileId,
      parents: [],
      kind: "adopted",
      content,
    }
    const deleted: FileEvent = {
      event_id: "deleted",
      file_id: fileId,
      parents: [adopted.event_id],
      kind: "deleted",
      retained: content,
    }
    const shared = remote("someone changed the old page\n")
    const api = client(shared)
    const result = await api.run(observeSharedFile(input([adopted, deleted])))
    expect(result.changed).toBe(false)
    expect(result.state.ownership.kind).toBe("tombstone")
    expect(shared.records.size).toBe(0)
  })

  test("oversized retained envelopes fail before any fact is written", async () => {
    const shared = remote("\n".repeat(40_000))
    const api = client(shared)
    const result = await api.run(observeSharedFile(input([], true)).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected size limit")
    expect(result.failure.code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(shared.records.size).toBe(0)
    expect(api.calls).toHaveLength(1)
  })

  test("incompatible shared heads fail before reading or changing the body", async () => {
    const a = projected("source a\n")
    const b: FileEvent = { ...projected("source b\n"), event_id: "projection-2" }
    const shared = remote("user body\n")
    const api = client(shared)
    await expect(api.run(observeSharedFile(input([a, b])))).rejects.toThrow(
      "Concurrent file changes",
    )
    expect(api.calls).toHaveLength(0)
  })
})

describe("retained shared body retrieval", () => {
  test("uses the fixed body even after the current page changes", async () => {
    const shared = remote("fixed version\n")
    const writer = client(shared)
    const observation = await writer.run(observeSharedFile(input([], true)))
    shared.bodies.set(bodyPageId, "new current version\n")
    const reader = client(shared)
    const historical = await reader.run(
      loadRetainedBody(library, skillId, retained(observation.state)),
    )
    expect(historical.markdown).toBe("fixed version\n")
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]?.path).not.toContain(`/pages/${bodyPageId}/`)
  })

  test("missing history does not fall back to available current content", async () => {
    const shared = remote("available current content\n")
    const api = client(shared)
    const wanted: RetainedContent = {
      object_id: `body-${hash("missing\n")}`,
      sha256: hash("missing\n"),
      bytes: 8,
    }
    const result = await api.run(loadRetainedBody(library, skillId, wanted).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected missing retained object")
    expect(result.failure.code).toBe("RETAINED_BODY_MISSING")
    expect(api.calls).toHaveLength(1)
  })

  test("checks fixed byte length independently of the Records envelope hash", async () => {
    const shared = remote("fixed bytes\n")
    const api = client(shared)
    const observation = await api.run(observeSharedFile(input([], true)))
    const content = retained(observation.state)
    await expect(
      api.run(loadRetainedBody(library, skillId, { ...content, bytes: content.bytes + 1 })),
    ).rejects.toThrow("fixed content reference")
  })

  test("rejects changed body bytes even when the outer envelope hash was recomputed", async () => {
    const shared = remote("original retained bytes\n")
    const api = client(shared)
    const observation = await api.run(observeSharedFile(input([], true)))
    const content = retained(observation.state)
    const objectRow = [...shared.records.values()].find(
      (row) =>
        property(property(property(row.properties)[properties.Kind]).select).name === "object",
    )
    if (objectRow === undefined) throw new Error("Missing retained object")
    const props = property(objectRow.properties)
    const altered = canonicalSharedJson({
      version: 1,
      operation_id: `retain-${content.sha256}`,
      payload: {
        version: 1,
        kind: "normalized_markdown",
        normalization_version: 1,
        markdown: "different retained bytes\n",
      },
    })
    props[properties.Payload] = {
      id: properties.Payload,
      type: "rich_text",
      rich_text: [{ plain_text: altered }],
    }
    props[properties.Hash] = {
      id: properties.Hash,
      type: "rich_text",
      rich_text: [{ plain_text: hash(altered) }],
    }
    await expect(api.run(loadRetainedBody(library, skillId, content))).rejects.toThrow(
      "fixed content reference",
    )
  })
})
