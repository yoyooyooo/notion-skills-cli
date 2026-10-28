import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
} from "../../markdown/src/index.ts"
import { samePublishedMarkdown, type NotionBlockBoundary } from "../src/markdown.ts"

const root = (id: string, text: string, type = "paragraph"): NotionBlockBoundary => ({
  id,
  type,
  has_children: false,
  text,
  rich_text: [{ text, link: null, bold: false, code: false }],
})
const escape = (text: string) => text.replace(/[<>]/g, (character) => `\\${character}`)
const fixture = () => ({
  target:
    "<overview>\n\nKeep every instruction.\n\n</overview>\n\n<writing-rules>\n\n## Tasks\n\nFinish carefully.\n\n</writing-rules>\n",
  actual:
    "\\<overview\\>\nKeep every instruction.\n\\</overview\\>\n\\<writing-rules\\>\n## Tasks\nFinish carefully.\n\\</writing-rules\\>",
  roots: [
    root("one", "<overview>"),
    root("two", "Keep every instruction."),
    root("three", "</overview>"),
    root("four", "<writing-rules>"),
    root("five", "Tasks", "heading_2"),
    root("six", "Finish carefully."),
    root("seven", "</writing-rules>"),
  ],
})
const matches = (actual: string, target: string, roots?: readonly NotionBlockBoundary[]) =>
  samePublishedMarkdown(actual, target, undefined, roots)
test("isolated custom HTML tags retain exact literal bytes at original root boundaries", () => {
  const f = fixture(),
    before = JSON.stringify(f),
    candidate = notionMarkdownForComparison(f.actual, f.target, f.roots)
  assert.equal(
    sameMarkdownStructure(markdownStructure(f.actual), markdownStructure(f.target)),
    false,
  )
  assert.ok(candidate)
  assert.equal(
    sameMarkdownStructure(markdownStructure(candidate), markdownStructure(f.target)),
    true,
  )
  assert.equal(matches(f.actual, f.target, f.roots), true)
  assert.equal(JSON.stringify(f), before)
  assert.equal(fromNotionMarkdown(f.actual, f.roots), f.actual)
})
test("a multiline HTML token requires every literal source line in contiguous physical roots", () => {
  const literal = "<task-instructions>\nKeep the original words.\n</task-instructions>"
  const target = "Before\n\n" + literal + "\n\nAfter"
  const actual = "Before\n" + escape(literal) + "\nAfter"
  const roots = [
    root("a", "Before"),
    root("b", "<task-instructions>"),
    root("c", "Keep the original words."),
    root("d", "</task-instructions>"),
    root("e", "After"),
  ]
  assert.equal(matches(actual, target, roots), true)
  assert.equal(
    matches(
      actual,
      target,
      roots.filter((value) => value.id !== "c"),
    ),
    false,
  )
  assert.equal(matches(actual.replace("original", "changed"), target, roots), false)
  assert.equal(matches(actual, target.replace("original", "changed"), roots), false)
})
test("a single literal quote restores all original tags with exact physical text", () => {
  const body = "Status: set <N> after <reason one> then <reason two>."
  const target = "Before\n\n> " + body + "\n\nAfter"
  const actual = "Before\n> " + escape(body) + "\nAfter"
  const roots = [root("a", "Before"), root("b", body, "quote"), root("c", "After")]
  assert.equal(matches(actual, target, roots), true)
  for (const value of [
    root("b", body),
    root("b", body.replace("one", "other"), "quote"),
    { ...roots[1]!, has_children: true },
  ])
    assert.equal(matches(actual, target, [roots[0]!, value, roots[2]!]), false)
  assert.equal(matches(actual.replace("reason two", "other text"), target, roots), false)
})
test("missing, duplicate, reordered, or child-bearing roots cannot grant a literal HTML repair", () => {
  const f = fixture()
  for (const roots of [
    undefined,
    [],
    f.roots.slice(1),
    [f.roots[1]!, f.roots[0]!, ...f.roots.slice(2)],
    f.roots.map((value, index) => (index === 3 ? { ...value, id: "one" } : value)),
    f.roots.map((value, index) => (index === 0 ? { ...value, has_children: true } : value)),
  ])
    assert.equal(matches(f.actual, f.target, roots), false)
})
test("linked, bold, code, or contradictory literal spans supply no plain-root proof", () => {
  const f = fixture()
  for (const patch of [{ link: "https://example.test" }, { bold: true }, { code: true }]) {
    const roots = f.roots.map((value, index) =>
      index === 0 ? { ...value, rich_text: [{ ...value.rich_text![0]!, ...patch }] } : value,
    )
    assert.equal(matches(f.actual, f.target, roots), false)
  }
  assert.equal(
    matches(
      f.actual,
      f.target,
      f.roots.map((value, index) => (index === 0 ? { ...value, text: "Different" } : value)),
    ),
    false,
  )
})
test("attributes, inline tag constructs, destinations, and unproved tag-like text remain outside the family", () => {
  for (const literal of [
    '<instruction href="https://example.test">',
    '<instruction data-value="a">',
    "<script>alert(1)</script>",
    "<!DOCTYPE html>",
  ]) {
    const target = literal + "\n\nAfter",
      actual = escape(literal) + "\nAfter"
    assert.equal(matches(actual, target, [root("a", literal), root("b", "After")]), false)
  }
  const body = "Status <value> ends."
  assert.equal(matches("> " + escape(body), "> " + body, [root("q", body, "quote")]), true)
  assert.equal(matches("> " + escape(body), "> " + body, [root("q", body, "paragraph")]), false)
})
test("whole-body comparison rejects unrelated source, URL, or prose changes outside repaired roots", () => {
  const f = fixture()
  assert.equal(matches(f.actual + "\nUnsubmitted.", f.target, f.roots), false)
  assert.equal(matches(f.actual, f.target + "\nMissing instruction.", f.roots), false)
  const target = "Before [link](https://example.test/a)\n\n<tag-one>\n\nAfter"
  const actual = "Before [link](https://example.test/b)\n\\<tag-one\\>\nAfter"
  const first: NotionBlockBoundary = {
    ...root("a", "Before link"),
    rich_text: [
      { text: "Before ", link: null, bold: false, code: false },
      { text: "link", link: "https://example.test/b", bold: false, code: false },
    ],
  }
  assert.equal(matches(actual, target, [first, root("b", "<tag-one>"), root("c", "After")]), false)
})
test("repeated tag texts cannot borrow physical positions from another identical root", () => {
  const target = "<repeat-tag>\n\nFirst\n\n<repeat-tag>\n\nSecond"
  const actual = "\\<repeat-tag\\>\nFirst\n\\<repeat-tag\\>\nSecond"
  assert.equal(
    matches(actual, target, [
      root("a", "<repeat-tag>"),
      root("b", "First"),
      root("c", "<repeat-tag>"),
      root("d", "Second"),
    ]),
    false,
  )
})
