import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { authScope } from "../src/catalog.ts"
import { exportSkill, portableIdentity } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { decode, fail, property, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  BUNDLE,
  bodyIdentity,
  canonicalMain,
  fileOrder,
  portableZip,
  readPortable,
  type PortableSkill,
} from "../src/portable.ts"
import {
  commitPublicationIntegrity,
  preparePublicationIntegrity,
  publicationMarker,
  startPublicationIntegrity,
} from "../src/publication-integrity.ts"
import { readSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, tarGzip, upstreamRepositoryFixture } from "./fixtures.ts"

const page = "11111111-1111-4111-8111-111111111111"
const peer = "22222222-2222-4222-8222-222222222222"
const database = "33333333-3333-4333-8333-333333333333"
const dataSource = "44444444-4444-4444-8444-444444444444"
const subscription = "55555555-5555-4555-8555-555555555555"
const upstreamDatabase = "66666666-6666-4666-8666-666666666666"
const upstreamDataSource = "77777777-7777-4777-8777-777777777777"
const revision = "a".repeat(40)
const memberKey = "skills/n8n-workflow-patterns"
const peerKey = "skills/n8n-expression-syntax"
const encode = (text: string) => new TextEncoder().encode(text)
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const rich = (text: string) => ({
  type: "rich_text",
  rich_text: text ? [{ type: "text", text: { content: text }, plain_text: text }] : [],
})
const title = (text: string) => ({
  id: "title",
  type: "title",
  title: [{ type: "text", text: { content: text }, plain_text: text }],
})
type Environment = Store | Notion | NodeServices.NodeServices | HttpClient.HttpClient

