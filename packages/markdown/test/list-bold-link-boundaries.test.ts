import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
  type NotionBlockBoundary,
  type NotionTextSpan,
} from "../src/index.ts"

const label = "alpha.dev"
const continuation = " has native features"
const tail = " and uses `first_key`, followed by `second-key`, finally `third_key`."
const item = `[**${label}**](http://alpha.dev)**${continuation}**${tail}`
const sourceItem = `**${label}${continuation}**${tail}`
const raw = `# Example\nBefore.\n- ${item}\n- Second item.\nAfter [docs](https://example.test/exact).`
const target = `# Example\n\nBefore.\n\n- ${sourceItem}\n- Second item.\n\nAfter [docs](https://example.test/exact).`
const span = (
  text: string,
  bold = false,
  code = false,
  link: string | null = null,
): NotionTextSpan => ({ text, bold, code, link })
const rich: NotionTextSpan[] = [
  span(label, true, false, "http://alpha.dev"),
  span(continuation, true),
  span(" and uses "),
  span("first_key", false, true),
  span(", followed by "),
  span("second-key", false, true),
  span(", finally "),
  span("third_key", false, true),
  span("."),
]
const roots: NotionBlockBoundary[] = [
  { id: "heading", type: "heading_1", has_children: false },
  { id: "before", type: "paragraph", has_children: false, text: "Before." },
  { id: "bullet", type: "bulleted_list_item", has_children: false, rich_text: rich },
  {
    id: "second",
    type: "bulleted_list_item",
    has_children: false,
    rich_text: [span("Second item.")],
  },
  { id: "after", type: "paragraph", has_children: false, text: "After docs." },
]
const normalized = (markdown = raw, blocks = roots) => fromNotionMarkdown(markdown, blocks)
const prove = (markdown = raw, source = target, blocks = roots) =>
  notionMarkdownForComparison(markdown, source, blocks)
const complete = (actual: string, source = target) =>
  sameMarkdownStructure(markdownStructure(actual), markdownStructure(source))
const changedSpans = (transform: (spans: NotionTextSpan[]) => NotionTextSpan[]) =>
  roots.map((block) =>
    block.id === "bullet" ? { ...block, rich_text: transform(structuredClone(rich)) } : block,
  )

test("an exact original list annotation boundary explains only the two malformed pairs", () => {
  const before = normalized(),
    result = prove()
  assert.equal(complete(before), false)
  if (result === undefined) throw new Error("Expected an exact original list candidate")
  assert.equal(complete(result), true)
  assert.equal(result, before.replace(`**${continuation}**`, continuation))
  assert.equal(before.length - result.length, 4)
  for (const code of ["`first_key`", "`second-key`", "`third_key`"])
    assert.ok(result.includes(code))
  assert.ok(result.includes("[**alpha.dev**](http://alpha.dev)"))
  assert.equal(normalized(), before)
})

test("missing, duplicate, non-leaf, or differently typed original roots cannot authorize the edit", () => {
  for (const blocks of [
    [],
    roots.filter((block) => block.id !== "bullet"),
    roots.map((block) => ({ ...block, id: "duplicate" })),
    roots.map((block) => (block.id === "bullet" ? { ...block, has_children: true } : block)),
    roots.map((block) =>
      block.id === "bullet" ? { ...block, type: "numbered_list_item" } : block,
    ),
    roots.map((block) => (block.id === "bullet" ? { ...block, rich_text: undefined } : block)),
  ])
    assert.equal(prove(raw, target, blocks), undefined)
})

for (const [name, index, field, value] of [
  ["first bold", 0, "bold", false],
  ["continuation bold", 1, "bold", false],
  ["first code", 0, "code", true],
  ["continuation code", 1, "code", true],
  ["tail bold", 2, "bold", true],
  ["continuation link", 1, "link", "https://example.test"],
  ["tail link", 2, "link", "https://example.test"],
  ["inline code identity", 3, "code", false],
] as const) {
  test(`the exact original ${name} evidence remains necessary`, () => {
    const blocks = changedSpans((spans) =>
      spans.map((entry, position) => (position === index ? { ...entry, [field]: value } : entry)),
    )
    assert.equal(prove(raw, target, blocks), undefined)
  })
}

