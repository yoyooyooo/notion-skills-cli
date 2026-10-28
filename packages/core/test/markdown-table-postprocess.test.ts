import { expect, test } from "bun:test"
import { Effect } from "effect"
import { restoreMarkdownBlocks } from "../src/markdown-blocks.ts"
import { fail, property } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"

const pageId = "11111111-1111-4111-8111-111111111111"
const tableId = "22222222-2222-4222-8222-222222222222"
const codeId = "33333333-3333-4333-8333-333333333333"
const source =
  '| Key | Meaning | Example |\n| --- | --- | --- |\n| <item name="sample"> | text | plain |\n| word | middle | prefix <value key> suffix |\n| last | <entry mode="all"> | prefix <literal> suffix |\n'
const values = [
  ["Key", "Meaning", "Example"],
  ['<item name="sample">', "text", "plain"],
  ["word", "middle", "prefix <value key> suffix"],
  ["last", '<entry mode="all">', "prefix <literal> suffix"],
]
function fixture(text: string[][] = values, code = false) {
  const roots = [
    ...(code
      ? [
          {
            id: codeId,
            type: "code",
            has_children: false,
            code: { language: "python", rich_text: [] },
          },
        ]
      : []),
    {
      id: tableId,
      type: "table",
      has_children: true,
      parent: { type: "page_id", page_id: pageId },
      table: { table_width: text[0]!.length, has_column_header: true, has_row_header: false },
    },
  ]
  const rows = text.map((cells, index) => ({
    id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    type: "table_row",
    has_children: false,
    archived: false,
    in_trash: false,
    parent: { type: "block_id", block_id: tableId },
    table_row: {
      cells: cells.map((content) => [
        {
          type: "text",
          text: { content, link: null },
          plain_text: content,
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
        },
      ]),
    },
  }))
  const writes: Array<{ path: string; body: unknown }> = []
  const api: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) => {
      if (options?.method === "PATCH") {
        writes.push({ path, body })
        return Effect.succeed({ id: path.split("/")[2] })
      }
      if (body !== undefined || (options?.method && options.method !== "GET"))
        return Effect.fail(fail("NOTION_REQUEST_FAILED", "Unexpected table fixture write."))
      if (path === `v1/blocks/${pageId}/children?page_size=100`)
        return Effect.succeed({ results: roots, has_more: false, next_cursor: null })
      if (path === `v1/blocks/${tableId}/children?page_size=100`)
        return Effect.succeed({ results: rows, has_more: false, next_cursor: null })
      return Effect.fail(fail("NOTION_REQUEST_FAILED", "Unexpected table fixture read."))
    },
  }
  return { api, roots, rows, writes }
}

test("exact physical HTML literals finish table postprocessing with zero writes", async () => {
  const f = fixture(),
    before = JSON.stringify([f.roots, f.rows])
  await Effect.runPromise(restoreMarkdownBlocks(pageId, source, f.api))
  expect(f.writes).toEqual([])
  expect(JSON.stringify([f.roots, f.rows])).toBe(before)
})

for (const change of ["literal", "format", "url", "neighbor", "parent"] as const)
  test(`supported literal HTML with changed ${change} uses ordinary text correction`, async () => {
    const f = fixture()
    const cell = f.rows[1]!.table_row.cells[0]![0]!
    if (change === "literal") {
      cell.text.content += "edited"
      cell.plain_text += "edited"
    }
    if (change === "format") cell.annotations.bold = true
    if (change === "url")
      Object.assign(cell, {
        text: { content: cell.text.content, link: { url: "https://example.invalid/edited" } },
        href: "https://example.invalid/edited",
      })
    if (change === "neighbor") {
      f.rows[1]!.table_row.cells[1]![0]!.text.content = "edited"
      f.rows[1]!.table_row.cells[1]![0]!.plain_text = "edited"
    }
    if (change === "parent") f.rows[1]!.parent.block_id = pageId
    const before = JSON.stringify([f.roots, f.rows])
    const result = await Effect.runPromise(
      restoreMarkdownBlocks(pageId, source, f.api).pipe(Effect.result),
    )
    expect(result._tag).toBe("Success")
    // This postprocessor corrects text. Complete format, destination and parent
    // validation remains with the ordinary final publication readback.
    if (change === "literal" || change === "neighbor") {
      expect(f.writes).toHaveLength(1)
      expect(f.writes[0]!.path).toBe(`v1/blocks/${f.rows[1]!.id}`)
      expect(property(property(f.writes[0]!.body).table_row).cells).toEqual(
        values[1]!.map((content) => [{ type: "text", text: { content }, annotations: {} }]),
      )
    } else expect(f.writes).toEqual([])
    expect(JSON.stringify([f.roots, f.rows])).toBe(before)
  })

test("supported text correction continues through the existing mutation path", async () => {
  const f = fixture([["Key"], ["changed"]])
  await Effect.runPromise(restoreMarkdownBlocks(pageId, "| Key |\n| --- |\n| exact |\n", f.api))
  expect(f.writes).toHaveLength(1)
  expect(f.writes[0]!.path).toBe(`v1/blocks/${f.rows[1]!.id}`)
  const cells = property(property(f.writes[0]!.body).table_row).cells
  expect(cells).toEqual([[{ type: "text", text: { content: "exact" }, annotations: {} }]])
})

test("HTML row no-ops do not skip the page's existing code language correction", async () => {
  const f = fixture(values, true)
  await Effect.runPromise(
    restoreMarkdownBlocks(pageId, "```javascript\nlet value = 1\n```\n\n" + source, f.api),
  )
  expect(f.writes).toEqual([
    { path: `v1/blocks/${codeId}`, body: { code: { language: "javascript" } } },
  ])
})