/** Read endpoints serve real archives; the integrity owner creates the committed marker. */
async function fixture(brokenLink = true) {
  const body = "# Workflow\n\nRead [webhook](webhook_processing.md).\n"
  const description = "Use when checking exact authored source exports."
  const destination = brokenLink
    ? "../../n8n-expression-syntax/SKILL.md"
    : "../n8n-expression-syntax/SKILL.md"
  const source: PortableSkill = {
    kind: "skill",
    name: "n8n-workflow-patterns",
    description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encode(
          `---\r\nname: n8n-workflow-patterns\r\ndescription: ${description}\r\ncompatibility: n8n\r\n---\r\n\r\n${body.replaceAll("\n", "\r\n")}`,
        ),
      },
      {
        path: "README.md",
        bytes: encode("\ufeff# Original readme\r\n\r\nPreserve these bytes.\r\n"),
      },
      { path: "ai_agent_workflow.md", bytes: encode("# Agent\n\nKeep original spacing.\n\n") },
      { path: "database_operations.md", bytes: encode("# Database\n\n原始文件。\n") },
      {
        path: "http_api_integration.md",
        bytes: encode("# HTTP\n\nRead [webhook](webhook_processing.md).\n"),
      },
      { path: "scheduled_tasks.md", bytes: encode("# Schedule\n\nUse the exact source.\n") },
      {
        path: "webhook_processing.md",
        bytes: encode(`# Webhook\n\n[Expression syntax](${destination})\n`),
      },
    ],
  }
  const peerSource: PortableSkill = {
    kind: "skill",
    name: "n8n-expression-syntax",
    description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encode(
          `---\nname: n8n-expression-syntax\ndescription: ${description}\n---\n\n# Expressions\n\nRead the exact published expression skill.\n`,
        ),
      },
    ],
  }
  const json = new Map<string, unknown>([["config.json", { upstream_database: upstreamDatabase }]])
  const objects = new Map<string, Uint8Array>()
  const outputs = new Map<string, Uint8Array>()
  const generations = new Map<string, number>()
  const writes: string[] = []
  const reads: string[] = []
  let exportVersion = "export-1"
  let liveBody = body
  let archiveSource = source
  let archiveRequests = 0
  const properties: Record<string, unknown> = {
    Name: title(source.name),
    Description: rich(description),
    Kind: { type: "select", select: { name: "skill" } },
    Publication: rich(""),
    "Default Context": { type: "checkbox", checkbox: false },
    Upstream: { type: "relation", relation: [{ id: subscription }], has_more: false },
    "Sync Mode": { type: "select", select: { name: "tracked" } },
    "Upstream Key": rich(memberKey),
    "Upstream Revision": rich(revision),
    "Published Hash": rich(""),
    "Fork Baseline": rich(""),
  }
  const peerProperties: Record<string, unknown> = {
    ...structuredClone(properties),
    Name: title(peerSource.name),
    "Upstream Key": rich(peerKey),
  }
  const subscriptionProperties: Record<string, unknown> = {
    Name: title("Export source"),
    Description: rich(description),
    "Default Context": { type: "checkbox", checkbox: false },
    Enabled: { type: "checkbox", checkbox: true },
    Status: { type: "select", select: { name: "verified" } },
    Source: rich(
      JSON.stringify({
        provider: {
          type: "git",
          url: "https://github.com/example/n8n-skills.git",
          ref: revision,
        },
      }),
    ),
    Ref: rich(revision),
    "Target Database ID": rich(database),
    Roots: rich('["skills"]'),
    Include: rich("[]"),
    Exclude: rich("[]"),
    Mapping: rich("{}"),
    "Published Members": rich(""),
  }
  const row = (id = page) => ({
    id,
    archived: false,
    in_trash: false,
    last_edited_time: "2026-10-22T00:00:00.000Z",
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    properties: structuredClone(id === page ? properties : peerProperties),
  })
  const remoteFiles = () => [
    canonicalMain(source.name, description, liveBody, source.files[0]!),
    {
      path: BUNDLE,
      bytes: portableZip(
        {
          ...archiveSource,
          projection: {
            name: source.name,
            description,
            body: bodyIdentity(body),
          },
        },
        true,
      ),
    },
  ]
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input) !== `https://source-export.example.test/${exportVersion}.tar.gz`)
        throw new Error("Unexpected fixture download")
      archiveRequests++
      const archive = tarGzip(
        remoteFiles().map((file) => ({
          name: `${source.name}/${file.path}`,
          content: file.bytes,
        })),
      )
      return new Response(archive.slice().buffer)
    },
    {
      preconnect: () => {
        throw new Error("Unexpected fixture preconnect")
      },
    },
  )
  const store = Layer.succeed(Store, {
    root: "/memory/source-export",
    configRoot: "/memory/config",
    cacheRoot: "/memory/cache",
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding write")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline write")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    reserveCacheGeneration: (scope, id) =>
      Effect.sync(() => {
        const key = `${scope}/${id}`,
          next = (generations.get(key) ?? 0) + 1
        generations.set(key, next)
        return next
      }),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(prefix + "/"))),
    retireKeys: () => Effect.die(new Error("Unexpected cache retirement")),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined),
        catch: () => fail("STATE_CORRUPT", "Invalid fixture state"),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
      }),
    output: (path, bytes) =>
      Effect.sync(() => {
        outputs.set(path, bytes.slice())
        return { output: path, reused: false }
      }),
  })
  const api = Layer.succeed(Notion, {
    credentialIdentity: Effect.succeed("source-export-fixture"),
    version: Effect.succeed("fixture"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? "GET"
        if (method !== "GET") {
          if (method !== "PATCH" || ![`v1/pages/${page}`, `v1/pages/${peer}`].includes(path))
            return yield* Effect.fail(
              fail("UNEXPECTED", "Unexpected fixture mutation", { path, method }),
            )
          writes.push(path)
          const value = property(property(payload).properties).Publication
          if (!value)
            return yield* Effect.fail(fail("UNEXPECTED", "Only integrity marker setup may write"))
          const id = path === `v1/pages/${page}` ? page : peer
          const targetProperties = id === page ? properties : peerProperties
          targetProperties.Publication = { ...property(value), type: "rich_text" }
          return row(id)
        }
        reads.push(path)
        if (path === "v1/users/me") return { id: "source-export-fixture", object: "user" }
        if (path === `v1/pages/${page}`) return row()
        if (path === `v1/pages/${peer}` && !brokenLink) return row(peer)
        if (path === `v1/ai/skills/${page}`)
          return {
            id: page,
            version_id: exportVersion,
            url: `https://source-export.example.test/${exportVersion}.tar.gz`,
          }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: "skills",
            title: [],
            data_sources: [{ id: dataSource, name: "Skills" }],
          }
        if (path === `v1/data_sources/${dataSource}`)
          return { properties: structuredClone(properties) }
        if (path === `v1/databases/${upstreamDatabase}`)
          return {
            id: upstreamDatabase,
            database_type: null,
            title: [],
            data_sources: [{ id: upstreamDataSource, name: "Upstream" }],
          }
        if (path === `v1/data_sources/${upstreamDataSource}`)
          return { properties: structuredClone(subscriptionProperties) }
        if (path === `v1/pages/${subscription}`)
          return {
            id: subscription,
            archived: false,
            in_trash: false,
            last_edited_time: "2026-10-22T00:00:00.000Z",
            parent: {
              type: "data_source_id",
              database_id: upstreamDatabase,
              data_source_id: upstreamDataSource,
            },
            properties: structuredClone(subscriptionProperties),
          }
        return yield* Effect.fail(fail("UNEXPECTED", `Unexpected fixture read: ${path}`, { path }))
      }),
  })
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    store,
    api,
    Layer.succeed(FetchHttpClient.Fetch, fetch),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Environment>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const scope = await run(authScope)
  const publishedHash = await run(portableIdentity(source))
  const peerHash = await run(portableIdentity(peerSource))
  properties["Published Hash"] = rich(publishedHash)
  peerProperties["Published Hash"] = rich(peerHash)
  subscriptionProperties["Published Members"] = rich(
    JSON.stringify({
      version: 1,
      revision,
      plan_hash: "a".repeat(64),
      publisher_subscription_id: subscription,
      source_manifest: {
        version: 1,
        source_id: subscription,
        revision,
        members: [
          {
            member_key: memberKey,
            source_path: memberKey,
            main: source.main,
            resources: source.files.map((file) => ({ path: file.path, sha256: hash(file.bytes) })),
          },
          ...(!brokenLink
            ? [
                {
                  member_key: peerKey,
                  source_path: peerKey,
                  main: "SKILL.md",
                  resources: peerSource.files.map((file) => ({
                    path: file.path,
                    sha256: hash(file.bytes),
                  })),
                },
              ]
            : []),
        ],
      },
      members: [
        { member_key: memberKey, page_id: page, content_hash: publishedHash, revision },
        ...(!brokenLink
          ? [{ member_key: peerKey, page_id: peer, content_hash: peerHash, revision }]
          : []),
      ],
    }),
  )
  const files = [...remoteFiles(), ...source.files.filter((file) => file.path !== source.main)]
    .sort(fileOrder)
    .map((file) => {
      const sha256 = hash(file.bytes)
      objects.set(`objects/${sha256}`, file.bytes.slice())
      return { path: file.path, bytes: file.bytes.length, sha256 }
    })
  const snapshot: Snapshot = {
    snapshot_id: `s_${hash(JSON.stringify([scope, `notion_page:${page}`, exportVersion]))}`,
    scope,
    version_id: exportVersion,
    created_at: 1,
    entrypoint: source.main,
    files,
    record: {
      id: `notion_page:${page}`,
      kind: "skill",
      name: source.name,
      alias: source.name,
      description,
      default_context: false,
      entrypoint: source.main,
      ref: `skill://${page}/SKILL.md`,
      locator: {
        type: "notion_page",
        page_id: page,
        database_id: database,
        data_source_id: dataSource,
      },
    },
  }
  // Seed only the existing page's contents. Production integrity code creates both markers
  // and the durable intent; no successful mutation receipt or cache observation is invented.
  await run(
    Effect.gen(function* () {
      yield* preparePublicationIntegrity("p_source-export-fixture", source)
      yield* startPublicationIntegrity("p_source-export-fixture", page)
      yield* commitPublicationIntegrity("p_source-export-fixture", snapshot)
    }),
  )
  if (!brokenLink) {
    const peerSnapshot: Snapshot = {
      ...snapshot,
      snapshot_id: `s_${hash(JSON.stringify([scope, `notion_page:${peer}`, "peer-export-1"]))}`,
      version_id: "peer-export-1",
      record: {
        ...snapshot.record,
        id: `notion_page:${peer}`,
        name: peerSource.name,
        alias: peerSource.name,
        ref: `skill://${peer}/SKILL.md`,
        locator: {
          type: "notion_page",
          page_id: peer,
          database_id: database,
          data_source_id: dataSource,
        },
      },
      files: peerSource.files.map((file) => {
        const sha256 = hash(file.bytes)
        objects.set(`objects/${sha256}`, file.bytes.slice())
        return { path: file.path, bytes: file.bytes.length, sha256 }
      }),
    }
    await run(
      Effect.gen(function* () {
        yield* preparePublicationIntegrity("p_source-export-peer-fixture", peerSource)
        yield* startPublicationIntegrity("p_source-export-peer-fixture", peer)
        yield* commitPublicationIntegrity("p_source-export-peer-fixture", peerSnapshot)
      }),
    )
    expect(publicationMarker(row(peer))).toMatchObject({
      state: "committed",
      operation_id: "p_source-export-peer-fixture",
    })
  }
  const marker = publicationMarker(row())
  if (marker?.state !== "committed") throw new Error("Expected the actual integrity commit")
  return {
    run,
    source,
    outputs,
    reads,
    writes,
    json,
    archiveRequests: () => archiveRequests,
    latest: () => [...json.entries()].filter(([key]) => key.startsWith("cache/latest/")),
    drift: (change: "archive" | "body" | "marker") => {
      exportVersion = "export-2"
      if (change === "archive")
        archiveSource = {
          ...source,
          files: source.files.map((file) =>
            file.path === "README.md"
              ? { ...file, bytes: encode("Changed attached source\n") }
              : file,
          ),
        }
      if (change === "body") liveBody = body + "\nA direct Notion body edit.\n"
      if (change === "marker")
        properties.Publication = rich(JSON.stringify({ ...marker, revision: "f".repeat(64) }))
    },
  }
}

