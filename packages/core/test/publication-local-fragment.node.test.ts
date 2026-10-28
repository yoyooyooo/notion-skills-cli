import assert from "node:assert/strict"
import { test } from "vitest"
import type { NotionBlockBoundary } from "../src/markdown.ts"
import { samePublishedMarkdown } from "../src/markdown.ts"
import { pageLocalUnicodeFragmentTarget } from "../src/publication-local-fragment.ts"

const text = (value: string, link: string | null = null, bold = false) => ({
  text: value,
  link,
  bold,
  code: false,
})
function fixture() {
  const name = "在正文中插入内嵌图片",
    destination = `#${name}`,
    encoded = `#${encodeURIComponent(name)}`
  const source = `## ${name}\n\n[${name}](${destination})\n\n[External](https://example.test/a?q=1#keep)\n`
  const blocks: NotionBlockBoundary[] = [
    { id: "heading", type: "heading_2", has_children: false, text: name, rich_text: [text(name)] },
    {
      id: "link",
      type: "paragraph",
      has_children: false,
      text: name,
      rich_text: [text(name, encoded)],
    },
    {
      id: "external",
      type: "paragraph",
      has_children: false,
      text: "External",
      rich_text: [text("External", "https://example.test/a?q=1#keep")],
    },
  ]
  return { name, destination, encoded, source, blocks }
}

test("one source-local Unicode fragment changes only the proved destination spelling", () => {
  const f = fixture(),
    before = JSON.stringify(f.blocks)
  const view = pageLocalUnicodeFragmentTarget(f.source, f.blocks)
  assert.equal(view, f.source.replace(f.destination, f.encoded))
  assert.equal(pageLocalUnicodeFragmentTarget(view, f.blocks), view)
  assert.equal(JSON.stringify(f.blocks), before)
  assert.ok(view.includes("https://example.test/a?q=1#keep"))
  assert.equal(
    samePublishedMarkdown(view.replace("?q=1#keep", "?q=2#keep"), view, undefined, f.blocks),
    false,
  )
})

test("a paragraph and table cell keep both ordered labels and their distinct bold flags", () => {
  const name = "渲染 & 写入画板",
    fragment = "#渲染--写入画板",
    encoded = "#" + encodeURIComponent(fragment.slice(1))
  const label = `§ ${name}`
  const source = `**[${label}](${fragment})**\n\n| Route |\n| --- |\n| [${label}](${fragment}) |\n\n## ${name}\n`
  const blocks: NotionBlockBoundary[] = [
    {
      id: "link",
      type: "paragraph",
      has_children: false,
      text: label,
      rich_text: [text(label, encoded, true)],
    },
    {
      id: "table",
      type: "table",
      has_children: true,
      table_evidence: {
        width: 1,
        header_row: true,
        header_column: false,
        rows: [
          {
            id: "header",
            type: "table_row",
            has_children: false,
            parent_id: "table",
            table_row: { cells: [[text("Route")]] },
          },
          {
            id: "row",
            type: "table_row",
            has_children: false,
            parent_id: "table",
            table_row: { cells: [[text(label, encoded)]] },
          },
        ],
      },
    },
    { id: "heading", type: "heading_2", has_children: false, text: name, rich_text: [text(name)] },
  ]
  assert.equal(pageLocalUnicodeFragmentTarget(source, blocks), source.replaceAll(fragment, encoded))
  assert.equal(
    pageLocalUnicodeFragmentTarget(source, [
      blocks[0]!,
      { ...blocks[1]!, table_evidence: undefined },
      blocks[2]!,
    ]),
    source,
  )
  assert.equal(
    pageLocalUnicodeFragmentTarget(source, [
      { ...blocks[0]!, rich_text: [text(label, encoded)] },
      ...blocks.slice(1),
    ]),
    source,
  )
})

test("missing, duplicate, styled, wrong-level or altered physical headings cannot authorize a view", () => {
  const f = fixture()
  for (const blocks of [
    f.blocks.slice(1),
    [f.blocks[0]!, { ...f.blocks[0]!, id: "second" }, ...f.blocks.slice(1)],
    [{ ...f.blocks[0]!, rich_text: [text(f.name, null, true)] }, ...f.blocks.slice(1)],
    [{ ...f.blocks[0]!, type: "heading_3" }, ...f.blocks.slice(1)],
    [
      { ...f.blocks[0]!, text: f.name + "改", rich_text: [text(f.name + "改")] },
      ...f.blocks.slice(1),
    ],
  ])
    assert.equal(pageLocalUnicodeFragmentTarget(f.source, blocks), f.source)
  for (const extra of [`\n## ${f.name}\n`, `\n### **${f.name}**\n`])
    assert.equal(pageLocalUnicodeFragmentTarget(f.source + extra, f.blocks), f.source + extra)
})

