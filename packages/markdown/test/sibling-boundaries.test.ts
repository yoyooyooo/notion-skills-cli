import assert from "node:assert/strict"
import { test } from "bun:test"
import {
  fromNotionMarkdown,
  markdownStructure,
  type NotionBlockBoundary,
  type NotionTextSpan,
} from "../src/index.ts"
import { nestedParagraphBoundaries, richQuoteBoundaries } from "../src/sibling-boundaries.ts"

const span = (text: string, extra: Partial<NotionTextSpan> = {}): NotionTextSpan => ({
  text,
  bold: false,
  code: false,
  link: null,
  ...extra,
})
const root = (id: string, type: string, text: string): NotionBlockBoundary => ({
  id,
  type,
  text,
  has_children: false,
  rich_text: [span(text)],
})
const source =
  "1. Before.\n2. Parent.\n   - Branch.\n     - Nested.\n   - Last child.\n\n   First sibling.\n\n   Second sibling.\n3. After."
const actual = source.replaceAll("\n\n", "\n")
const roots = (): NotionBlockBoundary[] => [
  root("before", "numbered_list_item", "Before."),
  {
    ...root("parent", "numbered_list_item", "Parent."),
    has_children: true,
    descendants: [
      {
        ...root("branch", "bulleted_list_item", "Branch."),
        parent_id: "parent",
        has_children: true,
      },
      { ...root("nested", "bulleted_list_item", "Nested."), parent_id: "branch" },
      { ...root("last", "bulleted_list_item", "Last child."), parent_id: "parent" },
      { ...root("p1", "paragraph", "First sibling."), parent_id: "parent" },
      { ...root("p2", "paragraph", "Second sibling."), parent_id: "parent" },
    ],
  },
  root("after", "numbered_list_item", "After."),
]
const nested = (body: string, blocks = roots()) =>
  nestedParagraphBoundaries(body, blocks, markdownStructure)

test("read, comparison and export conversion share exact nested sibling boundaries", () => {
  const blocks = roots(),
    before = JSON.stringify(blocks)
  assert.equal(nested(actual, blocks), source)
  assert.equal(fromNotionMarkdown(actual, blocks), source)
  assert.deepEqual(markdownStructure(fromNotionMarkdown(actual, blocks)), markdownStructure(source))
  assert.equal(fromNotionMarkdown(source, blocks), source)
  assert.equal(JSON.stringify(blocks), before)
  assert.equal(nested(source, blocks), undefined)
})

test("legacy, incomplete, duplicate, foreign and non-DFS descendant evidence cannot repair", () => {
  const missing = roots()
  Reflect.deleteProperty(missing[1]!, "descendants")
  const parent = roots()
  Object.assign(parent[1]!.descendants![3]!, { parent_id: "branch" })
  const duplicate = roots()
  Object.assign(duplicate[1]!.descendants![3]!, { id: "nested" })
  const closed = roots()
  Object.assign(closed[1]!.descendants![4]!, { parent_id: "branch" })
  const absent = roots()
  Object.assign(absent[1]!, {
    descendants: absent[1]!.descendants!.filter((child) => child.id !== "nested"),
  })
  const leaf = roots()
  Object.assign(leaf[1]!.descendants![3]!, { has_children: true })
  const unsupported = roots()
  Object.assign(unsupported[1]!.descendants![3]!, { type: "synced_block" })
  for (const blocks of [missing, parent, duplicate, closed, absent, leaf, unsupported])
    assert.equal(nested(actual, blocks), undefined)
})

test("child bytes, indentation, order and adjacent physical roots stay exact", () => {
  for (const body of [
    actual.replace("First sibling.", "Changed sibling."),
    actual.replace("   First sibling.\n", ""),
    actual.replace("   First sibling.", "   First sibling.\n   Unobserved."),
    actual.replace("Nested.", "Changed nested."),
    actual.replace("   First sibling.", "     First sibling."),
    "```text\n" + actual + "\n```",
    actual + "\n4. Parent.",
  ])
    assert.equal(nested(body), undefined)
  const changed = roots()
  Object.assign(changed[1]!.descendants![3]!, { rich_text: [span("Edited.")] })
  const reversed = roots()
  Object.assign(reversed[1]!, { descendants: [...reversed[1]!.descendants!].reverse() })
  const before = roots()
  Object.assign(before[0]!, { text: "Other.", rich_text: [span("Other.")] })
  for (const blocks of [changed, reversed, before, roots().slice(0, -1), roots().reverse()])
    assert.equal(nested(actual, blocks), undefined)
})

