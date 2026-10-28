import type { Token, Tokens } from "marked"
import { SourceLexer } from "./source-lexer.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Positioned extends Range {
  readonly token: Token
}
interface Edit extends Range {
  readonly text: string
}
interface Piece {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly bold: boolean
}
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean

function pieces(tokens: readonly Token[] | undefined, bold = false): Piece[] | undefined {
  if (!tokens) return
  const result: Piece[] = []
  let offset = 0
  for (const token of tokens) {
    const start = offset
    offset += token.raw.length
    const text = token.type === "text" && typeof token.text === "string" ? token : undefined
    const escape = token.type === "escape" && typeof token.text === "string" ? token : undefined
    const strong =
      token.type === "strong" && typeof token.text === "string" && Array.isArray(token.tokens)
        ? token
        : undefined
    const deletion = token.type === "del" && Array.isArray(token.tokens) ? token : undefined
    if (text && text.raw === text.text) {
      if (text.text) result.push({ start, end: offset, text: text.text, bold })
    } else if (escape && escape.raw === "\\~" && escape.text === "~") {
      result.push({ start, end: offset, text: escape.raw, bold })
    } else if (
      strong &&
      Array.isArray(strong.tokens) &&
      !bold &&
      strong.raw === `**${strong.text}**` &&
      strong.tokens.map((part: Token) => part.raw).join("") === strong.text
    ) {
      const nested = pieces(strong.tokens, true)?.map((piece) => ({
        ...piece,
        start: start + piece.start,
        end: start + piece.end,
      }))
      if (!nested || nested.some((piece) => piece.text.includes("~"))) return
      result.push(...nested)
    } else if (
      deletion &&
      Array.isArray(deletion.tokens) &&
      /^~[^~\r\n]+~$/.test(deletion.raw) &&
      deletion.tokens.length &&
      deletion.tokens.every(
        (part: Token) =>
          part.type === "text" && typeof part.text === "string" && part.raw === part.text,
      ) &&
      deletion.tokens.map((part: Token) => part.raw).join("") === deletion.raw.slice(1, -1)
    ) {
      result.push({ start, end: offset, text: deletion.raw, bold })
    } else return
  }
  return result
}

function paragraphToken(token: Token): Tokens.Paragraph | undefined {
  return token.type === "paragraph" && typeof token.text === "string" && Array.isArray(token.tokens)
    ? (token as Tokens.Paragraph)
    : undefined
}

function paragraphPieces(token: Token) {
  const paragraph = paragraphToken(token)
  if (
    !paragraph ||
    /[\r\n]/.test(paragraph.text) ||
    !paragraph.raw.startsWith(paragraph.text) ||
    !/^\n*$/.test(paragraph.raw.slice(paragraph.text.length)) ||
    paragraph.tokens.map((part) => part.raw).join("") !== paragraph.text
  )
    return
  const result = pieces(paragraph.tokens)
  const covered = result?.map((piece) => piece.text).join("")
  const visible = paragraph.tokens
    .map((part) => (part.type === "strong" && typeof part.text === "string" ? part.text : part.raw))
    .join("")
  return result && covered === visible ? result : undefined
}

function rendered(parts: readonly Piece[]) {
  return parts.map((piece) => (piece.text === "\\~" ? "~" : piece.text)).join("")
}

function grouped(parts: readonly Piece[]) {
  const result: { text: string; bold: boolean }[] = []
  for (const piece of parts) {
    const text = piece.text === "\\~" ? "~" : piece.text
    const previous = result.at(-1)
    if (previous && previous.bold === piece.bold) previous.text += text
    else result.push({ text, bold: piece.bold })
  }
  return result
}

function plain(spans: readonly NotionTextSpan[] | undefined) {
  if (!spans?.length) return
  const result: { text: string; bold: boolean }[] = []
  for (const span of spans) {
    if (
      !span ||
      typeof span.text !== "string" ||
      !span.text ||
      typeof span.bold !== "boolean" ||
      typeof span.code !== "boolean" ||
      span.code ||
      span.link !== null
    )
      return
    const previous = result.at(-1)
    if (previous && previous.bold === span.bold) previous.text += span.text
    else result.push({ text: span.text, bold: span.bold })
  }
  return result
}
function plainStyle(
  span: NotionTextSpan & {
    annotations?: {
      italic?: unknown
      strikethrough?: unknown
      underline?: unknown
      color?: unknown
    }
  },
) {
  const style = span.annotations
  return (
    !style ||
    (style.italic === false &&
      style.strikethrough === false &&
      style.underline === false &&
      (style.color === undefined || style.color === "default"))
  )
}

function styledQuoteLine(block: NotionBlockBoundary) {
  const spans = block.rich_text
  if (
    block.type !== "quote" ||
    block.has_children ||
    !spans?.length ||
    !spans.some((span) => span.bold || span.code)
  )
    return
  let body = ""
  for (const span of spans) {
    if (
      !span.text ||
      span.link !== null ||
      !plainStyle(span) ||
      (span.bold && span.code) ||
      /[\r\n\\]/.test(span.text) ||
      (span.bold && span.text.includes("*")) ||
      (span.code && span.text.includes("`"))
    )
      return
    const text = span.code ? "`" + span.text + "`" : span.text
    body += span.bold ? `**${text}**` : text
  }
  return body ? "> " + body : undefined
}

function quoteParagraph(token: Token): Tokens.Paragraph | undefined {
  if (token.type !== "blockquote" || !Array.isArray(token.tokens)) return
  const children = token.tokens.filter((child) => child.type !== "space")
  const paragraph = children.length === 1 ? children[0] : undefined
  return paragraph ? paragraphToken(paragraph) : undefined
}

