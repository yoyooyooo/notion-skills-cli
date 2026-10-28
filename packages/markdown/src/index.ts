import { physicalSpanReadbackEdits } from "./physical-span-readback.ts"
import {
  planZeroStartPresentation,
  zeroStartPresentationCandidate,
  zeroStartParagraphReadbackCandidate,
} from "./zero-start.ts"
import { commentReadbackEdits } from "./comment-readback.ts"
import { codeFenceCandidate } from "./code-fence-readback.ts"
import { literalSingleTildeEdits } from "./literal-single-tilde-readback.ts"
import { literalHtmlBoundaryEdits, literalHtmlReadbackEdits } from "./literal-html-readback.ts"
import { paragraphDividerCandidate } from "./paragraph-divider-readback.ts"

import { type Token, type Tokens } from "marked"
import { SourceLexer as Lexer } from "./source-lexer.ts"
export { SourceLexer } from "./source-lexer.ts"
import { physicalTableLiteralEdits } from "./table-literal-readback.ts"
import { nestedParagraphBoundaries, richQuoteBoundaries } from "./sibling-boundaries.ts"
import { physicalReadbackCandidate } from "./physical-readback.ts"

const codeLanguages: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  md: "markdown",
  jsonc: "json",
  "plain text": "text",
  "": "text",
}

export function codeLanguage(language: string | undefined) {
  const value = language?.trim().toLowerCase() ?? ""
  return codeLanguages[value] ?? value
}

// v1 readback separates blocks with a single newline, which is not CommonMark.
// Keep code/table contents literal while restoring boundaries for local consumers.
export function fromNotionMarkdown(markdown: string, blocks?: readonly NotionBlockBoundary[]) {
  const output: string[] = []
  const lines = liftListFences(markdown.replace(/\r\n/g, "\n").split("\n"))
  let fence: { marker: string; length: number } | undefined
  let table = false
  let list = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    // A boundary is inserted only when the following line is content. Repeating
    // this on its own output must not accumulate blank lines.
    const separate = () => {
      if (lines[index + 1]?.trim()) output.push("")
    }
    if (fence) {
      output.push(line)
      const close = /^ *(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) {
        fence = undefined
        separate()
      }
      continue
    }
    if (table) {
      output.push(notionInlineSource(line))
      if (/^\s*<\/table>\s*$/.test(line)) {
        table = false
        separate()
      }
      continue
    }
    const open = (list ? /^ *(`{3,}|~{3,})/ : /^ {0,3}(`{3,}|~{3,})/).exec(line)
    const item = /^(?:[-+*]|\d+[.)])\s/.test(line)
    const continuedFence = Boolean(open) && list && /^ +\S/.test(line)
    if (
      (open && !continuedFence) ||
      /^<table\b/.test(line) ||
      (list && line && !item && !/^\s/.test(line))
    ) {
      if (output.at(-1)) output.push("")
      list = false
    }
    if (open) fence = { marker: open[1]![0]!, length: open[1]!.length }
    if (/^<table\b/.test(line)) table = true
    if (item) list = true
    output.push(open ? line : notionInlineSource(line))
  }
  const normalized = output.join("\n")
  const bounded = blocks ? restoreQuoteBoundaries(normalized, blocks) : normalized
  const authored = authoredNotionMarkdown(bounded, blocks)
  if (!blocks) return authored
  const quoted = richQuoteBoundaries(authored, blocks, markdownStructure) ?? authored
  return nestedParagraphBoundaries(quoted, blocks, markdownStructure) ?? quoted
}
// Notion indents a quote's list with tabs and omits the blank line after a rule.
function authoredNotionMarkdown(markdown: string, blocks?: readonly NotionBlockBoundary[]) {
  const lines = markdown.split("\n")
  const out: string[] = []
  let fence: { marker: string; length: number } | undefined
  let quote = false
  let lifted = false
  const rules = lines.filter((line) => /^ {0,3}(?:---|\*\*\*|___)\s*$/.test(line)).length
  const separateRules =
    (blocks?.filter((block) => block.type === "divider").length ?? 0) > 0 &&
    blocks!.filter((block) => block.type === "divider").length === rules
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      out.push(line)
      if (
        marker &&
        marker[1]![0] === fence.marker &&
        marker[1]!.length >= fence.length &&
        /^[ \t]*$/.test(line.slice(marker[0].length))
      )
        fence = undefined
      continue
    }
    if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }
      quote = false
      out.push(line)
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      quote = true
      out.push(line)
      continue
    }
    if (quote && /^\t+(?:[-+*]|\d+[.)])\s+/.test(line)) {
      lifted = true
      out.push(`> ${line.replace(/^\t+/, "")}`)
      continue
    }
    if (lifted && line.trim()) out.push("")
    lifted = false
    quote = false
    if (separateRules && /^ {0,3}(?:---|\*\*\*|___)\s*$/.test(line) && out.at(-1)?.trim())
      out.push("")
    out.push(line)
    if (/^ {0,3}(?:---|\*\*\*|___)\s*$/.test(line) && lines[index + 1]?.trim()) out.push("")
  }
  return out.join("\n")
}
function liftListFences(lines: readonly string[]) {
  const out: string[] = []
  // Each entry is the CommonMark content indentation for one Notion tab level.
  // Keep the context across every paragraph and fence within the same item.
  const items: string[] = []
  let literalFence: { marker: string; length: number } | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (literalFence) {
      out.push(line)
      if (
        fence &&
        fence[1]![0] === literalFence.marker &&
        fence[1]!.length >= literalFence.length &&
        !fence[2]!.trim()
      )
        literalFence = undefined
      continue
    }
    const item = /^(\t*)([-+*]|\d+[.)])([ \t]+)(.*)$/.exec(line)
    if (item) {
      const level = item[1]!.length
      const parent = level === 0 ? "" : items[level - 1]
      if (parent !== undefined) {
        items.length = level
        const prefix = `${parent}${item[2]}${item[3]}`
        items.push(" ".repeat(prefix.length))
        out.push(`${prefix}${item[4]}`)
      } else out.push(line)
      continue
    }
    const tabs = /^\t+/.exec(line)?.[0]
    const indent = tabs ? items[tabs.length - 1] : undefined
    if (tabs && indent !== undefined && fence) {
      const marker = fence[1]!
      let close = -1
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const candidate = lines[cursor]!
        const boundary = /^(\t*)(?:[-+*]|\d+[.)])\s/.exec(candidate)
        // A missing close cannot consume the next item's code. Ambiguous
        // unindented list examples inside such a fence are left unmodified.
        if (boundary && boundary[1]!.length < tabs.length) break
        const end = /^(\t+)(`{3,}|~{3,})[ \t]*$/.exec(candidate)
        if (end && end[1] === tabs && end[2]![0] === marker[0] && end[2]!.length >= marker.length) {
          close = cursor
          break
        }
      }
      if (close >= 0) {
        out.push(`${indent}${marker}${fence[2]}`)
        // Only the fence carries Notion's container tabs. Every byte of code
        // indentation is content, including leading tabs and blank lines.
        for (let cursor = index + 1; cursor < close; cursor++) out.push(`${indent}${lines[cursor]}`)
        out.push(`${indent}${lines[close]!.slice(tabs.length)}`)
        index = close
        continue
      }
    }
    if (fence) {
      literalFence = { marker: fence[1]![0]!, length: fence[1]!.length }
      out.push(line)
      continue
    }
    if (tabs && indent !== undefined) out.push(`${indent}${line.slice(tabs.length)}`)
    else {
      if (line.trim() && !/^\s/.test(line)) items.length = 0
      out.push(line)
    }
  }
  return out
}

// Notion splits rich-text emphasis at inline-code boundaries and emits tables as HTML.
function inlineSource(text: string) {
  let output = ""
  let index = 0
  while (index < text.length) {
    if (text[index] !== "`") {
      const start = index
      while (index < text.length && text[index] !== "`") index++
      output += text.slice(start, index).replace(/\*{4}/g, "")
      continue
    }
    let length = 0
    while (index + length < text.length && text[index + length] === "`") length++
    let cursor = index + length
    let close = -1
    while (cursor < text.length) {
      if (text[cursor] !== "`") {
        cursor++
        continue
      }
      let run = 0
      while (cursor + run < text.length && text[cursor + run] === "`") run++
      if (run === length) {
        close = cursor
        break
      }
      cursor += run
    }
    if (close < 0) {
      output += text.slice(index, index + length)
      index += length
      continue
    }
    output += text.slice(index, close + length)
    index = close + length
  }
  return output
}

function notionInlineSource(text: string) {
  const source = inlineSource(text)
  const candidate = Lexer.lexInline(source)
    .map((token) => {
      const child =
        token.type === "strong" && token.tokens?.length === 1 ? token.tokens[0] : undefined
      return child?.type === "codespan" && token.raw === `**${child.raw}**` ? child.raw : token.raw
    })
    .join("")
  if (candidate === source) return source
  // Notion wraps italic code in ** inside an italic paragraph. Marked can
  // leave the paragraph's outer * literal. Repair only when removing the
  // recognized code wrappers recovers one complete emphasis span.
  const repaired = Lexer.lexInline(candidate)
  return repaired.length === 1 && repaired[0]!.type === "em" && repaired[0]!.raw === candidate
    ? candidate
    : source
}

// Notion splits bold at inline-code edges and writes the break back as ****.
// Fenced lines and inline code stay literal, including a run of four asterisks.
export function stripNotionInlineBoundaries(markdown: string) {
  let fence: { marker: string; length: number } | undefined
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence.marker &&
          marker[1]!.length >= fence.length &&
          /^[ \t]*$/.test(line.slice(marker[0].length))
        )
          fence = undefined
        return line
      }
      if (marker) {
        fence = { marker: marker[1]![0]!, length: marker[1]!.length }
        return line
      }
      return inlineSource(line)
    })
    .join("\n")
}

function inlineText(values: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const value of values) {
    if (typeof value === "string" && typeof result.at(-1) === "string")
      result[result.length - 1] = (String(result.at(-1)) + value).replace(/\s+/g, " ")
    else result.push(value)
  }
  return result
}

