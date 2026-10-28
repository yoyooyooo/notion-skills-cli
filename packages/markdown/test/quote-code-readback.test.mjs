import assert from "node:assert/strict"
import test from "node:test"
import { projectNotionBlockTree, samePublishedMarkdown } from "../../core/src/markdown.ts"
import { notionMarkdownForComparison } from "../src/index.ts"

const rich = (content, annotations = {}) => ({
  type: "text",
  text: { content, link: null },
  plain_text: content,
  href: null,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...annotations,
  },
})
const block = (id, type, text, parent = "page", has_children = false, extra = {}) => ({
  id,
  type,
  has_children,
  archived: false,
  in_trash: false,
  parent: {
    type: parent === "page" ? "page_id" : "block_id",
    [parent === "page" ? "page_id" : "block_id"]: parent,
  },
  [type]: { rich_text: text === undefined ? [] : [rich(text)], ...extra },
})
const json = '{\n  "value": "keep  two spaces",\n  "literal": "\\\\n"\n}'
const payload = '{\n  "enabled": true\n}'
const shell = 'printf "%s\\n" "exact  bytes"\nprintf done'
const quoteCode = (language, text) => [
  `> \`\`\`${language}`,
  ...text.split("\n").map((line) => `> ${line}`),
  "> ```",
]
const actualCode = (language, text) => [`\t\`\`\`${language}`, ...text.split("\n"), "\t```"]

function fixture() {
  const source = [
    "# Instructions",
    "",
    "```bash",
    "tool status",
    "```",
    "",
    "> Keep the operation order.",
    ">",
    "> - Inspect the original source.",
    "> - Keep every result.",
    "",
    "> Use the exact JSON configuration.",
    ">",
    ...quoteCode("jsonc", json),
    "",
    "> Keep both payload and command.",
    ">",
    ...quoteCode("json", payload),
    ">",
    ...quoteCode("bash", shell),
    "",
    "## Next",
    "",
    "Read the [manual](https://example.test/manual#source).",
    "",
  ].join("\n")
  const actual = [
    "# Instructions",
    "```bash",
    "tool status",
    "```",
    "> Keep the operation order.",
    "\t- Inspect the original source.",
    "\t- Keep every result.",
    "> Use the exact JSON configuration.",
    ...actualCode("json", json),
    "> Keep both payload and command.",
    ...actualCode("json", payload),
    ...actualCode("bash", shell),
    "## Next",
    "Read the [manual](https://example.test/manual#source).",
  ].join("\n")
  const blocks = [
    block("title", "heading_1", "Instructions"),
    block("before", "code", "tool status", "page", false, { language: "shell", caption: [] }),
    block("quote-list", "quote", "Keep the operation order.", "page", true),
    block("list-one", "bulleted_list_item", "Inspect the original source.", "quote-list"),
    block("list-two", "bulleted_list_item", "Keep every result.", "quote-list"),
    block("quote-json", "quote", "Use the exact JSON configuration.", "page", true),
    block("json", "code", json, "quote-json", false, { language: "json", caption: [] }),
    block("quote-pair", "quote", "Keep both payload and command.", "page", true),
    block("payload", "code", payload, "quote-pair", false, { language: "json", caption: [] }),
    block("shell", "code", shell, "quote-pair", false, { language: "shell", caption: [] }),
    block("after", "heading_2", "Next"),
    block("tail", "paragraph", "Read the manual."),
  ]
  blocks.at(-1).paragraph.rich_text = [
    rich("Read the "),
    {
      ...rich("manual"),
      text: { content: "manual", link: { url: "https://example.test/manual#source" } },
      href: "https://example.test/manual#source",
    },
    rich("."),
  ]
  return { source, actual, blocks }
}
const projected = (f) => projectNotionBlockTree("page", f.blocks)
const matches = (f) => samePublishedMarkdown(f.actual, f.source, undefined, projected(f))
const changeText = (f, id, text) => {
  const node = f.blocks.find((block) => block.id === id)
  node[node.type].rich_text[0].text.content = text
  node[node.type].rich_text[0].plain_text = text
}

test("complete quote children preserve exact code bytes, languages, order and preceding code anchor", () => {
  const f = fixture(),
    before = JSON.stringify(f),
    roots = projected(f)
  assert.deepEqual(
    roots
      .filter((root) => root.quote_descendants)
      .map((root) => root.quote_descendants.map((node) => node.type)),
    [["bulleted_list_item", "bulleted_list_item"], ["code"], ["code", "code"]],
  )
  assert.deepEqual(
    roots.flatMap((root) =>
      (root.quote_descendants ?? []).filter((node) => node.code).map((node) => node.code.text),
    ),
    [json, payload, shell],
  )
  assert.equal(matches(f), true)
  assert.equal(typeof notionMarkdownForComparison(f.actual, f.source, roots), "string")
  assert.equal(JSON.stringify(f), before)
  assert.equal(
    samePublishedMarkdown(f.actual, f.source),
    false,
    "the malformed export needs complete physical evidence",
  )
})

