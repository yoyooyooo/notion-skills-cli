import type { Token } from "marked"
import { SourceLexer } from "./source-lexer.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "./index.ts"

interface Part {
  readonly token: Token
  readonly start: number
  readonly end: number
}
interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

function positioned(markdown: string) {
  const result: Part[] = []
  let cursor = 0
  for (const token of SourceLexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, cursor),
      end = start + token.raw.length
    if (start < cursor || markdown.slice(cursor, start).trim()) return
    if (token.type !== "space" && token.type !== "def") result.push({ token, start, end })
    cursor = end
  }
  return markdown.slice(cursor).trim() ? undefined : result
}

// This grammar records every source annotation. Unsupported inline forms do
// not become plain text, and source/physical destinations remain byte exact.
function sourceSpans(
  tokens: readonly Token[],
  bold = false,
  link: string | null = null,
): NotionTextSpan[] | undefined {
  const result: NotionTextSpan[] = []
  for (const token of tokens) {
    if (
      token.type === "text" &&
      token.raw === token.text &&
      !/[\r\n\t\\*_~`<>\[\]]/.test(token.text)
    ) {
      if (token.text) result.push({ text: token.text, bold, code: false, link })
    } else if (token.type === "codespan" && token.text && !/[\r\n\t\\`]/.test(token.text)) {
      result.push({ text: token.text, bold, code: true, link })
    } else if (
      token.type === "strong" &&
      !bold &&
      token.tokens?.length &&
      token.raw === `**${token.text}**` &&
      token.tokens.map((part: Token) => part.raw).join("") === token.text
    ) {
      const nested = sourceSpans(token.tokens, true, link)
      if (!nested) return
      result.push(...nested)
    } else if (
      token.type === "link" &&
      link === null &&
      token.title == null &&
      token.tokens?.length &&
      typeof token.href === "string" &&
      token.href &&
      !/[\s\\()<>\[\]]/.test(token.href) &&
      token.raw === `[${token.text}](${token.href})` &&
      token.tokens.map((part: Token) => part.raw).join("") === token.text
    ) {
      const nested = sourceSpans(token.tokens, bold, token.href)
      if (!nested) return
      result.push(...nested)
    } else return
  }
  return result
}

function merged(spans: readonly NotionTextSpan[]) {
  const result: NotionTextSpan[] = []
  for (const span of spans) {
    if (
      !span ||
      Object.keys(span).sort().join(",") !== "bold,code,link,text" ||
      typeof span.text !== "string" ||
      !span.text ||
      typeof span.bold !== "boolean" ||
      typeof span.code !== "boolean" ||
      (span.link !== null && typeof span.link !== "string")
    )
      return
    const previous = result.at(-1)
    if (
      previous &&
      previous.bold === span.bold &&
      previous.code === span.code &&
      previous.link === span.link
    )
      result[result.length - 1] = { ...previous, text: previous.text + span.text }
    else result.push({ text: span.text, bold: span.bold, code: span.code, link: span.link })
  }
  return result
}

/** Exact finite inline proof for the source and readback sides of a list
 * boundary. Unlike the public comparison AST, bold remains significant. */
export function sameLiteralInlineSpans(
  markdown: string,
  spans: readonly NotionTextSpan[] | undefined,
) {
  if (!spans?.length || /[\r\n\t]/.test(markdown)) return false
  const tokens = SourceLexer.lexInline(markdown)
  if (tokens.map((token: Token) => token.raw).join("") !== markdown) return false
  const source = sourceSpans(tokens),
    physical = merged(spans)
  return (
    source !== undefined &&
    physical !== undefined &&
    JSON.stringify(merged(source)) === JSON.stringify(physical)
  )
}