// Publication compare must not treat an escaped asterisk as an unparsed bold marker.
function inline(text: string, tokens?: readonly Token[], markEscapes = false): unknown[] {
  const result: unknown[] = []
  const push = (value: unknown) => {
    if (typeof value === "string" && typeof result.at(-1) === "string")
      result[result.length - 1] = (String(result.at(-1)) + value).replace(/\s+/g, " ")
    else result.push(value)
  }
  for (const token of tokens ?? Lexer.lexInline(inlineSource(text))) {
    switch (token.type) {
      case "strong":
      case "em":
        for (const value of inline(token.text, token.tokens, markEscapes)) push(value)
        break
      case "text":
        push(token.text.replace(/\s+/g, " "))
        break
      case "escape":
        push(
          markEscapes && token.text === "*"
            ? ["literal", token.text]
            : token.text.replace(/\s+/g, " "),
        )
        break
      case "codespan":
        push(["code", token.text])
        break
      case "link":
      case "image":
        push([
          token.type,
          token.href,
          token.title ?? null,
          inline(token.text, token.tokens, markEscapes),
        ])
        break
      case "del":
        push(["del", inline(token.text, undefined, markEscapes)])
        break
      case "br":
        push(" ")
        break
      case "html":
        if (/^<br[ \t]*\/?>$/i.test(token.raw)) push(" ")
        else push([token.type, token.raw])
        break
      default:
        push([token.type, token.raw])
    }
  }
  return result
}

export interface NotionBlockNode {
  readonly id: string
  readonly type: string
  readonly has_children: boolean
  readonly text?: string
  readonly rich_text?: readonly NotionTextSpan[]
  readonly code?: { readonly text: string; readonly language: string }
  readonly numbered_list?: { readonly start: number | null }
  readonly to_do?: { readonly checked: boolean }
}

export interface NotionBlockBoundary extends NotionBlockNode {
  // Present only after a complete, ordered walk of this root's own list subtree.
  readonly descendants?: readonly (NotionBlockNode & { readonly parent_id: string })[]
  // Separate from the ordinary-list grammar: complete supported quote children,
  // including table shape and every ordered cell, retain their physical owners.
  readonly quote_descendants?: readonly NotionQuoteNode[]
  // One direct table under an ordinary list root, independent of the existing
  // paragraph/list descendant grammar.
  readonly list_table_descendants?: readonly NotionQuoteNode[]
  // A complete root table with strictly supported cell text. Every row keeps
  // its physical identity and direct parent; unsupported cells omit this proof.
  readonly table_evidence?: {
    readonly width: number
    readonly header_row: boolean
    readonly header_column: boolean
    readonly rows: readonly NotionQuoteNode[]
  }
}

export interface NotionQuoteNode extends NotionBlockNode {
  readonly parent_id: string
  readonly table?: {
    readonly width: number
    readonly header_row: boolean
    readonly header_column: boolean
  }
  readonly table_row?: { readonly cells: readonly (readonly NotionTextSpan[])[] }
}

export interface NotionTextSpan {
  readonly text: string
  readonly link: string | null
  readonly bold: boolean
  readonly code: boolean
}

const boundaryTextTypes: Record<string, true> = {
  quote: true,
  paragraph: true,
  bulleted_list_item: true,
  numbered_list_item: true,
}

function visibleInline(content: readonly unknown[]): string {
  return content
    .map((value): string => {
      if (typeof value === "string") return value
      if (!Array.isArray(value)) return ""
      if (value[0] === "link" || value[0] === "image") return visibleInline(value[3])
      if (value[0] === "del") return visibleInline(value[1])
      return typeof value[1] === "string" ? value[1] : ""
    })
    .join("")
}

// Only authenticated sibling blocks can disambiguate CommonMark lazy continuation.
// Callers supply the complete ordered root inventory; unsupported roots remain sentinels.
function restoreQuoteBoundaries(markdown: string, blocks: readonly NotionBlockBoundary[]) {
  if (
    !blocks.some((block, index) => {
      const next = blocks[index + 1]
      return (
        block.type === "quote" &&
        next !== undefined &&
        (next.type === "paragraph" ||
          next.type === "bulleted_list_item" ||
          next.type === "numbered_list_item")
      )
    })
  )
    return markdown
  const ids = new Set<string>()
  for (const block of blocks) {
    if (!block.id || ids.has(block.id)) return markdown
    ids.add(block.id)
  }
  const lines = markdown.split("\n")
  const parsed = lines.map((line) => {
    const quote = /^ {0,3}>[ \t]?/.exec(line)
    const list = /^ {0,3}(?:([-+*])|\d+[.)])[ \t]+/.exec(line)
    const prefix = quote ?? list
    const content = inline(prefix ? line.slice(prefix[0].length) : line)
    return {
      type: quote
        ? "quote"
        : list
          ? list[1]
            ? "bulleted_list_item"
            : "numbered_list_item"
          : "paragraph",
      text: visibleInline(content),
      source: prefix ? line.slice(prefix[0].length) : line,
    }
  })
  const candidates: { type: string; text: string; start: number; end: number }[] = []
  for (let index = 0; index < parsed.length; index++) {
    const line = parsed[index]!
    const start = index
    const content = [line.source]
    if (line.type === "quote") {
      while (parsed[index + 1]?.type === "quote") content.push(parsed[++index]!.source)
    }
    candidates.push({
      type: line.type,
      text: visibleInline(inline(content.join("\n"))).replace(/\s+/g, " "),
      start,
      end: index,
    })
  }
  const locate = (block: NotionBlockBoundary) => {
    if (typeof block.text !== "string" || !block.text.trim() || block.has_children) return []
    const text = block.text.replace(/\s+/g, " ")
    const matches = candidates.filter((line) => line.text === text)
    if (block.type === "paragraph") {
      for (let start = 0; start < parsed.length; start++) {
        if (parsed[start]!.type !== "paragraph" || !lines[start]!.trim()) continue
        const content = [parsed[start]!.source]
        for (let end = start + 1; end < parsed.length; end++) {
          if (parsed[end]!.type !== "paragraph" || !lines[end]!.trim()) break
          content.push(parsed[end]!.source)
          const source = content.join("\n")
          const tokens = Lexer.lex(source).filter((token) => token.type !== "space")
          if (tokens.length !== 1 || tokens[0]!.type !== "paragraph") break
          const visible = visibleInline(inline(source)).replace(/\s+/g, " ")
          if (visible === text) matches.push({ type: block.type, text, start, end })
          if (visible.length >= text.length) break
        }
      }
    }
    return matches
  }
  const quotes = new Set<number>()
  let offset = 0
  for (const token of Lexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, offset)
    if (start < 0 || markdown.slice(offset, start).trim()) return markdown
    if (token.type === "blockquote") quotes.add(markdown.slice(0, start).split("\n").length - 1)
    offset = start + token.raw.length
  }
  const mapped = new Map<NotionBlockBoundary, { start: number; end: number }>()
  const matches = new Map(
    blocks
      .filter((block) => Object.hasOwn(boundaryTextTypes, block.type))
      .map((block) => [block, locate(block)]),
  )
  for (const block of blocks) {
    if (!Object.hasOwn(boundaryTextTypes, block.type) || block.text === undefined) continue
    const found = matches.get(block)!
    if (found.length !== 1) continue
    const match = found[0]!
    if (match.type !== block.type) return markdown
    mapped.set(block, match)
  }
  for (let index = 0; index + 2 < blocks.length; index++) {
    const quote = blocks[index]!
    const paragraph = blocks[index + 1]!
    const following = blocks[index + 2]!
    if (quote.type !== "quote" || paragraph.type !== "paragraph" || following.type !== "quote")
      continue
    if (mapped.has(quote) && mapped.has(paragraph)) continue
    const followingLine = mapped.get(following)
    if (!followingLine) continue
    // Exact adjacent siblings may disambiguate a repeated notice. The following
    // explicit quote proves its end without borrowing text from another root.
    const pairs = matches
      .get(quote)!
      .filter((line) => line.type === "quote")
      .flatMap((quoteLine) =>
        matches
          .get(paragraph)!
          .filter((line) => line.type === "paragraph" && line.start === quoteLine.end + 1)
          .map((paragraphLine) => ({ quoteLine, paragraphLine })),
      )
    if (pairs.length !== 1) continue
    const { quoteLine, paragraphLine } = pairs[0]!
    if (followingLine.start !== paragraphLine.end + 1) continue
    mapped.set(quote, quoteLine)
    mapped.set(paragraph, paragraphLine)
  }
  let lastRootEnd = -1
  for (const block of blocks) {
    const match = mapped.get(block)
    if (!match) continue
    if (match.start <= lastRootEnd) return markdown
    lastRootEnd = match.end
  }
  const boundaries: number[] = []
  let previous = -1
  for (let index = 0; index + 1 < blocks.length; index++) {
    const quote = blocks[index]!
    const next = blocks[index + 1]!
    if (quote.type !== "quote") continue
    if (!["paragraph", "bulleted_list_item", "numbered_list_item"].includes(next.type)) continue
    const quoteLine = mapped.get(quote)
    const nextLine = mapped.get(next)
    // An unprovable pair cannot invalidate another independently mapped boundary.
    if (!quoteLine || !nextLine) continue
    if (
      quoteLine.start <= previous ||
      nextLine.start <= quoteLine.end ||
      !quotes.has(quoteLine.start)
    )
      return markdown
    // Only explicit contiguous quote lines can authorize the end of a quote.
    if (nextLine.start === quoteLine.end + 1) boundaries.push(nextLine.start)
    else if (lines.slice(quoteLine.end + 1, nextLine.start).some((line) => line.trim()))
      return markdown
    previous = nextLine.end
  }
  for (const boundary of boundaries.reverse()) lines.splice(boundary, 0, "")
  return lines.join("\n")
}

