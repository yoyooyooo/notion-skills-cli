import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import type { HttpClient } from "effect/http"
import { decode, fail, property, SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill, snapshotInfo } from "../src/snapshot.ts"
import {
  applySkill,
  replaceSkill,
  resumePublication,
  skillDocument,
  writeSkill,
} from "../src/mutation.ts"
import { tarGzip } from "./fixtures.ts"
import { snapshotPortable } from "../src/export.ts"
import { portableFiles } from "../src/portable.ts"
import {
  updateSkill,
  listOperations,
  reconcileOperation,
  resumeOperation,
  showOperation,
  OperationSchema,
} from "../src/command-operations.ts"
import { SyncLocal } from "../src/sync-local.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { UpstreamPublisher } from "../src/upstream-model.ts"
import { UpstreamPublisherLive } from "../src/upstream-publication.ts"
import { authScope } from "../src/catalog.ts"

test("Skill document parsing preserves authored Unicode, digit and space names", () => {
  for (const name of ["Tty7", "n8n-workflow", "React19", "中文", "Agent Workflow"]) {
    const bytes = new TextEncoder().encode(
      `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\n\nOriginal body.\n`,
    )
    expect(skillDocument(bytes)).toMatchObject({ name, body: "Original body.\n" })
  }
  for (const name of ["", "  ", "Agent\tSkill", "Agent\u200bSkill"]) {
    expect(() =>
      skillDocument(
        new TextEncoder().encode(
          `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\nBody`,
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_SKILL_NAME" }))
  }
})

const database = "12345678-1234-1234-1234-123456789abc"
const page = "87654321-1234-1234-1234-123456789abc"
const descriptionId = "notion%3A%2F%2Fskills%2Fdescription_property"
const filesId = "notion%3A%2F%2Fskills%2Ffiles_property"
let served: Uint8Array = new Uint8Array()
const recoveryDownloads = new Map<string, Uint8Array>()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new Response(
      new Blob([
        new Uint8Array(recoveryDownloads.get(new URL(request.url).pathname) ?? served).buffer,
      ]),
    ),
})
afterAll(() => server.stop(true))

function fixture(
  failMetadata = false,
  inputText?: string,
  uploadFailure?: "allocate" | "send_pending" | "send_uploaded" | "attach",
  changedFiles?: Readonly<Record<string, Uint8Array>>,
) {
  const stateRoot = mkdtempSync(join(tmpdir(), "publication-write-"))
  let body = "Original body.\n"
  let description = "Use when testing writes."
  let revision = 0
  let name = "Sample Skill"
  let defaultContext = false
  let ownershipMode: "tracked" | "fork" | undefined
  let publication: unknown[] = []
  let losePropertyResponse = false
  let loseMarkdownResponse = false
  let afterPageRead: (() => void) | undefined
  let afterReceipt: (() => void) | undefined
  const propertyWrites: Array<Record<string, unknown>> = []
  const requests: Array<{ path: string; method: string }> = []
  const uploads = new Map<string, Uint8Array>()
  let uploadId = 0
  let uploadInterrupted = false
  const files = new Map<string, Uint8Array>([
    ["guide.md", new TextEncoder().encode("Original guide.\n")],
    ["keep.md", new TextEncoder().encode("Keep exact bytes.\n")],
  ])
  const fileIds = new Map([...files.keys()].map((name) => [name, `fixture-file:${name}`]))
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const input = new TextEncoder().encode(
    inputText ??
      "---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\nUpdated body.\n",
  )
  const attachments = () =>
    [...files.keys()].map((name) => ({
      name,
      id: fileIds.get(name),
      type: "file",
      file: { url: `${server.url}attachment/${name}` },
    }))
  const row = () => ({
    id: page,
    last_edited_time: new Date(Date.UTC(2026, 0, 1) + revision * 1000).toISOString(),
    parent: { database_id: database, data_source_id: "ds" },
    properties: {
      Publication: { id: "publication", type: "rich_text", rich_text: publication },
      Title: { id: "title", type: "title", title: [{ plain_text: name, text: { content: name } }] },
      Description: {
        id: descriptionId,
        type: "rich_text",
        rich_text: [{ plain_text: description, text: { content: description } }],
      },
      Files: { id: filesId, type: "files", files: attachments() },
      "Default Context": { id: "default", type: "checkbox", checkbox: defaultContext },
      ...(ownershipMode
        ? {
            Upstream: {
              type: "relation",
              relation: [{ id: "11111111-1111-4111-8111-111111111111" }],
            },
            "Sync Mode": { type: "select", select: { name: ownershipMode } },
            "Upstream Key": { type: "rich_text", rich_text: [{ plain_text: "skills/sample" }] },
            "Published Hash": { type: "rich_text", rich_text: [{ plain_text: "0".repeat(64) }] },
          }
        : {}),
    },
  })
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) json.delete(key)
        return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
      }),
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, value)
        if (key.startsWith("publications/") && afterReceipt) {
          const hook = afterReceipt
          afterReceipt = undefined
          hook()
        }
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "missing")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        requests.push({ path, method: options?.method ?? (payload === undefined ? "GET" : "POST") })
        if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: row().properties }
        if (path === `v1/blocks/${page}/children?page_size=100`)
          return { object: "list", results: [], has_more: false, next_cursor: null }
        if (path === `v1/pages/${page}/markdown`) {
          if (options?.method === "PATCH") {
            const updates = property(property(payload).update_content).content_updates
            const update = property(Array.isArray(updates) ? updates[0] : undefined)
            if (update.old_str !== body)
              return yield* Effect.fail(fail("NOTION_REQUEST_FAILED", "old string mismatch"))
            body = String(update.new_str)
            revision++
            if (loseMarkdownResponse) {
              loseMarkdownResponse = false
              body = body.replace(/\n$/, "")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Markdown response was lost after application"),
              )
            }
          }
          return {
            object: "page_markdown",
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (path === `v1/pages/${page}`) {
          if (options?.method === "PATCH") {
            const properties = property(property(payload).properties)
            const marker = properties.Publication ?? properties.publication
            if (marker) {
              publication = (property(marker).rich_text as unknown[]).map((value) => ({
                ...property(value),
                plain_text: property(property(value).text).content,
              }))
              return row()
            }
            propertyWrites.push(properties)
            if (failMetadata) return yield* Effect.fail(fail("ACCESS_DENIED", "metadata denied"))
            if (properties.title) {
              const rich = property(properties.title).title as unknown[]
              name = String(property(property(rich[0]).text).content)
            }
            if (properties.default) defaultContext = Boolean(property(properties.default).checkbox)
            if (properties[descriptionId]) {
              const rich = property(properties[descriptionId]).rich_text
              description = String(
                property(property(Array.isArray(rich) ? rich[0] : undefined).text).content,
              )
            }
            if (properties[filesId]) {
              const next = property(properties[filesId]).files
              if (!Array.isArray(next))
                return yield* Effect.fail(fail("INVALID_RESPONSE", "invalid files"))
              const retained = new Map<string, Uint8Array>()
              for (const value of next) {
                const item = property(value)
                const name = String(item.name)
                if (item.type === "file_upload")
                  fileIds.set(name, String(property(item.file_upload).id))
                retained.set(
                  name,
                  item.type === "file_upload"
                    ? uploads.get(String(property(item.file_upload).id))!
                    : files.get(name)!,
                )
              }
              files.clear()
              for (const [name, bytes] of retained) files.set(name, bytes)
              for (const [name, bytes] of files) recoveryDownloads.set(`/attachment/${name}`, bytes)
              if (uploadFailure === "attach" && !uploadInterrupted) {
                uploadInterrupted = true
                revision++
                return yield* Effect.fail(
                  fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "Attachment response lost after remote application",
                  ),
                )
              }
            }
            revision++
            if (losePropertyResponse) {
              losePropertyResponse = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Property response lost after application"),
              )
            }
          }
          const saved = row()
          if (options?.method !== "PATCH" && afterPageRead) {
            const hook = afterPageRead
            afterPageRead = undefined
            hook()
          }
          return saved
        }
        if (path === "v1/file_uploads") {
          const id = `upload-${++uploadId}`
          if (uploadFailure === "allocate" && !uploadInterrupted) {
            uploadInterrupted = true
            return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Allocation response lost"))
          }
          return { id, status: "pending" }
        }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          const id = path.split("/")[2]!
          if (options?.method !== "POST")
            return yield* Effect.fail(fail("INVALID_REQUEST", "Send endpoint cannot be read"))
          if (uploadFailure === "send_pending" && !uploadInterrupted) {
            uploadInterrupted = true
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Send transport lost before observable completion"),
            )
          }
          uploads.set(id, objects.get(options!.file!.slice(stateRoot.length + 1))!)
          if (uploadFailure === "send_uploaded" && !uploadInterrupted) {
            uploadInterrupted = true
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Send response lost after completion"),
            )
          }
          return { id, status: "uploaded" }
        }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return {
            object: "file_upload",
            id,
            status: uploads.has(id) ? "uploaded" : "pending",
            expiry_time: "2026-12-31T00:00:00Z",
          }
        }
        if (path === `v1/ai/skills/${page}`) {
          served = tarGzip([
            {
              name: `${name.toLowerCase().replaceAll(" ", "-")}/SKILL.md`,
              content: `---\nname: ${name.toLowerCase().replaceAll(" ", "-")}\ndescription: ${description}\n---\n\n${body}`,
            },
            ...[...files].map(([fileName, bytes]) => ({
              name: `${name.toLowerCase().replaceAll(" ", "-")}/${fileName}`,
              content: bytes,
            })),
          ])
          return { id: page, version_id: `version-${revision}`, url: server.url.href }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: (path) =>
      Effect.succeed({
        type: changedFiles && path === "/changes" ? "Directory" : "File",
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
        size: ByteSize.bytes(input.length),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readFile: (path) => Effect.succeed(changedFiles?.[path.slice("/changes/".length)] ?? input),
    readDirectory: () => Effect.succeed(Object.keys(changedFiles ?? {})),
  })
  const baseLive = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    api,
    store,
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(SyncLocal, {
      inspect: () => Effect.die(new Error("Unexpected local-sync inspection in property recovery")),
      commit: () => Effect.die(new Error("Unexpected local-sync commit in property recovery")),
      withLocks: () => Effect.die(new Error("Unexpected local-sync fence in property recovery")),
    }),
  )
  const live = UpstreamPublisherLive.pipe(
    Layer.provideMerge(
      Layer.effect(
        UpstreamState,
        Effect.map(Store, (service) => service.upstream),
      ).pipe(Layer.provideMerge(baseLive)),
    ),
  )
  return {
    run: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | NodeServices.NodeServices
        | HttpClient.HttpClient
        | Notion
        | Store
        | SyncLocal
        | UpstreamState
        | UpstreamPublisher
      >,
    ) => Effect.runPromise(effect.pipe(Effect.provide(live))),
    changeRemote: () => {
      revision++
    },
    body: () => body,
    setOwnership: (mode: "tracked" | "fork") => {
      ownershipMode = mode
    },
    editRemoteBody: (content: string) => {
      body = content
      revision++
    },
    files,
    propertyWrites,
    requests,
    json,
    editProperties: (value: { description?: string; defaultContext?: boolean }) => {
      if (value.description !== undefined) {
        description = value.description
        revision++
      }
      if (value.defaultContext !== undefined) defaultContext = value.defaultContext
    },
    afterPageRead: (hook: () => void) => {
      afterPageRead = hook
    },
    afterReceipt: (hook: () => void) => {
      afterReceipt = hook
    },
    losePropertyResponse: () => {
      losePropertyResponse = true
    },
    loseMarkdownResponse: () => {
      loseMarkdownResponse = true
    },
    allowMetadata: () => {
      failMetadata = false
    },
  }
}

