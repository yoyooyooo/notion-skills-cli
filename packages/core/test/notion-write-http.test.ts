import { expect, test } from "bun:test"
import type { IncomingMessage } from "node:http"
import { ByteSize, Effect, Fiber, FileSystem, Option, Stream } from "effect"
import { property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { NOTION_SINGLE_UPLOAD_LIMIT } from "../src/notion-http.ts"
import type { PortableSkill } from "../src/portable.ts"
import {
  createSharedNative,
  executeSharedCreate,
  prepareSharedCreate,
} from "../src/shared-create.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { fixtureToken, json, localServer, runtime } from "./notion-http-fixture.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode, id } from "./shared-snapshot-fixture.ts"

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function memoryUpload(read: () => Uint8Array, statSize?: number) {
  let opened = 0
  let closed = 0
  const fileSystem = FileSystem.makeNoop({
    stat: () =>
      Effect.sync(() => ({
        type: "File" as const,
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 1n,
        ino: Option.none(),
        mode: 0o600,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(statSize ?? read().byteLength),
        blksize: Option.none(),
        blocks: Option.none(),
      })),
    stream: () =>
      Stream.unwrap(
        Effect.sync(() => {
          opened++
          return Stream.make(read()).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                closed++
              }),
            ),
          )
        }),
      ),
  })
  return { fileSystem, counts: () => ({ opened, closed }) }
}

test("429 and 529 continue the frozen write after the server minimum, in one request identity", async () => {
  for (const status of [429, 529]) {
    const input = { markdown: "Original owned body" }
    const sent: Array<{ bytes: string; at: number }> = []
    await localServer(
      (request, response) => {
        void bodyOf(request).then((bytes) => {
          sent.push({ bytes: bytes.toString(), at: Date.now() })
          if (sent.length === 1) {
            input.markdown = "Changed caller input must not be replayed"
            json(
              response,
              status,
              {
                object: "error",
                code: status === 429 ? "rate_limited" : "service_overload",
                additional_data: { retry_after: "0.05", rate_limit_reason: "future_scope_limit" },
              },
              { "retry-after": "0.1", "x-request-id": "rejected-request" },
            )
          } else json(response, 200, { object: "page", id: id(90) })
        })
      },
      async (origin) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const api = yield* Notion
              expect(
                yield* api.request(`v1/pages/${id(90)}/markdown`, input, { method: "PATCH" }),
              ).toEqual({ object: "page", id: id(90) })
              expect(api.requestMetrics?.()).toMatchObject({
                total_requests: 2,
                requests: { notion_write: 2 },
                request_bytes: 2 * Buffer.byteLength(sent[0]!.bytes),
                unknown_request_bytes: 0,
                unknown_response_bytes: 0,
                in_flight: 0,
                outcomes: { success: 1, failure: 1 },
              })
              expect(
                api.requestMetrics?.().trace.filter((event) => event.event === "attempt"),
              ).toMatchObject([
                { http_status: status, request_id: "rejected-request" },
                { http_status: 200 },
              ])
              expect(api.requestMetrics?.().retry_wait_ms).toBeGreaterThanOrEqual(950)
            }),
          ).pipe(
            Effect.provide(runtime(origin, { config: { NTN_SKILLS_REQUEST_TRACE_LIMIT: "20" } })),
          ),
        )
      },
    )
    expect(sent).toHaveLength(2)
    expect(sent[1]!.bytes).toBe(sent[0]!.bytes)
    expect(sent[0]!.bytes).toBe('{"markdown":"Original owned body"}')
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(100)
  }
})

