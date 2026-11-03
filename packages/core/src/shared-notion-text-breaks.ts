import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token, Tokens } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"

function unsupported(): never {
  throw fail(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    "The native text-break projection cannot preserve this complete Markdown shape.",
  )
}

/** Forward serialization of text blocks, not a comparison normalizer. Code
 * bytes and explicit link destinations must never be rewritten to fit a reply.
 */
function inline(raw: string, literalUnderscores = false): string {
  const parts = splitNativeInlineCode(raw)
  if (parts === undefined) return unsupported()
  if (parts.some((part) => part.code))
    return parts
      .map((part) => (part.code ? part.raw : inline(part.raw, literalUnderscores)))
      .join("")
  const tokens = SourceLexer.lexInline(raw)
  if (tokens.map((token) => token.raw).join("") !== raw) return unsupported()
  const output: string[] = []
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at]!
    // Native rich text places a link around its annotated label, rather than
    // a Markdown link inside a style tag. Keep the parsed destination exact.
    const style = token.type === "html" ? /^<(b|i|s)>$/u.exec(token.raw)?.[1] : undefined
    const link = tokens[at + 1]
    if (style && link?.type === "link" && tokens[at + 2]?.raw === `</${style}>`) {
      const opening = `[${link.text}](`
      if (!link.raw.startsWith(opening) || /[<>\n]/u.test(link.text)) return unsupported()
      const label = link.text.replace(/(?<!\\)_/gu, "\\_")
      output.push(`[<${style}>${label}</${style}>]` + link.raw.slice(opening.length - 1))
      at += 2
      continue
    }
    output.push(
      (() => {
        if (token.type === "br") return "<br />"
        if (token.type === "link") {
          if (
            token.autolink === true &&
            token.href === token.raw &&
            /^https?:\/\/[^\s<>]+$/u.test(token.raw)
          )
            return `[${token.raw}](${token.href})`
          if (token.raw.includes("\n")) return unsupported()
          return token.raw
        }
        if (token.type === "codespan" || token.type === "image") return token.raw
        // This forward policy changes only parsed literal text, never code,
        // native tag attributes, existing escapes or a link destination.
        if (literalUnderscores && token.type === "text")
          return token.raw.replace(/(?<!\\)_/gu, "\\_").replace(/\n/gu, "<br />")
        return token.raw.replace(/\n/gu, "<br />")
      })(),
    )
  }
  return output.join("")
}

function item(token: Tokens.ListItem, literalUnderscores = false): string {
  if (token.tokens.length !== 1 || !["paragraph", "text"].includes(token.tokens[0]!.type))
    return token.raw
  const text = token.text.replace(/\n+$/u, "")
  const content = text.split("\n")
  const lines = token.raw.split("\n")
  let firstPrefix = ""
  for (let at = 0; at < content.length; at++) {
    const line = lines[at]
    const value = content[at]!
    if (line === undefined || !line.endsWith(value)) return unsupported()
    const prefix = line.slice(0, line.length - value.length)
    if (
      !(at === 0
        ? /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/u.test(prefix)
        : /^[ \t]*$/u.test(prefix))
    )
      return unsupported()
    if (at === 0) firstPrefix = prefix
  }
  if (lines.slice(content.length).some((line) => line !== "")) return unsupported()
  return firstPrefix + inline(text, literalUnderscores) + (/\n*$/u.exec(token.raw)?.[0] ?? "")
}

function block(token: Token, literalUnderscores = false): string {
  if (token.type === "paragraph" || token.type === "text") {
    if (typeof token.text !== "string") return unsupported()
    const at = token.raw.indexOf(token.text)
    if (at < 0) return unsupported()
    return (
      token.raw.slice(0, at) +
      inline(token.text, literalUnderscores) +
      token.raw.slice(at + token.text.length)
    )
  }
  if (token.type === "list") {
    if (!Array.isArray(token.items)) return unsupported()
    if (token.items.map((entry: Tokens.ListItem) => entry.raw).join("") !== token.raw)
      return unsupported()
    return token.items.map((entry: Tokens.ListItem) => item(entry, literalUnderscores)).join("")
  }
  // Fenced code, native XML, headings, tables and nested quote structures keep
  // their previous policy bytes; an unproven transform still fails readback.
  return token.raw
}

export function projectNativeTextBreaks(
  markdown: string,
  options: { readonly literalUnderscores?: boolean } = {},
): string {
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return unsupported()
  return tokens.map((token) => block(token, options.literalUnderscores)).join("")
}
