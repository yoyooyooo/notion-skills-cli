import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { fromNotionMarkdown, markdownStructure, notionMarkdownForComparison } from "../src/index.ts"

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
const node = (id, type, spans, parent = "page", children = false, extra = {}) => ({
  id,
  type,
  has_children: children,
  archived: false,
  in_trash: false,
  parent: {
    type: parent === "page" ? "page_id" : "block_id",
    [parent === "page" ? "page_id" : "block_id"]: parent,
  },
  [type]: { rich_text: spans, color: "default", ...extra },
})
const tree = (blocks) => projectNotionBlockTree("page", blocks)
const matches = (fixture) =>
  samePublishedMarkdown(fixture.actual, fixture.source, undefined, tree(fixture.blocks))
const comparison = (fixture) =>
  notionMarkdownForComparison(fixture.actual, fixture.source, tree(fixture.blocks))
const plain = (id, type, value) => node(id, type, [rich(value)])

function spacedParagraph() {
  return {
    source: "# Tools\n\nCommand line tools \n\n## Commands\n\nRun a command.\n",
    actual: "# Tools\nCommand line tools\n## Commands\nRun a command.",
    blocks: [
      plain("before", "heading_1", "Tools"),
      plain("space", "paragraph", "Command line tools"),
      plain("after", "heading_2", "Commands"),
      plain("tail", "paragraph", "Run a command."),
    ],
  }
}

function quotedTable() {
  const source = [
    "# Instructions",
    "",
    "Read the complete procedure.",
    "",
    "> First `mode` boundary.",
    "",
    "> Complete quoted procedure.",
    ">",
    "> | Name | Action |",
    "> | --- | --- |",
    "> | `token` | Read the [manual](https://example.test/manual). |",
    ">",
    "> Use `check` before continuing.",
    ">",
    "> 1. Check the session.",
    "> 2. Keep the token.",
    "",
    "> Last `mode` boundary.",
    "",
    "Run this command:",
    "",
    "```bash",
    "tool status",
    "```",
    "",
  ].join("\n")
  const actual = [
    "# Instructions",
    "Read the complete procedure.",
    "> First `mode` boundary.",
    "> Complete quoted procedure.",
    '\t<table header-row="true">',
    "<tr>",
    "<td>Name</td>",
    "<td>Action</td>",
    "</tr>",
    "<tr>",
    "<td>`token`</td>",
    "<td>Read the [manual](https://example.test/manual).</td>",
    "</tr>",
    "\t</table>",
    "\tUse `check` before continuing.",
    "\t1. Check the session.",
    "\t2. Keep the token.",
    "> Last `mode` boundary.",
    "Run this command:",
    "```bash",
    "tool status",
    "```",
  ].join("\n")
  const blocks = [
    plain("title", "heading_1", "Instructions"),
    plain("before", "paragraph", "Read the complete procedure."),
    node("quote-before", "quote", [
      rich("First "),
      rich("mode", { code: true }),
      rich(" boundary."),
    ]),
    node("quote-tree", "quote", [rich("Complete quoted procedure.")], "page", true),
    node("table", "table", undefined, "quote-tree", true, {
      table_width: 2,
      has_column_header: true,
      has_row_header: false,
    }),
    node("header", "table_row", undefined, "table", false, {
      cells: [[rich("Name")], [rich("Action")]],
    }),
    node("row", "table_row", undefined, "table", false, {
      cells: [
        [rich("token", { code: true })],
        [rich("Read the "), rich("manual", { link: "https://example.test/manual" }), rich(".")],
      ],
    }),
    node(
      "inside",
      "paragraph",
      [rich("Use "), rich("check", { code: true }), rich(" before continuing.")],
      "quote-tree",
    ),
    node("one", "numbered_list_item", [rich("Check the session.")], "quote-tree"),
    node("two", "numbered_list_item", [rich("Keep the token.")], "quote-tree"),
    node("quote-after", "quote", [rich("Last "), rich("mode", { code: true }), rich(" boundary.")]),
    plain("after", "paragraph", "Run this command:"),
    node("code", "code", [rich("tool status")], "page", false, { language: "shell" }),
  ]
  return { actual, source, blocks }
}

