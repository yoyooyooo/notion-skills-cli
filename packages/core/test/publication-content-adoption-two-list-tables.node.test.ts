import { test } from "vitest"
import assert from "node:assert/strict"
import type { NotionBlockBoundary, NotionQuoteNode } from "@notion-skills-cli/markdown"
import { priorContentAdoptionGraphs } from "../src/publication-content-adoption-graph.ts"

const span = (text: string) => ({ text, link: null, bold: false, code: false })
function tableNodes(owner: string, prefix: string): NotionQuoteNode[] {
  return [
    {
      id: `${prefix}-table`,
      parent_id: owner,
      type: "table",
      has_children: true,
      table: { width: 1, header_row: true, header_column: false },
    },
    {
      id: `${prefix}-header`,
      parent_id: `${prefix}-table`,
      type: "table_row",
      has_children: false,
      table_row: { cells: [[span(`${prefix} heading`)]] },
    },
    {
      id: `${prefix}-row`,
      parent_id: `${prefix}-table`,
      type: "table_row",
      has_children: false,
      table_row: { cells: [[span(`${prefix} cell`)]] },
    },
  ]
}
function fixture(ordered = true) {
  const pair: NotionBlockBoundary = {
    id: "pair",
    type: ordered ? "numbered_list_item" : "bulleted_list_item",
    has_children: true,
    rich_text: [span("Two complete direct tables")],
    ...(ordered ? { numbered_list: { start: 7 } } : {}),
    list_table_descendants: [...tableNodes("pair", "first"), ...tableNodes("pair", "second")],
  }
  const single: NotionBlockBoundary = {
    id: "single",
    type: "numbered_list_item",
    has_children: true,
    rich_text: [span("Established single table")],
    numbered_list: { start: 4 },
    list_table_descendants: tableNodes("single", "single"),
  }
  const ordinary: NotionBlockBoundary = {
    id: "ordinary",
    type: "numbered_list_item",
    has_children: true,
    rich_text: [span("Ordinary nested list")],
    numbered_list: { start: 15 },
    descendants: [
      {
        id: "ordinary-child",
        parent_id: "ordinary",
        type: "bulleted_list_item",
        has_children: false,
        rich_text: [span("Complete child")],
      },
    ],
  }
  const heading: NotionBlockBoundary = {
    id: "heading",
    type: "heading_2",
    has_children: false,
    text: "End",
    rich_text: [span("End")],
  }
  const page = {
    id: "page",
    path: "references/retained.md",
    markdown: "The complete original Markdown.\n",
    blocks: [pair, single, ordinary, heading],
  }
  return { pair, single, ordinary, heading, page, pages: [page] }
}

test("the immediate two-table model changes only the formerly absent pair projection", () => {
  for (const ordered of [false, true]) {
    const value = fixture(ordered),
      before = JSON.stringify(value.pages)
    const candidates = priorContentAdoptionGraphs(value.pages)
    const immediate = candidates?.[0]
    assert.equal(immediate?.model, "before-two-list-tables")
    assert.ok(immediate)
    const expected = { ...value.pair }
    delete expected.list_table_descendants
    delete expected.numbered_list
    assert.deepEqual(immediate.pages, [
      { ...value.page, blocks: [expected, value.single, value.ordinary, value.heading] },
    ])
    assert.equal(JSON.stringify(value.pages), before)
    assert.deepEqual(immediate.pages[0]!.blocks![1]!.numbered_list, { start: 4 })
    assert.deepEqual(immediate.pages[0]!.blocks![2]!.numbered_list, { start: 15 })
  }
})

