import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameNotionMarkdown,
  type NotionBlockBoundary,
} from "../src/index.ts"

const body = "A literal example:\n```mermaid\nA --> B\n```"
const raw = `# Example\nBefore.\n\`\`\`markdown\n${body}\n\`\`\`\n## Next\n\`\`\`text\nunchanged\n\`\`\`\nAfter.`
const target = `# Example\n\nBefore.\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n\n## Next\n\n\`\`\`text\nunchanged\n\`\`\`\n\nAfter.`
const roots: NotionBlockBoundary[] = [
  { id: "title", type: "heading_1", has_children: false },
  { id: "before", type: "paragraph", has_children: false, text: "Before." },
  {
    id: "literal-code",
    type: "code",
    has_children: false,
    code: { language: "markdown", text: body },
  },
  { id: "next", type: "heading_2", has_children: false },
  {
    id: "next-code",
    type: "code",
    has_children: false,
    code: { language: "text", text: "unchanged" },
  },
  { id: "after", type: "paragraph", has_children: false, text: "After." },
]
const compare = (input = raw, source = target, blocks = roots) =>
  notionMarkdownForComparison(input, source, blocks)

test("bound original code restores only the outer fence before complete comparison", () => {
  assert.equal(sameNotionMarkdown(fromNotionMarkdown(raw, roots), target), false)
  const candidate = compare()
  assert.notEqual(candidate, undefined)
  if (candidate === undefined) throw new Error("Expected bound code candidate")
  assert.deepEqual(markdownStructure(candidate), markdownStructure(target))
  assert.ok(candidate.includes(body))
  assert.ok(candidate.includes("```text\nunchanged\n```"))
  assert.equal(fromNotionMarkdown(raw, roots).includes("\n````markdown\n"), false)
})

test("the source cannot supply missing code bytes or a different original language", () => {
  assert.equal(compare(raw, target.replace("A --> B", "A --> C")), undefined)
  assert.equal(compare(raw.replace("A --> B", "A --> C")), undefined)
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) =>
        block.id === "literal-code"
          ? { ...block, code: { language: "javascript", text: body } }
          : block,
      ),
    ),
    undefined,
  )
})

test("every original code root must retain complete literal evidence", () => {
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) => ({ ...block, code: undefined })),
    ),
    undefined,
  )
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) => (block.type === "code" ? { ...block, has_children: true } : block)),
    ),
    undefined,
  )
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) =>
        block.id === "next-code"
          ? { ...block, code: { language: "text", text: "different" } }
          : block,
      ),
    ),
    undefined,
  )
})

test("a moved or missing original neighbor cannot prove the frame position", () => {
  assert.equal(
    compare(raw, target, [roots[0]!, roots[5]!, roots[2]!, roots[3]!, roots[4]!, roots[1]!]),
    undefined,
  )
  assert.equal(
    compare(
      raw,
      target,
      roots.filter((block) => block.id !== "before"),
    ),
    undefined,
  )
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) => (block.id === "before" ? { ...block, type: "unknown" } : block)),
    ),
    undefined,
  )
  assert.equal(
    compare(
      raw,
      target,
      roots.map((block) => ({ ...block, id: "duplicate" })),
    ),
    undefined,
  )
})

test("an extra interchangeable raw code frame remains ambiguous", () => {
  const input = `Before.\n\`\`\`markdown\n${body}\n\`\`\`\n\`\`\`markdown\n${body}\n\`\`\`\nAfter.`
  const source = `Before.\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n\nAfter.`
  assert.equal(compare(input, source, [roots[1]!, roots[2]!, roots[5]!]), undefined)
})

test("complete original ordering can disambiguate repeated literal code bodies", () => {
  const input = `Before.\n\`\`\`markdown\n${body}\n\`\`\`\nMiddle.\n\`\`\`markdown\n${body}\n\`\`\`\nAfter.`
  const source = `Before.\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n\nMiddle.\n\n\`\`\`\`markdown\n${body}\n\`\`\`\`\n\nAfter.`
  const blocks = [
    roots[1]!,
    roots[2]!,
    { id: "middle", type: "paragraph", has_children: false, text: "Middle." },
    { ...roots[2]!, id: "repeated-code" },
    roots[5]!,
  ]
  const candidate = compare(input, source, blocks)
  if (candidate === undefined) throw new Error("Expected uniquely ordered frames")
  assert.equal(sameNotionMarkdown(candidate, source), true)
})

test("an info-bearing marker alone does not require changing a valid outer fence", () => {
  const literal = "alpha\n```javascript\nkeep **** exact"
  const source = `Before.\n\n\`\`\`markdown\n${literal}\n\`\`\`\n\nAfter.`
  const input = source.replaceAll("\n\n", "\n")
  const blocks = [
    roots[1]!,
    { ...roots[2]!, code: { language: "markdown", text: literal } },
    roots[5]!,
  ]
  assert.equal(compare(input, source, blocks), undefined)
  assert.equal(sameNotionMarkdown(fromNotionMarkdown(input, blocks), source), true)
})

test("trailing code spaces, empty lines and tabs remain literal", () => {
  const literal = body.replace("A --> B", "\tA --> B  \n\n")
  const input = raw.replace(body, literal)
  const source = target.replace(body, literal)
  const blocks = roots.map((block) =>
    block.id === "literal-code"
      ? { ...block, code: { language: "markdown", text: literal } }
      : block,
  )
  const candidate = compare(input, source, blocks)
  if (candidate === undefined) throw new Error("Expected whitespace-preserving frame")
  assert.ok(candidate.includes(literal))
  assert.equal(sameNotionMarkdown(candidate, source), true)
  assert.equal(compare(input.replace("B  ", "B "), source, blocks), undefined)
})

test("CRLF input and a missing outer close do not authorize a frame candidate", () => {
  assert.equal(compare(raw.replaceAll("\n", "\r\n")), undefined)
  assert.equal(compare(raw.replace(`${body}\n\`\`\`\n##`, `${body}\n##`)), undefined)
})

test("a nested literal frame cannot substitute for a later original code root", () => {
  const inner = "inner body"
  const outer = `literal:\n\`\`\`text\n${inner}\n\`\`\``
  const input = `Before.\n\`\`\`markdown\n${outer}\n\`\`\`\nAfter.`
  const source = `Before.\n\n\`\`\`\`markdown\n${outer}\n\`\`\`\`\n\n\`\`\`text\n${inner}\n\`\`\`\n\nAfter.`
  const blocks = [
    roots[1]!,
    { ...roots[2]!, code: { language: "markdown", text: outer } },
    { ...roots[4]!, code: { language: "text", text: inner } },
    roots[5]!,
  ]
  assert.equal(compare(input, source, blocks), undefined)
})

test("a delimiter candidate does not erase an external URL or ordinary prose difference", () => {
  const input = raw.replace("After.", "After [docs](http://example.test).")
  const source = target.replace("After.", "After [docs](https://example.test).")
  const blocks = roots.map((block) =>
    block.id === "after" ? { ...block, text: "After docs." } : block,
  )
  const candidate = compare(input, source, blocks)
  if (candidate === undefined) throw new Error("Expected delimiter-only candidate")
  assert.ok(candidate.includes("http://example.test"))
  assert.equal(sameNotionMarkdown(candidate, source), false)
  assert.equal(sameNotionMarkdown(candidate, source.replace("After", "Changed")), false)
})
