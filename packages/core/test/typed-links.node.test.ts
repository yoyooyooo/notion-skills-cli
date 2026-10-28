import { expect, test } from "@effect/vitest"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import type { Notion } from "../src/notion.ts"
import {
  hasTypedLinks,
  mapMarkdownLinks,
  materializeTypedLinks,
  readLinkBlocks,
  restoreTypedLinks,
} from "../src/typed-links.ts"

const receipt = JSON.parse(
  readFileSync(new URL("./fixtures/typed-link-transport.json", import.meta.url), "utf8"),
) as {
  page_id: string
  markdown_request: string
  markdown_readback: string
  block: Block
}
type Block = Record<string, any>
const page = receipt.page_id
const target = "3fc5636c236e81d7bbfefb6082c1ce7d"
const other = "3fc5636c236e81d7bbfefb6082c1ce7e"
const plain = `https://app.notion.com/p/${target}`
const typed = (path: string, id = target) =>
  `https://www.notion.so/${id}#ntn-skills-path=${encodeURIComponent(path)}`
const text = (url: string, content = "link") => ({
  type: "text",
  text: { content, link: { url } },
  plain_text: content,
  href: url,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const paragraph = (id: string, urls: string[]): Block => ({
  object: "block",
  id,
  type: "paragraph",
  has_children: false,
  paragraph: {
    color: "default",
    rich_text: urls.flatMap((url, index) => [
      ...(index
        ? [{ type: "text", text: { content: " | ", link: null }, plain_text: " | ", href: null }]
        : []),
      text(url),
    ]),
  },
})
const italicCodeParagraph = (id: string, before: string, code: string, after: string): Block => ({
  object: "block",
  id,
  type: "paragraph",
  has_children: false,
  paragraph: {
    rich_text: [before, code, after].map((content, index) => ({
      ...text("", content),
      text: { content, link: null },
      href: null,
      annotations: { ...text("", content).annotations, italic: true, code: index === 1 },
    })),
  },
})
const inventory = (results: Block[], next_cursor: string | null = null) => ({
  object: "list",
  type: "block",
  block: {},
  results,
  has_more: next_cursor !== null,
  next_cursor,
})

// Only explicit official endpoints are implemented. Markdown is never rewritten by
// the transport double: the reader receives the stripped document independently.
function transport(initial: Block[]) {
  const blocks = structuredClone(initial)
  const calls: { path: string; body: unknown; options: unknown }[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.sync(() => {
        calls.push({ path, body: structuredClone(body), options })
        if (
          path === `v1/blocks/${page}/children?page_size=100` &&
          body === undefined &&
          options === undefined
        )
          return structuredClone(inventory(blocks))
        const block = blocks.find((item) => path === `v1/blocks/${item.id}`)
        if (!block) throw new Error(`Unexpected endpoint ${path}`)
        if (options?.method === "PATCH") {
          expect(Object.keys(body as object)).toEqual([block.type])
          const payload = (body as Block)[block.type]
          expect(Object.keys(payload)).toEqual([block.type === "table_row" ? "cells" : "rich_text"])
          for (const value of payload.rich_text ?? payload.cells.flat()) {
            expect(Object.keys(value).sort()).toEqual(
              ["annotations", "text", "type"]
                .filter((key) => key !== "annotations" || value.annotations !== undefined)
                .sort(),
            )
            expect(value).not.toHaveProperty("href")
            expect(value).not.toHaveProperty("plain_text")
          }
          block[block.type] = { ...block[block.type], ...structuredClone(payload) }
        } else {
          expect(body).toBeUndefined()
          expect(options).toBeUndefined()
        }
        return structuredClone(block)
      }),
  }
  return { api, calls, blocks }
}
const destinations = (markdown: string) => {
  const urls: string[] = []
  mapMarkdownLinks(markdown, (url) => {
    urls.push(url)
    return url
  })
  return urls
}

test("actual Markdown receipt loses typed fragments while raw block receipt preserves exact destinations", () => {
  expect(hasTypedLinks(receipt.markdown_request)).toBe(true)
  expect(hasTypedLinks(receipt.markdown_readback)).toBe(false)
  expect(destinations(receipt.markdown_readback)).toEqual([plain, plain, plain, plain])
  const rich = receipt.block.bulleted_list_item.rich_text
  expect([rich[0].text.link.url, rich[2].text.link.url]).toEqual([
    typed("SKILL.md"),
    typed("assets/data.txt"),
  ])
  expect(rich[0].href).toBe(rich[0].text.link.url)
  expect(rich[2].href).toBe(rich[2].text.link.url)
})

test("fresh reader materializes distinct same-page paths from the actual rich-text receipt", async () => {
  const remote = transport([receipt.block])
  const stripped = `[Block frag A](${plain}) | [Block frag B](${plain})`
  expect(await Effect.runPromise(materializeTypedLinks(page, stripped, remote.api))).toBe(
    `[Block frag A](${typed("SKILL.md")}) | [Block frag B](${typed("assets/data.txt")})`,
  )
  expect(remote.calls).toEqual([
    { path: `v1/blocks/${page}/children?page_size=100`, body: undefined, options: undefined },
  ])
})

for (const changed of [undefined, "code", "prose"] as const) {
  test(`reader checks the rationale italic-code readback against complete rich text ${changed ?? "before materializing links"}`, async () => {
    const before = "Cite the principle behind each decision (e.g., "
    const code = "per boundary-discipline"
    const after = "). Don't restate it."
    const remote = transport([
      italicCodeParagraph(
        "rationale-shape",
        before,
        changed === "code" ? "foreign-principle" : code,
        changed === "prose" ? "). Restate it." : after,
      ),
      paragraph("rationale-link", [typed("SKILL.md")]),
    ])
    const readback = `*${before}**\`${code}\`**${after}*\n\n[link](${plain})`
    const result = await Effect.runPromise(
      materializeTypedLinks(page, readback, remote.api).pipe(Effect.result),
    )
    expect(
      remote.calls.every((call) => call.body === undefined && call.options === undefined),
    ).toBe(true)
    if (changed) {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
      return
    }
    expect(result._tag).toBe("Success")
    if (result._tag === "Success")
      expect(result.success).toBe(readback.replace(plain, typed("SKILL.md")))
  })
}

test("writer cannot use readback emphasis repair to erase authored literal stars", async () => {
  const remote = transport([
    italicCodeParagraph("authored-stars", "Use ", "code", "."),
    paragraph("authored-link", [plain]),
  ])
  const authored = `*Use **\`code\`**.*\n\n[link](${typed("SKILL.md")})`
  const result = await Effect.runPromise(
    restoreTypedLinks(page, authored, remote.api).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
  expect(remote.calls.every((call) => call.body === undefined && call.options === undefined)).toBe(
    true,
  )
})

test("preloaded traversal restores typed links without another block request", async () => {
  const remote = transport([receipt.block])
  const blocks = await Effect.runPromise(readLinkBlocks(page, remote.api))
  const stripped = `[Block frag A](${plain}) | [Block frag B](${plain})`
  expect(await Effect.runPromise(materializeTypedLinks(page, stripped, remote.api, blocks))).toBe(
    `[Block frag A](${typed("SKILL.md")}) | [Block frag B](${typed("assets/data.txt")})`,
  )
  expect(remote.calls).toHaveLength(1)
  expect(await Effect.runPromise(materializeTypedLinks(page, stripped, remote.api, []))).toBe(
    stripped,
  )
  expect(remote.calls).toHaveLength(1)
})

test("writer accepts raw API metadata and PATCHes only writable rich text through the block endpoint", async () => {
  const strippedBlock = structuredClone(receipt.block)
  for (const value of strippedBlock.bulleted_list_item.rich_text) {
    if (!value.text.link) continue
    value.text.link.url = plain
    value.href = plain
  }
  const remote = transport([strippedBlock])
  await Effect.runPromise(
    restoreTypedLinks(
      page,
      `[Block frag A](${typed("SKILL.md")}) | [Block frag B](${typed("assets/data.txt")})`,
      remote.api,
    ),
  )
  const rich = receipt.block.bulleted_list_item.rich_text
  expect(remote.calls).toEqual([
    { path: `v1/blocks/${page}/children?page_size=100`, body: undefined, options: undefined },
    { path: `v1/blocks/${receipt.block.id}`, body: undefined, options: undefined },
    {
      path: `v1/blocks/${receipt.block.id}`,
      options: { method: "PATCH" },
      body: {
        bulleted_list_item: {
          rich_text: rich.map((value: Block) => ({
            type: value.type,
            text: value.text,
            annotations: value.annotations,
          })),
        },
      },
    },
    { path: `v1/blocks/${page}/children?page_size=100`, body: undefined, options: undefined },
  ])
})

test("same-page links with mismatched visible context reject before repair", async () => {
  const remote = transport([receipt.block])
  const failure = await Effect.runPromise(
    restoreTypedLinks(
      page,
      `[Block frag B](${typed("SKILL.md")}) | [Block frag A](${typed("assets/data.txt")})`,
      remote.api,
    ).pipe(Effect.result),
  )
  expect(failure._tag).toBe("Failure")
  if (failure._tag === "Failure") expect(failure.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
  expect(remote.calls.every((call) => call.body === undefined && call.options === undefined)).toBe(
    true,
  )
})

test("writer repairs exact block URLs and fresh reader recovers Unicode and percent paths from stripped Markdown", async () => {
  const paths = ["SKILL.md", "assets/data.txt", "assets/中文 空格.txt", "assets/100%25.txt"]
  const intended = paths.map((path) => `[link](${typed(path)})`).join(" | ")
  const stripped = paths.map(() => `[link](${plain})`).join(" | ")
  const remote = transport([
    paragraph(
      "owned-block",
      paths.map(() => plain),
    ),
  ])
  await Effect.runPromise(restoreTypedLinks(page, intended, remote.api))
  const annotations = text(plain).annotations
  expect(
    remote.calls.filter(
      (call) => (call.options as { method?: string } | undefined)?.method === "PATCH",
    ),
  ).toEqual([
    {
      path: "v1/blocks/owned-block",
      options: { method: "PATCH" },
      body: {
        paragraph: {
          rich_text: paths.flatMap((path, index) => [
            ...(index ? [{ type: "text", text: { content: " | ", link: null } }] : []),
            { type: "text", text: { content: "link", link: { url: typed(path) } }, annotations },
          ]),
        },
      },
    },
  ])
  // New service and cloned inventory prove reconstruction has no writer-local cache.
  const fresh = transport(remote.blocks)
  expect(await Effect.runPromise(materializeTypedLinks(page, stripped, fresh.api))).toBe(intended)
  expect(fresh.calls.every((call) => call.options === undefined)).toBe(true)
})

test("ordinary HTTPS destinations and typed-looking code examples do not become typed links", async () => {
  const external = "https://example.com/manual#ntn-skills-path=SKILL.md"
  const code = `[example](${typed("assets/example.txt")})`
  const markdown = `[external](${external})\n\`${code}\`\n\n\`\`\`md\n${code}\n\`\`\`\n~~~md\n${code}\n~~~`
  expect(hasTypedLinks(markdown)).toBe(false)
  expect(destinations(markdown)).toEqual([external])
  expect(mapMarkdownLinks(markdown, (url) => `${url}&seen=1`)).toBe(
    markdown.replace(external, `${external}&seen=1`),
  )
  const remote = transport([paragraph("external", [external])])
  await Effect.runPromise(restoreTypedLinks(page, markdown, remote.api))
  expect(remote.calls).toEqual([])
  expect(await Effect.runPromise(materializeTypedLinks(page, markdown, remote.api))).toBe(markdown)
})

test("reader and writer ignore inline-code rich text and fenced code blocks in correspondence", async () => {
  const codeUrl = typed("assets/code.txt")
  const inline = {
    ...text(codeUrl, `[example](${codeUrl})`),
    text: { content: `[example](${codeUrl})`, link: null },
    href: null,
    annotations: { ...text(codeUrl).annotations, code: true },
  }
  const block = paragraph("owned", [plain])
  block.paragraph.rich_text.unshift(inline)
  const remote = transport([
    block,
    {
      id: "code",
      type: "code",
      has_children: false,
      code: { rich_text: [text(codeUrl)], language: "markdown" },
    },
  ])
  const example = `\`[example](${codeUrl})\`\n\`\`\`md\n[example](${codeUrl})\n\`\`\`\n`
  const intended = `${example}[link](${typed("SKILL.md")})`
  await Effect.runPromise(restoreTypedLinks(page, intended, remote.api))
  const fresh = transport(remote.blocks)
  expect(
    await Effect.runPromise(materializeTypedLinks(page, `${example}[link](${plain})`, fresh.api)),
  ).toBe(intended)
  expect(remote.blocks[0]!.paragraph.rich_text[0]).toMatchObject({
    text: inline.text,
    annotations: inline.annotations,
  })
})

test("a Notion br inside inline code corresponds to the authored newline", async () => {
  const code = {
    ...text("", "side<br>extent"),
    text: { content: "side<br>extent", link: null },
    href: null,
  }
  code.annotations.code = true
  const block = paragraph("owned", [plain])
  block.paragraph.rich_text.unshift(code)
  const remote = transport([block])
  const intended = `\`side\nextent\` [link](${typed("SKILL.md")})`
  await Effect.runPromise(restoreTypedLinks(page, intended, remote.api))
  expect(remote.blocks[0]!.paragraph.rich_text[1]!.text.link.url).toBe(typed("SKILL.md"))
})

test("a br tag inside read-back inline code matches the block text", async () => {
  const code = {
    ...text("", "side<br>extent"),
    text: { content: "side<br>extent", link: null },
    href: null,
  }
  code.annotations.code = true
  const block = paragraph("owned", [typed("SKILL.md")])
  block.paragraph.rich_text.unshift(code)
  const remote = transport([block])
  const readback = `\`side<br>extent\` [link](${plain})`
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toBe(`\`side<br>extent\` [link](${typed("SKILL.md")})`)
})

test("reader keeps escaped details text and drops a real details wrapper", async () => {
  const paragraphText = (id: string, content: string): Block => ({
    object: "block",
    id,
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [{ type: "text", text: { content, link: null }, plain_text: content, href: null }],
      color: "default",
    },
  })
  const item: Block = {
    object: "block",
    id: "claim",
    type: "numbered_list_item",
    has_children: false,
    numbered_list_item: {
      rich_text: [
        {
          type: "text",
          text: { content: "deliver proves it.", link: null },
          plain_text: "deliver proves it.",
          href: null,
        },
      ],
      color: "default",
    },
  }
  const link: Block = {
    object: "block",
    id: "after-details",
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [text(typed("SKILL.md"), "workers")], color: "default" },
  }
  const remote = transport([
    paragraphText("before", "验收通过。"),
    paragraphText("literal", "</details>"),
    paragraphText("claims", "The delivery interface exposes four separate claims:"),
    item,
    link,
  ])
  const readback = [
    "验收通过。",
    "\\</details\\>",
    "The delivery interface exposes four separate claims:",
    "1. deliver proves it.",
    "</details>",
    `[workers](${plain})`,
  ].join("\n")
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toContain(typed("SKILL.md"))
  expect(result).toContain("\\</details\\>")
})

test("details tags kept in block text still correspond to the authored wrapper", async () => {
  const paragraphText = (id: string, content: string): Block => ({
    object: "block",
    id,
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [{ type: "text", text: { content, link: null }, plain_text: content, href: null }],
      color: "default",
    },
  })
  const link: Block = {
    object: "block",
    id: "after-wrapper",
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [text(typed("SKILL.md"), "workers")], color: "default" },
  }
  const remote = transport([
    paragraphText("wrapped", "<details><summary>中文说明</summary>正文</details>"),
    link,
  ])
  const readback = [
    "<details>",
    "<summary>中文说明</summary>",
    "正文",
    "</details>",
    `[workers](${plain})`,
  ].join("\n")
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toContain(typed("SKILL.md"))
})

