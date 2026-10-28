import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { priorContentAdoptionGraphs } from "../src/publication-content-adoption-graph.ts"

const span = (text) => ({ text, link: null, bold: false, code: false })
const text = (id, type, value, has_children = false) => ({
  id,
  type,
  has_children,
  text: value,
  rich_text: [span(value)],
})
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function current() {
  return [
    {
      id: "page",
      path: "SKILL.md",
      markdown: "Exact retained raw body.",
      blocks: [
        text("heading", "heading_1", "Retain the heading"),
        {
          id: "table",
          type: "table",
          has_children: true,
          table_evidence: {
            width: 1,
            header_row: true,
            header_column: false,
            rows: [
              {
                id: "row",
                type: "table_row",
                has_children: false,
                parent_id: "table",
                table_row: { cells: [[span("Exact <literal>")]] },
              },
            ],
          },
        },
        {
          ...text("quote", "quote", "Quote", true),
          quote_descendants: [
            {
              id: "code",
              type: "code",
              has_children: false,
              parent_id: "quote",
              code: { text: "unchanged bytes", language: "json" },
            },
          ],
        },
        {
          ...text("other-quote", "quote", "Prior quote", true),
          quote_descendants: [
            { ...text("paragraph", "paragraph", "Prior child"), parent_id: "other-quote" },
          ],
        },
        { ...text("task", "to_do", "Keep checked"), to_do: { checked: true } },
      ],
    },
  ]
}
function beforeTable() {
  const value = current()
  delete value[0].blocks[1].table_evidence
  return value
}
function beforeCode() {
  const value = beforeTable()
  delete value[0].blocks[2].quote_descendants
  return value
}
const byModel = (value) =>
  new Map(priorContentAdoptionGraphs(value)?.map((candidate) => [candidate.model, candidate.pages]))

test("root-table compatibility follows the real reader sequence without mixing projection versions", () => {
  const input = current(),
    saved = structuredClone(input),
    candidates = byModel(input)
  assert.deepEqual(
    [...candidates.keys()],
    [
      "before-root-table-evidence",
      "before-quote-code-evidence",
      "root-headings-before-container-evidence",
      "before-root-headings",
    ],
  )
  assert.deepEqual(candidates.get("before-root-table-evidence"), beforeTable())
  assert.deepEqual(candidates.get("before-quote-code-evidence"), beforeCode())
  assert.deepEqual(input, saved)
  assert.equal(
    candidates.get("before-root-table-evidence")[0].blocks[2].quote_descendants[0].code.text,
    "unchanged bytes",
  )
  assert.deepEqual(candidates.get("before-quote-code-evidence")[0].blocks[3], input[0].blocks[3])
  assert.deepEqual(candidates.get("before-quote-code-evidence")[0].blocks[4], input[0].blocks[4])
  assert.equal(byModel(beforeTable()).has("before-root-table-evidence"), false)
})

test("a historical table graph still preserves root identity, body, order, heading and prior container values", () => {
  const expected = hash(beforeTable())
  for (const change of [
    (value) => {
      value[0].markdown += " changed"
    },
    (value) => {
      value[0].path = "another.md"
    },
    (value) => {
      value[0].blocks[1].id = "other-table"
      value[0].blocks[1].table_evidence.rows[0].parent_id = "other-table"
    },
    (value) => {
      value[0].blocks.reverse()
    },
    (value) => {
      value[0].blocks[0].rich_text[0].text += " changed"
      value[0].blocks[0].text += " changed"
    },
    (value) => {
      value[0].blocks[2].quote_descendants[0].code.text += " changed"
    },
    (value) => {
      value[0].blocks[4].to_do.checked = false
    },
  ]) {
    const value = current()
    change(value)
    assert.notEqual(hash(byModel(value).get("before-root-table-evidence")), expected)
  }
})

test("unknown, incomplete, reordered-parent or contradictory table evidence grants no historical candidate", () => {
  for (const change of [
    (table) => {
      table.future = true
    },
    (table) => {
      table.table_evidence.future = true
    },
    (table) => {
      table.table_evidence.rows[0].future = true
    },
    (table) => {
      table.table_evidence.rows[0].table_row.cells[0][0].future = true
    },
    (table) => {
      table.table_evidence.rows[0].id = "heading"
    },
    (table) => {
      table.table_evidence.rows[0].parent_id = "foreign"
    },
    (table) => {
      table.table_evidence.rows[0].has_children = true
    },
    (table) => {
      table.table_evidence.rows[0].type = "paragraph"
    },
    (table) => {
      table.table_evidence.rows[0].text = "unexpected"
    },
    (table) => {
      table.table_evidence.rows[0].table_row.cells = []
    },
    (table) => {
      table.table_evidence.rows = []
    },
    (table) => {
      table.table_evidence.width = 2
    },
    (table) => {
      table.table_evidence.header_row = false
    },
    (table) => {
      table.table_evidence.header_column = true
    },
    (table) => {
      table.has_children = false
    },
    (table) => {
      table.type = "quote"
    },
    (table) => {
      table.rich_text = [span("unexpected")]
    },
    (table) => {
      table.descendants = []
    },
  ]) {
    const value = current()
    change(value[0].blocks[1])
    assert.equal(priorContentAdoptionGraphs(value), undefined)
  }
})

test("omitted table rows in an old digest remain subject to the independent complete raw-equality gate", () => {
  const input = current(),
    changed = structuredClone(input)
  changed[0].blocks[1].table_evidence.rows[0].table_row.cells[0][0].text =
    "Different physical bytes"
  assert.equal(
    hash(byModel(input).get("before-root-table-evidence")),
    hash(byModel(changed).get("before-root-table-evidence")),
  )
  assert.notDeepEqual(changed, input)
})
