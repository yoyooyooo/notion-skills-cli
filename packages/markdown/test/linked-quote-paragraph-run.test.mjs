import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { fromNotionMarkdown, markdownStructure } from "../src/index.ts"

const rich = (text, { link = null, code = false, bold = false } = {}) => ({
  type: "text",
  text: { content: text, link: link === null ? null : { url: link } },
  plain_text: text,
  href: link,
  annotations: {
    bold,
    code,
    italic: false,
    strikethrough: false,
    underline: false,
    color: "default",
  },
})
const node = (id, type, rich_text) => ({
  id,
  type,
  has_children: false,
  archived: false,
  in_trash: false,
  parent: { type: "page_id", page_id: "page" },
  [type]: { rich_text, color: "default" },
})
function fixture() {
  return {
    source: [
      "# Start",
      "",
      "> Read the [`guide`](https://example.test/guide#setup).",
      "",
      "Keep the `first` instruction.",
      "",
      "Read the [next step](https://example.test/next).",
      "",
      "## End",
      "",
    ].join("\n"),
    actual: [
      "# Start",
      "> Read the [`guide`](https://example.test/guide#setup).",
      "Keep the `first` instruction.",
      "Read the [next step](https://example.test/next).",
      "## End",
    ].join("\n"),
    blocks: [
      node("start", "heading_1", [rich("Start")]),
      node("quote", "quote", [
        rich("Read the "),
        rich("guide", { code: true, link: "https://example.test/guide#setup" }),
        rich("."),
      ]),
      node("first", "paragraph", [
        rich("Keep the "),
        rich("first", { code: true }),
        rich(" instruction."),
      ]),
      node("second", "paragraph", [
        rich("Read the "),
        rich("next step", { link: "https://example.test/next" }),
        rich("."),
      ]),
      node("end", "heading_2", [rich("End")]),
    ],
  }
}
const projection = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, projection(f))

test("a complete linked quote and two separate siblings retain all original inline content", () => {
  const f = fixture(),
    before = structuredClone(f)
  assert.equal(samePublishedMarkdown(f.actual, f.source), false)
  assert.equal(matches(f), true)
  const converted = fromNotionMarkdown(f.actual, projection(f))
  assert.equal(converted, f.actual.replace(".\nKeep", ".\n\nKeep"))
  assert.deepEqual(markdownStructure(converted), markdownStructure(f.source))
  assert.deepEqual(f, before)
})

test("the existing single sibling and trailing flat bullet boundary remain supported", () => {
  const f = fixture()
  f.actual = f.actual.replace("Read the [next step](https://example.test/next).\n", "")
  f.source = f.source.replace("Read the [next step](https://example.test/next).\n\n", "")
  f.blocks.splice(3, 1)
  assert.equal(matches(f), true)
  f.actual = f.actual.replace("## End", "- End")
  f.source = f.source.replace("## End", "- End")
  f.blocks[3] = node("end", "bulleted_list_item", [rich("End")])
  assert.equal(matches(f), true)
})

test("missing, extra, reordered and nested physical siblings cannot supply a boundary", () => {
  for (const alter of [
    (f) => {
      f.blocks.splice(3, 1)
    },
    (f) => {
      f.blocks.splice(4, 0, node("extra", "paragraph", [rich("An extra sibling.")]))
    },
    (f) => {
      ;[f.blocks[2], f.blocks[3]] = [f.blocks[3], f.blocks[2]]
    },
    (f) => {
      f.blocks[1].has_children = true
    },
    (f) => {
      f.blocks[2].has_children = true
    },
    (f) => {
      f.blocks[3].parent = { type: "block_id", block_id: "quote" }
    },
    (f) => {
      f.blocks[3].id = "first"
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("every readback line must match one whole physical sibling in the same order", () => {
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace("Keep the", "Change the")
    },
    (f) => {
      f.actual = f.actual.replace("Read the [next", "Change the [next")
    },
    (f) => {
      f.actual = f.actual.replace("## End", "An extra paragraph.\n## End")
    },
    (f) => {
      f.actual = f.actual.replace(
        "Keep the `first` instruction.\nRead the [next step](https://example.test/next).",
        "Read the [next step](https://example.test/next).\nKeep the `first` instruction.",
      )
    },
    (f) => {
      f.actual = f.actual.replace("\nRead the [next", "\n\tRead the [next")
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("physical code, destinations and either unique outer anchor remain mandatory", () => {
  for (const alter of [
    (f) => {
      f.blocks[2].paragraph.rich_text[1].annotations.code = false
    },
    (f) => {
      f.blocks[2].paragraph.rich_text[0] = rich("Change the ")
    },
    (f) => {
      f.blocks[3].paragraph.rich_text[1] = rich("next step", { link: "https://example.test/other" })
    },
    (f) => {
      f.blocks[1].quote.rich_text[1] = rich("guide", {
        code: true,
        link: "https://example.test/guide#other",
      })
    },
    (f) => {
      f.blocks[0].heading_1.rich_text = [rich("Other start")]
    },
    (f) => {
      f.blocks[4].heading_2.rich_text = [rich("Other end")]
    },
    (f) => {
      f.blocks.unshift(node("duplicate-anchor", "heading_1", [rich("Start")]))
      f.actual = "# Start\n" + f.actual
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("matching physical and readback edits still fail the complete unchanged source proof", () => {
  const f = fixture()
  f.actual = f.actual.replace("Keep the", "Change the")
  f.blocks[2].paragraph.rich_text[0] = rich("Change the ")
  assert.equal(matches(f), false)
  const g = fixture()
  g.source = g.source.replace("https://example.test/next", "https://example.test/changed")
  assert.equal(matches(g), false)
})