test("fresh authored export preserves all seven source files despite an original unresolved repository link", async () => {
  const f = await fixture()
  const writes = f.writes.length
  expect(f.latest()).toEqual([])
  await f.run(
    exportSkill(page, {
      database,
      refresh: true,
      projection: "source",
      output: "/authored-source.zip",
    }),
  )
  const restored = readPortable(readImportZip(f.outputs.get("/authored-source.zip")!))
  expect(restored?.files).toEqual([...f.source.files].sort(fileOrder))
  expect(restored?.files).toHaveLength(7)
  expect(f.archiveRequests()).toBe(1)
  expect(f.writes).toHaveLength(writes)
  expect(f.latest()).toEqual([])

  // A non-refresh read would consume a polluted latest pointer and wrongly succeed.
  const read = await f.run(readSkill(page).pipe(Effect.result))
  expect(read._tag === "Failure" && read.failure.code).toBe("SOURCE_PREREQUISITE_UNAVAILABLE")
  const generated = await f.run(
    exportSkill(page, {
      database,
      refresh: true,
      projection: "snapshot",
      output: "/generated-snapshot.zip",
    }).pipe(Effect.result),
  )
  expect(generated._tag === "Failure" && generated.failure.code).toBe(
    "SOURCE_PREREQUISITE_UNAVAILABLE",
  )
  expect(f.outputs.has("/generated-snapshot.zip")).toBe(false)
  expect(f.latest()).toEqual([])
  expect(f.writes).toHaveLength(writes)
})