test("permanent rejections, blocked requests, contradictory receipts and unknown 5xx never replay writes", async () => {
  const cases = [
    { status: 400, code: "validation_error", expected: "NOTION_REQUEST_FAILED" },
    { status: 401, code: "unauthorized", expected: "AUTH_REQUIRED" },
    { status: 403, code: "restricted_resource", expected: "ACCESS_DENIED" },
    {
      status: 429,
      code: "rate_limited",
      expected: "RATE_LIMITED",
      additional: { rate_limit_reason: "public_api_request_blocked" },
    },
    {
      status: 529,
      code: "service_overload",
      expected: "RATE_LIMITED",
      additional: { rate_limit_reason: "public_api_request_blocked" },
    },
    { status: 429, code: "service_overload", expected: "WRITE_OUTCOME_UNKNOWN" },
    { status: 529, code: "rate_limited", expected: "WRITE_OUTCOME_UNKNOWN" },
    {
      status: 429,
      code: "rate_limited",
      expected: "WRITE_OUTCOME_UNKNOWN",
      additional: { committed_resource_id: id(91) },
    },
    {
      status: 529,
      code: "service_overload",
      expected: "WRITE_OUTCOME_UNKNOWN",
      additional: { retry_guidance: ["Do not repeat the write."] },
    },
    { status: 500, code: "internal_server_error", expected: "WRITE_OUTCOME_UNKNOWN" },
    { status: 502, code: "bad_gateway", expected: "WRITE_OUTCOME_UNKNOWN" },
    {
      status: 503,
      code: "service_unavailable",
      expected: "WRITE_OUTCOME_UNKNOWN",
      additional: { committed_resource_id: id(91), committed_child_ids: [id(92)] },
    },
    { status: 504, code: "gateway_timeout", expected: "WRITE_OUTCOME_UNKNOWN" },
  ]
  for (const item of cases) {
    let attempts = 0
    await localServer(
      (request, response) => {
        request.resume()
        attempts++
        json(response, item.status, {
          object: "error",
          code: item.code,
          message: fixtureToken,
          additional_data: { retry_after: "0", ...item.additional },
        })
      },
      async (origin) => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(Notion, (api) =>
              api.request("v1/pages", { parent: { page_id: id(90) } }).pipe(Effect.result),
            ),
          ).pipe(Effect.provide(runtime(origin))),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag !== "Failure") throw new Error("Expected bounded write failure")
        expect(result.failure.code).toBe(item.expected)
        expect(JSON.stringify(result)).not.toContain(fixtureToken)
        if (item.expected === "WRITE_OUTCOME_UNKNOWN")
          expect(result.failure.details).toMatchObject({ phase: "outcome_unknown" })
      },
    )
    expect(attempts).toBe(1)
  }
})

test("a safe read-only POST recovers a 503 and remains metadata in actual-attempt metrics", async () => {
  let attempts = 0
  await localServer(
    (request, response) => {
      request.resume()
      attempts++
      if (attempts === 1) json(response, 503, { object: "error", code: "service_unavailable" })
      else json(response, 200, { object: "list", results: [], has_more: false })
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            yield* api.request(`v1/data_sources/${id(90)}/query`, { page_size: 100 })
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 2,
              requests: { notion_metadata: 2, notion_write: 0 },
              outcomes: { failure: 1, success: 1 },
            })
          }),
        ).pipe(Effect.provide(runtime(origin))),
      )
    },
  )
  expect(attempts).toBe(2)
})

test("deferred and interrupted retry waits count only time actually slept", async () => {
  for (const cancel of [false, true]) {
    let attempts = 0
    let rejected!: () => void
    const rejection = new Promise<void>((resolve) => {
      rejected = resolve
    })
    await localServer(
      (request, response) => {
        request.resume()
        attempts++
        json(response, 429, {
          object: "error",
          code: "rate_limited",
          additional_data: { retry_after: "30" },
        })
        rejected()
      },
      async (origin) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const api = yield* Notion
              if (cancel) {
                const running = yield* Effect.forkChild(api.request("v1/pages", {}), {
                  startImmediately: true,
                })
                yield* Effect.promise(() => rejection)
                yield* Effect.sleep(100)
                yield* Fiber.interrupt(running)
                expect(api.requestMetrics?.().retry_wait_ms).toBeGreaterThan(0)
                expect(api.requestMetrics?.().retry_wait_ms).toBeLessThan(5000)
              } else {
                const result = yield* api
                  .request("v1/pages", {}, { queueBudgetMs: 100 })
                  .pipe(Effect.result)
                expect(result._tag === "Failure" && property(result.failure.details).reason).toBe(
                  "admission_wait_exhausted",
                )
                expect(api.requestMetrics?.().retry_wait_ms).toBe(0)
              }
              expect(api.requestMetrics?.()).toMatchObject({ total_requests: 1, in_flight: 0 })
            }),
          ).pipe(Effect.provide(runtime(origin))),
        )
      },
    )
    expect(attempts).toBe(1)
  }
})

