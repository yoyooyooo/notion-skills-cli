import assert from "node:assert/strict"
import { test } from "node:test"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
  sameNotionMarkdown,
  type NotionBlockBoundary,
} from "../src/index.ts"

const paragraph = (id: string, text: string): NotionBlockBoundary => ({
  id,
  type: "paragraph",
  has_children: false,
  text,
})
const sentinel = (id: string, type: string): NotionBlockBoundary => ({
  id,
  type,
  has_children: false,
})
const compare = (actual: string, target: string, blocks?: readonly NotionBlockBoundary[]) => {
  const candidate = notionMarkdownForComparison(actual, target, blocks)
  return (
    sameNotionMarkdown(actual, target) ||
    (candidate !== undefined && sameNotionMarkdown(candidate, target))
  )
}

const listTarget =
  "# Before\n\n- First item.\n- Last item.\n\n<!-- retained note -->\n## After\n\nText."
const listActual =
  "# Before\n- First item.\n- Last item.\n\\<!-- retained note --\\>\n## After\nText."
const listBlocks = [
  sentinel("before", "heading_1"),
  paragraph("first", "First item."),
  paragraph("last", "Last item."),
  paragraph("note", "<!-- retained note -->"),
  sentinel("after", "heading_2"),
  paragraph("tail", "Text."),
].map((block) =>
  block.id === "first" || block.id === "last" ? { ...block, type: "bulleted_list_item" } : block,
)

test("an independent comment after a list requires its exact ordered paragraph root", () => {
  assert.equal(sameNotionMarkdown(listActual, listTarget), false)
  assert.equal(compare(listActual, listTarget, listBlocks), true)
  const candidate = notionMarkdownForComparison(listActual, listTarget, listBlocks)!
  assert.equal(
    sameMarkdownStructure(markdownStructure(candidate), markdownStructure(listTarget)),
    true,
  )
  assert.equal(
    fromNotionMarkdown(listActual, listBlocks).includes("\\<!-- retained note --\\>"),
    true,
  )
  assert.equal(compare(listActual, listTarget), false)
})

test("list comment repair cannot alter a literal, an inline comment, a fence or surrounding content", () => {
  for (const [before, after] of [
    ["retained note", "different note"],
    ["First item.", "Different item."],
    ["## After", "### After"],
    ["Text.", "Changed."],
  ] as const)
    assert.equal(compare(listActual.replace(before, after), listTarget, listBlocks), false)
  const literal = listTarget.replace("<!-- retained note -->", "\\<!-- retained note --\\>")
  assert.equal(notionMarkdownForComparison(listActual, literal, listBlocks), undefined)
  assert.equal(compare(listActual, literal, listBlocks), true)
  assert.equal(compare(listTarget, literal, listBlocks), false)
  for (const actual of [
    listActual.replace("\n\\<!-- retained note --\\>", " \\<!-- retained note --\\>"),
    listActual.replace("\\<!-- retained note --\\>", "`\\<!-- retained note --\\>`"),
    listActual.replace("\\<!-- retained note --\\>", "```text\n\\<!-- retained note --\\>\n```"),
  ])
    assert.equal(compare(actual, listTarget, listBlocks), false)
})

test("list comment proof rejects missing, duplicated, moved, nested and unknown adjacent roots", () => {
  const variants: NotionBlockBoundary[][] = [
    listBlocks.filter((block) => block.id !== "note"),
    listBlocks.map((block) => (block.id === "note" ? { ...block, text: "<!-- wrong -->" } : block)),
    listBlocks.map((block) => (block.id === "note" ? { ...block, has_children: true } : block)),
    [...listBlocks.slice(0, 3), sentinel("unknown", "unsupported"), ...listBlocks.slice(3)],
    [...listBlocks.slice(0, 3), listBlocks[4]!, listBlocks[3]!, listBlocks[5]!],
    [...listBlocks, { ...listBlocks[3]!, id: "duplicate-note" }],
    [listBlocks[4]!, ...listBlocks.filter((block) => block.id !== "after")],
  ]
  for (const blocks of variants) assert.equal(compare(listActual, listTarget, blocks), false)
  assert.equal(
    compare(`${listActual}\n\n${listActual}`, `${listTarget}\n\n${listTarget}`, listBlocks),
    false,
  )
})