function tableRows(text: string) {
  if (!/^<table(?: header-row="true")?>\s*\n/.test(text.trim())) return undefined
  const rows: string[][] = []
  const content = text.trim().replace(/^<table[^>]*>\s*|\s*<\/table>$/g, "")
  let rest = content
  for (const row of content.matchAll(/<tr>\s*([\s\S]*?)\s*<\/tr>/g)) {
    rest = rest.replace(row[0], "")
    const cells: string[] = []
    let rowRest = row[1]!
    for (const cell of row[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)) {
      cells.push(cell[1]!.trim())
      rowRest = rowRest.replace(cell[0], "")
    }
    if (rowRest.trim() || !cells.length) return undefined
    rows.push(cells)
  }
  return rest.trim() || !rows.length ? undefined : rows
}

function blocks(tokens: readonly Token[], markEscapes = false): unknown[] {
  const result: unknown[] = []
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
        break
      case "heading":
        result.push(["heading", token.depth, inline(token.text, token.tokens, markEscapes)])
        break
      case "paragraph":
      case "text":
        result.push(["paragraph", inline(token.text, token.tokens, markEscapes)])
        if (result.length > 1 && (result[result.length - 2] as unknown[])[0] === "paragraph") {
          const previous = result[result.length - 2] as [string, unknown[]]
          const current = result.pop() as [string, unknown[]]
          previous[1].push(" ", ...current[1])
          previous[1] = inlineText(previous[1])
        }
        {
          const paragraph = result.at(-1) as [string, unknown[]] | undefined
          const parts = paragraph?.[1]
          const last = parts?.at(-1)
          const glued =
            typeof last === "string"
              ? /^(.*?)<details>\s*<summary>([\s\S]*?)<\/summary>\s*$/i.exec(last)
              : undefined
          if (glued && parts) {
            const prefix = glued[1]!.replace(/\s+$/, "")
            if (prefix) parts[parts.length - 1] = prefix
            else parts.pop()
            result.push(["paragraph", inline(glued[2]!, undefined, markEscapes)])
          }
          if (parts) {
            for (let index = parts.length - 1; index >= 0; index--) {
              const part = parts[index]
              if (typeof part !== "string" || !/<\/details>/i.test(part)) continue
              const replaced = part.replace(/\s*<\/details>\s*/gi, " ")
              if (replaced.trim()) parts[index] = replaced
              else parts.splice(index, 1)
            }
          }
        }
        break
      case "code":
        result.push(["code", codeLanguage(token.lang), token.text])
        break
      case "list":
        result.push([
          "list",
          token.ordered,
          token.start,
          token.items.map((item: Tokens.ListItem) => [
            item.task,
            item.checked ?? null,
            blocks(item.tokens, markEscapes),
          ]),
        ])
        break
      case "blockquote":
        result.push(["blockquote", blocks(token.tokens!, markEscapes)])
        break
      case "table":
        result.push([
          "table",
          [token.header, ...token.rows].map((row: Tokens.TableCell[]) =>
            row.map((cell) => inline(cell.text, cell.tokens, markEscapes)),
          ),
        ])
        break
      case "html": {
        const table = /^(<table(?: header-row="true")?>[\s\S]*?<\/table>)([\s\S]*)$/.exec(
          token.text,
        )
        const rows = table && tableRows(table[1]!)
        if (rows) {
          result.push([
            "table",
            rows.map((row) => row.map((cell) => inline(cell, undefined, markEscapes))),
          ])
          result.push(...blocks(Lexer.lex(table![2]!.trimStart()), markEscapes))
          break
        }
        const opened = /^<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*)$/i.exec(token.text)
        if (opened) {
          result.push(["paragraph", inline(opened[1]!, undefined, markEscapes)])
          if (opened[2]!.trim()) result.push(...blocks(Lexer.lex(opened[2]!), markEscapes))
          break
        }
        const closed = /^<\/details>\s*([\s\S]*)$/i.exec(token.text)
        if (closed) {
          if (closed[1]!.trim()) {
            for (const block of blocks(Lexer.lex(closed[1]!), markEscapes)) {
              const previous = result.at(-1) as [string, unknown[]] | undefined
              const current = block as [string, unknown[]]
              if (previous?.[0] === "paragraph" && current[0] === "paragraph") {
                previous[1].push(" ", ...current[1])
                previous[1] = inlineText(previous[1])
              } else result.push(block)
            }
          }
          break
        }
        result.push(["html", token.text])
        break
      }
      default:
        result.push([token.type, token.raw])
    }
  }
  return result
}

export function markdownIdentity(markdown: string) {
  return JSON.stringify(blocks(Lexer.lex(markdown.replace(/\r\n/g, "\n"))))
}

/** Project only the documented wrapper/break artifacts from API plain text.
 * Plain rich text is not Markdown: never reparse its backticks or asterisks.
 * This projection supports link correspondence, not complete-body verification.
 */
export function visibleNotionText(text: string) {
  return text.replace(/<\/?(?:details|summary)\b[^>]*>/gi, "").replace(/\s*<br\s*\/?>\s*/gi, " ")
}

/** Project authored CommonMark, omitting fenced/indented code without readback repair. */
export function visibleMarkdownText(markdown: string) {
  const visit = (node: unknown): string => {
    if (!Array.isArray(node)) return ""
    switch (node[0]) {
      case "paragraph":
        return visibleInline(node[1])
      case "heading":
        return visibleInline(node[2])
      case "blockquote":
        return node[1].map(visit).join("")
      case "list":
        return node[3]
          .map((item: unknown[]) => (Array.isArray(item[2]) ? item[2].map(visit).join("") : ""))
          .join("")
      case "table":
        return node[1].map((row: unknown[][]) => row.map(visibleInline).join("")).join("")
      case "html":
        return typeof node[1] === "string" ? node[1] : ""
      default:
        return ""
    }
  }
  return visibleNotionText(
    blocks(Lexer.lex(markdown.replace(/\r\n/g, "\n")))
      .map(visit)
      .join(""),
  )
}

/** API Markdown uses its documented readback syntax before visible-text projection. */
export function visibleNotionMarkdownText(markdown: string) {
  return visibleMarkdownText(fromNotionMarkdown(markdown))
}

export function markdownStructure(markdown: string) {
  return blocks(Lexer.lex(markdown.replace(/\r\n/g, "\n")), true)
}

/** Compare readback with authored Markdown without interpreting application URLs. */
export function sameNotionMarkdown(actual: string, target: string) {
  const expected = markdownStructure(target)
  return (
    sameMarkdownStructure(markdownStructure(actual), expected) ||
    sameMarkdownStructure(markdownStructure(fromNotionMarkdown(actual)), expected)
  )
}

export type MarkdownLinkDestinationMatch = (actual: string, target: string) => boolean

export function sameMarkdownStructure(
  left: readonly unknown[],
  right: readonly unknown[],
  sameLinkDestination: MarkdownLinkDestinationMatch = (actual, target) => actual === target,
) {
  // Notion may wrap inline code with a literal <br> and split one link around it.
  const unwrap = (value: unknown) =>
    typeof value === "string" ? value.replace(/\s*<br\s*\/?>\s*/gi, " ") : value
  const coalesce = (nodes: readonly unknown[]) => {
    const result: unknown[] = []
    for (const node of nodes) {
      const previous = result.at(-1)
      if (
        Array.isArray(previous) &&
        Array.isArray(node) &&
        previous[0] === "link" &&
        node[0] === "link" &&
        previous[1] === node[1] &&
        previous[2] === node[2] &&
        Array.isArray(previous[3]) &&
        Array.isArray(node[3])
      ) {
        result[result.length - 1] = [
          previous[0],
          previous[1],
          previous[2],
          [...previous[3], ...node[3]],
        ]
        continue
      }
      result.push(node)
    }
    return result
  }
  // Bare-domain autolinks and emphasis split around a link are readback
  // syntax. Destination aliases and page identity belong to the caller.
  const bareHost = (node: unknown) => {
    if (!Array.isArray(node) || node[0] !== "link" || typeof node[1] !== "string") return
    const children = node[3]
    if (!Array.isArray(children) || children.length !== 1 || typeof children[0] !== "string") return
    const label = children[0]
    const localHost =
      label.toLowerCase() === "localhost" &&
      node[2] === null &&
      /^https?:\/\/localhost\/?$/i.test(node[1])
    if (!localHost && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(label)) return
    const root = /^https?:\/\/([^/:?#@\\\s]+)\/?$/i.exec(node[1])
    if (!root || root[1]!.toLowerCase() !== label.toLowerCase()) return
    try {
      const url = new URL(node[1])
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.hostname.toLowerCase() !== label.toLowerCase() ||
        (url.pathname !== "/" && url.pathname !== "") ||
        url.port ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        return
      return label
    } catch {
      return
    }
  }
  const foldPublished = (nodes: readonly unknown[]) => {
    const result: unknown[] = []
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      const next = nodes[index + 1]
      if (typeof node === "string" && Array.isArray(next) && next[0] === "link") {
        const split = /^(.*?)\*\*(\S[\s\S]*?)\s\*\*$/.exec(node)
        if (split && !split[1]!.includes("**") && !split[2]!.includes("**")) {
          result.push(`${split[1]!}${split[2]!} `)
          continue
        }
      }
      result.push(node)
    }
    const merged: unknown[] = []
    for (const item of result) {
      const previous = merged.at(-1)
      if (typeof item === "string" && typeof previous === "string")
        merged[merged.length - 1] = previous + item
      else merged.push(item)
    }
    return merged
  }
  const same = (candidate: unknown, expected: unknown): boolean => {
    if (!Array.isArray(candidate) || !Array.isArray(expected))
      return JSON.stringify(candidate) === JSON.stringify(expected)
    if (
      candidate[0] === "code" &&
      expected[0] === "code" &&
      candidate.length === 2 &&
      expected.length === 2
    )
      return candidate[1] === expected[1] || unwrap(candidate[1]) === expected[1]
    if (candidate[0] === "code" && expected[0] === "code")
      return (
        (candidate[1] === expected[1] ||
          (expected[1] === "text" && candidate[1] === "javascript")) &&
        candidate[2] === expected[2]
      )
    if ((candidate[0] === "link" || candidate[0] === "image") && candidate[0] === expected[0]) {
      const destinationMatches =
        candidate[0] === "link" &&
        typeof candidate[1] === "string" &&
        typeof expected[1] === "string"
          ? sameLinkDestination(candidate[1], expected[1])
          : candidate[1] === expected[1]
      return destinationMatches && candidate[2] === expected[2] && same(candidate[3], expected[3])
    }
    if (candidate[0] === "html" && expected[0] === "html") return candidate[1] === expected[1]
    if (
      candidate[0] === "paragraph" &&
      expected[0] === "paragraph" &&
      Array.isArray(candidate[1]) &&
      Array.isArray(expected[1])
    ) {
      const edges = (parts: readonly unknown[]) => {
        const result = [...parts]
        if (typeof result[0] === "string") result[0] = result[0].trimStart()
        if (typeof result.at(-1) === "string")
          result[result.length - 1] = String(result.at(-1)).trimEnd()
        return result.filter((part) => part !== "")
      }
      return same(edges(candidate[1]), edges(expected[1]))
    }
    const aligned = coalesce(foldPublished(candidate))
    const wanted = coalesce(foldPublished(expected))
    let leftIndex = 0
    let rightIndex = 0
    let leftOffset = 0
    let rightOffset = 0
    while (leftIndex < aligned.length && rightIndex < wanted.length) {
      const actual = aligned[leftIndex]
      const target = wanted[rightIndex]
      // A readback autolink can stand in for authored bare text. Two explicit
      // links must retain their destinations, including scheme and port.
      const actualText =
        typeof actual === "string"
          ? actual
          : Array.isArray(actual) && actual[0] === "literal"
            ? actual[1]
            : bareHost(actual)
      const targetText =
        typeof target === "string"
          ? target
          : Array.isArray(target) && target[0] === "literal"
            ? target[1]
            : undefined
      if (actualText !== undefined && targetText !== undefined) {
        const length = Math.min(actualText.length - leftOffset, targetText.length - rightOffset)
        if (
          actualText.slice(leftOffset, leftOffset + length) !==
          targetText.slice(rightOffset, rightOffset + length)
        )
          return false
        leftOffset += length
        rightOffset += length
        if (leftOffset === actualText.length) {
          leftIndex++
          leftOffset = 0
        }
        if (rightOffset === targetText.length) {
          rightIndex++
          rightOffset = 0
        }
        continue
      }
      if (leftOffset || rightOffset || !same(actual, target)) return false
      leftIndex++
      rightIndex++
    }
    return leftIndex === aligned.length && rightIndex === wanted.length
  }
  return same(left, right)
}

interface SourceRange {
  readonly start: number
  readonly end: number
}

interface PositionedToken extends SourceRange {
  readonly token: Token
}

interface ComparisonEdit extends SourceRange {
  readonly text: string
}

function positionedTokens(markdown: string): PositionedToken[] | undefined {
  const result: PositionedToken[] = []
  let offset = 0
  for (const token of Lexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, offset)
    if (start < 0 || markdown.slice(offset, start).trim()) return
    const end = start + token.raw.length
    if (token.type !== "space" && token.type !== "def") result.push({ token, start, end })
    offset = end
  }
  return markdown.slice(offset).trim() ? undefined : result
}

