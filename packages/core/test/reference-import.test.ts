import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import { importPortable, importSkill } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotPortable } from "../src/export.ts"
import { authScope } from "../src/catalog.ts"
import { cachedRemoteObservation } from "../src/cache.ts"

const database = "44444444-4444-4444-8444-444444444444"
const root = "11111111-1111-4111-8111-111111111111"
const encoder = new TextEncoder()

function fixture(failure: "registration" | "body") {
  let exists = false
  let interrupted = false
  let main = ""
  let mutations = 0
  const children: Array<{ id: string; title: string; body: string }> = []
  let references: unknown[] = []
  const input = new Map([
    [
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [guide](references/guide.md).\n",
      ),
    ],
    ["references/guide.md", encoder.encode("# Guide\n\nRead [policy](./policy.md).\n")],
    [
      "references/policy.md",
      encoder.encode("# Policy\n\nA consumer must keep original page identities.\n"),
    ],
  ])
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const properties = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [{ plain_text: "Use for recovery." }],
    },
    References: { id: "references", type: "rich_text", rich_text: references },
  })
  const row = () => ({
    id: root,
    parent: { database_id: database, data_source_id: "ds" },
    properties: properties(),
  })
  const store = Layer.succeed(Store, {
    root: "/memory",
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
    credentialIdentity: Effect.succeed("credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (path === "v1/users/me") return { id: "fixture", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: properties() }
        if (path === "v1/data_sources/ds/query")
          return { results: exists ? [row()] : [], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          mutations++
          if (property(payload).parent && property(property(payload).parent).data_source_id) {
            exists = true
            return row()
          }
          const title = String(
            property(
              property(
                (property(property(payload).properties).title as { title: unknown[] }).title[0],
              ).text,
            ).content,
          )
          const child = {
            id: `22222222-2222-4222-8222-${String(children.length + 1).padStart(12, "0")}`,
            title,
            body: "",
          }
          children.push(child)
          return {
            id: child.id,
            properties: { title: { type: "title", title: [{ plain_text: title }] } },
          }
        }
        if (path === `v1/pages/${root}`) {
          if (options?.method === "PATCH") {
            mutations++
            if (property(property(payload).properties).references) {
              if (failure === "registration" && !interrupted) {
                interrupted = true
                return yield* Effect.fail(fail("ACCESS_DENIED", "Registration interrupted"))
              }
              references = (
                property(property(property(payload).properties).references).rich_text as unknown[]
              ).map((value) => {
                const item = property(value)
                return { ...item, plain_text: property(item.text).content }
              })
            }
          }
          return row()
        }
        if (path.includes(`/blocks/${root}/children`)) {
          const second = path.includes("start_cursor")
          return {
            results: second
              ? children.map((child) => ({
                  id: child.id,
                  type: "child_page",
                  child_page: { title: child.title },
                }))
              : [{ id: "paragraph", type: "paragraph" }],
            has_more: !second,
            next_cursor: second ? null : "children",
          }
        }
        if (path.includes(`/pages/${root}/properties/references`))
          return {
            results: references.map((rich_text) => ({ rich_text })),
            has_more: false,
            next_cursor: null,
          }
        const id = path.split("/")[2]
        const child = children.find((child) => child.id === id)
        if (path.endsWith("/markdown")) {
          if (options?.method === "PATCH") {
            mutations++
            const body = String(property(property(payload).replace_content).new_str)
            if (child) child.body = body
            else main = body
            if (failure === "body" && child?.title === "policy.md" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response lost after write"))
            }
          }
          const tags =
            id === root
              ? children
                  .map(
                    (child) =>
                      `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
                  )
                  .join("\n")
              : ""
          return {
            object: "page_markdown",
            markdown: child ? child.body : `${main}${tags ? "\n" + tags : ""}`,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (child)
          return {
            id: child.id,
            properties: { title: { type: "title", title: [{ plain_text: child.title }] } },
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
    readFile: (path) => Effect.succeed(input.get(path.slice("/input/".length))!),
  })
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    store,
    api,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    children,
    mutations: () => mutations,
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}

for (const failure of ["registration", "body"] as const) {
  test(`import resumes after ${failure} interruption without duplicate pages and reuses completed content`, async () => {
    const f = fixture(failure)
    const interrupted = await f.run(importSkill("/input", { database }).pipe(Effect.result))
    expect(interrupted._tag === "Failure" && interrupted.failure.code).toBe(
      failure === "body" ? "WRITE_OUTCOME_UNKNOWN" : "WRITE_PARTIAL",
    )
    expect(await f.run(cachedRemoteObservation(root, await f.run(authScope)))).toBeUndefined()
    const originalIds = f.children.map((child) => child.id)
    const completed = await f.run(importSkill("/input", { database }))
    expect("skill" in completed && completed.skill.id).toBe(root)
    expect(f.children.map((child) => child.id).slice(0, originalIds.length)).toEqual(originalIds)
    expect(f.children.map((child) => child.title).sort()).toEqual(["guide.md", "policy.md"])
    const guide = await f.run(readSkill(completed.snapshot_id!, { path: "references/guide.md" }))
    expect("content" in guide && guide.content).toContain("[policy](./policy.md)")
    const policy = await f.run(readSkill(completed.snapshot_id!, { path: "references/policy.md" }))
    expect("content" in policy && policy.content).toContain(
      "A consumer must keep original page identities.",
    )
    const before = f.mutations()
    const reused = await f.run(importSkill("/input", { database }))
    expect(reused.action).toBe("reuse")
    const baseline = await f.run(openSkill(root, { refresh: true }))
    const portable = await f.run(snapshotPortable(baseline))
    const equivalent = {
      ...portable,
      files: portable.files.map((file) => ({
        ...file,
        bytes: encoder.encode(new TextDecoder().decode(file.bytes).replaceAll("\n\n", "\n\n\n")),
      })),
    }
    const baselineReuse = await f.run(importPortable(equivalent, baseline))
    expect(baselineReuse.action).toBe("reuse")
    expect(f.mutations()).toBe(before)
  })
}

test("recovery rejects duplicate unregistered reference paths before writing", async () => {
  const f = fixture("registration")
  await f.run(importSkill("/input", { database }).pipe(Effect.result))
  f.children.push({ ...f.children[0]!, id: "33333333-3333-4333-8333-333333333333" })
  const before = f.mutations()
  const result = await f.run(importSkill("/input", { database }).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("REFERENCE_PATH_CONFLICT")
  expect(f.mutations()).toBe(before)
})
