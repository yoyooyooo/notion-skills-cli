import assert from "node:assert/strict"
import { test } from "node:test"
import { notionMarkdownForComparison } from "../../markdown/src/index.ts"
import { samePublishedMarkdown } from "../src/markdown.ts"

const span = (text, bold = false, code = false, link = null) => ({ text, bold, code, link })
const root = (id, text, type = "paragraph", rich_text = [span(text)]) => ({
  id,
  type,
  text,
  rich_text,
  has_children: false,
})
const matches = (value) => samePublishedMarkdown(value.actual, value.target, undefined, value.roots)
const reject = (fixture, changes) => {
  for (const change of changes) {
    const input = structuredClone(fixture)
    change(input)
    assert.equal(matches(input), false)
  }
}
const numberedFixture = () => ({
  target: "## Steps\n\nOne paragraph.\n\n3. Keep `x  y` exact.\n\nAfter",
  actual: "## Steps\nOne paragraph.\n1. Keep `x  y` exact.\nAfter",
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
test("restoring a retained start keeps the already observed paragraph/list boundary", () => {
  const fixture = numberedFixture(),
    before = JSON.stringify(fixture)
  assert.equal(matches(fixture), true)
  assert.equal(
    notionMarkdownForComparison(fixture.actual, fixture.target, fixture.roots),
    "## Steps\nOne paragraph.\n\n3. Keep `x  y` exact.\n\nAfter",
  )
  assert.equal(JSON.stringify(fixture), before)
  reject(fixture, [
    (f) => {
      delete f.roots[2].numbered_list
    },
    ...[null, 0, 1, 2, 4].map((start) => (f) => {
      f.roots[2].numbered_list.start = start
    }),
    (f) => {
      f.roots[2].rich_text[1].code = false
    },
    (f) => {
      f.actual = f.actual.replace("x  y", "x y")
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[1].text = "Other paragraph."
      f.roots[1].rich_text[0].text = "Other paragraph."
    },
    (f) => {
      f.actual = f.actual.replace("One paragraph.", "Changed paragraph.")
    },
    (f) => {
      f.actual = f.actual.replace("\n1. Keep", "\nUnobserved instruction.\n1. Keep")
    },
    (f) => {
      f.target = f.target.replace("3. Keep", "4. Keep")
    },
    (f) => {
      f.roots.splice(1, 1)
    },
  ])
})

const quoteFixture = () => ({
  target: "Before\n\n>\n</template-box>\n\n## After",
  actual: "Before\n>\n\\</template-box\\>\n## After",
  roots: [
    root("before", "Before"),
    root("empty", "", "quote", []),
    root("close", "</template-box>"),
    root("after", "After", "heading_2"),
  ],
})
test("a directly adjacent closing source tag requires the exact empty quote", () => {
  const fixture = quoteFixture(),
    before = JSON.stringify(fixture)
  assert.equal(matches(fixture), true)
  assert.equal(matches({ ...fixture, target: fixture.target.replace(">\n</", "> \n</") }), true)
  assert.equal(JSON.stringify(fixture), before)
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
      f.target = f.target.replace("\n>\n", "\n>>\n")
    },
    (f) => {
      f.target = f.target.replace("\n>\n", "\n>\n>\n")
    },
    (f) => {
      f.actual = f.actual.replace("\n>\n", "\n>>\n")
    },
    (f) => {
      f.actual = f.actual.replace("\n>\n", "\n>\n\n>\n")
      f.roots.splice(2, 0, root("second-empty", "", "quote", []))
    },
    (f) => {
      f.target = f.target.replace("</template-box>", "<template-box>")
    },
    (f) => {
      f.actual = f.actual.replace("template-box", "changed-box")
    },
    (f) => {
      f.roots[2].rich_text[0].code = true
    },
    (f) => {
      f.roots.splice(1, 1)
    },
  ])
})

const listFixture = () => ({
  target: "## Fields\n\n1. Describe <goal> and <owner>.\n\n## Next",
  actual: "## Fields\n1. Describe \\<goal\\> and \\<owner\\>.\n## Next",
  roots: [
    root("fields", "Fields", "heading_2"),
    {
      ...root("item", "Describe <goal> and <owner>.", "numbered_list_item"),
      numbered_list: { start: null },
    },
    root("next", "Next", "heading_2"),
  ],
})
test("single-word list placeholders are proved as one complete original literal line", () => {
  const fixture = listFixture(),
    before = JSON.stringify(fixture)
  assert.equal(matches(fixture), true)
  assert.equal(JSON.stringify(fixture), before)
  reject(fixture, [
    (f) => {
      delete f.roots[1].rich_text
    },
    (f) => {
      f.roots[1].rich_text[0].bold = true
    },
    (f) => {
      f.roots[1].rich_text[0].code = true
    },
    (f) => {
      f.roots[1].rich_text[0].link = "https://example.test"
    },
    (f) => {
      f.roots[1].numbered_list.start = 3
    },
    (f) => {
      delete f.roots[1].numbered_list
    },
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[1].type = "to_do"
    },
    (f) => {
      f.actual = f.actual.replace("owner", "changed")
    },
    (f) => {
      f.target = f.target.replace("<goal>", '<goal id="one">')
    },
    (f) => {
      f.target = f.target.replace("<goal>", "`<goal>`")
    },
    (f) => {
      f.target = f.target.replace("<goal>", "**<goal>**")
    },
    (f) => {
      f.actual = f.actual.replace("\n## Next", "\n2. Unobserved.\n## Next")
    },
    (f) => {
      f.roots.splice(0, 1)
    },
    (f) => {
      f.roots.splice(2, 0, { ...structuredClone(f.roots[1]), id: "duplicate" })
    },
  ])
})