const sameRange = (left: SourceRange, right: SourceRange) =>
  left.start === right.start && left.end === right.end
const plainBoundaryText = (text: string) => text.replace(/\s+/g, " ")
const paragraphRange = (part: PositionedToken): SourceRange => ({
  start: part.start,
  end:
    part.start + (part.token.type === "paragraph" ? part.token.text.length : part.token.raw.length),
})

function boldLinkSpans(block: NotionBlockBoundary) {
  const spans = block.rich_text
  if (block.type !== "paragraph" || block.has_children || spans?.length !== 3) return
  const [first, second, last] = spans
  if (
    !first!.bold ||
    first!.code ||
    typeof first!.link !== "string" ||
    !second!.bold ||
    second!.code ||
    second!.link !== null ||
    last!.bold ||
    last!.code ||
    last!.link !== null
  )
    return
  return [first!, second!, last!] as const
}

// Locate roots in the unmodified readback. A proposed repair cannot create the
// evidence that proves its own position, and an ambiguous root stays unproved.
function orderedRootProof(
  markdown: string,
  actual: readonly PositionedToken[],
  boundaries: readonly NotionBlockBoundary[],
) {
  const structural = new Map<string, SourceRange[]>()
  const add = (type: string, range: SourceRange) =>
    structural.set(type, [...(structural.get(type) ?? []), range])
  for (const part of actual) {
    const token = part.token
    if (token.type === "code") add("code", part)
    else if (token.type === "hr") add("divider", part)
    else if (token.type === "heading") add(`heading_${token.depth}`, part)
    else if (token.type === "html" && /^<table\b[^>]*>[\s\S]*<\/table>\s*$/.test(token.raw))
      add("table", part)
    else if (token.type === "list") {
      let offset = part.start
      for (const item of token.items) {
        const start = markdown.indexOf(item.raw, offset)
        if (start < offset || start + item.raw.length > part.end) break
        add(
          item.task === true
            ? "to_do"
            : token.ordered
              ? "numbered_list_item"
              : "bulleted_list_item",
          {
            start,
            end: start + item.raw.length,
          },
        )
        offset = start + item.raw.length
      }
    }
  }
  const fixed = new Map<NotionBlockBoundary, SourceRange>()
  for (const [type, ranges] of structural) {
    const roots = boundaries.filter((block) => block.type === type)
    if (roots.length === ranges.length)
      roots.forEach((block, index) => fixed.set(block, ranges[index]!))
  }
  const textCache = new Map<string, SourceRange[]>()
  const locateText = (text: string) => {
    const expected = plainBoundaryText(text)
    if (!expected.trim()) return []
    const cached = textCache.get(expected)
    if (cached) return cached
    const matches: SourceRange[] = []
    for (const part of actual) {
      if (part.token.type !== "paragraph") continue
      const text = part.token.text
      const lines = text.split("\n")
      const starts: number[] = []
      let offset = part.start
      for (const line of lines) {
        starts.push(offset)
        offset += line.length + 1
      }
      const protectedRanges: SourceRange[] = []
      offset = 0
      for (const token of Lexer.lexInline(text)) {
        const start = text.indexOf(token.raw, offset)
        if (start < 0) break
        if (token.type === "codespan")
          protectedRanges.push({
            start: part.start + start,
            end: part.start + start + token.raw.length,
          })
        offset = start + token.raw.length
      }
      for (let start = 0; start < lines.length; start++) {
        for (let end = start; end < lines.length; end++) {
          const range = { start: starts[start]!, end: starts[end]! + lines[end]!.length }
          if (
            protectedRanges.some(
              (code) =>
                (code.start < range.start && range.start < code.end) ||
                (code.start < range.end && range.end < code.end),
            )
          )
            continue
          const content = plainBoundaryText(
            visibleInline(inline(markdown.slice(range.start, range.end))),
          )
          if (content === expected) matches.push(range)
          if (content.length >= expected.length) break
        }
      }
    }
    textCache.set(expected, matches)
    return matches
  }
  const located = new Map<NotionBlockBoundary, readonly SourceRange[]>()
  for (const block of boundaries) {
    const position = fixed.get(block)
    if (
      block.type === "quote" &&
      !block.has_children &&
      block.rich_text?.length === 0 &&
      (block.text === undefined || block.text === "")
    ) {
      located.set(
        block,
        actual.flatMap((part) =>
          part.token.type === "blockquote" &&
          part.token.text === "" &&
          part.token.tokens?.length === 0 &&
          /^>[ \t]?\n*$/.test(part.token.raw)
            ? [part]
            : [],
        ),
      )
      continue
    }
    if (
      block.type === "quote" &&
      !block.has_children &&
      block.rich_text?.length &&
      block.rich_text.every((span) => !span.bold && !span.code && span.link === null)
    ) {
      const text = block.rich_text.map((span) => span.text).join("")
      if (text && !/[\r\n]/.test(text))
        located.set(
          block,
          actual.flatMap((part) => {
            const children =
              part.token.type === "blockquote"
                ? part.token.tokens?.filter((token) => token.type !== "space")
                : undefined
            const paragraph = children?.length === 1 ? children[0] : undefined
            if (
              paragraph?.type !== "paragraph" ||
              /[\r\n]/.test(paragraph.text) ||
              !/^> [^\r\n]+\n*$/.test(part.token.raw) ||
              JSON.stringify(inline(paragraph.text, paragraph.tokens, true)) !==
                JSON.stringify([text])
            )
              return []
            return [part]
          }),
        )
      continue
    }
    if (block.type !== "paragraph" || block.has_children) {
      if (position) located.set(block, [position])
      continue
    }
    const text = block.rich_text?.map((span) => span.text).join("") ?? block.text
    if (text === undefined) continue
    const forms = [text]
    const spans = boldLinkSpans(block)
    if (spans) forms.push(`${spans[0].text}**${spans[1].text}**${spans[2].text}`)
    // A literal backtick inside physical inline code has one observed escaped
    // serializer form. Locate that form only in the untouched readback; the
    // source-bound decoder must still prove the complete typed inline content.
    const backticks = block.rich_text?.filter((span) => span.code && span.text.includes("`"))
    if (
      backticks?.length &&
      backticks.every((span) => span.link === null && !/[\\\r\n]/.test(span.text))
    )
      forms.push(
        block
          .rich_text!.map((span) =>
            span.code && span.text.includes("`")
              ? visibleInline(inline("`" + span.text.replaceAll("`", "\\`") + "`"))
              : span.text,
          )
          .join(""),
      )
    const matches: SourceRange[] = []
    for (const form of forms) {
      for (const match of locateText(form))
        if (!matches.some((found) => sameRange(found, match))) matches.push(match)
    }
    located.set(block, matches)
  }
  const unique = (index: number) => {
    const matches = boundaries[index] && located.get(boundaries[index]!)
    return matches?.length === 1 ? matches[0] : undefined
  }
  let previousEnd = -1
  let ordered = true
  for (let index = 0; index < boundaries.length; index++) {
    const range = unique(index)
    if (!range) continue
    if (range.start < previousEnd) ordered = false
    previousEnd = range.end
  }
  let visibleReadback: string | undefined
  const absentLeaf = (block: NotionBlockBoundary) => {
    const text = block.rich_text?.map((span) => span.text).join("") ?? block.text
    if (
      block.type !== "paragraph" ||
      block.has_children ||
      typeof text !== "string" ||
      !text.trim() ||
      (located.get(block)?.length ?? 0) !== 0 ||
      markdown.includes(text)
    )
      return false
    visibleReadback ??= plainBoundaryText(visibleMarkdownText(markdown))
    return !visibleReadback.includes(plainBoundaryText(text))
  }
  return (firstIndex: number, ranges: readonly SourceRange[]) => {
    if (!ordered || !ranges.length) return false
    for (let index = 0; index < ranges.length; index++) {
      const actualRange = unique(firstIndex + index)
      if (!actualRange || !sameRange(actualRange, ranges[index]!)) return false
      if (index && markdown.slice(ranges[index - 1]!.end, actualRange.start).trim()) return false
    }
    const first = ranges[0]!
    const last = ranges.at(-1)!
    if (firstIndex > 0) {
      const before = unique(firstIndex - 1)
      if (before) {
        if (before.end > first.start || markdown.slice(before.end, first.start).trim()) return false
      } else {
        // Application-owned prefixes may have been removed before comparison.
        // They prove no position; only an actual document-start range permits them.
        if (
          markdown.slice(0, first.start).trim() ||
          !boundaries.slice(0, firstIndex).every(absentLeaf)
        )
          return false
      }
    } else if (markdown.slice(0, first.start).trim()) return false
    const nextIndex = firstIndex + ranges.length
    if (nextIndex < boundaries.length) {
      const after = unique(nextIndex)
      if (!after || after.start < last.end || markdown.slice(last.end, after.start).trim())
        return false
    } else if (markdown.slice(last.end).trim()) return false
    return true
  }
}