test("original link destination and every original text or inline-code segment stay exact", () => {
  assert.equal(prove(raw.replace("http://alpha.dev", "https://alpha.dev")), undefined)
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    const blocks = changedSpans((spans) =>
      spans.map((entry, position) =>
        position === index ? { ...entry, text: entry.text + "changed" } : entry,
      ),
    )
    assert.equal(prove(raw, target, blocks), undefined)
  }
  assert.equal(prove(raw.replace("`first_key`", "`other_key`")), undefined)
  assert.equal(prove(raw, target.replace("`first_key`", "`other_key`")), undefined)
})

test("the authored strong prefix and entire original tail are required", () => {
  assert.equal(prove(raw, target.replace(sourceItem, `${label}${continuation}${tail}`)), undefined)
  assert.equal(prove(raw, target.replace("native", "other")), undefined)
  assert.equal(prove(raw, target.replace("followed", "changed")), undefined)
  assert.equal(prove(raw.replace("followed", "changed")), undefined)
  assert.equal(prove(raw.replace(`**${continuation}**`, `**${continuation}***`)), undefined)
})

test("literal asterisks inside the original inline code remain byte exact", () => {
  const value = "literal ** remains"
  const input = raw.replace("first_key", value),
    source = target.replace("first_key", value)
  const blocks = changedSpans((spans) =>
    spans.map((entry, index) => (index === 3 ? { ...entry, text: value } : entry)),
  )
  const result = prove(input, source, blocks)
  if (result === undefined) throw new Error("Expected an exact original list candidate")
  assert.equal(complete(result, source), true)
  assert.ok(result.includes("`literal ** remains`"))
})

test("unknown or moved original neighbors cannot lend their position to the list item", () => {
  assert.equal(
    prove(
      raw,
      target,
      roots.map((block) => (block.id === "before" ? { ...block, type: "unknown" } : block)),
    ),
    undefined,
  )
  assert.equal(
    prove(raw, target, [roots[0]!, roots[4]!, roots[2]!, roots[3]!, roots[1]!]),
    undefined,
  )
})

test("duplicate source, original, or readback occurrences remain ambiguous", () => {
  assert.equal(
    prove(raw, target.replace("- Second item.", `- ${sourceItem}\n- Second item.`)),
    undefined,
  )
  const more = [...roots.slice(0, 3), { ...roots[2]!, id: "duplicate-bullet" }, ...roots.slice(3)]
  assert.equal(prove(raw, target, more), undefined)
  assert.equal(prove(raw.replace("- Second item.", `- ${item}\n- Second item.`)), undefined)
})

test("the complete comparator still checks every external destination and other body content", () => {
  const result = prove(raw.replace("https://example.test", "http://example.test"))
  if (result === undefined) throw new Error("Expected an exact original list candidate")
  assert.equal(complete(result), false)
  assert.equal(complete(result.replace("After", "Different")), false)
  const evil = raw.replace("http://alpha.dev", "https://elsewhere.test")
  const blocks = changedSpans((spans) =>
    spans.map((entry, index) =>
      index === 0 ? { ...entry, link: "https://elsewhere.test" } : entry,
    ),
  )
  const bounded = prove(evil, target, blocks)
  if (bounded === undefined) throw new Error("Expected an exact original list candidate")
  assert.equal(complete(bounded), false)
})

test("multiline, task, numbered, and CRLF source stay outside this narrow repair", () => {
  assert.equal(prove(raw.replace("- " + item, "- [ ] " + item)), undefined)
  assert.equal(prove(raw.replace("- " + item, "1. " + item)), undefined)
  assert.equal(notionMarkdownForComparison(raw, target.replaceAll("\n", "\r\n"), roots), undefined)
  assert.equal(prove(raw.replace(" and uses ", " and\n  uses ")), undefined)
})
