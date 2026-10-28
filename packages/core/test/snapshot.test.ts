import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { afterAll, beforeEach, expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { Notion } from "../src/notion.ts"
import { Store, sha256 } from "../src/store.ts"
import { decode, fail, type Snapshot } from "../src/model.ts"
import { publicationGuard, publicationManifest } from "../src/publication-integrity.ts"
import { canonical } from "../src/publication-observation.ts"
import { makeSkillRefresh, openSkill, readSkill } from "../src/snapshot.ts"
import { skillDocument } from "../src/mutation.ts"
import { mainContent, skillBundle, tarGzip } from "./fixtures.ts"

const database = "12345678-1234-1234-1234-123456789abc"
const page = "87654321-1234-1234-1234-123456789abc"
const reference = "11111111-1111-4111-8111-111111111111"
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    downloads++
    return new Response(new Blob([new Uint8Array(currentBundle).buffer]))
  },
})
afterAll(() => server.stop(true))
let currentBundle = skillBundle
let currentVersion = "version-a"
let authorized = true
let currentName = "Sample Skill"
let currentDescription = "Use when reviewing."
let currentDatabase = database
let returnedPageId = page
let currentDataSource = "ds"
let trashed = false
let references = false
let rootMarkdown = "Original main content."
let referenceMarkdown = "Original reference content."
let credential = "fixture-credential"
let user = "user"
let downloads = 0
let extraProperties: Record<string, unknown> = {}
const requests: string[] = []

