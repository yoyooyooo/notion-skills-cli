import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"

function unsupported(): never {
  throw fail(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    "Native authoring policy 3 cannot preserve inline code containing a literal backtick without merging adjacent paragraphs. The complete input is retained; no write was dispatched.",
  )
}

function inline(tokens: readonly Token[]): void {
  const raw = tokens.map((token) => token.raw).join("")
  let offset = 0
  for (const token of tokens) {
    // Inspect the original span through its exact native closing tag: a
    // backtick can make the Markdown lexer consume that closing tag into a
    // later codespan. Retain the block's resolved link tokens, so hidden
    // reference identifiers and URL destinations never become author text.
    if (token.type === "html" && token.raw === "<code>") {
      const closing = raw.indexOf("</code>", offset + "<code>".length)
      if (closing >= 0 && raw.slice(offset + "<code>".length, closing).includes("`")) unsupported()
    }
    offset += token.raw.length
    if (token.type === "codespan" && token.text.includes("`")) unsupported()
    // Only visible inline children are authoring content. Link/image URLs,
    // titles, comments and escaped tags must not be parsed as code spans.
    if (token.type === "link" && token.autolink === true) continue
    if ("tokens" in token && Array.isArray(token.tokens)) inline(token.tokens)
  }
}

function blocks(tokens: readonly Token[]): void {
  for (const token of tokens) {
    if (token.type === "code") continue
    if (token.type === "list") {
      if (Array.isArray(token.items)) blocks(token.items)
    } else if (token.type === "list_item" || token.type === "blockquote") {
      if (Array.isArray(token.tokens)) blocks(token.tokens)
    } else if (token.type === "table") {
      if (Array.isArray(token.header)) for (const cell of token.header) inline(cell.tokens)
      if (Array.isArray(token.rows))
        for (const row of token.rows) for (const cell of row) inline(cell.tokens)
    } else if (token.type === "heading" || token.type === "paragraph" || token.type === "text") {
      if (Array.isArray(token.tokens)) inline(token.tokens)
      else if (typeof token.text === "string") inline(SourceLexer.lexInline(token.text))
    } else if (token.type === "html") inline(SourceLexer.lexInline(token.raw))
  }
}

/** Policy 3 rejects the observed paragraph-merging native inline shape before
 * planning. It leaves the input untouched and never changes literal fences,
 * retained v1/v2 plans, or their request/readback bytes. */
export function assertNotionInlineBoundary(markdown: string): void {
  blocks(SourceLexer.lex(markdown))
}
