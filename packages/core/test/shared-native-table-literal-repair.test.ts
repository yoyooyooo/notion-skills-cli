import { expect, test } from "bun:test"
import {
  deriveTableLiteralRepair,
  bindTableLiteralRows,
  tableLiteralProgress,
  assertTableLiteralProgress,
} from "../src/shared-native-table-literal-repair.ts"
import { assertImportedMarkdownContent } from "../src/shared-import-markdown.ts"

const source =
  "# Guide\n\n| # | Question |\n| --- | --- |\n| 1 | **Audience + venue** - Who? |\n| 2 | **Length** - 15 min: ~10 slides |\n\nKeep `a - b` and [reference](https://example.test/exact).\n"
const observed = source
  .replace("**Audience + venue** -", "<b>Audience + venue</b>  •")
  .replace("**Length** -", "<b>Length</b>  •")
const annotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const span = (content: string) => ({
  type: "text" as const,
  text: { content, link: null },
  annotations,
})
const rows = [
  {
    row_id: "row-1",
    table_id: "table",
    cells: [[span("1")], [span("Audience + venue"), span("  • Who?")]],
  },
  {
    row_id: "row-2",
    table_id: "table",
    cells: [[span("2")], [span("Length"), span("  • 15 min: ~10 slides")]],
  },
]

test("a full-source table proposal preserves original code, links and physical identities", () => {
  expect(() => assertImportedMarkdownContent(source, observed)).toThrow()
  const proposal = deriveTableLiteralRepair(source, observed)
  expect(proposal.rows.map((row) => [row.table_index, row.row_index])).toEqual([
    [0, 1],
    [0, 2],
  ])
  expect(() => assertImportedMarkdownContent(source, proposal.markdown)).not.toThrow()
  const after = bindTableLiteralRows(proposal, rows)
  expect(after[0]?.row_id).toBe(rows[0]!.row_id)
  expect(after[0]?.cells[1]?.[1]?.text.content).toBe("  - Who?")
  expect(after[1]?.cells[1]?.[1]?.annotations).toEqual(annotations)
  expect(observed).toContain("Keep `a - b`")
  expect(proposal.markdown).toContain("Keep `a - b` and [reference](https://example.test/exact).")
})

test("partial progress uses only explicit acknowledged row positions", () => {
  const proposal = deriveTableLiteralRepair(source, observed)
  expect(tableLiteralProgress(proposal, new Set())).toBe(observed)
  const partial = tableLiteralProgress(proposal, new Set([0]))
  expect(partial).toContain("<b>Audience + venue</b>  - Who?")
  expect(partial).toContain("<b>Length</b>  •")
  expect(() => assertTableLiteralProgress(proposal, new Set([0]), partial)).not.toThrow()
  expect(() => assertTableLiteralProgress(proposal, new Set(), partial)).toThrow()
  expect(() => tableLiteralProgress(proposal, new Set([2]))).toThrow()
  expect(() =>
    assertTableLiteralProgress(proposal, new Set([0]), partial.replace("Who?", "When?")),
  ).toThrow()
  expect(() =>
    assertTableLiteralProgress(proposal, new Set([0]), partial.replace("# Guide", "# Edited")),
  ).toThrow()
})

test("authored bullets, other text drift, code, linked rows and incomplete physical rows refuse", () => {
  for (const body of [
    observed.replace("Who?", "What?"),
    observed.replace("`a - b`", "`a + b`"),
    observed.replace("/exact", "/other"),
  ])
    expect(() => deriveTableLiteralRepair(source, body)).toThrow()
  expect(() =>
    deriveTableLiteralRepair(source.replace("**Length** -", "**Length** •"), observed),
  ).toThrow()
  const proposal = deriveTableLiteralRepair(source, observed)
  expect(() => bindTableLiteralRows(proposal, rows.slice(1))).toThrow()
  expect(() => bindTableLiteralRows(proposal, [rows[0]!, rows[0]!])).toThrow()
  const changed = structuredClone(rows)
  changed[0]!.cells[1]![1]!.annotations.code = true
  expect(() => bindTableLiteralRows(proposal, changed)).toThrow()
  const different = structuredClone(rows)
  different[1]!.cells[1]![0]!.text.content = "Different label"
  expect(() => bindTableLiteralRows(proposal, different)).toThrow()
})

test("escaped restored hyphens are restricted to acknowledged changed rows", () => {
  const proposal = deriveTableLiteralRepair(source, observed)
  const after = tableLiteralProgress(proposal, new Set([0, 1]))
  expect(after).toBe(proposal.markdown)
  expect(() =>
    assertTableLiteralProgress(proposal, new Set([0, 1]), after.replace("  - Who?", "  \\- Who?")),
  ).not.toThrow()
  expect(() =>
    assertTableLiteralProgress(proposal, new Set([0, 1]), after.replace("a - b", "a \\- b")),
  ).toThrow()
})
