import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { notionMarkdownForComparison } from "../src/index.ts"

const rich = (content, { link, ...annotations } = {}) => ({
  type: "text",
  text: {
    content,
    link: link ? { url: link } : null,
  },
  plain_text: content,
  href: link ?? null,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...annotations,
  },
})
const node = (id, type, parent, children, body) => ({
  id,
  type,
  has_children: children,
  archived: false,
  in_trash: false,
  parent: {
    type: parent === "page" ? "page_id" : "block_id",
    [parent === "page" ? "page_id" : "block_id"]: parent,
  },
  [type]: body,
})
const leaf = (id, type, text) => node(id, type, "page", false, { rich_text: [rich(text)] })
const tree = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, tree(f))

function fixture(ordered = true) {
  const type = ordered ? "numbered_list_item" : "bulleted_list_item"
  const one = ordered ? "1." : "-",
    two = ordered ? "2." : "-",
    three = ordered ? "3." : "-"
  const indent = " ".repeat(two.length + 1)
  return {
    source: [
      "# Rules",
      "",
      "Keep the original mapping.",
      "",
      `${one} Before.`,
      `${two} **Status mapping**:`,
      "",
      `${indent}| Value | Action |`,
      `${indent}| --- | --- |`,
      `${indent}| \`accept\` | Read the [manual](https://example.test/manual). |`,
      "",
      `${three} After.`,
      "",
      "## End",
      "",
      "Complete.",
      "",
    ].join("\n"),
    actual: [
      "# Rules",
      "Keep the original mapping.",
      `${one} Before.`,
      `${two} **Status mapping**:`,
      '\t<table header-row="true">',
      "<tr>",
      "<td>Value</td>",
      "<td>Action</td>",
      "</tr>",
      "<tr>",
      "<td>`accept`</td>",
      "<td>Read the [manual](https://example.test/manual).</td>",
      "</tr>",
      "\t</table>",
      `${three} After.`,
      "## End",
      "Complete.",
    ].join("\n"),
    blocks: [
      leaf("title", "heading_1", "Rules"),
      leaf("before", "paragraph", "Keep the original mapping."),
      leaf("one", type, "Before."),
      node("owner", type, "page", true, {
        rich_text: [rich("Status mapping", { bold: true }), rich(":")],
      }),
      node("table", "table", "owner", true, {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
      }),
      node("header", "table_row", "table", false, { cells: [[rich("Value")], [rich("Action")]] }),
      node("row", "table_row", "table", false, {
        cells: [
          [rich("accept", { code: true })],
          [rich("Read the "), rich("manual", { link: "https://example.test/manual" }), rich(".")],
        ],
      }),
      leaf("three", type, "After."),
      leaf("after", "heading_2", "End"),
      leaf("tail", "paragraph", "Complete."),
    ],
  }
}

for (const ordered of [true, false])
  test(`complete ${ordered ? "ordered" : "bullet"} list table restores only its container layout`, () => {
    const f = fixture(ordered),
      before = JSON.stringify(f),
      blocks = tree(f)
    assert.equal(blocks.find((block) => block.id === "owner").list_table_descendants.length, 3)
    assert.equal(blocks.find((block) => block.id === "owner").descendants, undefined)
    assert.equal(matches(f), true)
    const candidate = notionMarkdownForComparison(f.actual, f.source, blocks)
    assert.ok(candidate.includes("<td>`accept`</td>"))
    assert.ok(candidate.includes("<td>Read the [manual](https://example.test/manual).</td>"))
    assert.equal(JSON.stringify(f), before)
    const without = blocks.map(({ list_table_descendants, ...block }) => block)
    assert.equal(samePublishedMarkdown(f.actual, f.source, undefined, without), false)
  })

test("a same-content sibling table cannot supply nested list ownership", () => {
  const f = fixture()
  f.blocks[3].has_children = false
  f.blocks[4].parent = { type: "page_id", page_id: "page" }
  assert.equal(matches(f), false)
  assert.equal(tree(f).find((block) => block.id === "owner").list_table_descendants, undefined)
})

