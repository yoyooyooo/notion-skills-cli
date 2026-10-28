import assert from "node:assert/strict"
import test from "node:test"
import { notionMarkdownForComparison, samePublishedMarkdown } from "../../core/src/markdown.ts"

const span = (text, code = false, link = null) => ({ text, code, link, bold: false })
const leaf = (id, type, rich_text) => ({ id, type, has_children: false, rich_text })
const child = (id, parent_id, type, rich_text) => ({ ...leaf(id, type, rich_text), parent_id })
const destination = "https://example.test/manual#query"

function tableQuote() {
  const table = {
    id: "table",
    type: "table",
    has_children: true,
    table_evidence: {
      width: 2,
      header_row: true,
      header_column: false,
      rows: [
        {
          id: "header",
          parent_id: "table",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[span("Field")], [span("Meaning")]] },
        },
        {
          id: "row",
          parent_id: "table",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[span("id", true)], [span("Keep the identifier.")]] },
        },
      ],
    },
  }
  const quote = {
    ...leaf("quote", "quote", [span("Shortcut:")]),
    has_children: true,
    quote_descendants: [
      child("shortcut", "quote", "bulleted_list_item", [
        span("lookup", true),
        span(" "),
        span("manual", false, destination),
      ]),
      child("api", "quote", "paragraph", [span("API:")]),
      child("list", "quote", "bulleted_list_item", [
        span("items.list", true),
        span(" — list records"),
      ]),
      child("get", "quote", "bulleted_list_item", [
        span("items.get", true),
        span(" — read one record"),
      ]),
    ],
  }
  return {
    source: `# Fields\n\n| Field | Meaning |\n|---|---|\n| \`id\` | Keep the identifier. |\n\n> Shortcut:\n>\n> - \`lookup\` [manual](${destination})\n>\n> API:\n>\n> - \`items.list\` — list records\n> - \`items.get\` — read one record\n\n---\n\n## Finish\n`,
    actual: `# Fields\n<table header-row="true">\n<tr>\n<td>Field</td>\n<td>Meaning</td>\n</tr>\n<tr>\n<td>\`id\`</td>\n<td>Keep the identifier.</td>\n</tr>\n</table>\n> Shortcut:\n\t- \`lookup\` [manual](${destination})\n\tAPI:\n\t- \`items.list\` — list records\n\t- \`items.get\` — read one record\n---\n## Finish`,
    blocks: [
      leaf("heading", "heading_1", [span("Fields")]),
      table,
      quote,
      { id: "divider", type: "divider", has_children: false },
      leaf("finish", "heading_2", [span("Finish")]),
    ],
  }
}

function separatedQuotes(list = false) {
  const tail = list
    ? [
        child("query-a", "query", "bulleted_list_item", [span("Query "), span("items.list", true)]),
        child("query-b", "query", "bulleted_list_item", [span("Read "), span("items.get", true)]),
      ]
    : [
        child("query-detail", "query", "paragraph", [
          span("Keep "),
          span("target", true),
          span(" and "),
          span("status", true),
          span(" unchanged."),
        ]),
      ]
  const quoteLine = `> Query [manual](${destination}) first.`
  const sourceChildren = list
    ? "> - Query `items.list`\n> - Read `items.get`"
    : "> Keep `target` and `status` unchanged."
  const actualChildren = list
    ? "\t- Query `items.list`\n\t- Read `items.get`"
    : "\tKeep `target` and `status` unchanged."
  return {
    source: `# Start\n\n> Read [shared](../shared.md).\n\nThis instruction is a separate paragraph.\n\n${quoteLine}\n>\n${sourceChildren}\n\n${list ? "## Finish" : "---\n\n## Finish"}\n`,
    actual: `# Start\n> Read [shared](../shared.md).\nThis instruction is a separate paragraph.\n${quoteLine}\n${actualChildren}\n${list ? "## Finish" : "---\n## Finish"}`,
    blocks: [
      leaf("start", "heading_1", [span("Start")]),
      leaf("first", "quote", [span("Read "), span("shared", false, "../shared.md"), span(".")]),
      leaf("separate", "paragraph", [span("This instruction is a separate paragraph.")]),
      {
        ...leaf("query", "quote", [
          span("Query "),
          span("manual", false, destination),
          span(" first."),
        ]),
        has_children: true,
        quote_descendants: tail,
      },
      ...(list ? [] : [{ id: "divider", type: "divider", has_children: false }]),
      leaf("finish", "heading_2", [span("Finish")]),
    ],
  }
}
const matches = (fixture) =>
  samePublishedMarkdown(fixture.actual, fixture.source, undefined, fixture.blocks)