const combinedFixture = () => ({
  target:
    "## Steps\n\nKeep the original context.\n\n3. Preserve `a  b` exactly.\n\n## Fields\n\n1. Write <goal> and <owner>.\n\n<extra-notes>\n1. Preserve one extra item.\n</extra-notes>\n\n## Quotation\n\n>\n</template-box>\n\n## End",
  actual:
    "## Steps\nKeep the original context.\n1. Preserve `a  b` exactly.\n## Fields\n1. Write \\<goal\\> and \\<owner\\>.\n\\<extra-notes\\>\n1. Preserve one extra item.\n\t\\</extra-notes\\>\n## Quotation\n>\n\\</template-box\\>\n## End",
  roots: [
    root("steps", "Steps", "heading_2"),
    root("context", "Keep the original context."),
    {
      ...root("retained-three", "Preserve a  b exactly.", "numbered_list_item", [
        span("Preserve "),
        span("a  b", false, true),
        span(" exactly."),
      ]),
      numbered_list: { start: 3 },
    },
    root("fields", "Fields", "heading_2"),
    {
      ...root("placeholder-item", "Write <goal> and <owner>.", "numbered_list_item"),
      numbered_list: { start: null },
    },
    root("open", "<extra-notes>"),
    {
      ...root("wrapper-item", "Preserve one extra item.\n</extra-notes>", "numbered_list_item"),
      numbered_list: { start: null },
    },
    root("quote-heading", "Quotation", "heading_2"),
    root("empty", "", "quote", []),
    root("close", "</template-box>"),
    root("end", "End", "heading_2"),
  ],
})
test("the three finite boundaries compose without weakening whole-page structure", () => {
  const fixture = combinedFixture()
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      f.roots[2].numbered_list.start = null
    },
    (f) => {
      f.roots[6].text = f.roots[6].text.replace("\n", " ")
    },
    (f) => {
      f.target = f.target.replace("Preserve one extra item.", "Different instruction.")
    },
    (f) => {
      f.roots[8].has_children = true
    },
    (f) => {
      f.roots.splice(5, 1)
    },
    (f) => {
      ;[f.roots[5], f.roots[6]] = [f.roots[6], f.roots[5]]
    },
  ])
})

test("one exact br token can represent the retained LF inside the proved wrapper leaf", () => {
  const fixture = combinedFixture()
  fixture.actual = fixture.actual.replace(
    "Preserve one extra item.\n\t",
    "Preserve one extra item.<br>",
  )
  assert.equal(matches(fixture), true)
  reject(fixture, [
    (f) => {
      f.actual = f.actual.replace("<br>", "<br/>")
    },
    (f) => {
      f.actual = f.actual.replace("<br>", "<BR>")
    },
    (f) => {
      f.actual = f.actual.replace("<br>", "<br class='x'>")
    },
    (f) => {
      f.actual = f.actual.replace("<br>", "<br><br>")
    },
    (f) => {
      f.actual = f.actual.replace("<br>", " ")
    },
    (f) => {
      f.roots[6].text = f.roots[6].text.replace("\n", " ")
      f.roots[6].rich_text[0].text = f.roots[6].text
    },
    (f) => {
      f.roots[6].rich_text[0].code = true
    },
    (f) => {
      f.roots[6].numbered_list.start = 2
    },
    (f) => {
      f.actual = f.actual.replace("extra item.", "changed item.")
    },
    (f) => {
      f.roots.splice(7, 0, root("unobserved-closing", "</extra-notes>"))
    },
  ])
})

test("all new positive shapes retain full source and external destination checks", () => {
  for (const make of [numberedFixture, quoteFixture, listFixture, combinedFixture]) {
    const fixture = make(),
      suffix = "\n\n[Original](https://example.test/path?q=1#keep)"
    fixture.actual += suffix
    fixture.target += suffix
    fixture.roots.push(
      root("external-link", "Original", "paragraph", [
        span("Original", false, false, "https://example.test/path?q=1#keep"),
      ]),
    )
    assert.equal(matches(fixture), true)
    fixture.actual = fixture.actual.replace("q=1", "q=2")
    assert.equal(matches(fixture), false)
  }
})