function styledQuote(part: Positioned, line: string) {
  const paragraph = quoteParagraph(part.token)
  return (
    !!paragraph &&
    part.token.raw.replace(/\n+$/, "") === line &&
    /^\n+$/.test(part.token.raw.slice(line.length)) &&
    !/[\r\n]/.test(paragraph.text) &&
    paragraph.raw.replace(/\n+$/, "") === line.slice(2) &&
    paragraph.tokens.map((token) => token.raw).join("") === paragraph.text
  )
}

function headingToken(token: Token, depth: number): Tokens.Heading | undefined {
  return token.type === "heading" && token.depth === depth && typeof token.text === "string"
    ? (token as Tokens.Heading)
    : undefined
}

function pairedHeading(
  part: Positioned,
  block: NotionBlockBoundary,
  boundaries: readonly NotionBlockBoundary[],
  actual: readonly Positioned[],
) {
  const depth = /^heading_([1-6])$/.exec(block.type)
  const text = block.rich_text?.map((span) => span.text).join("") ?? block.text
  const level = depth ? Number(depth[1]) : undefined
  const heading = level === undefined ? undefined : headingToken(part.token, level)
  if (
    !depth ||
    !heading ||
    block.has_children ||
    typeof text !== "string" ||
    !text ||
    /[\r\n]/.test(text) ||
    block.rich_text?.some(
      (span) => span.bold || span.code || span.link !== null || !plainStyle(span),
    ) ||
    heading.text !== text
  )
    return false
  const roots = boundaries.filter((item) => item.type === block.type)
  const tokens = actual.filter((item) => headingToken(item.token, level!) !== undefined)
  return roots.length === tokens.length && roots.indexOf(block) === tokens.indexOf(part)
}

/** Ordered proof cannot see a styled quote. The paragraph is still owned when the
 * preceding heading pairs by depth and the following quote's physical spans are
 * that blockquote's exact bytes, with nothing between them. */
function ownedBetweenHeadingAndQuote(
  part: Positioned,
  rootIndex: number,
  actual: readonly Positioned[],
  boundaries: readonly NotionBlockBoundary[],
) {
  const index = actual.indexOf(part)
  const before = actual[index - 1],
    after = actual[index + 1]
  const heading = boundaries[rootIndex - 1],
    quote = boundaries[rootIndex + 1]
  const line = quote ? styledQuoteLine(quote) : undefined
  return (
    !!before &&
    !!after &&
    !!heading &&
    !!line &&
    before.end === part.start &&
    after.start === part.end &&
    pairedHeading(before, heading, boundaries, actual) &&
    styledQuote(after, line) &&
    actual.filter((item) => styledQuote(item, line)).length === 1 &&
    boundaries.filter((item) => styledQuoteLine(item) === line).length === 1
  )
}

function supportedAnnotations(block: NotionBlockBoundary) {
  return !!block.rich_text?.every((span) => {
    const style = (
      span as NotionTextSpan & {
        annotations?: {
          italic?: unknown
          strikethrough?: unknown
          underline?: unknown
          color?: unknown
        }
      }
    ).annotations
    return (
      !style ||
      (style.italic === false &&
        style.strikethrough === false &&
        style.underline === false &&
        (style.color === undefined || style.color === "default"))
    )
  })
}

/** Remove readback escapes only when one source paragraph retains every single
 * tilde literally, including one ordinary deletion token, and one plain physical
 * paragraph owns that exact text. A styled following quote proves that leaf when
 * ordered proof cannot locate it. Double-tilde deletion stays untouched. */
export function literalSingleTildeEdits(
  actual: readonly Positioned[],
  wanted: readonly Positioned[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  const consumed = new Set<number>()
  for (const part of actual) {
    const paragraph = paragraphToken(part.token)
    const readback = paragraph && paragraphPieces(paragraph)
    if (
      !paragraph ||
      !readback ||
      !SourceLexer.lexInline(paragraph.text).every(
        (token, index) => token.raw === paragraph.tokens[index]?.raw,
      )
    )
      continue
    const escapes = readback.filter((piece) => piece.text === "\\~")
    if (
      !escapes.length ||
      readback.some((piece) => piece.text !== "\\~" && piece.text.includes("~"))
    )
      continue
    const literal = rendered(readback)
    const matches = wanted.flatMap((item, index) => {
      if (consumed.has(index)) return []
      const source = paragraphPieces(item.token)
      const deletion = source?.filter((piece) => /^~[^~\r\n]+~$/.test(piece.text))
      return source &&
        !source.some((piece) => piece.text.startsWith("\\")) &&
        deletion?.length === 1 &&
        !deletion[0]!.bold &&
        rendered(source) === literal &&
        JSON.stringify(grouped(source)) === JSON.stringify(grouped(readback))
        ? [index]
        : []
    })
    const roots = boundaries.flatMap((block, index) =>
      block.type === "paragraph" &&
      !block.has_children &&
      supportedAnnotations(block) &&
      JSON.stringify(plain(block.rich_text)) === JSON.stringify(grouped(readback)) &&
      (block.text === undefined || block.text === literal)
        ? [index]
        : [],
    )
    const range = { start: part.start, end: part.start + paragraph.text.length }
    if (
      matches.length !== 1 ||
      roots.length !== 1 ||
      (!proves(roots[0]!, [range]) &&
        !ownedBetweenHeadingAndQuote(part, roots[0]!, actual, boundaries))
    )
      continue
    consumed.add(matches[0]!)
    for (const piece of escapes.reverse())
      edits.push({ start: part.start + piece.start, end: part.start + piece.start + 1, text: "" })
  }
  return edits
}