test("invalid property descriptions fail before reads, journals or writes", async () => {
  for (const description of ["", " \n ", "x".repeat(2001), "😀".repeat(2001), 42]) {
    const f = fixture()
    const result = await f.run(
      updateSkill(page, { description: description as string }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_SKILL" } })
    expect(f.requests).toHaveLength(0)
    expect(f.propertyWrites).toHaveLength(0)
    expect(f.json.size).toBe(0)
  }
})

test("apply changes body, resources and allowed properties in one resumable publication", async () => {
  const text = (value: string) => new TextEncoder().encode(value)
  const f = fixture(false, undefined, undefined, {
    "SKILL.md": text("Updated complete body.\n"),
    "references/new.md": text("Added guide.\n"),
    "assets/data.bin": new Uint8Array([0, 42, 255]),
  })
  const first = await f.run(openSkill(page))
  const saved = await f.run(
    applySkill(snapshotInfo(first).ref, {
      input: "/changes",
      remove: ["guide.md"],
      name: "Applied Skill",
      description: "A complete edit.",
      defaultContext: true,
    }),
  )
  expect(saved).toMatchObject({
    operation: "replace",
    verified: true,
    changes: { files: ["SKILL.md", "assets/data.bin", "references/new.md"], removed: ["guide.md"] },
  })
  const current = await f.run(openSkill(page, { refresh: true }))
  expect(current.record).toMatchObject({
    name: "Applied Skill",
    description: "A complete edit.",
    default_context: true,
  })
  const portable = await f.run(snapshotPortable(current))
  expect(f.body()).toBe("Updated complete body.\n")
  expect(portable.files.find((file) => file.path === "guide.md")).toBeUndefined()
  expect(portable.files.find((file) => file.path === "keep.md")?.bytes).toEqual(
    text("Keep exact bytes.\n"),
  )
  expect(portable.files.find((file) => file.path === "references/new.md")?.bytes).toEqual(
    text("Added guide.\n"),
  )
  expect(portable.files.find((file) => file.path === "assets/data.bin")?.bytes).toEqual(
    new Uint8Array([0, 42, 255]),
  )
  const receipts = [...f.json.keys()].filter((key) => /^publications\/p_[^/]+\.json$/.test(key))
  expect(receipts).toHaveLength(1)
  const old = await f.run(readSkill(first.snapshot_id))
  expect(old).toMatchObject({ content: expect.stringContaining("Original body.") })
})

test("apply keeps nested sparse paths and all unspecified files", async () => {
  const bytes = new TextEncoder().encode("Nested change.\n")
  const f = fixture(false, undefined, undefined, { "references/new.md": bytes })
  const first = await f.run(openSkill(page))
  await f.run(applySkill(first.snapshot_id, { input: "/changes" }))
  const saved = await f.run(snapshotPortable(await f.run(openSkill(page, { refresh: true }))))
  expect(saved.files.find((file) => file.path === "references/new.md")?.bytes).toEqual(bytes)
  expect(saved.files.find((file) => file.path === "new.md")).toBeUndefined()
  expect(saved.files.some((file) => file.path === "guide.md")).toBe(true)
  expect(f.body()).toBe("Original body.\n")
})

test("apply accepts a portable export while preserving unspecified remote resources", async () => {
  const files = portableFiles({
    kind: "skill",
    name: "File metadata",
    description: "File description",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", bytes: new TextEncoder().encode("Portable edit.\n") }],
  })
  const f = fixture(
    false,
    undefined,
    undefined,
    Object.fromEntries(files.map((file) => [file.path, file.bytes])),
  )
  const first = await f.run(openSkill(page))
  await f.run(applySkill(first.snapshot_id, { input: "/changes" }))
  const saved = await f.run(snapshotPortable(await f.run(openSkill(page, { refresh: true }))))
  expect(f.body()).toBe("Portable edit.\n")
  expect(saved.name).toBe("Sample Skill")
  expect(saved.files.some((file) => file.path === "guide.md")).toBe(true)
  expect(saved.files.some((file) => file.path === "keep.md")).toBe(true)
})

test("apply rejects unpinned, stale and contradictory edits before publication", async () => {
  for (const kind of [
    "unpinned",
    "stale",
    "checkbox-stale",
    "remove-main",
    "remove-and-write",
    "empty",
  ] as const) {
    const f = fixture()
    const first = await f.run(openSkill(page))
    if (kind === "stale") f.changeRemote()
    if (kind === "checkbox-stale") f.editProperties({ defaultContext: true })
    const result = await f.run(
      applySkill(
        kind === "unpinned" ? page : first.snapshot_id,
        kind === "empty"
          ? {}
          : kind === "remove-main"
            ? { remove: ["SKILL.md"] }
            : kind === "remove-and-write"
              ? { input: "/guide.md", remove: ["guide.md"] }
              : kind === "checkbox-stale"
                ? { defaultContext: false }
                : { name: "Requested name" },
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(f.propertyWrites).toHaveLength(0)
    expect([...f.json.keys()].filter((key) => key.startsWith("publications/"))).toHaveLength(0)
    expect(f.body()).toBe("Original body.\n")
  }
})

test("property-only apply changes the requested checkbox even when content is identical", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  const saved = await f.run(applySkill(first.snapshot_id, { defaultContext: true }))
  expect(saved).toMatchObject({ operation: "replace", verified: true })
  expect((await f.run(openSkill(page, { refresh: true }))).record.default_context).toBe(true)
  expect(f.body()).toBe("Original body.\n")
})

test("interrupted apply resumes its original publication with files and properties", async () => {
  const f = fixture(true, "Updated complete body.\n")
  const first = await f.run(openSkill(page))
  const interrupted = await f.run(
    applySkill(first.snapshot_id, {
      input: "/SKILL.md",
      remove: ["guide.md"],
      name: "Resumed Skill",
      defaultContext: true,
    }).pipe(Effect.result),
  )
  if (interrupted._tag !== "Failure") throw new Error("Expected metadata interruption")
  const id = String(property(interrupted.failure.details).operation_id)
  expect(id).toMatch(/^p_/)
  f.allowMetadata()
  const resumed = await f.run(resumePublication(id))
  expect(property(resumed)).toMatchObject({ operation: "replace", verified: true })
  const current = await f.run(openSkill(page, { refresh: true }))
  expect(current.record).toMatchObject({ name: "Resumed Skill", default_context: true })
  const saved = await f.run(snapshotPortable(current))
  expect(saved.files.some((file) => file.path === "guide.md")).toBe(false)
  expect(saved.files.some((file) => file.path === "keep.md")).toBe(true)
  expect(
    [...f.json.keys()].filter((key) => /^publications\/p_[^/]+\.json$/.test(key)),
  ).toHaveLength(1)
})

test("tracked content rejects ordinary body and authored-property writes at the shared publication boundary", async () => {
  for (const operation of ["write", "apply", "name", "description"] as const) {
    const f = fixture()
    f.setOwnership("tracked")
    const first = await f.run(openSkill(page))
    const result = await f.run(
      Effect.gen(function* () {
        if (operation === "write") yield* writeSkill(first.snapshot_id, { input: "/SKILL.md" })
        else if (operation === "apply") yield* applySkill(first.snapshot_id, { input: "/SKILL.md" })
        else
          yield* updateSkill(
            first.snapshot_id,
            operation === "name" ? { name: "Local rename" } : { description: "Local edit" },
          )
      }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe("UPSTREAM_CONTENT_READ_ONLY")
    expect(f.body()).toBe("Original body.\n")
    expect(f.propertyWrites).toHaveLength(0)
    expect(
      f.requests.some(
        (request) => request.method !== "GET" && /v1\/file_uploads/.test(request.path),
      ),
    ).toBe(false)
  }
})

test("fork content remains writable through ordinary apply", async () => {
  const f = fixture()
  f.setOwnership("fork")
  const first = await f.run(openSkill(page))
  expect(await f.run(applySkill(first.snapshot_id, { input: "/SKILL.md" }))).toMatchObject({
    verified: true,
  })
  expect(f.body()).toBe("Updated body.\n")
})

test("an organization-only apply preserves human edits and leaves current tracked content readable", async () => {
  const f = fixture()
  f.setOwnership("tracked")
  f.editRemoteBody("Human edited tracked content.\n")
  const first = await f.run(openSkill(page))
  const saved = await f.run(applySkill(first.snapshot_id, { defaultContext: true }))
  expect(saved).toMatchObject({ verified: true })
  expect(f.body()).toBe("Human edited tracked content.\n")
  expect(f.propertyWrites).toHaveLength(1)
  expect(Object.keys(f.propertyWrites[0]!)).toEqual(["default"])
  const current = await f.run(readSkill(page, { refresh: true }))
  expect(current).toMatchObject({
    content: expect.stringContaining("Human edited tracked content."),
  })
  expect((await f.run(openSkill(page, { refresh: true }))).record.default_context).toBe(true)
})

test("pinned protocol writes refuse a changed remote version without modifying content", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  f.changeRemote()
  const result = await f.run(
    writeSkill(snapshotInfo(first).ref, { input: "/input.md" }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_CONFLICT")
  expect(f.body()).toBe("Original body.\n")
})

test("attachment writes preserve other files and historical snapshot content", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  const before = new Uint8Array(f.files.get("keep.md")!)
  const result = await f.run(
    writeSkill(`skill://${page}/guide.md?snapshot=${first.snapshot_id}`, { input: "/input.md" }),
  )
  const saved = await f.run(snapshotPortable(await f.run(openSkill(page))))
  expect(saved.files.find((file) => file.path === "keep.md")?.bytes).toEqual(before)
  expect(saved.files.find((file) => file.path === "guide.md")?.bytes).toEqual(
    new TextEncoder().encode(
      "---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\nUpdated body.\n",
    ),
  )
  const old = await f.run(readSkill(`skill://${page}/guide.md?snapshot=${first.snapshot_id}`))
  expect("content" in old && old.content).toBe("Original guide.\n")
  expect("snapshot_id" in result && result.snapshot_id).not.toBe(first.snapshot_id)
  if (!("operation_id" in result)) throw new Error("Expected a retained publication")
  const recovered = await f.run(resumePublication(result.operation_id))
  expect(recovered as unknown).toEqual(result)
  expect(property(recovered).path).toBe("guide.md")
})

test("a source bundle failure after body update reports the completed body and page identity", async () => {
  const f = fixture(true)
  const first = await f.run(openSkill(page))
  const result = await f.run(
    writeSkill(snapshotInfo(first).ref, { input: "/input.md" }).pipe(Effect.result),
  )
  expect(f.body()).toBe("Updated body.\n")
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "WRITE_PARTIAL",
    details: {
      page_id: page,
      stage: "metadata",
      completed: ["body", "upload:source_bundle"],
      cause_code: "ACCESS_DENIED",
    },
  })
})

test("nested attachment writes preserve paths and leave the body and unrelated files intact", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  const result = await f.run(
    writeSkill(first.snapshot_id, { path: "references/guide.md", input: "/input.md" }),
  )
  const saved = await f.run(snapshotPortable(await f.run(openSkill(page))))
  expect(saved.files.find((file) => file.path === "references/guide.md")?.bytes).toEqual(
    new TextEncoder().encode(
      "---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\nUpdated body.\n",
    ),
  )
  expect(saved.files.find((file) => file.path === "keep.md")?.bytes).toEqual(
    new TextEncoder().encode("Keep exact bytes.\n"),
  )
  expect(f.body()).toBe("Original body.\n")
  expect(result.path).toBe("references/guide.md")
})

test("main-file writes preserve page metadata while retaining changed frontmatter bytes", async () => {
  const input =
    "---\nname: different-file-name\ndescription: File-only description.\n---\n\nUpdated body.\n"
  const f = fixture(false, input)
  const first = await f.run(openSkill(page))
  const before = new Uint8Array(f.files.get("keep.md")!)
  const result = await f.run(writeSkill(snapshotInfo(first).ref, { input: "/input.md" }))
  expect(result.operation).toBe("write")
  expect("record" in result && result.record.name).toBe("Sample Skill")
  expect("record" in result && result.record.description).toBe("Use when testing writes.")
  expect(f.propertyWrites).toHaveLength(1)
  expect(Object.keys(f.propertyWrites[0]!)).toEqual([filesId])
  const snapshot = await f.run(openSkill(page, { refresh: true }))
  const saved = await f.run(snapshotPortable(snapshot))
  expect(saved.name).toBe("Sample Skill")
  expect(saved.description).toBe("Use when testing writes.")
  expect(saved.files.find((file) => file.path === saved.main)?.bytes).toEqual(
    new TextEncoder().encode(input),
  )
  expect(saved.files.find((file) => file.path === "keep.md")?.bytes).toEqual(before)
})

test("resumed main-file writes preserve the file-only operation and page metadata", async () => {
  const f = fixture(
    true,
    "---\nname: file-only-name\ndescription: File-only description.\n---\n\nUpdated body.\n",
  )
  const first = await f.run(openSkill(page))
  const interrupted = await f.run(
    writeSkill(first.snapshot_id, { input: "/input.md" }).pipe(Effect.result),
  )
  if (interrupted._tag !== "Failure") throw new Error("Expected source bundle interruption")
  const operationId = String(property(interrupted.failure.details).operation_id)
  f.allowMetadata()
  const resumed = await f.run(resumePublication(operationId))
  expect(property(resumed).operation).toBe("write")
  expect(property(property(resumed).record).name).toBe("Sample Skill")
  expect(property(property(resumed).record).description).toBe("Use when testing writes.")
  for (const properties of f.propertyWrites) expect(Object.keys(properties)).toEqual([filesId])
  const saved = await f.run(snapshotPortable(await f.run(openSkill(page, { refresh: true }))))
  const bytes = saved.files.find((file) => file.path === saved.main)!.bytes
  expect(new TextDecoder().decode(bytes)).toContain("name: file-only-name")
})

for (const boundary of ["after-initial-open", "after-begin-publication"] as const) {
  test(`property update rejects external target edit ${boundary} without PATCH`, async () => {
    const f = fixture()
    const edit = () => f.editProperties({ description: "External author metadata" })
    if (boundary === "after-initial-open") f.afterPageRead(edit)
    else f.afterReceipt(edit)
    const result = await f.run(
      updateSkill(page, { description: "Requested metadata" }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(
      boundary === "after-initial-open" ? "PUBLICATION_CHANGED" : "WRITE_CONFLICT",
    )
    expect(f.propertyWrites).toHaveLength(0)
    if (boundary === "after-begin-publication") {
      if (result._tag !== "Failure") throw new Error("Expected conflict")
      const id = String(property(result.failure.details).operation_id)
      expect(id).toMatch(/^p_/)
      expect(await f.run(showOperation(id))).toMatchObject({
        operation_id: id,
        state: "failed",
        verified: false,
      })
      expect(await f.run(reconcileOperation(id))).toMatchObject({
        operation_id: id,
        result: { outcome: "conflict" },
        verified: false,
      })
      expect(f.propertyWrites).toHaveLength(0)
    }
  })
}

test("pinned property update rejects checkbox edits omitted from content version", async () => {
  const f = fixture()
  const pinned = await f.run(openSkill(page))
  f.editProperties({ defaultContext: true })
  const result = await f.run(
    updateSkill(snapshotInfo(pinned).ref, { defaultContext: false }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_CONFLICT")
  expect((await f.run(openSkill(page))).version_id).toBe(pinned.version_id)
  expect(f.propertyWrites).toHaveLength(0)
  expect(await f.run(updateSkill(page, { defaultContext: false }))).toMatchObject({
    verified: true,
  })
})

test("property update reads back all three authorized fields", async () => {
  const f = fixture()
  const saved = await f.run(
    updateSkill(page, {
      name: "Renamed Skill",
      description: "New description",
      defaultContext: true,
    }),
  )
  expect(saved.verified).toBe(true)
  expect(f.propertyWrites).toHaveLength(1)
  expect(Object.keys(f.propertyWrites[0]!)).toEqual(["title", descriptionId, "default"])
  const current = await f.run(openSkill(page))
  expect(current.record).toMatchObject({
    name: "Renamed Skill",
    description: "New description",
    default_context: true,
  })
})

for (const external of [false, true]) {
  test(`unknown applied property update ${external ? "conflicts on unrequested edit" : "reconciles original intent"} without replay`, async () => {
    const f = fixture()
    f.losePropertyResponse()
    const result = await f.run(
      updateSkill(page, { description: "Applied description" }).pipe(Effect.result),
    )
    if (result._tag !== "Failure") throw new Error("Expected lost response")
    expect(result.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const id = String(property(result.failure.details).operation_id)
    if (external) f.editProperties({ defaultContext: true })
    const beforeRequests = f.requests.length
    const reconciled = await f.run(reconcileOperation(id))
    expect(reconciled).toMatchObject({
      operation_id: id,
      domain: "publication",
      result: { outcome: external ? "conflict" : "needs_safe_commit" },
      verified: false,
    })
    expect(f.propertyWrites).toHaveLength(1)
    expect(f.requests.slice(beforeRequests).every((request) => request.method === "GET")).toBe(true)
    if (!external) {
      expect(reconciled.next.argv).toEqual(["ntn-skills", "operation", "resume", id])
      const resumed = await f.run(resumeOperation(id))
      expect(resumed).toMatchObject({
        domain: "publication",
        operation_id: id,
        state: "completed",
        verified: true,
      })
      expect(f.propertyWrites).toHaveLength(1)
      expect(decode(OperationSchema, resumed)).toEqual(resumed)
    }
  })
}

test("operation summaries hide private receipt fields and scope foreign publications", async () => {
  const f = fixture()
  const saved = await f.run(updateSkill(page, { description: "Saved description" }))
  if (!("operation_id" in saved)) throw new Error("Expected a retained publication")
  const id = String(saved.operation_id)
  const shown = await f.run(showOperation(id))
  expect(decode(OperationSchema, shown)).toEqual(shown)
  expect(Object.keys(shown).sort()).toEqual([
    "domain",
    "next",
    "operation_id",
    "result",
    "resume_supported",
    "state",
    "verified",
  ])
  const raw = property(f.json.get(`publications/${id}.json`))
  f.json.set(`publications/${id}.json`, { ...raw, scope: "another-credential" })
  expect((await f.run(listOperations)).operations).toEqual([])
  const hidden = await f.run(showOperation(id).pipe(Effect.result))
  expect(hidden._tag === "Failure" && hidden.failure.code).toBe("OPERATION_NOT_FOUND")
})

test("review operations remain accessible without authenticating and never replay", async () => {
  const f = fixture()
  const id = "p_local_review"
  f.json.set(`operation-reviews/${id}.json`, {
    format: 1,
    operation_id: id,
    kind: "review",
    state: "unknown",
    reason: "UNRESOLVED_NO_REPLAY",
    provenance: {
      type: "external_migration",
      source_sha256: "original-hash",
      audit_ref: "migration-review#original",
    },
    refs: { plan_ids: [], publication_ids: [id], binding_ids: [] },
    next: { action: "inspect", audit_ref: "migration-review#original" },
  })
  const shown = await f.run(showOperation(id))
  expect((await f.run(listOperations)).operations).toEqual([shown])
  expect(decode(OperationSchema, await f.run(reconcileOperation(id)))).toEqual(shown)
  const resumed = await f.run(resumeOperation(id).pipe(Effect.result))
  expect(
    resumed._tag === "Failure" && resumed.failure instanceof SkillsError && resumed.failure.code,
  ).toBe("UNRESOLVED_NO_REPLAY")
  expect(f.requests).toEqual([])
})

test("operation listing detects cross-domain identity collisions", async () => {
  const f = fixture()
  const saved = await f.run(updateSkill(page, { description: "Saved description" }))
  if (!("operation_id" in saved)) throw new Error("Expected a retained publication")
  const id = String(saved.operation_id)
  f.json.set(`operation-reviews/${id}.json`, {
    format: 1,
    operation_id: id,
    kind: "review",
    state: "unknown",
    reason: "UNRESOLVED_NO_REPLAY",
    provenance: { type: "external_migration", source_sha256: "hash", audit_ref: "audit" },
    refs: { plan_ids: [], publication_ids: [id], binding_ids: [] },
    next: { action: "inspect", audit_ref: "audit" },
  })
  const shown = await f.run(showOperation(id).pipe(Effect.result))
  expect(shown._tag === "Failure" && shown.failure.code).toBe("OPERATION_ID_COLLISION")
  const listed = await f.run(listOperations.pipe(Effect.result))
  expect(listed._tag === "Failure" && listed.failure.code).toBe("OPERATION_ID_COLLISION")
})

test("sync operation visibility requires every configured binding in the current scope", async () => {
  const f = fixture()
  const scope = await f.run(authScope)
  const binding = {
    id: "b_current",
    label: "current",
    page_id: page,
    database_id: database,
    data_source_id: "ds",
    logical_path: "/fixture",
    active: true,
    revision: 1,
    scope,
  }
  const other = { ...binding, id: "b_other", label: "other", scope: "another-scope" }
  f.json.set("config.json", { sync_bindings: [binding, other] })
  const id = "o_11111111-1111-4111-8111-111111111111"
  const edge = (binding_id: string) => ({
    binding_id,
    page_id: page,
    resolved_path: "/private/path",
    stage: "complete",
    generation_before: 0,
    generation_after: 1,
    retained: [],
  })
  const receipt = {
    format: "ntn-skills-sync-receipt",
    version: 1,
    operation_id: id,
    plan_id: "p_plan",
    created_at: 1,
    status: "complete",
    groups: [],
    bindings: [edge(binding.id), edge(other.id)],
  }
  f.json.set(`sync/receipts/${id}.json`, receipt)
  expect((await f.run(listOperations)).operations).toEqual([])
  f.json.set(`sync/receipts/${id}.json`, { ...receipt, bindings: [edge(binding.id)] })
  const shown = await f.run(showOperation(id))
  expect(shown).toMatchObject({ domain: "sync_local", operation_id: id, resume_supported: false })
  expect(JSON.stringify(shown)).not.toContain("/private/path")
  const resumed = await f.run(resumeOperation(id).pipe(Effect.result))
  expect(
    resumed._tag === "Failure" && resumed.failure instanceof SkillsError && resumed.failure.code,
  ).toBe("OPERATION_NOT_RESUMABLE")
})

test("sync operation reconciliation observes fresh sides without promoting a pending baseline", async () => {
  const f = fixture()
  const scope = await f.run(authScope)
  const binding = {
    id: "b_readonly",
    label: "readonly",
    page_id: page,
    database_id: database,
    data_source_id: "ds",
    logical_path: "/fixture",
    active: true,
    revision: 1,
    scope,
  }
  f.json.set("config.json", { sync_bindings: [binding] })
  const base = {
    format: "ntn-skills-sync-base",
    version: 1,
    binding_id: binding.id,
    generation: 0,
    initialized: false,
  }
  f.json.set(`sync/bases/${binding.id}.json`, base)
  const id = "o_22222222-2222-4222-8222-222222222222"
  const receipt = {
    format: "ntn-skills-sync-receipt",
    version: 1,
    operation_id: id,
    plan_id: "p_readonly",
    created_at: 1,
    status: "pending",
    groups: [],
    bindings: [
      {
        binding_id: binding.id,
        page_id: page,
        resolved_path: "/fixture",
        stage: "writing",
        generation_before: 0,
        retained: [],
      },
    ],
  }
  f.json.set(`sync/receipts/${id}.json`, receipt)
  const beforeRequests = f.requests.length
  const observed = await f.run(
    reconcileOperation(id).pipe(
      Effect.provideService(SyncLocal, {
        inspect: () =>
          Effect.succeed({
            logical_path: "/fixture",
            resolved_path: "/fixture",
            exists: false,
            proof: { root: { nodes: [], resolved_path: "/fixture", exists: false }, files: [] },
            file_hashes: [],
          }),
        commit: () => Effect.die(new Error("Readonly reconciliation attempted a local write")),
        withLocks: () =>
          Effect.die(new Error("Readonly reconciliation attempted baseline settlement")),
      }),
    ),
  )
  expect(observed).toMatchObject({
    domain: "sync_local",
    operation_id: id,
    state: "pending",
    verified: false,
    result: {
      observations: [
        { binding_id: binding.id, status: "needs_initialization", authoritative: true },
      ],
    },
  })
  expect(f.json.get(`sync/bases/${binding.id}.json`)).toEqual(base)
  expect(f.json.get(`sync/receipts/${id}.json`)).toEqual(receipt)
  expect(f.requests.slice(beforeRequests).every((request) => request.method === "GET")).toBe(true)
  expect(
    f.requests.slice(beforeRequests).some((request) => request.path === `v1/ai/skills/${page}`),
  ).toBe(true)
  expect(decode(OperationSchema, observed)).toEqual(observed)
})

for (const target of [
  "Changed paragraph.\n",
  "```text\nconst text = `literal`;\n\nkeep this blank line\n```\n",
]) {
  test("reconcile accepts normalized Markdown targets without replay", async () => {
    const f = fixture(
      false,
      `---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\n${target}`,
    )
    const first = await f.run(openSkill(page))
    f.loseMarkdownResponse()
    const stopped = await f.run(
      writeSkill(snapshotInfo(first).ref, { input: "/input.md" }).pipe(Effect.result),
    )
    if (stopped._tag !== "Failure") throw new Error("Expected lost Markdown response")
    const id = String(property(stopped.failure.details).operation_id)
    const beforeRequests = f.requests.length
    expect(await f.run(reconcileOperation(id))).toMatchObject({
      domain: "publication",
      verified: false,
      result: { outcome: "success" },
    })
    const receipt = property(f.json.get(`publications/${id}.json`))
    if (!Array.isArray(receipt.intents)) throw new Error("Expected publication intents")
    expect(receipt.intents.every((intent) => property(intent).status === "completed")).toBe(true)
    expect(property(f.json.get(`publications/${id}.json`)).conflict).toBeUndefined()
    expect(f.requests.slice(beforeRequests).every((request) => request.method === "GET")).toBe(true)
  })
}

test("reconcile keeps a fence when matching Markdown still has an unknown intent", async () => {
  const f = fixture()
  const first = await f.run(openSkill(page))
  f.loseMarkdownResponse()
  const stopped = await f.run(
    writeSkill(snapshotInfo(first).ref, { input: "/input.md" }).pipe(Effect.result),
  )
  if (stopped._tag !== "Failure") throw new Error("Expected lost Markdown response")
  const id = String(property(stopped.failure.details).operation_id)
  const receipt = property(f.json.get(`publications/${id}.json`))
  if (!Array.isArray(receipt.intents)) throw new Error("Expected publication intents")
  expect(
    receipt.intents.some(
      (intent) =>
        String(property(intent).path).endsWith("/markdown") &&
        property(intent).status === "unknown",
    ),
  ).toBe(true)
  expect(f.body()).toBe("Updated body.")
  f.json.set(`publications/${id}.json`, { ...receipt, conflict: true, state: "failed" })
  const beforeRequests = f.requests.length
  expect(await f.run(reconcileOperation(id))).toMatchObject({
    result: { outcome: "conflict" },
    verified: false,
  })
  const retained = property(f.json.get(`publications/${id}.json`))
  expect(retained.conflict).toBe(true)
  expect(retained.intents).toEqual(receipt.intents)
  expect(retained.guards).toEqual(receipt.guards)
  expect(f.requests.slice(beforeRequests).every((request) => request.method === "GET")).toBe(true)
})

test("reconcile preserves a Markdown fence when literal code content is missing", async () => {
  const f = fixture(
    false,
    "---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\n```text\nkeep literal\n\nkeep blank\n```\n",
  )
  const first = await f.run(openSkill(page))
  f.loseMarkdownResponse()
  const stopped = await f.run(
    writeSkill(snapshotInfo(first).ref, { input: "/input.md" }).pipe(Effect.result),
  )
  if (stopped._tag !== "Failure") throw new Error("Expected lost Markdown response")
  const id = String(property(stopped.failure.details).operation_id)
  const receipt = property(f.json.get(`publications/${id}.json`))
  const intents = (receipt.intents as unknown[]).map((intent) => {
    const value = property(intent)
    if (!String(value.path).endsWith("/markdown")) return intent
    const body = property(value.body),
      update = property(body.update_content)
    return {
      ...value,
      body: {
        ...body,
        update_content: {
          ...update,
          content_updates: (update.content_updates as unknown[]).map((entry) => ({
            ...property(entry),
            new_str: String(property(entry).new_str).replace(
              "keep literal",
              "keep literal plus missing content",
            ),
          })),
        },
      },
    }
  })
  f.json.set(`publications/${id}.json`, { ...receipt, intents, conflict: true, state: "failed" })
  const beforeRequests = f.requests.length
  expect(await f.run(reconcileOperation(id))).toMatchObject({
    result: { outcome: "conflict" },
    verified: false,
  })
  expect(property(f.json.get(`publications/${id}.json`)).conflict).toBe(true)
  expect(f.requests.slice(beforeRequests).every((request) => request.method === "GET")).toBe(true)
})

for (const failure of ["allocate", "send_pending", "send_uploaded", "attach"] as const) {
  test(`upload recovery preserves the original operation after lost ${failure}`, async () => {
    const f = fixture(false, undefined, failure)
    const stopped = await f.run(writeSkill(page, { input: "/input/SKILL.md" }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected interrupted upload publication")
    const id = String(property(stopped.failure.details).operation_id)
    const before = f.requests.length
    if (failure === "allocate" || failure === "send_pending") {
      const refused = await f.run(resumePublication(id).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe(
        "PUBLICATION_UPLOAD_RECOVERY_REQUIRED",
      )
      if (refused._tag === "Failure")
        expect(property(refused.failure.details).next).toEqual({
          argv: ["ntn-skills", "operation", "resume", id, "--new-artifact"],
        })
      expect(f.requests.slice(before).every((item) => item.method === "GET")).toBe(true)
    }
    const resumed = await f.run(
      resumePublication(id, { newArtifact: failure === "allocate" || failure === "send_pending" }),
    )
    expect(resumed.operation_id).toBe(id)
    const receipt = property(f.json.get(`publications/${id}.json`))
    expect(receipt.state).toBe("completed")
    const intents = (receipt.intents as unknown[]).map(property)
    if (failure === "allocate" || failure === "send_pending")
      expect(
        intents.some(
          (item) => item.status === "unknown" && property(item.recovery).kind === "remote_orphan",
        ),
      ).toBe(true)
    expect(
      f.requests.filter((item) => item.path === "v1/file_uploads" && item.method === "POST"),
    ).toHaveLength(failure === "allocate" || failure === "send_pending" ? 2 : 1)
    expect(
      f.requests.filter(
        (item) => item.path === "v1/file_uploads/upload-1/send" && item.method === "POST",
      ),
    ).toHaveLength(failure === "allocate" ? 0 : 1)
    expect(
      f.requests.every((item) => !(item.path.endsWith("/send") && item.method === "GET")),
    ).toBe(true)
    expect(f.requests.every((item) => item.path !== "v1/pages")).toBe(true)
  }, 20_000)
}

test("new artifact authorization preserves the external edit fence", async () => {
  const f = fixture(false, undefined, "allocate")
  const stopped = await f.run(writeSkill(page, { input: "/input/SKILL.md" }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected unknown allocation")
  const id = String(property(stopped.failure.details).operation_id)
  f.changeRemote()
  const before = f.requests.length
  const resumed = await f.run(resumePublication(id, { newArtifact: true }).pipe(Effect.result))
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.requests.slice(before).every((item) => item.method === "GET")).toBe(true)
})

for (const failure of ["allocate", "send_pending"] as const) {
  test(`upload recovery retains missing artifact evidence after lost ${failure}`, async () => {
    const f = fixture(false, undefined, failure)
    const stopped = await f.run(writeSkill(page, { input: "/input/SKILL.md" }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected interrupted upload")
    const id = String(property(stopped.failure.details).operation_id)
    const receipt = property(f.json.get(`publications/${id}.json`))
    const intents = (receipt.intents as unknown[]).map((raw) => {
      const { artifact: _artifact, ...intent } = property(raw)
      return intent
    })
    f.json.set(`publications/${id}.json`, { ...receipt, intents })
    const resumed = await f.run(resumePublication(id, { newArtifact: true }))
    expect(resumed.operation_id).toBe(id)
    const saved = property(f.json.get(`publications/${id}.json`))
    expect(saved.state).toBe("completed")
    expect(
      (saved.intents as unknown[])
        .map(property)
        .some(
          (item) => item.status === "unknown" && property(item.recovery).kind === "remote_orphan",
        ),
    ).toBe(true)
    expect(
      f.requests.filter(
        (item) => item.path === "v1/file_uploads/upload-1/send" && item.method === "POST",
      ),
    ).toHaveLength(failure === "allocate" ? 0 : 1)
  }, 20_000)
}

test("upload recovery proves attachment and requested metadata together", async () => {
  const f = fixture(false, undefined, "attach")
  const portable = {
    kind: "skill" as const,
    name: "Sample Skill",
    description: "Use for replaced metadata.",
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: new TextEncoder().encode(
          "---\nname: sample-skill\ndescription: Use for replaced metadata.\n---\n\nReplacement body.\n",
        ),
      },
    ],
  }
  const stopped = await f.run(replaceSkill(portable, { target: page }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost attachment acknowledgement")
  const id = String(property(stopped.failure.details).operation_id)
  const resumed = await f.run(resumePublication(id))
  expect(resumed.operation_id).toBe(id)
  expect(property(f.json.get(`publications/${id}.json`)).state).toBe("completed")
  expect(
    f.requests.filter((item) => item.path === "v1/file_uploads" && item.method === "POST"),
  ).toHaveLength(1)
})
