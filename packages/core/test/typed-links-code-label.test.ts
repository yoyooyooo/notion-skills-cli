import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import { mapMarkdownLinks, materializeTypedLinks, restoreTypedLinks } from "../src/typed-links.ts"
import { Notion as NotionService } from "../src/notion.ts"
import { verifyPublicationRead } from "../src/publication-integrity.ts"
import type { Snapshot } from "../src/model.ts"
import * as NodeServices from "@effect/platform-node/NodeServices"

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`
const page = id(1),
  table = id(2),
  header = id(3),
  codeRow = id(4),
  workflowRow = id(5)
const example = id(6),
  fence = id(7),
  exportPage = id(8),
  workflowPage = id(9)
const url = (pageId: string) => `https://app.notion.com/p/${pageId.replaceAll("-", "")}`
const exportUrl = url(exportPage),
  workflowUrl = url(workflowPage)
const typed = `${workflowUrl}#ntn-skills-path=references%2Fworkflow.md&heading=Editing`
const typedCode = `${exportUrl}#ntn-skills-path=references%2Fexport.md&heading=Output`
const external = "https://example.test/docs?q=exact#section"
const rich = (content: string, link?: string, code = false) => ({
  type: "text",
  text: { content, link: link ? { url: link } : null },
  plain_text: content,
  href: link ?? null,
  annotations: {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code,
    color: "default",
  },
})
const block = (
  blockId: string,
  type: string,
  owner: string,
  hasChildren: boolean,
  body: unknown,
) => ({
  id: blockId,
  type,
  parent:
    owner === page ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  has_children: hasChildren,
  archived: false,
  in_trash: false,
  [type]: body,
})

function fixture(codeDestination = exportUrl) {
  const blocks: Record<string, unknown>[] = [
    block(table, "table", page, true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
    block(header, "table_row", table, false, { cells: [[rich("Name")], [rich("Command")]] }),
    block(codeRow, "table_row", table, false, {
      cells: [[rich("Export")], [rich("+export", exportUrl, true)]],
    }),
    block(workflowRow, "table_row", table, false, {
      cells: [[rich("Edit")], [rich("Workflow", workflowUrl)]],
    }),
    block(example, "paragraph", page, false, {
      rich_text: [
        rich("Example "),
        rich(workflowUrl, undefined, true),
        rich(" and "),
        rich("external", external),
      ],
    }),
    block(fence, "code", page, false, {
      rich_text: [rich(`[example](${typed})`)],
      language: "markdown",
      caption: [],
    }),
  ]
  const markdown = [
    "| Name | Command |",
    "| --- | --- |",
    `| Export | [\`+export\`](${codeDestination}) |`,
    `| Edit | [Workflow](${typed}) |`,
    "",
    `Example \`${workflowUrl}\` and [external](${external})`,
    "",
    "```markdown",
    `[example](${typed})`,
    "```",
    "",
  ].join("\n")
  const writes: Array<{ path: string; body: unknown }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        if (options?.file) return yield* Effect.fail(fail("UNEXPECTED", "No fixture file requests"))
        const children = /^v1\/blocks\/([^/]+)\/children\?page_size=100$/.exec(path)
        if (children && body === undefined && (!options?.method || options.method === "GET")) {
          const results = blocks.filter((entry) => {
            const parent = property(entry.parent)
            return parent.page_id === children[1] || parent.block_id === children[1]
          })
          return {
            object: "list",
            results: structuredClone(results),
            has_more: false,
            next_cursor: null,
          }
        }
        const found = blocks.find((entry) => path === `v1/blocks/${entry.id}`)
        if (!found)
          return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture path", { path }))
        if (options?.method === "PATCH") {
          const field = String(found.type),
            supplied = property(property(body)[field])
          if (field !== "table_row" || !Array.isArray(supplied.cells))
            return yield* Effect.fail(
              fail("UNEXPECTED", "Only captured table cell links may change"),
            )
          writes.push({ path, body: structuredClone(body) })
          found[field] = {
            ...property(found[field]),
            cells: supplied.cells.map((cell) => {
              if (!Array.isArray(cell)) throw new Error("Invalid fixture cell")
              return cell.map((value) => {
                const span = property(value),
                  text = property(span.text)
                return { ...span, plain_text: text.content, href: property(text.link).url ?? null }
              })
            }),
          }
        } else if (body !== undefined || (options?.method && options.method !== "GET"))
          return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture mutation"))
        return structuredClone(found)
      }),
  }
  const span = (blockId: string) => {
    const cells = property(blocks.find((entry) => entry.id === blockId)?.table_row).cells
    if (!Array.isArray(cells) || !Array.isArray(cells[1])) throw new Error("Expected fixture cell")
    return property(cells[1][0])
  }
  return { api, blocks, markdown, writes, span }
}

