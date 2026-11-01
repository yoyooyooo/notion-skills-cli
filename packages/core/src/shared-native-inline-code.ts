import { SourceLexer } from "@notion-skills-cli/markdown"

type NativeInlinePart = { readonly raw: string; readonly code: boolean }

/** Notion v2 code content is literal, including backticks. Marked can consume
 * a closing code tag into a later Markdown codespan even in its raw-block
 * state. After a genuine parsed opening tag, retain through its exact closing
 * tag and restart outside it; do not trust tokens lexed through its contents.
 * Escaped tags and tags inside Markdown code/link tokens are not openings. */
export function splitNativeInlineCode(raw: string): readonly NativeInlinePart[] | undefined {
  const parts: NativeInlinePart[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const rest = raw.slice(cursor)
    const tokens = SourceLexer.lexInline(rest)
    if (tokens.map((token) => token.raw).join("") !== rest) return undefined
    let offset = 0,
      opening: number | undefined
    for (const token of tokens) {
      if (token.type === "html" && token.raw === "<code>") {
        opening = cursor + offset
        break
      }
      offset += token.raw.length
    }
    if (opening === undefined) {
      parts.push({ raw: rest, code: false })
      break
    }
    const closing = raw.indexOf("</code>", opening + "<code>".length)
    if (closing < 0) return undefined
    if (opening > cursor) parts.push({ raw: raw.slice(cursor, opening), code: false })
    const end = closing + "</code>".length
    parts.push({ raw: raw.slice(opening, end), code: true })
    cursor = end
  }
  return parts
}
