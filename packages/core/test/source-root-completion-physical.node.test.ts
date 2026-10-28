import assert from "node:assert/strict"
import { test } from "vitest"
import {
  compileSourceRootBody,
  sourceRootBodyMatches,
  type PhysicalNode,
} from "../src/source-root-completion-physical.ts"

const source = [
  "# Skills",
  "",
  "**Bold** *Italic* ~~Strike~~ `code` [reference](https://EXAMPLE.test/path?q=1#part)",
  "",
  "## Steps",
  "",
  "- First `item`",
  "- Second",
  "",
  "3. Alpha",
  "4. Beta",
  "",
  "### Matrix",
  "",
  "| Rule | Value |",
  "| --- | --- |",
  "| A | **yes** |",
  "| Empty | |",
  "| Entity | &lt; |",
  "",
  "```bash",
  "printf '%s\\n' \"$HOME\"",
  "```",
  "",
  "---",
  "",
].join("\n")

const defaults = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
function span(
  content: string,
  annotations: Partial<typeof defaults> = {},
  url: string | null = null,
) {
  return {
    type: "text",
    text: { content, link: url === null ? null : { url } },
    annotations: { ...defaults, ...annotations },
    plain_text: content,
    href: url,
  }
}
function fixture() {
  let next = 0
  function node(
    type: string,
    body: Record<string, unknown>,
    children: PhysicalNode[] = [],
  ): PhysicalNode {
    const id = `10000000-0000-0000-0000-${String(++next).padStart(12, "0")}`
    for (const child of children) child.raw.parent = { type: "block_id", block_id: id }
    return {
      raw: {
        object: "block",
        id,
        parent: { type: "page_id", page_id: "20000000-0000-0000-0000-000000000001" },
        type,
        archived: false,
        in_trash: false,
        has_children: children.length > 0,
        [type]: body,
      },
      children,
    }
  }
  const text = (
    type: string,
    rich_text: ReturnType<typeof span>[],
    extra: Record<string, unknown> = {},
  ) => node(type, { rich_text, color: "default", ...extra })
  const paragraph = text("paragraph", [
    span("Bold", { bold: true }),
    span(" "),
    span("Italic", { italic: true }),
    span(" "),
    span("Strike", { strikethrough: true }),
    span(" "),
    span("code", { code: true }),
    span(" "),
    span("reference", {}, "https://EXAMPLE.test/path?q=1#part"),
  ])
  const first = text("numbered_list_item", [span("Alpha")], {
    list_start_index: 3,
    list_format: "numbers",
  })
  const second = text("numbered_list_item", [span("Beta")])
  const tableRows = [
    node("table_row", { cells: [[span("Rule")], [span("Value")]] }),
    node("table_row", { cells: [[span("A")], [span("yes", { bold: true })]] }),
    node("table_row", { cells: [[span("Empty")], []] }),
    node("table_row", { cells: [[span("Entity")], [span("&lt;")]] }),
  ]
  const table = node(
    "table",
    { table_width: 2, has_column_header: true, has_row_header: false },
    tableRows,
  )
  const code = node("code", {
    language: "shell",
    caption: [],
    rich_text: [span("printf '%s\\n' \"$HOME\"")],
  })
  const roots = [
    text("heading_1", [span("Skills")], { is_toggleable: false }),
    paragraph,
    text("heading_2", [span("Steps")]),
    text("bulleted_list_item", [span("First "), span("item", { code: true })]),
    text("bulleted_list_item", [span("Second")]),
    first,
    second,
    text("heading_3", [span("Matrix")]),
    table,
    code,
    node("divider", {}),
  ]
  return { roots, paragraph, first, second, table, tableRows, code, node, text }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function body(node: PhysicalNode) {
  const value = node.raw[String(node.raw.type)]
  assert.ok(record(value))
  return value
}
function rich(node: PhysicalNode) {
  const values = body(node).rich_text
  assert.ok(Array.isArray(values) && values.every(record))
  return values
}
function cells(node: PhysicalNode) {
  const values = body(node).cells
  assert.ok(Array.isArray(values) && values.every(Array.isArray))
  return values
}
function model(markdown = source) {
  const result = compileSourceRootBody(markdown)
  assert.ok(result)
  return result
}

test("consumes a complete independent physical fixture without changing either input", () => {
  const f = fixture(),
    compiled = model()
  const original = JSON.stringify({ compiled, roots: f.roots })
  assert.equal(sourceRootBodyMatches(compiled, f.roots), true)
  assert.equal(compiled.roots.length, 11)
  assert.equal(JSON.stringify(compiled).includes("10000000-"), false)
  assert.equal(JSON.stringify({ compiled, roots: f.roots }), original)
})

test("allows only segmentation of adjacent text with the same complete style and destination", () => {
  const f = fixture()
  body(f.paragraph).rich_text = [
    span("Bo", { bold: true }),
    span("ld", { bold: true }),
    ...rich(f.paragraph).slice(1),
  ]
  assert.equal(sourceRootBodyMatches(model(), f.roots), true)
  body(f.paragraph).rich_text = [
    span("Bo", { bold: true }),
    span("ld"),
    ...rich(f.paragraph).slice(2),
  ]
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
})

test("does not hide missing, extra empty or opaque ordinary roots", () => {
  const f = fixture(),
    compiled = model()
  assert.equal(sourceRootBodyMatches(compiled, f.roots.slice(0, -1)), false)
  assert.equal(sourceRootBodyMatches(compiled, [...f.roots, f.text("paragraph", [])]), false)
  const opaque = f.node("unsupported", {})
  assert.equal(sourceRootBodyMatches(compiled, [...f.roots.slice(0, -1), opaque]), false)
})

test("consumes descendants even when an added paragraph is empty", () => {
  const f = fixture(),
    extra = f.text("paragraph", [])
  f.roots[1] = { raw: { ...f.paragraph.raw, has_children: true }, children: [extra] }
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  f.roots[1] = { raw: { ...f.paragraph.raw, has_children: false }, children: [extra] }
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
})

test("requires every table row and every cell, including an otherwise unselected cell", () => {
  const compiled = model()
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.tableRows.pop()
    },
    (f: ReturnType<typeof fixture>) => {
      f.tableRows.push(f.node("table_row", { cells: [[], []] }))
    },
    (f: ReturnType<typeof fixture>) => {
      cells(f.tableRows[0]!)[1] = [span("Different header")]
    },
    (f: ReturnType<typeof fixture>) => {
      cells(f.tableRows[2]!)[1] = [span("hidden")]
    },
    (f: ReturnType<typeof fixture>) => {
      cells(f.tableRows[3]!)[1] = [span("<")]
    },
    (f: ReturnType<typeof fixture>) => {
      cells(f.tableRows[1]!).push([])
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.equal(sourceRootBodyMatches(compiled, f.roots), false)
  }
})

