import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"

/** Presentation may change at import. Keep text, code and explicit destinations
 * as separate checks rather than predicting Notion's Markdown serialization. */
function importContent(markdown: string) {
  const text: string[] = []
  const code: string[] = []
  const links: Array<{ href: string; automatic: boolean; authored: boolean }> = []
  const literal = (value: string, block = false) => {
    code.push(JSON.stringify([block, value.replace(/\r\n/g, "\n")]))
    text.push(value)
  }
  const inline = (raw: string, parsed?: readonly Token[]): void => {
    const parts = splitNativeInlineCode(raw)
    if (parts?.some((part) => part.code)) {
      for (const part of parts) part.code ? literal(part.raw.slice(6, -7)) : inline(part.raw)
      return
    }
    for (const token of parsed ?? SourceLexer.lexInline(raw)) {
      switch (token.type) {
        case "strong":
        case "em":
        case "del":
          inline(token.text, token.tokens)
          break
        case "codespan":
          literal(token.text)
          break
        case "link":
        case "image": {
          const labelStart = text.length
          const link = {
            href: token.href.replace(
              /^https:\/\/www\.notion\.so\/([a-f0-9]{32})$/u,
              "https://app.notion.com/p/$1",
            ),
            automatic: false,
            authored: token.type === "image" || /^[\[<]/u.test(token.raw),
          }
          links.push(link)
          inline(token.text, token.tokens)
          link.automatic =
            token.type !== "image" &&
            token.href.replace(/^https?:\/\//u, "").replace(/\/$/u, "") ===
              text.slice(labelStart).join("")
          break
        }
        case "html":
          if (
            !/^<\/?(?:b|strong|i|em|s|del|p|h[1-6]|table|tr|td|th|thead|tbody|br)(?:\s[^>]*)?\s*\/?>$/iu.test(
              token.raw,
            )
          )
            text.push(token.raw)
          break
        case "br":
          break
        default:
          text.push("text" in token && typeof token.text === "string" ? token.text : token.raw)
      }
    }
  }
  const blocks = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
        case "hr":
          break
        case "code":
          literal(token.text, true)
          break
        case "list":
          for (const item of token.items) blocks(item.tokens)
          break
        case "blockquote":
          blocks(token.tokens ?? SourceLexer.lex(token.text))
          break
        case "table":
          for (const row of [token.header, ...token.rows])
            for (const cell of row) inline(cell.text, cell.tokens)
          break
        case "paragraph":
        case "text":
        case "heading":
          inline(token.text, token.tokens)
          break
        default:
          inline(token.raw)
      }
    }
  }
  blocks(SourceLexer.lex(markdown))
  return { text: text.join("").replace(/\s+/gu, ""), code, links }
}

export function assertImportedMarkdownContent(expected: string, actual: string): void {
  const before = importContent(expected)
  const after = importContent(actual)
  const mismatch = (component: "text" | "code" | "links"): never => {
    throw fail(
      "SHARED_CREATE_BODY_MISMATCH",
      "The imported body changed text, code or an explicit destination; formatting differences alone are accepted.",
      { policy: "notion_import_readback_v1", component },
    )
  }
  for (const component of ["text", "code"] as const)
    if (JSON.stringify(before[component]) !== JSON.stringify(after[component])) mismatch(component)
  const required = before.links
    .filter((link) => link.authored || !link.automatic)
    .map((link) => link.href)
  const observed: string[] = []
  for (const link of after.links) {
    if (link.automatic && link.href !== required[observed.length]) continue
    observed.push(link.href)
  }
  if (JSON.stringify(required) !== JSON.stringify(observed)) mismatch("links")
}

export function compatibleImportMarkdown(markdown: string): string {
  const tokens = SourceLexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return markdown
  return tokens
    .map((token) => {
      if (token.type !== "heading") return token.raw
      const suffix = /\n*$/u.exec(token.raw)?.[0] ?? ""
      if (token.depth > 3) return `### ${token.text}${suffix}`
      if (token.depth === 1) return `<h1>${token.text}</h1>${suffix}`
      return token.raw
    })
    .join("")
}