test("code bytes and language must agree independently with the original source and the raw export", () => {
  for (const alter of [
    (f) => {
      changeText(f, "json", json.replace("two spaces", "other value"))
    },
    (f) => {
      changeText(f, "shell", `${shell} `)
    },
    (f) => {
      f.blocks.find((node) => node.id === "payload").code.language = "python"
    },
    (f) => {
      f.actual = f.actual.replace('"enabled": true', '"enabled": false')
    },
    (f) => {
      f.actual = f.actual.replace("\t```json", "\t```python")
    },
    (f) => {
      f.source = f.source.replace("keep  two spaces", "keep one space")
    },
    (f) => {
      f.source = f.source.replace("> ```jsonc", "> ```python")
    },
    (f) => {
      f.actual = f.actual.replace("keep  two spaces", "current changed")
      changeText(f, "json", json.replace("keep  two spaces", "current changed"))
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("the quote inventory rejects missing, extra, duplicated, reordered or foreign code children", () => {
  for (const alter of [
    (f) => {
      f.blocks.splice(8, 1)
    },
    (f) => {
      f.blocks.splice(
        9,
        0,
        block("extra", "code", "extra", "quote-pair", false, { language: "shell" }),
      )
    },
    (f) => {
      ;[f.blocks[8], f.blocks[9]] = [f.blocks[9], f.blocks[8]]
    },
    (f) => {
      f.blocks[9].id = "payload"
    },
    (f) => {
      f.blocks[8].parent.block_id = "quote-json"
    },
    (f) => {
      f.blocks[8].parent = { type: "page_id", page_id: "page" }
    },
    (f) => {
      f.blocks[8].has_children = true
    },
    (f) => {
      f.blocks[7].has_children = false
    },
    (f) => {
      f.blocks[8].type = "paragraph"
      f.blocks[8].paragraph = f.blocks[8].code
    },
    (f) => {
      f.blocks.splice(8, 0, block("nested", "quote", "nested", "quote-pair", true))
      f.blocks[9].parent.block_id = "nested"
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("archived, decorated, linked, captioned or contradictory code is not a complete supported projection", () => {
  for (const alter of [
    (node) => {
      node.archived = true
    },
    (node) => {
      node.in_trash = true
    },
    (node) => {
      node.code.caption = [rich("A caption")]
    },
    (node) => {
      node.code.rich_text[0].plain_text += " changed"
    },
    (node) => {
      node.code.rich_text[0].type = "equation"
    },
    (node) => {
      node.code.rich_text[0].href = "https://example.test"
    },
    (node) => {
      node.code.rich_text[0].text.link = { url: "https://example.test" }
    },
    ...["bold", "italic", "strikethrough", "underline", "code"].map((key) => (node) => {
      node.code.rich_text[0].annotations[key] = true
    }),
    (node) => {
      node.code.rich_text[0].annotations.color = "red"
    },
    (node) => {
      delete node.code.rich_text[0].annotations.italic
    },
  ]) {
    const f = fixture()
    alter(f.blocks[8])
    assert.equal(
      projected(f)?.find((root) => root.id === "quote-pair")?.quote_descendants,
      undefined,
    )
    assert.equal(matches(f), false)
  }
})

test("code container boundaries cannot discard extra readback text, change fences or consume another root", () => {
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace("\t```json", "  ```json")
    },
    (f) => {
      f.actual = f.actual.replace("\t```\n> Keep both", "\t```\nExtra instruction.\n> Keep both")
    },
    (f) => {
      f.actual = f.actual.replace("\t```\n> Keep both", "\t~~~\n> Keep both")
    },
    (f) => {
      f.actual = f.actual.replace("\t```\n## Next", "\t```\n\tExtra instruction.\n## Next")
    },
    (f) => {
      f.actual = f.actual.replace("## Next", "## Different")
    },
    (f) => {
      f.blocks.splice(10, 1)
    },
    (f) => {
      f.actual = f.actual.replace("tool status", "tool reset")
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})

test("the whole source AST and original external destinations still govern a decoded quote", () => {
  for (const alter of [
    (f) => {
      f.actual = f.actual.replace(
        "https://example.test/manual#source",
        "https://example.test/manual#changed",
      )
    },
    (f) => {
      f.source = f.source.replace(
        "https://example.test/manual#source",
        "https://example.test/another#source",
      )
    },
    (f) => {
      f.actual = f.actual.replace("Read the [manual]", "Discard the [manual]")
    },
    (f) => {
      f.source = f.source.replace("> - Keep every result.", "> - Keep a different result.")
    },
  ]) {
    const f = fixture()
    alter(f)
    assert.equal(matches(f), false)
  }
})
