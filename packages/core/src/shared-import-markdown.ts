import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"
import { maskImportTablePlus } from "./shared-import-table-literals.ts"
import { referenceProse } from "./shared-file-references.ts"

/** Native v2 uses paired standalone quote tags for multi-paragraph quotes.
 * Only unambiguous flat containers are presentation. Mask code/comments and
 * require top-level HTML tokens so literal labels and destinations stay intact. */
function nativeQuoteBlocks(markdown: string): string {
  if (!markdown.includes("<quote>") || !markdown.includes("</quote>")) return markdown
  const visible = referenceProse(markdown, 2, true)
  const tokens = SourceLexer.lexInline(visible)
  if (tokens.map((token) => token.raw).join("") !== visible) return markdown
  const starts = new Map<number, number>()
  const lines = visible.split("\n")
  let position = 0
  for (const [line, text] of lines.entries()) {
    starts.set(position, line)
    position += text.length + 1
  }
  const pairs = new Map<number, "open" | "close">()
  let depth = 0,
    opening = 0,
    nested = false
  position = 0
  for (const token of tokens) {
    const line = starts.get(position)
    if (
      token.type === "html" &&
      (token.raw === "<quote>" || token.raw === "</quote>") &&
      line !== undefined &&
      /^<\/?quote>[ \t]*$/u.test(lines[line]!)
    ) {
      if (token.raw === "<quote>") {
        if (depth === 0) {
          opening = line
          nested = false
        } else nested = true
        depth += 1
      } else if (depth > 0 && --depth === 0 && !nested) {
        pairs.set(opening, "open")
        pairs.set(line, "close")
      }
    }
    position += token.raw.length
  }
  if (pairs.size === 0) return markdown
  let quoted = false
  return markdown
    .split("\n")
    .map((line, index) => {
      const marker = pairs.get(index)
      if (marker !== undefined) {
        quoted = marker === "open"
        return quoted ? ">" : ""
      }
      return quoted ? `> ${line}` : line
    })
    .join("\n")
}

const literalCustomTag = /^<\/?[a-z][a-z0-9]*(?:-[a-z0-9]+)+\s*\/?>$/iu
function literalCustomTagBlock(raw: string): string | undefined {
  const tokens = SourceLexer.lexInline(raw)
  if (
    tokens[0]?.type !== "html" ||
    !literalCustomTag.test(tokens[0].raw) ||
    tokens.map((token) => token.raw).join("") !== raw
  )
    return undefined
  // These attribute-free custom tags are visible instruction labels. Native
  // import escapes them and parses their contents as Markdown. Re-lex that
  // same literal form; code tokens, standard HTML and attributes stay intact.
  return tokens
    .map((token) =>
      token.type === "html" && literalCustomTag.test(token.raw) ? `\\${token.raw}` : token.raw,
    )
    .join("")
}

/** Presentation may change at import. Keep text, code and explicit destinations
 * as separate checks rather than predicting Notion's Markdown serialization. */
function importContent(markdown: string) {
  const text: string[] = []
  const code: string[] = []
  const links: Array<{
    href: string
    automatic: boolean
    authored: boolean
    start: number
    end: number
  }> = []
  let textOffset = 0
  const visible = (value: string) => {
    text.push(value)
    textOffset += value.replace(/\s+/gu, "").length
  }
  const literal = (value: string, block = false) => {
    code.push(JSON.stringify([block, value.replace(/\r\n/g, "\n")]))
    visible(value)
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
            start: textOffset,
            end: textOffset,
          }
          links.push(link)
          inline(token.text, token.tokens)
          const label = text.slice(labelStart).join("")
          link.end = textOffset
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
            ) &&
            // Native reading pages can flatten class-only layout wrappers.
            // Preserve other attributes as semantic text; code tokens never
            // enter this branch and retained source bytes are unchanged.
            !/^(?:<(?:div|span)(?:\s+class=(?:"[^"<>\r\n]*"|'[^'<>\r\n]*'))?\s*>|<\/(?:div|span)\s*>)$/iu.test(
              token.raw,
            )
          )
            visible(token.raw)
          break
        case "br":
          break
        default:
          visible("text" in token && typeof token.text === "string" ? token.text : token.raw)
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
        case "html": {
          const literal = literalCustomTagBlock(token.raw)
          if (literal === undefined) inline(token.raw)
          else blocks(SourceLexer.lex(literal))
          break
        }
        default:
          inline(token.raw)
      }
    }
  }
  blocks(SourceLexer.lex(nativeQuoteBlocks(markdown)))
  return { text: text.join("").replace(/\s+/gu, ""), code, links }
}

export function assertImportedMarkdownContent(expected: string, actual: string): void {
  const before = importContent(expected)
  const after = importContent(actual)
  assertMeaning(before, after)
}

/** Review-only evidence for a local destination that native import treated as a
 * hostname. Only the original authored occurrence may use that exact spelling;
 * this is never successful import acceptance and never authorizes an external
 * destination, changed label, code or an added link. */
export function assertImportedLocalLinksRepairable(
  expected: string,
  actual: string,
  localHrefs: readonly string[],
): number {
  const before = importContent(expected),
    after = importContent(actual)
  const allowed = new Set(
    localHrefs.filter((href) => /^[^./?#:][^/?#:]*\.(?:md|markdown)(?:[?#].*)?$/iu.test(href)),
  )
  const required = before.links.filter((link) => link.authored || !link.automatic)
  let changed = 0
  const links = after.links.map((link) => {
    const original = required.find(
      (candidate) => candidate.start === link.start && candidate.end === link.end,
    )
    if (
      original !== undefined &&
      allowed.has(original.href) &&
      link.href === `https://${original.href}`
    ) {
      changed++
      return { ...link, href: original.href }
    }
    return link
  })
  assertMeaning(before, { ...after, links })
  return changed
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
  const required = before.links.filter((link) => link.authored || !link.automatic)
  let matched = 0
  for (const link of after.links) {
    const original = required[matched]
    if (original !== undefined && link.start === original.start && link.end === original.end) {
      if (link.href !== original.href) mismatch("links")
      matched++
    } else if (!link.automatic) mismatch("links")
  }
  if (matched !== required.length) mismatch("links")
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

/** Review-only repair proposal for the observed native table/list-code defect.
 * This never changes successful import equivalence or trims arbitrary code. */
export function deriveImportedTableCodePaddingRepair(expected: string, actual: string) {
  const tokens = SourceLexer.lex(actual)
  if (tokens.map((token) => token.raw).join("") !== actual)
    throw fail(
      "SOURCE_FILE_REPAIR_UNSUPPORTED",
      "The complete native Markdown cannot be located without rewriting other content.",
    )
  let changes = 0
  const markdown = tokens
    .map((token) =>
      token.type !== "table"
        ? token.raw
        : token.raw
            .split("\n")
            .map((line) => {
              const parts = splitNativeInlineCode(line)
              if (parts === undefined)
                throw fail(
                  "SOURCE_FILE_REPAIR_UNSUPPORTED",
                  "A native table has ambiguous code boundaries.",
                )
              return parts
                .map((part) => {
                  if (!part.code || part.raw !== "<code>  • </code>") return part.raw
                  changes++
                  return "<code>•</code>"
                })
                .join("")
            })
            .join("\n"),
    )
    .join("")
  if (changes !== 1)
    throw fail(
      "SOURCE_FILE_REPAIR_UNSUPPORTED",
      "Select exactly one known padded table code marker; general code whitespace is not repair authority.",
    )
  assertImportedMarkdownContent(expected, markdown)
  return { markdown, before_code: "  • " as const, after_code: "•" as const, changes: 1 as const }
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