test("the complete table/quote/divider interval retains every quote child after a lifted list", () => {
  const f = tableQuote(),
    before = structuredClone(f)
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  assert.equal(matches(f), true)
  assert.deepEqual(f, before)
})

test("a separate physical paragraph between two quotes stays outside both complete quotes", () => {
  for (const list of [false, true]) {
    const f = separatedQuotes(list),
      before = structuredClone(f)
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
    assert.equal(matches(f), true, `child list: ${list}`)
    assert.deepEqual(f, before)
  }
})

test("a paragraph after one leaf quote remains outside the quote", () => {
  const f = {
    source:
      "## Example\n\n> Keep the quoted instruction.\n\nKeep this explanation separate.\n\n---\n",
    actual: "## Example\n> Keep the quoted instruction.\nKeep this explanation separate.\n---\n",
    blocks: [
      leaf("heading", "heading_2", [span("Example")]),
      leaf("quote", "quote", [span("Keep the quoted instruction.")]),
      leaf("explanation", "paragraph", [span("Keep this explanation separate.")]),
      { id: "divider", type: "divider", has_children: false },
    ],
  }
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  assert.equal(matches(f), true)
  for (const change of [
    (value) => {
      value.actual = value.actual.replace("explanation", "changed explanation")
    },
    (value) => {
      value.blocks[2].rich_text[0].text = "Different explanation."
    },
    (value) => {
      value.blocks[2].has_children = true
    },
  ]) {
    const altered = structuredClone(f)
    change(altered)
    assert.equal(matches(altered), false)
  }
  const moved = structuredClone(f)
  moved.source = moved.source.replace("\n\nKeep this", "\n>\n> Keep this")
  // Both raw strings already parse as one lazy quote. The physical decoder
  // must not provide a source-bound repair for that different ownership.
  assert.equal(notionMarkdownForComparison(moved.actual, moved.source, moved.blocks), undefined)
})
test("plain paragraphs between adjacent leaf quotes stay outside every quote", () => {
  const label = (id, text) => leaf(id, "paragraph", [{ ...span(text), bold: true }])
  const quote = (id, text) => leaf(id, "quote", [span(text)])
  const f = {
    source: [
      "## Examples",
      "",
      "**Good (name the source):**",
      "> Gestalt names the principle.",
      "",
      "Knowledge arrives as a recollection.",
      "",
      "**Good (use the history):**",
      "> Factories bought motors in the 1880s.",
      "",
      "A present problem can use that analogy.",
      "",
      "**Bad (do not lecture):**",
      "> Gestalt began in Germany.",
      "",
      "---",
      "",
      "## Next",
      "",
    ].join("\n"),
    actual: [
      "## Examples",
      "**Good (name the source):**",
      "> Gestalt names the principle.",
      "Knowledge arrives as a recollection.",
      "**Good (use the history):**",
      "> Factories bought motors in the 1880s.",
      "A present problem can use that analogy.",
      "**Bad (do not lecture):**",
      "> Gestalt began in Germany.",
      "---",
      "## Next",
    ].join("\n"),
    blocks: [
      leaf("heading", "heading_2", [span("Examples")]),
      label("good", "Good (name the source):"),
      quote("gestalt", "Gestalt names the principle."),
      leaf("recollection", "paragraph", [span("Knowledge arrives as a recollection.")]),
      label("history", "Good (use the history):"),
      quote("motors", "Factories bought motors in the 1880s."),
      leaf("analogy", "paragraph", [span("A present problem can use that analogy.")]),
      label("bad", "Bad (do not lecture):"),
      quote("lecture", "Gestalt began in Germany."),
      { id: "divider", type: "divider", has_children: false },
      leaf("next", "heading_2", [span("Next")]),
    ],
  }
  const before = structuredClone(f)
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  assert.equal(matches(f), true)
  assert.deepEqual(f, before)
  for (const change of [
    (value) => {
      value.blocks.splice(4, 2)
    },
    (value) => {
      value.blocks[3].rich_text[0].text = "Changed recollection."
    },
    (value) => {
      value.actual = value.actual.replace(
        "Knowledge arrives as a recollection.",
        "Changed recollection.",
      )
    },
    (value) => {
      value.source = value.source.replace("\n\nKnowledge arrives", "\n> Knowledge arrives")
    },
    (value) => {
      ;[value.blocks[5], value.blocks[6]] = [value.blocks[6], value.blocks[5]]
    },
  ]) {
    const altered = structuredClone(f)
    change(altered)
    assert.equal(matches(altered), false)
  }
})

