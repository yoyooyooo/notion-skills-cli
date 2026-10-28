import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { restoreAcknowledgedCodeLanguages as restore } from "../src/publication-code-languages.ts"
import { canonical, metadata } from "../src/publication-observation.ts"
import { Store } from "../src/store.ts"

const root = "11111111-1111-4111-8111-111111111111"
const code = "22222222-2222-4222-8222-222222222222"
const pagePath = `v1/pages/${root}`,
  bodyPath = `${pagePath}/markdown`
const op = "p_code_alias_finite_fixture"
const sha = (value) => createHash("sha256").update(value).digest("hex")
const rich = (content, url = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})

// This is an isolated finite-field fixture, with no native state or transport.
// The original operation's journal lifecycle is covered separately by its
// existing production tests and the fixed real-ACK read-only replay.
function fixture(options = {}) {
  const targetLink = options.targetLink ?? "REFERENCES.md"
  const actualLink = options.actualLink ?? "https://REFERENCES.md"
  const sourceLink = options.sourceLink ?? "https://example.test/source?q=1#section"
  const actualSourceLink = options.actualSourceLink ?? sourceLink
  const body = `# Alias proof\n\n\`\`\`text\n  exact authored code\n\`\`\`\n\n[guide](${targetLink})\n\n[site](${sourceLink})\n`
  const input =
    "---\nname: code-alias-fixture\ndescription: Prove the finite code field.\n---\n\n" + body
  const bytes = new TextEncoder().encode(input)
  const portable = {
    kind: "skill",
    name: "code-alias-fixture",
    description: "Prove the finite code field.",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", bytes }],
  }
  const intended = sha(
    canonical([
      portable.kind,
      portable.name,
      portable.description,
      portable.main,
      [["SKILL.md", bytes.length, sha(bytes)]],
    ]),
  )
  const marker = { version: 2, state: "writing", operation_id: op, intended_hash: intended }
  let revision = 0,
    ownerReads = 0
  const properties = {
    Publication: {
      id: "publication",
      type: "rich_text",
      rich_text: [rich(JSON.stringify(marker))],
    },
  }
  const rootData = () => ({
    id: root,
    last_edited_time: `revision-${revision}`,
    archived: false,
    in_trash: false,
    parent: { type: "data_source_id", data_source_id: "fixture-ds" },
    properties: structuredClone(properties),
  })
  const makeBlock = (id, type, fields) => ({
    id,
    type,
    has_children: false,
    archived: false,
    in_trash: false,
    last_edited_time: "block-0",
    parent: { type: "page_id", page_id: root },
    [type]: fields,
  })
  const roots = [
    makeBlock("33333333-3333-4333-8333-333333333333", "heading_1", {
      rich_text: [rich("Alias proof")],
      color: "default",
    }),
    makeBlock(code, "code", {
      language: "javascript",
      rich_text: [rich("  exact authored code")],
      caption: [],
    }),
    makeBlock("44444444-4444-4444-8444-444444444444", "paragraph", {
      rich_text: [rich(options.label ?? "guide", actualLink)],
      color: "default",
    }),
    makeBlock("55555555-5555-4555-8555-555555555555", "paragraph", {
      rich_text: [rich("site", actualSourceLink)],
      color: "default",
    }),
  ]
  if (options.changedCode) roots[1].code.rich_text = [rich("  changed authored code")]
  if (options.foreignBlock) roots[1].parent.page_id = "66666666-6666-4666-8666-666666666666"
  if (options.duplicateBlock) roots[2].id = roots[0].id
  const inline = (values) =>
    values
      .map((span) =>
        span.text.link ? `[${span.text.content}](${span.text.link.url})` : span.text.content,
      )
      .join("")
  const markdown = () =>
    roots
      .map((block) =>
        block.type === "heading_1"
          ? `# ${inline(block.heading_1.rich_text)}`
          : block.type === "code"
            ? `\`\`\`${block.code.language}\n${inline(block.code.rich_text)}\n\`\`\``
            : inline(block.paragraph.rich_text),
      )
      .join("\n\n") + "\n"
  const receipt = {
    format: 1,
    operation_id: op,
    operation: "create",
    state: "running",
    page_id: root,
    data_source_id: "fixture-ds",
    portable: {
      ...portable,
      files: [{ path: "SKILL.md", sha256: sha(bytes), size: bytes.length }],
    },
    guards: { [pagePath]: metadata(rootData()), [bodyPath]: markdown() },
    stages: [],
    intents: [
      {
        method: "POST",
        path: "v1/pages",
        status: "completed",
        response: { id: root },
        body: {
          parent: { data_source_id: "fixture-ds" },
          properties: {
            Publication: { rich_text: [rich(JSON.stringify(marker))] },
          },
        },
      },
      {
        method: "PATCH",
        path: bodyPath,
        status: "completed",
        response: { id: root },
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: body },
        },
      },
    ],
  }
  const savedReceipt = canonical(receipt),
    requests = [],
    fieldBodies = []
  const integrity = { version: 1, operation_id: op, intended_hash: intended, marker }
  const denied = () => Effect.die("Unexpected fixture durable operation")
  const store = new Proxy(
    { integrity: { inspect: () => Effect.succeed(structuredClone(integrity)) } },
    { get: (object, key) => (key in object ? object[key] : denied) },
  )
  const api = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, requestBody, callOptions) =>
      Effect.sync(() => {
        const method = callOptions?.method ?? (requestBody === undefined ? "GET" : "POST")
        requests.push({ path, method })
        if (method === "GET" && path === pagePath) {
          ownerReads++
          if (options.revisionDuringRead && ownerReads === 2) revision++
          return rootData()
        }
        if (method === "GET" && path === bodyPath)
          return {
            object: "page_markdown",
            markdown: markdown(),
            truncated: false,
            unknown_block_ids: [],
          }
        if (method === "GET" && path === `v1/blocks/${root}/children?page_size=100`)
          return {
            results: structuredClone(roots),
            has_more: false,
            next_cursor: options.invalidCursor ? "unexpected" : null,
          }
        assert.equal(method, "PATCH")
        assert.equal(path, `v1/blocks/${code}`)
        assert.deepEqual(requestBody, { code: { language: "plain text" } })
        fieldBodies.push(structuredClone(requestBody))
        revision++
        roots[1].code.language = "plain text"
        roots[1].last_edited_time = `block-${revision}`
        if (options.sideEffect === "caption") roots[1].code.caption = [rich("unexpected")]
        if (options.sideEffect === "metadata")
          properties.Other = { id: "other", type: "rich_text", rich_text: [] }
        return structuredClone(roots[1])
      }),
  }
  return {
    roots,
    receipt,
    requests,
    fieldBodies,
    savedReceipt,
    run: (fn) =>
      Effect.runPromise(
        fn(receipt, portable, api).pipe(
          Effect.provideService(Store, store),
          Effect.provide(NodeServices.layer),
          Effect.result,
        ),
      ),
  }
}

