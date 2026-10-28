import assert from "node:assert/strict"
import { test } from "node:test"
import { fromNotionMarkdown, notionMarkdownForComparison } from "../../markdown/src/index.ts"
import { projectNotionBlocks, samePublishedMarkdown } from "../src/markdown.ts"

const span = (text, bold = false, code = false, link = null) => ({ text, bold, code, link })
const root = (id, text, type = "paragraph", rich_text = [span(text)]) => ({
  id,
  type,
  text,
  rich_text,
  has_children: false,
})
const matches = ({ actual, target, roots }) =>
  samePublishedMarkdown(actual, target, undefined, roots)
const clone = (value) => structuredClone(value)
const reject = (fixture, mutations) => {
  for (const mutate of mutations) {
    const input = clone(fixture)
    mutate(input)
    assert.equal(matches(input), false)
  }
}

const taskFixture = () => ({
  target:
    "Before\n\n<ticket-notes>\n\n- [ ] Check one.\n- [x] Check two.\n\n</ticket-notes>\n\nAfter",
  actual:
    "Before\n\\<ticket-notes\\>\n- [ ] Check one.\n- [x] Check two.\n\\</ticket-notes\\>\nAfter",
  roots: [
    root("before", "Before"),
    root("open", "<ticket-notes>"),
    root("one", "Check one.", "to_do"),
    root("two", "Check two.", "to_do"),
    root("close", "</ticket-notes>"),
    root("after", "After"),
  ],
})
test("task items occupy their original physical positions without changing checkbox comparison", () => {
  const fixture = taskFixture(),
    before = JSON.stringify(fixture)
  assert.equal(matches(fixture), true)
  assert.equal(JSON.stringify(fixture), before)
  reject(fixture, [
    (f) => {
      f.actual = f.actual.replace("[ ]", "[x]")
    },
    (f) => {
      f.target = f.target.replace("[x]", "[ ]")
    },
    (f) => {
      f.roots[2].type = "bulleted_list_item"
    },
    (f) => {
      f.roots.splice(2, 1)
    },
    (f) => {
      ;[f.roots[2], f.roots[3]] = [f.roots[3], f.roots[2]]
      f.actual = f.actual.replace("Check one.", "Changed one.")
    },
  ])
})

const emptyQuoteFixture = () => ({
  target: "Before\n\n>\n\n</template-box>\n\nAfter",
  actual: "Before\n>\n\\</template-box\\>\nAfter",
  roots: [
    root("before", "Before"),
    root("empty", "", "quote", []),
    root("close", "</template-box>"),
    root("after", "After"),
  ],
})
test("only an explicit empty leaf quote can prove an adjacent literal root", () => {
  const fixture = emptyQuoteFixture()
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      delete f.roots[1].rich_text
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[1].text = " "
    },
    (f) => {
      f.roots[1].rich_text = [span("hidden")]
    },
    (f) => {
      f.actual = f.actual.replace("\n>\n", "\n>>\n")
    },
    (f) => {
      f.actual = f.actual.replace("\n>\n", "\n>\n>\n")
    },
  ])
  const duplicate = clone(fixture)
  duplicate.actual = duplicate.actual.replace("\n>\n", "\n>\n\n>\n")
  duplicate.target = duplicate.target.replace("\n>\n", "\n>\n\n>\n")
  duplicate.roots.splice(2, 0, root("empty-two", "", "quote", []))
  assert.equal(matches(duplicate), false)
})

test("raw projection records an empty quote only from an explicit empty rich-text array", () => {
  const block = { id: "empty", type: "quote", has_children: false, quote: { rich_text: [] } }
  assert.deepEqual(projectNotionBlocks([block])[0], {
    id: "empty",
    type: "quote",
    has_children: false,
    text: "",
    rich_text: [],
  })
  for (const change of [
    (value) => {
      delete value.quote.rich_text
    },
    (value) => {
      value.quote.rich_text = null
    },
    (value) => {
      value.has_children = true
    },
    (value) => {
      value.type = "paragraph"
      value.paragraph = value.quote
      delete value.quote
    },
  ]) {
    const value = clone(block)
    change(value)
    assert.equal(projectNotionBlocks([value])[0].rich_text, undefined)
  }
})

