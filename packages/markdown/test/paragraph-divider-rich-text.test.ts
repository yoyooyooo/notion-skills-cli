import assert from "node:assert/strict"
import { test } from "node:test"
import * as candidate from "../src/index.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "../src/index.ts"

const url = "https://example.test/exact?key=one#section"
const code = "literal\n---\nkeep  code"
const sentence = `Read **private**\n\`code  bytes\` and [docs](${url}).`
const actual = `# Start\n\n\`\`\`text\n${code}\n\`\`\`\n\n${sentence}\n---\n\n## Middle\n\nSecond paragraph.\n---\n\n## End\n\nDone.`
const target = actual.replaceAll(".\n---", ".\n\n---")
const plain = (text: string, extra: Partial<NotionTextSpan> = {}): NotionTextSpan => ({
  text,
  link: null,
  bold: false,
  code: false,
  ...extra,
})
const spans = [
  plain("Read "),
  plain("private", { bold: true }),
  plain("\n"),
  plain("code  bytes", { code: true }),
  plain(" and "),
  plain("docs", { link: url }),
  plain("."),
]
const roots: readonly NotionBlockBoundary[] = [
  { id: "start", type: "heading_1", has_children: false },
  { id: "code", type: "code", has_children: false, code: { language: "text", text: code } },
  { id: "first", type: "paragraph", has_children: false, rich_text: spans },
  { id: "first-rule", type: "divider", has_children: false },
  { id: "middle", type: "heading_2", has_children: false },
  { id: "second", type: "paragraph", has_children: false, text: "Second paragraph." },
  { id: "second-rule", type: "divider", has_children: false },
  { id: "end", type: "heading_2", has_children: false },
  { id: "done", type: "paragraph", has_children: false, text: "Done." },
]
const proof = (raw = actual, expected = target, blocks = roots) =>
  candidate.notionMarkdownForComparison(raw, expected, blocks)
const full = (raw = actual, expected = target, blocks = roots) => {
  const value = proof(raw, expected, blocks)
  return value !== undefined && candidate.sameNotionMarkdown(value, expected)
}
const withSpan = (index: number, patch: Partial<NotionTextSpan>) =>
  roots.map((root) =>
    root.id === "first"
      ? {
          ...root,
          rich_text: spans.map((span, offset) => (offset === index ? { ...span, ...patch } : span)),
        }
      : root,
  )

test("rich-text soft breaks bind both original paragraph-divider pairs without changing authored content", () => {
  const before = JSON.stringify(roots)
  assert.equal(
    candidate.sameNotionMarkdown(candidate.fromNotionMarkdown(actual, roots), target),
    false,
  )
  const result = proof()
  if (result === undefined) throw new Error("Missing source-bound rich-text divider candidate")
  assert.equal(candidate.sameNotionMarkdown(result, target), true)
  assert.equal(result.includes(code), true)
  assert.equal(result.includes("`code  bytes`"), true)
  assert.equal(result.includes(url), true)
  assert.equal(result.replaceAll(".\n\n---", ".\n---"), candidate.fromNotionMarkdown(actual, roots))
  assert.equal(JSON.stringify(roots), before)
})

test("rich-text divider binding needs original spans and preserves code bytes and annotations", () => {
  const withoutSpans = roots.map((root) => {
    if (root.id !== "first") return root
    const { rich_text: _spans, ...rest } = root
    return { ...rest, text: spans.map((span) => span.text).join("") }
  })
  for (const blocks of [
    withoutSpans,
    withSpan(3, { text: "code bytes" }),
    withSpan(3, { code: false }),
    withSpan(0, { text: "Other " }),
  ])
    assert.equal(full(actual, target, blocks), false)
})

test("rich-text divider binding retains full explicit link schemes, paths, queries and fragments", () => {
  for (const changed of [
    url.replace("https:", "http:"),
    url.replace("/exact", "/elsewhere"),
    url.replace("one", "two"),
    url.replace("#section", "#other"),
  ]) {
    assert.equal(full(actual, target, withSpan(5, { link: changed })), false)
    assert.equal(full(actual.replace(url, changed)), false)
  }
})

test("rich-text divider binding rejects missing, moved, duplicate, nested and unknown original roots", () => {
  assert.equal(
    full(
      actual,
      target,
      roots.filter((root) => root.id !== "first-rule"),
    ),
    false,
  )
  assert.equal(
    full(
      actual,
      target,
      roots.map((root) => ({ ...root, id: "duplicate" })),
    ),
    false,
  )
  assert.equal(
    full(
      actual,
      target,
      roots.map((root) => (root.id === "first" ? { ...root, has_children: true } : root)),
    ),
    false,
  )
  assert.equal(
    full(
      actual,
      target,
      roots.map((root) => (root.id === "middle" ? { ...root, type: "unknown" } : root)),
    ),
    false,
  )
  assert.equal(
    full(actual, target, [
      ...roots.slice(0, 2),
      ...roots.slice(5, 7),
      roots[4]!,
      ...roots.slice(2, 4),
      ...roots.slice(7),
    ]),
    false,
  )
})

test("rich-text divider binding still needs the exact source pair and complete unchanged body", () => {
  assert.equal(full(actual, target.replace(sentence, "Changed paragraph.")), false)
  assert.equal(full(actual, target.replace(`${sentence}\n\n---`, `${sentence}\n---`)), false)
  assert.equal(full(actual.replace("keep  code", "keep code")), false)
  assert.equal(full(actual.replace("Done.", "Changed.")), false)
  assert.equal(full(actual.replace(".\n---", ".\n----")), false)
})

test("rich-text divider binding treats original plain-span stars as literal text", () => {
  const blocks = withSpan(1, { text: "*private*", bold: false })
  assert.equal(full(actual, target, blocks), false)
  const literalActual = actual.replace("**private**", "\\*private\\*")
  const literalTarget = target.replace("**private**", "\\*private\\*")
  assert.equal(full(literalActual, literalTarget, blocks), true)
})

test("rich-text divider binding cannot borrow code-break or bare-host readback aliases", () => {
  assert.equal(
    full(
      actual.replace("code  bytes", "a b"),
      target.replace("code  bytes", "a b"),
      withSpan(3, { text: "a<br>b" }),
    ),
    false,
  )
  assert.equal(
    full(
      actual.replace(`[docs](${url})`, "example.test"),
      target.replace(`[docs](${url})`, "example.test"),
      withSpan(5, { text: "example.test", link: "https://example.test" }),
    ),
    false,
  )
})

test("rich-text divider repair neither changes code-language policy nor claims a language write", () => {
  const raw = actual.replace("```text", "```javascript")
  const blocks = roots.map((root) =>
    root.id === "code" ? { ...root, code: { language: "javascript", text: code } } : root,
  )
  const result = proof(raw, target, blocks)
  if (result === undefined) throw new Error("Missing source-bound rich-text divider candidate")
  assert.equal(candidate.sameNotionMarkdown(result, target), true)
  assert.notDeepEqual(candidate.markdownStructure(result), candidate.markdownStructure(target))
  assert.equal(result.includes("```javascript"), true)
  assert.equal(blocks[1]!.code!.language, "javascript")
})