function backtickLists() {
  return {
    source: [
      "# Code",
      "",
      "1. Before.",
      "2. Use `` `${item}` `` or `next()`.",
      "3. After.",
      "",
      "## Checklist",
      "",
      "- [ ] Before.",
      "- [ ] Use `` `${value}` ``.",
      "- [ ] After.",
      "",
      "## End",
      "",
    ].join("\n"),
    actual: [
      "# Code",
      "1. Before.",
      "2. Use `\\`${item}\\`` or `next()`.",
      "3. After.",
      "## Checklist",
      "- [ ] Before.",
      "- [ ] Use `\\`${value}\\``.",
      "- [ ] After.",
      "## End",
    ].join("\n"),
    blocks: [
      plain("heading", "heading_1", "Code"),
      plain("before", "numbered_list_item", "Before."),
      node("ticks", "numbered_list_item", [
        rich("Use "),
        rich("`${item}`", { code: true }),
        rich(" or "),
        rich("next()", { code: true }),
        rich("."),
      ]),
      plain("after", "numbered_list_item", "After."),
      plain("check-heading", "heading_2", "Checklist"),
      node("check-before", "to_do", [rich("Before.")], "page", false, { checked: false }),
      node(
        "check-ticks",
        "to_do",
        [rich("Use "), rich("`${value}`", { code: true }), rich(".")],
        "page",
        false,
        { checked: false },
      ),
      node("check-after", "to_do", [rich("After.")], "page", false, { checked: false }),
      plain("end", "heading_2", "End"),
    ],
  }
}

function backtickParagraph() {
  return {
    source: [
      "# Literal syntax",
      "",
      "Show `` `value` `` beside literal, then read the [manual](https://example.test/manual#syntax).",
      "",
      "| Name | Example |",
      "| --- | --- |",
      "| Text | Value |",
      "",
      "## End",
      "",
    ].join("\n"),
    actual: [
      "# Literal syntax",
      "Show `\\`value\\`` beside literal, then read the [manual](https://example.test/manual#syntax).",
      '<table header-row="true">',
      "<tr>",
      "<td>Name</td>",
      "<td>Example</td>",
      "</tr>",
      "<tr>",
      "<td>Text</td>",
      "<td>Value</td>",
      "</tr>",
      "</table>",
      "## End",
    ].join("\n"),
    blocks: [
      plain("title", "heading_1", "Literal syntax"),
      node("ticks", "paragraph", [
        rich("Show "),
        rich("`value`", { code: true }),
        rich(" beside "),
        rich("literal"),
        rich(", then read the "),
        rich("manual", { link: "https://example.test/manual#syntax" }),
        rich("."),
      ]),
      node("table", "table", undefined, "page", true, {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
      }),
      node("header", "table_row", undefined, "table", false, {
        cells: [[rich("Name")], [rich("Example")]],
      }),
      node("row", "table_row", undefined, "table", false, {
        cells: [[rich("Text")], [rich("Value")]],
      }),
      plain("end", "heading_2", "End"),
    ],
  }
}

function quoteAfterCode() {
  return {
    source: [
      "# Procedure",
      "",
      "```bash",
      "tool status",
      "```",
      "",
      "> Keep the session.",
      ">",
      "> Inspect the result.",
      ">",
      "> - Keep `first`.",
      "> - Keep `second`.",
      ">",
      "> Stop after checking.",
      "",
      "## Next",
      "",
      "Continue.",
      "",
    ].join("\n"),
    actual: [
      "# Procedure",
      "```bash",
      "tool status",
      "```",
      "> Keep the session.",
      "\tInspect the result.",
      "\t- Keep `first`.",
      "\t- Keep `second`.",
      "\tStop after checking.",
      "## Next",
      "Continue.",
    ].join("\n"),
    blocks: [
      plain("title", "heading_1", "Procedure"),
      node("code-before", "code", [rich("tool status")], "page", false, { language: "shell" }),
      node("quote", "quote", [rich("Keep the session.")], "page", true),
      node("inside", "paragraph", [rich("Inspect the result.")], "quote"),
      node(
        "first",
        "bulleted_list_item",
        [rich("Keep "), rich("first", { code: true }), rich(".")],
        "quote",
      ),
      node(
        "second",
        "bulleted_list_item",
        [rich("Keep "), rich("second", { code: true }), rich(".")],
        "quote",
      ),
      node("end", "paragraph", [rich("Stop after checking.")], "quote"),
      plain("after", "heading_2", "Next"),
      plain("tail", "paragraph", "Continue."),
    ],
  }
}

