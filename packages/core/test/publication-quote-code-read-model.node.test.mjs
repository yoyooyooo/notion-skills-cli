import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { priorContentAdoptionGraphs } from "../src/publication-content-adoption-graph.ts"

const span = (text) => ({ text, bold: false, code: false, link: null })
const text = (id, type, value, has_children = false) => ({
  id,
  type,
  has_children,
  text: value,
  rich_text: [span(value)],
})
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function fixture() {
  return [
    {
      id: "page",
      path: "SKILL.md",
      markdown: "Unchanged complete raw Markdown.",
      blocks: [
        text("heading", "heading_2", "Retained heading"),
        {
          ...text("ordinary", "bulleted_list_item", "Ordinary list", true),
          descendants: [
            {
              ...text("ordinary-child", "paragraph", "Keep the ordinary subtree"),
              parent_id: "ordinary",
            },
          ],
        },
        {
          ...text("prior-quote", "quote", "Prior quote evidence", true),
          quote_descendants: [
            {
              ...text("prior-child", "paragraph", "Retained quote child"),
              parent_id: "prior-quote",
            },
          ],
        },
        {
          ...text("quote-code", "quote", "Quote with code", true),
          quote_descendants: [
            {
              ...text(
                "quote-paragraph",
                "paragraph",
                "Also retain this sibling in current evidence",
              ),
              parent_id: "quote-code",
            },
            {
              id: "code",
              type: "code",
              has_children: false,
              parent_id: "quote-code",
              code: { text: "  exact\nbytes  ", language: "json" },
            },
          ],
        },
        {
          ...text("list-table", "numbered_list_item", "Table item", true),
          numbered_list: { start: 3 },
          list_table_descendants: [
            {
              id: "table",
              type: "table",
              has_children: true,
              parent_id: "list-table",
              table: { width: 1, header_row: true, header_column: false },
            },
            {
              id: "row",
              type: "table_row",
              has_children: false,
              parent_id: "table",
              table_row: { cells: [[span("Header")]] },
            },
          ],
        },
        { ...text("task", "to_do", "Checked task"), to_do: { checked: true } },
      ],
    },
  ]
}
function previous() {
  const result = fixture()
  delete result[0].blocks[3].quote_descendants
  return result
}
const immediate = (value) =>
  priorContentAdoptionGraphs(value)?.find(
    (candidate) => candidate.model === "before-quote-code-evidence",
  )?.pages

test("the immediate prior model removes only complete quote trees newly containing code", () => {
  const input = fixture(),
    before = structuredClone(input),
    output = immediate(input)
  assert.deepEqual(output, previous())
  assert.equal(hash(output), hash(previous()))
  assert.deepEqual(input, before)
  assert.deepEqual(
    output[0].blocks.slice(4),
    input[0].blocks.slice(4),
    "table, numbered start and checked task remain exact",
  )
  assert.deepEqual(
    output[0].blocks.slice(0, 3),
    input[0].blocks.slice(0, 3),
    "headings, ordinary and prior quote evidence remain exact",
  )
  assert.deepEqual(
    priorContentAdoptionGraphs(input).map((candidate) => candidate.model),
    [
      "before-quote-code-evidence",
      "root-headings-before-container-evidence",
      "before-root-headings",
    ],
  )
})

test("a graph without the new code projection gets no immediate-model candidate", () => {
  assert.equal(immediate(previous()), undefined)
  const input = fixture()
  input[0].blocks[3].quote_descendants.pop()
  assert.equal(immediate(input), undefined)
})

test("unknown fields, contradictory code shapes and incomplete or foreign trees fail closed", () => {
  for (const change of [
    (value) => {
      value[0].blocks[3].future = true
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].future = true
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].code.future = true
    },
    (value) => {
      delete value[0].blocks[3].quote_descendants[1].code
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].code.language = undefined
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].rich_text = [span("Unexpected")]
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].text = "Unexpected"
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].table = {
        width: 1,
        header_row: true,
        header_column: false,
      }
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].has_children = true
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].parent_id = "prior-quote"
    },
    (value) => {
      value[0].blocks[3].quote_descendants[1].id = "prior-child"
    },
    (value) => {
      value[0].blocks[3].quote_descendants[0].has_children = true
    },
    (value) => {
      value[0].blocks[3].has_children = false
    },
    (value) => {
      value[0].blocks[4].list_table_descendants.pop()
    },
  ]) {
    const value = fixture()
    change(value)
    assert.equal(priorContentAdoptionGraphs(value), undefined)
  }
})

test("code evidence is never admitted in the ordinary list or list-table grammar", () => {
  for (const field of ["descendants", "list_table_descendants"]) {
    const value = fixture(),
      owner = field === "descendants" ? value[0].blocks[1] : value[0].blocks[4]
    owner[field].push({
      id: "wrong-code",
      type: "code",
      has_children: false,
      parent_id: owner.id,
      code: { text: "exact", language: "json" },
    })
    assert.equal(priorContentAdoptionGraphs(value), undefined)
  }
})

test("one whole prior graph digest preserves every existing field and rejects mixed model projections", () => {
  const expectedHash = hash(previous())
  for (const change of [
    (value) => {
      value[0].id = "another-page"
    },
    (value) => {
      value[0].path = "references/another.md"
    },
    (value) => {
      value[0].markdown += " changed"
    },
    (value) => {
      value[0].blocks.reverse()
    },
    (value) => {
      value[0].blocks[0].text = "Changed heading"
      value[0].blocks[0].rich_text[0].text = "Changed heading"
    },
    (value) => {
      delete value[0].blocks[0].text
      delete value[0].blocks[0].rich_text
    },
    (value) => {
      delete value[0].blocks[2].quote_descendants
    },
    (value) => {
      value[0].blocks[4].numbered_list.start = 4
    },
    (value) => {
      value[0].blocks[4].list_table_descendants[1].table_row.cells[0][0].text = "Other header"
    },
    (value) => {
      value[0].blocks[5].to_do.checked = false
    },
  ]) {
    const value = fixture()
    change(value)
    const output = immediate(value)
    assert.ok(output)
    assert.notEqual(hash(output), expectedHash)
  }
})

test("the digest preimage is not a code-content proof and cannot replace the caller's raw-equality gate", () => {
  const input = fixture(),
    changed = structuredClone(input)
  changed[0].blocks[3].quote_descendants[1].code.text = "Different live code"
  // Both readers previously omitted this whole field. A caller must reject
  // changed raw resources before evaluating this limited historical digest.
  assert.equal(hash(immediate(changed)), hash(immediate(input)))
  assert.notDeepEqual(changed, input)
})
