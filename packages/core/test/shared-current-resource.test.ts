import { describe, expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { makeRequestBudget, RequestBudget } from "../src/request-budget.ts"
import { requestBudgetHttpClient } from "../src/request-budget-http.ts"
import {
  CURRENT_RESOURCE_INLINE_BYTES,
  CURRENT_RESOURCE_MAX_BYTES,
  loadCurrentSharedResourceContent,
  prepareCurrentSharedResource,
  storeCurrentSharedResource,
  validateCurrentSharedResourceManifest,
} from "../src/shared-current-resource.ts"
import { querySharedRecords } from "../src/shared-records.ts"
import {
  digest,
  id,
  library as oldLibrary,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const library = {
  ...oldLibrary,
  records: {
    ...oldLibrary.records,
    property_ids: { ...oldLibrary.records.property_ids, Resource: "resource" },
  },
}
const url =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/current/font.otf?signature=fixture"
const attachment = (value = url, expires = new Date(Date.now() + 60_000).toISOString()) => ({
  name: "font.otf",
  type: "file",
  file: { url: value, expiry_time: expires },
})

function fixture(
  download: (url: string, attempt: number) => Response = () => new Response(null, { status: 404 }),
) {
  const downloads: string[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      downloads.push(request.url)
      return HttpClientResponse.fromWeb(request, download(request.url, downloads.length))
    }),
  )
  const base = sharedSnapshotFixture({ httpClient: http })
  let unknown: "accepted" | "absent" | undefined
  let rewriteQuery: ((rows: unknown) => unknown) | undefined
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | HttpClient.HttpClient>) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const request: Notion["Service"]["request"] = (path, body, options) =>
          Effect.gen(function* () {
            const value = property(body),
              properties = property(value.properties)
            if (
              path === "v1/pages" &&
              options?.method === "POST" &&
              property(property(properties.kind).select).name === "resource"
            ) {
              const chosen = unknown
              unknown = undefined
              if (chosen === "absent") {
                base.calls.push({ path, body, method: "POST" })
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "The resource create response was lost."),
                )
              }
              const { resource: _resource, ...withoutFile } = properties
              const raw = property(
                yield* api.request(path, { ...value, properties: withoutFile }, options),
              )
              const files = property(properties.resource).files
              const native = Array.isArray(files) ? files.map(() => attachment()) : []
              const row = {
                ...raw,
                properties: {
                  ...property(raw.properties),
                  resource: { id: "resource", type: "files", files: native },
                },
              }
              base.records.set(String(raw.id), row)
              if (chosen === "accepted")
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "The accepted resource response was lost."),
                )
              return row
            }
            const result = yield* api.request(path, body, options)
            return path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`) &&
              rewriteQuery !== undefined
              ? rewriteQuery(result)
              : result
          })
        return yield* effect.pipe(Effect.provideService(Notion, { ...api, request }))
      }),
    )
  const seed = async (bytes: Uint8Array, mode: "100644" | "100755" = "100644") => {
    const prepared = await run(prepareCurrentSharedResource(bytes, mode))
    base.seedFact(
      prepared.manifest,
      "resource",
      prepared.content.object_id,
      prepared.content.object_id,
      `store-${prepared.content.object_id}`,
    )
    const row = [...base.records.values()].at(-1)
    if (row === undefined) throw new Error("Expected resource row")
    property(row.properties).resource = {
      id: "resource",
      type: "files",
      files: prepared.status === "inline" ? [] : [attachment()],
    }
    return { prepared, row }
  }
  return {
    ...base,
    run,
    seed,
    downloads,
    http,
    unknownCreate: (value: "accepted" | "absent") => {
      unknown = value
    },
    rewriteQuery: (value: (rows: unknown) => unknown) => {
      rewriteQuery = value
    },
  }
}

describe("current exact resources", () => {
  test("one inline Record preserves bytes and mode; ordinary reads and unchanged storage write nothing", async () => {
    const f = fixture()
    const bytes = new Uint8Array([239, 187, 191, 35, 13, 10, 0, 255])
    const prepared = await f.run(prepareCurrentSharedResource(bytes, "100755"))
    expect(prepared.status).toBe("inline")
    await f.run(
      storeCurrentSharedResource(library, { skillPageId: skillPage, prepared, mode: "create" }),
    )
    expect(f.records.size).toBe(1)
    expect(f.writeCount()).toBe(1)
    f.clearCalls()
    const result = await f.run(
      loadCurrentSharedResourceContent(library, {
        skillPageId: skillPage,
        content: prepared.content,
      }),
    )
    expect(result.bytes).toEqual(bytes)
    expect(result.content.mode).toBe("100755")
    expect(f.calls).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
    expect(f.downloads).toHaveLength(0)
    expect(f.readBodyCount()).toBe(0)
    await f.run(
      storeCurrentSharedResource(library, { skillPageId: skillPage, prepared, mode: "create" }),
    )
    expect(f.records.size).toBe(1)
    expect(f.writeCount()).toBe(0)
    const regular = await f.run(prepareCurrentSharedResource(bytes, "100644"))
    expect(regular.content.object_id).not.toBe(prepared.content.object_id)
  })

  test("a 19 MiB resource has one current attachment, no chunks, and one exact download", async () => {
    const bytes = new Uint8Array(19 * 1024 * 1024).fill(137)
    bytes[bytes.length - 1] = 255
    const f = fixture(() => new Response(bytes))
    const { prepared } = await f.seed(bytes)
    expect(prepared.status).toBe("needs_attachment")
    expect(prepared.manifest.storage).toEqual({ kind: "attachment" })
    expect(JSON.stringify(prepared.manifest).length).toBeLessThan(250)
    expect(f.calls).toHaveLength(0)
    const result = await f.run(
      loadCurrentSharedResourceContent(library, {
        skillPageId: skillPage,
        content: prepared.content,
      }),
    )
    expect(result.bytes.byteLength).toBe(bytes.byteLength)
    expect(digest(result.bytes)).toBe(digest(bytes))
    expect(f.records.size).toBe(1)
    expect(f.calls).toHaveLength(1)
    expect(f.downloads).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
    f.records.clear()
    await expect(
      f.run(
        storeCurrentSharedResource(library, { skillPageId: skillPage, prepared, mode: "create" }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_UPLOAD_REQUIRED" })
  })

  test("empty resources are exact; malformed and old manifests fail before remote I/O", async () => {
    const f = fixture()
    const empty = await f.run(prepareCurrentSharedResource(new Uint8Array(), "100644"))
    expect(empty.manifest.storage).toEqual({ kind: "inline", encoding: "base64", data: "" })
    const invalid: Array<[unknown, unknown]> = [
      [empty.content, { ...empty.manifest, kind: "retained_resource", chunks: [] }],
      [
        empty.content,
        { ...empty.manifest, storage: { kind: "inline", encoding: "base64", data: "Zh==" } },
      ],
      [{ ...empty.content, mode: null }, empty.manifest],
      [{ ...empty.content, bytes: CURRENT_RESOURCE_MAX_BYTES + 1 }, empty.manifest],
      [{ ...empty.content, object_id: `resource-${"0".repeat(64)}` }, empty.manifest],
      [empty.content, { ...empty.manifest, predecessor: "old" }],
    ]
    for (const [content, manifest] of invalid)
      expect(
        (await f.run(validateCurrentSharedResourceManifest(content, manifest).pipe(Effect.result)))
          ._tag,
      ).toBe("Failure")
    expect(f.calls).toHaveLength(0)
    await expect(
      f.run(prepareCurrentSharedResource(new Uint8Array(CURRENT_RESOURCE_MAX_BYTES + 1), "100644")),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_TOO_LARGE" })
  })

  test("old object records are not current resources and local bytes do not replace missing current data", async () => {
    const f = fixture()
    const { prepared, row } = await f.seed(new Uint8Array([1, 2, 3]))
    property(property(row.properties).kind).select = { name: "object" }
    f.objects.set(`objects/${prepared.content.sha256}`, new Uint8Array([1, 2, 3]))
    await expect(
      f.run(
        loadCurrentSharedResourceContent(library, {
          skillPageId: skillPage,
          content: prepared.content,
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_UNAVAILABLE" })
    expect(f.writeCount()).toBe(0)
    await expect(
      f.run(querySharedRecords(library, { skillPageId: skillPage, kind: "resource" })),
    ).rejects.toMatchObject({ code: "INVALID_SHARED_RECORD" })
  })

  test("identical duplicate physical resource rows are conflicts, not silently deduplicated", async () => {
    const f = fixture()
    const { prepared, row } = await f.seed(new Uint8Array([9]))
    f.records.set(id(9999), { ...structuredClone(row), id: id(9999) })
    await expect(
      f.run(
        loadCurrentSharedResourceContent(library, {
          skillPageId: skillPage,
          content: prepared.content,
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_DUPLICATE" })
    expect(f.downloads).toHaveLength(0)
  })

  test("unknown creates perform stable-ID read-only reconciliation without a second POST", async () => {
    for (const outcome of ["accepted", "absent"] as const) {
      const f = fixture()
      const prepared = await f.run(prepareCurrentSharedResource(new Uint8Array([7]), "100644"))
      f.unknownCreate(outcome)
      await expect(
        f.run(
          storeCurrentSharedResource(library, { skillPageId: skillPage, prepared, mode: "create" }),
        ),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      expect(f.writeCount()).toBe(1)
      f.clearCalls()
      const result = await f.run(
        storeCurrentSharedResource(library, {
          skillPageId: skillPage,
          prepared,
          mode: "reconcile",
        }).pipe(Effect.result),
      )
      expect(result._tag).toBe(outcome === "accepted" ? "Success" : "Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
      expect(f.writeCount()).toBe(0)
    }
  })

  test("attachment writes use the caller's uploaded handle and verify original bytes without allocating", async () => {
    const bytes = new Uint8Array(CURRENT_RESOURCE_INLINE_BYTES + 1).fill(29)
    const f = fixture(() => new Response(bytes))
    const prepared = await f.run(prepareCurrentSharedResource(bytes, "100755"))
    const result = await f.run(
      storeCurrentSharedResource(library, {
        skillPageId: skillPage,
        prepared,
        mode: "create",
        upload: { id: id(800), name: "font.otf" },
      }),
    )
    expect(result.bytes).toEqual(bytes)
    expect(f.writeCount()).toBe(1)
    expect(f.calls.some((call) => call.path.startsWith("v1/file_uploads"))).toBe(false)
    expect(f.records.size).toBe(1)
    expect(f.downloads).toHaveLength(1)
  })

  test("only one signed-URL refresh is allowed and no fallback resolves another Record", async () => {
    const bytes = new Uint8Array(CURRENT_RESOURCE_INLINE_BYTES + 1).fill(3)
    const f = fixture((_url, attempt) =>
      attempt === 1 ? new Response(null, { status: 403 }) : new Response(bytes),
    )
    const { prepared } = await f.seed(bytes)
    const result = await f.run(
      loadCurrentSharedResourceContent(library, {
        skillPageId: skillPage,
        content: prepared.content,
      }),
    )
    expect(result.bytes).toEqual(bytes)
    expect(f.calls).toHaveLength(2)
    expect(f.downloads).toHaveLength(2)
    const unavailable = fixture(() => new Response(null, { status: 403 }))
    const second = await unavailable.seed(bytes)
    await expect(
      unavailable.run(
        loadCurrentSharedResourceContent(library, {
          skillPageId: skillPage,
          content: second.prepared.content,
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_RESOURCE_DOWNLOAD_FAILED" })
    expect(unavailable.downloads).toHaveLength(2)
    expect(unavailable.calls).toHaveLength(2)
    expect(unavailable.writeCount()).toBe(0)
  })

  test("unsafe URLs, incomplete Records, missing attachments and byte mismatches cannot produce content", async () => {
    const bytes = new Uint8Array(CURRENT_RESOURCE_INLINE_BYTES + 1)
    for (const unsafe of [
      "https://example.com/file",
      "http://secure.notion-static.com/file",
      "https://secure.notion-static.com@evil.test/file",
      "https://127.0.0.1/file",
    ]) {
      const f = fixture()
      const { prepared, row } = await f.seed(bytes)
      property(property(row.properties).resource).files = [attachment(unsafe)]
      await expect(
        f.run(
          loadCurrentSharedResourceContent(library, {
            skillPageId: skillPage,
            content: prepared.content,
          }),
        ),
      ).rejects.toMatchObject({ code: "SHARED_RESOURCE_URL_REFUSED" })
      expect(f.downloads).toHaveLength(0)
    }
    const incomplete = fixture()
    const seeded = await incomplete.seed(bytes)
    incomplete.rewriteQuery((raw) => ({ ...property(raw), request_status: { type: "incomplete" } }))
    await expect(
      incomplete.run(
        loadCurrentSharedResourceContent(library, {
          skillPageId: skillPage,
          content: seeded.prepared.content,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SHARED_RECORD" })
    expect(incomplete.downloads).toHaveLength(0)
    for (const files of [[], [attachment(), attachment()]]) {
      const f = fixture()
      const { prepared, row } = await f.seed(bytes)
      property(property(row.properties).resource).files = files
      await expect(
        f.run(
          loadCurrentSharedResourceContent(library, {
            skillPageId: skillPage,
            content: prepared.content,
          }),
        ),
      ).rejects.toMatchObject({ code: "SHARED_RESOURCE_INVALID" })
      expect(f.downloads).toHaveLength(0)
    }
    for (const wrong of [new Uint8Array(bytes.length - 1), new Uint8Array(bytes.length).fill(1)]) {
      const f = fixture(() => new Response(wrong))
      const { prepared } = await f.seed(bytes)
      await expect(
        f.run(
          loadCurrentSharedResourceContent(library, {
            skillPageId: skillPage,
            content: prepared.content,
          }),
        ),
      ).rejects.toMatchObject({ code: "SHARED_RESOURCE_INVALID" })
      expect(f.downloads).toHaveLength(1)
    }
  })

  test("provider budget exhaustion survives the transport wrapper and stops URL retry", async () => {
    const bytes = new Uint8Array(CURRENT_RESOURCE_INLINE_BYTES + 1)
    const f = fixture(() => new Response("expired", { status: 403 }))
    const { prepared } = await f.seed(bytes)
    const result = await f.run(
      Effect.gen(function* () {
        const budget = yield* makeRequestBudget("current-resource-fixture", {
          requests: 1,
          bytes: 1024 * 1024,
          duration_ms: 10_000,
        })
        const result = yield* loadCurrentSharedResourceContent(library, {
          skillPageId: skillPage,
          content: prepared.content,
        }).pipe(
          Effect.provideService(RequestBudget, budget),
          Effect.provideService(HttpClient.HttpClient, requestBudgetHttpClient(f.http, budget)),
          Effect.result,
        )
        return { result, usage: yield* budget.snapshot }
      }),
    )
    expect(result.result._tag).toBe("Failure")
    if (result.result._tag === "Failure")
      expect(result.result.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
    expect(result.usage.attempts).toBe(1)
    expect(f.downloads).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
  })
})