for (const actualLink of [
  "https://REFERENCES.md",
  "http://REFERENCES.md",
  "https://REFERENCES.md/",
  "REFERENCES.md",
]) {
  test(`the finite repair preserves the body and exact field under ${actualLink}`, async () => {
    const f = fixture({ actualLink }),
      result = await f.run(restore)
    assert.equal(
      result._tag,
      "Success",
      result._tag === "Failure" ? result.failure.message : undefined,
    )
    assert.deepEqual(f.fieldBodies, [{ code: { language: "plain text" } }])
    assert.equal(f.roots[1].code.language, "plain text")
    assert.equal(canonical(f.receipt), f.savedReceipt)
    assert.ok(
      f.requests
        .filter((row) => row.method !== "GET")
        .every((row) => row.path === `v1/blocks/${code}`),
    )
    assert.equal(f.requests.filter((row) => row.path === pagePath).length, 4)
  })
}

const refused = [
  ["changed relative filename", { actualLink: "https://OTHER.md" }],
  ["changed relative filename case", { actualLink: "https://references.md" }],
  ["added query", { actualLink: "https://REFERENCES.md?download=1" }],
  ["added fragment", { actualLink: "https://REFERENCES.md#section" }],
  ["foreign path", { actualLink: "https://example.test/REFERENCES.md" }],
  ["foreign host suffix", { actualLink: "https://REFERENCES.md.example.test" }],
  [
    "changed explicit filename URL",
    { targetLink: "http://REFERENCES.md", actualLink: "https://REFERENCES.md" },
  ],
  ["changed external URL", { actualSourceLink: "https://example.test/changed?q=1#section" }],
  ["changed external query", { actualSourceLink: "https://example.test/source?q=2#section" }],
  ["changed external fragment", { actualSourceLink: "https://example.test/source?q=1#other" }],
  ["changed link label", { label: "different guide" }],
  ["changed code content", { changedCode: true }],
  ["foreign code parent", { foreignBlock: true }],
  ["duplicate physical root", { duplicateBlock: true }],
  ["revision changed during bracket", { revisionDuringRead: true }],
  ["invalid final cursor", { invalidCursor: true }],
]
for (const [label, options] of refused) {
  test(`the finite repair refuses ${label} before a field write`, async () => {
    const f = fixture(options),
      result = await f.run(restore)
    assert.equal(result._tag, "Failure")
    assert.equal(f.fieldBodies.length, 0)
    assert.equal(canonical(f.receipt), f.savedReceipt)
  })
}

for (const sideEffect of ["caption", "metadata"]) {
  test(`the finite repair rejects an unrelated ${sideEffect} side effect after readback`, async () => {
    const f = fixture({ sideEffect }),
      result = await f.run(restore)
    assert.equal(result._tag, "Failure")
    assert.equal(result.failure.code, "WRITE_CONFLICT")
    assert.deepEqual(f.fieldBodies, [{ code: { language: "plain text" } }])
    assert.equal(canonical(f.receipt), f.savedReceipt)
  })
}
