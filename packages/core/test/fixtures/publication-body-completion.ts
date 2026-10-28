import assert from "node:assert/strict"
import type {
  BodyCompletionDerivation,
  BodyCompletionSnapshot,
} from "../../src/publication-body-completion-proof.ts"

export const completionPage = "20000000-0000-4000-8000-000000000001"
export const completionRoot = "20000000-0000-4000-8000-000000000002"
export const completionDatabase = "20000000-0000-4000-8000-000000000003"
export const completionDataSource = "20000000-0000-4000-8000-000000000004"
export const completionSource = [
  "# Complete source",
  "",
  "| Field | Value |",
  "| --- | --- |",
  "| Range | `one`~`two` |",
  "",
  "## Syntax",
  "",
  "| Shape | Literal |",
  "| --- | --- |",
  "| List | `- item` |",
  "| Code | `` `code` `` |",
  "| Missing A | `---` |",
  "| Missing B | `![x](key)` |",
  "",
  "## Notes",
  "",
  "- **Keep** text.",
  "- Keep `second`.",
  "",
].join("\n")
const baseTime = "2026-10-20T00:00:00.000Z"
const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
export function completionSpan(content: string, code = false, bold = false) {
  return {
    type: "text",
    text: { content, link: null },
    annotations: { ...style, code, bold },
    plain_text: content,
    href: null,
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
export function completionRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value))
  return value
}
export function completionArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value))
  return value
}
export const completionChildPath = (id: string) => `v1/blocks/${id}/children?page_size=100`
const list = (results: readonly unknown[]) => ({
  object: "list",
  type: "block",
  block: {},
  results,
  has_more: false,
  next_cursor: null,
})
const blockId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`
function rawBlock(
  n: number,
  type: string,
  body: Record<string, unknown>,
  parent = completionPage,
  tableChild = false,
  created = baseTime,
) {
  return {
    object: "block",
    id: blockId(n),
    type,
    parent: {
      type: tableChild ? "block_id" : "page_id",
      [tableChild ? "block_id" : "page_id"]: parent,
    },
    has_children: type === "table",
    in_trash: false,
    created_time: created,
    last_edited_time: created,
    created_by: { object: "user", id: "integration" },
    last_edited_by: { object: "user", id: "integration" },
    [type]: body,
  }
}
export function completionFixture(marker = "original-creation-identity") {
  const first = rawBlock(3, "table", {
    table_width: 2,
    has_column_header: true,
    has_row_header: false,
  })
  const second = rawBlock(5, "table", {
    table_width: 2,
    has_column_header: true,
    has_row_header: false,
  })
  const row = (n: number, table: string, cells: ReturnType<typeof completionSpan>[][]) =>
    rawBlock(n, "table_row", { cells }, table, true)
  const roots = [
    rawBlock(1, "paragraph", { rich_text: [completionSpan(marker)], color: "default" }),
    rawBlock(2, "heading_1", { rich_text: [completionSpan("Complete source")], color: "default" }),
    first,
    rawBlock(4, "heading_2", { rich_text: [completionSpan("Syntax")], color: "default" }),
    second,
  ]
  const firstRows = [
    row(11, first.id, [[completionSpan("Field")], [completionSpan("Value")]]),
    row(12, first.id, [
      [completionSpan("Range")],
      [completionSpan("one", true), completionSpan("~"), completionSpan("two", true)],
    ]),
  ]
  const secondRows = [
    row(21, second.id, [[completionSpan("Shape")], [completionSpan("Literal")]]),
    row(22, second.id, [[completionSpan("List")], [completionSpan("  • item", true)]]),
    row(23, second.id, [[completionSpan("Code")], [completionSpan("`code`", true)]]),
  ]
  const page = {
    object: "page",
    id: completionPage,
    parent: { type: "page_id", page_id: completionRoot },
    properties: { title: { id: "title", type: "title", title: [completionSpan("completion.md")] } },
    created_time: baseTime,
    last_edited_time: baseTime,
    in_trash: false,
    archived: false,
  }
  const beforeSource = completionSource
    .slice(0, completionSource.indexOf("| Missing A"))
    .replace("`- item`", "`  • item`")
  const before: BodyCompletionSnapshot = {
    page_before: structuredClone(page),
    page_after: structuredClone(page),
    markdown: {
      object: "page_markdown",
      id: completionPage,
      markdown: `${marker}\n\n${beforeSource}`,
      truncated: false,
      unknown_block_ids: [],
    },
    inventories: {
      [completionChildPath(completionPage)]: list(roots),
      [completionChildPath(first.id)]: list(firstRows),
      [completionChildPath(second.id)]: list(secondRows),
    },
  }
  return {
    marker,
    before,
    first_table_id: first.id,
    table_id: second.id,
    row_id: secondRows[1]!.id,
  }
}
export const completionRoots = (snapshot: BodyCompletionSnapshot) =>
  completionArray(snapshot.inventories[completionChildPath(completionPage)]?.results)
export const completionRows = (snapshot: BodyCompletionSnapshot, table: string) =>
  completionArray(snapshot.inventories[completionChildPath(table)]?.results)
export function completionFind(snapshot: BodyCompletionSnapshot, id: string) {
  for (const inventory of Object.values(snapshot.inventories)) {
    const result = completionArray(inventory.results).find((raw) => completionRecord(raw).id === id)
    if (result) return completionRecord(result)
  }
  throw new Error(`Missing fixture block ${id}`)
}
function richResponse(value: unknown) {
  return completionArray(value).map((raw) => {
    const span = completionRecord(raw),
      text = completionRecord(span.text)
    const url = text.link == null ? null : completionRecord(text.link).url
    return {
      ...span,
      text: { ...text, link: url === null ? null : { url } },
      plain_text: text.content,
      href: url,
    }
  })
}
export function advanceCompletion(
  derived: BodyCompletionDerivation,
  step: number,
  before: BodyCompletionSnapshot,
) {
  const after = structuredClone(before),
    request = derived.requests[step]
  assert.ok(request)
  const edited = `2026-10-20T00:00:0${step + 1}.000Z`
  after.page_before.last_edited_time = edited
  after.page_after.last_edited_time = edited
  after.markdown.markdown = derived.markdown[step + 1]
  const table = completionFind(after, derived.table_id)
  let response: unknown
  if (step === 0) {
    const row = completionFind(after, derived.row_id)
    row.table_row = {
      cells: completionArray(completionRecord(request.body.table_row).cells).map(richResponse),
    }
    row.last_edited_time = edited
    table.last_edited_time = edited
    response = structuredClone(row)
  } else {
    const appended = completionArray(request.body.children).map((raw, index) => {
      const requested = completionRecord(raw),
        type = String(requested.type),
        body = completionRecord(requested[type])
      const responseBody =
        type === "table_row"
          ? { cells: completionArray(body.cells).map(richResponse) }
          : { ...body, rich_text: richResponse(body.rich_text) }
      return rawBlock(
        100 + step * 10 + index,
        type,
        responseBody,
        step === 1 ? derived.table_id : derived.page_id,
        step === 1,
        edited,
      )
    })
    if (step === 1) {
      completionRows(after, derived.table_id).push(...appended)
      table.last_edited_time = edited
    } else completionRoots(after).push(...appended)
    response = list(structuredClone(appended))
  }
  return { after, response }
}
