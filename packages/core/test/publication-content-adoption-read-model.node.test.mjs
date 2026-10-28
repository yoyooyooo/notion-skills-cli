import assert from "node:assert/strict"
import test from "node:test"
import { priorContentAdoptionGraphs } from "../src/publication-content-adoption-graph.ts"

const span = (text, link = null) => ({ text, link, bold: false, code: false })
const leaf = (id, type, text) => ({ id, type, has_children: false, text, rich_text: [span(text)] })
const table = (prefix, parent) => [
  {
    id: `${prefix}-table`,
    type: "table",
    has_children: true,
    parent_id: parent,
    table: { width: 2, header_row: true, header_column: false },
  },
  {
    id: `${prefix}-header`,
    type: "table_row",
    has_children: false,
    parent_id: `${prefix}-table`,
    table_row: { cells: [[span("Name")], [span("Value")]] },
  },
  {
    id: `${prefix}-row`,
    type: "table_row",
    has_children: false,
    parent_id: `${prefix}-table`,
    table_row: { cells: [[span("one")], [span("two")]] },
  },
]
function fixture() {
  return [
    {
      id: "page",
      path: "SKILL.md",
      markdown: "complete original readback",
      blocks: [
        leaf("heading", "heading_1", "Heading"),
        { ...leaf("task", "to_do", "Keep task"), to_do: { checked: true } },
        {
          ...leaf("quote", "quote", "Quote"),
          has_children: true,
          quote_descendants: [
            ...table("quote", "quote"),
            { ...leaf("quote-end", "paragraph", "End"), parent_id: "quote" },
          ],
        },
        {
          ...leaf("list", "numbered_list_item", "List"),
          has_children: true,
          numbered_list: { start: 7 },
          list_table_descendants: table("list", "list"),
        },
        {
          ...leaf("ordinary", "bulleted_list_item", "Ordinary"),
          has_children: true,
          descendants: [
            { ...leaf("ordinary-child", "paragraph", "Retained child"), parent_id: "ordinary" },
          ],
        },
        { id: "empty-quote", type: "quote", has_children: false, rich_text: [], text: "" },
      ],
    },
  ]
}
function previous() {
  return [
    {
      id: "page",
      path: "SKILL.md",
      markdown: "complete original readback",
      blocks: [
        leaf("heading", "heading_1", "Heading"),
        { id: "task", type: "to_do", has_children: false },
        { ...leaf("quote", "quote", "Quote"), has_children: true },
        { ...leaf("list", "numbered_list_item", "List"), has_children: true },
        {
          ...leaf("ordinary", "bulleted_list_item", "Ordinary"),
          has_children: true,
          descendants: [
            { ...leaf("ordinary-child", "paragraph", "Retained child"), parent_id: "ordinary" },
          ],
        },
        { id: "empty-quote", type: "quote", has_children: false, rich_text: [], text: "" },
      ],
    },
  ]
}

test("finite prior graphs reproduce the two actual reader models without modifying evidence", () => {
  const input = fixture(),
    before = structuredClone(input)
  const candidates = priorContentAdoptionGraphs(input)
  assert.deepEqual(
    candidates.map((candidate) => candidate.model),
    ["root-headings-before-container-evidence", "before-root-headings"],
  )
  assert.deepEqual(candidates[0].pages, previous())
  const older = previous()
  older[0].blocks[0] = { id: "heading", type: "heading_1", has_children: false }
  assert.deepEqual(candidates[1].pages, older)
  assert.deepEqual(input, before)
})

test("an unchanged old reader graph retains only its existing heading fallback", () => {
  const candidates = priorContentAdoptionGraphs(previous())
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].model, "before-root-headings")
  const oldest = candidates[0].pages
  assert.equal(priorContentAdoptionGraphs(oldest), undefined)
})

