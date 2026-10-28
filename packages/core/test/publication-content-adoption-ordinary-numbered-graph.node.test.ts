import { test } from "vitest"
import assert from "node:assert/strict"
import type { NotionBlockBoundary } from "@notion-skills-cli/markdown"
import { priorContentAdoptionGraphs } from "../src/publication-content-adoption-graph.ts"

const span = (text: string) => ({ text, link: null, bold: false, code: false })
function fixture(start: number | null = 15) {
  const root = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    type: "numbered_list_item",
    has_children: true,
    rich_text: [span("Head")],
    numbered_list: { start },
    descendants: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        parent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "bulleted_list_item",
        has_children: false,
        rich_text: [span("Child")],
      },
    ],
  }
  const heading = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    type: "heading_1",
    has_children: false,
    text: "Heading",
    rich_text: [span("Heading")],
  }
  const pages = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      path: "SKILL.md",
      markdown: `${start ?? 1}. Head\n    - Child\n\n# Heading\n`,
      blocks: [root, heading],
    },
  ]
  return { root, heading, pages }
}
test("the immediate prior model omits only the new ordinary root start and leaves input intact", () => {
  for (const start of [15, null]) {
    const value = fixture(start),
      before = JSON.stringify(value.pages),
      candidates = priorContentAdoptionGraphs(value.pages)
    const immediate = candidates?.find(
      (candidate) => candidate.model === "before-ordinary-numbered-start",
    )
    assert.ok(immediate)
    const root = immediate.pages[0]!.blocks![0]!
    assert.equal(root.numbered_list, undefined)
    assert.deepEqual(root.descendants, value.root.descendants)
    assert.deepEqual(root.rich_text, value.root.rich_text)
    assert.equal(root.id, value.root.id)
    assert.equal(root.has_children, true)
    assert.deepEqual(immediate.pages[0]!.blocks![1], value.heading)
    assert.equal(immediate.pages[0]!.markdown, value.pages[0]!.markdown)
    assert.equal(JSON.stringify(value.pages), before)
    assert.ok(candidates?.some((candidate) => candidate.model === "before-root-headings"))
    for (const candidate of candidates ?? [])
      assert.equal(candidate.pages[0]!.blocks![0]!.numbered_list, undefined)
  }
})
test("ordinary starts require the same valid complete tree before any prior model is offered", () => {
  const mutations: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      "wrong parent",
      (value) => {
        value.root.descendants[0]!.parent_id = "foreign"
      },
    ],
    [
      "duplicate ID",
      (value) => {
        value.root.descendants[0]!.id = value.root.id
      },
    ],
    [
      "unread child",
      (value) => {
        value.root.descendants[0]!.has_children = true
      },
    ],
    [
      "inconsistent root",
      (value) => {
        value.root.has_children = false
      },
    ],
    [
      "unsupported child",
      (value) => {
        value.root.descendants[0]!.type = "code"
      },
    ],
    [
      "zero start",
      (value) => {
        value.root.numbered_list.start = 0
      },
    ],
  ]
  for (const [name, mutate] of mutations) {
    const value = fixture()
    mutate(value)
    assert.equal(priorContentAdoptionGraphs(value.pages), undefined, name)
  }
  const value = fixture()
  const missing = {
    id: value.root.id,
    type: value.root.type,
    has_children: true,
    rich_text: value.root.rich_text,
    numbered_list: value.root.numbered_list,
  }
  assert.equal(
    priorContentAdoptionGraphs([{ ...value.pages[0]!, blocks: [missing, value.heading] }]),
    undefined,
  )
})
test("the immediate ordinary-start view preserves established list-table start and every table node", () => {
  const value = fixture()
  const table: NotionBlockBoundary = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    type: "numbered_list_item",
    has_children: true,
    rich_text: [span("Table")],
    numbered_list: { start: 7 },
    list_table_descendants: [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        parent_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        type: "table",
        has_children: true,
        table: { width: 1, header_row: true, header_column: false },
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        parent_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        type: "table_row",
        has_children: false,
        table_row: { cells: [[span("Cell")]] },
      },
    ],
  }
  const candidates = priorContentAdoptionGraphs([
    { ...value.pages[0]!, blocks: [...value.pages[0]!.blocks, table] },
  ])
  const immediate = candidates?.find(
    (candidate) => candidate.model === "before-ordinary-numbered-start",
  )
  assert.ok(immediate)
  assert.deepEqual(immediate.pages[0]!.blocks!.at(-1), table)
  assert.deepEqual(table.numbered_list, { start: 7 })
})
