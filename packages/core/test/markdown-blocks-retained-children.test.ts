import { expect, test } from "bun:test"
import { Effect } from "effect"
import { restoreMarkdownBlocks } from "../src/markdown-blocks.ts"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import {
  retainedChildTableComparison,
  retainedChildTableRootBlocks,
  retainedChildTableSource,
} from "../src/retained-child-table.ts"

const owner = "10000000-0000-0000-0000-000000000001"
const table = "10000000-0000-0000-0000-000000000002"
const childIds = ["10000000-0000-0000-0000-000000000005", "10000000-0000-0000-0000-000000000006"]
const authored = "| Rule | Value |\n| --- | --- |\n| Supervisor | `RunAtLoad` + `KeepAlive` |\n"
const tags = childIds.map(
  (id, index) =>
    `<page url="https://app.notion.com/p/${id.replaceAll("-", "")}">guide-${index}.md</page>`,
)
const submitted = authored + tags.join("\n")
const rich = (content: string) => [{ type: "text", text: { content } }]

function fixture(
  options: { changedCell?: boolean; missingRow?: boolean; badCursor?: boolean } = {},
) {
  const roots: Record<string, unknown>[] = [
    {
      id: table,
      type: "table",
      has_children: true,
      in_trash: false,
      parent: { type: "page_id", page_id: owner },
      table: { table_width: 2, has_column_header: true, has_row_header: false },
    },
    ...childIds.map((id, index) => ({
      id,
      type: "child_page",
      has_children: true,
      in_trash: false,
      parent: { type: "page_id", page_id: owner },
      child_page: { title: `guide-${index}.md` },
    })),
  ]
  const rows: Record<string, unknown>[] = [
    {
      id: "10000000-0000-0000-0000-000000000003",
      type: "table_row",
      table_row: { cells: [rich("Rule"), rich("Value")] },
    },
    {
      id: "10000000-0000-0000-0000-000000000004",
      type: "table_row",
      table_row: {
        cells: [
          rich("Supervisor"),
          rich(options.changedCell ? "RunAtLoad • KeepAlive" : "RunAtLoad + KeepAlive"),
        ],
      },
    },
  ]
  const writes: { path: string; body: unknown }[] = []
  const reads: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture"),
    request: (path, body, requestOptions) =>
      Effect.gen(function* () {
        if (requestOptions?.method === "PATCH") {
          if (path !== `v1/blocks/${rows[1]!.id}`)
            return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture mutation", { path }))
          writes.push({ path, body })
          rows[1] = { ...rows[1], table_row: property(body).table_row }
          return rows[1]
        }
        reads.push(path)
        if (path === `v1/blocks/${owner}/children?page_size=100`)
          return { results: roots.slice(0, 2), has_more: true, next_cursor: "next" }
        if (path === `v1/blocks/${owner}/children?page_size=100&start_cursor=next`)
          return {
            results: roots.slice(2),
            has_more: false,
            next_cursor: options.badCursor ? "unexpected" : null,
          }
        if (path === `v1/blocks/${table}/children?page_size=100`)
          return {
            results: options.missingRow ? rows.slice(0, 1) : rows,
            has_more: false,
            next_cursor: null,
          }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture read", { path }))
      }),
  }
  return { roots, rows, writes, reads, api }
}

test("terminal retained child pages do not become table rows after complete pagination", async () => {
  const f = fixture()
  const original = JSON.stringify({ submitted, roots: f.roots, rows: f.rows })
  expect(retainedChildTableSource(owner, submitted, f.roots)).toBe(authored)
  await Effect.runPromise(restoreMarkdownBlocks(owner, submitted, f.api))
  expect(f.reads).toContain(`v1/blocks/${owner}/children?page_size=100&start_cursor=next`)
  expect(f.reads).toContain(`v1/blocks/${table}/children?page_size=100`)
  expect(f.writes).toEqual([])
  expect(JSON.stringify({ submitted, roots: f.roots, rows: f.rows })).toBe(original)
})

test("the comparison view keeps every retained tag and changes only its table boundary", () => {
  const f = fixture(),
    before = JSON.stringify(f.roots)
  expect(retainedChildTableComparison(owner, submitted, f.roots)).toBe(
    authored + "\n" + tags.join("\n"),
  )
  expect(
    retainedChildTableComparison(owner, authored + "\n" + tags.join("\n"), f.roots),
  ).toBeUndefined()
  expect(JSON.stringify(f.roots)).toBe(before)
})