for (const scenario of ["count", "order"] as const) {
  test(`mismatched ${scenario} rejects reader and writer before any mutation`, async () => {
    const intended = `[link](${typed("SKILL.md")}) | [link](${typed("assets/data.txt", other)})`
    const remote = transport([
      paragraph(
        "owned",
        scenario === "count" ? [plain] : [`https://app.notion.com/p/${other}`, plain],
      ),
    ])
    const failure = await Effect.runPromise(
      restoreTypedLinks(page, intended, remote.api).pipe(Effect.result),
    )
    expect(failure._tag).toBe("Failure")
    if (failure._tag === "Failure") expect(failure.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
    expect(
      remote.calls.every((call) => call.body === undefined && call.options === undefined),
    ).toBe(true)
    const saved = transport([
      paragraph(
        "owned",
        scenario === "count"
          ? [typed("SKILL.md")]
          : [typed("assets/data.txt", other), typed("SKILL.md")],
      ),
    ])
    const result = await Effect.runPromise(
      materializeTypedLinks(page, intended, saved.api).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
  })
}

test("inventory follows pagination and nested owned blocks without crossing child-page permission boundaries", async () => {
  const calls: string[] = []
  const nested = { id: "toggle", type: "toggle", has_children: true, toggle: { rich_text: [] } }
  const child = {
    id: "private-child",
    type: "child_page",
    has_children: true,
    child_page: { title: "separate permission boundary" },
  }
  const database = {
    id: "private-database",
    type: "child_database",
    has_children: true,
    child_database: { title: "separate database" },
  }
  const leaf = paragraph("nested-link", [typed("SKILL.md")])
  const last = paragraph("last-link", [typed("assets/data.txt")])
  const responses: Record<
    string,
    {
      object: string
      type: string
      block: object
      results: Block[]
      has_more: boolean
      next_cursor: string | null
    }
  > = {
    [`v1/blocks/${page}/children?page_size=100`]: inventory([nested, child, database], "cursor /+"),
    "v1/blocks/toggle/children?page_size=100": inventory([leaf]),
    [`v1/blocks/${page}/children?page_size=100&start_cursor=cursor%20%2F%2B`]: inventory([last]),
  }
  const api: Notion["Service"] = {
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.sync(() => {
        calls.push(path)
        expect(body).toBeUndefined()
        expect(options).toBeUndefined()
        const response = responses[path]
        if (!response) throw new Error(`Crossed boundary or used unexpected endpoint: ${path}`)
        return structuredClone(response)
      }),
  }
  expect((await Effect.runPromise(readLinkBlocks(page, api))).map((block) => block.id)).toEqual([
    "toggle",
    "nested-link",
    "private-child",
    "private-database",
    "last-link",
  ])
  expect(calls).toEqual(Object.keys(responses))
  expect(
    await Effect.runPromise(materializeTypedLinks(page, `[link](${plain})\n[link](${plain})`, api)),
  ).toBe(`[link](${typed("SKILL.md")})\n[link](${typed("assets/data.txt")})`)
})

test("reader ignores Notion bold boundaries around inline code when materializing typed links", async () => {
  const sentence = "extends vs implements "
  const block: Block = {
    object: "block",
    id: "bold-boundary",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: sentence, link: null },
          plain_text: sentence,
          href: null,
        },
        text(typed("SKILL.md"), "workers"),
      ],
    },
  }
  const remote = transport([block])
  const readback = `**\`extends\`**** vs ****\`implements\`** [workers](${plain})`
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toBe(`**\`extends\` vs \`implements\`** [workers](${typed("SKILL.md")})`)
  expect(result).not.toContain("****")
})

