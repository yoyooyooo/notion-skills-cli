import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { notionMarkdownForComparison } from "../src/index.ts"

const rich = (content, extra = {}) => ({
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
    ...extra,
  },
})
const block = (id, type, value, parent = "page", children = false) => ({
  id,
  type,
  has_children: children,
  archived: false,
  in_trash: false,
  parent: {
    type: parent === "page" ? "page_id" : "block_id",
    [parent === "page" ? "page_id" : "block_id"]: parent,
  },
  [type]: value,
})
const code = (value) =>
  "`".repeat(Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1) +
  " " +
  value +
  " " +
  "`".repeat(Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1)
const serialized = (value) => "`" + value.replaceAll("`", "\\`") + "`"
const html = (rows) =>
  [
    '<table header-row="true">',
    ...rows.flatMap((row) => ["<tr>", ...row.map((cell) => `<td>${cell}</td>`), "</tr>"]),
    "</table>",
  ].join("\n")
function fixture(literal = false) {
  const values = ["`code`", "```go ... ```"]
  const suffix = literal ? " and <value>." : " safely."
  const expected = values.map(code).join(" / ") + suffix
  const actual = values.map(serialized).join(" / ") + (literal ? " and \\<value\\>." : suffix)
  const rows = [
    [[rich("Kind")], [rich("Example")]],
    [
      [rich("Code")],
      [rich(values[0], { code: true }), rich(" / "), rich(values[1], { code: true }), rich(suffix)],
    ],
    [[rich("Other")], [rich("Keep every other cell.")]],
  ]
  return {
    source: [
      "# Before",
      "",
      "| Kind | Example |",
      "| --- | --- |",
      `| Code | ${expected} |`,
      "| Other | Keep every other cell. |",
      "",
      "## After",
      "",
      "End.",
      "",
    ].join("\n"),
    actual: [
      "# Before",
      html([
        ["Kind", "Example"],
        ["Code", actual],
        ["Other", "Keep every other cell."],
      ]),
      "## After",
      "End.",
    ].join("\n"),
    blocks: [
      block("before", "heading_1", { rich_text: [rich("Before")] }),
      block(
        "table",
        "table",
        { table_width: 2, has_column_header: true, has_row_header: false },
        "page",
        true,
      ),
      ...rows.map((cells, index) => block(`row-${index}`, "table_row", { cells }, "table")),
      block("after", "heading_2", { rich_text: [rich("After")] }),
      block("end", "paragraph", { rich_text: [rich("End.")] }),
    ],
  }
}
const tree = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, tree(f))
const cell = (f, row, column) =>
  f.blocks.find((block) => block.id === `row-${row}`).table_row.cells[column]
const changeText = (span, text) => {
  span.text.content = text
  span.plain_text = text
}

for (const literal of [false, true])
  test(`complete physical/source proof decodes backticks${literal ? " with a literal tag" : ""}`, () => {
    const f = fixture(literal),
      before = JSON.stringify(f)
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
    assert.equal(matches(f), true)
    assert.ok(notionMarkdownForComparison(f.actual, f.source, tree(f)).includes(code("`code`")))
    assert.equal(JSON.stringify(f), before)
  })

test("escaped-backtick decoding requires complete physical table evidence", () => {
  const f = fixture(),
    roots = tree(f)
  assert.equal(matches(f), true)
  const missing = roots.map((root) => {
    const { table_evidence, ...prior } = root
    return prior
  })
  assert.equal(samePublishedMarkdown(f.actual, f.source, undefined, missing), false)
})

test("changed physical code bytes or any other cell cannot be hidden by the serializer", () => {
  for (const alter of [
    (f) => {
      changeText(cell(f, 1, 1)[0], "`other`")
    },
    (f) => {
      changeText(cell(f, 1, 1)[2], "```go changed ```")
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.code = false
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.bold = true
    },
    (f) => {
      cell(f, 1, 1)[0].text.link = { url: "https://example.test/" }
      cell(f, 1, 1)[0].href = "https://example.test/"
    },
    (f) => {
      changeText(cell(f, 0, 0)[0], "Different header")
    },
    (f) => {
      changeText(cell(f, 2, 1)[0], "Discard the other cell.")
    },
    (f) => {
      cell(f, 1, 1)[0].plain_text = "Contradictory code"
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("source, readback, neighboring text and whole-table order remain exact", () => {
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace("code", "other")
    },
    (f) => {
      f.source = f.source.replace("code", "other")
    },
    (f) => {
      f.actual = f.actual.replace("Keep every other cell.", "Discard the other cell.")
    },
    (f) => {
      f.actual = f.actual.replace("## After", "## Elsewhere")
    },
    (f) => {
      f.actual = f.actual.replace(serialized("`code`"), "\\" + serialized("`code`"))
    },
    (f) => {
      f.blocks.splice(3, 1)
    },
    (f) => {
      f.blocks[3].parent.block_id = "foreign"
    },
    (f) => {
      ;[f.blocks[2], f.blocks[3]] = [f.blocks[3], f.blocks[2]]
    },
    (f) => {
      f.blocks[3].has_children = true
    },
    (f) => {
      f.actual = f.actual.replace("code", "other")
      changeText(cell(f, 1, 1)[0], "`other`")
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("unknown formatting and unproven backslashes do not qualify as backtick serialization", () => {
  for (const alter of [
    (f) => {
      cell(f, 1, 1)[0].annotations.italic = true
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.future = true
    },
    (f) => {
      cell(f, 1, 1)[0].type = "equation"
    },
    (f) => {
      f.actual = f.actual.replace("code", "co\\\\de")
    },
    (f) => {
      f.blocks[3].table_row.future = true
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})