test("explicit code-label links count in complete correspondence while only typed destinations change", async () => {
  const f = fixture(),
    beforeCode = structuredClone(f.span(codeRow)),
    beforeExamples = structuredClone(f.blocks.slice(-2))
  await Effect.runPromise(restoreTypedLinks(page, f.markdown, f.api))
  expect(f.writes.map((entry) => entry.path)).toEqual([`v1/blocks/${workflowRow}`])
  expect(f.span(codeRow)).toEqual(beforeCode)
  expect(property(f.span(workflowRow).text).link).toEqual({ url: typed })
  expect(f.blocks.slice(-2)).toEqual(beforeExamples)
  await Effect.runPromise(restoreTypedLinks(page, f.markdown, f.api))
  expect(f.writes).toHaveLength(1)
})

test("a typed explicit code-label link retains its exact fragment and code annotation", async () => {
  const f = fixture(typedCode)
  await Effect.runPromise(restoreTypedLinks(page, f.markdown, f.api))
  expect(f.writes.map((entry) => entry.path)).toEqual([
    `v1/blocks/${codeRow}`,
    `v1/blocks/${workflowRow}`,
  ])
  expect(property(f.span(codeRow).text).link).toEqual({ url: typedCode })
  expect(property(f.span(codeRow).annotations).code).toBe(true)
  const readback = mapMarkdownLinks(f.markdown, (value) =>
    value === typedCode ? exportUrl : value === typed ? workflowUrl : value,
  )
  const restored = await Effect.runPromise(materializeTypedLinks(page, readback, f.api, f.blocks))
  expect(restored).toBe(f.markdown)
  expect(restored).toContain(`[external](${external})`)
})