function serialized(spans: readonly NotionTextSpan[], splitCodeLinks = false) {
  const result: string[] = []
  let bold = false
  const close = () => {
    if (bold) {
      result.push("**")
      bold = false
    }
  }
  for (const span of spans) {
    if (
      !span.text ||
      /[\r\n\t\\`]/.test(span.text) ||
      (!span.code && /[*_~<>\[\]]/.test(span.text)) ||
      (span.link !== null && (!span.link || /[\s\\()<>\[\]]/.test(span.link)))
    )
      return
    if (splitCodeLinks && span.bold && span.code && span.link !== null) {
      close()
      result.push(`[**\`${span.text}\`**](${span.link})`)
      continue
    }
    if (span.bold !== bold) {
      result.push("**")
      bold = span.bold
    }
    let text = span.code ? `\`${span.text}\`` : span.text
    if (span.link !== null) text = `[${text}](${span.link})`
    result.push(text)
  }
  close()
  return result.join("")
}

function heading(token: Token | undefined, root: NotionBlockBoundary | undefined) {
  if (
    token?.type !== "heading" ||
    !root ||
    root.type !== `heading_${token.depth}` ||
    root.has_children ||
    !root.rich_text?.length ||
    !Array.isArray(token.tokens) ||
    !token.tokens.every((part: Token) => part.type === "text" && part.raw === part.text)
  )
    return false
  return (
    root.rich_text.every((span) => !span.bold && !span.code && span.link === null) &&
    root.rich_text.map((span) => span.text).join("") === token.text &&
    (root.text === undefined || root.text === token.text)
  )
}

/** Decode only a complete source paragraph and Notion's per-span bold/code-link
 * serialization between the same two physical headings. Literal stars, links,
 * styles, code text, missing siblings and other paragraphs are never erased. */
export function boldCodeLinkReadbackEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
): Edit[] {
  if (markdown.includes("\r") || target.includes("\r")) return []
  const actual = positioned(markdown),
    source = positioned(target),
    result: Edit[] = []
  if (!actual || !source) return result
  for (let rootIndex = 1; rootIndex + 1 < roots.length; rootIndex++) {
    const root = roots[rootIndex]!,
      spans = root.rich_text
    if (
      root.type !== "paragraph" ||
      root.has_children ||
      !spans?.length ||
      !spans.some((span) => span.bold && span.code && span.link !== null) ||
      !spans.some((span) => span.bold && !span.code && span.link === null)
    )
      continue
    const retained = merged(spans)
    const readbacks = [serialized(spans), serialized(spans, true)].filter(
      (value): value is string => value !== undefined,
    )
    if (
      !retained ||
      !readbacks.length ||
      (root.text !== undefined && root.text !== spans.map((span) => span.text).join(""))
    )
      continue
    const candidates = source.flatMap((part, index) => {
      const token = part.token
      if (
        token.type !== "paragraph" ||
        /[\r\n]/.test(token.text) ||
        !/^\n*$/.test(token.raw.slice(token.text.length)) ||
        !token.raw.startsWith(token.text) ||
        !heading(source[index - 1]?.token, roots[rootIndex - 1]) ||
        !heading(source[index + 1]?.token, roots[rootIndex + 1])
      )
        return []
      const expected = token.tokens && sourceSpans(token.tokens)
      return expected && JSON.stringify(merged(expected)) === JSON.stringify(retained)
        ? [{ token, index }]
        : []
    })
    if (candidates.length !== 1) continue
    const original = candidates[0]!.token
    if (readbacks.every((readback) => readback === original.text)) continue
    const matches = actual.flatMap((part, index) =>
      part.token.type === "paragraph" &&
      readbacks.includes(part.token.text) &&
      part.token.raw.startsWith(part.token.text) &&
      /^\n*$/.test(part.token.raw.slice(part.token.text.length)) &&
      heading(actual[index - 1]?.token, roots[rootIndex - 1]) &&
      heading(actual[index + 1]?.token, roots[rootIndex + 1])
        ? [{ start: part.start, end: part.start + part.token.text.length, text: original.text }]
        : [],
    )
    if (matches.length === 1) result.push(matches[0]!)
  }
  return result
}