test("nested paragraph code and full link destinations remain physical evidence", () => {
  const blocks = roots()
  Object.assign(blocks[1]!.descendants![3]!, {
    rich_text: [
      span("First sibling.", { bold: true, code: true, link: "https://example.invalid/source" }),
    ],
  })
  const body = actual.replace(
    "First sibling.",
    "[`First sibling.`](https://example.invalid/source)",
  )
  const target = source.replace(
    "First sibling.",
    "[`First sibling.`](https://example.invalid/source)",
  )
  assert.equal(nested(body, blocks), target)
  assert.equal(nested(body.replace("/source", "/changed"), blocks), undefined)
  assert.equal(nested(body.replaceAll("`", ""), blocks), undefined)
})

const quoteRoots = (): NotionBlockBoundary[] => [
  root("a", "heading_1", "Before"),
  {
    id: "b",
    type: "quote",
    has_children: false,
    rich_text: [
      span("Notice", { bold: true }),
      span(" use "),
      span("a/reference.md", { code: true, link: "../a/reference.md" }),
      span(" safely."),
    ],
  },
  root("c", "paragraph", "This is a separate paragraph."),
  root("d", "heading_2", "After"),
]
const quoteBody =
  "# Before\n\n> **Notice** use [`a/reference.md`](../a/reference.md) safely.\nThis is a separate paragraph.\n\n## After\n"
const quoteSource = quoteBody.replace("\nThis is", "\n\nThis is")
const quote = (body: string, blocks = quoteRoots()) =>
  richQuoteBoundaries(body, blocks, markdownStructure)

test("rich quote repair inserts one LF using both actual heading siblings", () => {
  const blocks = quoteRoots(),
    before = JSON.stringify(blocks)
  assert.equal(quote(quoteBody, blocks), quoteSource)
  assert.equal(fromNotionMarkdown(quoteBody, blocks), quoteSource)
  assert.equal(fromNotionMarkdown(quoteSource, blocks), quoteSource)
  assert.equal(quote(quoteSource, blocks), undefined)
  assert.equal(JSON.stringify(blocks), before)
})

test("missing, repeated, reordered and intervening roots cannot locate a quote repair", () => {
  const blocks = quoteRoots()
  for (const evidence of [
    blocks.slice(1),
    [blocks[0]!, blocks[1]!, blocks[1]!, ...blocks.slice(2)],
    blocks.slice().reverse(),
    [blocks[0]!, blocks[1]!, { id: "x", type: "divider", has_children: false }, ...blocks.slice(2)],
  ])
    assert.equal(quote(quoteBody, evidence), undefined)
  for (const body of [
    quoteBody + quoteBody,
    quoteBody + "\n# Before\n",
    "```md\n" + quoteBody + "```\n",
    quoteBody.replace("\nThis is", "\nExtra\nThis is"),
    quoteBody.replace("# Before", "Before"),
    quoteBody.replace("## After", "## Other"),
    quoteBody.replace("\nThis is", "\n> This is"),
  ])
    assert.equal(quote(body), undefined)
})

test("quote links, code, prose and every leaf root must be authenticated", () => {
  for (const [from, to] of [
    ["(../a/reference.md)", "(https://example.com/reference.md)"],
    ["`a/reference.md`", "a/reference.md"],
    [" safely.", " differently."],
  ])
    assert.equal(quote(quoteBody.replace(from!, to!)), undefined)
  for (let index = 0; index < 4; index++) {
    const children = quoteRoots()
    Object.assign(children[index]!, { has_children: true })
    const missing = quoteRoots()
    Reflect.deleteProperty(missing[index]!, "rich_text")
    assert.equal(quote(quoteBody, children), undefined)
    assert.equal(quote(quoteBody, missing), undefined)
  }
  const changed = quoteRoots()
  Object.assign(changed[1]!.rich_text![2]!, { link: "../a/other.md" })
  const missingFlag = quoteRoots()
  Reflect.deleteProperty(missingFlag[1]!.rich_text![2]!, "code")
  const conflicting = quoteRoots()
  Object.assign(conflicting[1]!, { text: "Contradictory" })
  for (const blocks of [changed, missingFlag, conflicting])
    assert.equal(quote(quoteBody, blocks), undefined)
})

test("boundary repairs leave unrelated instruction and URL changes visible", () => {
  const changed = quoteBody + "\n[Outside](https://example.com/changed)\n"
  const repaired = quote(changed)
  assert.equal(repaired, changed.replace("\nThis is", "\n\nThis is"))
  assert.notDeepEqual(
    markdownStructure(repaired!),
    markdownStructure(quoteSource + "\n[Outside](https://example.com/original)\n"),
  )
  assert.equal(repaired!.replaceAll("\n", ""), changed.replaceAll("\n", ""))
})
