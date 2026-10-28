import { type Token } from "marked"
import { SourceLexer as Lexer } from "@notion-skills-cli/markdown"
import { codeLanguage } from "./markdown.ts"
import { markdownRichText, markdownTableCells } from "./markdown-blocks.ts"

export interface PhysicalNode {
  readonly raw: Record<string, unknown>
  readonly children: readonly PhysicalNode[]
}

interface TextStyle {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly underline: boolean
  readonly code: boolean
  readonly color: string
}
interface TextSpan {
  readonly text: string
  readonly url: string | null
  readonly style: TextStyle
}
type TextBlockType = "paragraph" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item"
export type SourceRootBlock =
  | { readonly type: TextBlockType; readonly rich_text: readonly TextSpan[] }
  | {
      readonly type: "numbered_list_item"
      readonly rich_text: readonly TextSpan[]
      readonly start: number | null
    }
  | {
      readonly type: "table"
      readonly width: number
      readonly rows: readonly (readonly (readonly TextSpan[])[])[]
    }
  | { readonly type: "code"; readonly language: string; readonly text: string }
  | { readonly type: "divider" }

export interface SourceRootBodyModel {
  readonly version: 1
  readonly roots: readonly SourceRootBlock[]
}

const defaultStyle: TextStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
const styleKeys = ["bold", "italic", "strikethrough", "underline", "code", "color"]
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function sameStyle(left: TextStyle, right: TextStyle) {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.underline === right.underline &&
    left.code === right.code &&
    left.color === right.color
  )
}

// Only segmentation of adjacent text with identical complete formatting and
// destination is immaterial. No text, entity, whitespace or URL is normalized.
function richText(values: unknown, source: boolean): TextSpan[] | undefined {
  if (!Array.isArray(values)) return
  const spans: TextSpan[] = []
  for (const value of values) {
    if (
      !record(value) ||
      value.type !== "text" ||
      !keys(value, ["type", "text", "annotations", "plain_text", "href"]) ||
      !record(value.text) ||
      !keys(value.text, ["content", "link"]) ||
      typeof value.text.content !== "string" ||
      !value.text.content.length ||
      !record(value.annotations) ||
      !keys(value.annotations, styleKeys)
    )
      return
    const text = value.text.content
    let url: string | null = null
    if (value.text.link != null) {
      if (
        !record(value.text.link) ||
        !keys(value.text.link, ["url"]) ||
        typeof value.text.link.url !== "string" ||
        !value.text.link.url
      )
        return
      url = value.text.link.url
    }
    const annotations = value.annotations
    if (
      !source &&
      (value.plain_text !== text ||
        value.href !== url ||
        styleKeys.some((key) => !(key in annotations)))
    )
      return
    const bold = source ? (annotations.bold ?? false) : annotations.bold,
      italic = source ? (annotations.italic ?? false) : annotations.italic,
      strikethrough = source ? (annotations.strikethrough ?? false) : annotations.strikethrough,
      underline = source ? (annotations.underline ?? false) : annotations.underline,
      code = source ? (annotations.code ?? false) : annotations.code,
      color = source ? (annotations.color ?? "default") : annotations.color
    if (
      typeof bold !== "boolean" ||
      typeof italic !== "boolean" ||
      typeof strikethrough !== "boolean" ||
      typeof underline !== "boolean" ||
      typeof code !== "boolean" ||
      typeof color !== "string"
    )
      return
    const style: TextStyle = { bold, italic, strikethrough, underline, code, color }
    const previous = spans.at(-1)
    if (previous && previous.url === url && sameStyle(previous.style, style))
      spans[spans.length - 1] = { ...previous, text: previous.text + text }
    else spans.push({ text, url, style })
  }
  return spans
}

