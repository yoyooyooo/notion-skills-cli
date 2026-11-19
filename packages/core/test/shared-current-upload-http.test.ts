import { expect, test } from "bun:test"
import type { IncomingMessage } from "node:http"
import { ByteSize, Effect, FileSystem, Option, Stream } from "effect"
import { Notion } from "../src/notion.ts"
import { NOTION_SINGLE_UPLOAD_LIMIT } from "../src/notion-http.ts"
import { json, localServer, runtime } from "./notion-http-fixture.ts"

const uploadId = "00000000-0000-4000-8000-000000000044"
async function bodyOf(request: IncomingMessage) {
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  return Buffer.concat(parts)
}
function memoryFile(read: () => Uint8Array) {
  let opened = 0,
    closed = 0
  return {
    counts: () => ({ opened, closed }),
    fileSystem: FileSystem.makeNoop({
      stat: () =>
        Effect.succeed({
          type: "File",
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
          size: ByteSize.bytes(read().byteLength),
          blksize: Option.none(),
          blocks: Option.none(),
        }),
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
    }),
  }
}

test("real multipart transport freezes part_number and exact bytes across an allowed retry", async () => {
  let bytes = new TextEncoder().encode("original part\u0000\r\n")
  const expected = bytes.slice(),
    file = memoryFile(() => bytes)
  const options = { method: "POST" as const, file: "/owned/current.txt", partNumber: 2 }
  const received: Array<{ body: Buffer; type: string }> = []
  await localServer(
    (request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ body, type: String(request.headers["content-type"]) })
        if (received.length === 1) {
          bytes = new TextEncoder().encode("different local bytes")
          options.partNumber = 3
          json(response, 429, {
            object: "error",
            code: "rate_limited",
            additional_data: { retry_after: "0" },
          })
        } else json(response, 200, { object: "file_upload", id: uploadId, status: "pending" })
      })
    },
    async (origin) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const api = yield* Notion
            yield* api.request(`v1/file_uploads/${uploadId}/send`, undefined, options)
            expect(api.requestMetrics?.()).toMatchObject({
              total_requests: 2,
              requests: { notion_write: 2 },
              request_bytes: received[0]!.body.byteLength * 2,
              unknown_request_bytes: 0,
              in_flight: 0,
            })
          }),
        ).pipe(Effect.provide(runtime(origin, { fileSystem: file.fileSystem, intervalMs: 0 }))),
      )
    },
  )
  expect(received).toHaveLength(2)
  expect(received[1]).toEqual(received[0])
  const form = await new Response(Uint8Array.from(received[0]!.body), {
    headers: { "content-type": received[0]!.type },
  }).formData()
  expect(form.get("part_number")).toBe("2")
  const part = form.get("file")
  expect(part).toBeInstanceOf(File)
  if (!(part instanceof File)) throw new Error("Missing file part")
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(expected)
  expect(file.counts()).toEqual({ opened: 1, closed: 1 })
})

test("real multipart transport permits exactly 20 MiB and rejects a larger part before HTTP", async () => {
  for (const size of [NOTION_SINGLE_UPLOAD_LIMIT, NOTION_SINGLE_UPLOAD_LIMIT + 1]) {
    const file = memoryFile(() => new Uint8Array(size))
    let attempts = 0,
      receivedSize = 0
    await localServer(
      (request, response) => {
        void bodyOf(request).then(async (body) => {
          attempts++
          const form = await new Response(Uint8Array.from(body), {
            headers: { "content-type": String(request.headers["content-type"]) },
          }).formData()
          const part = form.get("file")
          if (!(part instanceof File)) throw new Error("Missing file part")
          receivedSize = part.size
          expect(form.get("part_number")).toBe("1")
          json(response, 200, { object: "file_upload", id: uploadId, status: "pending" })
        })
      },
      async (origin) => {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const api = yield* Notion
              return yield* api
                .request(`v1/file_uploads/${uploadId}/send`, undefined, {
                  method: "POST",
                  file: "/owned/current.txt",
                  partNumber: 1,
                })
                .pipe(Effect.result)
            }),
          ).pipe(Effect.provide(runtime(origin, { fileSystem: file.fileSystem, intervalMs: 0 }))),
        )
        expect(result._tag).toBe(size === NOTION_SINGLE_UPLOAD_LIMIT ? "Success" : "Failure")
        if (result._tag === "Failure") expect(result.failure.code).toBe("FILE_TOO_LARGE")
      },
    )
    expect(attempts).toBe(size === NOTION_SINGLE_UPLOAD_LIMIT ? 1 : 0)
    expect(receivedSize).toBe(size === NOTION_SINGLE_UPLOAD_LIMIT ? size : 0)
    expect(file.counts()).toEqual(
      size === NOTION_SINGLE_UPLOAD_LIMIT ? { opened: 1, closed: 1 } : { opened: 0, closed: 0 },
    )
  }
})