test("reader keeps literal asterisk runs inside fences and inline code", async () => {
  const sentence = "literal **** stays "
  const block: Block = {
    object: "block",
    id: "literal-stars",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: sentence, link: null },
          plain_text: sentence,
          href: null,
        },
        text(typed("SKILL.md"), "workers"),
      ],
    },
  }
  const remote = transport([block])
  const readback = [
    "```",
    "keep **** inside",
    "```",
    `literal \`****\` stays [workers](${plain})`,
  ].join("\n")
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toBe(
    [
      "```",
      "keep **** inside",
      "```",
      `literal \`****\` stays [workers](${typed("SKILL.md")})`,
    ].join("\n"),
  )
})

test("reader keeps asterisks inside a longer inline code span", async () => {
  const sentence = "a`****`b "
  const block: Block = {
    object: "block",
    id: "nested-ticks",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: sentence, link: null },
          plain_text: sentence,
          href: null,
        },
        text(typed("SKILL.md"), "workers"),
      ],
    },
  }
  const remote = transport([block])
  const readback = `\`\`a\`****\`b\`\` [workers](${plain})`
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toBe(`\`\`a\`****\`b\`\` [workers](${typed("SKILL.md")})`)
  expect(result).toContain("a`****`b")
})

test("reader ignores heading and list markers glued after HTML tables", async () => {
  const row = (id: string, values: string[]): Block => ({
    object: "block",
    id,
    type: "table_row",
    has_children: false,
    table_row: {
      cells: values.map((content) => [
        { type: "text", text: { content, link: null }, plain_text: content, href: null },
      ]),
    },
  })
  const heading = (id: string, type: "heading_2" | "heading_3", content: string): Block => ({
    object: "block",
    id,
    type,
    has_children: false,
    [type]: {
      rich_text: [{ type: "text", text: { content, link: null }, plain_text: content, href: null }],
      is_toggleable: false,
      color: "default",
    },
  })
  const item: Block = {
    object: "block",
    id: "after-table-item",
    type: "bulleted_list_item",
    has_children: false,
    bulleted_list_item: {
      rich_text: [
        { type: "text", text: { content: "item ", link: null }, plain_text: "item ", href: null },
        text(typed("SKILL.md"), "workers"),
      ],
      color: "default",
    },
  }
  const blocks = [
    row("row-1", ["A", "B"]),
    heading("later", "heading_2", "Later"),
    item,
    row("row-2", ["C"]),
    heading("tail", "heading_3", "Tail"),
  ]
  const plainText = JSON.stringify(blocks)
  expect(plainText).not.toContain("##")
  expect(plainText).not.toContain("- item")
  const remote = transport(blocks)
  const readback = [
    '<table header-row="true">',
    "<tr><td>A</td><td>B</td></tr>",
    "</table>## Later",
    `- item [workers](${plain})`,
    "<table>",
    "<tr><td>C</td></tr>",
    "</table>### Tail",
  ].join("\n")
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toBe(
    [
      '<table header-row="true">',
      "<tr><td>A</td><td>B</td></tr>",
      "</table>## Later",
      `- item [workers](${typed("SKILL.md")})`,
      "<table>",
      "<tr><td>C</td></tr>",
      "</table>### Tail",
    ].join("\n"),
  )
  expect(result).toContain("#ntn-skills-path=")
})

test("reader keeps comparison operators inside an HTML table cell", async () => {
  const row = (id: string, values: string[]): Block => ({
    object: "block",
    id,
    type: "table_row",
    has_children: false,
    table_row: {
      cells: values.map((content) => [
        { type: "text", text: { content, link: null }, plain_text: content, href: null },
      ]),
    },
  })
  const item: Block = {
    object: "block",
    id: "after-comparison",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [text(typed("SKILL.md"), "workers")],
      color: "default",
    },
  }
  const remote = transport([row("comparison", ["F[1] < sy"]), item])
  const readback = [
    "<table>",
    "<tr><td>`F[1] < sy`</td></tr>",
    "</table>",
    `[workers](${plain})`,
  ].join("\n")
  const result = await Effect.runPromise(materializeTypedLinks(page, readback, remote.api))
  expect(result).toContain(typed("SKILL.md"))
  expect(result).toContain("`F[1] < sy`")
})
