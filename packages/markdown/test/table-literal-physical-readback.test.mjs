import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { notionMarkdownForComparison } from "../src/index.ts"

const url = "https://example.test/manual?q=1#exact"
const rich = (content, { link = null, ...style } = {}) => ({
  type: "text",
  text: { content, link: link === null ? null : { url: link } },
  plain_text: content,
  href: link,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...style,
  },
})
const block = (id, type, body, parent = "page", has_children = false) => ({
  id,
  type,
  has_children,
  archived: false,
  in_trash: false,
  parent: {
    type: parent === "page" ? "page_id" : "block_id",
    [parent === "page" ? "page_id" : "block_id"]: parent,
  },
  [type]: body,
})
const text = (id, type, value) => block(id, type, { rich_text: [rich(value)], color: "default" })
const options = (id) =>
  block(id, "paragraph", {
    rich_text: [
      rich("Options: ", { italic: true }),
      rich("--dry-run", { italic: true, code: true }),
    ],
  })
const table = (id, rows) => [
  block(
    id,
    "table",
    { table_width: 2, has_column_header: true, has_row_header: false },
    "page",
    true,
  ),
  ...rows.map((cells, i) => block(`${id}-row-${i}`, "table_row", { cells }, id)),
]
const html = (rows) =>
  [
    '<table header-row="true">',
    ...rows.flatMap((cells) => ["<tr>", ...cells.map((value) => `<td>${value}</td>`), "</tr>"]),
    "</table>",
  ].join("\n")
function fixture(repeated = false) {
  const sourceRows = [
    ["Name", "Use"],
    ["`--input`", `Read <value>, **keep**, [manual](${url}) and JSON [{"x":{}}].`],
    ["`--other`", "Keep the other cell."],
  ]
  const actualRows = [
    ["Name", "Use"],
    ["`--input`", `Read \\<value\\>, **keep**, [manual](${url}) and JSON \\[\\{"x":\\{\\}\\}\\].`],
    ["`--other`", "Keep the other cell."],
  ]
  const source = [
    "# Commands",
    "",
    "_Options: `--dry-run`_",
    "",
    "| Name | Use |",
    "| --- | --- |",
    ...sourceRows.slice(1).map((row) => `| ${row.join(" | ")} |`),
    "",
    "## Next",
    "",
  ]
  const actual = ["# Commands", "*Options: **`--dry-run`*", html(actualRows), "## Next"]
  const blocks = [
    text("before", "heading_1", "Commands"),
    options("options"),
    ...table("table", [
      [[rich("Name")], [rich("Use")]],
      [
        [rich("--input", { code: true })],
        [
          rich("Read <value>, "),
          rich("keep", { bold: true }),
          rich(", "),
          rich("manual", { link: url }),
          rich(' and JSON [{"x":{}}].'),
        ],
      ],
      [[rich("--other", { code: true })], [rich("Keep the other cell.")]],
    ]),
    text("after", "heading_2", "Next"),
  ]
  if (repeated) {
    source.push(
      "_Options: `--dry-run`_",
      "",
      "| A | B |",
      "| --- | --- |",
      "| Keep | This second table |",
      "",
      "# Commands",
      "",
      "Finish here.",
      "",
    )
    actual.push(
      "*Options: **`--dry-run`*",
      html([
        ["A", "B"],
        ["Keep", "This second table"],
      ]),
      "# Commands",
      "Finish here.",
    )
    blocks.push(
      options("again"),
      ...table("second", [
        [[rich("A")], [rich("B")]],
        [[rich("Keep")], [rich("This second table")]],
      ]),
      text("repeated-heading", "heading_1", "Commands"),
      text("tail", "paragraph", "Finish here."),
    )
  } else {
    source.push("Finish here.", "")
    actual.push("Finish here.")
    blocks.push(text("tail", "paragraph", "Finish here."))
  }
  return { source: source.join("\n"), actual: actual.join("\n"), blocks }
}
const tree = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, tree(f))
const cell = (f, row, column) =>
  f.blocks.find((block) => block.id === `table-row-${row}`).table_row.cells[column]
const replace = (span, value) => {
  span.text.content = value
  span.plain_text = value
}

test("a complete mixed-format table removes only the source literal-tag escapes", () => {
  const f = fixture(),
    before = JSON.stringify(f),
    roots = tree(f),
    result = notionMarkdownForComparison(f.actual, f.source, roots)
  assert.equal(roots.find((root) => root.id === "table").table_evidence.rows.length, 3)
  assert.equal(matches(f), true)
  assert.ok(result.includes("Read <value>, **keep**"))
  assert.ok(result.includes('JSON \\[\\{"x":\\{\\}\\}\\].'), "all non-tag escaping stays unchanged")
  assert.ok(result.includes(`[manual](${url})`))
  assert.equal(JSON.stringify(f), before)
  const unavailable = roots.map((root) => {
    const { table_evidence, ...prior } = root
    return prior
  })
  assert.equal(samePublishedMarkdown(f.actual, f.source, undefined, unavailable), false)
})

