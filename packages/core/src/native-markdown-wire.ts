import type { Token, Tokens } from "marked"
import { SourceLexer } from "@notion-skills-cli/markdown"

// Notion Markdown v2 warns on an unknown tag and publication treats that
// warning as failure. These source forms are literal placeholders, so only
// the request body escapes them. The authored comparison target stays raw.
const literalPlaceholder = /^<(?:[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*|[A-Za-z])>$/

// Tags the native writer already uses as structure, plus ordinary HTML names.
// Escaping either would hide a real unsupported construct instead of leaving
// its warning intact. Closings use the same names, so a pair stays complete.
const structuralTag =
  /^<\/?(?:a|b|br|code|col|colgroup|div|em|h[1-6]|hr|i|img|input|li|mention-page|ol|p|page|pre|script|span|strong|style|table|tbody|td|tfoot|th|thead|tr|u|ul)\b/i

function literalPlaceholderTag(token: Token) {
  return (
    token.type === "html" &&
    token.block !== true &&
    literalPlaceholder.test(token.raw) &&
    !structuralTag.test(token.raw)
  )
}

type Emphasis = Pick<Tokens.Strong, "raw" | "text" | "tokens">
type Label = Pick<Tokens.Link, "raw" | "text" | "tokens">

function nestedMarker(token: Emphasis) {
  const width = (token.raw.length - token.text.length) / 2
  if (!Number.isInteger(width) || width < 1) return
  const marker = token.raw.slice(0, width)
  return token.raw === marker + token.text + marker ? marker : undefined
}

function escapeLabel(token: Label) {
  const nested = escapeTokens(token.tokens)
  if (nested === undefined || !token.raw.includes(token.text)) return token.raw
  const at = token.raw.indexOf(token.text)
  return token.raw.slice(0, at) + nested + token.raw.slice(at + token.text.length)
}

function escapeTokens(tokens: readonly Token[]): string | undefined {
  if (!tokens.length) return ""
  const parts: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    // A native page title is structural data, even when its tag is classified
    // inline after prose. Preserve the complete pair, including its filename.
    const page = token.type === "html" && /^<(page|mention-page)\b[^>]*>$/i.exec(token.raw)
    if (page) {
      const closing = `</${page[1]!.toLowerCase()}>`
      const end = tokens.findIndex(
        (candidate, at) =>
          at > index && candidate.type === "html" && candidate.raw.toLowerCase() === closing,
      )
      if (end >= 0) {
        parts.push(...tokens.slice(index, end + 1).map((candidate) => candidate.raw))
        index = end
        continue
      }
    }
    if (literalPlaceholderTag(token)) {
      parts.push(`\\${token.raw.slice(0, -1)}\\>`)
      continue
    }
    if (token.type === "em" || token.type === "strong" || token.type === "del") {
      if (typeof token.text !== "string" || !Array.isArray(token.tokens)) {
        parts.push(token.raw)
        continue
      }
      const emphasis: Emphasis = { raw: token.raw, text: token.text, tokens: token.tokens }
      const marker = nestedMarker(emphasis)
      const nested = marker ? escapeTokens(emphasis.tokens) : undefined
      parts.push(marker && nested !== undefined ? marker + nested + marker : token.raw)
      continue
    }
    if (token.type === "link" || token.type === "image") {
      if (typeof token.text !== "string" || !Array.isArray(token.tokens)) {
        parts.push(token.raw)
        continue
      }
      const label: Label = { raw: token.raw, text: token.text, tokens: token.tokens }
      if (label.tokens.some((child) => child.type !== "text")) parts.push(escapeLabel(label))
      else parts.push(token.raw)
      continue
    }
    if (token.type === "text" && token.raw === token.text) {
      parts.push(
        token.raw
          .replaceAll("$", "\\$")
          .replaceAll("+", "\\+")
          .replace(/\b([A-Za-z0-9_-]+)\.(md|markdown)\b/g, "$1\\.$2"),
      )
      continue
    }
    parts.push(token.raw)
  }
  return parts.join("")
}

/** Escape inline placeholder tags inside one already classified raw span.
 * Returns the original string when its inline tokens do not cover it. */
function escapeInline(raw: string) {
  const tokens = SourceLexer.lexInline(raw)
  if (tokens.map((token) => token.raw).join("") !== raw) return raw
  const text = escapeTokens(tokens)
  return text === undefined || text === raw ? raw : text
}

function containerTokens(token: Token): readonly Token[] | undefined {
  if (token.type === "blockquote" || token.type === "list_item") return token.tokens
  if (token.type === "list") return token.items
  return
}

/** Rebuild one quote, list, or list item from its classified children. A
 * reference definition stays raw. An incomplete child sequence returns the
 * original container instead of guessing its markers. */
function escapeContainer(token: Token, children: readonly Token[]) {
  let cursor = 0
  const parts: string[] = []
  for (const child of children) {
    const at = token.raw.indexOf(child.raw, cursor)
    if (at < 0) return token.raw
    parts.push(token.raw.slice(cursor, at), escapeBlock(child))
    cursor = at + child.raw.length
  }
  return parts.join("") + token.raw.slice(cursor)
}

function escapeBlock(token: Token): string {
  if (token.type === "code" || token.type === "html" || token.type === "def") return token.raw
  const children = containerTokens(token)
  return children ? escapeContainer(token, children) : escapeInline(token.raw)
}

/** Escape source-authored inline placeholder tags for one native Markdown
 * request. Code, links, destinations, definitions, structural tags, and block
 * HTML stay byte for byte; an untokenized span is also left unchanged. */
export function nativeMarkdownWire(markdown: string) {
  return SourceLexer.lex(markdown).map(escapeBlock).join("")
}