test("unknown fields and unsupported task or non-leaf numbered projections fail closed", () => {
  const alterations = [
    (f) => {
      f[0].blocks[1].future_evidence = { accepted: true }
    },
    (f) => {
      f[0].blocks[1].to_do.extra = true
    },
    (f) => {
      f[0].blocks[1].has_children = true
    },
    (f) => {
      delete f[0].blocks[1].to_do
    },
    (f) => {
      f[0].blocks[3].numbered_list.start = 0
    },
    (f) => {
      delete f[0].blocks[3].list_table_descendants
    },
    (f) => {
      delete f[0].blocks[3].numbered_list
    },
    (f) => {
      f[0].blocks[2].rich_text[0].future = true
    },
    (f) => {
      f[0].blocks[2].text = "Different text"
    },
  ]
  for (const alter of alterations) {
    const f = fixture()
    alter(f)
    assert.equal(priorContentAdoptionGraphs(f), undefined)
  }
})

test("partial, repeated, foreign or unsupported quote/table evidence grants no old graph", () => {
  const alterations = [
    (f) => {
      f[0].blocks[2].quote_descendants = []
    },
    (f) => {
      f[0].blocks[2].quote_descendants[1].parent_id = "foreign"
    },
    (f) => {
      f[0].blocks[2].quote_descendants[1].id = "task"
    },
    (f) => {
      f[0].blocks[2].quote_descendants[0].has_children = false
    },
    (f) => {
      f[0].blocks[2].quote_descendants[1].has_children = true
    },
    (f) => {
      f[0].blocks[2].quote_descendants[0].table.width = 3
    },
    (f) => {
      f[0].blocks[2].quote_descendants[0].table.header_column = true
    },
    (f) => {
      f[0].blocks[2].quote_descendants[1].table_row.cells[0][0].bold = "false"
    },
    (f) => {
      f[0].blocks[2].quote_descendants[0].table.unrecognized = 1
    },
    (f) => {
      f[0].blocks[2].quote_descendants[3].type = "callout"
    },
    (f) => {
      f[0].blocks[2].descendants = []
    },
    (f) => {
      f[0].blocks[2].quote_descendants.splice(1, 2)
    },
  ]
  for (const alter of alterations) {
    const f = fixture()
    alter(f)
    assert.equal(priorContentAdoptionGraphs(f), undefined)
  }
})

test("list tables need their sole direct parent and complete nonempty row shape", () => {
  for (const alter of [
    (f) => {
      f[0].blocks[3].list_table_descendants.splice(1)
    },
    (f) => {
      f[0].blocks[3].list_table_descendants[0].parent_id = "quote"
    },
    (f) => {
      f[0].blocks[3].list_table_descendants[1].parent_id = "list"
    },
    (f) => {
      f[0].blocks[3].list_table_descendants.push({
        ...leaf("extra", "paragraph", "Extra"),
        parent_id: "list",
      })
    },
    (f) => {
      f[0].blocks[3].list_table_descendants[2].table_row.cells.pop()
    },
    (f) => {
      f[0].blocks[3].list_table_descendants[0].table.header_row = false
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(priorContentAdoptionGraphs(f), undefined)
  }
})

test("the fallback never erases ordinary descendants, empty quotes, body, paths, IDs or order", () => {
  for (const alter of [
    (f) => {
      f[0].markdown += " changed"
    },
    (f) => {
      f[0].path = "references/other.md"
    },
    (f) => {
      f[0].id = "different-page"
    },
    (f) => {
      ;[f[0].blocks[0], f[0].blocks[1]] = [f[0].blocks[1], f[0].blocks[0]]
    },
    (f) => {
      f[0].blocks[4].descendants[0].text = "Changed child"
      f[0].blocks[4].descendants[0].rich_text[0].text = "Changed child"
    },
    (f) => {
      f[0].blocks.splice(5, 1)
    },
  ]) {
    const f = fixture()
    alter(f)
    const candidates = priorContentAdoptionGraphs(f)
    assert.ok(candidates)
    assert.notDeepEqual(candidates[0].pages, previous())
  }
})

test("duplicate pages or roots and malformed ordinary trees refuse compatibility", () => {
  for (const alter of [
    (f) => {
      f.push(structuredClone(f[0]))
    },
    (f) => {
      f[0].blocks[5].id = "heading"
    },
    (f) => {
      f[0].blocks[4].descendants[0].parent_id = "foreign"
    },
    (f) => {
      f[0].blocks[4].descendants = []
    },
    (f) => {
      f[0].blocks[4].descendants[0].has_children = true
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(priorContentAdoptionGraphs(f), undefined)
  }
})
