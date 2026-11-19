import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { CurrentOperationSession } from "../src/shared-current-operation.ts"
import {
  prepareCurrentSharedResource,
  type PreparedCurrentSharedResource,
} from "../src/shared-current-resource.ts"
import {
  currentUploadFileSpec,
  currentUploadActionPrefix,
  makeCurrentUploadScope,
  uploadCurrentSharedResource,
} from "../src/shared-current-upload.ts"
import {
  currentDigest as digest,
  currentBytes as encode,
  currentId as id,
  currentSnapshotFixture,
  currentSkillPage as skillPage,
} from "./shared-current-fixture.ts"

const MiB = 1024 * 1024
type Failure = { stage: string; outcome: "accepted" | "absent" | "partial" }
function fixture() {
  const base = currentSnapshotFixture()
  const uploads = new Map<string, Record<string, unknown>>()
  const sent = new Map<string, Uint8Array[]>()
  const calls: Array<{
    path: string
    method: string
    body: unknown
    part?: number
    file?: string
  }> = []
  const actions: Array<{ key: string; hash: string; replay: string }> = []
  let pending: { key: string; hash: string } | undefined
  let failure: Failure | undefined
  let incomplete = false
  let nextId = 100
  const service: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        const method = options?.method ?? "GET"
        calls.push({
          path,
          body,
          method,
          ...(options?.partNumber === undefined ? {} : { part: options.partNumber }),
          ...(options?.file === undefined ? {} : { file: options.file }),
        })
        if (path.startsWith("v1/file_uploads?")) {
          const offset = Number(
            new URL(path, "https://notion.test/").searchParams.get("start_cursor") ?? 0,
          )
          const all = [...uploads.values()],
            results = all.slice(offset, offset + 100)
          const has_more = offset + results.length < all.length
          return Effect.succeed({
            object: "list",
            results,
            has_more,
            next_cursor: has_more ? String(offset + results.length) : null,
            ...(incomplete ? { request_status: { type: "incomplete" } } : {}),
          })
        }
        const match = /^v1\/file_uploads\/([^/]+)(?:\/(send|complete))?$/u.exec(path)
        const stage =
          path === "v1/file_uploads"
            ? "allocate"
            : match?.[2] === "send"
              ? "send:" + (options?.partNumber ?? 1)
              : match?.[2]
        const selected = failure?.stage === stage ? failure : undefined
        if (selected) failure = undefined
        if (selected?.outcome === "absent")
          return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Request has no observed effect."))
        if (path === "v1/file_uploads" && method === "POST") {
          const value = property(body),
            uploadId = id(nextId++)
          const row = {
            object: "file_upload",
            id: uploadId,
            filename: value.filename,
            content_type: value.content_type,
            status: "pending",
            expiry_time: "2030-01-01T00:00:00.000Z",
            in_trash: false,
            content_length: null,
            ...(value.mode === "multi_part"
              ? { number_of_parts: { total: value.number_of_parts, sent: 0 } }
              : {}),
          }
          uploads.set(uploadId, row)
          if (selected)
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Allocation response was lost."))
          return Effect.succeed(row)
        }
        if (!match) return Effect.fail(fail("TEST_UNEXPECTED", path))
        const row = uploads.get(match[1]!)
        if (!row) return Effect.fail(fail("NOT_FOUND", "Missing upload."))
        if (!match[2] && method === "GET") return Effect.succeed(row)
        if (match[2] === "send" && method === "POST") {
          if (options?.file === undefined)
            return Effect.fail(fail("TEST_INVALID", "Missing temporary part."))
          const bytes = new Uint8Array(readFileSync(options.file))
          expect(bytes.byteLength).toBeLessThanOrEqual(20 * MiB)
          const chunks = sent.get(String(row.id)) ?? []
          expect(options.partNumber ?? 1).toBe(chunks.length + 1)
          chunks.push(bytes)
          sent.set(String(row.id), chunks)
          const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          const updated = {
            ...row,
            content_length: length - (selected?.outcome === "partial" ? 1 : 0),
            ...(row.number_of_parts === undefined
              ? { status: "uploaded" }
              : { number_of_parts: { ...property(row.number_of_parts), sent: chunks.length } }),
          }
          uploads.set(String(row.id), updated)
          if (selected) return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Part response was lost."))
          return Effect.succeed(updated)
        }
        if (match[2] === "complete" && method === "POST") {
          const updated = { ...row, status: "uploaded" }
          uploads.set(String(row.id), updated)
          if (selected)
            return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Completion response was lost."))
          return Effect.succeed(updated)
        }
        return Effect.fail(fail("TEST_UNEXPECTED", path))
      }),
  }
  const dispatch: CurrentOperationSession["dispatch"] = (action) =>
    Effect.gen(function* () {
      const hash = digest(
        JSON.stringify({
          path: action.request.path,
          body: action.request.body ?? null,
          file: action.fileSha256 ?? null,
          part: action.request.options?.partNumber ?? null,
        }),
      )
      if (pending?.key === action.key && pending.hash !== hash)
        return yield* Effect.fail(fail("CURRENT_OPERATION_CONFLICT", "The pending input changed."))
      const result = yield* action.observe({ fresh: pending?.key === action.key })
      if (result.status === "complete") {
        if (pending?.key === action.key) pending = undefined
        return result.value
      }
      if (pending !== undefined)
        return yield* Effect.fail(
          fail("CURRENT_OPERATION_UNRESOLVED", "An unknown upload cannot be blindly repeated."),
        )
      if (action.request.options?.file !== undefined) {
        if (action.fileSha256 === undefined) throw new Error("A part needs its immutable byte hash")
        expect(digest(new Uint8Array(readFileSync(action.request.options.file)))).toBe(
          action.fileSha256,
        )
      }
      pending = { key: action.key, hash }
      actions.push({ ...pending, replay: action.replay })
      const raw = yield* service.request(
        action.request.path,
        action.request.body,
        action.request.options,
      )
      if (action.acknowledge === undefined)
        return yield* Effect.fail(fail("TEST_INVALID", "Upload needs precise ACK handling."))
      const value = yield* action.acknowledge(raw)
      pending = undefined
      return value
    })
  const session: CurrentOperationSession = {
    operation_id: "current-import-1",
    intent: {
      operation_id: "current-import-1",
      input_sha256: "a".repeat(64),
      owner: { kind: "skill", id: "skill" },
    },
    owner: { kind: "skill", id: "skill" },
    sourceProgress: undefined,
    ownerRetired: false,
    predecessor: undefined,
    markSourceChildStarted: () => Effect.void,
    markSourceChildComplete: () => Effect.void,
    ownerPageId: skillPage,
    assertCurrent: () => Effect.succeed({}),
    activate: () => Effect.void,
    get pendingActionKey() {
      return pending?.key
    },
    bindOwner: () => Effect.void,
    dispatch,
  }
  const run: typeof base.run = (effect) =>
    base.run(effect.pipe(Effect.provideService(Notion, service)))
  return {
    session,
    run,
    calls,
    actions,
    uploads,
    sent,
    scope: () => makeCurrentUploadScope(session),
    prepare: (path: string, bytes: Uint8Array) =>
      run(
        prepareCurrentSharedResource(bytes, "100644", {
          storage: "attachment",
          ...(currentUploadFileSpec(path).archiveName === undefined ? {} : { archiveName: path }),
        }),
      ),
    upload: (
      path: string,
      prepared: PreparedCurrentSharedResource,
      scope?: ReturnType<typeof makeCurrentUploadScope>,
    ) =>
      run(
        uploadCurrentSharedResource({
          session,
          path,
          prepared,
          ...(scope === undefined ? {} : { scope }),
        }),
      ),
    lose: (stage: string, outcome: Failure["outcome"]) => {
      failure = { stage, outcome }
    },
    incomplete: () => {
      incomplete = true
    },
    pending: () => pending,
    writes: () => calls.filter((call) => call.method !== "GET"),
    reset: () => {
      calls.length = 0
    },
  }
}

