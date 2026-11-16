import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token, Tokens } from "marked"
import { fail } from "./model.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"
import type { RepairTableRow } from "./shared-native-table-code-repair.ts"

const unsupported = () =>
  fail(
    "SOURCE_FILE_REPAIR_UNSUPPORTED",
    "The complete source, table text and physical rows do not prove an exact literal repair.",
  )

/** This is a proposal only. The ordinary import equivalence is never relaxed. */
function restoreTableText(raw: string, supplied?: readonly Token[]): string {
  const parts = splitNativeInlineCode(raw)
  if (parts?.some((part) => part.code))
    return parts.map((part) => (part.code ? part.raw : restoreTableText(part.raw))).join("")
  const tokens = supplied ?? SourceLexer.lexInline(raw)
  if (tokens.map((token) => token.raw).join("") !== raw) throw unsupported()
  return tokens
    .map((token) => {
      if (token.type === "strong" || token.type === "em" || token.type === "del") {
        const at = token.raw.indexOf(token.text)
        if (at < 0) throw unsupported()
        return (
          token.raw.slice(0, at) +
          restoreTableText(token.text, token.tokens) +
          token.raw.slice(at + token.text.length)
        )
      }
      return token.type === "text" ? token.raw.replaceAll("•", "-") : token.raw
    })
    .join("")
}

/** Changed rows deliberately exclude code, links and non-presentation HTML.
 * Other rows and all non-table content retain their original bytes. */
function plainCell(raw: string, parsed?: readonly Token[]): string {
  let result = ""
  for (const token of parsed ?? SourceLexer.lexInline(raw)) {
    if (token.type === "strong" || token.type === "em" || token.type === "del")
      result += plainCell(token.text, token.tokens)
    else if (token.type === "text" || token.type === "escape") result += token.text
    else if (token.type !== "html" || !/^<\/?(?:b|strong|i|em|s|del)\s*>$/iu.test(token.raw))
      throw unsupported()
  }
  return result.replace(/\s+/gu, "")
}

export function deriveTableLiteralRepair(expected: string, before: string) {
  const tokens = SourceLexer.lex(before)
  if (tokens.map((token) => token.raw).join("") !== before) throw unsupported()
  const rows: {
    table_index: number
    row_index: number
    line_index: number
    before_line: string
    after_line: string
    before_cells: string[]
    after_cells: string[]
  }[] = []
  let tableIndex = 0
  let lineIndex = 0
  const markdown = tokens
    .map((token) => {
      const start = lineIndex
      lineIndex += token.raw.split("\n").length - 1
      if (token.type !== "table") return token.raw
      const index = tableIndex++
      const candidate = token.raw
        .split("\n")
        .map((line, at) => (at === 1 ? line : restoreTableText(line)))
        .join("\n")
      const after = SourceLexer.lex(candidate).find((part) => part.type === "table")
      if (!after || after.type !== "table" || after.rows.length !== token.rows.length)
        throw unsupported()
      const previous = [token.header, ...token.rows]
      const next = [after.header, ...after.rows]
      const beforeLines = token.raw.split("\n")
      const afterLines = candidate.split("\n")
      for (let at = 0; at < previous.length; at++) {
        const rowLine = at === 0 ? 0 : at + 1
        if (beforeLines[rowLine] === afterLines[rowLine]) continue
        const old = previous[at]!
        const changed = next[at]!
        if (old.length !== changed.length) throw unsupported()
        rows.push({
          table_index: index,
          row_index: at,
          line_index: start + rowLine,
          before_line: beforeLines[rowLine]!,
          after_line: afterLines[rowLine]!,
          before_cells: old.map((cell: Tokens.TableCell) => plainCell(cell.text, cell.tokens)),
          after_cells: changed.map((cell: Tokens.TableCell) => plainCell(cell.text, cell.tokens)),
        })
      }
      return candidate
    })
    .join("")
  if (rows.length === 0 || rows.length > 32) throw unsupported()
  // An authored bullet, any other character change, code mutation or explicit
  // destination change makes this proposal ineligible, rather than equivalent.
  assertImportedMarkdownContent(expected, markdown)
  return { before, markdown, rows }
}

export type TableLiteralRepair = ReturnType<typeof deriveTableLiteralRepair>

export function patchTableLiteralRow(before: RepairTableRow) {
  let changes = 0
  const cells = before.cells.map((cell) =>
    cell.map((span) => {
      if (span.annotations.code || span.text.link !== null) throw unsupported()
      const content = span.text.content.replaceAll("•", () => {
        changes++
        return "-"
      })
      return { ...span, text: { ...span.text, content } }
    }),
  )
  if (changes === 0) throw unsupported()
  return { ...before, cells }
}

export function bindTableLiteralRows(
  proposal: TableLiteralRepair,
  before: readonly RepairTableRow[],
) {
  if (
    before.length !== proposal.rows.length ||
    new Set(before.map((row) => row.row_id)).size !== before.length
  )
    throw unsupported()
  return before.map((row, at) => {
    const changed = patchTableLiteralRow(row)
    const text = (value: RepairTableRow) =>
      value.cells.map((cell) =>
        cell
          .map((span) => span.text.content)
          .join("")
          .replace(/\s+/gu, ""),
      )
    if (
      JSON.stringify(text(row)) !== JSON.stringify(proposal.rows[at]!.before_cells) ||
      JSON.stringify(text(changed)) !== JSON.stringify(proposal.rows[at]!.after_cells)
    )
      throw unsupported()
    return changed
  })
}

export function tableLiteralProgress(proposal: TableLiteralRepair, completed: ReadonlySet<number>) {
  const lines = proposal.before.split("\n")
  for (const at of completed) {
    const row = proposal.rows[at]
    if (!row || lines[row.line_index] !== row.before_line) throw unsupported()
    lines[row.line_index] = row.after_line
  }
  return lines.join("\n")
}

/** Physical row PATCH may escape a restored hyphen. No other serialization
 * exception is permitted, and bytes outside acknowledged rows remain exact. */
export function assertTableLiteralProgress(
  proposal: TableLiteralRepair,
  completed: ReadonlySet<number>,
  actual: string,
) {
  const candidate = tableLiteralProgress(proposal, completed)
  const expectedLines = candidate.split("\n")
  const actualLines = actual.split("\n")
  if (expectedLines.length !== actualLines.length) throw unsupported()
  const changedLines = new Set([...completed].map((at) => proposal.rows[at]!.line_index))
  if (
    expectedLines.some((line, at) =>
      changedLines.has(at)
        ? line !== actualLines[at]!.replace(/\\-/gu, "-")
        : line !== actualLines[at],
    )
  )
    throw unsupported()
  assertImportedMarkdownContent(candidate, actual)
}
