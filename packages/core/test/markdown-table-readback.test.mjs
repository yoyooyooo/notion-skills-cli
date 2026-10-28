import test from "node:test"
import assert from "node:assert/strict"
import { literalHtmlTableRowAlreadyExact as exact } from "../src/markdown-table-readback.ts"

const tableId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const rowId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const token = (type, text) => ({
  type,
  raw: text,
  text,
  ...(type === "html" ? { block: false } : {}),
})
const cell = (...tokens) => ({ text: "", tokens })
const span = (content, changes = {}, url = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  plain_text: content,
  href: url,
  annotations: { ...style, ...changes },
})
const row = (...cells) => ({
  id: rowId,
  type: "table_row",
  has_children: false,
  archived: false,
  in_trash: false,
  parent: { type: "block_id", block_id: tableId },
  table_row: { cells },
})
const html = '<item name="source">'
const expected = [
  cell(token("html", html), token("text", "inside"), token("html", "</item>")),
  cell(token("text", "plain")),
]
const current = () => row([span(html + "inside</item>")], [span("plain")])

test("literal attributes and closing tags are already present, with every other cell exact", () => {
  assert.equal(exact(expected, current(), tableId), true)
})
test("equally styled text chunks are read as the same complete physical value", () => {
  const value = current()
  value.table_row.cells[0] = [span(html), span("inside"), span("</item>")]
  assert.equal(exact(expected, value, tableId), true)
})
test("source formatting and complete destinations remain part of the proof", () => {
  const url = "https://example.invalid/path?a=1#section"
  const source = [
    cell({
      type: "link",
      raw: "",
      text: "",
      href: url,
      title: null,
      tokens: [{ type: "strong", raw: "", text: "", tokens: [token("html", "<literal>")] }],
    }),
  ]
  assert.equal(exact(source, row([span("<literal>", { bold: true }, url)]), tableId), true)
  assert.equal(
    exact(source, row([span("<literal>", { bold: true }, url + "-changed")]), tableId),
    false,
  )
  assert.equal(exact(source, row([span("<literal>", {}, url)]), tableId), false)
})
test("ordinary supported rows keep the existing serializer path", () => {
  assert.equal(exact([cell(token("text", "plain"))], row([span("plain")]), tableId), false)
  assert.equal(exact([cell(token("text", "<literal>"))], row([span("<literal>")]), tableId), false)
})
test("any changed literal byte, whitespace, attribute or neighboring cell refuses the no-op", () => {
  for (const text of [
    html + "changed</item>",
    html + "inside </item>",
    '<item name="other">inside</item>',
    "inside",
  ])
    assert.equal(exact(expected, row([span(text)], [span("plain")]), tableId), false)
  assert.equal(
    exact(expected, row([span(html + "inside</item>")], [span("changed")]), tableId),
    false,
  )
})
test("all readback annotations must be complete and exact", () => {
  for (const annotation of [
    { underline: true },
    { code: true },
    { color: "red" },
    { italic: true },
    { bold: true },
    { strikethrough: true },
  ]) {
    const value = current()
    Object.assign(value.table_row.cells[1][0].annotations, annotation)
    assert.equal(exact(expected, value, tableId), false)
  }
  const missing = current()
  delete missing.table_row.cells[0][0].annotations.underline
  assert.equal(exact(expected, missing, tableId), false)
  const unknown = current()
  unknown.table_row.cells[0][0].annotations.extra = true
  assert.equal(exact(expected, unknown, tableId), false)
})
test("current text aliases, links and value types cannot contradict the literal", () => {
  const changedText = current()
  changedText.table_row.cells[0][0].plain_text = "edited"
  assert.equal(exact(expected, changedText, tableId), false)
  const changedHref = current()
  changedHref.table_row.cells[0][0].href = "https://example.invalid/added"
  assert.equal(exact(expected, changedHref, tableId), false)
  const linked = current()
  linked.table_row.cells[0][0].text.link = { url: "https://example.invalid/added" }
  assert.equal(exact(expected, linked, tableId), false)
  const mention = current()
  mention.table_row.cells[0][0].type = "mention"
  assert.equal(exact(expected, mention, tableId), false)
})
test("unsupported source types and nonliteral HTML have no readback authority", () => {
  assert.equal(
    exact(
      [cell(token("image", "image"), token("html", "<literal>"))],
      row([span("image<literal>")]),
      tableId,
    ),
    false,
  )
  assert.equal(
    exact(
      [cell({ ...token("html", "<literal>"), text: "other" })],
      row([span("<literal>")]),
      tableId,
    ),
    false,
  )
  assert.equal(
    exact(
      [cell({ ...token("html", "<literal>"), block: true })],
      row([span("<literal>")]),
      tableId,
    ),
    false,
  )
})
test("unrepresented link titles cannot be proved by a physical text span", () => {
  const url = "https://example.invalid/a"
  assert.equal(
    exact(
      [
        cell({
          type: "link",
          href: url,
          title: "authored title",
          tokens: [token("html", "<literal>")],
        }),
      ],
      row([span("<literal>", {}, url)]),
      tableId,
    ),
    false,
  )
})
test("only a current leaf table row owned by the observed table is eligible", () => {
  for (const change of [
    { type: "paragraph" },
    { has_children: true },
    { archived: true },
    { in_trash: true },
    { parent: { type: "block_id", block_id: rowId } },
    { parent: { type: "page_id", page_id: tableId } },
    { id: tableId },
  ])
    assert.equal(exact(expected, { ...current(), ...change }, tableId), false)
})
test("missing or additional cells cannot be hidden by an exact HTML cell", () => {
  assert.equal(exact(expected, row([span(html + "inside</item>")]), tableId), false)
  assert.equal(
    exact(expected, row([span(html + "inside</item>")], [span("plain")], []), tableId),
    false,
  )
})
test("successful evidence leaves all source tokens and current raw records untouched", () => {
  const source = structuredClone(expected),
    value = current(),
    before = JSON.stringify([source, value])
  assert.equal(exact(source, value, tableId), true)
  assert.equal(JSON.stringify([source, value]), before)
})
