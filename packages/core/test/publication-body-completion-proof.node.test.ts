import assert from "node:assert/strict"
import { test } from "vitest"
import {
  bodyCompletionAckMatches,
  bodyCompletionStageMatches,
  bodyCompletionTransition,
  bodyCompletionTree,
  deriveBodyCompletion,
  stableBodyCompletionSnapshot,
} from "../src/publication-body-completion-proof.ts"
import {
  advanceCompletion,
  completionArray as array,
  completionChildPath,
  completionFind,
  completionFixture,
  completionPage,
  completionRecord as record,
  completionRoots,
  completionRows,
  completionSource,
  completionSpan,
} from "./fixtures/publication-body-completion.ts"

function fixture() {
  const f = completionFixture(),
    derived = deriveBodyCompletion(completionSource, f.marker, f.before)
  assert.ok(derived)
  return { ...f, derived }
}

test("derives only the existing row correction, missing table suffix and final authored roots", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert.deepEqual(
    f.derived.models.map((model) => model.roots.length),
    [4, 4, 4, 7],
  )
  assert.deepEqual(
    f.derived.requests.map((request) => request.path),
    [
      `v1/blocks/${f.row_id}`,
      `v1/blocks/${f.table_id}/children`,
      `v1/blocks/${completionPage}/children`,
    ],
  )
  assert.equal(array(f.derived.requests[1]!.body.children).length, 2)
  assert.equal(array(f.derived.requests[2]!.body.children).length, 3)
  const row = record(f.derived.requests[0]!.body.table_row)
  const literal = record(array(array(row.cells)[1])[0])
  assert.equal(record(literal.text).content, "- item")
  assert.equal(JSON.stringify(f), before)
})

test("complete transitions and real allocation ACKs preserve the first table and original identities", () => {
  const f = fixture(),
    first = JSON.stringify(completionRows(f.before, f.first_table_id))
  let before = f.before
  for (let step = 0; step < 3; step++) {
    const { after, response } = advanceCompletion(f.derived, step, before)
    assert.equal(bodyCompletionStageMatches(f.derived, step + 1, after), true)
    assert.equal(bodyCompletionTransition(f.derived, step, before, after), true)
    assert.equal(bodyCompletionAckMatches(f.derived, step, response, before, after), true)
    assert.equal(JSON.stringify(completionRows(after, f.first_table_id)), first)
    before = after
  }
  assert.equal(completionRoots(before).length, 8)
  assert.equal(completionRows(before, f.table_id).length, 5)
})

test("refuses changed cells or formatting outside the one source-bound code literal", () => {
  for (const field of ["text", "annotation", "other_cell"]) {
    const f = fixture(),
      rows = completionRows(f.before, f.first_table_id)
    const cells = array(record(record(rows[1]).table_row).cells)
    if (field === "text") cells[0] = [completionSpan("Other")]
    else if (field === "annotation") record(record(array(cells[0])[0]).annotations).italic = true
    else cells[1] = [completionSpan("one~two")]
    assert.equal(deriveBodyCompletion(completionSource, f.marker, f.before), undefined)
  }
})

test("refuses extra empty roots, opaque roots, hidden descendants and unused inventory responses", () => {
  for (const kind of ["empty", "opaque", "hidden", "unused"]) {
    const f = fixture(),
      roots = completionRoots(f.before),
      extra = structuredClone(record(roots[0]))
    extra.id = "40000000-0000-4000-8000-000000000001"
    if (kind === "empty") {
      extra.paragraph = { rich_text: [], color: "default" }
      roots.push(extra)
    }
    if (kind === "opaque") {
      extra.type = "unsupported"
      extra.unsupported = {}
      roots.push(extra)
    }
    if (kind === "hidden") record(roots[1]).has_children = true
    if (kind === "unused") {
      const inventories = {
        ...f.before.inventories,
        [completionChildPath(String(extra.id))]: {
          object: "list",
          type: "block",
          block: {},
          results: [],
          has_more: false,
          next_cursor: null,
        },
      }
      assert.equal(bodyCompletionTree({ ...f.before, inventories }, completionPage), undefined)
      continue
    }
    assert.equal(deriveBodyCompletion(completionSource, f.marker, f.before), undefined)
  }
})

