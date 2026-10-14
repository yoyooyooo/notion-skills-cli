import { afterAll, beforeEach, expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { decode, fail } from "../src/model.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { mainContent, skillBundle, tarGzip } from "./fixtures.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const page = "87654321-1234-1234-1234-123456789abc"
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(new Blob([new Uint8Array(currentBundle).buffer])),
})
afterAll(() => server.stop(true))
let currentBundle = skillBundle
let currentVersion = "version-a"
let authorized = true
let currentName = "Sample Skill"

const json = new Map<string, unknown>()
const objects = new Map<string, Uint8Array>()
const memory = Layer.succeed(Store, {
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
  readJson: <S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S) =>
    Effect.try({
      try: () => (json.has(key) ? decode(schema, json.get(key)) : undefined),
      catch: () => fail("STATE_CORRUPT", "corrupt"),
    }),
  writeJson: (key, value) =>
    Effect.sync(() => {
      json.set(key, value)
    }),
  writeBytes: (key, bytes) =>
    Effect.sync(() => {
      objects.set(key, bytes)
    }),
  readBytes: (key) =>
    objects.has(key)
      ? Effect.succeed(objects.get(key)!)
      : Effect.fail(fail("SNAPSHOT_MISSING", "missing")),
  output: () => Effect.fail(fail("UNUSED", "unused")),
})
const api = Layer.succeed(Notion, {
  version: Effect.succeed("fixture"),
  credentialIdentity: Effect.succeed("fixture-credential"),
  request: (path) => {
    if (!authorized) return Effect.fail(fail("ACCESS_DENIED", "revoked"))
    if (path === "v1/users/me") return Effect.succeed({ id: "user", object: "user" })
    if (path === `v1/pages/${page}`)
      return Effect.succeed({
        id: page,
        parent: { database_id: database, data_source_id: "ds" },
        properties: { title: { type: "title", title: [{ plain_text: currentName }] } },
      })
    if (path === `v1/databases/${database}`)
      return Effect.succeed({
        id: database,
        database_type: "skills",
        title: [{ plain_text: "Skills" }],
        data_sources: [{ id: "ds", name: "Skills" }],
      })
    if (path === `v1/ai/skills/${page}`)
      return Effect.succeed({ id: page, version_id: currentVersion, url: server.url.href })
    return Effect.fail(fail("UNEXPECTED", "unexpected"))
  },
})
const live = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch, memory, api)
const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient | Notion | Store>,
) => Effect.runPromise(effect.pipe(Effect.provide(live)))
beforeEach(() => {
  json.clear()
  objects.clear()
  currentBundle = skillBundle
  currentVersion = "version-a"
  authorized = true
  currentName = "Sample Skill"
})

test("pinned reads keep old content after updates and remote revocation; new online reads require access", async () => {
  const first = await run(openSkill(page))
  const read = await run(
    readSkill(first.snapshot_id, { path: "references/guide.md", lines: "2-2" }),
  )
  expect("content" in read && read.content).toBe("第二行")
  expect("has_more" in read && read.has_more).toBe(true)
  expect(read.ref).toContain(`?snapshot=${first.snapshot_id}`)
  currentVersion = "version-b"
  currentBundle = tarGzip([
    { name: "sample-skill/SKILL.md", content: mainContent },
    { name: "sample-skill/references/guide.md", content: "new version" },
  ])
  const second = await run(openSkill(page))
  expect(second.snapshot_id).not.toBe(first.snapshot_id)
  const latest = await run(
    readSkill(`skill://${page}/references/guide.md?snapshot=${second.snapshot_id}`),
  )
  expect("content" in latest && latest.content).toBe("new version")
  authorized = false
  const pinned = await run(
    readSkill(`skill://${page}/references/guide.md?snapshot=${first.snapshot_id}`),
  )
  expect("content" in pinned && pinned.content).toBe("第一行\n第二行\n第三行")
  const denied = await run(openSkill(page).pipe(Effect.result))
  expect(denied._tag === "Failure" && denied.failure.code).toBe("ACCESS_DENIED")
})

test("snapshot reads detect corruption, missing paths and binary content", async () => {
  const snapshot = await run(openSkill(page))
  const binary = await run(
    readSkill(snapshot.snapshot_id, { path: "assets/data.bin" }).pipe(Effect.result),
  )
  expect(binary._tag === "Failure" && binary.failure.code).toBe("BINARY_FILE")
  const missing = await run(
    readSkill(snapshot.snapshot_id, { path: "absent.md" }).pipe(Effect.result),
  )
  expect(missing._tag === "Failure" && missing.failure.code).toBe("FILE_NOT_FOUND")
  const file = snapshot.files.find((f) => f.path === "references/guide.md")!
  objects.set(`objects/${file.sha256}`, new TextEncoder().encode("tampered"))
  const corrupted = await run(
    readSkill(snapshot.snapshot_id, { path: "references/guide.md" }).pipe(Effect.result),
  )
  expect(corrupted._tag === "Failure" && corrupted.failure.code).toBe("STATE_CORRUPT")
})

test("invalid Notion names fail as typed errors even when selecting a page ID", async () => {
  currentName = "资源治理"
  const result = await run(openSkill(page).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: page, name: currentName },
  })
  expect(json.size).toBe(0)
})

test("exports and cached versions must use the invocation name derived from the current Notion Name", async () => {
  currentBundle = tarGzip([
    {
      name: "different-name/SKILL.md",
      content: mainContent.replace("sample-skill", "different-name"),
    },
  ])
  const mismatch = await run(openSkill(page).pipe(Effect.result))
  expect(mismatch._tag === "Failure" && mismatch.failure).toMatchObject({
    code: "INVALID_SKILL",
    details: { page_id: page, expected: "sample-skill", actual: "different-name" },
  })
  expect(json.size).toBe(0)
  currentBundle = skillBundle
  const original = await run(openSkill(page))
  currentName = "Renamed Skill"
  const cached = await run(openSkill(page).pipe(Effect.result))
  expect(cached._tag === "Failure" && cached.failure).toMatchObject({
    code: "INVALID_SKILL",
    details: { expected: "renamed-skill", actual: "sample-skill" },
  })
  const historical = await run(readSkill(original.snapshot_id))
  expect("content" in historical && historical.content).toBe(mainContent)
})

test("page reads accept aliases and pinned database constraints remain local after remote revocation", async () => {
  const other = "11111111-1111-4111-8111-111111111111"
  json.set("config.json", {
    sources: [
      {
        alias: "frontend",
        database_id: database,
        title: "Frontend Skills",
        data_source_ids: ["ds"],
      },
      {
        alias: "ops",
        database_id: other,
        title: "Operations Skills",
        data_source_ids: ["other-ds"],
      },
    ],
  })
  const snapshot = await run(openSkill(page, { database: "frontend" }))
  expect(snapshot.skill.database_id).toBe(database)
  const wrongOnline = await run(openSkill(page, { database: "ops" }).pipe(Effect.result))
  expect(wrongOnline._tag === "Failure" && wrongOnline.failure.code).toBe("SKILL_NOT_FOUND")
  authorized = false
  const read = await run(readSkill(snapshot.snapshot_id, { database: "frontend" }))
  expect("content" in read && read.content).toBe(mainContent)
  for (const [selector, code] of [
    ["ops", "SKILL_NOT_FOUND"],
    ["missing", "DATABASE_NOT_FOUND"],
  ] as const) {
    const result = await run(
      readSkill(snapshot.snapshot_id, { database: selector }).pipe(Effect.result),
    )
    expect(result._tag === "Failure" && result.failure.code).toBe(code)
  }
})