test.each(["archive", "body"] as const)(
  "authored export reads stable current %s edits while preserving the pinned source",
  async (change) => {
    const f = await fixture()
    const writes = f.writes.length
    const original = await f.run(
      exportSkill(page, {
        database,
        refresh: true,
        projection: "source",
        output: "/original-source.zip",
      }),
    )
    f.drift(change)
    const current = await f.run(
      exportSkill(page, {
        database,
        refresh: true,
        projection: "source",
        output: "/current-source.zip",
      }),
    )
    expect(current.snapshot_id).not.toBe(original.snapshot_id)
    const restored = readPortable(readImportZip(f.outputs.get("/current-source.zip")!))
    expect(restored?.files).toHaveLength(f.source.files.length)
    const changedPath = change === "archive" ? "README.md" : "SKILL.md"
    for (const file of f.source.files) {
      const actual = restored?.files.find((candidate) => candidate.path === file.path)
      if (file.path !== changedPath) expect(actual).toEqual(file)
      else if (change === "archive")
        expect(actual?.bytes).toEqual(encode("Changed attached source\n"))
      else expect(new TextDecoder().decode(actual?.bytes)).toContain("A direct Notion body edit.")
    }
    const readsBeforeHistory = f.reads.length
    await f.run(
      exportSkill(original.snapshot_id, {
        projection: "source",
        output: "/historical-source.zip",
      }),
    )
    expect(readPortable(readImportZip(f.outputs.get("/historical-source.zip")!))?.files).toEqual(
      [...f.source.files].sort(fileOrder),
    )
    expect(f.reads).toHaveLength(readsBeforeHistory)
    expect(f.latest()).toEqual([])
    expect(f.writes).toHaveLength(writes)
  },
)