test("requires closed pagination, unique IDs and exact parent ownership", () => {
  for (const kind of ["page", "duplicate", "foreign"]) {
    const f = fixture(),
      inventory = f.before.inventories[completionChildPath(f.table_id)]!
    if (kind === "page") inventory.has_more = true
    if (kind === "duplicate")
      record(completionRows(f.before, f.table_id)[1]).id = record(completionRoots(f.before)[1]).id
    if (kind === "foreign")
      record(completionRows(f.before, f.table_id)[1]).parent = {
        type: "block_id",
        block_id: f.first_table_id,
      }
    assert.equal(bodyCompletionTree(f.before, completionPage), undefined)
  }
})

test("refuses a full source whose missing suffix would exceed one closed table inventory", () => {
  const f = fixture(),
    rows = completionRows(f.before, f.table_id),
    template = record(rows[2])
  const lines: string[] = []
  for (let index = 0; index < 97; index++) {
    const row = structuredClone(template)
    row.id = `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    row.table_row = {
      cells: [[completionSpan(`Filler ${index}`)], [completionSpan(`value${index}`, true)]],
    }
    rows.push(row)
    lines.push(`| Filler ${index} | \`value${index}\` |`)
  }
  const source = completionSource.replace(
    "| Missing A | `---` |\n| Missing B | `![x](key)` |",
    `${lines.join("\n")}\n| Missing A | \`---\` |`,
  )
  assert.ok(bodyCompletionTree(f.before, completionPage))
  assert.equal(rows.length, 100)
  assert.equal(Boolean(deriveBodyCompletion(source, f.marker, f.before)), false)
})

test("refuses a full source whose new rows and roots would exceed the complete physical node budget", () => {
  const f = fixture(),
    first = completionRows(f.before, f.first_table_id),
    second = completionRows(f.before, f.table_id)
  let serial = 1
  const paddedRows = (target: unknown[], count: number, parent: string, prefix: string) => {
    const lines: string[] = []
    for (let index = 0; index < count; index++) {
      const row = structuredClone(record(first[1]))
      row.id = `50000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`
      row.parent = { type: "block_id", block_id: parent }
      row.table_row = {
        cells: [[completionSpan(`${prefix} ${index}`)], [completionSpan(`value${index}`, true)]],
      }
      target.push(row)
      lines.push(`| ${prefix} ${index} | \`value${index}\` |`)
    }
    return lines
  }
  const firstLines = paddedRows(first, 98, f.first_table_id, "First")
  const secondLines = paddedRows(second, 95, f.table_id, "Second")
  const table = structuredClone(completionFind(f.before, f.first_table_id))
  table.id = "60000000-0000-4000-8000-000000000001"
  const header = structuredClone(record(first[0]))
  header.id = "60000000-0000-4000-8000-000000000002"
  header.parent = { type: "block_id", block_id: table.id }
  const extra: unknown[] = [header],
    extraLines = paddedRows(extra, 47, String(table.id), "Extra")
  completionRoots(f.before).splice(3, 0, table)
  const snapshot = {
    ...f.before,
    inventories: {
      ...f.before.inventories,
      [completionChildPath(String(table.id))]: {
        object: "list",
        type: "block",
        block: {},
        results: extra,
        has_more: false,
        next_cursor: null,
      },
    },
  }
  const source = completionSource
    .replace(
      "\n\n## Syntax",
      `\n${firstLines.join("\n")}\n\n| Field | Value |\n| --- | --- |\n${extraLines.join("\n")}\n\n## Syntax`,
    )
    .replace("| Missing A", `${secondLines.join("\n")}\n| Missing A`)
  assert.ok(bodyCompletionTree(snapshot, completionPage))
  assert.equal(completionRoots(snapshot).length + first.length + second.length + extra.length, 252)
  assert.equal(Boolean(deriveBodyCompletion(source, f.marker, snapshot)), false)
})

