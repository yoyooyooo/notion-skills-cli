import assert from "node:assert/strict"
import test from "node:test"
import {
  projectNotionBlockTree,
  samePublishedMarkdown,
  notionMarkdownForComparison,
} from "../../core/src/markdown.ts"

const rich = (text, { link = null, ...style } = {}) => ({
  type: "text",
  text: { content: text, link: link === null ? null : { url: link } },
  plain_text: text,
  href: link,
  annotations: {
    bold: false,
    code: false,
    italic: false,
    strikethrough: false,
    underline: false,
    color: "default",
    ...style,
  },
})
const block = (id, type, spans, owner = "page", children = false, extra = {}) => ({
  object: "block",
  id,
  type,
  has_children: children,
  archived: false,
  in_trash: false,
  parent:
    owner === "page" ? { type: "page_id", page_id: owner } : { type: "block_id", block_id: owner },
  [type]: { rich_text: spans, color: "default", ...extra },
})
const plain = (id, type, text) => block(id, type, [rich(text)])
const code = '# keep exact bytes\nprintf "%s\\n" literal'
const url = "../other/reference.md#section"
function fixture() {
  const source = [
    "# Workflow",
    "",
    "- Keep **both** prerequisites.",
    "- Retain `owner`.",
    "",
    "> Run this `command`.",
    ">",
    "> ```bash",
    ...code.split("\n").map((line) => `> ${line}`),
    "> ```",
    ">",
    `> Read [all details](${url}).`,
    "",
    "> Keep the result.",
    "> - Read `first`.",
    "> - Read **second**.",
    "",
    "2. Continue with the result.",
    "",
    "```bash",
    "next-step",
    "```",
    "",
    "## Finish",
    "",
  ].join("\n")
  const actual = [
    "# Workflow",
    "- Keep **both** prerequisites.",
    "- Retain `owner`.",
    "> Run this `command`.",
    "\t```bash",
    code,
    "\t```",
    `\tRead [all details](${url}).`,
    "> Keep the result.",
    "\t- Read `first`.",
    "\t- Read **second**.",
    "1. Continue with the result.",
    "```bash",
    "next-step",
    "```",
    "## Finish",
  ].join("\n")
  const blocks = [
    plain("title", "heading_1", "Workflow"),
    block("before-1", "bulleted_list_item", [
      rich("Keep "),
      rich("both", { bold: true }),
      rich(" prerequisites."),
    ]),
    block("before-2", "bulleted_list_item", [
      rich("Retain "),
      rich("owner", { code: true }),
      rich("."),
    ]),
    block(
      "quote-code",
      "quote",
      [rich("Run this "), rich("command", { code: true }), rich(".")],
      "page",
      true,
    ),
    block("code", "code", [rich(code)], "quote-code", false, { language: "bash", caption: [] }),
    block(
      "inside",
      "paragraph",
      [rich("Read "), rich("all details", { link: url }), rich(".")],
      "quote-code",
    ),
    block("quote-list", "quote", [rich("Keep the result.")], "page", true),
    block(
      "first",
      "bulleted_list_item",
      [rich("Read "), rich("first", { code: true }), rich(".")],
      "quote-list",
    ),
    block(
      "second",
      "bulleted_list_item",
      [rich("Read "), rich("second", { bold: true }), rich(".")],
      "quote-list",
    ),
    block("after", "numbered_list_item", [rich("Continue with the result.")], "page", false, {
      list_start_index: 2,
    }),
    block("after-code", "code", [rich("next-step")], "page", false, {
      language: "bash",
      caption: [],
    }),
    plain("finish", "heading_2", "Finish"),
  ]
  return { actual, source, blocks }
}
const matches = (f) => {
  const roots = projectNotionBlockTree("page", f.blocks)
  return roots !== undefined && samePublishedMarkdown(f.actual, f.source, undefined, roots)
}

