import { afterAll, expect, test } from "bun:test"
import { BunHttpClient, BunServices } from "@effect/platform-bun"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import type { HttpClient } from "effect/http"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill, snapshotInfo } from "../src/snapshot.ts"
import { writeSkill } from "../src/mutation.ts"
import { tarGzip } from "./fixtures.ts"
import { snapshotPortable } from "../src/export.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const page = "87654321-1234-1234-1234-123456789abc"
const descriptionId = "notion%3A%2F%2Fskills%2Fdescription_property"
const filesId = "notion%3A%2F%2Fskills%2Ffiles_property"
let served: Uint8Array = new Uint8Array()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(new Blob([new Uint8Array(served).buffer])),
})
afterAll(() => server.stop(true))

function fixture(failMetadata = false) {
  let body = "Original body.\n"
  let description = "Use when testing writes."
  let revision = 0
  const uploads = new Map<string, Uint8Array>()
  let uploadId = 0
  const files = new Map<string, Uint8Array>([
    ["guide.md", new TextEncoder().encode("Original guide.\n")],
    ["keep.md", new TextEncoder().encode("Keep exact bytes.\n")],
  ])
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const input = new TextEncoder().encode(
    "---\nname: sample-skill\ndescription: Use when testing updated writes.\n---\n\nUpdated body.\n",
  )
  const attachments = () =>
    [...files.keys()].map((name) => ({
      name,
      type: "file",
      file: { url: `https://fixture.invalid/${name}` },
    }))
  const row = () => ({
    id: page,
    parent: { database_id: database, data_source_id: "ds" },
    properties: {
      Title: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
      Description: {
        id: descriptionId,
        type: "rich_text",
        rich_text: [{ plain_text: description }],
      },
      Files: { id: filesId, type: "files", files: attachments() },
    },
  })
  const store = Layer.succeed(Store, {
    root: "/memory",
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, value)
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
        if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === `v1/pages/${page}/markdown`) {
          if (options?.method === "PATCH") {
            const updates = property(property(payload).update_content).content_updates
            const update = property(Array.isArray(updates) ? updates[0] : undefined)
            if (update.old_str !== body)
              return yield* Effect.fail(fail("NOTION_REQUEST_FAILED", "old string mismatch"))
            body = String(update.new_str)
            revision++
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
            if (properties[descriptionId]) {
              if (failMetadata) return yield* Effect.fail(fail("ACCESS_DENIED", "metadata denied"))
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
                retained.set(
                  name,
                  item.type === "file_upload"
                    ? uploads.get(String(property(item.file_upload).id))!
                    : files.get(name)!,
                )
              }
              files.clear()
              for (const [name, bytes] of retained) files.set(name, bytes)
            }
            revision++
          }
          return row()
        }
        if (path === "v1/file_uploads") return { id: `upload-${++uploadId}` }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploads.set(path.split("/")[2]!, objects.get(options!.file!.slice("/memory/".length))!)
          return { status: "uploaded" }
        }
        if (path === `v1/ai/skills/${page}`) {
          served = tarGzip([
            {
              name: "sample-skill/SKILL.md",
              content: `---\nname: sample-skill\ndescription: ${description}\n---\n\n${body}`,
            },
            ...[...files].map(([name, bytes]) => ({
              name: `sample-skill/${name}`,
              content: bytes,
            })),
          ])
          return { id: page, version_id: `version-${revision}`, url: server.url.href }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: () =>
      Effect.succeed({
        type: "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 1,
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
    readFile: () => Effect.succeed(input),
  })
  const live = Layer.mergeAll(
    BunServices.layer,
    BunHttpClient.layer,
    api,
    store,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    run: <A, E>(
      effect: Effect.Effect<A, E, BunServices.BunServices | HttpClient.HttpClient | Notion | Store>,
    ) => Effect.runPromise(effect.pipe(Effect.provide(live))),
    changeRemote: () => {
      revision++
    },
    body: () => body,
    files,
  }
}

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
})

test("a metadata failure after body update reports the completed body and page identity", async () => {
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