test("a second changed table cell or an ambiguous source occurrence is not this bounded defect", () => {
  const f = fixture(),
    row = record(completionRows(f.before, f.table_id)[2])
  array(record(row.table_row).cells)[1] = [completionSpan("  • another", true)]
  assert.equal(deriveBodyCompletion(completionSource, f.marker, f.before), undefined)
  const g = fixture()
  const other = record(completionRows(g.before, g.first_table_id)[1])
  array(array(record(other.table_row).cells)[1])[0] = completionSpan("- item", true)
  assert.equal(
    deriveBodyCompletion(completionSource.replace("`one`", "`- item`"), g.marker, g.before),
    undefined,
  )
})

test("after cannot swap an existing same-content ID or reorder retained rows", () => {
  for (const kind of ["swap", "reorder"]) {
    const f = fixture(),
      first = advanceCompletion(f.derived, 0, f.before)
    const second = advanceCompletion(f.derived, 1, first.after)
    if (kind === "swap")
      completionFind(second.after, f.row_id).id = "40000000-0000-4000-8000-000000000002"
    else completionRows(second.after, f.first_table_id).reverse()
    assert.equal(bodyCompletionTransition(f.derived, 1, first.after, second.after), false)
  }
})

test("after consumes every new cell and rejects extra empty nodes even with identical Markdown", () => {
  for (const kind of ["cell", "empty"]) {
    const f = fixture(),
      first = advanceCompletion(f.derived, 0, f.before)
    const second = advanceCompletion(f.derived, 1, first.after)
    if (kind === "cell") {
      const row = record(completionRows(second.after, f.table_id).at(-1))
      array(record(row.table_row).cells)[0] = [completionSpan("Unsubmitted")]
    } else {
      const empty = structuredClone(record(completionRoots(second.after)[0]))
      empty.id = "40000000-0000-4000-8000-000000000003"
      empty.paragraph = { rich_text: [], color: "default" }
      completionRoots(second.after).push(empty)
    }
    assert.equal(bodyCompletionTransition(f.derived, 1, first.after, second.after), false)
  }
})

test("only genuine nondecreasing edit timestamps can change on the affected owner and blocks", () => {
  for (const kind of ["owner_backwards", "row_backwards", "table_invalid", "user_field"]) {
    const f = fixture(),
      { after } = advanceCompletion(f.derived, 0, f.before)
    if (kind === "owner_backwards")
      after.page_before.last_edited_time = after.page_after.last_edited_time =
        "2026-10-19T00:00:00.000Z"
    if (kind === "row_backwards")
      completionFind(after, f.row_id).last_edited_time = "2026-10-19T00:00:00.000Z"
    if (kind === "table_invalid") completionFind(after, f.table_id).last_edited_time = "invalid"
    if (kind === "user_field") {
      record(after.page_before.properties).custom = { last_edited_time: "changed" }
      record(after.page_after.properties).custom = { last_edited_time: "changed" }
    }
    assert.equal(bodyCompletionTransition(f.derived, 0, f.before, after), false)
  }
})

test("real append ACK must name the exact complete new IDs in order", () => {
  const f = fixture(),
    first = advanceCompletion(f.derived, 0, f.before)
  const second = advanceCompletion(f.derived, 1, first.after)
  assert.equal(
    bodyCompletionAckMatches(f.derived, 1, { id: f.table_id }, first.after, second.after),
    false,
  )
  const response = record(structuredClone(second.response))
  array(response.results).reverse()
  assert.equal(bodyCompletionAckMatches(f.derived, 1, response, first.after, second.after), false)
})

test("stable dual reads ignore only response envelope request IDs", () => {
  const f = fixture(),
    later = structuredClone(f.before)
  later.page_before.request_id = "later"
  later.page_after.request_id = "later"
  later.markdown.request_id = "later"
  for (const value of Object.values(later.inventories)) value.request_id = "later"
  assert.equal(stableBodyCompletionSnapshot(f.before, later), true)
  record(later.page_before.properties).request_id = "user edit"
  record(later.page_after.properties).request_id = "user edit"
  assert.equal(stableBodyCompletionSnapshot(f.before, later), false)
})