test("repeated paragraphs and headings need one complete four-root source/physical/readback interval", () => {
  const f = fixture(true)
  assert.equal(matches(f), true)
  for (const alter of [
    (f) => {
      f.blocks.find((root) => root.id === "before").has_children = true
    },
    (f) => {
      f.blocks.find((root) => root.id === "after").heading_2.rich_text[0] = rich("Elsewhere")
    },
    (f) => {
      f.actual = f.actual.replace("## Next", "## Elsewhere")
    },
    (f) => {
      f.source = f.source.replace("## Next", "## Elsewhere")
    },
    (f) => {
      f.blocks.splice(0, 1)
    },
    (f) => {
      f.actual = f.actual.replace(
        "# Commands\n*Options",
        "# Commands\nAn extra paragraph.\n*Options",
      )
    },
  ]) {
    const value = fixture(true)
    alter(value)
    assert.equal(matches(value), false)
  }
})

test("every physical cell is bound, including header, unaffected rows, code, bold and complete URL", () => {
  for (const alter of [
    (f) => {
      replace(cell(f, 0, 0)[0], "Other header")
    },
    (f) => {
      replace(cell(f, 2, 1)[0], "Different instructions.")
    },
    (f) => {
      replace(cell(f, 1, 1)[0], "Read <other>, ")
    },
    (f) => {
      cell(f, 1, 0)[0].annotations.code = false
    },
    (f) => {
      cell(f, 1, 1)[1].annotations.bold = false
    },
    (f) => {
      cell(f, 1, 1)[3].text.link.url += "-other"
      cell(f, 1, 1)[3].href += "-other"
    },
    (f) => {
      cell(f, 2, 1)[0].plain_text = "Contradictory"
    },
    (f) => {
      cell(f, 1, 1)[3].href = null
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("readback-only or coherent physical/readback changes cannot borrow original source authority", () => {
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace("<td>Name</td>", "<td>Other name</td>")
    },
    (f) => {
      f.actual = f.actual.replace("Keep the other cell.", "Discard the other cell.")
    },
    (f) => {
      f.actual = f.actual.replace("**keep**", "keep")
    },
    (f) => {
      f.actual = f.actual.replace(url, `${url}-other`)
    },
    (f) => {
      f.actual = f.actual.replace("\\<value\\>", "\\<other\\>")
      replace(cell(f, 1, 1)[0], "Read <other>, ")
    },
    (f) => {
      f.actual = f.actual.replace(url, `${url}-other`)
      cell(f, 1, 1)[3].text.link.url += "-other"
      cell(f, 1, 1)[3].href += "-other"
    },
    (f) => {
      f.source = f.source.replace("**keep**", "keep")
    },
    (f) => {
      f.source = f.source.replace("<value>", "<another>")
    },
    (f) => {
      f.actual = f.actual.replace("Finish here.", "Run a different command.")
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("complete physical ownership refuses missing, extra, reordered or foreign rows and wrong shape", () => {
  for (const alter of [
    (f) => {
      f.blocks.splice(4, 1)
    },
    (f) => {
      f.blocks.splice(
        5,
        0,
        block("extra", "table_row", { cells: [[rich("Extra")], [rich("row")]] }, "table"),
      )
    },
    (f) => {
      ;[f.blocks[3], f.blocks[4]] = [f.blocks[4], f.blocks[3]]
    },
    (f) => {
      f.blocks[4].parent.block_id = "foreign-table"
    },
    (f) => {
      f.blocks[4].id = "before"
    },
    (f) => {
      f.blocks[4].has_children = true
    },
    (f) => {
      f.blocks[4].archived = true
    },
    (f) => {
      f.blocks[4].in_trash = true
    },
    (f) => {
      f.blocks[2].table.table_width = 3
    },
    (f) => {
      f.blocks[2].table.has_column_header = false
    },
    (f) => {
      f.blocks[2].table.has_row_header = true
    },
    (f) => {
      f.blocks[4].table_row.cells.pop()
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("unsupported physical formatting and unknown table fields cannot create evidence", () => {
  for (const alter of [
    (f) => {
      cell(f, 1, 1)[0].annotations.italic = true
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.strikethrough = true
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.underline = true
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.color = "red"
    },
    (f) => {
      cell(f, 1, 1)[0].annotations.future = true
    },
    (f) => {
      cell(f, 1, 1)[0].type = "equation"
    },
    (f) => {
      f.blocks[2].table.future = true
    },
    (f) => {
      f.blocks[4].table_row.future = true
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(tree(f)?.find((root) => root.id === "table")?.table_evidence, undefined)
    assert.equal(matches(f), false)
  }
})

test("untrusted projected evidence rejects extra fields, duplicate IDs and detached row owners", () => {
  for (const alter of [
    (roots) => {
      roots[2].table_evidence.future = true
    },
    (roots) => {
      roots[2].table_evidence.rows[1].future = true
    },
    (roots) => {
      roots[2].table_evidence.rows[1].parent_id = "foreign"
    },
    (roots) => {
      roots[2].table_evidence.rows[1].id = "before"
    },
    (roots) => {
      roots[2].table_evidence.rows[1].table_row.cells[0][0].future = true
    },
    (roots) => {
      roots[2].table_evidence.rows = {}
    },
  ]) {
    const f = fixture(),
      roots = tree(f)
    alter(roots)
    assert.equal(samePublishedMarkdown(f.actual, f.source, undefined, roots), false)
  }
})