test("rejects table flags, hidden descendants and unconsumed table semantics", () => {
  for (const patch of [
    { table_width: 3 },
    { has_column_header: false },
    { has_row_header: true },
    { caption: [] },
  ]) {
    const f = fixture()
    Object.assign(body(f.table), patch)
    assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  }
  const f = fixture(),
    row = f.tableRows[0]!
  f.tableRows[0] = { raw: { ...row.raw, has_children: true }, children: [f.text("paragraph", [])] }
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
})

test("binds all annotation fields and rejects incomplete physical text metadata", () => {
  for (const annotations of [
    { bold: false },
    { italic: true },
    { strikethrough: true },
    { underline: true },
    { code: true },
    { color: "red" },
    { unsupported: false },
    { italic: null },
    { code: null },
    { color: null },
    { underline: undefined },
  ]) {
    const f = fixture(),
      first = rich(f.paragraph)[0]!
    assert.ok(record(first.annotations))
    Object.assign(first.annotations, annotations)
    assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  }
  const f = fixture(),
    first = rich(f.paragraph)[0]!
  assert.ok(record(first.annotations))
  delete first.annotations.underline
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
})

test("never aliases explicit URL hosts, ports, paths, queries or fragments", () => {
  for (const url of [
    "https://example.test/path?q=1#part",
    "https://EXAMPLE.test:443/path?q=1#part",
    "https://EXAMPLE.test/path/?q=1#part",
    "https://EXAMPLE.test/path?q=2#part",
    "https://EXAMPLE.test/path?q=1",
    "http://EXAMPLE.test/path?q=1#part",
  ]) {
    const f = fixture()
    rich(f.paragraph)[8] = span("reference", {}, url)
    assert.equal(sourceRootBodyMatches(model(), f.roots), false, url)
  }
})