function leafQuoteSiblings(separated = false) {
  const first = "Read the [`guide.md`](guide.md) before continuing."
  const last = separated
    ? "\\[!CAUTION\\]<br>Keep `token`.<br>Stop after checking."
    : "Keep `token`."
  return {
    source: [
      "# Start",
      "",
      `> ${first}`,
      "",
      ...(separated ? ["A separate complete paragraph.", ""] : []),
      ...(separated
        ? ["> [!CAUTION]", "> Keep `token`.", "> Stop after checking."]
        : ["> Keep `token`."]),
      "",
      "## End",
      "",
      "Tail.",
      "",
    ].join("\n"),
    actual: [
      "# Start",
      `> ${first}`,
      ...(separated ? ["A separate complete paragraph."] : []),
      `> ${last}`,
      "## End",
      "Tail.",
    ].join("\n"),
    blocks: [
      plain("title", "heading_1", "Start"),
      node("first-quote", "quote", [
        rich("Read the "),
        rich("guide.md", { code: true, link: "guide.md" }),
        rich(" before continuing."),
      ]),
      ...(separated ? [plain("separate", "paragraph", "A separate complete paragraph.")] : []),
      node("last-quote", "quote", [
        rich(separated ? "[!CAUTION]\nKeep " : "Keep "),
        rich("token", { code: true }),
        rich(separated ? ".\nStop after checking." : "."),
      ]),
      plain("after", "heading_2", "End"),
      plain("tail", "paragraph", "Tail."),
    ],
  }
}

function nestedParentSpace() {
  return {
    source: [
      "# Meeting",
      "",
      "- Before.",
      "- If the meeting ended, use `detail`:  ",
      "  - Read the `meeting.id`.",
      "  - Keep `note_id` and the complete result.",
      "- After.",
      "",
      "## End",
      "",
    ].join("\n"),
    actual: [
      "# Meeting",
      "- Before.",
      "- If the meeting ended, use `detail`:",
      "\t- Read the `meeting.id`.",
      "\t- Keep `note_id` and the complete result.",
      "- After.",
      "## End",
    ].join("\n"),
    blocks: [
      plain("title", "heading_1", "Meeting"),
      plain("before", "bulleted_list_item", "Before."),
      node(
        "parent",
        "bulleted_list_item",
        [rich("If the meeting ended, use "), rich("detail", { code: true }), rich(":")],
        "page",
        true,
      ),
      node(
        "child-one",
        "bulleted_list_item",
        [rich("Read the "), rich("meeting.id", { code: true }), rich(".")],
        "parent",
      ),
      node(
        "child-two",
        "bulleted_list_item",
        [rich("Keep "), rich("note_id", { code: true }), rich(" and the complete result.")],
        "parent",
      ),
      plain("after", "bulleted_list_item", "After."),
      plain("end", "heading_2", "End"),
    ],
  }
}

test("two complete leaf quotes retain their distinct sibling boundary, including an independent middle paragraph", () => {
  for (const separated of [false, true]) {
    const f = leafQuoteSiblings(separated),
      before = JSON.stringify(f)
    assert.equal(matches(f), true)
    assert.equal(JSON.stringify(f), before)
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  }
})