const headingFixture = () => ({
  target: "Before\n\n# <id>: <ticket name>\n\nAfter",
  actual: "Before\n# \\<id\\>: \\<ticket name\\>\nAfter",
  roots: [
    root("before", "Before"),
    root("heading", "<id>: <ticket name>", "heading_1"),
    root("after", "After"),
  ],
})
test("heading placeholders require complete original literal text, depth and neighbors", () => {
  const fixture = headingFixture()
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      delete f.roots[1].rich_text
    },
    (f) => {
      f.roots[1].rich_text[0].code = true
    },
    (f) => {
      f.roots[1].rich_text[0].bold = true
    },
    (f) => {
      f.roots[1].rich_text[0].link = "https://example.test"
    },
    (f) => {
      f.roots[1].text += "!"
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[1].type = "heading_2"
    },
    (f) => {
      f.actual = f.actual.replace("ticket name", "changed name")
    },
    (f) => {
      f.target = f.target.replace("<id>", '<id mode="x">')
    },
    (f) => {
      f.roots.splice(0, 1)
    },
  ])
})

const paragraphFixture = () => ({
  target:
    "# Fields\n\n**Why:** Keep original explanation.\n\n**From:** <start date>, **To:** <end date>, **What:** <work item>\n\n## Next",
  actual:
    "# Fields\n**Why:** Keep original explanation.\n**From:** \\<start date\\>, **To:** \\<end date\\>, **What:** \\<work item\\>\n## Next",
  roots: [
    root("heading", "Fields", "heading_1"),
    root("why", "Why: Keep original explanation.", "paragraph", [
      span("Why:", true),
      span(" Keep original explanation."),
    ]),
    root("fields", "From: <start date>, To: <end date>, What: <work item>", "paragraph", [
      span("From:", true),
      span(" <start date>, "),
      span("To:", true),
      span(" <end date>, "),
      span("What:", true),
      span(" <work item>"),
    ]),
    root("next", "Next", "heading_2"),
  ],
})
test("a full original paragraph with several placeholders preserves every bold span and literal", () => {
  const fixture = paragraphFixture()
  assert.equal(matches(fixture), true)
  assert.equal(
    fromNotionMarkdown(fixture.actual, fixture.roots),
    fromNotionMarkdown(fixture.actual),
  )
  reject(fixture, [
    (f) => {
      f.roots[2].rich_text[0].bold = false
    },
    (f) => {
      f.roots[2].rich_text[1].code = true
    },
    (f) => {
      f.roots[2].rich_text[3].link = "https://example.test"
    },
    (f) => {
      f.actual = f.actual.replace("end date", "wrong date")
    },
    (f) => {
      f.target = f.target.replace("work item", "new item")
    },
    (f) => {
      f.roots.splice(1, 1)
    },
    (f) => {
      f.actual = f.actual.replace("\n**From:", "\nUnobserved.\n**From:")
    },
  ])
})

const htmlHeadingFixture = () => ({
  target: "Before\n\n<template-box>\n### Write the next question\n\nAfter",
  actual: "Before\n\\<template-box\\>\n### Write the next question\nAfter",
  roots: [
    root("before", "Before"),
    root("open", "<template-box>"),
    root("heading", "Write the next question", "heading_3"),
    root("after", "After"),
  ],
})
test("a two-line opaque source block is reconstructed only from its exact paragraph and heading", () => {
  const fixture = htmlHeadingFixture()
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      f.roots[2].type = "heading_2"
    },
    (f) => {
      f.roots[2].has_children = true
    },
    (f) => {
      f.roots[2].rich_text[0].code = true
    },
    (f) => {
      f.roots.splice(2, 1)
    },
    (f) => {
      f.actual = f.actual.replace("next question", "wrong question")
    },
    (f) => {
      f.target = f.target.replace("<template-box>", "<template-box mode='x'>")
    },
    (f) => {
      f.actual = f.actual.replace("\n###", "\nUnobserved.\n###")
    },
  ])
})

