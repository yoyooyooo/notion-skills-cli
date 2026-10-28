import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { decode, fail } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { openSkill, readSkill } from "../src/snapshot.ts"
import { referencePath, rewritePageLinks } from "../src/references.ts"
import { fileRef } from "../src/ref.ts"
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
  let revision = "2026-10-17T00:00:00.000Z"
  let changeDuringRead = false
  let rootBlockId = "55555555-5555-4555-8555-555555555555"
  const calls: string[] = []
  const trees = new Map<string, unknown[]>()
  const bodies = new Map([
    [
      root,
      `Read [guide](${url(guide)}) and [policy](${url(policy)}).\n<page url="${url(guide)}">Guide</page>`,
    ],
    [guide, `# Guide\n\nRead [policy](${url(policy)}) and [main](${url(root)}).`],
    [policy, "# Policy\n\nOriginal policy."],
  ])
  const text = (content: string, href?: string) => ({
    type: "text",
    plain_text: content,
    href: href ?? null,
    text: { content, link: href ? { url: href } : null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
  })
  const block = (page: string, id: string, type: string, content: unknown) => ({
    object: "block",
    id,
    type,
    parent: { type: "page_id", page_id: page },
    created_time: "2026-10-17T00:00:00.000Z",
    last_edited_time: "2026-10-17T00:00:00.000Z",
    created_by: { object: "user", id: "99999999-9999-4999-8999-999999999999" },
    last_edited_by: { object: "user", id: "99999999-9999-4999-8999-999999999999" },
    has_children: false,
    archived: false,
    in_trash: false,
    [type]: content,
  })
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
      calls.push(path)
      if (changeDuringRead && path === `v1/blocks/${guide}/children?page_size=100`)
        revision = "2026-10-18T00:00:00.000Z"
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
          last_edited_time: revision,
          parent: { database_id: database, data_source_id: "ds" },
          properties,
        })
      if (path === `v1/pages/${guide}` || path === `v1/pages/${policy}`)
        return Effect.succeed({
          id: path.split("/")[2],
          last_edited_time: revision,
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
      const tree = trees.get(path)
      if (tree) return Effect.succeed({ results: tree, has_more: false, next_cursor: null })
      if (path === `v1/blocks/${root}/children?page_size=100`)
        return Effect.succeed({
          object: "list",
          type: "block",
          block: {},
          results: [
            block(root, rootBlockId, "paragraph", {
              rich_text: [
                text("Read "),
                text("guide", url(guide)),
                text(" and "),
                text("policy", url(policy)),
                text("."),
              ],
              color: "default",
            }),
            block(root, guide, "child_page", { title: "Guide" }),
          ],
          has_more: false,
          next_cursor: null,
        })
      if (path === `v1/blocks/${guide}/children?page_size=100`)
        return Effect.succeed({
          object: "list",
          type: "block",
          block: {},
          results: [
            block(guide, "66666666-6666-4666-8666-666666666666", "heading_1", {
              rich_text: [text("Guide")],
              color: "default",
              is_toggleable: false,
            }),
            block(guide, "77777777-7777-4777-8777-777777777777", "paragraph", {
              rich_text: [
                text("Read "),
                text("policy", url(policy)),
                text(" and "),
                text("main", url(root)),
                text("."),
              ],
              color: "default",
            }),
          ],
          has_more: false,
          next_cursor: null,
        })
      if (path === `v1/blocks/${policy}/children?page_size=100`)
        return Effect.succeed({
          object: "list",
          type: "block",
          block: {},
          results: [],
          has_more: false,
          next_cursor: null,
        })
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
    calls,
    json,
    nestedStructure: () => {
      const container = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      const nested = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      const quote = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      const sibling = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      trees.set(`v1/blocks/${root}/children?page_size=100`, [
        block(root, quote, "quote", { rich_text: [text("Quote")] }),
        {
          ...block(root, container, "toggle", { rich_text: [text("Container")] }),
          has_children: true,
        },
        block(root, sibling, "paragraph", { rich_text: [text("Sibling")] }),
      ])
      trees.set(`v1/blocks/${container}/children?page_size=100`, [
        {
          ...block(root, nested, "paragraph", { rich_text: [text("Nested")] }),
          parent: { type: "block_id", block_id: container },
        },
      ])
      return { quote, container, sibling, nested }
    },
    changeDuringRead: () => {
      changeDuringRead = true
    },
    changeStructure: () => {
      rootBlockId = "88888888-8888-4888-8888-888888888888"
    },
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

test("snapshot structure retains root sentinels and excludes nested paragraphs", async () => {
  const f = fixture()
  const ids = f.nestedStructure()
  await f.run(openSkill(root))
  const snapshots = [...f.json.values()] as {
    references?: { id: string; blocks?: { id: string; type: string }[] }[]
  }[]
  const reference = snapshots
    .flatMap((value) => value.references ?? [])
    .find((value) => value.id === root)
  expect(reference?.blocks?.map((block) => block.id)).toEqual([
    ids.quote,
    ids.container,
    ids.sibling,
  ])
  expect(reference?.blocks?.some((block) => block.id === ids.nested)).toBe(false)
  expect(reference?.blocks?.[1]?.type).toBe("toggle")
})

test("structure evidence shares one block traversal and contributes to snapshot version", async () => {
  const f = fixture()
  const first = await f.run(openSkill(root))
  for (const id of [root, guide, policy])
    expect(
      f.calls.filter((path) => path === `v1/blocks/${id}/children?page_size=100`),
    ).toHaveLength(1)
  const firstContent = await f.run(readSkill(first.snapshot_id))
  f.changeStructure()
  const second = await f.run(openSkill(root))
  expect(second.version_id).not.toBe(first.version_id)
  const secondContent = await f.run(readSkill(second.snapshot_id))
  expect("content" in firstContent && firstContent.content).toBe(
    "content" in secondContent && secondContent.content,
  )
})

test("reference edits during Markdown and block reads reject mixed revision evidence", async () => {
  const f = fixture()
  f.changeDuringRead()
  const result = await f.run(openSkill(root).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("PUBLICATION_CHANGED")
})

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
  const notion = rewritePageLinks(local, "SKILL.md", pages, "notion")
  const typed = `${url(guide)}#ntn-skills-path=${encodeURIComponent("references/guide.md")}&heading=${encodeURIComponent("section")}`
  expect(notion).toContain(`[guide](${typed})`)
  expect(notion).not.toContain(`${url(guide)}#section`)
  expect(notion).toContain("[external](https://example.com).")
  expect(rewritePageLinks(notion, "SKILL.md", pages, "local")).toContain(
    "[guide](./references/guide.md#section)",
  )
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

test("typed path fragments stay on their page when another page owns the same path", () => {
  const other = "66666666-6666-4666-8666-666666666666"
  const pages = [
    { id: root, path: "SKILL.md", markdown: "" },
    { id: guide, path: "references/guide.md", markdown: "" },
  ]
  const mismatched = `${url(other)}#ntn-skills-path=${encodeURIComponent("references/guide.md")}&heading=section`
  expect(rewritePageLinks(mismatched, "SKILL.md", pages, "local")).toBe(
    fileRef(other, "references/guide.md"),
  )
  const matched = `${url(guide)}#ntn-skills-path=${encodeURIComponent("references/guide.md")}&heading=section`
  expect(rewritePageLinks(`[guide](${matched})`, "SKILL.md", pages, "local")).toContain(
    "[guide](./references/guide.md#section)",
  )
})

test("Notion file hosts and bare-domain autolinks restore the authored text", () => {
  const pages = [{ id: root, path: "SKILL.md", markdown: "" }]
  const saved = [
    "See [STANDARDS.md](https://STANDARDS.md) and ([animations.dev](http://animations.dev)).",
    "[docs](https://example.com/guide) stays.",
    "`[STANDARDS.md](https://STANDARDS.md)`",
  ].join("\n")
  expect(rewritePageLinks(saved, "SKILL.md", pages, "local")).toBe(
    [
      "See [STANDARDS.md](STANDARDS.md) and (animations.dev).",
      "[docs](https://example.com/guide) stays.",
      "`[STANDARDS.md](https://STANDARDS.md)`",
    ].join("\n"),
  )
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
