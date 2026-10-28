import test from "node:test"
import assert from "node:assert/strict"
import { Lexer } from "marked"
import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
} from "../src/index.ts"

const targetRows = [
  ["Key", "Example"],
  ['<item name="sample">', "plain"],
  ["word", "prefix <value key> suffix"],
  ['<entry mode="all">', "prefix <literal> suffix"],
]
const actualRows = [
  ["Key", "Example"],
  ['\\<item name="sample"\\>', "plain"],
  ["word", "prefix \\<value key\\> suffix"],
  ['\\<entry mode="all"\\>', "prefix \\<literal\\> suffix"],
]
const sourceTable = (rows) =>
  rows
    .map(
      (row, index) =>
        `| ${row.join(" | ")} |\n${index === 0 ? `| ${row.map(() => "---").join(" | ")} |\n` : ""}`,
    )
    .join("")
const savedTable = (rows) =>
  `<table header-row="true">\n${rows.map((row) => `<tr>\n${row.map((cell) => `<td>${cell}</td>\n`).join("")}</tr>\n`).join("")}</table>\n`
const document = (table) => `Before.\n\n${table}\nAfter.\n`
const actual = document(savedTable(actualRows)),
  target = document(sourceTable(targetRows))
const blocks = [
  { id: "before", type: "paragraph", has_children: false, text: "Before." },
  { id: "table", type: "table", has_children: true },
  { id: "after", type: "paragraph", has_children: false, text: "After." },
]
const candidate = (body = actual, source = target, evidence = blocks) =>
  notionMarkdownForComparison(body, source, evidence)
const whole = (body, source = target) =>
  sameMarkdownStructure(markdownStructure(body), markdownStructure(source))

test("a unique complete table restores only the exact source HTML token delimiters", () => {
  assert.equal(whole(actual), false)
  assert.equal(whole(fromNotionMarkdown(actual, blocks)), false)
  const repaired = candidate()
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired), true)
  assert.equal(actual.length - repaired.length, 8)
  assert.equal(repaired, actual.replaceAll("\\<", "<").replaceAll("\\>", ">"))
})
test("ordinary read and legacy comparison without root evidence do not perform this repair", () => {
  assert.equal(notionMarkdownForComparison(actual, target, undefined), undefined)
  assert.equal(candidate(actual, target, []), undefined)
  assert.equal(fromNotionMarkdown(actual, blocks), actual)
})
test("an authored escaped tag remains escaped rather than becoming source HTML", () => {
  const escapedSource = document(sourceTable(actualRows))
  assert.equal(notionMarkdownForComparison(actual, escapedSource, blocks), undefined)
  assert.equal(whole(actual, escapedSource), true)
})
test("current literal text, attribute values, whitespace and every neighboring cell are bound", () => {
  for (const changed of [
    actual.replace("sample", "other"),
    actual.replace("plain", "edited"),
    actual.replace("prefix ", "prefix  "),
    actual.replace("suffix", "changed"),
  ])
    assert.equal(candidate(changed), undefined)
  assert.equal(candidate(actual, target.replace("sample", "other")), undefined)
})
test("exact external destinations embedded in literal attributes cannot be substituted", () => {
  const wanted = document(
    sourceTable([
      ["Key", "Example"],
      ['<item src="https://example.invalid/a?x=1#h">', "plain"],
    ]),
  )
  const saved = document(
    savedTable([
      ["Key", "Example"],
      ['\\<item src="https://example.invalid/a?x=1#h"\\>', "plain"],
    ]),
  )
  const repaired = candidate(saved, wanted)
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired, wanted), true)
  assert.equal(candidate(saved.replace("a?x=1", "a?x=2"), wanted), undefined)
})
test("closing source tags retain all bytes and only their outer escapes are removed", () => {
  const wanted = document(
    sourceTable([
      ["Key", "Example"],
      ["<item>inside</item>", "plain"],
    ]),
  )
  const saved = document(
    savedTable([
      ["Key", "Example"],
      ["\\<item\\>inside\\</item\\>", "plain"],
    ]),
  )
  const repaired = candidate(saved, wanted)
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired, wanted), true)
})
test("partial escaping, entity encoding, or additional table wrapper attributes are refused", () => {
  assert.equal(
    candidate(actual.replace('\\<item name="sample"\\>', '\\<item name="sample">')),
    undefined,
  )
  assert.equal(
    candidate(actual.replace('\\<item name="sample"\\>', '&lt;item name="sample"&gt;')),
    undefined,
  )
  assert.equal(
    candidate(
      actual.replace('<table header-row="true">', '<table header-row="true" extra="value">'),
    ),
    undefined,
  )
})
test("missing rows, extra cells, and reordered values cannot use the table root count alone", () => {
  assert.equal(candidate(document(savedTable(actualRows.slice(0, -1)))), undefined)
  assert.equal(
    candidate(
      document(savedTable(actualRows.map((row, index) => (index === 2 ? [...row, "extra"] : row)))),
    ),
    undefined,
  )
  const reordered = [actualRows[0], actualRows[2], actualRows[1], actualRows[3]]
  assert.equal(candidate(document(savedTable(reordered))), undefined)
})
test("a table must be one active structural root with unique identity and ordered neighbors", () => {
  assert.equal(
    candidate(
      actual,
      target,
      blocks.map((block) => (block.type === "table" ? { ...block, has_children: false } : block)),
    ),
    undefined,
  )
  assert.equal(
    candidate(actual, target, [blocks[0], { ...blocks[1], id: blocks[0].id }, blocks[2]]),
    undefined,
  )
  assert.equal(candidate(actual, target, [blocks[2], blocks[1], blocks[0]]), undefined)
  assert.equal(
    candidate(actual, target, [
      { id: "unknown", type: "toggle", has_children: true },
      blocks[1],
      blocks[2],
    ]),
    undefined,
  )
})
test("duplicate complete source or readback table matches remain ambiguous", () => {
  const duplicatedSource = document(sourceTable(targetRows) + "\n" + sourceTable(targetRows))
  assert.equal(candidate(actual, duplicatedSource), undefined)
  const duplicatedActual = document(savedTable(actualRows) + "\n" + savedTable(actualRows))
  const duplicatedBlocks = [blocks[0], blocks[1], { ...blocks[1], id: "second-table" }, blocks[2]]
  assert.equal(candidate(duplicatedActual, target, duplicatedBlocks), undefined)
})
test("table syntax inside code has no table readback authority", () => {
  const body = document("```html\n" + savedTable(actualRows) + "```\n")
  assert.equal(candidate(body), undefined)
})
test("breaks, declarations, nested table tags and formatted source cells are outside the literal-only rule", () => {
  for (const literal of ["<br>", "<!-- comment -->", "<td>", "</table>", "**<literal>**"]) {
    const wanted = document(
      sourceTable([
        ["Key", "Example"],
        [literal, "plain"],
      ]),
    )
    const saved = document(
      savedTable([
        ["Key", "Example"],
        [literal.replaceAll("<", "\\<").replaceAll(">", "\\>"), "plain"],
      ]),
    )
    assert.equal(candidate(saved, wanted), undefined)
  }
})
test("the caller still rejects complete-body edits outside the proven table", () => {
  const body = actual.replace("After.", "Changed after."),
    evidence = blocks.map((block) =>
      block.id === "after" ? { ...block, text: "Changed after." } : block,
    )
  const repaired = candidate(body, target, evidence)
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired), false)
})
test("source tokens, root evidence and all raw bytes outside the exact escapes are unchanged", () => {
  const evidence = structuredClone(blocks),
    before = JSON.stringify(evidence)
  const repaired = candidate(actual, target, evidence)
  assert.equal(JSON.stringify(evidence), before)
  assert.equal(
    repaired
      .replaceAll('<item name="sample">', '\\<item name="sample"\\>')
      .replaceAll("<value key>", "\\<value key\\>")
      .replaceAll('<entry mode="all">', '\\<entry mode="all"\\>')
      .replaceAll("<literal>", "\\<literal\\>"),
    actual,
  )
})