test("every table anchor row, parent, width and cell must be complete", () => {
  for (const change of [
    (table) => {
      delete table.table_evidence
    },
    (table) => {
      table.table_evidence.rows.pop()
    },
    (table) => {
      table.table_evidence.rows[1].parent_id = "other-table"
    },
    (table) => {
      table.table_evidence.rows[1].has_children = true
    },
    (table) => {
      table.table_evidence.width = 3
    },
    (table) => {
      table.table_evidence.header_column = true
    },
    (table) => {
      table.table_evidence.rows[1].table_row.cells[1][0].text = "Different cell."
    },
    (table) => {
      table.table_evidence.rows[1].id = table.table_evidence.rows[0].id
    },
    (table) => {
      table.table_evidence.hidden = "unknown"
    },
  ]) {
    const f = tableQuote()
    change(f.blocks[1])
    assert.equal(matches(f), false)
  }
})

test("a source-bound table anchor cannot borrow a different physical or readback cell", () => {
  const f = tableQuote()
  f.actual = f.actual.replace("Keep the identifier.", "Changed instructions.")
  f.blocks[1].table_evidence.rows[1].table_row.cells[1][0].text = "Changed instructions."
  assert.equal(matches(f), false)
  const g = tableQuote()
  g.actual = g.actual.replace("<td>Meaning</td>", "<td>Other column</td>")
  assert.equal(matches(g), false)
})

test("the complete quote descendants reject missing, extra, foreign, reordered or unknown nodes", () => {
  for (const change of [
    (quote) => {
      delete quote.quote_descendants
    },
    (quote) => {
      quote.quote_descendants.pop()
    },
    (quote) => {
      quote.quote_descendants[1].parent_id = "other-quote"
    },
    (quote) => {
      quote.quote_descendants[1].type = "toggle"
    },
    (quote) => {
      quote.quote_descendants[1].has_children = true
    },
    (quote) => {
      ;[quote.quote_descendants[1], quote.quote_descendants[2]] = [
        quote.quote_descendants[2],
        quote.quote_descendants[1],
      ]
    },
    (quote) => {
      quote.quote_descendants.push(child("extra", "quote", "paragraph", [span("Not in readback.")]))
    },
  ]) {
    const f = tableQuote()
    change(f.blocks[2])
    assert.equal(matches(f), false)
  }
})

test("only empty serialization lines may separate complete children", () => {
  for (const inserted of [
    "\tUnrecorded instruction.\n",
    "> Unrecorded quote.\n",
    "<aside>Hidden content</aside>\n",
  ]) {
    const f = tableQuote()
    f.actual = f.actual.replace("\tAPI:", inserted + "\tAPI:")
    assert.equal(matches(f), false)
  }
})

test("mixed quote intervals reject moved paragraphs, changed destinations and code semantics", () => {
  for (const change of [
    (f) => {
      f.blocks.splice(2, 1)
    },
    (f) => {
      f.blocks[2].has_children = true
    },
    (f) => {
      f.blocks[3].quote_descendants[0].parent_id = "first"
    },
    (f) => {
      f.blocks[3].quote_descendants[0].rich_text[1].code = false
    },
    (f) => {
      f.blocks[3].rich_text[1].link = "https://example.test/other#query"
    },
    (f) => {
      f.actual = f.actual.replace("separate paragraph", "changed paragraph")
    },
    (f) => {
      f.source = f.source.replace("\n\nThis instruction", "\n>\n> This instruction")
    },
    (f) => {
      f.blocks[0].rich_text[0].text = "Unrelated anchor"
    },
    (f) => {
      f.blocks[4].type = "paragraph"
    },
  ]) {
    const f = separatedQuotes()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("an unrelated whole-page change remains a mismatch after decoding the interval", () => {
  const f = tableQuote()
  f.actual = f.actual.replace("## Finish", "## Different ending")
  f.blocks.at(-1).rich_text[0].text = "Different ending"
  assert.equal(matches(f), false)
})
