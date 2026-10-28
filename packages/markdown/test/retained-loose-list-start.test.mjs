import { test } from "node:test"
import assert from "node:assert/strict"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
} from "../src/index.ts"

const first = "**Ask the user before filing.** Show the draft before continuing."
const second = "Run `verify  exact` and visit [guide](https://example.com/guide?q=1#details)."
const source =
  "# Procedure\n\n```text\ntemplate\n```\n\n" +
  `2. ${first}\n\n3. ${second}\n\n## After\n\nTail stays exact.\n`
const span = (text, values = {}) => ({ text, link: null, bold: false, code: false, ...values })

function fixture() {
  return {
    source,
    actual:
      "# Procedure\n```plain text\ntemplate\n```\n" +
      `1. ${first}\n2. ${second}\n## After\nTail stays exact.\n`,
    roots: [
      {
        id: "heading-before",
        type: "heading_1",
        has_children: false,
        text: "Procedure",
        rich_text: [span("Procedure")],
      },
      {
        id: "template",
        type: "code",
        has_children: false,
        code: { language: "plain text", text: "template" },
      },
      {
        id: "second-step",
        type: "numbered_list_item",
        has_children: false,
        numbered_list: { start: 2 },
        rich_text: [
          span("Ask the user before filing.", { bold: true }),
          span(" Show the draft before continuing."),
        ],
      },
      {
        id: "third-step",
        type: "numbered_list_item",
        has_children: false,
        numbered_list: { start: null },
        rich_text: [
          span("Run "),
          span("verify  exact", { code: true }),
          span(" and visit "),
          span("guide", { link: "https://example.com/guide?q=1#details" }),
          span("."),
        ],
      },
      {
        id: "heading-after",
        type: "heading_2",
        has_children: false,
        text: "After",
        rich_text: [span("After")],
      },
      {
        id: "tail",
        type: "paragraph",
        has_children: false,
        text: "Tail stays exact.",
        rich_text: [span("Tail stays exact.")],
      },
    ],
  }
}

function matches(f) {
  const candidate = notionMarkdownForComparison(f.actual, f.source, f.roots)
  return sameMarkdownStructure(
    markdownStructure(candidate ?? f.actual),
    markdownStructure(f.source),
  )
}

test("a loose source leaf keeps its retained positive physical start across a code boundary", () => {
  const f = fixture(),
    before = JSON.stringify(f)
  assert.equal(
    sameMarkdownStructure(
      markdownStructure(fromNotionMarkdown(f.actual, f.roots)),
      markdownStructure(f.source),
    ),
    false,
  )
  assert.equal(matches(f), true)
  const candidate = notionMarkdownForComparison(f.actual, f.source, f.roots)
  assert.ok(candidate.includes(`2. ${first}`))
  assert.equal(JSON.stringify(f), before)
  assert.ok(fromNotionMarkdown(f.actual, f.roots).includes(`1. ${first}`))
})

test("the same physical proof still accepts an ordinary tight source list", () => {
  const f = fixture()
  f.source = f.source.replace(`${first}\n\n3.`, `${first}\n3.`)
  assert.equal(matches(f), true)
})

test("a source-only trailing LF cannot invent or borrow a positive physical start", () => {
  const changes = [
    [
      "missing projection",
      (f) => {
        delete f.roots[2].numbered_list
      },
    ],
    [
      "missing first start",
      (f) => {
        f.roots[2].numbered_list.start = null
      },
    ],
    [
      "default-one first start",
      (f) => {
        f.roots[2].numbered_list.start = 1
      },
    ],
    [
      "different first start",
      (f) => {
        f.roots[2].numbered_list.start = 3
      },
    ],
    [
      "unexpected successor start",
      (f) => {
        f.roots[3].numbered_list.start = 7
      },
    ],
    [
      "missing second item",
      (f) => {
        f.roots.splice(3, 1)
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = fixture()
    mutate(f)
    assert.equal(matches(f), false, label)
  }
})

test("complete physical item scope and order remain necessary", () => {
  const changes = [
    [
      "first item has descendants",
      (f) => {
        f.roots[2].has_children = true
      },
    ],
    [
      "second item has descendants",
      (f) => {
        f.roots[3].has_children = true
      },
    ],
    [
      "reversed items",
      (f) => {
        ;[f.roots[2], f.roots[3]] = [f.roots[3], f.roots[2]]
      },
    ],
    [
      "group moved across code boundary",
      (f) => {
        f.roots = [f.roots[0], f.roots[2], f.roots[3], f.roots[1], ...f.roots.slice(4)]
      },
    ],
    [
      "duplicate identity",
      (f) => {
        f.roots[3].id = f.roots[2].id
      },
    ],
    [
      "unexpected adjacent list item",
      (f) => {
        f.roots.splice(4, 0, { ...structuredClone(f.roots[3]), id: "extra-step" })
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = fixture()
    mutate(f)
    assert.equal(matches(f), false, label)
  }
})

test("the full physical rich text and complete authored body still bind the comparison", () => {
  const changes = [
    [
      "physical prose change",
      (f) => {
        f.roots[2].rich_text[1].text = " Continue without the draft."
      },
    ],
    [
      "physical code space change",
      (f) => {
        f.roots[3].rich_text[1].text = "verify exact"
      },
    ],
    [
      "physical link query change",
      (f) => {
        f.roots[3].rich_text[3].link = "https://example.com/guide?q=2#details"
      },
    ],
    [
      "live list prose change",
      (f) => {
        f.actual = f.actual.replace("Show the draft", "Hide the draft")
      },
    ],
    [
      "live explicit URL change",
      (f) => {
        f.actual = f.actual.replace("q=1#details", "q=2#details")
      },
    ],
    [
      "body change beyond the list",
      (f) => {
        f.actual = f.actual.replace("Tail stays exact.", "Changed tail.")
      },
    ],
    [
      "extra live paragraph",
      (f) => {
        f.actual += "\nUnrequested instructions.\n"
      },
    ],
  ]
  for (const [label, mutate] of changes) {
    const f = fixture()
    mutate(f)
    assert.equal(matches(f), false, label)
  }
})

test("an internal source line break is not the loose-leaf terminal LF case", () => {
  const f = fixture()
  f.source = f.source.replace(
    "**Ask the user before filing.** Show",
    "**Ask the user before filing.**\n   Show",
  )
  assert.equal(matches(f), false)
})

test("a source item with a second paragraph cannot use a flat leaf proof", () => {
  const f = fixture()
  f.source = f.source.replace(`${first}\n\n3.`, `${first}\n\n   Another paragraph.\n\n3.`)
  assert.equal(matches(f), false)
})

test("a newly linked literal still differs from its original unlinked source", () => {
  const f = fixture()
  f.source = f.source.replace("Tail stays exact.", "Keep file:line literal.")
  f.actual = f.actual.replace("Tail stays exact.", "Keep [file:line](file:line) literal.")
  f.roots[5] = {
    id: "tail",
    type: "paragraph",
    has_children: false,
    rich_text: [span("Keep "), span("file:line", { link: "file://line" }), span(" literal.")],
  }
  assert.equal(matches(f), false)
})
