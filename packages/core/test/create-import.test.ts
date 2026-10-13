import { afterAll, expect, test } from "bun:test"
import { BunHttpClient, BunServices } from "@effect/platform-bun"
import { ByteSize, Effect, FileSystem, Layer, Option, PlatformError } from "effect"
import { createSkill, importSkill } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { readSkill } from "../src/snapshot.ts"
import { tarGzip } from "./fixtures.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const page = "87654321-1234-1234-1234-123456789abc"
const descriptionId = "notion%3A%2F%2Fskills%2Fdescription_property"
const filesId = "notion%3A%2F%2Fskills%2Ffiles_property"
const encoder = new TextEncoder()
let archive: Uint8Array = new Uint8Array()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(new Blob([new Uint8Array(archive).buffer])),
})
afterAll(() => server.stop(true))

function fixture() {
  let exists = false
  let body = ""
  let title = "Sample Workflow"
  let description = "Use for samples."
  let version = 0
  let mutations = 0
  let race = false
  let files: Array<{ name: string; bytes: Uint8Array }> = []
  const input = new Map([
    [
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-workflow\ndescription: Use for samples.\ncompatibility: Bun\n---\n\n# Original\n",
      ),
    ],
    ["references/guide.md", encoder.encode("Original guide.\n")],
    ["assets/data.bin", new Uint8Array([0, 255, 7])],
  ])
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const uploads = new Map<string, Uint8Array>()
  let upload = 0
  const row = () => ({
    id: page,
    parent: { database_id: database, data_source_id: "ds" },
    properties: {
      Title: { id: "title", type: "title", title: [{ plain_text: title }] },
      Description: {
        id: descriptionId,
        type: "rich_text",
        rich_text: [{ plain_text: description }],
      },
      Files: {
        id: filesId,
        type: "files",
        files: files.map((file) => ({
          name: file.name,
          type: "file",
          file: { url: `https://fixture.invalid/${file.name}` },
        })),
      },
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
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object")),
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
        if (
          options?.method === "PATCH" ||
          path === "v1/pages" ||
          path.startsWith("v1/file_uploads")
        )
          mutations++
        if (path === "v1/users/me") return { id: "fixture-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [{ plain_text: "Skills" }],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds/query")
          return { results: exists ? [row()] : [], has_more: false, next_cursor: null }
        if (path === "v1/data_sources/ds") return { properties: row().properties }
        if (path === "v1/pages") {
          exists = true
          version++
          return row()
        }
        if (path === `v1/pages/${page}`) {
          if (options?.method === "PATCH") {
            const props = property(property(payload).properties)
            if (props.title)
              title = String(
                property(property((property(props.title).title as unknown[])[0]).text).content,
              )
            if (props[descriptionId])
              description = String(
                property(property((property(props[descriptionId]).rich_text as unknown[])[0]).text)
                  .content,
              )
            if (props[filesId])
              files = (property(props[filesId]).files as unknown[]).map((value) => {
                const file = property(value)
                return {
                  name: String(file.name),
                  bytes: uploads.get(String(property(file.file_upload).id))!,
                }
              })
            version++
          }
          return row()
        }
        if (path === `v1/pages/${page}/markdown`) {
          if (options?.method === "PATCH") {
            const content = property(payload)
            if (content.type === "update_content") {
              const change = property(
                (property(content.update_content).content_updates as unknown[])[0],
              )
              if (change.old_str !== body)
                return yield* Effect.fail(fail("WRITE_CONFLICT", "Body changed"))
              body = String(change.new_str)
            } else body = String(property(content.replace_content).new_str)
            version++
          }
          return {
            object: "page_markdown",
            markdown: body,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (path === "v1/file_uploads") return { id: `upload-${++upload}` }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploads.set(path.split("/")[2]!, objects.get(options!.file!.slice("/memory/".length))!)
          if (race) {
            version++
            body = "Concurrent body.\n"
          }
          return { status: "uploaded" }
        }
        if (path === `v1/ai/skills/${page}`) {
          archive = tarGzip([
            {
              name: "sample-workflow/SKILL.md",
              content: `---\nname: sample-workflow\ndescription: ${description}\n---\n\n${body}`,
            },
            ...files.map((file) => ({ name: `sample-workflow/${file.name}`, content: file.bytes })),
          ])
          return { id: page, version_id: `v-${version}`, url: server.url.href }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: (path) =>
      Effect.succeed({
        type: path === "/input" ? "Directory" : "File",
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
        size: ByteSize.bytes(10),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readDirectory: () => Effect.succeed([...input.keys()]),
    readFile: (path) =>
      input.has(path.slice("/input/".length))
        ? Effect.succeed(input.get(path.slice("/input/".length))!)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFile",
              pathOrDescriptor: path,
            }),
          ),
  })
  const live = Layer.mergeAll(
    BunServices.layer,
    BunHttpClient.layer,
    api,
    store,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(live)) as Effect.Effect<A, E>),
    input,
    body: () => body,
    mutations: () => mutations,
    race: () => {
      race = true
    },
  }
}

test("create rejects existing names; import reuses or replaces the same page and file set", async () => {
  const f = fixture()
  const first = await f.run(createSkill("/input", { database }))
  expect(first.action).toBe("create")
  expect("skill" in first && first.skill.id).toBe(page)
  const original = await f.run(readSkill(first.snapshot_id!, { path: "references/guide.md" }))
  expect("content" in original && original.content).toBe("Original guide.\n")
  const before = f.mutations()
  const conflict = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(conflict._tag === "Failure" && conflict.failure.code).toBe("CREATE_CONFLICT")
  const reused = await f.run(importSkill("/input", { database }))
  expect(reused.action).toBe("reuse")
  expect(reused.reused).toBe(true)
  expect(f.mutations()).toBe(before)
  f.input.set(
    "SKILL.md",
    encoder.encode("---\nname: sample-workflow\ndescription: Use for samples.\n---\n\n# Updated\n"),
  )
  f.input.delete("references/guide.md")
  f.input.set("references/new.md", encoder.encode("New guide.\n"))
  const preview = await f.run(importSkill("/input", { database, dryRun: true }))
  expect(preview.action).toBe("update")
  expect(f.mutations()).toBe(before)
  const updated = await f.run(importSkill("/input", { database }))
  expect(updated.action).toBe("update")
  expect("skill" in updated && updated.skill.id).toBe(page)
  expect(f.body()).toBe("# Updated\n")
  const removed = await f.run(
    readSkill(updated.snapshot_id!, { path: "references/guide.md" }).pipe(Effect.result),
  )
  expect(removed._tag === "Failure" && removed.failure.code).toBe("FILE_NOT_FOUND")
  const historical = await f.run(readSkill(first.snapshot_id!, { path: "references/guide.md" }))
  expect("content" in historical && historical.content).toBe("Original guide.\n")
})

test("import refuses a concurrent change before committing an uploaded source bundle", async () => {
  const f = fixture()
  await f.run(importSkill("/input", { database }))
  f.input.set("references/guide.md", encoder.encode("Updated guide.\n"))
  f.race()
  const result = await f.run(importSkill("/input", { database }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "WRITE_PARTIAL",
    details: { cause_code: "WRITE_CONFLICT", page_id: page },
  })
  expect(f.body()).toBe("Concurrent body.\n")
})
