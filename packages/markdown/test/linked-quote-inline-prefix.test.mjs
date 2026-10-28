import assert from "node:assert/strict"
import test from "node:test"
import { samePublishedMarkdown } from "../../core/src/markdown.ts"
import { fromNotionMarkdown, markdownStructure } from "../src/index.ts"

const span = (text, code = false, link = null) => ({ text, code, link, bold: false })
const leaf = (id, type, rich_text) => ({ id, type, has_children: false, rich_text })
function fixture(first = false) {
  const code = "`--content` is required; keep [details](../details.md)."
  const prefix = first ? [] : ["Keep the first separate instruction."]
  const head = ["# Start", "> Read [shared](../shared/SKILL.md)."]
  return {
    source: [
      head[0],
      "",
      head[1],
      "",
      ...prefix.flatMap((line) => [line, ""]),
      code,
      "",
      "## End",
      "",
    ].join("\n"),
    actual: [...head, ...prefix, code, "## End"].join("\n"),
    blocks: [
      leaf("start", "heading_1", [span("Start")]),
      leaf("quote", "quote", [
        span("Read "),
        span("shared", false, "../shared/SKILL.md"),
        span("."),
      ]),
      ...prefix.map((text) => leaf("first", "paragraph", [span(text)])),
      leaf("code-first", "paragraph", [
        span("--content", true),
        span(" is required; keep "),
        span("details", false, "../details.md"),
        span("."),
      ]),
      leaf("end", "heading_2", [span("End")]),
    ],
  }
}
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, f.blocks)

test("a leading inline code span can begin either complete physical sibling after a linked quote", () => {
  for (const first of [true, false]) {
    const f = fixture(first),
      before = structuredClone(f)
    assert.equal(samePublishedMarkdown(f.actual, f.source), false)
    assert.equal(matches(f), true)
    assert.deepEqual(
      markdownStructure(fromNotionMarkdown(f.actual, f.blocks)),
      markdownStructure(f.source),
    )
    assert.deepEqual(f, before)
  }
})

test("the full physical code span, following prose and destination must match the readback", () => {
  for (const change of [
    (node) => {
      node.rich_text[0].code = false
    },
    (node) => {
      node.rich_text[0].text = "--different"
    },
    (node) => {
      node.rich_text[1].text = " is optional; keep "
    },
    (node) => {
      node.rich_text[2].link = "../different.md"
    },
    (node) => {
      node.has_children = true
    },
  ]) {
    const f = fixture()
    change(f.blocks.find((block) => block.id === "code-first"))
    assert.equal(matches(f), false)
  }
})

test("missing, extra or reordered siblings and ambiguous anchors cannot authorize a boundary", () => {
  for (const change of [
    (f) => {
      f.blocks.splice(2, 1)
    },
    (f) => {
      f.blocks.splice(3, 0, leaf("extra", "paragraph", [span("Unobserved sibling.")]))
    },
    (f) => {
      ;[f.blocks[2], f.blocks[3]] = [f.blocks[3], f.blocks[2]]
    },
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[0].id = f.blocks[1].id
    },
    (f) => {
      f.blocks[0].rich_text[0].text = "Other start"
    },
    (f) => {
      f.blocks.at(-1).rich_text[0].text = "Other end"
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("unclosed delimiters, code fences and indented code stay outside paragraph eligibility", () => {
  for (const replacement of [
    "`--content is required; keep [details](../details.md).",
    "```text\n--content is required; keep [details](../details.md).\n```",
    "\t`--content` is required; keep [details](../details.md).",
    "\\`--content\\` is required; keep [details](../details.md).",
  ]) {
    const f = fixture()
    f.actual = f.actual.replace(
      "`--content` is required; keep [details](../details.md).",
      replacement,
    )
    assert.equal(matches(f), false)
  }
})

test("even agreeing physical and Markdown changes still fail against the unchanged source", () => {
  const f = fixture()
  f.actual = f.actual.replace("`--content`", "`--different`")
  f.blocks.find((block) => block.id === "code-first").rich_text[0].text = "--different"
  assert.equal(matches(f), false)
  const g = fixture()
  g.actual = g.actual.replace("../details.md", "../different.md")
  g.blocks.find((block) => block.id === "code-first").rich_text[2].link = "../different.md"
  assert.equal(matches(g), false)
})