test("authored export rejects an internally invalid committed marker before producing output", async () => {
  const f = await fixture()
  const writes = f.writes.length
  f.drift("marker")
  const result = await f.run(
    exportSkill(page, {
      database,
      refresh: true,
      projection: "source",
      output: "/must-not-exist.zip",
    }).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "PUBLICATION_INVALID" } })
  expect(f.outputs.size).toBe(0)
  expect(f.latest()).toEqual([])
  expect(f.writes).toHaveLength(writes)
})

test("generated cross-member refs remain derived while cached and refreshed authored exports retain their source bytes", async () => {
  const f = await fixture(false)
  const writes = f.writes.length
  await f.run(
    exportSkill(page, {
      database,
      refresh: true,
      projection: "snapshot",
      output: "/generated.zip",
    }),
  )
  const generated = readImportZip(f.outputs.get("/generated.zip")!)
  expect(
    new TextDecoder().decode(
      generated.find((file) => file.path === "webhook_processing.md")!.bytes,
    ),
  ).toContain(`skill://${peer}/SKILL.md`)
  const latest = structuredClone(f.latest())
  expect(latest).toHaveLength(1)
  await f.run(exportSkill(page, { database, projection: "source", output: "/cached-source.zip" }))
  await f.run(
    exportSkill(page, {
      database,
      refresh: true,
      projection: "source",
      output: "/fresh-source.zip",
    }),
  )
  for (const path of ["/cached-source.zip", "/fresh-source.zip"])
    expect(readPortable(readImportZip(f.outputs.get(path)!))?.files).toEqual(
      [...f.source.files].sort(fileOrder),
    )
  expect(f.latest()).toEqual(latest)
  expect(f.writes).toHaveLength(writes)
})