// Rich text is already literal evidence. Only ordinary whitespace follows the
// existing inline semantics; code bytes and complete link destinations stay exact.
function retainedInline(block: NotionBlockBoundary) {
  const spans = block.rich_text
  if (!spans?.length) return
  return inlineText(
    spans.map((span) => {
      const value = span.code ? ["code", span.text] : span.text.replace(/\s+/g, " ")
      return span.link === null ? value : ["link", span.link, null, [value]]
    }),
  )
}

function leafListItem(item: Tokens.ListItem) {
  return (
    !item.task &&
    !item.text.includes("\n") &&
    item.tokens.length === 1 &&
    (item.tokens[0]!.type === "text" || item.tokens[0]!.type === "paragraph")
  )
}

interface RetainedStartItem {
  readonly tokens: readonly Token[]
  readonly children: readonly Tokens.ListItem[]
}

function retainedStartItem(
  item: Tokens.ListItem,
  acceptsLeaf: (item: Tokens.ListItem) => boolean = leafListItem,
): RetainedStartItem | undefined {
  const head = item.tokens[0]
  if (
    item.task ||
    !head ||
    (head.type !== "text" && head.type !== "paragraph") ||
    typeof head.text !== "string" ||
    /[\r\n\t]/.test(head.text) ||
    (head.tokens !== undefined && !Array.isArray(head.tokens))
  )
    return
  const tokens = head.tokens ?? Lexer.lexInline(head.text)
  if (acceptsLeaf(item)) return { tokens, children: [] }
  const nested = item.tokens[1]
  if (
    item.tokens.length !== 2 ||
    nested?.type !== "list" ||
    nested.ordered !== false ||
    nested.loose !== false ||
    !Array.isArray(nested.items) ||
    !nested.items.length ||
    !nested.items.every((child: Tokens.ListItem) => child.loose === false && leafListItem(child))
  )
    return
  return { tokens, children: nested.items }
}

function retainedStartSpanStructure(spans: readonly NotionTextSpan[] | undefined) {
  if (!spans?.length) return
  const merged: { text: string; bold: boolean; code: boolean }[] = []
  for (const span of spans) {
    if (
      typeof span.text !== "string" ||
      !span.text.length ||
      /[\r\n\t]/.test(span.text) ||
      span.link !== null ||
      typeof span.bold !== "boolean" ||
      typeof span.code !== "boolean"
    )
      return
    const last = merged.at(-1)
    if (last && last.bold === span.bold && last.code === span.code) last.text += span.text
    else merged.push({ text: span.text, bold: span.bold, code: span.code })
  }
  return JSON.stringify(merged)
}

// The observed nested-list form contains text, strong text and code spans.
// Every other inline token remains unsupported by this finite physical proof.
function retainedStartTokenStructure(tokens: readonly Token[]) {
  const spans: NotionTextSpan[] = []
  const visit = (values: readonly Token[], bold: boolean): boolean => {
    for (const token of values) {
      if (token.type === "strong") {
        if (!Array.isArray(token.tokens) || !visit(token.tokens, true)) return false
      } else if (
        (token.type === "text" || token.type === "codespan") &&
        typeof token.text === "string"
      ) {
        if (token.text.length)
          spans.push({ text: token.text, link: null, bold, code: token.type === "codespan" })
      } else return false
    }
    return true
  }
  return visit(tokens, false) ? retainedStartSpanStructure(spans) : undefined
}

function retainedStartEvidenceIds(boundaries: readonly NotionBlockBoundary[]) {
  const ids = new Set<string>()
  const add = (node: NotionBlockNode) => {
    if (!node || typeof node.id !== "string" || !node.id || ids.has(node.id) || ids.size >= 4096)
      return false
    ids.add(node.id)
    return true
  }
  for (const root of boundaries) {
    if (!add(root)) return false
    for (const nodes of [
      root.descendants,
      root.quote_descendants,
      root.list_table_descendants,
      root.table_evidence?.rows,
    ]) {
      if (nodes === undefined) continue
      if (!Array.isArray(nodes) || nodes.some((node: NotionBlockNode) => !add(node))) return false
    }
  }
  return true
}

function retainedStartItemMatches(
  root: NotionBlockBoundary,
  actual: RetainedStartItem | undefined,
  wanted: RetainedStartItem | undefined,
) {
  if (
    !actual ||
    !wanted ||
    actual.children.length !== wanted.children.length ||
    root.quote_descendants !== undefined ||
    root.list_table_descendants !== undefined ||
    root.table_evidence !== undefined ||
    root.code !== undefined ||
    root.to_do !== undefined
  )
    return false
  const textMatches = (
    node: NotionBlockNode,
    readback: RetainedStartItem,
    source: RetainedStartItem,
  ) => {
    const physical = retainedStartSpanStructure(node.rich_text)
    return (
      physical !== undefined &&
      physical === retainedStartTokenStructure(readback.tokens) &&
      physical === retainedStartTokenStructure(source.tokens)
    )
  }
  if (!textMatches(root, actual, wanted)) return false
  const children = root.descendants ?? []
  if (
    !Array.isArray(children) ||
    children.length !== actual.children.length ||
    root.has_children !== children.length > 0
  )
    return false
  return children.every((child, index) => {
    const readback = retainedStartItem(actual.children[index]!)
    const source = retainedStartItem(wanted.children[index]!)
    return (
      child.type === "bulleted_list_item" &&
      child.parent_id === root.id &&
      !child.has_children &&
      child.numbered_list === undefined &&
      child.code === undefined &&
      child.to_do === undefined &&
      readback !== undefined &&
      source !== undefined &&
      textMatches(child, readback, source)
    )
  })
}

function retainedStartParagraphMatches(root: NotionBlockBoundary, actual: Token, wanted: Token) {
  if (
    root.type !== "paragraph" ||
    actual.type !== "paragraph" ||
    wanted.type !== "paragraph" ||
    typeof actual.text !== "string" ||
    typeof wanted.text !== "string" ||
    /[\r\n\t]/.test(actual.text) ||
    /[\r\n\t]/.test(wanted.text) ||
    (actual.tokens !== undefined && !Array.isArray(actual.tokens)) ||
    (wanted.tokens !== undefined && !Array.isArray(wanted.tokens))
  )
    return false
  return retainedStartItemMatches(
    root,
    { tokens: actual.tokens ?? Lexer.lexInline(actual.text), children: [] },
    { tokens: wanted.tokens ?? Lexer.lexInline(wanted.text), children: [] },
  )
}

function retainedStartIndentEdits(
  markdown: string,
  range: SourceRange,
  first: Tokens.ListItem,
  start: number,
): ComparisonEdit[] | undefined {
  const item = retainedStartItem(first)
  if (!item) return
  const width = String(start).length - 1
  if (!width || !item.children.length) return []
  const raw = markdown.slice(range.start, range.end)
  if (raw.includes("\r")) return
  const lines = raw.split("\n")
  if (!lines[0] || lines.slice(item.children.length + 1).some((line) => line !== "")) return
  const edits: ComparisonEdit[] = []
  let offset = range.start + lines[0].length + 1
  for (const [index, child] of item.children.entries()) {
    const line = lines[index + 1]
    const childRaw = child.raw.replace(/\n+$/, "")
    if (
      line === undefined ||
      !childRaw ||
      /[\r\n\t]/.test(childRaw) ||
      !/^ {0,3}[-+*] +[^\r\n]+$/.test(childRaw) ||
      !line.endsWith(childRaw) ||
      !/^ +$/.test(line.slice(0, line.length - childRaw.length))
    )
      return
    edits.push({ start: offset, end: offset, text: " ".repeat(width) })
    offset += line.length + 1
  }
  return edits
}

function originalListItemRanges(
  markdown: string,
  part: PositionedToken,
  acceptsItem: (item: Tokens.ListItem) => boolean = leafListItem,
  allowTerminalLf = false,
) {
  if (part.token.type !== "list" || !part.token.items.every(acceptsItem)) return
  const ranges: SourceRange[] = []
  let offset = part.start
  for (const item of part.token.items) {
    const start = markdown.indexOf(item.raw, offset)
    if (start !== offset || start + item.raw.length > part.end) return
    ranges.push({ start, end: start + item.raw.length })
    offset = start + item.raw.length
  }
  return offset === part.end || (allowTerminalLf && markdown.slice(offset, part.end) === "\n")
    ? ranges
    : undefined
}