test("literal percent, reserved components and other slug transformations stay strict", () => {
  const f = fixture()
  for (const destination of [
    f.encoded,
    "#" + encodeURIComponent(f.encoded.slice(1)),
    "#在正文%20中",
    "#在正文?x=1",
    "#在正文/中",
    "#在正文#中",
    "#在正文:中",
    "#在正文@中",
    "#在正文\\中",
    "#在正文 中",
    "https://example.test/#" + f.name,
  ]) {
    const source = f.source.replace(f.destination, destination)
    assert.equal(pageLocalUnicodeFragmentTarget(source, f.blocks), source)
  }
  const source = f.source.replaceAll(f.name, "在 正文")
  assert.equal(pageLocalUnicodeFragmentTarget(source, f.blocks), source)
})

test("a changed physical destination, label, count, style or duplicate identity is refused", () => {
  const f = fixture()
  for (const replacement of [
    text(f.name, f.encoded.toLowerCase()),
    text(f.name, f.encoded + "?x=1"),
    text(f.name, "https://example.test/" + f.encoded),
    text(f.name, f.destination),
    text(f.name + "改", f.encoded),
    text(f.name, f.encoded, true),
    { ...text(f.name, f.encoded), code: true },
  ])
    assert.equal(
      pageLocalUnicodeFragmentTarget(f.source, [
        f.blocks[0]!,
        { ...f.blocks[1]!, text: replacement.text, rich_text: [replacement] },
        f.blocks[2]!,
      ]),
      f.source,
    )
  assert.equal(
    pageLocalUnicodeFragmentTarget(f.source, [
      f.blocks[0]!,
      f.blocks[1]!,
      { ...f.blocks[1]!, id: "duplicate-link" },
      f.blocks[2]!,
    ]),
    f.source,
  )
  assert.equal(
    pageLocalUnicodeFragmentTarget(f.source, [...f.blocks, { ...f.blocks[2]!, id: "heading" }]),
    f.source,
  )
})

test("code examples, a second candidate fragment and unproved link labels cannot borrow authority", () => {
  const f = fixture()
  const example = `\n\`[${f.name}](${f.destination})\`\n\n\`\`\`md\n[${f.name}](${f.destination})\n\`\`\`\n`
  const view = pageLocalUnicodeFragmentTarget(f.source + example, f.blocks)
  assert.equal(view, f.source.replace(f.destination, f.encoded) + example)
  const other = f.source + "\n[第二个](#第二个)\n\n## 第二个\n"
  assert.equal(pageLocalUnicodeFragmentTarget(other, f.blocks), other)
  const label = f.source.replace(`[${f.name}]`, "[Other]")
  assert.equal(pageLocalUnicodeFragmentTarget(label, f.blocks), label)
})

test("the existing quote-child decoder works after the local view without changing any physical input", () => {
  const f = fixture(),
    source = `\`\`\`json\n{}\n\`\`\`\n\n> [${f.name}](${f.destination})\n>\n> \`add_inline\` is retained.\n\n\`replace_inline\`\n\n## ${f.name}\n`
  const actual = `\`\`\`json\n{}\n\`\`\`\n> [${f.name}](${f.encoded})\n\t\`add_inline\` is retained.\n\`replace_inline\`\n## ${f.name}\n`
  const blocks: NotionBlockBoundary[] = [
    { id: "code", type: "code", has_children: false, code: { language: "json", text: "{}" } },
    {
      id: "quote",
      type: "quote",
      has_children: true,
      text: f.name,
      rich_text: [text(f.name, f.encoded)],
      quote_descendants: [
        {
          id: "child",
          parent_id: "quote",
          type: "paragraph",
          has_children: false,
          rich_text: [{ ...text("add_inline"), code: true }, text(" is retained.")],
        },
      ],
    },
    {
      id: "paragraph",
      type: "paragraph",
      has_children: false,
      rich_text: [{ ...text("replace_inline"), code: true }],
    },
    f.blocks[0]!,
  ]
  const before = JSON.stringify(blocks)
  assert.equal(samePublishedMarkdown(actual, source, undefined, blocks), false)
  assert.equal(
    samePublishedMarkdown(
      actual,
      pageLocalUnicodeFragmentTarget(source, blocks),
      undefined,
      blocks,
    ),
    true,
  )
  assert.equal(JSON.stringify(blocks), before)
  assert.equal(
    samePublishedMarkdown(
      actual.replace("is retained.", "was edited."),
      pageLocalUnicodeFragmentTarget(source, blocks),
      undefined,
      blocks,
    ),
    false,
  )
})
