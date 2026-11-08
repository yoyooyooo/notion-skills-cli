import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import {
  appendSharedRecord,
  canonicalSharedJson,
  querySharedRecords,
  withSharedRecordPayloadCache,
} from "../src/shared-records.ts"
import {
  digest,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const entity = "retained-object"
const payload = { markdown: "The complete immutable original response.\n" }
const scope = digest("payload-cache-scope")
const selected = {
  skillPageId: skillPage,
  kind: "object" as const,
  entityId: entity,
  recordId: entity,
}
const read = () => querySharedRecords(library, selected)
const reconcile = () =>
  appendSharedRecord(library, {
    ...selected,
    mode: "reconcile",
    operationId: "retained-original",
    payload,
  })
const setup = (copies = 1) => {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  for (let index = 0; index < copies; index++)
    f.seedFact(payload, "object", entity, entity, "retained-original")
  return f
}
const cached = <A, E, R>(effect: Effect.Effect<A, E, R>, selectedScope = scope) =>
  withSharedRecordPayloadCache(effect, selectedScope)

describe("consumer-only verified retained Record payload reuse", () => {
  test("large compressed creation metadata caches its complete logical envelope and reuses only verified headers", async () => {
    const f = sharedSnapshotFixture({ fileCount: 1 })
    const fixed = {
      version: 1,
      kind: "git",
      files: Array.from({ length: 407 }, (_, index) => ({
        path: `complete/${index}/${"retained-path-".repeat(12)}`,
        sha256: digest(`file-${index}`),
        git_oid: digest(`blob-${index}`).slice(0, 40),
        bytes: 42,
        mode: "100644",
      })),
    }
    const large = {
      version: 1,
      kind: "skill_create_manifest",
      source_projection: { version: 1, binding: fixed, local: { baseline: fixed } },
    }
    const canonical = canonicalSharedJson({
      version: 1,
      operation_id: "large-original",
      payload: large,
    })
    expect(Buffer.byteLength(canonical)).toBeGreaterThan(180 * 1024)
    f.records.clear()
    f.seedFact(large, "operation", "large-manifest", "large-manifest", "large-original")
    const row = [...f.records.values()][0]!
    property(row.properties).payload = rich(
      "payload",
      JSON.stringify({
        version: 2,
        encoding: "gzip-base64",
        bytes: Buffer.byteLength(canonical),
        data: gzipSync(canonical).toString("base64"),
      }),
    )
    const readLarge = () =>
      cached(
        querySharedRecords(library, {
          skillPageId: skillPage,
          kind: "operation",
          entityId: "large-manifest",
          recordId: "large-manifest",
          payloadContainsBody: true,
        }),
      )
    const original = await f.run(readLarge())
    expect(original[0]?.payload).toEqual(large)
    expect(new TextDecoder().decode(f.objects.get(`objects/${digest(canonical)}`))).toBe(canonical)
    f.clearCalls()
    expect(await f.run(readLarge())).toEqual(original)
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 1,
      notion_body: 0,
      notion_write: 0,
      provider: 0,
    })
    expect(
      new URL(f.calls[0]!.path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
    ).not.toContain("payload")
    f.objects.set(`objects/${digest(canonical)}`, new TextEncoder().encode("corrupt logical bytes"))
    await expect(f.run(readLarge())).rejects.toMatchObject({ code: "STATE_CORRUPT" })
  })

  test("defaults remain full reads and cache hits still query metadata without Payload", async () => {
    const f = setup()
    await f.run(read())
    await f.run(read())
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("cache/shared-record-payloads/")),
    ).toEqual([])
    expect(f.requestMetrics().body_requests.retained_body).toBe(2)
    f.clearCalls()
    const original = await f.run(cached(read()))
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 1,
      notion_body: 1,
      notion_write: 0,
      provider: 0,
    })
    f.clearCalls()
    expect(await f.run(cached(read()))).toEqual(original)
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 1,
      notion_body: 0,
      notion_write: 0,
      provider: 0,
    })
    expect(
      new URL(f.calls[0]!.path, "https://api.notion.com/").searchParams.getAll("filter_properties"),
    ).not.toContain("payload")
  })

  test("full metadata pagination remains authoritative and does not become a per-page lookup", async () => {
    const f = setup(101)
    expect(await f.run(cached(read()))).toHaveLength(1)
    f.clearCalls()
    expect(await f.run(cached(read()))).toHaveLength(1)
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 2,
      notion_body: 0,
      notion_write: 0,
      provider: 0,
    })
    expect(
      f.calls.every((call) =>
        new URL(call.path, "https://api.notion.com/").pathname.endsWith("/query"),
      ),
    ).toBe(true)
  })

  test("an absent remote fact stays unresolved even after its envelope was cached", async () => {
    const f = setup()
    await f.run(cached(reconcile()))
    f.records.clear()
    f.clearCalls()
    const result = await f.run(cached(reconcile()).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected absent retained fact")
    expect(result.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 1,
      notion_body: 0,
      notion_write: 0,
      provider: 0,
    })
  })

  test("a changed page version forces full verification and rejects payload tampering", async () => {
    const f = setup()
    await f.run(cached(reconcile()))
    const row = [...f.records.values()][0]!
    row.last_edited_time = new Date(Date.parse(String(row.last_edited_time)) + 1).toISOString()
    property(row.properties).payload = rich(
      "payload",
      canonicalSharedJson({
        version: 1,
        operation_id: "retained-original",
        payload: { markdown: "changed bytes without an updated Hash" },
      }),
    )
    f.clearCalls()
    const result = await f.run(cached(reconcile()).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected tampered payload")
    expect(result.failure.code).toBe("INVALID_SHARED_RECORD")
    expect(f.requestMetrics().body_requests.retained_body).toBe(1)
    expect(f.writeCount()).toBe(0)
  })

  test("a conflicting duplicate cannot be hidden by a cached same-ID fact", async () => {
    const f = setup()
    await f.run(cached(reconcile()))
    f.seedFact(
      { markdown: "a competing retained payload" },
      "object",
      entity,
      entity,
      "retained-original",
    )
    f.clearCalls()
    const result = await f.run(cached(reconcile()).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected conflicting retained facts")
    expect(result.failure.code).toBe("SHARED_RECORD_CONFLICT")
    expect(f.requestMetrics().body_requests.retained_body).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("another auth scope cannot reuse a local verification receipt", async () => {
    const f = setup()
    await f.run(cached(read()))
    f.clearCalls()
    await f.run(cached(read(), digest("another-account-scope")))
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 1,
      notion_body: 1,
      notion_write: 0,
      provider: 0,
    })
  })

  test("a missing object is reacquired, while a corrupt object is never accepted or overwritten", async () => {
    const f = setup()
    const first = await f.run(cached(read()))
    const objectKey = `objects/${first[0]!.hash}`
    f.objects.delete(objectKey)
    f.clearCalls()
    await f.run(cached(read()))
    expect(f.requestMetrics().body_requests.retained_body).toBe(1)
    f.objects.set(objectKey, new TextEncoder().encode("corrupt retained envelope"))
    f.clearCalls()
    const result = await f.run(cached(read()).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected corrupt local envelope")
    expect(result.failure.code).toBe("STATE_CORRUPT")
    expect(f.requestMetrics().body_requests.retained_body).toBe(0)
    expect(new TextDecoder().decode(f.objects.get(objectKey))).toBe("corrupt retained envelope")
  })
})
