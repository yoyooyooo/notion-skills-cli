import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { notionMarkdownForComparison } from "../src/index.ts"

const rich = (text, code = false, extra = {}) => ({
  type: "text",
  text: { content: text, link: null },
  plain_text: text,
  href: null,
  annotations: {
    bold: false,
    code,
    italic: true,
    strikethrough: false,
    underline: false,
    color: "default",
    ...extra,
  },
})
const node = (id, type, body, parent = "page", children = false) => ({
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
function fixture(count = 1, double = true) {
  const source = [],
    actual = [],
    blocks = []
  for (let at = 0; at < count; at++) {
    const values = double
      ? [rich("System: "), rich("--yes", true), rich(" / "), rich("--preview", true)]
      : [rich("System: "), rich("--preview", true)]
    const original =
      "_" +
      values
        .map((value) => (value.annotations.code ? "`" + value.plain_text + "`" : value.plain_text))
        .join("") +
      "_"
    const serialized = values
      .map(
        (value) =>
          "*" + (value.annotations.code ? "`" + value.plain_text + "`" : value.plain_text) + "*",
      )
      .join("")
    source.push(`## Command ${at}`, "", original, "", "| Flag |", "| --- |", `| value ${at} |`, "")
    actual.push(
      `## Command ${at}`,
      serialized,
      '<table header-row="true">',
      "<tr>",
      "<td>Flag</td>",
      "</tr>",
      "<tr>",
      `<td>value ${at}</td>`,
      "</tr>",
      "</table>",
    )
    blocks.push(
      node(`heading-${at}`, "heading_2", {
        rich_text: [rich(`Command ${at}`, false, { italic: false })],
      }),
      node(`paragraph-${at}`, "paragraph", { rich_text: values }),
      node(
        `table-${at}`,
        "table",
        { table_width: 1, has_column_header: true, has_row_header: false },
        "page",
        true,
      ),
      node(
        `header-${at}`,
        "table_row",
        { cells: [[rich("Flag", false, { italic: false })]] },
        `table-${at}`,
      ),
      node(
        `row-${at}`,
        "table_row",
        { cells: [[rich(`value ${at}`, false, { italic: false })]] },
        `table-${at}`,
      ),
    )
  }
  return { source: source.join("\n"), actual: actual.join("\n"), blocks }
}
const projection = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, projection(f))

test("one or two physical inline-code spans retain their complete source paragraph", () => {
  for (const double of [false, true]) {
    const f = fixture(1, double),
      before = structuredClone(f)
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
    assert.equal(matches(f), true)
    assert.equal(typeof notionMarkdownForComparison(f.actual, f.source, projection(f)), "string")
    assert.deepEqual(f, before)
  }
})

test("repeated paragraphs are each bounded by their original heading and ordered table", () => {
  const f = fixture(3)
  assert.equal(matches(f), true)
  const g = fixture(2)
  g.source = g.source.replaceAll("Command 1", "Command 0")
  g.actual = g.actual.replaceAll("Command 1", "Command 0")
  g.blocks[5].heading_2.rich_text = [rich("Command 0", false, { italic: false })]
  assert.equal(matches(g), false)
})

test("visible punctuation, code bytes and destinations cannot be inferred from the source", () => {
  for (const change of [
    (f) => {
      f.blocks[1].paragraph.rich_text[2] = rich(" changed ")
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1] = rich("--other", true)
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[1].annotations.bold = true
    },
    (f) => {
      const value = f.blocks[1].paragraph.rich_text[1]
      value.text.link = { url: "https://example.test/other" }
      value.href = value.text.link.url
    },
    (f) => {
      f.actual = f.actual.replace("** / **", "** changed **")
    },
    (f) => {
      f.actual = f.actual.replace("`--yes`", "`--other`")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("only the complete observed emphasis serializer qualifies, not arbitrary asterisk removal", () => {
  for (const change of [
    (f) => {
      f.actual = f.actual.replace("*System:", "**System:")
    },
    (f) => {
      f.actual = f.actual.replace("** / **", "*** / **")
    },
    (f) => {
      f.actual = f.actual.replace("`--preview`*", "`--preview`**")
    },
    (f) => {
      f.source = f.source.replace("_System:", "System:").replace("`--preview`_", "`--preview`")
    },
    (f) => {
      f.source = f.source
        .replace("_System:", "_**System:")
        .replace("`--preview`_", "`--preview`**_")
    },
    (f) => {
      f.blocks[1].paragraph.rich_text[0] = rich("System: **")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("missing, nested, reordered or unbounded roots cannot establish the selected paragraph", () => {
  for (const change of [
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[1].parent = { type: "block_id", block_id: "heading-0" }
    },
    (f) => {
      f.blocks[0].heading_2.rich_text = [rich("Different heading")]
    },
    (f) => {
      f.blocks[2].has_children = false
    },
    (f) => {
      f.blocks.splice(2, 0, node("extra", "paragraph", { rich_text: [rich("Extra")] }))
    },
    (f) => {
      f.actual = f.actual.replace('<table header-row="true">', 'Extra\n<table header-row="true">')
    },
    (f) => {
      f.actual = f.actual.replace("## Command 0\n", "")
    },
    (f) => {
      f.actual = f.actual.replace("</table>", "")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("full-source validation still rejects a changed table or coherently changed paragraph", () => {
  const f = fixture()
  f.actual = f.actual.replace("<td>value 0</td>", "<td>changed</td>")
  f.blocks[4].table_row.cells[0] = [rich("changed", false, { italic: false })]
  assert.equal(matches(f), false)
  const g = fixture()
  g.actual = g.actual.replace("`--yes`", "`--other`")
  g.blocks[1].paragraph.rich_text[1] = rich("--other", true)
  assert.equal(matches(g), false)
})

test("literal asterisks inside code remain exact content", () => {
  const f = fixture()
  f.actual = f.actual.replace("`--yes`", "`*literal*`")
  f.source = f.source.replace("`--yes`", "`*literal*`")
  f.blocks[1].paragraph.rich_text[1] = rich("*literal*", true)
  assert.equal(matches(f), true)
  const g = structuredClone(f)
  g.source = g.source.replace("`*literal*`", "`literal`")
  assert.equal(matches(g), false)
})
