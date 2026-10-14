import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { decode, fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { referencePath, rewritePageLinks } from "../src/references.ts"
import { writeSkill } from "../src/mutation.ts"

const root = "11111111-1111-4111-8111-111111111111"
const guide = "22222222-2222-4222-8222-222222222222"
const policy = "33333333-3333-4333-8333-333333333333"
const database = "44444444-4444-4444-8444-444444444444"
const url = (id: string) => `https://www.notion.so/${id.replaceAll("-", "")}`

function fixture(attachment?: string) {
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  let revoked = false
  let conflicting = false
  const bodies = new Map([
    [
      root,
      `Read [guide](${url(guide)}) and [policy](${url(policy)}).\n<page url="${url(guide)}">Guide</page>`,
    ],
    [guide, `# Guide\n\nRead [policy](${url(policy)}) and [main](${url(root)}).`],
    [policy, "# Policy\n\nOriginal policy."],
  ])
  const properties = {
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [{ plain_text: "Use when reviewing." }],
    },
    References: { id: "references", type: "rich_text", rich_text: [] },
    ...(attachment
      ? {
          Files: {
            id: "files",
            type: "files",
            files: [{ name: "assets/data.bin", type: "file", file: { url: attachment } }],
          },
        }
      : {}),
  }
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
    credentialIdentity: Effect.succeed("credential"),
    request: (path) => {
      if (revoked) return Effect.fail(fail("ACCESS_DENIED", "revoked"))
      if (path === "v1/users/me") return Effect.succeed({ id: "user", object: "user" })
      if (path === `v1/databases/${database}`)
        return Effect.succeed({
          id: database,
          database_type: null,
          title: [],
          data_sources: [{ id: "ds", name: "Skills" }],
        })
      if (path === "v1/data_sources/ds") return Effect.succeed({ properties })
      if (path === `v1/pages/${root}`)
        return Effect.succeed({
          id: root,
          parent: { database_id: database, data_source_id: "ds" },
          properties,
        })
      if (path === `v1/pages/${guide}` || path === `v1/pages/${policy}`)
        return Effect.succeed({
          id: path.split("/")[2],
          properties: {
            title: {
              type: "title",
              title: [
                { plain_text: conflicting ? "Guide" : path.includes(guide) ? "Guide" : "Policy" },
              ],
            },
          },
        })
      if (path.includes("/properties/references")) {
        const second = path.includes("start_cursor")
        const id = second ? policy : guide
        return Effect.succeed({
          object: "list",
          results: [
            {
              object: "property_item",
              rich_text: {
                type: "mention",
                plain_text: conflicting ? "Guide" : second ? "Policy" : "Guide",
                mention: { type: "page", page: { id } },
              },
            },
          ],
          has_more: !second,
          next_cursor: second ? null : "next",
        })
      }
      if (path.endsWith("/markdown"))
        return Effect.succeed({
          object: "page_markdown",
          markdown: bodies.get(path.split("/")[2]!),
          truncated: false,
          unknown_block_ids: [],
        })
      return Effect.fail(fail("UNEXPECTED", "unexpected request", { path }))
    },
  })
  const layer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch, store, api)
  return {
    bodies,
    revoke: () => {
      revoked = true
    },
    collide: () => {
      conflicting = true
    },
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}

test("References pagination materializes linked pages and child edits invalidate the online version while pinned content stays fixed", async () => {
  const f = fixture()
  const first = await f.run(openSkill(root))
  expect(first.files.map((file) => file.path)).toEqual(
    ["references/guide.md", "references/policy.md", "SKILL.md"].sort((a, b) => a.localeCompare(b)),
  )
  const main = await f.run(readSkill(first.snapshot_id))
  expect("content" in main && main.content).toContain("[guide](./references/guide.md)")
  expect("content" in main && main.content).not.toContain("<page")
  const reference = await f.run(readSkill(first.snapshot_id, { path: "references/guide.md" }))
  expect("content" in reference && reference.content).toContain(
    "[policy](./policy.md) and [main](../SKILL.md)",
  )
  f.bodies.set(policy, "# Policy\n\nChanged policy.")
  const second = await f.run(openSkill(root))
  expect(second.version_id).not.toBe(first.version_id)
  const stale = await f.run(
    writeSkill(main.ref, { input: "/input-is-not-read-before-version-check.md" }).pipe(
      Effect.result,
    ),
  )
  expect(stale._tag === "Failure" && stale.failure.code).toBe("WRITE_CONFLICT")
  f.revoke()
  const pinned = await f.run(readSkill(first.snapshot_id, { path: "references/policy.md" }))
  expect("content" in pinned && pinned.content).toContain("Original policy.")
  const online = await f.run(openSkill(root).pipe(Effect.result))
  expect(online._tag === "Failure" && online.failure.code).toBe("ACCESS_DENIED")
})

test("References same-path pages fail rather than dropping one document", async () => {
  const f = fixture()
  f.collide()
  const result = await f.run(openSkill(root).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("REFERENCE_PATH_CONFLICT")
})

test("links round-trip by containing file and preserve code, unrelated URLs and anchors", () => {
  const pages = [
    { id: root, path: "SKILL.md", markdown: "" },
    { id: guide, path: "references/guide.md", markdown: "" },
    { id: policy, path: "references/policy.md", markdown: "" },
  ]
  const original = `Read [guide](${url(guide)}#section).\n[external](https://example.com).\n\`${url(guide)}\`\n\n\`\`\`text\n[guide](${url(guide)})\n\`\`\``
  const local = rewritePageLinks(original, "SKILL.md", pages, "local")
  expect(local).toContain("[guide](./references/guide.md#section)")
  expect(local).toContain(`[guide](${url(guide)})\n\`\`\``)
  expect(local).toContain(`\`${url(guide)}\``)
  expect(rewritePageLinks(local, "SKILL.md", pages, "notion")).toBe(original)
  expect(
    rewritePageLinks(
      "[main](../SKILL.md) [policy](./policy.md)",
      "references/guide.md",
      pages,
      "notion",
    ),
  ).toBe(`[main](${url(root)}) [policy](${url(policy)})`)
  expect(referencePath("阅读策略")).toBe("references/阅读策略.md")
  expect(() => referencePath("../escape.md")).toThrow()
})

test("attachment downloads recover temporary service errors and reject denied access without leaking signed URLs", async () => {
  let requests = 0
  let denied = false
  const bytes = new Uint8Array([0, 255, 7])
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++
      if (denied) return new Response("Denied", { status: 403 })
      if (requests === 1) return new Response("Unavailable", { status: 503 })
      return new Response(bytes)
    },
  })
  try {
    const f = fixture(`${server.url}source?signature=private-fixture`)
    const snapshot = await f.run(openSkill(root))
    const file = snapshot.files.find((file) => file.path === "assets/data.bin")!
    expect(file.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
    expect(requests).toBe(2)
    denied = true
    requests = 0
    const result = await f.run(openSkill(root).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected denied attachment")
    expect(result.failure.code).toBe("DOWNLOAD_FAILED")
    expect(result.failure.details).toEqual({ path: "assets/data.bin", status: 403 })
    expect(JSON.stringify(result.failure)).not.toContain("private-fixture")
    expect(requests).toBe(1)
  } finally {
    server.stop(true)
  }
})