for (const change of [
  "unlinked-code",
  "wrong-page",
  "changed-label",
  "extra-example-link",
] as const) {
  test(`code-label correspondence refuses ${change} before writing`, async () => {
    const f = fixture(),
      span = f.span(codeRow)
    if (change === "unlinked-code") {
      span.text = { ...property(span.text), link: null }
      span.href = null
    } else if (change === "wrong-page") {
      span.text = { ...property(span.text), link: { url: url(id(99)) } }
      span.href = url(id(99))
    } else if (change === "changed-label") {
      span.text = { ...property(span.text), content: "+changed" }
      span.plain_text = "+changed"
    } else {
      const examples = property(f.blocks.find((entry) => entry.id === example)?.paragraph).rich_text
      if (!Array.isArray(examples)) throw new Error("Expected example rich text")
      examples[1] = rich(workflowUrl, workflowUrl, true)
    }
    const before = JSON.stringify(f.blocks)
    const result = await Effect.runPromise(
      restoreTypedLinks(page, f.markdown, f.api).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(f.writes).toEqual([])
    expect(JSON.stringify(f.blocks)).toBe(before)
  })
}

test("link scanning keeps ordinary inline-code and complete fenced examples outside the destination list", () => {
  const f = fixture(),
    destinations: string[] = []
  expect(
    mapMarkdownLinks(f.markdown, (value) => {
      destinations.push(value)
      return value
    }),
  ).toBe(f.markdown)
  expect(destinations).toEqual([exportUrl, typed, external])
})

test("fresh readback joins one typed link split at a code annotation boundary", async () => {
  const blocks = [
    block(example, "paragraph", page, false, {
      rich_text: [rich("+message", typed, true), rich(" 字段说明", typed)],
    }),
  ]
  const api = fixture().api
  const saved = await Effect.runPromise(
    materializeTypedLinks(
      page,
      `[\`+message\`](${workflowUrl})[ 字段说明](${workflowUrl})`,
      api,
      blocks,
    ),
  )
  expect(saved).toBe(`[\`+message\` 字段说明](${typed})`)
})

for (const change of [
  "changed-label",
  "changed-page",
  "distinct-fragments",
  "separated-links",
] as const) {
  test(`split-link readback preserves ambiguity for ${change}`, async () => {
    const blocks = [
      block(example, "paragraph", page, false, {
        rich_text: [
          rich("+message", typed, true),
          rich(" 字段说明", change === "distinct-fragments" ? typedCode : typed),
        ],
      }),
    ]
    const secondUrl = change === "changed-page" ? exportUrl : workflowUrl
    const separator = change === "separated-links" ? " " : ""
    const label = change === "changed-label" ? " 已改说明" : " 字段说明"
    const result = await Effect.runPromise(
      materializeTypedLinks(
        page,
        `[\`+message\`](${workflowUrl})${separator}[${label}](${secondUrl})`,
        fixture().api,
        blocks,
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("TYPED_LINK_AMBIGUOUS")
  })
}

test("valid distinct adjacent typed links retain separate destinations and code examples", async () => {
  const blocks = [
    block(example, "paragraph", page, false, {
      rich_text: [rich("+message", typed, true), rich(" 字段说明", typedCode)],
    }),
    block(fence, "code", page, false, {
      rich_text: [rich(`[x](${workflowUrl})[y](${workflowUrl})`)],
    }),
  ]
  const markdown = `[\`+message\`](${workflowUrl})[ 字段说明](${exportUrl})\n\n\`\`\`md\n[x](${workflowUrl})[y](${workflowUrl})\n\`\`\``
  const saved = await Effect.runPromise(
    materializeTypedLinks(page, markdown, fixture().api, blocks),
  )
  expect(saved).toBe(
    `[\`+message\`](${typed})[ 字段说明](${typedCode})\n\n\`\`\`md\n[x](${workflowUrl})[y](${workflowUrl})\n\`\`\``,
  )
})

test("publication stability compares the same typed-link view and still detects reference edits", async () => {
  const blocks = [
    block(example, "paragraph", page, false, {
      rich_text: [rich("+message", typed, true), rich(" 字段说明", typed)],
    }),
  ]
  const before = { id: id(100), properties: {}, last_edited_time: "same" }
  const snapshot: Snapshot = {
    snapshot_id: "s_split",
    scope: "test",
    version_id: "v",
    created_at: 0,
    entrypoint: "SKILL.md",
    files: [],
    record: {
      id: `notion_page:${id(100)}`,
      kind: "skill",
      name: "Test",
      alias: "test",
      description: "Test read.",
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${id(100)}/SKILL.md`,
      locator: { type: "notion_page", page_id: id(100), database_id: "db", data_source_id: "ds" },
    },
    references: [
      { id: id(100), path: "SKILL.md", markdown: "Main" },
      { id: page, path: "references/guide.md", markdown: `[\`+message\` 字段说明](${typed})` },
    ],
  }
  for (const changed of [false, true]) {
    const api: Notion["Service"] = {
      version: Effect.succeed("fixture"),
      credentialIdentity: Effect.succeed("fixture"),
      request: (path, body, options) =>
        Effect.gen(function* () {
          if (body !== undefined || options?.method || options?.file)
            return yield* Effect.fail(fail("TEST_WRITE", "Read only"))
          if (path === `v1/pages/${id(100)}`) return before
          if (path === `v1/pages/${page}/markdown`)
            return {
              truncated: false,
              unknown_block_ids: [],
              markdown: `[\`+message\`](${workflowUrl})[ ${changed ? "已改" : "字段"}说明](${workflowUrl})`,
            }
          if (path === `v1/blocks/${page}/children?page_size=100`)
            return { results: blocks, has_more: false, next_cursor: null }
          return yield* Effect.fail(fail("TEST_PATH", "Unexpected path", { path }))
        }),
    }
    const result = await Effect.runPromise(
      verifyPublicationRead(before, snapshot).pipe(
        Effect.provideService(NotionService, api),
        Effect.provide(NodeServices.layer),
        Effect.result,
      ),
    )
    expect(result._tag).toBe(changed ? "Failure" : "Success")
    if (result._tag === "Success") expect(result.success).toBe("unmanaged")
  }
})
