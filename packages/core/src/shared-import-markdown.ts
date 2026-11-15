import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"
import { maskImportTablePlus } from "./shared-import-table-literals.ts"

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
          const label = text.slice(labelStart).join("")
          link.automatic =
            token.type !== "image" &&
            // Native import also auto-links full URL labels in preserved
            // literal comment text. The label must identify the exact href;
            // authored destinations in the input remain required below.
            (token.href === label ||
              token.href.replace(/^https?:\/\//u, "").replace(/\/$/u, "") === label)
          break
        }
        case "html":
          if (
            !/^<\/?(?:b|strong|i|em|s|del|p|h[1-6]|table|tr|td|th|thead|tbody|br|ul|ol|li)(?:\s[^>]*)?\s*\/?>$/iu.test(
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
  assertMeaning(before, after)
}

function assertMeaning(
  before: ReturnType<typeof importContent>,
  after: ReturnType<typeof importContent>,
) {
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

/** Review-only diagnosis, not successful import acceptance. Recognize an
 * optional + → • change only at original ordinary table-text source positions;
 * all other text, code and authored destinations keep the exact existing check. */
export function assertImportedTablePlusRepairable(expected: string, actual: string): number {
  if (actual.includes("\uE000"))
    throw fail("SOURCE_PROJECTION_REPAIR_REQUIRED", "Reserved comparison marker in current body.")
  const masked = importContent(maskImportTablePlus(expected).markdown)
  const before = importContent(expected),
    after = importContent(actual)
  if (masked.text.length !== before.text.length || after.text.length !== before.text.length)
    throw fail(
      "SOURCE_PROJECTION_REPAIR_REQUIRED",
      "The current text has changes beyond original table plus literals.",
    )
  let changed = 0
  const normalized = Array.from({ length: after.text.length }, (_, at) => {
    if (masked.text[at] !== "\uE000") return after.text[at]!
    if (before.text[at] !== "+" || (after.text[at] !== "+" && after.text[at] !== "•"))
      throw fail(
        "SOURCE_PROJECTION_REPAIR_REQUIRED",
        "A reviewed table position is not the known original plus mutation.",
      )
    if (after.text[at] === "•") changed++
    return "+"
  }).join("")
  assertMeaning(before, { ...after, text: normalized })
  if (changed === 0)
    throw fail("SOURCE_PROJECTION_REPAIR_REQUIRED", "The complete body needs no table-plus repair.")
  return changed
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