test("a pair is eligible for a prior digest only after its entire bounded tree validates", () => {
  const value = fixture(),
    nodes = value.pair.list_table_descendants!
  const replace = (index: number, node: NotionQuoteNode) =>
    nodes.map((prior, at) => (at === index ? node : prior))
  const mutations: readonly [string, readonly NotionQuoteNode[]][] = [
    ["empty tree", []],
    ["second table has no rows", nodes.slice(0, 4)],
    ["foreign second owner", replace(3, { ...nodes[3]!, parent_id: "single" })],
    ["row borrowed from first table", replace(5, { ...nodes[5]!, parent_id: "first-table" })],
    ["duplicate row identity", replace(5, { ...nodes[5]!, id: nodes[1]!.id })],
    ["unread row child", replace(5, { ...nodes[5]!, has_children: true })],
    [
      "wrong width",
      replace(3, { ...nodes[3]!, table: { width: 2, header_row: true, header_column: false } }),
    ],
    [
      "wrong table header",
      replace(3, { ...nodes[3]!, table: { width: 1, header_row: false, header_column: false } }),
    ],
    ["third complete table", [...nodes, ...tableNodes("pair", "third")]],
    [
      "intermediate paragraph",
      [
        ...nodes.slice(0, 3),
        { id: "between", parent_id: "pair", type: "paragraph", has_children: false, rich_text: [] },
        ...nodes.slice(3),
      ],
    ],
    [
      "unsupported projected field",
      replace(3, { ...nodes[3]!, code: { text: "", language: "plain text" } }),
    ],
  ]
  for (const [name, changed] of mutations) {
    const pair = { ...value.pair, list_table_descendants: changed }
    assert.equal(
      priorContentAdoptionGraphs([
        { ...value.page, blocks: [pair, value.single, value.ordinary, value.heading] },
      ]),
      undefined,
      name,
    )
  }
  for (const pair of [
    { ...value.pair, has_children: false },
    { ...value.pair, numbered_list: { start: 0 } },
    { ...value.pair, unexpected: true },
  ])
    assert.equal(priorContentAdoptionGraphs([{ ...value.page, blocks: [pair] }]), undefined)
})

test("every older deployed model builds on the two-table prior view without altering retained text", () => {
  const value = fixture(),
    candidates = priorContentAdoptionGraphs(value.pages)
  assert.ok(candidates)
  assert.deepEqual(
    candidates.map((candidate) => candidate.model),
    [
      "before-two-list-tables",
      "before-ordinary-numbered-start",
      "root-headings-before-container-evidence",
      "before-root-headings",
    ],
  )
  for (const candidate of candidates) {
    const page = candidate.pages[0]!,
      pair = page.blocks![0]!
    assert.equal(page.id, value.page.id)
    assert.equal(page.path, value.page.path)
    assert.equal(page.markdown, value.page.markdown)
    assert.deepEqual(
      page.blocks!.map((block) => block.id),
      value.page.blocks.map((block) => block.id),
    )
    assert.equal(pair.list_table_descendants, undefined)
    assert.equal(pair.numbered_list, undefined)
    assert.deepEqual(pair.rich_text, value.pair.rich_text)
    assert.equal(pair.has_children, true)
  }
  const ordinaryPrior = candidates.find(
    (candidate) => candidate.model === "before-ordinary-numbered-start",
  )
  assert.deepEqual(ordinaryPrior?.pages[0]!.blocks![1], value.single)
  assert.equal(ordinaryPrior?.pages[0]!.blocks![2]!.numbered_list, undefined)
})

test("established single tables do not invent a pair transition or replace other graph bytes", () => {
  const value = fixture()
  const singleOnly = priorContentAdoptionGraphs([
    { ...value.page, blocks: [value.single, value.heading] },
  ])
  assert.equal(
    singleOnly?.some((candidate) => candidate.model === "before-two-list-tables"),
    false,
  )
  const changed = { ...value.page, markdown: value.page.markdown + "A different complete body.\n" }
  const originalPrior = priorContentAdoptionGraphs(value.pages)?.[0]
  const changedPrior = priorContentAdoptionGraphs([changed])?.[0]
  assert.ok(originalPrior && changedPrior)
  assert.notDeepEqual(changedPrior.pages, originalPrior.pages)
  assert.equal(changedPrior.pages[0]!.markdown, changed.markdown)
  // This helper reconstructs digests only. The caller still requires exact raw
  // resources before comparing any candidate to the entire frozen graph hash.
  assert.equal(
    JSON.stringify(value.single.list_table_descendants),
    JSON.stringify(changedPrior.pages[0]!.blocks![1]!.list_table_descendants),
  )
})