test("retained-child comparison roots require their complete exact root pagination chain", () => {
  const f = fixture(),
    first = `v1/blocks/${owner}/children?page_size=100`
  const next = `${first}&start_cursor=next%20%2F%2B`,
    cursor = "next /+"
  const raw: Record<string, unknown> = {
    [first]: { object: "list", results: f.roots.slice(0, 1), has_more: true, next_cursor: cursor },
    [next]: { object: "list", results: f.roots.slice(1), has_more: false, next_cursor: null },
  }
  expect(retainedChildTableRootBlocks(owner, raw)).toEqual(f.roots)
  for (const change of [
    "missing-page",
    "repeated-cursor",
    "terminal-cursor",
    "wrong-envelope",
    "descendants-only",
  ] as const) {
    const changed = structuredClone(raw)
    if (change === "missing-page") delete changed[next]
    if (change === "repeated-cursor")
      changed[next] = { ...property(changed[next]), has_more: true, next_cursor: cursor }
    if (change === "terminal-cursor")
      changed[next] = { ...property(changed[next]), next_cursor: "contradiction" }
    if (change === "wrong-envelope")
      changed[first] = { ...property(changed[first]), object: "block" }
    if (change === "descendants-only") {
      changed[`v1/blocks/${table}/children?page_size=100`] = changed[first]
      delete changed[first]
    }
    expect(retainedChildTableRootBlocks(owner, changed)).toBeUndefined()
  }
})

test("retained child framing still restores a genuinely changed existing table cell", async () => {
  const f = fixture({ changedCell: true })
  const originalRoots = JSON.stringify(f.roots)
  await Effect.runPromise(restoreMarkdownBlocks(owner, submitted, f.api))
  expect(f.writes).toEqual([
    {
      path: "v1/blocks/10000000-0000-0000-0000-000000000004",
      body: {
        table_row: {
          cells: [
            [{ type: "text", text: { content: "Supervisor" }, annotations: {} }],
            [
              { type: "text", text: { content: "RunAtLoad" }, annotations: { code: true } },
              { type: "text", text: { content: " + " }, annotations: {} },
              { type: "text", text: { content: "KeepAlive" }, annotations: { code: true } },
            ],
          ],
        },
      },
    },
  ])
  expect(JSON.stringify(f.roots)).toBe(originalRoots)
})

test("a physically missing authored row still fails before any mutation", async () => {
  const f = fixture({ missingRow: true })
  const result = await Effect.runPromise(
    restoreMarkdownBlocks(owner, submitted, f.api).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
  expect(f.writes).toEqual([])
})

const invalid: readonly {
  name: string
  markdown?: string
  change?: (roots: Record<string, unknown>[]) => void
}[] = [
  {
    name: "foreign tag destination",
    markdown: submitted.replace(childIds[0]!.replaceAll("-", ""), "f".repeat(32)),
  },
  { name: "external host", markdown: submitted.replace("app.notion.com", "example.test") },
  { name: "missing preserved tag", markdown: authored + tags[0] },
  { name: "duplicate preserved tag", markdown: authored + [tags[0], tags[0]].join("\n") },
  { name: "different child title", markdown: submitted.replace("guide-0.md", "other.md") },
  { name: "reordered tags", markdown: authored + [...tags].reverse().join("\n") },
  {
    name: "foreign physical parent",
    change: (roots) => {
      roots[1]!.parent = { type: "page_id", page_id: childIds[1] }
    },
  },
  {
    name: "archived child",
    change: (roots) => {
      roots[1]!.archived = true
    },
  },
  {
    name: "extra root after children",
    change: (roots) => {
      roots.push({
        id: "10000000-0000-0000-0000-000000000007",
        type: "paragraph",
        has_children: false,
        parent: { type: "page_id", page_id: owner },
        paragraph: { rich_text: [] },
      })
    },
  },
]
for (const scenario of invalid) {
  test(`retained child table framing refuses ${scenario.name}`, async () => {
    const f = fixture()
    scenario.change?.(f.roots)
    const markdown = scenario.markdown ?? submitted
    expect(retainedChildTableSource(owner, markdown, f.roots)).toBeUndefined()
    expect(retainedChildTableComparison(owner, markdown, f.roots)).toBeUndefined()
    const original = JSON.stringify({ markdown, roots: f.roots, rows: f.rows })
    const result = await Effect.runPromise(
      restoreMarkdownBlocks(owner, markdown, f.api).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(f.writes).toEqual([])
    expect(JSON.stringify({ markdown, roots: f.roots, rows: f.rows })).toBe(original)
  })
}

test("page HTML inside code, a table cell or a quote is never removed", () => {
  const f = fixture()
  for (const markdown of [
    authored + "\n```html\n" + tags.join("\n"),
    authored + "\n```html\n" + tags.join("\n") + "\n```",
    authored + tags.map((tag) => `| Literal | \`${tag}\` |`).join("\n"),
    authored + tags.map((tag) => `> ${tag}`).join("\n"),
  ])
    expect(retainedChildTableSource(owner, markdown, f.roots)).toBeUndefined()
})

test("a contradictory final inventory cursor refuses before table restoration", async () => {
  const f = fixture({ badCursor: true })
  const result = await Effect.runPromise(
    restoreMarkdownBlocks(owner, submitted, f.api).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_RESPONSE")
  expect(f.writes).toEqual([])
})