// The Markdown serializer can restart at one even when the physical first
// block retains its positive start. Missing fields and zero provide no evidence.
function retainedOrderedStartEdits(
  markdown: string,
  target: string,
  actual: readonly PositionedToken[],
  wanted: readonly PositionedToken[],
  boundaries: readonly NotionBlockBoundary[],
  proves: ReturnType<typeof orderedRootProof>,
) {
  const edits: ComparisonEdit[] = []
  const content = (list: Token) => {
    if (list.type !== "list") return
    return JSON.stringify(
      list.items.map((item: Tokens.ListItem) => [
        item.task,
        item.checked ?? null,
        blocks(item.tokens, true),
      ]),
    )
  }
  // Marked keeps one terminal LF on a loose source item's sole paragraph.
  // Admit only that source form; actual item ranges and every physical proof
  // still use the existing flat-leaf contract.
  const sourceLeaf = (item: Tokens.ListItem) => {
    if (leafListItem(item)) return true
    const paragraph = item.tokens[0]
    return (
      !item.task &&
      item.loose &&
      item.tokens.length === 1 &&
      paragraph?.type === "paragraph" &&
      !paragraph.text.includes("\n") &&
      item.text === `${paragraph.text}\n`
    )
  }
  for (const part of actual) {
    const list = part.token
    if (list.type !== "list" || !list.ordered || list.start !== 1) continue
    const last = list.items.at(-1)
    const terminalNested = last !== undefined && (retainedStartItem(last)?.children.length ?? 0) > 0
    const ranges = originalListItemRanges(
      markdown,
      part,
      (item) => leafListItem(item) || retainedStartItem(item) !== undefined,
      terminalNested,
    )
    if (!ranges?.length) continue
    const signature = content(list)
    const source = wanted.filter(
      ({ token }) =>
        token.type === "list" &&
        token.ordered &&
        typeof token.start === "number" &&
        Number.isSafeInteger(token.start) &&
        token.start > 1 &&
        token.start <= 999999999 &&
        token.items.every(
          (item: Tokens.ListItem) =>
            sourceLeaf(item) || retainedStartItem(item, sourceLeaf) !== undefined,
        ) &&
        content(token) === signature,
    )
    if (source.length !== 1 || source[0]!.token.type !== "list") continue
    const sourceList = source[0]!.token
    const sourceStart = sourceList.start
    if (typeof sourceStart !== "number") continue
    // Equal-looking lists cannot borrow one another's physical start.
    if (
      actual.filter(
        ({ token }) => token.type === "list" && token.ordered && content(token) === signature,
      ).length !== 1
    )
      continue
    const nested = list.items.some((item: Tokens.ListItem) => !leafListItem(item))
    if (nested && !retainedStartEvidenceIds(boundaries)) continue
    const roots = boundaries.flatMap((block, index) => {
      if (
        block.type !== "numbered_list_item" ||
        boundaries[index - 1]?.type === "numbered_list_item"
      )
        return []
      const group = boundaries.slice(index, index + list.items.length)
      if (
        group.length !== list.items.length ||
        boundaries[index + list.items.length]?.type === "numbered_list_item" ||
        group.some((item, itemIndex) => {
          if (
            item.type !== "numbered_list_item" ||
            !item.numbered_list ||
            (itemIndex === 0
              ? item.numbered_list.start !== sourceStart
              : item.numbered_list.start !== null)
          )
            return true
          if (nested)
            return !retainedStartItemMatches(
              item,
              retainedStartItem(list.items[itemIndex]!),
              retainedStartItem(sourceList.items[itemIndex]!, sourceLeaf),
            )
          return (
            item.has_children ||
            JSON.stringify(retainedInline(item)) !==
              JSON.stringify(inline(list.items[itemIndex]!.text))
          )
        })
      )
        return []
      return [index]
    })
    if (roots.length !== 1 || !proves(roots[0]!, ranges)) continue
    const prefix = /^( {0,3})1([.)][ \t]+)/.exec(list.raw)
    if (!prefix) continue
    if (nested && prefix[0].includes("\t")) continue
    const indentation = nested
      ? retainedStartIndentEdits(markdown, ranges[0]!, list.items[0]!, sourceStart)
      : []
    if (indentation === undefined) continue
    const previous = actual[actual.indexOf(part) - 1]
    const sourcePrevious = wanted[wanted.indexOf(source[0]!) - 1]
    // Restoring a start greater than one must retain the already observed list
    // boundary: unlike one, that marker cannot interrupt a paragraph. Prove the
    // complete original paragraph/list pair before inserting its single LF.
    if (
      (list.items.length === 1 || nested) &&
      previous?.token.type === "paragraph" &&
      sourcePrevious?.token.type === "paragraph" &&
      !previous.token.text.includes("\n") &&
      previous.token.text === sourcePrevious.token.text &&
      sourcePrevious.token.raw.replace(/\n+$/, "") === sourcePrevious.token.text &&
      target.slice(sourcePrevious.end, source[0]!.start) === "\n\n" &&
      markdown.slice(paragraphRange(previous).end, part.start) === "\n" &&
      boundaries[roots[0]! - 1]?.type === "paragraph" &&
      !boundaries[roots[0]! - 1]!.has_children &&
      JSON.stringify(retainedInline(boundaries[roots[0]! - 1]!)) ===
        JSON.stringify(inline(previous.token.text, previous.token.tokens)) &&
      (!nested ||
        retainedStartParagraphMatches(
          boundaries[roots[0]! - 1]!,
          previous.token,
          sourcePrevious.token,
        )) &&
      proves(roots[0]! - 1, [paragraphRange(previous), ...ranges])
    ) {
      edits.push(...indentation, {
        start: part.start,
        end: part.start + prefix[1]!.length + 1,
        text: "\n" + prefix[1] + String(sourceStart),
      })
      continue
    }
    const start = part.start + prefix[1]!.length
    edits.push(...indentation, { start, end: start + 1, text: String(sourceStart) })
  }
  return edits
}

function setextEdits(
  target: string,
  actual: readonly PositionedToken[],
  wanted: readonly PositionedToken[],
  boundaries: readonly NotionBlockBoundary[],
  proves: ReturnType<typeof orderedRootProof>,
): ComparisonEdit[] {
  const heading = wanted[1]?.token
  const paragraph = actual[1]?.token
  if (
    wanted[0]?.start !== 0 ||
    actual[0]?.start !== 0 ||
    wanted[0]?.token.type !== "hr" ||
    wanted[0].token.raw.trim() !== "---" ||
    heading?.type !== "heading" ||
    heading.depth !== 2 ||
    actual[0]?.token.type !== "hr" ||
    actual[0].token.raw.trim() !== "---" ||
    paragraph?.type !== "paragraph" ||
    actual[2]?.token.type !== "hr" ||
    actual[2].token.raw.trim() !== "---"
  )
    return []
  if (
    !heading.text.includes("\n") ||
    heading.raw.trimEnd() !== `${heading.text}\n---` ||
    !heading.tokens?.every((token) => token.type === "text" && token.raw === token.text) ||
    paragraph.text !== heading.text.replace(/\n/g, "<br>")
  )
    return []
  const roots = boundaries.flatMap((block, index) =>
    block.type === "paragraph" &&
    !block.has_children &&
    block.text === heading.text &&
    boundaries[index - 1]?.type === "divider" &&
    !boundaries[index - 1]!.has_children &&
    boundaries[index + 1]?.type === "divider" &&
    !boundaries[index + 1]!.has_children
      ? [index]
      : [],
  )
  if (
    roots.length !== 1 ||
    !proves(roots[0]! - 1, [actual[0]!, paragraphRange(actual[1]!), actual[2]!])
  )
    return []
  return [{ start: 0, end: actual[2]!.end, text: target.slice(0, wanted[1]!.end) }]
}

function sameSerializedUrl(actual: string, recorded: string) {
  try {
    return new URL(actual).href === new URL(recorded).href
  } catch {
    return false
  }
}