test("refuses contradictory plain text, href, unknown span fields and nontext inline effects", () => {
  for (const patch of [
    { plain_text: "Different" },
    { href: "https://example.test" },
    { mention: {} },
    { type: "equation", equation: { expression: "Bold" } },
    { type: "mention", mention: {} },
  ]) {
    const f = fixture()
    Object.assign(rich(f.paragraph)[0]!, patch)
    assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  }
})

test("binds complete code text, caption and formatting while retaining existing language aliases", () => {
  const f = fixture()
  body(f.code).language = "bash"
  assert.equal(sourceRootBodyMatches(model(), f.roots), true)
  for (const patch of [
    { language: "python" },
    { caption: [span("caption")] },
    { rich_text: [span("printf '%s\\n' \"$HOME\"\n")] },
    { rich_text: [span("printf '%s\\n' \"$HOME\"", { bold: true })] },
    { rich_text: [span("printf '%s\\n' \"$HOME\"", {}, "https://example.test")] },
  ]) {
    const changed = fixture()
    Object.assign(body(changed.code), patch)
    assert.equal(sourceRootBodyMatches(model(), changed.roots), false)
  }
})

test("preserves nondefault ordered starts and does not silently turn numeric zero into one", () => {
  assert.equal(compileSourceRootBody("0. Zero\n1. One\n"), undefined)
  const f = fixture()
  delete body(f.first).list_start_index
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  body(f.first).list_start_index = 3
  body(f.second).list_start_index = 4
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  delete body(f.second).list_start_index
  body(f.first).list_format = "roman"
  assert.equal(sourceRootBodyMatches(model(), f.roots), false)
  const first = f.text("numbered_list_item", [span("One")]),
    second = f.text("numbered_list_item", [span("Two")])
  assert.equal(sourceRootBodyMatches(model("1. One\n2. Two\n"), [first, second]), true)
})

test("refuses unsupported source structure before a request can be planned", () => {
  for (const markdown of [
    "",
    "\n",
    "#### Deep heading\n",
    "> A quote\n",
    "- Parent\n  - Nested\n",
    "- First\n\n- Loose\n",
    "- [x] Task\n",
    "![image](https://example.test/a.png)\n",
    "<details>hidden</details>\n",
    '[titled](https://example.test "title")\n',
    "| A | B |\n| :--- | ---: |\n| x | y |\n",
  ])
    assert.equal(compileSourceRootBody(markdown), undefined, markdown)
})

test("rejects toggled headings, icons, unexpected body fields and archived content", () => {
  const compiled = model()
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      body(f.roots[0]!).is_toggleable = true
    },
    (f: ReturnType<typeof fixture>) => {
      body(f.paragraph).icon = { type: "emoji", emoji: "!" }
    },
    (f: ReturnType<typeof fixture>) => {
      body(f.paragraph).unknown_effect = "hidden"
    },
    (f: ReturnType<typeof fixture>) => {
      f.tableRows[0]!.raw.in_trash = true
    },
    (f: ReturnType<typeof fixture>) => {
      f.paragraph.raw.archived = true
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.equal(sourceRootBodyMatches(compiled, f.roots), false)
  }
})