test("a comment repair never makes numbered lists with different starts equal", () => {
  const target = listTarget.replace("- First item.\n- Last item.", "1. First item.\n2. Last item.")
  const actual = listActual.replace("- First item.\n- Last item.", "1. First item.\n2. Last item.")
  const blocks = listBlocks.map((block) =>
    block.type === "bulleted_list_item" ? { ...block, type: "numbered_list_item" } : block,
  )
  assert.equal(compare(actual, target, blocks), true)
  assert.equal(compare(actual.replace("1. First item.", "0. First item."), target, blocks), false)
})

const endTarget = "# Before\n\nBefore `tool`.\n<!-- retained end -->\n"
const endActual = "# Before\nBefore `tool`.<br>\\<!-- retained end --\\>"
const endBlocks = [
  sentinel("heading", "heading_1"),
  paragraph("end", "Before tool.\n<!-- retained end -->"),
]

test("a terminal comment in the same Notion paragraph requires an exact recorded line break", () => {
  assert.equal(sameNotionMarkdown(endActual, endTarget), false)
  assert.equal(compare(endActual, endTarget, endBlocks), true)
  assert.equal(compare(endActual, endTarget.trimEnd(), endBlocks), true)
  const candidate = notionMarkdownForComparison(endActual, endTarget, endBlocks)!
  assert.equal(
    sameMarkdownStructure(markdownStructure(candidate), markdownStructure(endTarget)),
    true,
  )
  assert.equal(
    fromNotionMarkdown(endActual, endBlocks).includes("<br>\\<!-- retained end --\\>"),
    true,
  )
  assert.equal(compare(endActual, endTarget), false)
})

test("terminal proof preserves source literal syntax, inline code, words and the newline location", () => {
  for (const actual of [
    endActual.replace("retained end", "different end"),
    endActual.replace("`tool`", "`other`"),
    endActual.replace("Before `tool`", "After `tool`"),
    endActual.replace("<br>", " "),
    endActual.replace("<br>", "\\<br\\>"),
    endActual.replace(
      "Before `tool`.<br>\\<!-- retained end --\\>",
      "`Before tool.<br>\\<!-- retained end --\\>`",
    ),
    endActual.replace(
      "Before `tool`.<br>\\<!-- retained end --\\>",
      "```text\nBefore tool.<br>\\<!-- retained end --\\>\n```",
    ),
  ])
    assert.equal(compare(actual, endTarget, endBlocks), false)
  for (const target of [
    endTarget.replace("<!-- retained end -->", "`<!-- retained end -->`"),
    endTarget.replace("<!-- retained end -->", "\\<!-- retained end --\\>"),
    endTarget.replace(".\n<!--", ". <!--"),
    endTarget.replace(".\n<!--", ".\n\n<!--"),
  ])
    assert.equal(notionMarkdownForComparison(endActual, target, endBlocks), undefined)
})

test("terminal proof cannot borrow another root or an unrecorded line break", () => {
  const variants: NotionBlockBoundary[][] = [
    endBlocks.slice(0, 1),
    endBlocks.map((block) => (block.id === "end" ? { ...block, text: undefined } : block)),
    endBlocks.map((block) => (block.id === "end" ? { ...block, has_children: true } : block)),
    endBlocks.map((block) =>
      block.id === "end" ? { ...block, text: "Before tool. <!-- retained end -->" } : block,
    ),
    endBlocks.map((block) =>
      block.id === "end" ? { ...block, text: "Before tool.<br><!-- retained end -->" } : block,
    ),
    endBlocks.map((block) =>
      block.id === "end" ? { ...block, text: "Before tool.\n\n<!-- retained end -->" } : block,
    ),
    [endBlocks[1]!, endBlocks[0]!],
    [endBlocks[0]!, sentinel("unknown", "unsupported"), endBlocks[1]!],
    [...endBlocks, { ...endBlocks[1]!, id: "duplicate-end" }],
    [...endBlocks, sentinel("unknown-after", "unsupported")],
  ]
  for (const blocks of variants) assert.equal(compare(endActual, endTarget, blocks), false)
  const repeatedActual = `${endActual}\n\n${endActual}`
  const repeatedTarget = `${endTarget}\n\n${endTarget}`
  assert.equal(compare(repeatedActual, repeatedTarget, endBlocks), false)
})