describe("finite current original uploads", () => {
  test("supported originals keep their names while unsupported types use exactly one original ZIP", async () => {
    expect(currentUploadFileSpec("refs/文档.pdf")).toEqual({
      name: "文档.pdf",
      contentType: "application/pdf",
    })
    expect(currentUploadFileSpec("assets/font.woff2")).toEqual({
      name: "font.woff2.zip",
      contentType: "application/zip",
      archiveName: "assets/font.woff2",
    })
    expect(() => currentUploadFileSpec("../escape.bin")).toThrow()
    expect(currentUploadFileSpec("odd.constructor").archiveName).toBe("odd.constructor")
    expect(currentUploadFileSpec("字😀".repeat(200) + ".txt").name.length).toBeLessThanOrEqual(255)
    const f = fixture(),
      source = new Uint8Array([0, 255, 1, 2])
    const prepared = await f.prepare("assets/font.woff2", source)
    expect(prepared.manifest.storage.kind).toBe("zip_attachment")
    const result = await f.upload("assets/font.woff2", prepared)
    expect(result.name).toBe("font.woff2.zip")
    expect(f.sent.get(result.id)?.[0]?.slice(0, 2)).toEqual(new Uint8Array([80, 75]))
  })

  test("one invocation shares a complete inventory and successful rerun creates no upload", async () => {
    const f = fixture(),
      scope = f.scope()
    const first = await f.prepare("guide.txt", encode("current original"))
    const second = await f.prepare("style.css", encode("body { color: red }"))
    const one = await f.upload("guide.txt", first, scope)
    expect(f.uploads.get(one.id)?.filename).toBe(one.filename)
    const prefix = await f.run(
      currentUploadActionPrefix({ session: f.session, path: "guide.txt", prepared: first }),
    )
    expect(f.actions.slice(0, 2).every((action) => action.key.startsWith(prefix))).toBe(true)
    const otherOwner = await f.run(
      currentUploadActionPrefix({
        session: {
          operation_id: f.session.operation_id,
          ownerPageId: id(777),
          owner: f.session.owner,
        },
        path: "guide.txt",
        prepared: first,
      }),
    )
    expect(otherOwner).not.toBe(prefix)
    await f.upload("style.css", second, scope)
    expect(f.calls.filter((call) => call.path.startsWith("v1/file_uploads?"))).toHaveLength(1)
    expect(f.writes()).toHaveLength(4)
    expect(f.uploads.get(one.id)?.filename).toMatch(/^ntn-current-[a-f0-9]{64}\.txt$/u)
    for (const call of f.calls) if (call.file) expect(existsSync(call.file)).toBe(false)
    f.reset()
    expect(await f.upload("guide.txt", first)).toEqual(one)
    expect(f.writes()).toHaveLength(0)
    expect(f.calls).toHaveLength(1)
  })

  test("the single-part boundary and 10 MiB multipart pieces preserve the exact original bytes", async () => {
    for (const size of [20 * MiB, 20 * MiB + 1]) {
      const f = fixture(),
        source = new Uint8Array(size).fill(97)
      source[source.length - 1] = 90
      const prepared = await f.prepare("large.txt", source)
      const result = await f.upload("large.txt", prepared)
      const sends = f.calls.filter((call) => call.path.endsWith("/send"))
      expect(sends.map((call) => call.part)).toEqual(size === 20 * MiB ? [undefined] : [1, 2, 3])
      const chunks = f.sent.get(result.id)!
      expect(chunks.map((chunk) => chunk.byteLength)).toEqual(
        size === 20 * MiB ? [20 * MiB] : [10 * MiB, 10 * MiB, 1],
      )
      expect(digest(Buffer.concat(chunks))).toBe(digest(source))
      expect(f.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(
        size === 20 * MiB ? 0 : 1,
      )
      expect(
        f.actions
          .filter((action) => action.key.includes(":part:"))
          .every((action) => action.replay === "never"),
      ).toBe(true)
    }
  })

  test("lost allocation is found by exact input metadata and never allocated again", async () => {
    const f = fixture(),
      prepared = await f.prepare("current.json", encode("{}"))
    f.lose("allocate", "accepted")
    await expect(f.upload("current.json", prepared)).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    f.reset()
    await f.upload("current.json", prepared)
    expect(f.uploads.size).toBe(1)
    expect(f.writes().map((call) => call.path)).toEqual([`v1/file_uploads/${id(100)}/send`])
    expect(f.pending()).toBeUndefined()
  })

  test("absent, duplicated, incomplete or expired allocation observations cannot authorize another create", async () => {
    for (const outcome of ["absent", "duplicate", "incomplete", "expired"] as const) {
      const f = fixture(),
        prepared = await f.prepare("current.json", encode("{}"))
      f.lose("allocate", outcome === "absent" ? "absent" : "accepted")
      await expect(f.upload("current.json", prepared)).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      const row = [...f.uploads.values()][0]
      if (outcome === "duplicate") f.uploads.set(id(201), { ...row, id: id(201) })
      if (outcome === "incomplete") f.incomplete()
      if (outcome === "expired")
        f.uploads.set(id(100), { ...row, expiry_time: "2000-01-01T00:00:00.000Z" })
      f.reset()
      await expect(f.upload("current.json", prepared)).rejects.toMatchObject({
        code:
          outcome === "absent"
            ? "CURRENT_OPERATION_UNRESOLVED"
            : outcome === "duplicate"
              ? "CURRENT_UPLOAD_DUPLICATE"
              : outcome === "expired"
                ? "CURRENT_UPLOAD_UNAVAILABLE"
                : "CURRENT_UPLOAD_INVALID",
      })
      expect(f.writes()).toHaveLength(0)
      expect(f.pending()).toBeDefined()
    }
  })

  test("an accepted unknown part resumes from the observed sequential prefix without sending it twice", async () => {
    const f = fixture(),
      prepared = await f.prepare("large.txt", new Uint8Array(20 * MiB + 1).fill(97))
    f.lose("send:2", "accepted")
    await expect(f.upload("large.txt", prepared)).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    expect(f.pending()?.key).toContain(":part:2")
    f.reset()
    await f.upload("large.txt", prepared)
    expect(f.calls.filter((call) => call.path.endsWith("/send")).map((call) => call.part)).toEqual([
      3,
    ])
    expect(f.sent.get(id(100))).toHaveLength(3)
    expect(f.calls.some((call) => call.path === `v1/file_uploads/${id(100)}`)).toBe(true)
    expect(f.pending()).toBeUndefined()
  })

  test("unobserved and partial upload parts stay blocked without replay", async () => {
    for (const outcome of ["absent", "partial"] as const) {
      const f = fixture(),
        prepared = await f.prepare("current.txt", encode("current input"))
      f.lose("send:1", outcome)
      await expect(f.upload("current.txt", prepared)).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      f.reset()
      await expect(f.upload("current.txt", prepared)).rejects.toMatchObject({
        code: outcome === "absent" ? "CURRENT_OPERATION_UNRESOLVED" : "CURRENT_UPLOAD_INVALID",
      })
      expect(f.writes()).toHaveLength(0)
      expect(f.pending()).toBeDefined()
    }
  })

  test("a complete unknown upload is observed without repeating completion", async () => {
    const f = fixture(),
      prepared = await f.prepare("large.txt", new Uint8Array(20 * MiB + 1).fill(97))
    f.lose("complete", "accepted")
    await expect(f.upload("large.txt", prepared)).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    f.reset()
    await f.upload("large.txt", prepared)
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toBeUndefined()
  })

  test("complete allocation pagination cannot hide a later duplicate", async () => {
    const f = fixture(),
      prepared = await f.prepare("current.txt", encode("input"))
    f.lose("allocate", "accepted")
    await expect(f.upload("current.txt", prepared)).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    const row = f.uploads.get(id(100))!
    for (let index = 300; index < 500; index++)
      f.uploads.set(id(index), { ...row, id: id(index), filename: `unrelated-${index}.txt` })
    f.uploads.set(id(501), { ...row, id: id(501) })
    f.reset()
    await expect(f.upload("current.txt", prepared)).rejects.toMatchObject({
      code: "CURRENT_UPLOAD_DUPLICATE",
    })
    expect(f.calls).toHaveLength(3)
    expect(f.writes()).toHaveLength(0)
  })
})
