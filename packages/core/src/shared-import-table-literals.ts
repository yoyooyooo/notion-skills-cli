import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"

function unsupported(): never {
  throw fail(
    "SHARED_IMPORT_TABLE_LITERAL_UNSUPPORTED",
    "Cannot identify the complete original table text without rewriting other Markdown.",
  )
}

/** Work only on exact source spans in parsed top-level tables. Inline code,
 * authored links/images, HTML and non-table blocks retain their original bytes. */
function mapTablePlus(markdown: string, replacement: "\\+" | "<b>+</b>" | "•" | "\uE000") {
  let changed = 0
  const inline = (raw: string, supplied?: readonly Token[]): string => {
    const parts = splitNativeInlineCode(raw)
    if (parts?.some((part) => part.code))
      return parts.map((part) => (part.code ? part.raw : inline(part.raw))).join("")
    const tokens = supplied ?? SourceLexer.lexInline(raw)
    if (tokens.map((token) => token.raw).join("") !== raw) return unsupported()
    return tokens
      .map((token) => {
        if (token.type === "strong" || token.type === "em" || token.type === "del") {
          const at = token.raw.indexOf(token.text)
          if (at < 0) return unsupported()
          return (
            token.raw.slice(0, at) +
            inline(token.text, token.tokens) +
            token.raw.slice(at + token.text.length)
          )
        }
        if (token.type !== "text") return token.raw
        return token.raw.replace(/\+/gu, () => {
          changed++
          return replacement
        })
      })
      .join("")
  }
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return unsupported()
  const output = tokens
    .map((token) =>
      token.type !== "table"
        ? token.raw
        : token.raw
            .split("\n")
            .map((line) => inline(line))
            .join("\n"),
    )
    .join("")
  return { markdown: output, changed }
}

/** New opt-in import wire; this never changes old retained policies. */
export const escapeImportTablePlus = (markdown: string) => mapTablePlus(markdown, "\\+")

/** Explicit v17 wire: a presentation-only span prevents native table list
 * interpretation. The v16 escape candidate remains frozen for old reviews. */
export const protectImportTablePlus = (markdown: string) => mapTablePlus(markdown, "<b>+</b>")

/** Recognize the observed old provider corruption for a constrained repair.
 * Never use this representation to accept a successful original import. */
export const knownImportTablePlusReadback = (markdown: string) => mapTablePlus(markdown, "•")

/** Single-code-point source marker for the independent repair comparison.
 * It is not emitted to Notion and cannot occur in the reviewed original. */
export function maskImportTablePlus(markdown: string) {
  if (markdown.includes("\uE000")) return unsupported()
  return mapTablePlus(markdown, "\uE000")
}