test("multipart retry reuses the complete encoded payload and closes its bounded file stream once", async () => {
  let contents = encode("Owned attachment\r\nBinary \u0000 bytes\n")
  const original = contents.slice()
  const fixture = memoryUpload(() => contents)
  const requests: Array<{ bytes: Buffer; contentType: string; length: number }> = []
  await localServer(
    (request, response) => {
      void bodyOf(request).then((bytes) => {
        requests.push({
          bytes,
          contentType: String(request.headers["content-type"]),
          length: Number(request.headers["content-length"]),
        })
        if (requests.length === 1) {
          contents = encode("Changed local content cannot replace an in-flight original upload")
          json(response, 429, {
            object: "error",
            code: "rate_limited",
            additional_data: { retry_after: "0" },
          })
        } else json(response, 200, { object: "file_upload", id: id(94), status: "uploaded" })
      })
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            yield* api.request(`v1/file_uploads/${id(94)}/send`, undefined, {
              method: "POST",
              file: '/owned/附件 "fixture".bin',
            })
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 2,
              requests: { notion_write: 2 },
              request_bytes: 2 * requests[0]!.bytes.byteLength,
              unknown_request_bytes: 0,
            })
          }),
        ).pipe(Effect.provide(runtime(origin, { fileSystem: fixture.fileSystem }))),
      )
    },
  )
  expect(requests).toHaveLength(2)
  expect(requests[1]!.bytes).toEqual(requests[0]!.bytes)
  expect(requests[1]!.contentType).toBe(requests[0]!.contentType)
  expect(requests[0]!.length).toBe(requests[0]!.bytes.byteLength)
  expect(requests[0]!.bytes.byteLength).toBeGreaterThan(original.byteLength)
  const form = await new Response(Uint8Array.from(requests[0]!.bytes), {
    headers: { "content-type": requests[0]!.contentType },
  }).formData()
  const file = form.get("file")
  expect(file).toBeInstanceOf(File)
  if (!(file instanceof File)) throw new Error("Missing original file part")
  expect(file.name).toBe("附件 %22fixture%22.bin")
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(original)
  expect(fixture.counts()).toEqual({ opened: 1, closed: 1 })
})

test("multipart bounds reject an oversized or growing file before any HTTP attempt", async () => {
  for (const growing of [false, true]) {
    const bytes = new Uint8Array(NOTION_SINGLE_UPLOAD_LIMIT + 1)
    const fixture = memoryUpload(() => bytes, growing ? 1 : bytes.byteLength)
    let attempts = 0
    await localServer(
      (request, response) => {
        request.resume()
        attempts++
        json(response, 200, {})
      },
      async (origin) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const api = yield* Notion
              const result = yield* api
                .request(`v1/file_uploads/${id(94)}/send`, undefined, {
                  method: "POST",
                  file: "/owned/oversized.bin",
                })
                .pipe(Effect.result)
              expect(result._tag === "Failure" && result.failure.code).toBe("FILE_TOO_LARGE")
              expect(api.requestMetrics?.().total_requests).toBe(0)
            }),
          ).pipe(Effect.provide(runtime(origin, { fileSystem: fixture.fileSystem }))),
        )
      },
    )
    expect(attempts).toBe(0)
    expect(fixture.counts()).toEqual({ opened: growing ? 1 : 0, closed: growing ? 1 : 0 })
  }
})

test("cancelled multipart closes the real HTTP attempt and never marks an upload complete", async () => {
  const fixture = memoryUpload(() => new Uint8Array(1024 * 1024))
  let attempts = 0
  let started!: () => void
  let closed!: () => void
  const start = new Promise<void>((resolve) => {
    started = resolve
  })
  const close = new Promise<void>((resolve) => {
    closed = resolve
  })
  await localServer(
    (request, response) => {
      attempts++
      request.resume()
      response.on("close", closed)
      started()
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            const running = yield* Effect.forkChild(
              api.request(`v1/file_uploads/${id(94)}/send`, undefined, {
                method: "POST",
                file: "/owned/slow.bin",
              }),
              { startImmediately: true },
            )
            yield* Effect.promise(() => start)
            yield* Fiber.interrupt(running)
            yield* Effect.promise(() => close).pipe(Effect.timeout(2000))
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 1,
              in_flight: 0,
              outcomes: { cancelled: 1, success: 0 },
            })
          }),
        ).pipe(Effect.provide(runtime(origin, { fileSystem: fixture.fileSystem }))),
      )
    },
  )
  expect(attempts).toBe(1)
  expect(fixture.counts()).toEqual({ opened: 1, closed: 1 })
})