test("leaf quote framing cannot conceal changed text, code, destinations, owners or sibling inventory", () => {
  for (const separated of [false, true])
    for (const alter of [
      (f) => {
        f.blocks[1].quote.rich_text[1].text.link.url = "other.md"
      },
      (f) => {
        f.blocks[1].quote.rich_text[1].annotations.code = false
      },
      (f) => {
        f.blocks[1].quote.rich_text[0].text.content = "Different text "
      },
      (f) => {
        f.blocks[1].parent.page_id = "foreign"
      },
      (f) => {
        f.blocks[1].has_children = true
      },
      (f) => {
        f.blocks.splice(2, 0, plain("extra", "paragraph", "Extra."))
      },
      (f) => {
        f.blocks[2].id = "first-quote"
      },
      (f) => {
        f.blocks[0].heading_1.rich_text[0].text.content = "Wrong start"
      },
      (f) => {
        f.blocks.at(-2).heading_2.rich_text[0].text.content = "Wrong end"
      },
      (f) => {
        f.actual = f.actual.replace("(guide.md)", "(other.md)")
      },
      (f) => {
        f.actual = f.actual.replace("Keep `token`", "Keep `other`")
      },
      (f) => {
        f.source = f.source.replace("before continuing", "after finishing")
      },
    ]) {
      const f = leafQuoteSiblings(separated)
      alter(f)
      assert.equal(matches(f), false)
    }
  const f = leafQuoteSiblings(true)
  f.blocks[2].paragraph.rich_text[0].text.content = "Changed middle paragraph."
  assert.equal(matches(f), false)
})

test("exact source parent spaces require the complete direct bullet subtree and leave all inputs unchanged", () => {
  const f = nestedParentSpace(),
    before = JSON.stringify(f)
  assert.equal(matches(f), true)
  const readback = fromNotionMarkdown(f.actual, tree(f.blocks))
  assert.equal(comparison(f), readback.replace("use `detail`:\n", "use `detail`:  \n"))
  assert.equal(JSON.stringify(f), before)
  assert.notDeepEqual(markdownStructure(f.actual), markdownStructure(f.source))
  assert.equal(
    samePublishedMarkdown(f.actual, f.source),
    true,
    "Semantic edge whitespace equality does not restore authored bytes",
  )
})

test("nested source space recovery requires exact edge bytes, inline content and a complete subtree", () => {
  for (const end of [" ", "   ", "\t", "\u00a0", " \t", "\ncontinued  "]) {
    const f = nestedParentSpace()
    f.source = f.source.replace("`detail`:  \n", "`detail`:" + end + "\n")
    assert.equal(comparison(f), undefined, JSON.stringify(end))
  }
  for (const alter of [
    (f) => {
      f.blocks.splice(3, 1)
    },
    (f) => {
      f.blocks.splice(5, 0, node("extra", "bulleted_list_item", [rich("Extra.")], "parent"))
    },
    (f) => {
      ;[f.blocks[3], f.blocks[4]] = [f.blocks[4], f.blocks[3]]
    },
    (f) => {
      f.blocks[3].parent.block_id = "other-parent"
    },
    (f) => {
      f.blocks[3].has_children = true
    },
    (f) => {
      f.blocks[3].id = "child-two"
    },
    (f) => {
      f.blocks[2].has_children = false
    },
    (f) => {
      f.blocks[3].bulleted_list_item.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[3].bulleted_list_item.rich_text[0].annotations.bold = true
    },
    (f) => {
      f.blocks[3].bulleted_list_item.rich_text[1].text.link = { url: "https://example.test/" }
    },
    (f) => {
      f.blocks[3].bulleted_list_item.rich_text[1].text.content = "different.id"
    },
  ]) {
    const f = nestedParentSpace()
    alter(f)
    assert.equal(comparison(f), undefined)
  }
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace("meeting.id", "different.id")
    },
    (f) => {
      f.source = f.source.replace("meeting.id", "different.id")
    },
    (f) => {
      f.source = f.source.replace("use `detail`", "use **detail**")
    },
  ]) {
    const f = nestedParentSpace()
    alter(f)
    assert.equal(comparison(f), undefined)
    assert.equal(
      matches(f),
      false,
      "Whitespace equivalence cannot conceal changed text or inline semantics",
    )
  }
  const changedSibling = nestedParentSpace()
  changedSibling.actual = changedSibling.actual.replace("- Before.", "- Changed before.")
  const readback = fromNotionMarkdown(changedSibling.actual, tree(changedSibling.blocks))
  assert.equal(
    comparison(changedSibling),
    readback.replace("use `detail`:\n", "use `detail`:  \n"),
    "A local space candidate must retain the separate changed sibling",
  )
  assert.equal(
    matches(changedSibling),
    false,
    "The caller still compares the complete candidate against the source",
  )
})

