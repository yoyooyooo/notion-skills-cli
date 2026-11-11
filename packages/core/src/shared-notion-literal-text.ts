import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"

function unsupported(): never {
  throw fail(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    "The native heading literal projection cannot preserve this complete Markdown shape.",
  )
}

function literalText(raw: string, tokens: readonly Token[]): string {
  let codeEnd = 0
  function project(value: string, children: readonly Token[], startAt: number): string {
    if (children.map((token) => token.raw).join("") !== value) return unsupported()
    let offset = startAt
    return children
      .map((token) => {
        const start = offset
        offset += token.raw.length
        if (offset <= codeEnd) return token.raw
        if (token.type === "html" && token.raw === "<code>") {
          const closing = raw.indexOf("</code>", offset)
          if (closing < 0) return unsupported()
          codeEnd = closing + "</code>".length
          return token.raw
        }
        if (token.type === "text") {
          const protectedLength = Math.max(0, codeEnd - start)
          return (
            token.raw.slice(0, protectedLength) +
            token.raw.slice(protectedLength).replace(/(?<!\\)[_[\]<~]/gu, "\\$&")
          )
        }
        // The lexer can interpret literal tildes across native closing tags as
        // one style token. Walk its source spans without changing its markers.
        if (token.type === "strong" || token.type === "em" || token.type === "del") {
          if (typeof token.text !== "string" || !Array.isArray(token.tokens)) return unsupported()
          const at = token.raw.indexOf(token.text)
          if (at < 0) return unsupported()
          return (
            token.raw.slice(0, at) +
            project(token.text, token.tokens, start + at) +
            token.raw.slice(at + token.text.length)
          )
        }
        if (start < codeEnd) return unsupported()
        // Keep resolved links intact: re-lexing just the heading text would
        // turn reference-style links into literal bracket/underscore text.
        return token.raw
      })
      .join("")
  }
  return project(raw, tokens, 0)
}

/** v11 extends the literal policy to parsed heading text. Original structure,
 * native code, tag attributes and complete link tokens remain byte-for-byte.
 * The preceding serializer still owns supported heading levels and wire bytes.
 */
export function projectNativeHeadingLiterals(markdown: string): string {
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return unsupported()
  return tokens
    .map((token) => {
      if (token.type !== "heading") return token.raw
      if (typeof token.text !== "string" || !Array.isArray(token.tokens)) return unsupported()
      if (token.text === "") return token.raw
      const at = token.raw.indexOf(token.text)
      if (at < 0) return unsupported()
      return (
        token.raw.slice(0, at) +
        literalText(token.text, token.tokens) +
        token.raw.slice(at + token.text.length)
      )
    })
    .join("")
}
