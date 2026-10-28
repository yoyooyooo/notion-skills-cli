import test from "node:test"
import assert from "node:assert/strict"
import { fromNotionMarkdown, markdownStructure, sameMarkdownStructure } from "../src/index.ts"
import { richQuoteBoundaries } from "../src/sibling-boundaries.ts"

const span = (text, link = null, code = false) => ({ text, link, code, bold: false })
const leaf = (id, type, rich_text) => ({ id, type, has_children: false, rich_text })
function fixture(bullet = false) {
  return {
    source:
      "# Action\n\n> Read [shared](../shared/SKILL.md).\n\nKeep selection.id separate.\n\n" +
      (bullet ? "- `raw`: exact.\n" : "## Next\n"),
    actual:
      "# Action\n> Read [shared](../shared/SKILL.md).\nKeep [selection.id](http://selection.id) separate.\n" +
      (bullet ? "- `raw`: exact.\n" : "## Next\n"),
    roots: [
      leaf("before", "heading_1", [span("Action")]),
      leaf("quote", "quote", [span("Read "), span("shared", "../shared/SKILL.md"), span(".")]),
      leaf("paragraph", "paragraph", [
        span("Keep "),
        span("selection.id", "http://selection.id/"),
        span(" separate."),
      ]),
      bullet
        ? leaf("after", "bulleted_list_item", [span("raw", null, true), span(": exact.")])
        : leaf("after", "heading_2", [span("Next")]),
    ],
  }
}
const boundary = (f) => richQuoteBoundaries(f.actual, f.roots, markdownStructure)
const matches = (f) =>
  sameMarkdownStructure(
    markdownStructure(fromNotionMarkdown(f.actual, f.roots)),
    markdownStructure(f.source),
  )

for (const bullet of [false, true])
  test(`linked quote keeps its separate paragraph; flat bullet anchor=${bullet}`, () => {
    const f = fixture(bullet),
      before = JSON.stringify(f)
    assert.equal(boundary(f), f.actual.replace("\nKeep", "\n\nKeep"))
    assert.equal(matches(f), true)
    assert.equal(JSON.stringify(f), before)
  })

test("physical root URL serialization preserves scheme, host and every non-root component", () => {
  for (const url of [
    "https://selection.id/",
    "http://other.id/",
    "http://selection.id:80/",
    "http://selection.id/path",
    "http://selection.id/?q=1",
    "http://selection.id/#part",
    "http://user@selection.id/",
    "http://selection.id//",
  ]) {
    const f = fixture()
    f.roots[2].rich_text[1].link = url
    assert.equal(boundary(f), undefined, url)
  }
})

test("the physical alias never makes two explicit authored destinations equal", () => {
  for (const destination of [
    "https://selection.id",
    "http://selection.id/",
    "http://selection.id:80/",
    "http://selection.id/path",
    "http://selection.id?q=1",
  ]) {
    const f = fixture()
    f.source = f.source.replace("Keep selection.id", `Keep [selection.id](${destination})`)
    assert.equal(typeof boundary(f), "string")
    assert.equal(matches(f), false, destination)
  }
})

test("linked sibling framing requires both exact flat adjacent roots and unique identities", () => {
  const changes = [
    (f) => {
      f.roots[1].has_children = true
    },
    (f) => {
      f.roots[2].has_children = true
    },
    (f) => {
      f.roots[3].has_children = true
    },
    (f) => {
      f.roots[3].rich_text[0].text = "changed"
    },
    (f) => {
      f.roots[2].rich_text[2].text = " changed."
    },
    (f) => {
      f.roots[2].rich_text[1].code = true
    },
    (f) => {
      f.roots[0].id = f.roots[1].id
    },
    (f) => {
      f.roots.splice(2, 0, leaf("extra", "paragraph", [span("Invisible extra root")]))
    },
    (f) => {
      f.roots.splice(0, 1)
    },
    (f) => {
      ;[f.roots[1], f.roots[2]] = [f.roots[2], f.roots[1]]
    },
  ]
  for (const mutate of changes) {
    const f = fixture(true)
    mutate(f)
    assert.equal(boundary(f), undefined)
  }
})

test("a changed source paragraph or explicit shared link cannot borrow the valid boundary", () => {
  for (const change of [
    (f) => {
      f.source = f.source.replace("separate", "changed")
    },
    (f) => {
      f.source = f.source.replace("../shared/SKILL.md", "../foreign/SKILL.md")
    },
  ]) {
    const f = fixture(true)
    change(f)
    assert.equal(typeof boundary(f), "string")
    assert.equal(matches(f), false)
  }
})
