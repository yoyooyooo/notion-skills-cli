import { Lexer, type Token, type Tokens } from "marked"
import type { NotionBlockBoundary, NotionTextSpan } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Part extends Range {
  readonly token: Token
}
interface Edit extends Range {
  readonly text: string
}
interface Cell extends Range {
  readonly text: string
}
interface Literal extends Range {
  readonly text: string
}
interface ParsedCell {
  readonly spans: readonly NotionTextSpan[]
  readonly literals: readonly Literal[]
  readonly escapes: ReadonlyMap<number, number>
  readonly formatted: boolean
}
type Proves = (root: number, ranges: readonly Range[]) => boolean

function keys(value: unknown, allowed: readonly string[]) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  )
}

function append(spans: NotionTextSpan[], span: NotionTextSpan) {
  if (!span.text) return
  const last = spans.at(-1)
  if (last && last.bold === span.bold && last.code === span.code && last.link === span.link)
    spans[spans.length - 1] = { ...last, text: last.text + span.text }
  else spans.push(span)
}

function sameSpans(left: readonly NotionTextSpan[], right: readonly NotionTextSpan[]) {
  return (
    left.length === right.length &&
    left.every((span, index) => {
      const other = right[index]!
      return (
        span.text === other.text &&
        span.bold === other.bold &&
        span.code === other.code &&
        span.link === other.link
      )
    })
  )
}

// A deliberately finite cell grammar. Literal HTML contributes its complete
// text only to this three-way proof; it does not change the public Markdown AST.
function parsedCell(
  raw: string,
  tokens: readonly Token[],
  source: boolean,
): ParsedCell | undefined {
  if (/[\r\n]/.test(raw)) return
  const spans: NotionTextSpan[] = [],
    literals: Literal[] = [],
    escapes = new Map<number, number>()
  let visible = 0,
    formatted = false
  const add = (text: string, bold: boolean, code: boolean, link: string | null) => {
    append(spans, { text, bold, code, link })
    visible += text.length
  }
  const walk = (
    parts: readonly Token[],
    text: string,
    base: number,
    bold: boolean,
    link: string | null,
    depth: number,
  ): boolean => {
    if (depth > 16 || parts.map((part) => part.raw).join("") !== text) return false
    let cursor = 0
    for (const part of parts) {
      const at = base + cursor
      cursor += part.raw.length
      if (part.type === "strong") {
        if (!Array.isArray(part.tokens) || typeof part.text !== "string") return false
        const marker = part.raw.slice(0, 2)
        if (
          !["**", "__"].includes(marker) ||
          part.raw !== marker + part.text + marker ||
          !walk(part.tokens, part.text, at + 2, true, link, depth + 1)
        )
          return false
        formatted = true
      } else if (part.type === "link") {
        if (
          link !== null ||
          typeof part.href !== "string" ||
          !part.href ||
          part.title != null ||
          !Array.isArray(part.tokens) ||
          typeof part.text !== "string" ||
          part.raw !== `[${part.text}](${part.href})` ||
          !walk(part.tokens, part.text, at + 1, bold, part.href, depth + 1)
        )
          return false
        formatted = true
      } else if (part.type === "codespan") {
        if (typeof part.text !== "string" || /[\r\n]/.test(part.text)) return false
        add(part.text, bold, true, link)
        formatted = true
      } else if (part.type === "html") {
        if (
          !source ||
          link !== null ||
          part.text !== part.raw ||
          part.block === true ||
          !/^<\/?[A-Za-z][^<>\r\n]*>$/.test(part.raw) ||
          /^<\/?(?:br|table|tr|td|th)(?:[ \t/>])/i.test(part.raw)
        )
          return false
        literals.push({ start: visible, end: visible + part.raw.length, text: part.raw })
        add(part.raw, bold, false, link)
      } else if (part.type === "text" || part.type === "escape") {
        if (
          typeof part.text !== "string" ||
          ("tokens" in part && Array.isArray(part.tokens) && part.tokens.length > 0)
        )
          return false
        if (part.type === "text" && part.raw !== part.text) return false
        if (part.type === "escape") {
          if (part.text.length !== 1 || part.raw !== `\\${part.text}`) return false
          if (!source && (part.text === "<" || part.text === ">")) escapes.set(visible, at)
        }
        add(part.text, bold, false, link)
      } else return false
    }
    return true
  }
  return walk(tokens, raw, 0, false, null, 0) ? { spans, literals, escapes, formatted } : undefined
}