test("complete flat-list anchors recover both quote subtrees and the retained numbered start", () => {
  const f = fixture(),
    before = JSON.stringify(f),
    roots = projectNotionBlockTree("page", f.blocks)
  assert.equal(matches(f), true)
  const candidate = notionMarkdownForComparison(f.actual, f.source, roots)
  assert.ok(candidate?.includes("\n\n2. Continue with the result."))
  assert.ok(candidate?.includes(`> ${code.split("\n")[0]}`))
  assert.equal(JSON.stringify(f), before)
})

test("the preceding bullet run is complete, correctly ordered and exactly styled", () => {
  for (const change of [
    (f) => {
      f.blocks.splice(1, 1)
    },
    (f) => {
      ;[f.blocks[1], f.blocks[2]] = [f.blocks[2], f.blocks[1]]
    },
    (f) => {
      f.blocks[1].bulleted_list_item.rich_text[1].annotations.bold = false
    },
    (f) => {
      f.actual = f.actual.replace("**both**", "both")
    },
    (f) => {
      f.source = f.source.replace("**both**", "both")
    },
    (f) => {
      f.blocks[2].has_children = true
    },
    (f) => {
      f.actual = f.actual.replace("- Retain `owner`.", "- Extra prerequisite.\n- Retain `owner`.")
    },
    (f) => {
      f.source = f.source.replace("- Retain `owner`.", "- Extra prerequisite.\n- Retain `owner`.")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("the following numbered root requires original source start and complete exact text", () => {
  for (const change of [
    (f) => {
      f.blocks[9].numbered_list_item.list_start_index = 3
    },
    (f) => {
      delete f.blocks[9].numbered_list_item.list_start_index
    },
    (f) => {
      f.blocks[9].has_children = true
    },
    (f) => {
      f.actual = f.actual.replace("1. Continue", "3. Continue")
    },
    (f) => {
      f.actual = f.actual.replace("1. Continue", "01. Continue")
    },
    (f) => {
      f.source = f.source.replace("2. Continue", "4. Continue")
    },
    (f) => {
      f.blocks[9].numbered_list_item.rich_text[0] = rich("Changed result.")
      f.actual = f.actual.replace("Continue with the result.", "Changed result.")
    },
    (f) => {
      f.actual = f.actual.replace(
        "1. Continue with the result.",
        "1. Continue with the result.\n2. Unobserved item.",
      )
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("nested code bytes, canonical language, links, owners and every child remain mandatory", () => {
  for (const change of [
    (f) => {
      f.blocks[4].code.rich_text[0] = rich(code + " changed")
      f.actual = f.actual.replace(code, code + " changed")
    },
    (f) => {
      f.blocks[4].code.language = "python"
      f.actual = f.actual.replace("\t```bash", "\t```python")
    },
    (f) => {
      f.blocks.splice(5, 1)
    },
    (f) => {
      ;[f.blocks[4], f.blocks[5]] = [f.blocks[5], f.blocks[4]]
    },
    (f) => {
      f.blocks[4].parent.block_id = "quote-list"
    },
    (f) => {
      f.blocks[7].id = f.blocks[5].id
    },
    (f) => {
      f.blocks[8].has_children = true
    },
    (f) => {
      f.blocks[5].paragraph.rich_text[1] = rich("all details", { link: url + "-other" })
      f.actual = f.actual.replace(url, url + "-other")
    },
    (f) => {
      f.actual = f.actual.replace("\t```\n\tRead", "\t```\n\tUnobserved child.\n\tRead")
    },
  ]) {
    const f = fixture()
    change(f)
    assert.equal(matches(f), false)
  }
})

test("a full-page change outside the recovered interval still fails", () => {
  const f = fixture()
  f.blocks.at(-1).heading_2.rich_text[0] = rich("Changed")
  f.actual = f.actual.replace("## Finish", "## Changed")
  assert.equal(matches(f), false)
})