const htmlListFixture = () => ({
  target: "Before\n\n<extra-notes>\n1. Add one item.\n</extra-notes>\n\nAfter",
  actual: "Before\n\\<extra-notes\\>\n1. Add one item.\n\t\\</extra-notes\\>\nAfter",
  roots: [
    root("before", "Before"),
    root("open", "<extra-notes>"),
    {
      ...root("item", "Add one item.\n</extra-notes>", "numbered_list_item"),
      numbered_list: { start: null },
    },
    root("after", "After"),
  ],
})
test("a three-line wrapper proves its closing literal inside the actual numbered leaf", () => {
  const fixture = htmlListFixture()
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      f.roots[2].numbered_list.start = 2
    },
    (f) => {
      delete f.roots[2].numbered_list
    },
    (f) => {
      f.roots[2].text = f.roots[2].text.replace("\n", " ")
      f.roots[2].rich_text[0].text = f.roots[2].text
    },
    (f) => {
      f.roots[2].rich_text[0].bold = true
    },
    (f) => {
      f.roots[2].rich_text[0].code = true
    },
    (f) => {
      f.roots.splice(3, 0, root("invented-close", "</extra-notes>"))
    },
    (f) => {
      f.actual = f.actual.replace("Add one item.", "Add wrong item.")
    },
    (f) => {
      f.target = f.target.replace("</extra-notes>", "</different-notes>")
    },
  ])
})

const numberedFixture = () => ({
  target: "## Steps\n\nOne paragraph.\n\n3. Keep `x  y` exact.\n\nAfter",
  actual: "## Steps\nOne paragraph.\n3. Keep `x  y` exact.\nAfter",
  roots: [
    root("heading", "Steps", "heading_2"),
    root("paragraph", "One paragraph."),
    {
      ...root("numbered", "Keep x  y exact.", "numbered_list_item", [
        span("Keep "),
        span("x  y", false, true),
        span(" exact."),
      ]),
      numbered_list: { start: 3 },
    },
    root("after", "After"),
  ],
})
test("a retained positive start proves one missing paragraph-to-list boundary with code bytes intact", () => {
  const fixture = numberedFixture()
  assert.equal(matches(fixture), true)
  const candidate = notionMarkdownForComparison(fixture.actual, fixture.target, fixture.roots)
  assert.equal(
    candidate.replaceAll("\n", ""),
    fromNotionMarkdown(fixture.actual, fixture.roots).replaceAll("\n", ""),
  )
  reject(fixture, [
    (f) => {
      delete f.roots[2].numbered_list
    },
    ...[null, 0, 1, 2, 4].map((start) => (f) => {
      f.roots[2].numbered_list.start = start
    }),
    (f) => {
      f.actual = f.actual.replace("x  y", "x y")
    },
    (f) => {
      f.roots[2].rich_text[1].code = false
    },
    (f) => {
      f.target = f.target.replace("3. Keep", "4. Keep")
    },
    (f) => {
      f.roots.splice(1, 1)
    },
  ])
})

test("new literal proofs leave all unrelated whole-page content and link changes visible", () => {
  for (const make of [
    taskFixture,
    emptyQuoteFixture,
    headingFixture,
    paragraphFixture,
    htmlHeadingFixture,
    htmlListFixture,
    numberedFixture,
  ]) {
    const fixture = make(),
      suffix = "\n\n[Original](https://example.test/a?q=1#keep)"
    fixture.target += suffix
    fixture.actual += suffix
    fixture.roots.push(
      root("link", "Original", "paragraph", [
        span("Original", false, false, "https://example.test/a?q=1#keep"),
      ]),
    )
    assert.equal(matches(fixture), true)
    fixture.actual = fixture.actual.replace("q=1", "q=2")
    assert.equal(matches(fixture), false)
  }
})