test("terminal comparison keeps explicit external URLs at their original AST positions", () => {
  const actual = "# Before\nBefore [site](https://example.test/x).<br>\\<!-- retained end --\\>"
  const target = "# Before\n\nBefore [site](https://example.test/x).\n<!-- retained end -->\n"
  const blocks: NotionBlockBoundary[] = [
    endBlocks[0]!,
    {
      ...endBlocks[1]!,
      text: undefined,
      rich_text: [
        { text: "Before ", link: null, bold: false, code: false },
        { text: "site", link: "https://example.test/x", bold: false, code: false },
        { text: ".\n<!-- retained end -->", link: null, bold: false, code: false },
      ],
    },
  ]
  assert.equal(compare(actual, target, blocks), true)
  for (const changed of [
    actual.replace("https://example.test/x", "http://example.test/x"),
    actual.replace("https://example.test/x", "https://example.test/other"),
    actual.replace("[site]", "[other]"),
  ])
    assert.equal(compare(changed, target, blocks), false)
})

test("independent and terminal comments use their original positions in one complete document", () => {
  const actual = `${listActual}\n${endActual}`
  const target = `${listTarget}\n\n${endTarget}`
  const blocks = [...listBlocks, ...endBlocks]
  assert.equal(compare(actual, target, blocks), true)
  assert.equal(compare(actual.replace("retained end", "other end"), target, blocks), false)
  const wrong = [...listBlocks.slice(0, 3), ...endBlocks, ...listBlocks.slice(3)]
  assert.equal(compare(actual, target, wrong), false)
})

test("only literal text and punctuation escapes can reconstruct the exact authored comment", () => {
  const note = "retained_note: [one]"
  const escaped = "retained\\_note: \\[one\\]"
  const target = listTarget.replace("retained note", note)
  const actual = listActual.replace("retained note", escaped)
  const blocks = listBlocks.map((block) =>
    block.id === "note" ? { ...block, text: `<!-- ${note} -->` } : block,
  )
  assert.equal(compare(actual, target, blocks), true)
  for (const changed of [
    actual.replace("[one", "[other"),
    actual.replace("retained\\_note", "retained\\qnote"),
    actual.replace("retained\\_note", "`retained_note`"),
    actual.replace("retained\\_note", "**retained_note**"),
    actual.replace("retained\\_note", "<b>retained_note</b>"),
  ])
    assert.equal(compare(changed, target, blocks), false)
  assert.equal(compare(actual, target.replace("retained_note", "retained\\_note"), blocks), false)
  const terminalTarget = endTarget.replace("retained end", note)
  const terminalActual = endActual.replace("retained end", escaped)
  const terminalBlocks = endBlocks.map((block) =>
    block.id === "end" ? { ...block, text: `Before tool.\n<!-- ${note} -->` } : block,
  )
  assert.equal(compare(terminalActual, terminalTarget, terminalBlocks), true)
  assert.equal(
    compare(
      terminalActual.replace("retained\\_note", "`retained_note`"),
      terminalTarget,
      terminalBlocks,
    ),
    false,
  )
  const literal = terminalTarget.replace(`<!-- ${note} -->`, `\\<!-- ${escaped} --\\>`)
  assert.equal(notionMarkdownForComparison(terminalActual, literal, terminalBlocks), undefined)
})