test("restores only one source-owned ASCII space at a proved plain paragraph boundary", () => {
  const f = spacedParagraph(),
    before = JSON.stringify(f)
  assert.equal(matches(f), true)
  const readback = fromNotionMarkdown(f.actual, tree(f.blocks))
  assert.equal(comparison(f), readback.replace("Command line tools\n", "Command line tools \n"))
  assert.equal(JSON.stringify(f), before)
  assert.equal(f.blocks[1].paragraph.rich_text[0].text.content, "Command line tools")
  assert.equal(f.actual.includes("tools "), false)
})

test("plain source space recovery excludes other whitespace, markup and changed text", () => {
  for (const replacement of [
    "Command line tools  ",
    "Command line tools\t",
    "Command line tools\u00a0",
  ]) {
    const f = spacedParagraph()
    f.source = f.source.replace("Command line tools ", replacement)
    assert.equal(comparison(f), undefined, JSON.stringify(replacement))
  }
  for (const replacement of [
    "Command line tools\ncontinued ",
    "`Command line tools `",
    "Other tools ",
  ]) {
    const f = spacedParagraph()
    f.source = f.source.replace("Command line tools ", replacement)
    assert.equal(comparison(f), undefined, JSON.stringify(replacement))
    assert.equal(matches(f), false, JSON.stringify(replacement))
  }
})

test("plain source space recovery requires complete unique physical ownership and both heading anchors", () => {
  for (const alter of [
    (f) => {
      f.blocks.splice(0, 1)
    },
    (f) => {
      f.blocks.splice(2, 1)
    },
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[1].parent.page_id = "foreign"
    },
    (f) => {
      f.blocks.splice(2, 0, structuredClone(f.blocks[1]))
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0].text.content = "Other tools"
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0].annotations.code = true
    },
  ]) {
    const f = spacedParagraph()
    alter(f)
    assert.equal(comparison(f), undefined)
  }
})

test("complete quote/table proof restores sibling and descendant readback boundaries", () => {
  const f = quotedTable(),
    before = JSON.stringify(f)
  const projected = tree(f.blocks)
  assert.equal(projected.find((block) => block.id === "quote-tree").quote_descendants.length, 6)
  assert.equal(matches(f), true)
  assert.equal(JSON.stringify(f), before)
})