test("accepted writes with a dropped HTTP response reconcile the original native-create journal without creating again", async () => {
  for (const lostStage of ["skill", "outcome"] as const) {
    const fixture = sharedCreateFixture()
    const backend = await fixture.run(Notion)
    const portable: PortableSkill = {
      kind: "skill",
      name: `HTTP unknown ${lostStage}`,
      description: "Owned wire recovery fixture",
      main: "SKILL.md",
      files: [
        { path: "SKILL.md", bytes: encode("# Frozen original\n\nOwned HTTP recovery marker.\n") },
      ],
    }
    let dropped = false
    await localServer(
      (request, response) => {
        void bodyOf(request)
          .then(async (bytes) => {
            const path = (request.url ?? "/").slice(1)
            const method = request.method
            if (method !== "GET" && method !== "POST" && method !== "PATCH")
              throw new Error("Unexpected fixture method")
            if (path === "v1/users/me") {
              json(response, 200, { object: "user", id: id(95) })
              return
            }
            const body: unknown = bytes.length ? JSON.parse(bytes.toString()) : undefined
            const parent = property(property(body).parent).data_source_id
            const recordText = text(
              property(
                property(property(body).properties)[createLibrary.records.property_ids.Payload!],
              ).rich_text,
            )
            const payload = recordText ? property(property(JSON.parse(recordText)).payload) : {}
            const native =
              method === "POST" &&
              path === "v1/pages" &&
              parent === createLibrary.skills.data_source_id
            const applied = payload.kind === "skill_create_outcome" && payload.status === "applied"
            const result = await Effect.runPromise(
              backend.request(path, body, { method }).pipe(Effect.result),
            )
            if (result._tag === "Failure") throw new Error(`${result.failure.code}: ${path}`)
            if (!dropped && (lostStage === "skill" ? native : applied)) {
              dropped = true
              response.destroy()
            } else json(response, 200, result.success)
          })
          .catch((error) =>
            json(response, 500, {
              object: "error",
              code: "internal_server_error",
              message: String(error),
            }),
          )
      },
      async (origin) => {
        const transport = () => runtime(origin, { intervalMs: 1 })
        const plan = await fixture.run(
          prepareSharedCreate(createLibrary, { portable }).pipe(Effect.provide(transport())),
        )
        const frozen = canonicalSharedJson(plan)
        const first = await fixture.run(
          executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(
            Effect.result,
            Effect.provide(transport()),
          ),
        )
        expect(first._tag === "Failure" && first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
        expect(dropped).toBe(true)
        expect(fixture.pending()).toHaveLength(1)
        expect(
          canonicalSharedJson(property(fixture.base.json.get(fixture.pending()[0]!)).plan),
        ).toBe(frozen)
        const creates = fixture.nativeCreates().length
        const records = fixture.base.records.size
        const second = await fixture.run(
          executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(
            Effect.result,
            Effect.provide(transport()),
          ),
        )
        expect(fixture.nativeCreates()).toHaveLength(creates)
        expect(fixture.base.records.size).toBe(records)
        if (lostStage === "skill") {
          expect(second._tag === "Failure" && second.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
          const next = await fixture.run(
            createSharedNative(createLibrary, { portable }).pipe(
              Effect.result,
              Effect.provide(transport()),
            ),
          )
          expect(next._tag === "Failure" && next.failure.code).toBe("SHARED_RECORD_UNRESOLVED")
          if (next._tag === "Failure")
            expect(next.failure.details).toMatchObject({
              native_create_operation_id: plan.operation_id,
            })
          expect(fixture.pending()).toHaveLength(1)
          expect(fixture.nativeCreates()).toHaveLength(1)
          expect(
            canonicalSharedJson(property(fixture.base.json.get(fixture.pending()[0]!)).plan),
          ).toBe(frozen)
        } else {
          expect(second._tag).toBe("Success")
          if (second._tag !== "Success") throw new Error("Original saved outcome did not reconcile")
          expect(second.success.status).toBe("created")
          expect(second.success.reused).toBe(true)
          expect(second.success.operation_id).toBe(plan.operation_id)
          expect(fixture.pending()).toHaveLength(0)
          expect(
            [...fixture.retired.values()].map((value) => canonicalSharedJson(property(value).plan)),
          ).toContain(frozen)
        }
      },
    )
  }
}, 60_000)