function physicalSpans(values: readonly NotionTextSpan[]) {
  if (!Array.isArray(values)) return
  const spans: NotionTextSpan[] = []
  for (const value of values) {
    if (
      !keys(value, ["text", "bold", "code", "link"]) ||
      typeof value.text !== "string" ||
      /[\r\n]/.test(value.text) ||
      typeof value.bold !== "boolean" ||
      typeof value.code !== "boolean" ||
      (value.link !== null && typeof value.link !== "string")
    )
      return
    append(spans, value)
  }
  return spans
}

// The API uses one outer backtick and escapes every inner backtick even though
// CommonMark treats backslashes inside code literally. Derive only this exact
// serializer from complete physical code spans; the caller must still prove
// the entire corrected cell against both the source and the physical table.
function backtickCell(raw: string, spans: readonly NotionTextSpan[]) {
  const codes = spans.filter((span) => span.code && span.text.includes("`"))
  if (!codes.length || codes.some((span) => span.link !== null || /[\\\r\n]/.test(span.text)))
    return
  const edits: Edit[] = []
  for (const value of new Set(codes.map((span) => span.text))) {
    const serialized = "`" + value.replaceAll("`", "\\`") + "`"
    const fence = "`".repeat(
      Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
    )
    const text = `${fence} ${value} ${fence}`
    const offsets: number[] = []
    let cursor = 0
    for (;;) {
      const start = raw.indexOf(serialized, cursor)
      if (start < 0) break
      offsets.push(start)
      cursor = start + serialized.length
    }
    if (offsets.length !== codes.filter((span) => span.text === value).length) return
    edits.push(...offsets.map((start) => ({ start, end: start + serialized.length, text })))
  }
  edits.sort((left, right) => left.start - right.start)
  if (edits.some((edit, index) => index > 0 && edits[index - 1]!.end > edit.start)) return
  let result = raw
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

function tableCells(raw: string): Cell[][] | undefined {
  if (raw.includes("\r")) return
  const open = /^<table header-row="true">[ \t]*\n/.exec(raw)
  if (!open) return
  let cursor = open[0].length
  const rows: Cell[][] = []
  const whitespace = () => {
    cursor += /^[ \t\n]*/.exec(raw.slice(cursor))![0].length
  }
  whitespace()
  while (raw.startsWith("<tr>", cursor)) {
    cursor += 4
    whitespace()
    const cells: Cell[] = []
    while (raw.startsWith("<td>", cursor)) {
      const start = cursor + 4,
        end = raw.indexOf("</td>", start)
      if (end < 0 || /[\r\n]/.test(raw.slice(start, end))) return
      cells.push({ start, end, text: raw.slice(start, end) })
      cursor = end + 5
      whitespace()
    }
    if (!cells.length || !raw.startsWith("</tr>", cursor)) return
    rows.push(cells)
    cursor += 5
    whitespace()
  }
  return rows.length && /^<\/table>[ \t]*\n*$/.test(raw.slice(cursor)) ? rows : undefined
}

function completePhysicalTable(root: NotionBlockBoundary) {
  const table = root.table_evidence
  if (
    root.type !== "table" ||
    !root.has_children ||
    !table ||
    !keys(table, ["width", "header_row", "header_column", "rows"]) ||
    !Number.isSafeInteger(table.width) ||
    table.width < 1 ||
    table.header_row !== true ||
    table.header_column !== false ||
    !Array.isArray(table.rows) ||
    !table.rows.length ||
    root.descendants !== undefined ||
    root.quote_descendants !== undefined ||
    root.list_table_descendants !== undefined
  )
    return
  const result: NotionTextSpan[][][] = [],
    ids = new Set<string>([root.id])
  for (const row of table.rows) {
    if (
      !keys(row, ["id", "type", "has_children", "parent_id", "table_row"]) ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      row.type !== "table_row" ||
      row.has_children !== false ||
      row.parent_id !== root.id ||
      !keys(row.table_row, ["cells"]) ||
      !Array.isArray(row.table_row?.cells) ||
      row.table_row.cells.length !== table.width
    )
      return
    ids.add(row.id)
    const cells: NotionTextSpan[][] = []
    for (const cell of row.table_row.cells) {
      const spans = physicalSpans(cell)
      if (!spans) return
      cells.push(spans)
    }
    result.push(cells)
  }
  return result
}

function sourceCells(table: Pick<Tokens.Table, "header" | "rows" | "align">) {
  if (
    !Array.isArray(table.header) ||
    !table.header.length ||
    !Array.isArray(table.rows) ||
    !Array.isArray(table.align) ||
    table.align.some((value) => value !== null)
  )
    return
  const result: ParsedCell[][] = []
  for (const row of [table.header, ...table.rows]) {
    if (row.length !== table.header.length) return
    const cells: ParsedCell[] = []
    for (const cell of row) {
      if (!Array.isArray(cell.tokens)) return
      const parsed = parsedCell(cell.text, cell.tokens, true)
      if (!parsed) return
      cells.push(parsed)
    }
    result.push(cells)
  }
  return result
}

function completeIds(roots: readonly NotionBlockBoundary[]) {
  const identity = (value: string) =>
    /^[0-9a-f-]+$/i.test(value) && value.replaceAll("-", "").length === 32
      ? value.replaceAll("-", "").toLowerCase()
      : value
  const ids = new Set<string>()
  for (const root of roots) {
    const groups = [
      root.descendants,
      root.quote_descendants,
      root.list_table_descendants,
      root.table_evidence?.rows,
    ]
    if (groups.some((group) => group !== undefined && !Array.isArray(group))) return false
    for (const node of [root, ...groups.flatMap((group) => group ?? [])]) {
      if (!node || typeof node.id !== "string" || !node.id || ids.has(identity(node.id)))
        return false
      ids.add(identity(node.id))
      if (ids.size > 4096) return false
    }
  }
  return true
}

function inlineAnchor(
  token: Token | undefined,
  root: NotionBlockBoundary | undefined,
  emphasized = false,
) {
  if (
    !token ||
    !root ||
    root.has_children ||
    !root.rich_text?.length ||
    !["paragraph", "heading"].includes(token.type) ||
    !("text" in token) ||
    typeof token.text !== "string" ||
    !("tokens" in token) ||
    !Array.isArray(token.tokens) ||
    /[\r\n]/.test(token.text)
  )
    return false
  if (token.type === "heading" ? root.type !== `heading_${token.depth}` : root.type !== "paragraph")
    return false
  let text = token.text,
    tokens = token.tokens
  if (emphasized) {
    const emphasis = tokens[0]
    if (
      token.type !== "paragraph" ||
      tokens.length !== 1 ||
      emphasis?.type !== "em" ||
      typeof emphasis.text !== "string" ||
      !Array.isArray(emphasis.tokens)
    )
      return false
    text = emphasis.text
    tokens = emphasis.tokens
  }
  const expected = parsedCell(text, tokens, true),
    observed = physicalSpans(root.rich_text)
  return (
    !!expected && !expected.literals.length && !!observed && sameSpans(expected.spans, observed)
  )
}

// Repeated emphasized paragraphs cannot supply the generic root locator's
// unique neighboring anchor. The finite serializer decoder has already made
// this whole line equal to the source. The complete heading/paragraph/table/
// heading interval must be unique in all three representations; neither a
// repeated paragraph nor a repeated heading can supply its position alone.
function emphasizedTableBoundary(
  actual: readonly Part[],
  wanted: readonly Part[],
  roots: readonly NotionBlockBoundary[],
  rootIndex: number,
  observed: Part,
  expected: Part,
) {
  const before = roots[rootIndex - 2],
    paragraph = roots[rootIndex - 1],
    after = roots[rootIndex + 1]
  if (
    !before ||
    !after ||
    !/^heading_[123]$/.test(before.type) ||
    !/^heading_[123]$/.test(after.type)
  )
    return false
  const at = actual.indexOf(observed),
    sourceAt = wanted.indexOf(expected)
  const sourceParagraph = wanted[sourceAt - 1]?.token,
    actualParagraph = actual[at - 1]?.token
  if (
    sourceParagraph?.type !== "paragraph" ||
    actualParagraph?.type !== "paragraph" ||
    sourceParagraph.text !== actualParagraph.text ||
    !inlineAnchor(sourceParagraph, paragraph, true) ||
    !inlineAnchor(actualParagraph, paragraph, true)
  )
    return false
  for (const [parts, index] of [
    [actual, at],
    [wanted, sourceAt],
  ] as const) {
    const interval = (at: number) => {
      const paragraphToken = parts[at - 1]?.token,
        tableToken = parts[at]?.token
      return (
        inlineAnchor(parts[at - 2]?.token, before) &&
        paragraphToken?.type === "paragraph" &&
        paragraphToken.text === sourceParagraph.text &&
        inlineAnchor(paragraphToken, paragraph, true) &&
        inlineAnchor(parts[at + 1]?.token, after) &&
        (tableToken?.type === "table" ||
          (tableToken?.type === "html" && /^<table\b/.test(tableToken.raw)))
      )
    }
    if (!interval(index) || parts.filter((_, at) => interval(at)).length !== 1) return false
  }
  const sameNode = (node: NotionBlockBoundary | undefined, expected: NotionBlockBoundary) => {
    if (
      !node ||
      node.type !== expected.type ||
      node.has_children ||
      !node.rich_text ||
      !expected.rich_text
    )
      return false
    const left = physicalSpans(node.rich_text),
      right = physicalSpans(expected.rich_text)
    return !!left && !!right && sameSpans(left, right)
  }
  return (
    roots.filter(
      (node, index) =>
        node.type === "table" &&
        node.has_children &&
        sameNode(roots[index - 2], before) &&
        sameNode(roots[index - 1], paragraph!) &&
        sameNode(roots[index + 1], after),
    ).length === 1
  )
}

/** A mixed-format table is eligible only when every source/physical/readback
 * cell agrees. Decode only the exact inner-backtick serializer or the two
 * escapes around an identified source HTML token. All other bytes stay intact. */
export function physicalTableLiteralEdits(
  actual: readonly Part[],
  wanted: readonly Part[],
  roots: readonly NotionBlockBoundary[],
  proves: Proves,
): Edit[] {
  if (!completeIds(roots)) return []
  const physical = roots.flatMap((root, index) => (root.type === "table" ? [{ root, index }] : []))
  const source = wanted.filter((part) => part.token.type === "table")
  const readback = actual.filter(
    (part) => part.token.type === "html" && /^<table\b/.test(part.token.raw),
  )
  if (!physical.length || source.length !== physical.length || readback.length !== physical.length)
    return []
  const edits: Edit[] = []
  for (const [index, { root, index: rootIndex }] of physical.entries()) {
    const sourcePart = source[index]!,
      token = sourcePart.token
    if (token.type !== "table") continue
    const expected = sourceCells({ header: token.header, rows: token.rows, align: token.align }),
      observed = completePhysicalTable(root),
      part = readback[index]!
    const current = tableCells(part.token.raw)
    if (
      !expected ||
      !observed ||
      !current ||
      expected.length !== observed.length ||
      expected.length !== current.length ||
      !expected.flat().some((cell) => cell.formatted) ||
      !expected
        .flat()
        .some(
          (cell) =>
            cell.literals.length || cell.spans.some((span) => span.code && span.text.includes("`")),
        ) ||
      (!proves(rootIndex, [part]) &&
        !emphasizedTableBoundary(actual, wanted, roots, rootIndex, part, sourcePart))
    )
      continue
    const proposed: Edit[] = []
    let valid = true
    for (const [rowIndex, row] of expected.entries()) {
      if (row.length !== observed[rowIndex]!.length || row.length !== current[rowIndex]!.length) {
        valid = false
        break
      }
      for (const [column, cell] of row.entries()) {
        const raw = current[rowIndex]![column]!
        const retained = observed[rowIndex]![column]!
        if (!sameSpans(cell.spans, retained)) {
          valid = false
          break
        }
        let text = raw.text,
          parsed = parsedCell(text, Lexer.lexInline(text), false)
        if (!parsed || !sameSpans(parsed.spans, retained)) {
          const candidate = backtickCell(text, retained)
          if (candidate === undefined) {
            valid = false
            break
          }
          text = candidate
          parsed = parsedCell(text, Lexer.lexInline(text), false)
        }
        if (!parsed || !sameSpans(parsed.spans, retained)) {
          valid = false
          break
        }
        const remove: number[] = []
        for (const literal of cell.literals) {
          const start = parsed.escapes.get(literal.start),
            end = parsed.escapes.get(literal.end - 1)
          const escaped = `\\${literal.text.slice(0, -1)}\\>`
          if (
            start === undefined ||
            end === undefined ||
            end !== start + escaped.length - 2 ||
            text.slice(start, end + 2) !== escaped
          ) {
            valid = false
            break
          }
          remove.push(start, end)
        }
        if (!valid) break
        for (const offset of remove.sort((left, right) => right - left))
          text = text.slice(0, offset) + text.slice(offset + 1)
        if (text !== raw.text)
          proposed.push({ start: part.start + raw.start, end: part.start + raw.end, text })
      }
      if (!valid) break
    }
    if (valid) edits.push(...proposed)
  }
  return edits
}