function supportedInline(tokens: readonly Token[], depth = 0): boolean {
  if (depth > 32) return false
  return tokens.every((token) => {
    if (
      token.type === "strong" ||
      token.type === "em" ||
      token.type === "del" ||
      token.type === "link"
    ) {
      if (!Array.isArray(token.tokens) || !token.tokens.length) return false
      if (
        token.type === "link" &&
        (typeof token.href !== "string" || !token.href || token.title != null)
      )
        return false
      return supportedInline(token.tokens, depth + 1)
    }
    return (
      ["text", "escape", "codespan", "br"].includes(token.type) &&
      !("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) &&
      (token.type === "br" || ("text" in token && typeof token.text === "string"))
    )
  })
}
function compileInline(tokens: readonly Token[]) {
  if (!supportedInline(tokens)) return
  return richText(markdownRichText(tokens), true)
}

/** Input is the already imported authored body, after the original reference
 * mapping. The UIUX corpus needs only headings, paragraphs, flat lists, tables,
 * code and dividers. Unsupported structure refuses before a request is planned. */
export function compileSourceRootBody(markdown: string): SourceRootBodyModel | undefined {
  try {
    const roots: SourceRootBlock[] = []
    for (const token of Lexer.lex(markdown)) {
      if (token.type === "space") continue
      if (token.type === "paragraph" || token.type === "heading") {
        if (!Array.isArray(token.tokens)) return
        const spans = compileInline(token.tokens)
        if (!spans?.length) return
        if (token.type === "paragraph") roots.push({ type: "paragraph", rich_text: spans })
        else {
          if (!("depth" in token) || typeof token.depth !== "number") return
          const type =
            token.depth === 1
              ? "heading_1"
              : token.depth === 2
                ? "heading_2"
                : token.depth === 3
                  ? "heading_3"
                  : undefined
          if (!type) return
          roots.push({ type, rich_text: spans })
        }
      } else if (token.type === "list") {
        if (
          token.loose !== false ||
          !Array.isArray(token.items) ||
          !token.items.length ||
          typeof token.ordered !== "boolean" ||
          (token.ordered &&
            (typeof token.start !== "number" ||
              !Number.isSafeInteger(token.start) ||
              token.start < 1))
        )
          return
        for (const [index, item] of token.items.entries()) {
          if (item.task === true || item.loose !== false || !Array.isArray(item.tokens)) return
          const content = item.tokens.filter((child: Token) => child.type !== "space")
          if (
            content.length !== 1 ||
            content[0]?.type !== "text" ||
            !Array.isArray(content[0].tokens)
          )
            return
          const spans = compileInline(content[0].tokens)
          if (!spans?.length) return
          if (token.ordered) {
            // Continuations must not introduce a hidden physical restart.
            if (typeof token.start !== "number") return
            roots.push({
              type: "numbered_list_item",
              rich_text: spans,
              start: index === 0 ? token.start : null,
            })
          } else roots.push({ type: "bulleted_list_item", rich_text: spans })
        }
      } else if (token.type === "table") {
        if (
          !Array.isArray(token.header) ||
          !token.header.length ||
          !Array.isArray(token.rows) ||
          !Array.isArray(token.align) ||
          token.align.some((value) => value !== null)
        )
          return
        const cells = [token.header, ...token.rows]
        if (
          cells.some(
            (row) =>
              !Array.isArray(row) ||
              row.length !== token.header.length ||
              row.some((cell) => !Array.isArray(cell.tokens) || !supportedInline(cell.tokens)),
          )
        )
          return
        const rows: TextSpan[][][] = []
        for (const row of cells) {
          const values = markdownTableCells(row).map((value) => richText(value, true))
          if (values.some((value) => value === undefined)) return
          const complete: TextSpan[][] = []
          for (const value of values) {
            if (value === undefined) return
            complete.push(value)
          }
          rows.push(complete)
        }
        roots.push({ type: "table", width: token.header.length, rows })
      } else if (token.type === "code") {
        if (
          typeof token.text !== "string" ||
          (token.lang !== undefined && typeof token.lang !== "string")
        )
          return
        roots.push({ type: "code", language: codeLanguage(token.lang), text: token.text })
      } else if (token.type === "hr") roots.push({ type: "divider" })
      else return
    }
    return roots.length ? { version: 1, roots } : undefined
  } catch {
    return
  }
}

function sameRichText(value: unknown, wanted: readonly TextSpan[]) {
  const actual = richText(value, false)
  return (
    actual !== undefined &&
    actual.length === wanted.length &&
    actual.every((span, index) => {
      const expected = wanted[index]!
      return (
        span.text === expected.text &&
        span.url === expected.url &&
        sameStyle(span.style, expected.style)
      )
    })
  )
}

function matchBlock(expected: SourceRootBlock, node: PhysicalNode): boolean {
  const raw = node.raw
  if (
    !record(raw) ||
    raw.type !== expected.type ||
    !Array.isArray(node.children) ||
    raw.archived === true ||
    raw.is_archived === true ||
    raw.in_trash === true ||
    raw.has_children !== node.children.length > 0 ||
    !record(raw[expected.type])
  )
    return false
  const body = raw[expected.type]
  if (!record(body)) return false
  if (expected.type === "table") {
    if (
      !keys(body, ["table_width", "has_column_header", "has_row_header"]) ||
      body.table_width !== expected.width ||
      body.has_column_header !== true ||
      body.has_row_header !== false ||
      node.children.length !== expected.rows.length
    )
      return false
    return node.children.every((row, index) => {
      const value = row.raw
      if (
        !record(value) ||
        value.type !== "table_row" ||
        value.has_children !== false ||
        value.archived === true ||
        value.is_archived === true ||
        value.in_trash === true ||
        !Array.isArray(row.children) ||
        row.children.length !== 0 ||
        !record(value.table_row) ||
        !keys(value.table_row, ["cells"]) ||
        !Array.isArray(value.table_row.cells) ||
        value.table_row.cells.length !== expected.width
      )
        return false
      return value.table_row.cells.every((cell, column) =>
        sameRichText(cell, expected.rows[index]![column]!),
      )
    })
  }
  if (node.children.length !== 0) return false
  if (expected.type === "divider") return Object.keys(body).length === 0
  if (expected.type === "code") {
    if (
      !keys(body, ["rich_text", "caption", "language"]) ||
      !Array.isArray(body.caption) ||
      body.caption.length !== 0 ||
      typeof body.language !== "string" ||
      codeLanguage(body.language) !== expected.language
    )
      return false
    return sameRichText(
      body.rich_text,
      expected.text ? [{ text: expected.text, url: null, style: defaultStyle }] : [],
    )
  }
  if (body.color !== "default" || !sameRichText(body.rich_text, expected.rich_text)) return false
  if (expected.type === "paragraph")
    return keys(body, ["rich_text", "color", "icon"]) && body.icon == null
  if (expected.type === "numbered_list_item") {
    if (
      !keys(body, ["rich_text", "color", "list_start_index", "list_format"]) ||
      (body.list_format !== undefined && body.list_format !== "numbers")
    )
      return false
    return expected.start === null
      ? body.list_start_index === undefined
      : body.list_start_index === expected.start ||
          (expected.start === 1 && body.list_start_index === undefined)
  }
  if (expected.type === "bulleted_list_item") return keys(body, ["rich_text", "color"])
  return (
    keys(body, ["rich_text", "color", "is_toggleable"]) &&
    (body.is_toggleable === undefined || body.is_toggleable === false)
  )
}

/** The caller separately closes IDs, parent chains and pagination, and binds
 * retained reference pages. This consumes every supplied ordinary root and
 * descendant: no Markdown equality fast path can hide an extra empty block. */
export function sourceRootBodyMatches(
  model: SourceRootBodyModel,
  roots: readonly PhysicalNode[],
): boolean {
  try {
    return (
      model.version === 1 &&
      Array.isArray(model.roots) &&
      model.roots.length > 0 &&
      Array.isArray(roots) &&
      model.roots.length === roots.length &&
      model.roots.every((expected, index) => matchBlock(expected, roots[index]!))
    )
  } catch {
    return false
  }
}

// The follow-on repair consumes the same strict physical text model. These
// exports do not change the compiler, comparison rules or frozen model bytes.
export { richText as sourceRootRichText, sameRichText as sourceRootRichTextMatches }