test("a mixed grid binds ordinary angle text while repairing only four source HTML tokens", () => {
  const rows = [
    ["Key", "Meaning", "Example"],
    ['<item name="sample">', "<choose the user, not markup>", "<state why, when>"],
    ["<plain choice, keep it>", "<text & explanation>", "<outer example: <value key>>"],
    ["<all reasons, no markup>", '<entry mode="all">', "<literal>"],
  ]
  const table = sourceTable(rows),
    source = document(table)
  const tokens = Lexer.lex(table)[0]
  assert.equal(tokens.type, "table")
  assert.equal(
    tokens.rows
      .flat()
      .flatMap((cell) => cell.tokens)
      .filter((token) => token.type === "html").length,
    4,
  )
  const escaped = rows.map((row) =>
    row.map((cell) => cell.replaceAll("<", "\\<").replaceAll(">", "\\>")),
  )
  const saved = document(savedTable(escaped)),
    repaired = candidate(saved, source)
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired, source), true)
  assert.equal(saved.length - repaired.length, 8)
  assert.ok(repaired.includes("\\<choose the user, not markup\\>"))
  assert.ok(repaired.includes("\\<outer example: <value key>\\>"))
  assert.equal(
    repaired
      .replaceAll('<item name="sample">', '\\<item name="sample"\\>')
      .replaceAll("<value key>", "\\<value key\\>")
      .replaceAll('<entry mode="all">', '\\<entry mode="all"\\>')
      .replaceAll("<literal>", "\\<literal\\>"),
    saved,
  )
  assert.equal(candidate(saved.replace("the user,", "the editor,"), source), undefined)
  assert.equal(
    candidate(saved.replace("\\<state why, when\\>", "<state why, when>"), source),
    undefined,
  )
})

test("authored escaped angle text alongside source HTML remains entirely escaped", () => {
  const source = document(
    sourceTable([
      ["Key", "Example"],
      ["<item>", "\\<literal\\>"],
    ]),
  )
  const saved = document(
    savedTable([
      ["Key", "Example"],
      ["\\<item\\>", "\\<literal\\>"],
    ]),
  )
  const repaired = candidate(saved, source)
  assert.equal(typeof repaired, "string")
  assert.equal(whole(repaired, source), true)
  assert.equal(repaired, saved.replace("\\<item\\>", "<item>"))
})
