import type { Token, Tokens } from "marked"

interface Style {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly underline: boolean
  readonly code: boolean
  readonly color: string
}
interface Span {
  text: string
  readonly url: string | null
  readonly style: Style
}
interface SourceSpans {
  readonly spans: Span[]
  readonly hasHtml: boolean
}
const defaultStyle: Style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function sameStyle(left: Style, right: Style) {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.underline === right.underline &&
    left.code === right.code &&
    left.color === right.color
  )
}
function append(spans: Span[], value: Span) {
  if (!value.text) return
  const last = spans.at(-1)
  if (last && last.url === value.url && sameStyle(last.style, value.style)) last.text += value.text
  else spans.push({ ...value })
}

// Evidence only: HTML is its complete literal source token. No HTML renderer or
// Notion mutation body is exposed by this projection.
function sourceSpans(
  tokens: readonly Token[],
  style = defaultStyle,
  url: string | null = null,
): SourceSpans | undefined {
  const spans: Span[] = []
  let hasHtml = false
  for (const token of tokens) {
    if (
      token.type === "strong" ||
      token.type === "em" ||
      token.type === "del" ||
      token.type === "link"
    ) {
      if (!Array.isArray(token.tokens)) return
      if (
        token.type === "link" &&
        (typeof token.href !== "string" || !token.href || token.title != null || url !== null)
      )
        return
      const nestedStyle =
        token.type === "link"
          ? style
          : {
              ...style,
              [token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough"]:
                true,
            }
      const nested = sourceSpans(
        token.tokens,
        nestedStyle,
        token.type === "link" ? token.href : url,
      )
      if (!nested) return
      hasHtml ||= nested.hasHtml
      for (const span of nested.spans) append(spans, span)
      continue
    }
    if (
      !["text", "escape", "codespan", "br", "html"].includes(token.type) ||
      ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0)
    )
      return
    let text: string
    if (token.type === "br") text = "\n"
    else if (token.type === "html") {
      if (
        typeof token.raw !== "string" ||
        !token.raw ||
        token.text !== token.raw ||
        token.block === true
      )
        return
      text = token.raw
      hasHtml = true
    } else {
      if (!("text" in token) || typeof token.text !== "string") return
      text = token.text
    }
    append(spans, {
      text,
      url,
      style: token.type === "codespan" ? { ...style, code: true } : style,
    })
  }
  return { spans, hasHtml }
}

function currentSpans(values: unknown): Span[] | undefined {
  if (!Array.isArray(values)) return
  const spans: Span[] = []
  for (const value of values) {
    if (
      !record(value) ||
      value.type !== "text" ||
      !record(value.text) ||
      typeof value.text.content !== "string" ||
      (value.plain_text !== undefined && value.plain_text !== value.text.content) ||
      !record(value.annotations)
    )
      return
    const text = value.text,
      annotations = value.annotations
    if (
      Object.keys(text).some((key) => key !== "content" && key !== "link") ||
      Object.keys(annotations).some(
        (key) => !["bold", "italic", "strikethrough", "underline", "code", "color"].includes(key),
      ) ||
      typeof annotations.bold !== "boolean" ||
      typeof annotations.italic !== "boolean" ||
      typeof annotations.strikethrough !== "boolean" ||
      typeof annotations.underline !== "boolean" ||
      typeof annotations.code !== "boolean" ||
      typeof annotations.color !== "string"
    )
      return
    let url: string | null = null
    if (text.link != null) {
      if (
        !record(text.link) ||
        Object.keys(text.link).length !== 1 ||
        typeof text.link.url !== "string"
      )
        return
      url = text.link.url
    }
    if (value.href !== undefined && value.href !== url) return
    append(spans, {
      text: value.text.content,
      url,
      style: {
        bold: annotations.bold,
        italic: annotations.italic,
        strikethrough: annotations.strikethrough,
        underline: annotations.underline,
        code: annotations.code,
        color: annotations.color,
      },
    })
  }
  return spans
}

/** A row containing unsupported literal HTML needs no serialization when every
 * source cell already equals its complete physical text, format and URL value.
 * Failure to prove this leaves the existing serializer and its refusal intact.
 * The caller still performs the ordinary complete page and URL verification. */
export function literalHtmlTableRowAlreadyExact(
  cells: readonly Tokens.TableCell[],
  row: unknown,
  tableId: unknown,
): boolean {
  if (
    typeof tableId !== "string" ||
    !tableId ||
    !record(row) ||
    typeof row.id !== "string" ||
    !row.id ||
    row.id === tableId ||
    row.type !== "table_row" ||
    row.has_children !== false ||
    row.archived === true ||
    row.in_trash === true ||
    !record(row.parent) ||
    Object.keys(row.parent).length !== 2 ||
    row.parent.type !== "block_id" ||
    row.parent.block_id !== tableId ||
    !record(row.table_row) ||
    !Array.isArray(row.table_row.cells) ||
    row.table_row.cells.length !== cells.length
  )
    return false
  let hasHtml = false
  for (const [column, cell] of cells.entries()) {
    if (!Array.isArray(cell.tokens)) return false
    const expected = sourceSpans(cell.tokens),
      actual = currentSpans(row.table_row.cells[column])
    if (
      !expected ||
      !actual ||
      expected.spans.length !== actual.length ||
      expected.spans.some((span, index) => {
        const observed = actual[index]!
        return (
          span.text !== observed.text ||
          span.url !== observed.url ||
          !sameStyle(span.style, observed.style)
        )
      })
    )
      return false
    hasHtml ||= expected.hasHtml
  }
  return hasHtml
}
