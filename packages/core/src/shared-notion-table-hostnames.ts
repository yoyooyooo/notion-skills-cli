import { SourceLexer } from "@notion-skills-cli/markdown"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"

function unsupported(): never {
  throw fail(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    "The complete native table hostname presentation cannot be projected without changing other source spans.",
  )
}
function inline(text: string): string {
  const parts = splitNativeInlineCode(text)
  if (parts === undefined) return unsupported()
  if (parts.some((part) => part.code))
    return parts.map((part) => (part.code ? part.raw : inline(part.raw))).join("")
  const tokens = SourceLexer.lexInline(text)
  if (tokens.map((token) => token.raw).join("") !== text) return unsupported()
  let nativeDepth = 0
  return tokens
    .map((token) => {
      if (token.type === "html") {
        if (/^<\//u.test(token.raw)) nativeDepth = Math.max(0, nativeDepth - 1)
        else if (/^<[A-Za-z]/u.test(token.raw) && !/\/>$/u.test(token.raw)) nativeDepth++
        return token.raw
      }
      return token.type === "text" && nativeDepth === 0
        ? token.raw.replace(
            /(?<![\w.\/@:\\-])localhost(?![\w.\/@:-])/gu,
            "[localhost](http://localhost)",
          )
        : token.raw
    })
    .join("")
}

/** Forward-only v15 policy for one observed native table-cell serialization.
 * Existing links, code, attributes, other hostname shapes and old policies are
 * unchanged. The original wire and full exact postcondition remain authoritative. */
export function projectNativeTableHostnames(markdown: string): string {
  if (!markdown.includes("localhost")) return markdown
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return unsupported()
  return tokens
    .map((token) => {
      if (token.type !== "table" || !token.raw.includes("localhost")) return token.raw
      const lines = token.raw.split("\n")
      for (const [index, row] of [token.header, ...token.rows].entries()) {
        const lineIndex = index === 0 ? 0 : index + 1,
          line = lines[lineIndex]
        if (line === undefined) return unsupported()
        let cursor = 0,
          output = ""
        for (const cell of row) {
          const at = line.indexOf(cell.text, cursor)
          if (at < cursor) return unsupported()
          output += line.slice(cursor, at) + inline(cell.text)
          cursor = at + cell.text.length
        }
        lines[lineIndex] = output + line.slice(cursor)
      }
      return lines.join("\n")
    })
    .join("")
}