test("quote/table proof refuses missing, extra, reordered, repeated or foreign descendants", () => {
  const alterations = [
    (f) => {
      f.blocks.splice(6, 1)
    },
    (f) => {
      f.blocks.splice(7, 0, node("extra", "paragraph", [rich("Extra")], "quote-tree"))
    },
    (f) => {
      ;[f.blocks[5], f.blocks[6]] = [f.blocks[6], f.blocks[5]]
    },
    (f) => {
      f.blocks[6].parent.block_id = "quote-tree"
    },
    (f) => {
      f.blocks[6].id = "header"
    },
    (f) => {
      f.blocks[4].has_children = false
    },
    (f) => {
      f.blocks[6].has_children = true
    },
    (f) => {
      f.blocks[7].type = "callout"
    },
    (f) => {
      f.blocks[4].table.table_width = 3
    },
    (f) => {
      f.blocks[4].table.has_row_header = true
    },
    (f) => {
      f.blocks[4].table.has_column_header = false
    },
    (f) => {
      f.blocks[6].archived = true
    },
  ]
  for (const alter of alterations) {
    const f = quotedTable()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("quote/table proof keeps exact inline code, complete destinations, rows and list order", () => {
  for (const alter of [
    (f) => {
      f.blocks[6].table_row.cells[1][1].text.link.url = "https://example.test/elsewhere"
    },
    (f) => {
      f.blocks[6].table_row.cells[0][0].annotations.code = false
    },
    (f) => {
      f.blocks[6].table_row.cells[0][0].text.content = "other-token"
    },
    (f) => {
      ;[f.blocks[8], f.blocks[9]] = [f.blocks[9], f.blocks[8]]
    },
    (f) => {
      f.blocks[8].numbered_list_item.list_start_index = 2
    },
    (f) => {
      f.actual = f.actual.replace("<td>Name</td>", "<td>Other</td>")
    },
    (f) => {
      f.actual = f.actual.replace("\t</table>", "\t</table>\n\tExtra text.")
    },
    (f) => {
      f.source = f.source.replace("https://example.test/manual", "https://example.test/elsewhere")
    },
    (f) => {
      f.source = f.source.replace("Last `mode` boundary.", "Last `changed` boundary.")
    },
  ]) {
    const f = quotedTable()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("quote/table proof requires both adjacent ordinary paragraphs and unique quote run", () => {
  for (const alter of [
    (f) => {
      f.blocks.splice(1, 1)
    },
    (f) => {
      f.blocks.splice(11, 1)
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0].text.content = "Different anchor."
    },
    (f) => {
      f.blocks[11].paragraph.rich_text[0].text.content = "Different ending."
    },
    (f) => {
      f.actual = f.actual.replace(
        "> Last `mode` boundary.",
        "> Last `mode` boundary.\n> Last `mode` boundary.",
      )
    },
  ]) {
    const f = quotedTable()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("quote descendants retain exact code-fence anchors and every paragraph/list boundary", () => {
  const f = quoteAfterCode(),
    before = JSON.stringify(f)
  assert.equal(matches(f), true)
  assert.equal(JSON.stringify(f), before)
})

test("quote code anchors reject changed bytes, language, missing owner, extra or reordered children", () => {
  for (const alter of [
    (f) => {
      f.blocks[1].code.rich_text[0].text.content = "tool reset"
    },
    (f) => {
      f.blocks[1].code.language = "python"
    },
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[1].parent.page_id = "foreign"
    },
    (f) => {
      f.actual = f.actual.replace("```bash", "```python")
    },
    (f) => {
      f.actual = f.actual.replace("tool status", "tool reset")
    },
    (f) => {
      f.actual = f.actual.replace("\tStop after checking.", "\tStop after checking.\n\tExtra.")
    },
    (f) => {
      ;[f.blocks[4], f.blocks[5]] = [f.blocks[5], f.blocks[4]]
    },
    (f) => {
      f.blocks.splice(3, 1)
    },
    (f) => {
      f.source = f.source.replace("> - Keep `second`.", "> - Keep `changed`.")
    },
  ]) {
    const f = quoteAfterCode()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("quote readback permits only a physical root-URL serializer slash and keeps source link policy", () => {
  const fixture = () => {
    const f = quotedTable()
    f.source = f.source.replace("First `mode` boundary.", "Open example.test.")
    f.actual = f.actual.replace(
      "First `mode` boundary.",
      "Open [example.test](http://example.test).",
    )
    f.blocks[2].quote.rich_text = [
      rich("Open "),
      rich("example.test", { link: "http://example.test/" }),
      rich("."),
    ]
    return f
  }
  assert.equal(matches(fixture()), true)
  for (const url of [
    "https://example.test",
    "http://other.test",
    "http://example.test:80",
    "http://example.test/path",
    "http://example.test?query",
    "http://example.test#anchor",
    "http://user@example.test",
    "http://Example.test",
  ]) {
    const f = fixture()
    f.actual = f.actual.replace("(http://example.test)", `(${url})`)
    assert.equal(matches(f), false, url)
  }
  const explicit = fixture()
  explicit.source = explicit.source.replace(
    "Open example.test.",
    "Open [example.test](http://example.test/).",
  )
  assert.equal(matches(explicit), false, "two explicit source/readback destinations remain strict")
})

test("backtick code spans require exact source and retained physical list or task content", () => {
  const f = backtickLists()
  assert.equal(matches(f), true)
  assert.equal(f.blocks[2].numbered_list_item.rich_text[1].text.content, "`${item}`")
  assert.equal(f.blocks[6].to_do.rich_text[1].text.content, "`${value}`")
})

test("backtick candidates do not repair code bytes, links, tasks, missing blocks or plaintext", () => {
  for (const alter of [
    (f) => {
      f.blocks[2].numbered_list_item.rich_text[1].text.content = "`${other}`"
    },
    (f) => {
      f.blocks[2].numbered_list_item.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[2].numbered_list_item.rich_text[1].text.link = { url: "https://example.test" }
    },
    (f) => {
      f.blocks[6].to_do.checked = true
    },
    (f) => {
      delete f.blocks[6].to_do.checked
    },
    (f) => {
      f.blocks.splice(3, 1)
    },
    (f) => {
      f.blocks[2].has_children = true
    },
    (f) => {
      f.source = f.source.replace("`${value}`", "`${changed}`")
    },
    (f) => {
      f.actual = f.actual.replace("2. Use", "2. Changed")
    },
  ]) {
    const f = backtickLists()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("paragraph backticks use the untouched readback position and exact complete physical inline content", () => {
  const f = backtickParagraph(),
    before = JSON.stringify(f)
  assert.equal(matches(f), true)
  assert.equal(JSON.stringify(f), before)
})

test("paragraph backticks reject physical string, code, destination, ownership and sibling drift", () => {
  for (const alter of [
    (f) => {
      f.blocks[1].paragraph.rich_text[1].text.content = "`other`"
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].text.link = { url: "https://example.test" }
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[5].text.link.url = "https://example.test/manual#other"
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0].text.content = "Discard "
    },
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[1].parent.page_id = "foreign"
    },
    (f) => {
      f.blocks.splice(0, 1)
    },
    (f) => {
      f.blocks.splice(2, 3)
    },
    (f) => {
      f.source = f.source.replace("`value`", "`different`")
    },
    (f) => {
      f.actual = f.actual.replace("beside", "instead of")
    },
  ]) {
    const f = backtickParagraph()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("paragraph backtick decoding cannot hide a change in any neighboring table cell", () => {
  for (const value of ["Name", "Example", "Text", "Value"]) {
    const f = backtickParagraph()
    f.actual = f.actual.replace(`<td>${value}</td>`, `<td>Changed ${value}</td>`)
    for (const block of f.blocks.filter((block) => block.type === "table_row")) {
      for (const cell of block.table_row.cells)
        for (const span of cell) {
          if (span.text.content === value) span.text.content = span.plain_text = `Changed ${value}`
        }
    }
    assert.equal(matches(f), false, value)
  }
})

test("paragraph backticks need a unique source leaf and complete physical boundary evidence", () => {
  const original = backtickParagraph()
  assert.equal(samePublishedMarkdown(original.actual, original.source), false)
  const f = backtickParagraph()
  f.source +=
    "\nShow `` `value` `` beside literal, then read the [manual](https://example.test/manual#syntax).\n"
  assert.equal(matches(f), false)
})

test("readback candidates cannot hide a separate real equation conversion", () => {
  const f = backtickLists()
  f.source += "\nKeep $first and $second literal.\n"
  f.actual += "\nKeep $`first and ` $second literal."
  f.blocks.push(
    node("equation", "paragraph", [
      rich("Keep "),
      { type: "equation", equation: { expression: "first and " }, plain_text: "first and " },
      rich("second literal."),
    ]),
  )
  assert.equal(matches(f), false)
})

test("semantic whitespace equality grants no source-byte recovery without physical boundary evidence", () => {
  for (const f of [spacedParagraph(), nestedParentSpace()]) {
    assert.notDeepEqual(markdownStructure(f.actual), markdownStructure(f.source))
    assert.equal(samePublishedMarkdown(f.actual, f.source), true)
    assert.equal(notionMarkdownForComparison(f.actual, f.source, []), undefined)
  }
  for (const f of [quotedTable(), backtickLists()]) {
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
    assert.equal(notionMarkdownForComparison(f.actual, f.source, []), undefined)
  }
})