test("complete table proof refuses missing, extra, reordered, repeated or foreign physical members", () => {
  const changes = [
    (f) => {
      f.blocks.splice(6, 1)
    },
    (f) => {
      f.blocks.splice(
        7,
        0,
        node("extra", "table_row", "table", false, { cells: [[rich("extra")], [rich("cell")]] }),
      )
    },
    (f) => {
      ;[f.blocks[5], f.blocks[6]] = [f.blocks[6], f.blocks[5]]
    },
    (f) => {
      f.blocks[6].id = "header"
    },
    (f) => {
      f.blocks[4].parent.block_id = "one"
    },
    (f) => {
      f.blocks[6].parent.block_id = "owner"
    },
    (f) => {
      f.blocks[4].table.table_width = 3
    },
    (f) => {
      f.blocks[4].table.has_column_header = false
    },
    (f) => {
      f.blocks[4].table.has_row_header = true
    },
    (f) => {
      f.blocks[6].has_children = true
    },
    (f) => {
      f.blocks[6].archived = true
    },
    (f) => {
      f.blocks.splice(
        7,
        0,
        node("invisible", "paragraph", "owner", false, { rich_text: [rich("Extra")] }),
      )
    },
    (f) => {
      f.blocks.splice(7, 0, leaf("extra-root", "paragraph", "Extra root"))
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("table decoding preserves every cell, code span, explicit URL and source identity", () => {
  const changes = [
    (f) => {
      f.actual = f.actual.replace("<td>Value</td>", "<td>Other</td>")
    },
    (f) => {
      f.actual = f.actual.replace("<td>`accept`</td>", "<td>accept</td>")
    },
    (f) => {
      f.blocks[6].table_row.cells[0][0].annotations.code = false
    },
    (f) => {
      f.blocks[6].table_row.cells[1][1].annotations.underline = true
    },
    (f) => {
      f.blocks[6].table_row.cells[1][1].text.link.url = "https://example.test/changed"
    },
    (f) => {
      f.source = f.source.replace("https://example.test/manual", "https://example.test/manual#part")
    },
    (f) => {
      f.actual = f.actual.replace("https://example.test/manual", "http://example.test/manual")
    },
    (f) => {
      f.actual = f.actual.replace("https://example.test/manual", "https://example.test:443/manual")
    },
    (f) => {
      f.source = f.source.replace("`accept`", "`decline`")
    },
    (f) => {
      f.actual = f.actual.replace("\t</table>", "\t</table>\nExtra text.")
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("the entire list run and both exact root anchors must agree", () => {
  const changes = [
    (f) => {
      f.blocks.splice(1, 1)
    },
    (f) => {
      f.blocks.splice(8, 1)
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0].text.content = "Different anchor."
    },
    (f) => {
      f.blocks[7].numbered_list_item.rich_text[0].text.content = "Changed item."
    },
    (f) => {
      f.blocks[7].has_children = true
    },
    (f) => {
      f.actual = f.actual.replace("1. Before.", "1. Before.\n1. Before.")
    },
    (f) => {
      f.source = f.source.replace("3. After.", "3. Different.")
    },
    (f) => {
      f.actual = f.actual.replace("3. After.", "4. After.")
    },
    (f) => {
      ;[f.blocks[2], f.blocks[3]] = [f.blocks[3], f.blocks[2]]
    },
  ]
  for (const change of changes) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("numeric zero and unproved restarted numbering never gain table authority", () => {
  for (const change of [
    (f) => {
      f.blocks[2].numbered_list_item.list_start_index = 0
    },
    (f) => {
      f.blocks[3].numbered_list_item.list_start_index = 0
    },
    (f) => {
      f.blocks[3].numbered_list_item.list_start_index = 1
    },
    (f) => {
      f.source = f.source.replace("1. Before.", "0. Before.")
    },
    (f) => {
      f.actual = f.actual.replace("1. Before.", "0. Before.")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

const secondTableRaw = [
  '\t<table header-row="true">',
  "<tr>",
  "<td>Kind</td>",
  "<td>Note</td>",
  "</tr>",
  "<tr>",
  "<td>`notes`</td>",
  "<td>Read [details](https://example.test/details?q=1#part).</td>",
  "</tr>",
  "\t</table>",
].join("\n")

function twoTableFixture(ordered = false) {
  const value = fixture(ordered)
  const third = ordered ? "3." : "-",
    indent = ordered ? "   " : "  "
  const sourceTable = [
    `${indent}| Kind | Note |`,
    `${indent}| --- | --- |`,
    `${indent}| \`notes\` | Read [details](https://example.test/details?q=1#part). |`,
  ].join("\n")
  value.source = value.source.replace(`\n${third} After.\n`, `\n${sourceTable}\n`)
  value.actual = value.actual.replace(`\n${third} After.\n`, `\n${secondTableRaw}\n`)
  const at = value.blocks.findIndex((block) => block.id === "three")
  assert.ok(at >= 0)
  value.blocks.splice(
    at,
    1,
    node("table-two", "table", "owner", true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
    node("header-two", "table_row", "table-two", false, {
      cells: [[rich("Kind")], [rich("Note")]],
    }),
    node("row-two", "table_row", "table-two", false, {
      cells: [
        [rich("notes", { code: true })],
        [
          rich("Read "),
          rich("details", { link: "https://example.test/details?q=1#part" }),
          rich("."),
        ],
      ],
    }),
  )
  return value
}

function twoTableBlock(value, id) {
  const block = value.blocks.find((block) => block.id === id)
  assert.ok(block, id)
  return block
}

function rejectTwoTables(cases) {
  for (const [label, change] of cases) {
    const value = twoTableFixture()
    change(value)
    assert.equal(matches(value), false, label)
  }
}

test("two complete direct tables retain their separate list-item boundaries", () => {
  for (const ordered of [false, true]) {
    const value = twoTableFixture(ordered),
      before = JSON.stringify(value)
    const owner = tree(value).find((block) => block.id === "owner")
    assert.equal(owner?.list_table_descendants?.filter((block) => block.type === "table").length, 2)
    assert.equal(matches(value), true)
    assert.equal(JSON.stringify(value), before)
  }
})

test("two table evidence consumes every row under its exact direct owner", () => {
  rejectTwoTables([
    [
      "missing second table",
      (value) => {
        value.blocks = value.blocks.filter(
          (block) => !["table-two", "header-two", "row-two"].includes(block.id),
        )
      },
    ],
    [
      "row borrowed from first table",
      (value) => {
        twoTableBlock(value, "row-two").parent.block_id = "table"
      },
    ],
    [
      "second table belongs to a different list item",
      (value) => {
        twoTableBlock(value, "table-two").parent.block_id = "one"
      },
    ],
    [
      "empty intermediate paragraph is not a table separator",
      (value) => {
        const at = value.blocks.findIndex((block) => block.id === "table-two")
        value.blocks.splice(
          at,
          0,
          node("hidden-between", "paragraph", "owner", false, { rich_text: [] }),
        )
      },
    ],
    [
      "third direct table is outside the bounded shape",
      (value) => {
        const at = value.blocks.findIndex((block) => block.id === "after")
        value.blocks.splice(
          at,
          0,
          node("table-three", "table", "owner", true, {
            table_width: 1,
            has_column_header: true,
            has_row_header: false,
          }),
          node("header-three", "table_row", "table-three", false, { cells: [[rich("Extra")]] }),
        )
      },
    ],
    [
      "second table row order differs",
      (value) => {
        const at = value.blocks.findIndex((block) => block.id === "header-two")
        value.blocks.splice(at, 2, value.blocks[at + 1], value.blocks[at])
      },
    ],
  ])
})

test("the second table must follow the exact first closing with complete readback lines", () => {
  rejectTwoTables([
    [
      "missing second table readback",
      (value) => {
        value.actual = value.actual.replace(`\n${secondTableRaw}`, "")
      },
    ],
    [
      "nonempty intermediate line",
      (value) => {
        value.actual = value.actual.replace(
          "\t</table>\n\t<table",
          "\t</table>\nUnaccounted text.\n\t<table",
        )
      },
    ],
    [
      "unproved blank before second opening",
      (value) => {
        value.actual = value.actual.replace("\t</table>\n\t<table", "\t</table>\n\n\t<table")
      },
    ],
    [
      "different second opening indentation",
      (value) => {
        value.actual = value.actual.replace(
          `\n${secondTableRaw}`,
          `\n${secondTableRaw.replace(/^\t/, "  ")}`,
        )
      },
    ],
    [
      "missing second table cell",
      (value) => {
        value.actual = value.actual.replace("<td>Note</td>\n", "")
      },
    ],
    [
      "additional row inside first table",
      (value) => {
        value.actual = value.actual.replace(
          "\t</table>",
          "<tr>\n<td>Extra</td>\n<td>Row</td>\n</tr>\n\t</table>",
        )
      },
    ],
  ])
})

test("both table bodies and explicit link query and fragment remain exact", () => {
  rejectTwoTables([
    [
      "first table Markdown changed",
      (value) => {
        value.actual = value.actual.replace("`accept`", "`reject`")
      },
    ],
    [
      "first table source changed",
      (value) => {
        value.source = value.source.replace("`accept`", "`reject`")
      },
    ],
    [
      "second table readback query changed",
      (value) => {
        value.actual = value.actual.replace("details?q=1#part", "details?q=2#part")
      },
    ],
    [
      "second table readback fragment changed",
      (value) => {
        value.actual = value.actual.replace("details?q=1#part", "details?q=1#other")
      },
    ],
    [
      "second table source destination changed",
      (value) => {
        value.source = value.source.replace("details?q=1#part", "details?q=2#part")
      },
    ],
    [
      "second table physical destination changed",
      (value) => {
        const link = twoTableBlock(value, "row-two").table_row.cells[1][1]
        link.text.link.url = "https://example.test/details?q=1#other"
        link.href = link.text.link.url
      },
    ],
    [
      "source and readback agree but physical second cell differs",
      (value) => {
        value.source = value.source.replace("`notes`", "`other`")
        value.actual = value.actual.replace("`notes`", "`other`")
      },
    ],
  ])
})

test("two table recovery preserves the complete list and both outside anchors", () => {
  rejectTwoTables([
    [
      "list head changed",
      (value) => {
        value.actual = value.actual.replace("**Status mapping**:", "**Changed mapping**:")
      },
    ],
    [
      "previous list item missing",
      (value) => {
        value.actual = value.actual.replace("- Before.\n", "")
      },
    ],
    [
      "preceding paragraph changed",
      (value) => {
        value.actual = value.actual.replace("Keep the original mapping.", "Different mapping.")
      },
    ],
    [
      "following heading changed",
      (value) => {
        value.actual = value.actual.replace("## End", "## Changed")
      },
    ],
    [
      "extra root before following heading",
      (value) => {
        value.actual = value.actual.replace("## End", "Unaccounted root.\n## End")
      },
    ],
    [
      "second source table omitted",
      (value) => {
        value.source = value.source.replace(
          /  \| Kind \| Note \|\n  \| --- \| --- \|\n  \|[^\n]+\|\n/,
          "",
        )
      },
    ],
  ])
})

function terminalFixture() {
  const row = (id, parent, cells) => node(id, "table_row", parent, false, { cells })
  const cell = (text) => (text === "" ? [] : [rich(text)])
  return {
    source: [
      "## State after the pass",
      "",
      "- **Releases.** 1.0.71 (`abc`) remains.",
      "- **Final scores**, lower of the two critics:",
      "",
      "  | | Page | Play |",
      "  | --- | --- | --- |",
      "  | Quick | 5 | 6 |",
      "",
      "- **Faults both critics name**, all body and timing:",
      "  - Knight:",
      "    - The salute remains.",
      "  - Done.",
    ].join("\n"),
    actual: [
      "## State after the pass",
      "- **Releases.** 1.0.71 (`abc`) remains.",
      "- **Final scores**, lower of the two critics:",
      '\t<table header-row="true">',
      "<tr>",
      "<td></td>",
      "<td>Page</td>",
      "<td>Play</td>",
      "</tr>",
      "<tr>",
      "<td>Quick</td>",
      "<td>5</td>",
      "<td>6</td>",
      "</tr>",
      "\t</table>",
      "- **Faults both critics name**, all body and timing:",
      "\t- Knight:",
      "\t\t- The salute remains.",
      "\t- Done.",
    ].join("\n"),
    blocks: [
      leaf("state", "heading_2", "State after the pass"),
      node("releases", "bulleted_list_item", "page", false, {
        rich_text: [
          rich("Releases.", { bold: true }),
          rich(" 1.0.71 ("),
          rich("abc", { code: true }),
          rich(") remains."),
        ],
      }),
      node("scores", "bulleted_list_item", "page", true, {
        rich_text: [rich("Final scores", { bold: true }), rich(", lower of the two critics:")],
      }),
      node("table", "table", "scores", true, {
        table_width: 3,
        has_column_header: true,
        has_row_header: false,
      }),
      row("header", "table", [cell(""), cell("Page"), cell("Play")]),
      row("body", "table", [cell("Quick"), cell("5"), cell("6")]),
      node("faults", "bulleted_list_item", "page", true, {
        rich_text: [
          rich("Faults both critics name", { bold: true }),
          rich(", all body and timing:"),
        ],
      }),
      node("knight", "bulleted_list_item", "faults", true, { rich_text: [rich("Knight:")] }),
      node("salute", "bulleted_list_item", "knight", false, {
        rich_text: [rich("The salute remains.")],
      }),
      node("done", "bulleted_list_item", "faults", false, { rich_text: [rich("Done.")] }),
    ],
  }
}

test("a terminal nested table keeps its empty header cell and following list", () => {
  const value = terminalFixture(),
    before = JSON.stringify(value)
  assert.equal(matches(value), true)
  const candidate = notionMarkdownForComparison(value.actual, value.source, tree(value))
  assert.match(
    candidate,
    / {2}<table header-row="true">\n {2}<tr>\n {2}<td><\/td>\n {2}<td>Page<\/td>/,
  )
  assert.equal(JSON.stringify(value), before)
  for (const change of [
    (current) => {
      current.actual = current.actual.replace("<td>5</td>", "<td>9</td>")
    },
    (current) => {
      current.actual = current.actual.replace("<td></td>\n", "")
    },
    (current) => {
      current.blocks.find((block) => block.id === "header").table_row.cells[0] = [rich("Name")]
    },
    (current) => {
      current.actual = current.actual.replace("\t\t- The salute remains.\n", "")
    },
  ]) {
    const current = terminalFixture()
    change(current)
    assert.equal(matches(current), false)
  }
})