function boldLinkEdits(
  actual: readonly PositionedToken[],
  wanted: readonly PositionedToken[],
  boundaries: readonly NotionBlockBoundary[],
  proves: ReturnType<typeof orderedRootProof>,
) {
  const edits: ComparisonEdit[] = []
  for (const part of wanted) {
    if (part.token.type !== "paragraph") continue
    const strong = part.token.tokens?.[0]
    const tailTokens = part.token.tokens?.slice(1)
    if (
      strong?.type !== "strong" ||
      !strong.tokens?.every((token) => token.type === "text" && token.raw === token.text) ||
      !tailTokens?.every((token) => token.type === "text" && token.raw === token.text)
    )
      continue
    const tail = tailTokens.map((token) => token.raw).join("")
    const candidates = actual.flatMap((candidate) => {
      if (candidate.token.type !== "paragraph" || candidate.token.tokens?.length !== 2) return []
      const [link, rest] = candidate.token.tokens
      if (
        link?.type !== "link" ||
        link.title != null ||
        rest?.type !== "text" ||
        rest.raw !== rest.text ||
        !link.tokens?.length
      )
        return []
      const labelTokens =
        link.tokens.length === 1 && link.tokens[0]!.type === "strong"
          ? link.tokens[0]!.tokens
          : link.tokens
      if (!labelTokens?.every((token) => token.type === "text" && token.raw === token.text))
        return []
      const label = visibleInline(inline(link.text, link.tokens))
      const split = /^\*\*([ \t]+[^*`\\\r\n]+\S)\*\*([\s\S]*)$/.exec(rest.raw)
      if (!split || label + split[1] !== strong.text || split[2] !== tail) return []
      const roots = boundaries.flatMap((block, index) => {
        const spans = boldLinkSpans(block)
        return spans &&
          spans[0].text === label &&
          sameSerializedUrl(link.href, spans[0].link!) &&
          spans[1].text === split[1] &&
          spans[2].text === tail
          ? [index]
          : []
      })
      const range = paragraphRange(candidate)
      if (roots.length !== 1 || !proves(roots[0]!, [range])) return []
      return [{ ...range, text: `${link.raw}${split[1]}${tail}` }]
    })
    if (candidates.length === 1) edits.push(candidates[0]!)
  }
  return edits
}

/** A comparison-only candidate, proved by the authored target and ordered roots.
 * Callers must still compare the complete result and preserve their URL policy.
 * Ordinary read/export conversion never calls these target-directed repairs.
 */
export function zeroStartPresentation(source: string) {
  return planZeroStartPresentation(source, markdownStructure)
}

export function notionMarkdownForComparison(
  actual: string,
  target: string,
  boundaries?: readonly NotionBlockBoundary[],
) {
  if (!boundaries?.length) return
  const ids = new Set<string>()
  for (const block of boundaries) {
    if (!block.id || ids.has(block.id)) return
    ids.add(block.id)
  }
  const framed = codeFenceCandidate(
    actual,
    target,
    boundaries,
    markdownStructure,
    codeLanguage,
    positionedTokens,
    orderedRootProof,
  )
  const converted = fromNotionMarkdown(framed ?? actual, boundaries)
  const physical = physicalReadbackCandidate(
    converted,
    target,
    boundaries,
    markdownStructure,
    sameMarkdownStructure,
    (firstIndex, ranges) => {
      const original = positionedTokens(converted)
      return !!original && orderedRootProof(converted, original, boundaries)(firstIndex, ranges)
    },
    codeLanguage,
  )
  const zeroParagraphs = zeroStartParagraphReadbackCandidate(
    physical ?? converted,
    target,
    boundaries,
    markdownStructure,
    sameMarkdownStructure,
  )
  const divided = paragraphDividerCandidate(
    zeroParagraphs ?? physical ?? converted,
    target,
    boundaries,
    sameMarkdownStructure,
    inline,
    visibleInline,
    inlineText,
    positionedTokens,
    orderedRootProof,
  )
  const separated = paragraphNumberedReadbackCandidate(
    divided ?? zeroParagraphs ?? physical ?? converted,
    target,
    boundaries,
  )
  const linked = listBoldLinkReadbackCandidate(
    separated ?? divided ?? zeroParagraphs ?? physical ?? converted,
    target,
    boundaries,
  )
  const normalized = linked ?? separated ?? divided ?? zeroParagraphs ?? physical ?? converted
  const readback = positionedTokens(normalized)
  const wanted = positionedTokens(target)
  if (!readback || !wanted) return
  const proves = orderedRootProof(normalized, readback, boundaries)
  const zero = zeroStartPresentationCandidate(
    normalized,
    target,
    boundaries,
    markdownStructure,
    proves,
    sameMarkdownStructure,
  )
  if (zero !== undefined) return zero
  const edits = [
    ...setextEdits(target, readback, wanted, boundaries, proves),
    ...commentReadbackEdits(
      normalized,
      target,
      readback,
      wanted,
      boundaries,
      proves,
      inline,
      visibleInline,
    ),
    ...retainedOrderedStartEdits(normalized, target, readback, wanted, boundaries, proves),
    ...literalHtmlReadbackEdits(
      normalized,
      target,
      readback,
      wanted,
      boundaries,
      proves,
      retainedInline,
      leafListItem,
      originalListItemRanges,
      inline,
      inlineText,
    ),
    ...tableLiteralHtmlEdits(readback, wanted, boundaries, proves),
    ...physicalTableLiteralEdits(readback, wanted, boundaries, proves),
    ...boldLinkEdits(readback, wanted, boundaries, proves),
    ...physicalSpanReadbackEdits(normalized, readback, wanted, boundaries, proves),
    ...literalSingleTildeEdits(readback, wanted, boundaries, proves),
  ]
  for (const edit of literalHtmlBoundaryEdits(
    normalized,
    target,
    readback,
    wanted,
    boundaries,
    proves,
    leafListItem,
    originalListItemRanges,
  )) {
    // Existing narrow repairs keep their ranges if two mechanisms identify the
    // same literal. A partial collision cannot create a new comparison proof.
    if (!edits.some((previous) => previous.start < edit.end && edit.start < previous.end))
      edits.push(edit)
  }
  edits.sort((left, right) => left.start - right.start)
  if (!edits.length)
    return framed === undefined &&
      physical === undefined &&
      divided === undefined &&
      separated === undefined &&
      linked === undefined &&
      zeroParagraphs === undefined
      ? undefined
      : normalized
  for (let index = 1; index < edits.length; index++)
    if (edits[index]!.start < edits[index - 1]!.end) return
  let result = normalized
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

// A positive start greater than one cannot interrupt a CommonMark paragraph.
// Split only the exact original source pair when the second physical root
// retains that start. The proof uses ranges in the unchanged paragraph token.
function paragraphNumberedReadbackCandidate(
  markdown: string,
  target: string,
  boundaries: readonly NotionBlockBoundary[],
) {
  if (markdown.includes("\r") || target.includes("\r")) return
  const actual = positionedTokens(markdown),
    wanted = positionedTokens(target)
  if (!actual || !wanted) return
  const bindings: Array<{
    part: PositionedToken
    paragraph: PositionedToken
    list: PositionedToken
    rootIndex: number
    sourceIndex: number
  }> = []
  for (const [sourceIndex, sourcePart] of wanted.entries()) {
    const list = sourcePart.token,
      previous = wanted[sourceIndex - 1]?.token
    if (
      list.type !== "list" ||
      !list.ordered ||
      typeof list.start !== "number" ||
      list.start <= 1 ||
      !Number.isSafeInteger(list.start) ||
      list.items.length !== 1 ||
      !leafListItem(list.items[0]!) ||
      previous?.type !== "paragraph" ||
      previous.text.includes("\n") ||
      previous.raw.replace(/\n+$/, "") !== previous.text
    )
      continue
    const item = list.items[0]!,
      sourceRaw = item.raw.replace(/\n+$/, "")
    if (
      list.raw !== item.raw ||
      !new RegExp(`^${list.start}[.)] `).test(sourceRaw) ||
      sourceRaw.slice(String(list.start).length + 2) !== item.text
    )
      continue
    const joined = previous.text + "\n" + sourceRaw
    const parts = actual.filter(
      ({ token }) =>
        token.type === "paragraph" &&
        token.text === joined &&
        /^\n*$/.test(token.raw.slice(joined.length)),
    )
    const roots = boundaries.flatMap((block, index) => {
      const next = boundaries[index + 1]
      return block.type === "paragraph" &&
        !block.has_children &&
        next?.type === "numbered_list_item" &&
        !next.has_children &&
        next.numbered_list?.start === list.start &&
        JSON.stringify(retainedInline(block)) ===
          JSON.stringify(inline(previous.text, previous.tokens)) &&
        JSON.stringify(retainedInline(next)) === JSON.stringify(inline(item.text))
        ? [index]
        : []
    })
    if (parts.length !== 1 || roots.length !== 1) continue
    const part = parts[0]!,
      start = part.start + previous.text.length + 1
    const parsed = positionedTokens(markdown.slice(start, part.end))
    if (
      parsed?.length !== 1 ||
      parsed[0]!.token.type !== "list" ||
      parsed[0]!.start !== 0 ||
      parsed[0]!.end !== part.end - start
    )
      continue
    bindings.push({
      part,
      sourceIndex,
      rootIndex: roots[0]!,
      paragraph: {
        start: part.start,
        end: start - 1,
        token: {
          type: "paragraph",
          raw: previous.text,
          text: previous.text,
          tokens: Lexer.lexInline(previous.text),
        },
      },
      list: { token: parsed[0]!.token, start, end: part.end },
    })
  }
  if (
    !bindings.length ||
    new Set(bindings.map((binding) => binding.part)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.rootIndex)).size !== bindings.length
  )
    return
  const positions = actual.flatMap((part) => {
    const binding = bindings.find((entry) => entry.part === part)
    return binding ? [binding.paragraph, binding.list] : [part]
  })
  const proves = orderedRootProof(markdown, positions, boundaries)
  const proven = bindings.filter((binding) =>
    proves(binding.rootIndex, [binding.paragraph, binding.list]),
  )
  if (!proven.length) return
  let candidate = markdown
  for (const binding of proven.sort((left, right) => right.paragraph.end - left.paragraph.end))
    candidate =
      candidate.slice(0, binding.paragraph.end) + "\n" + candidate.slice(binding.paragraph.end)
  return candidate
}

interface BulletInlineRange extends SourceRange {
  readonly textStart: number
  readonly text: string
  readonly tokens: readonly Token[]
}

// Only complete single-line leaf bullet items participate. Preserve the marker,
// original token bytes, and every following inline token for the later edit.
function bulletInlineRanges(markdown: string, roots: readonly PositionedToken[]) {
  const result: BulletInlineRange[] = []
  for (const root of roots) {
    if (root.token.type !== "list" || root.token.ordered) continue
    let offset = root.start
    for (const item of root.token.items) {
      const start = markdown.indexOf(item.raw, offset)
      if (start < offset || start + item.raw.length > root.end) break
      offset = start + item.raw.length
      const block = item.tokens[0]
      if (
        item.task ||
        item.tokens.length !== 1 ||
        !block ||
        (block.type !== "text" && block.type !== "paragraph") ||
        !block.tokens ||
        block.text !== item.text ||
        item.text.includes("\n") ||
        block.tokens.map((token: Token) => token.raw).join("") !== item.text
      )
        continue
      const prefix = /^ {0,3}[-+*][ \t]+/.exec(item.raw)?.[0]
      if (
        !prefix ||
        !item.raw.startsWith(prefix + item.text) ||
        !/^\n*$/.test(item.raw.slice(prefix.length + item.text.length))
      )
        continue
      result.push({
        start,
        end: offset,
        textStart: start + prefix.length,
        text: item.text,
        tokens: block.tokens,
      })
    }
  }
  return result
}

function exactTextCodePieces(tokens: readonly Token[]) {
  const pieces: unknown[] = []
  for (const token of tokens) {
    if (token.type === "text" && token.raw === token.text) {
      if (!token.text) continue
      const previous = pieces.at(-1)
      if (typeof previous === "string") pieces[pieces.length - 1] = previous + token.text
      else pieces.push(token.text)
    } else if (token.type === "codespan") pieces.push(["code", token.text])
    else return
  }
  return pieces
}

function exactPlainCodeTail(spans: readonly NotionTextSpan[]) {
  const pieces: unknown[] = []
  for (const span of spans) {
    if (span.bold || span.link !== null || !span.text) return
    if (span.code) pieces.push(["code", span.text])
    else {
      const previous = pieces.at(-1)
      if (typeof previous === "string") pieces[pieces.length - 1] = previous + span.text
      else pieces.push(span.text)
    }
  }
  return pieces
}

interface ListBoldLinkBinding {
  readonly range: BulletInlineRange
  readonly rootIndex: number
  readonly sourceIndex: number
  readonly replacement: string
}

// Original rich-text annotations and the complete inline-code tail bind exactly
// two readback delimiters. The whole candidate still uses the caller's URL policy.
function listBoldLinkReadbackCandidate(
  markdown: string,
  target: string,
  boundaries?: readonly NotionBlockBoundary[],
) {
  if (!boundaries?.length || markdown.includes("\r") || target.includes("\r")) return
  if (
    boundaries.some((block) => !block.id) ||
    new Set(boundaries.map((block) => block.id)).size !== boundaries.length
  )
    return
  const actual = positionedTokens(markdown),
    wanted = positionedTokens(target)
  if (!actual || !wanted) return
  const actualItems = bulletInlineRanges(markdown, actual)
  const sourceItems = bulletInlineRanges(target, wanted)
  const bindings: ListBoldLinkBinding[] = []
  for (const range of actualItems) {
    const [link, rest] = range.tokens
    if (
      link?.type !== "link" ||
      link.title != null ||
      rest?.type !== "text" ||
      rest.raw !== rest.text ||
      !link.tokens?.length
    )
      continue
    const labels =
      link.tokens.length === 1 && link.tokens[0]!.type === "strong"
        ? link.tokens[0]!.tokens
        : link.tokens
    if (
      !labels?.length ||
      !labels.every((token) => token.type === "text" && token.raw === token.text)
    )
      continue
    const label = labels.map((token) => token.raw).join("")
    const split = /^\*\*([ \t]+[^*`\\\r\n]+\S)\*\*([\s\S]*)$/.exec(rest.raw)
    if (!split) continue
    const actualTail = exactTextCodePieces([
      { type: "text", raw: split[2]!, text: split[2]! },
      ...range.tokens.slice(2),
    ])
    if (!actualTail) continue
    const matches: ListBoldLinkBinding[] = []
    for (const [rootIndex, block] of boundaries.entries()) {
      const spans = block.rich_text
      if (block.type !== "bulleted_list_item" || block.has_children || !spans || spans.length < 3)
        continue
      const [first, second] = spans
      if (
        !first!.bold ||
        first!.code ||
        typeof first!.link !== "string" ||
        !second!.bold ||
        second!.code ||
        second!.link !== null ||
        first!.text !== label ||
        second!.text !== split[1] ||
        !sameSerializedUrl(link.href, first!.link)
      )
        continue
      const originalTail = exactPlainCodeTail(spans.slice(2))
      if (!originalTail || JSON.stringify(originalTail) !== JSON.stringify(actualTail)) continue
      for (const [sourceIndex, source] of sourceItems.entries()) {
        const strong = source.tokens[0]
        if (
          strong?.type !== "strong" ||
          !strong.tokens?.length ||
          !strong.tokens.every((token) => token.type === "text" && token.raw === token.text) ||
          strong.text !== first!.text + second!.text
        )
          continue
        const sourceTail = exactTextCodePieces(source.tokens.slice(1))
        if (!sourceTail || JSON.stringify(sourceTail) !== JSON.stringify(originalTail)) continue
        matches.push({
          range,
          rootIndex,
          sourceIndex,
          replacement:
            link.raw +
            split[1] +
            split[2] +
            range.tokens
              .slice(2)
              .map((token) => token.raw)
              .join(""),
        })
      }
    }
    if (matches.length === 1) bindings.push(matches[0]!)
  }
  if (!bindings.length) return
  if (
    new Set(bindings.map((binding) => binding.rootIndex)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.sourceIndex)).size !== bindings.length
  )
    return
  // Locations and neighbors are proved in the unchanged readback. No corrected
  // list item participates in the structural inventory used to authorize itself.
  const proves = orderedRootProof(markdown, actual, boundaries)
  const proven = bindings.filter((binding) => proves(binding.rootIndex, [binding.range]))
  if (!proven.length) return
  let candidate = markdown
  for (const binding of [...proven].sort(
    (left, right) => right.range.textStart - left.range.textStart,
  )) {
    const { range } = binding
    candidate =
      candidate.slice(0, range.textStart) +
      binding.replacement +
      candidate.slice(range.textStart + range.text.length)
  }
  return candidate
}