const json = new Map<string, unknown>()
const objects = new Map<string, Uint8Array>()
const memory = Layer.succeed(Store, {
  integrity: integrityRepositoryFixture(),
  upstream: upstreamRepositoryFixture(),
  registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
  advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
  backup: () => Effect.die(new Error("Unexpected backup")),
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
  credentialIdentity: Effect.sync(() => credential),
  request: (path) => {
    requests.push(path)
    if (!authorized) return Effect.fail(fail("ACCESS_DENIED", "revoked"))
    if (path === "v1/users/me") return Effect.succeed({ id: user, object: "user" })
    if (path === `v1/pages/${page}`)
      return Effect.succeed({
        id: returnedPageId,
        in_trash: trashed,
        parent: { database_id: currentDatabase, data_source_id: currentDataSource },
        properties: {
          title: { type: "title", title: [{ plain_text: currentName }] },
          Description: { type: "rich_text", rich_text: [{ plain_text: currentDescription }] },
          ...extraProperties,
          ...(references
            ? {
                References: { id: "references", type: "rich_text", rich_text: [] },
                Files: {
                  type: "files",
                  files: [
                    { name: "assets/data.bin", type: "file", file: { url: server.url.href } },
                  ],
                },
              }
            : {}),
        },
      })
    if (path === `v1/pages/${reference}`)
      return Effect.succeed({
        id: reference,
        properties: { title: { type: "title", title: [{ plain_text: "Guide" }] } },
      })
    if (path === `v1/pages/${page}/properties/references?page_size=100`)
      return Effect.succeed({
        object: "list",
        results: [
          {
            rich_text: {
              type: "mention",
              plain_text: "Guide",
              mention: { type: "page", page: { id: reference } },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      })
    if (
      path === `v1/blocks/${page}/children?page_size=100` ||
      path === `v1/blocks/${reference}/children?page_size=100`
    )
      return Effect.succeed({ object: "list", results: [], has_more: false, next_cursor: null })
    if (path === `v1/pages/${page}/markdown` || path === `v1/pages/${reference}/markdown`)
      return Effect.succeed({
        object: "page_markdown",
        markdown: path === `v1/pages/${page}/markdown` ? rootMarkdown : referenceMarkdown,
        truncated: false,
        unknown_block_ids: [],
      })
    if (path === `v1/databases/${database}`)
      return Effect.succeed({
        id: database,
        database_type: "skills",
        title: [{ plain_text: "Skills" }],
        data_sources: [{ id: "ds", name: "Skills" }],
      })
    if (path === "v1/data_sources/ds/query")
      return Effect.succeed({
        results: [
          {
            id: page,
            properties: {
              title: { type: "title", title: [{ plain_text: "Sample Skill" }] },
              Description: {
                type: "rich_text",
                rich_text: [{ plain_text: "Use when reviewing." }],
              },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
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
  currentDescription = "Use when reviewing."
  currentDatabase = database
  returnedPageId = page
  currentDataSource = "ds"
  trashed = false
  references = false
  rootMarkdown = "Original main content."
  referenceMarkdown = "Original reference content."
  credential = "fixture-credential"
  user = "user"
  downloads = 0
  requests.length = 0
  extraProperties = {}
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
  currentName = "Agent\u200bSkill"
  const result = await run(openSkill(page).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "INVALID_SKILL_NAME",
    details: { page_id: page, name: currentName },
  })
  expect(json.size).toBe(0)
})

for (const name of ["Tty7", "n8n-workflow", "React19", "中文", "Agent Workflow"]) {
  test(`native snapshots preserve the authored display name ${name}`, async () => {
    currentName = name
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: Use this workflow\n---\n\nOriginal content.\n`
    currentBundle = tarGzip([{ name: `${name}/SKILL.md`, content }])
    const snapshot = await run(openSkill(page))
    expect(snapshot.record.name).toBe(name)
    const read = await run(readSkill(snapshot.snapshot_id))
    expect("content" in read && read.content).toBe(content)
  })
}

test("native exports and cached versions retain invocation coherence with the current Notion Name", async () => {
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
  expect(snapshot.record.locator).toMatchObject({ type: "notion_page", database_id: database })
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

test("page ID opens verify the root before and after content while keeping fresh auth and database checks", async () => {
  await run(openSkill(page))
  await run(openSkill(page))
  expect(requests.filter((request) => request === `v1/pages/${page}`)).toHaveLength(4)
  for (const path of ["v1/users/me", `v1/databases/${database}`])
    expect(requests.filter((request) => request === path)).toHaveLength(2)
})

test("operation refresh reads the full graph and attachments and detects external content and metadata edits", async () => {
  references = true
  const initial = await run(openSkill(page))
  const refresh = await run(makeSkillRefresh(initial))
  requests.length = 0
  downloads = 0
  const unchanged = await run(refresh(initial))
  expect(unchanged.version_id).toBe(initial.version_id)
  expect(downloads).toBe(1)
  expect(requests).toEqual([
    `v1/pages/${page}`,
    `v1/pages/${page}/markdown`,
    `v1/blocks/${page}/children?page_size=100`,
    `v1/pages/${page}/properties/references?page_size=100`,
    `v1/pages/${reference}`,
    `v1/pages/${reference}/markdown`,
    `v1/blocks/${reference}/children?page_size=100`,
    `v1/pages/${reference}/markdown`,
    `v1/pages/${page}`,
  ])

  rootMarkdown = "Externally updated main content."
  const mainChanged = await run(refresh(unchanged))
  expect(mainChanged.version_id).not.toBe(unchanged.version_id)
  referenceMarkdown = "Externally updated reference content."
  const referenceChanged = await run(refresh(mainChanged))
  expect(referenceChanged.version_id).not.toBe(mainChanged.version_id)
  currentName = "Renamed Skill"
  const renamed = await run(refresh(referenceChanged))
  expect(renamed.version_id).not.toBe(referenceChanged.version_id)
  expect(renamed.record).toMatchObject({ name: "Renamed Skill", alias: "renamed-skill" })
  currentDescription = "Use after metadata updates."
  const described = await run(refresh(renamed))
  expect(described.version_id).not.toBe(renamed.version_id)
  expect(described.record.description).toBe(currentDescription)
  currentBundle = new TextEncoder().encode("Externally replaced attachment.")
  const attached = await run(refresh(described))
  expect(attached.version_id).not.toBe(described.version_id)
  expect(downloads).toBe(6)
  expect(requests).not.toContain("v1/users/me")
  expect(requests).not.toContain(`v1/databases/${database}`)
  const historical = await run(readSkill(initial.snapshot_id))
  expect("content" in historical && historical.content).toContain("Original main content.")
})

test("operation refresh rejects trash and database or data-source drift before reading content", async () => {
  references = true
  const initial = await run(openSkill(page))
  const refresh = await run(makeSkillRefresh(initial))
  for (const change of ["trash", "database", "data-source"] as const) {
    trashed = change === "trash"
    currentDatabase = change === "database" ? reference : database
    currentDataSource = change === "data-source" ? "moved-ds" : "ds"
    requests.length = 0
    const result = await run(refresh(initial).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(
      change === "trash" ? "NOT_SKILL" : "SKILL_NOT_FOUND",
    )
    expect(requests).toEqual([`v1/pages/${page}`])
  }
})

test("operation refresh binds its factory to the authenticated scope and its closure to service and credentials", async () => {
  const initial = await run(openSkill(page))
  user = "different-user"
  const wrongScope = await run(makeSkillRefresh(initial).pipe(Effect.result))
  expect(wrongScope._tag === "Failure" && wrongScope.failure.code).toBe("ACCESS_DENIED")
  user = "user"
  const refresh = await run(makeSkillRefresh(initial))
  credential = "changed-credential"
  requests.length = 0
  const changedCredential = await run(refresh(initial).pipe(Effect.result))
  expect(changedCredential._tag === "Failure" && changedCredential.failure.code).toBe(
    "ACCESS_DENIED",
  )
  expect(requests).toEqual([])
  credential = "fixture-credential"
  const foreign = await run(refresh({ ...initial, scope: "foreign-scope" }).pipe(Effect.result))
  expect(foreign._tag === "Failure" && foreign.failure.code).toBe("SKILL_NOT_FOUND")
  const changedService = await run(
    refresh(initial).pipe(
      Effect.provideService(Notion, {
        version: Effect.succeed("fixture"),
        credentialIdentity: Effect.succeed(credential),
        request: () => Effect.fail(fail("UNEXPECTED", "unexpected replacement service request")),
      }),
      Effect.result,
    ),
  )
  expect(changedService._tag === "Failure" && changedService.failure.code).toBe("ACCESS_DENIED")
  expect(requests).toEqual([])
})

test("operation refresh rejects workspace and endpoint changes before requesting content", async () => {
  const initial = await run(openSkill(page))
  const refresh = await run(makeSkillRefresh(initial))
  for (const key of ["NOTION_WORKSPACE_ID", "NOTION_API_BASE_URL"] as const) {
    const previous = process.env[key]
    try {
      process.env[key] = `${previous ?? ""}-changed`
      requests.length = 0
      const result = await run(refresh(initial).pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("ACCESS_DENIED")
      expect(requests).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }
})

test("page opens reject a root response for another page", async () => {
  returnedPageId = reference
  const result = await run(openSkill(page).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_RESPONSE")
  expect(requests).not.toContain(`v1/ai/skills/${page}`)
})

test("named opens rebuild metadata from the fresh root after catalog resolution", async () => {
  references = true
  currentName = "Renamed Skill"
  currentDescription = "Current root description."
  const snapshot = await run(openSkill("sample-skill", { database }))
  expect(snapshot.record).toMatchObject({
    name: currentName,
    alias: "renamed-skill",
    description: currentDescription,
  })
  const main = await run(readSkill(snapshot.snapshot_id))
  if (!("content" in main)) throw new Error("Expected the materialized entrypoint")
  expect(skillDocument(new TextEncoder().encode(main.content))).toMatchObject({
    name: "Renamed Skill",
    description: currentDescription,
  })
})

test("named opens reject trash, wrong root IDs, and ownership drift after catalog resolution", async () => {
  references = true
  for (const change of ["trash", "id", "database", "data-source"] as const) {
    trashed = change === "trash"
    returnedPageId = change === "id" ? reference : page
    currentDatabase = change === "database" ? reference : database
    currentDataSource = change === "data-source" ? "moved-ds" : "ds"
    requests.length = 0
    const result = await run(openSkill("sample-skill", { database }).pipe(Effect.result))
    expect(result._tag === "Failure" && result.failure.code).toBe(
      change === "trash" ? "NOT_SKILL" : change === "id" ? "INVALID_RESPONSE" : "SKILL_NOT_FOUND",
    )
    expect(requests).not.toContain(`v1/pages/${page}/markdown`)
  }
})

async function commitSnapshot(snapshot: Snapshot) {
  const raw = await run(Effect.flatMap(Notion, (service) => service.request(`v1/pages/${page}`)))
  const manifestHash = await run(
    Effect.flatMap(publicationManifest(snapshot), (manifest) => sha256(canonical(manifest))),
  )
  const ownershipHash = await run(sha256(canonical(publicationGuard(raw))))
  const operation = "p_snapshot_projection"
  const intended = "a".repeat(64)
  const revision = await run(sha256(canonical([operation, intended, manifestHash, ownershipHash])))
  const marker = {
    version: 2,
    state: "committed",
    operation_id: operation,
    intended_hash: intended,
    revision,
    manifest_hash: manifestHash,
    ownership_hash: ownershipHash,
  }
  extraProperties.Publication = {
    type: "rich_text",
    rich_text: [{ plain_text: JSON.stringify(marker) }],
  }
  return marker
}

test("cached member projection verifies original publication files before publishing derived read bytes", async () => {
  const raw = await run(openSkill(page))
  await commitSnapshot(raw)
  const originalMain = raw.files.find((file) => file.path === raw.entrypoint)!
  const derivedBytes = new TextEncoder().encode(
    mainContent.replace("references/guide.md", `skill://${reference}/SKILL.md`),
  )
  const derivedHash = await run(sha256(derivedBytes))
  objects.set(`objects/${derivedHash}`, derivedBytes)
  const projected: Snapshot = {
    ...raw,
    files: raw.files.map((file) =>
      file === originalMain
        ? { path: file.path, bytes: derivedBytes.length, sha256: derivedHash }
        : file,
    ),
    source_files: raw.files,
    source_projection: {
      source_id: "fixture-source",
      revision: "fixture-commit",
      manifest_hash: "fixture-manifest",
      files: [
        { path: raw.entrypoint, source_hash: originalMain.sha256, derived_hash: derivedHash },
      ],
    },
  }
  json.set(`snapshots/${raw.snapshot_id}.json`, projected)
  const reopened = await run(openSkill(page))
  expect(reopened.files).toEqual(projected.files)
  expect(reopened.source_files).toEqual(raw.files)
  expect(reopened.source).toBe("notion")
  const read = await run(readSkill(reopened.snapshot_id))
  expect("content" in read && read.content).toContain(`skill://${reference}/SKILL.md`)
})

test("current References reads stable Notion edits while pinned bytes remain unchanged", async () => {
  references = true
  const raw = await run(openSkill(page))
  await commitSnapshot(raw)
  const before = [...json.entries()].filter(([key]) => key.startsWith("cache/latest/"))
  rootMarkdown = "Changed instructions after committed publication."
  const result = await run(readSkill(page, { refresh: true }))
  expect("content" in result && result.content).toContain(rootMarkdown)
  expect(result.snapshot_id).not.toBe(raw.snapshot_id)
  expect([...json.entries()].filter(([key]) => key.startsWith("cache/latest/"))).not.toEqual(before)
  authorized = false
  const pinned = await run(readSkill(raw.snapshot_id))
  expect("content" in pinned && pinned.content).toContain("Original main content.")
})

test("current edited content and its own resources remain readable without an upstream source map", async () => {
  references = true
  const raw = await run(openSkill(page))
  const guide = raw.references!.find((entry) => entry.id === reference)!
  const subscription = "44444444-4444-4444-8444-444444444444"
  extraProperties["Sync Mode"] = { type: "select", select: { name: "tracked" } }
  extraProperties.Upstream = { type: "relation", relation: [{ id: subscription }], has_more: false }
  await commitSnapshot(raw)
  rootMarkdown = `Changed instructions. Read [guide](${guide.path}).`
  referenceMarkdown = "Current edited supporting file."
  requests.length = 0
  const current = await run(openSkill(page, { refresh: true }))
  expect(current.source_projection).toBeUndefined()
  expect(requests).not.toContain(`v1/pages/${subscription}`)
  const main = await run(readSkill(current.snapshot_id))
  expect("content" in main && main.content).toContain(rootMarkdown)
  const support = await run(readSkill(guide.path, { from: main.ref }))
  expect("content" in support && support.content).toBe(referenceMarkdown)
  expect(support.snapshot_id).toBe(current.snapshot_id)
  const old = await run(readSkill(raw.snapshot_id, { path: guide.path }))
  expect("content" in old && old.content).toBe("Original reference content.")
})

test("unowned pinned relative reads retain their containing file and work after remote access is revoked", async () => {
  const snapshot = await run(openSkill(page))
  authorized = false
  requests.length = 0
  const read = await run(
    readSkill("../SKILL.md", {
      from: `skill://${page}/references/guide.md?snapshot=${snapshot.snapshot_id}`,
      offline: true,
    }),
  )
  expect("content" in read && read.content).toBe(mainContent)
  expect(read.snapshot_id).toBe(snapshot.snapshot_id)
  expect(read.source).toBe("local_snapshot")
  expect(requests).toEqual([])
  const invalid = await run(
    readSkill("../../outside.md", {
      from: `skill://${page}/references/guide.md?snapshot=${snapshot.snapshot_id}`,
      offline: true,
    }).pipe(Effect.result),
  )
  expect(invalid._tag === "Failure" && invalid.failure.code).toBe("INVALID_PATH")
  expect(requests).toEqual([])
})