interface SerializedTableCell extends SourceRange {
  readonly text: string
}

// Accept only the complete Notion table wrapper already understood by blocks().
// Literal source tags remain escaped inside its <td> content at this point.
function positionedHtmlTable(raw: string) {
  if (raw.includes("\r")) return
  const open = /^<table(?: header-row="true")?>[ \t]*\n/.exec(raw)
  if (!open) return
  let offset = open[0].length
  const rows: SerializedTableCell[][] = []
  const whitespace = () => {
    const match = /^[ \t\n]*/.exec(raw.slice(offset))!
    offset += match[0].length
  }
  whitespace()
  while (raw.startsWith("<tr>", offset)) {
    offset += 4
    whitespace()
    const cells: SerializedTableCell[] = []
    while (raw.startsWith("<td>", offset)) {
      const start = offset + 4,
        end = raw.indexOf("</td>", start)
      if (end < 0) return
      const content = raw.slice(start, end),
        leading = content.length - content.trimStart().length
      cells.push({
        start: start + leading,
        end: start + content.trimEnd().length,
        text: content.trim(),
      })
      offset = end + 5
      whitespace()
    }
    if (!cells.length || !raw.startsWith("</tr>", offset)) return
    rows.push(cells)
    offset += 5
    whitespace()
  }
  if (!rows.length || !/^<\/table>[ \t]*\n*$/.test(raw.slice(offset))) return
  return rows
}

function escapedLiteralTable(table: Pick<Tokens.Table, "header" | "rows">) {
  const rows: { text: string; escapes: number[] }[][] = []
  let htmlCount = 0
  for (const row of [table.header, ...table.rows]) {
    const cells: { text: string; escapes: number[] }[] = []
    for (const cell of row) {
      if (cell.tokens.map((token) => token.raw).join("") !== cell.text) return
      let text = ""
      const escapes: number[] = []
      for (const token of cell.tokens) {
        if (token.type === "html") {
          // Declarations, breaks and structural table tags are outside this
          // literal-only proof. Attributes and destinations stay byte-for-byte.
          if (
            token.text !== token.raw ||
            token.block === true ||
            !/^<\/?[A-Za-z][^<>\r\n]*>$/.test(token.raw) ||
            /^<\/?(?:br|table|tr|td|th)(?:[ \t/>])/i.test(token.raw)
          )
            return
          const escaped = `\\${token.raw.slice(0, -1)}\\>`
          escapes.push(text.length, text.length + escaped.length - 2)
          text += escaped
          htmlCount++
        } else {
          if (token.type !== "text" && token.type !== "escape") return
          if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length) return
          // Notion escapes angle characters in ordinary literal text as well.
          // Bind those exact bytes, but retain their escapes in the candidate.
          text +=
            token.type === "text"
              ? token.raw.replaceAll("<", "\\<").replaceAll(">", "\\>")
              : token.raw
        }
      }
      cells.push({ text, escapes })
    }
    rows.push(cells)
  }
  return htmlCount
    ? { rows, signature: JSON.stringify(rows.map((row) => row.map((cell) => cell.text))) }
    : undefined
}

function tableLiteralHtmlEdits(
  actual: readonly PositionedToken[],
  wanted: readonly PositionedToken[],
  boundaries: readonly NotionBlockBoundary[],
  proves: ReturnType<typeof orderedRootProof>,
) {
  const source = wanted.flatMap((part) => {
    if (
      part.token.type !== "table" ||
      !Array.isArray(part.token.header) ||
      !Array.isArray(part.token.rows)
    )
      return []
    const plan = escapedLiteralTable({ header: part.token.header, rows: part.token.rows })
    return plan ? [{ part, plan }] : []
  })
  const readback = actual.flatMap((part) => {
    if (part.token.type !== "html") return []
    const rows = positionedHtmlTable(part.token.raw)
    return rows
      ? [{ part, rows, signature: JSON.stringify(rows.map((row) => row.map((cell) => cell.text))) }]
      : []
  })
  const roots = boundaries.flatMap((block, index) =>
    block.type === "table" ? [{ block, index }] : [],
  )
  if (!roots.length || readback.length !== roots.length) return []
  const edits: ComparisonEdit[] = []
  for (const { plan } of source) {
    if (source.filter((item) => item.plan.signature === plan.signature).length !== 1) continue
    const matches = readback.flatMap((item, index) =>
      item.signature === plan.signature ? [{ ...item, index }] : [],
    )
    if (matches.length !== 1) continue
    const match = matches[0]!,
      root = roots[match.index]!
    if (!root.block.has_children || !proves(root.index, [match.part])) continue
    for (const [rowIndex, row] of plan.rows.entries())
      for (const [column, cell] of row.entries()) {
        const observed = match.rows[rowIndex]![column]!
        for (const escape of cell.escapes) {
          const start = match.part.start + observed.start + escape
          edits.push({ start, end: start + 1, text: "" })
        }
      }
  }
  return edits
}
