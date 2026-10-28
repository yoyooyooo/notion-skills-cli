import { createHash } from "node:crypto"
import { Lexer, type Token, type Tokens } from "marked"
import { fail, property, type Snapshot } from "./model.ts"
import { importDocument } from "./import.ts"
import { fromNotionMarkdown, projectNotionBlockTree, samePublishedMarkdown } from "./markdown.ts"
import { markdownRichText, markdownTableCells } from "./markdown-blocks.ts"
import { canonical } from "./publication-effect-proof.ts"
import type { PortableSkill } from "./portable.ts"
import {
  sourceRichTextRepairInlineMatches,
  sourceRichTextRepairTableMatches,
} from "./source-rich-text-repair-readback.ts"
import { publicationSourceDestination } from "./publication-markdown.ts"

export type SourceRichTextRepairKind = "literal_file_line_link" | "literal_dollar_equation"
export interface SourceRichTextRepairEffect {
  readonly kind: SourceRichTextRepairKind
  readonly block_id: string
  readonly ancestor_ids: readonly string[]
  readonly source_path: string
  readonly source_sha256: string
  readonly source_leaf_sha256: string
  readonly source_root_index: number
  readonly source_item_index?: number
  readonly source_row_index?: number
  readonly request: { readonly path: string; readonly method: "PATCH"; readonly body: unknown }
  readonly before_block: unknown
  readonly after_block: unknown
  readonly proposed_markdown_sha256: string
}

const refused = (message: string) => fail("SOURCE_RICH_TEXT_REPAIR_REFUSED", message)
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
const annotations = ["bold", "italic", "strikethrough", "underline", "code"] as const
interface AnnotationStyle {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly underline: boolean
  readonly code: boolean
  readonly color: string
}
function style(value: unknown): AnnotationStyle {
  const raw = property(value)
  if (
    !keys(raw, [...annotations, "color"]) ||
    annotations.some((key) => raw[key] !== undefined && typeof raw[key] !== "boolean") ||
    (raw.color !== undefined && typeof raw.color !== "string")
  )
    throw refused("A rich-text annotation is not completely understood.")
  return {
    bold: raw.bold === true,
    italic: raw.italic === true,
    strikethrough: raw.strikethrough === true,
    underline: raw.underline === true,
    code: raw.code === true,
    color: raw.color ?? "default",
  }
}
function richText(value: unknown) {
  const rich = property(value),
    text = property(rich.text)
  if (
    rich.type !== "text" ||
    !keys(rich, ["type", "text", "annotations", "plain_text", "href"]) ||
    !keys(text, ["content", "link"]) ||
    typeof text.content !== "string" ||
    (rich.plain_text !== undefined && rich.plain_text !== text.content)
  )
    throw refused("A complete literal text span is required.")
  const link = text.link == null ? null : property(text.link)
  if (
    (link !== null && (typeof link.url !== "string" || !keys(link, ["url"]))) ||
    (rich.href !== undefined && rich.href !== (link?.url ?? null))
  )
    throw refused("A physical text destination is inconsistent.")
  return {
    content: text.content,
    url: link?.url as string | undefined,
    annotations: style(rich.annotations),
  }
}
interface LiteralText {
  readonly content: string
  readonly url?: string
  readonly annotations: AnnotationStyle
}
function normalizedText(values: readonly unknown[]) {
  const result: LiteralText[] = []
  for (const value of values) {
    const current = richText(value),
      previous = result.at(-1)
    if (
      previous &&
      previous.url === current.url &&
      equal(previous.annotations, current.annotations)
    )
      result[result.length - 1] = { ...previous, content: previous.content + current.content }
    else result.push(current)
  }
  return result
}
function writable(values: readonly unknown[]) {
  return values.map((value) => {
    const item = richText(value)
    return {
      type: "text" as const,
      text: { content: item.content, ...(item.url ? { link: { url: item.url } } : {}) },
      annotations: item.annotations,
    }
  })
}
function readback(values: readonly unknown[]) {
  return values.map((value) => {
    const item = richText(value)
    return {
      type: "text",
      text: { content: item.content, link: item.url ? { url: item.url } : null },
      annotations: item.annotations,
      plain_text: item.content,
      href: item.url ?? null,
    }
  })
}

/** Retain the complete ordered DFS inventory, including unprojected blocks. */
export function sourceRichTextRepairBlocks(page: string, raw: Readonly<Record<string, unknown>>) {
  const roots: Record<string, unknown>[] = [],
    all: Record<string, unknown>[] = [],
    ids = new Set([page])
  const children = new Map<string, Record<string, unknown>[]>()
  function visit(owner: string, depth: number) {
    if (depth > 32) throw refused("The repair graph is too deep.")
    const rows: Record<string, unknown>[] = [],
      cursors = new Set<string>()
    let cursor: string | undefined
    for (let count = 0; count < 1000; count++) {
      const path = `v1/blocks/${owner}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
      const response = property(raw[path])
      if (!Array.isArray(response.results) || typeof response.has_more !== "boolean")
        throw refused("A complete physical inventory is required.")
      for (const value of response.results) {
        const block = property(value),
          parent = property(block.parent)
        if (
          typeof block.id !== "string" ||
          ids.has(block.id) ||
          typeof block.type !== "string" ||
          typeof block.has_children !== "boolean" ||
          block.archived === true ||
          block.in_trash === true ||
          parent.type !== (owner === page ? "page_id" : "block_id") ||
          parent[String(parent.type)] !== owner ||
          ["child_page", "child_database", "synced_block"].includes(block.type)
        )
          throw refused(
            "Single-leaf repair requires one closed root page with no child or shared pages.",
          )
        ids.add(block.id)
        rows.push(block)
        all.push(block)
        if (owner === page) roots.push(block)
        if (all.length > 4096) throw refused("The complete repair inventory is too large.")
        if (block.has_children) visit(block.id, depth + 1)
      }
      if (!response.has_more) {
        if (response.next_cursor != null) throw refused("An inventory has a nonterminal cursor.")
        children.set(owner, rows)
        return
      }
      if (
        typeof response.next_cursor !== "string" ||
        !response.next_cursor ||
        cursors.has(response.next_cursor)
      )
        throw refused("An inventory cursor is missing or repeated.")
      cursor = response.next_cursor
      cursors.add(cursor)
    }
    throw refused("The complete repair inventory did not terminate.")
  }
  visit(page, 0)
  return { roots, all, children }
}

interface Positioned {
  readonly token: Token
  readonly start: number
  readonly end: number
}
/** The complete documented Notion table wrapper already handled by the native
 * Markdown reader. No other HTML node can stand in for a physical table. */
function serializedTable(raw: string): Tokens.Table | undefined {
  const opened = /^<table(?: header-row="true")?>[ \t]*\n/.exec(raw)
  if (!opened || raw.includes("\r")) return
  let offset = opened[0].length
  const rows: string[][] = []
  const whitespace = () => {
    offset += /^[ \t\n]*/.exec(raw.slice(offset))![0].length
  }
  whitespace()
  while (raw.startsWith("<tr>", offset)) {
    offset += 4
    whitespace()
    const row: string[] = []
    while (raw.startsWith("<td>", offset)) {
      const start = offset + 4,
        end = raw.indexOf("</td>", start)
      if (end < 0) return
      const content = raw.slice(start, end)
      if (/<\/?(?:table|tr|td|th)\b/i.test(content)) return
      row.push(content.trim())
      offset = end + 5
      whitespace()
    }
    if (!row.length || !raw.startsWith("</tr>", offset)) return
    rows.push(row)
    offset += 5
    whitespace()
  }
  if (
    !rows.length ||
    !raw.startsWith("</table>", offset) ||
    rows.some((row) => row.length !== rows[0]!.length)
  )
    return
  offset += "</table>".length
  const cells = rows.map((row, index) =>
    row.map((text) => ({ text, tokens: Lexer.lexInline(text), header: index === 0, align: null })),
  )
  return {
    type: "table",
    raw: raw.slice(0, offset),
    align: rows[0]!.map(() => null),
    header: cells[0]!,
    rows: cells.slice(1),
  }
}
function positioned(markdown: string): Positioned[] {
  const tokens = Lexer.lex(markdown),
    result: Positioned[] = []
  let offset = 0
  for (const token of tokens) {
    if (
      typeof token.raw !== "string" ||
      markdown.slice(offset, offset + token.raw.length) !== token.raw
    )
      throw refused("The complete Markdown token ranges are ambiguous.")
    const table = token.type === "html" ? serializedTable(token.raw) : undefined
    if (table) {
      result.push({ token: table, start: offset, end: offset + table.raw.length })
      const tail = token.raw.slice(table.raw.length)
      result.push(
        ...positioned(tail).map((item) => ({
          ...item,
          start: item.start + offset + table.raw.length,
          end: item.end + offset + table.raw.length,
        })),
      )
    } else if (token.type !== "space" && token.type !== "def")
      result.push({ token, start: offset, end: offset + token.raw.length })
    offset += token.raw.length
  }
  if (offset !== markdown.length)
    throw refused("The Markdown token ranges do not cover the complete body.")
  return result
}
interface RootLeaf {
  readonly token_index: number
  readonly item_index?: number
  readonly type: string
  readonly paragraph_group?: true
}
function rootLeaves(tokens: readonly Positioned[]): RootLeaf[] {
  return tokens.flatMap(({ token }, token_index): RootLeaf[] => {
    if (token.type === "list")
      return token.items.map((item: Tokens.ListItem, item_index: number) => ({
        token_index,
        item_index,
        type: item.task ? "to_do" : token.ordered ? "numbered_list_item" : "bulleted_list_item",
      }))
    const type =
      token.type === "heading"
        ? `heading_${token.depth}`
        : token.type === "hr"
          ? "divider"
          : token.type === "blockquote"
            ? "quote"
            : token.type
    if (
      !["paragraph", "divider", "quote", "code", "table"].includes(type) &&
      !/^heading_[1-6]$/.test(type)
    )
      throw fail(
        "SOURCE_RICH_TEXT_REPAIR_REFUSED",
        "The whole-page physical root correspondence contains an unsupported Markdown block.",
        { token_type: token.type, root_index: token_index },
      )
    return [{ token_index, type }]
  })
}
function assertRoots(tokens: readonly Positioned[], roots: readonly Record<string, unknown>[]) {
  const leaves = rootLeaves(tokens)
  if (
    leaves.length !== roots.length ||
    leaves.some((leaf, index) => leaf.type !== roots[index]!.type)
  )
    throw refused("The complete Markdown root order does not match the physical inventory.")
  return leaves
}
/** Notion serializes adjacent physical paragraphs with one LF. The existing
 * native Markdown comparator coalesces those paragraphs too. Preserve every
 * physical/source root while proving each entire observed paragraph group;
 * an individual repair cannot select an ambiguous paragraph in such a group. */
function observedRoots(
  page: string,
  tokens: readonly Positioned[],
  source: readonly Positioned[],
  sourceRoots: readonly RootLeaf[],
  roots: readonly Record<string, unknown>[],
  portable: PortableSkill,
  selected: string,
) {
  const actual = rootLeaves(tokens),
    result: RootLeaf[] = []
  let physical = 0,
    observed = 0
  while (physical < roots.length) {
    const wanted = roots[physical]!,
      current = actual[observed]
    if (!current || current.type !== wanted.type)
      throw refused(
        "The complete observed Markdown root order differs from the physical inventory.",
      )
    if (wanted.type !== "paragraph") {
      result.push(current)
      physical++
      observed++
      continue
    }
    const start = physical,
      first = observed
    while (roots[physical]?.type === "paragraph") physical++
    while (actual[observed]?.type === "paragraph") observed++
    const actualParts = actual.slice(first, observed),
      physicalParts = roots.slice(start, physical)
    const sourceParts = sourceRoots.slice(start, physical)
    if (
      sourceParts.some((part) => part.type !== "paragraph") ||
      actualParts.length > physicalParts.length ||
      (physicalParts.length > 1 && physicalParts.some((block) => block.has_children !== false))
    )
      throw refused("The complete paragraph group has no bounded physical correspondence.")
    const actualMarkdown = actualParts.map((part) => tokens[part.token_index]!.token.raw).join("\n")
    const sourceMarkdown = sourceParts.map((part) => source[part.token_index]!.token.raw).join("\n")
    const boundaries = projectNotionBlockTree(page, physicalParts)
    // The one selected, ungrouped paragraph is checked against its complete
    // physical BEFORE spans below, because its intended error is not equivalent.
    const selectedLeaf =
      physicalParts.length === 1 && actualParts.length === 1 && physicalParts[0]!.id === selected
    if (
      !boundaries ||
      (!selectedLeaf &&
        !samePublishedMarkdown(
          actualMarkdown,
          sourceMarkdown,
          publicationSourceDestination({ path: portable.main, files: portable.files }, boundaries),
          boundaries,
        ))
    )
      throw refused("A complete observed paragraph group differs from the original frozen source.")
    for (let index = start; index < physical; index++)
      result.push({
        ...current,
        ...(physicalParts.length !== 1 || actualParts.length !== 1
          ? { paragraph_group: true as const }
          : {}),
      })
  }
  if (observed !== actual.length || result.length !== roots.length)
    throw refused("The complete observed Markdown has extra or missing physical roots.")
  return result
}
/** One ordinary leaf. A multiline currency leaf is admitted only when every
 * break is a source LF whose physical readback is the exact `<br>` serializer
 * form. CRLF and any other break stay outside this repair. */
function inline(token: Token, item?: number) {
  if (item !== undefined) {
    if (token.type !== "list" || token.items[item]?.task)
      throw refused("The selected source is not an ordinary list item.")
    const selected = token.items[item]!
    const parts = selected.tokens.filter((token: Token) => token.type !== "space")
    if (
      parts.length !== 1 ||
      !["text", "paragraph"].includes(parts[0]!.type) ||
      selected.text.includes("\r") ||
      selected.raw.includes("\r")
    )
      throw refused("Only one complete ordinary source leaf is supported.")
    return {
      text: selected.text,
      tokens: parts[0]!.tokens ?? Lexer.lexInline(selected.text),
      raw: selected.raw,
    }
  }
  if (
    token.type !== "paragraph" ||
    !Array.isArray(token.tokens) ||
    token.text.includes("\r") ||
    token.raw.includes("\r")
  )
    throw refused("Only one complete ordinary paragraph is supported.")
  return { text: token.text, tokens: token.tokens, raw: token.raw }
}
function bareHost(url: string, label: string) {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(label)) return false
  const match = /^https?:\/\/([^/:?#@\\\s]+)\/?$/i.exec(url)
  return !!match && match[1]!.toLowerCase() === label.toLowerCase()
}
function markedText(content: string, value: AnnotationStyle, breaks: "serializer") {
  if (value.underline || value.color !== "default" || content.includes("\r"))
    throw refused("The literal repair does not support extra styling or carriage returns.")
  let result = breaks === "serializer" ? content.replaceAll("\n", "<br>") : content
  if (value.code) {
    if (content.includes("`"))
      throw refused("This equation repair cannot rewrite literal backtick spans.")
    result = `\`${result}\``
  }
  if (value.bold) result = `**${result}**`
  if (value.italic) result = `*${result}*`
  if (value.strikethrough) result = `~~${result}~~`
  return result
}
/** Recover one finite dollar-parser error. The physical expression is inserted
 * between its two source dollar signs. A backticked expression keeps its body,
 * including outer spaces; a currency expression is the exact trimmed interval
 * and contains none. Source line breaks compare in the physical `<br>` form. */
function equationLiteral(values: readonly unknown[], expected: readonly unknown[]) {
  const destinations = new Set(
    expected.map(richText).flatMap((item) => (item.url ? [item.url] : [])),
  )
  let equations = 0,
    expression = "",
    generated = 0,
    result = ""
  for (const raw of values) {
    const value = property(raw)
    if (value.type === "equation") {
      const body = property(value.equation),
        format = style(value.annotations)
      const current = typeof body.expression === "string" ? body.expression : ""
      const currency = !current.includes("`")
      if (
        ++equations !== 1 ||
        !keys(value, ["type", "equation", "annotations", "plain_text", "href"]) ||
        !keys(body, ["expression"]) ||
        !current ||
        /[\r\n$]/.test(current) ||
        (currency ? current !== current.trim() : !current.trim()) ||
        (value.plain_text !== undefined && value.plain_text !== current) ||
        value.href != null ||
        !equal(format, style({}))
      )
        throw refused("The physical equation is not the supported literal dollar interval.")
      expression = current
      result += `$${current}$`
      continue
    }
    const item = richText(value)
    let content = markedText(item.content, item.annotations, "serializer")
    if (item.url) {
      if (destinations.has(item.url)) {
        if (/[\[\]\n]/.test(item.content) || /[()\s]/.test(item.url))
          throw refused("The explicit link cannot be reconstructed exactly.")
        content = `[${content}](${item.url})`
      } else if (bareHost(item.url, item.content) && !item.annotations.code && generated++ < 8) {
        // This is a proposed removal of an actual unwanted link. Exact equality
        // to the whole original leaf below is required; it is never normalisation.
      } else throw refused("An external destination is not explained by the frozen literal source.")
    }
    result += content
  }
  if (equations !== 1 || !result.includes(`$${expression}$`))
    throw refused("Exactly one physical equation is required.")
  return result
}
function replaceLeaf(markdown: string, at: Positioned, item: number | undefined, source: string) {
  const serialized = source.includes("\n") ? source.replaceAll("\n", "<br>") : source
  if (serialized.includes("\r"))
    throw refused("The repaired leaf cannot contain a carriage return.")
  if (item === undefined)
    return (
      markdown.slice(0, at.start) +
      serialized +
      at.token.raw.slice(at.token.raw.trimEnd().length) +
      markdown.slice(at.end)
    )
  if (at.token.type !== "list") throw refused("The observed target is not a list.")
  const selected = at.token.items[item]!
  const prefix = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)/.exec(selected.raw)
  const suffix = /\r?\n?$/.exec(selected.raw)?.[0] ?? ""
  const body = selected.raw.slice(prefix?.[1]?.length ?? 0, selected.raw.length - suffix.length)
  if (!prefix || body !== selected.text || selected.raw.includes("\r"))
    throw refused("The observed leaf range is not one complete ordinary list item.")
  const offset = at.token.raw.indexOf(selected.raw)
  if (offset < 0 || at.token.raw.indexOf(selected.raw, offset + 1) !== -1)
    throw refused("The observed leaf occurs more than once in its list.")
  const start = at.start + offset
  return (
    markdown.slice(0, start) +
    prefix[1] +
    serialized +
    suffix +
    markdown.slice(start + selected.raw.length)
  )
}

/** Derive one proposed whole-field effect. The actual capture stays untouched.
 * The caller must separately prove this proposed whole body, then run the
 * original strict live proof after a real request before reporting success. */
export function deriveSourceRichTextRepair(
  portable: PortableSkill,
  page: string,
  raw: Readonly<Record<string, unknown>>,
  snapshot: Snapshot,
  selection: { readonly kind: SourceRichTextRepairKind; readonly block_id: string },
) {
  const main = portable.files.find((file) => file.path === portable.main)
  if (
    !main ||
    snapshot.references?.length !== 1 ||
    snapshot.references[0]!.id !== page ||
    portable.files.some(
      (file) => file.path !== portable.main && /^references\/.+\.md$/i.test(file.path),
    )
  )
    throw refused("Single-leaf repair requires exactly the original root authored page.")
  const root = snapshot.references[0]!,
    inventory = sourceRichTextRepairBlocks(page, raw)
  const observedMarkdown = property(raw[`v1/pages/${page}/markdown`])
  if (
    observedMarkdown.id !== page ||
    observedMarkdown.truncated !== false ||
    !Array.isArray(observedMarkdown.unknown_block_ids) ||
    observedMarkdown.unknown_block_ids.length !== 0 ||
    typeof observedMarkdown.markdown !== "string" ||
    root.markdown !== observedMarkdown.markdown ||
    !equal(root.blocks, projectNotionBlockTree(page, inventory.all))
  )
    throw refused(
      "The selected Markdown and physical projection are not the exact complete captured root.",
    )
  const block = inventory.all.find((block) => block.id === selection.block_id)
  if (!block || block.has_children !== false)
    throw refused("The repair must select one existing leaf block.")
  const source = importDocument(main, portable).body.replace(/\r\n/g, "\n")
  const converted = fromNotionMarkdown(root.markdown, root.blocks)
  const sourceTokens = positioned(source),
    actualTokens = positioned(converted)
  const sourceRoots = assertRoots(sourceTokens, inventory.roots)
  const actualRoots = observedRoots(
    page,
    actualTokens,
    sourceTokens,
    sourceRoots,
    inventory.roots,
    portable,
    selection.block_id,
  )
  let body: unknown, after: Record<string, unknown>, projected: string, sourceLeaf: string
  let rootIndex: number, itemIndex: number | undefined, rowIndex: number | undefined
  const ancestors = [page]
  if (selection.kind === "literal_file_line_link") {
    const parent = property(block.parent)
    const tableIndex = inventory.roots.findIndex(
      (table) => table.id === parent.block_id && table.type === "table",
    )
    if (block.type !== "table_row" || parent.type !== "block_id" || tableIndex < 0)
      throw refused("The literal link must be inside one root table row.")
    const table = inventory.roots[tableIndex]!,
      rows = inventory.children.get(String(table.id))!
    const wanted = sourceTokens[sourceRoots[tableIndex]!.token_index]!.token
    const observed = actualTokens[actualRoots[tableIndex]!.token_index]!
    if (
      wanted.type !== "table" ||
      observed.token.type !== "table" ||
      !rows ||
      rows.some((row) => row.type !== "table_row" || row.has_children)
    )
      throw refused("The complete table correspondence is unavailable.")
    if (
      !sourceRichTextRepairTableMatches(
        observed.token.raw,
        rows.map((row) => property(row.table_row).cells),
      )
    )
      throw refused(
        "Every actual Markdown table cell must agree with its complete physical before-image.",
      )
    const cells = [wanted.header, ...wanted.rows]
    rowIndex = rows.findIndex((row) => row.id === block.id)
    if (
      rows.length !== cells.length ||
      rowIndex < 0 ||
      property(table.table).table_width !== wanted.header.length
    )
      throw refused("The physical table shape differs from the original source.")
    let removals = 0
    const repaired = structuredClone(property(block.table_row).cells)
    if (!Array.isArray(repaired) || repaired.some((cell) => !Array.isArray(cell)))
      throw refused("The target row is incomplete.")
    for (const cell of repaired)
      for (const value of cell) {
        const item = richText(value)
        if (
          item.content === "file:line" &&
          item.url === "file://line" &&
          equal(item.annotations, style({}))
        ) {
          property(value).text = { ...property(property(value).text), link: null }
          property(value).href = null
          removals++
        }
      }
    if (removals !== 1) throw refused("Exactly one unintended file:line link is required.")
    for (const [index, row] of rows.entries()) {
      const actual = index === rowIndex ? repaired : property(row.table_row).cells
      const expected = markdownTableCells(cells[index]!)
      if (
        !Array.isArray(actual) ||
        actual.length !== expected.length ||
        actual.some(
          (cell, column) =>
            !Array.isArray(cell) || !equal(normalizedText(cell), normalizedText(expected[column]!)),
        )
      )
        throw refused(
          "A table cell contains another content, annotation or destination difference.",
        )
    }
    const payload = repaired.map((cell) => writable(cell))
    body = { table_row: { cells: payload } }
    after = {
      ...structuredClone(block),
      table_row: { ...property(block.table_row), cells: payload.map(readback) },
    }
    projected = converted.slice(0, observed.start) + wanted.raw + converted.slice(observed.end)
    rootIndex = sourceRoots[tableIndex]!.token_index
    sourceLeaf = canonical(cells[rowIndex]!.map((cell: Tokens.TableCell) => cell.text))
    ancestors.push(String(table.id))
  } else {
    if (
      !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(String(block.type)) ||
      property(block.parent).page_id !== page
    )
      throw refused("A literal equation repair must be one ordinary root leaf.")
    const physicalIndex = inventory.roots.findIndex((item) => item.id === block.id)
    const wantedRoot = sourceRoots[physicalIndex]!,
      observedRoot = actualRoots[physicalIndex]!
    if (!wantedRoot || wantedRoot.type !== observedRoot?.type || observedRoot.paragraph_group)
      throw refused(
        "The complete source and actual leaf positions differ or select a grouped paragraph.",
      )
    rootIndex = wantedRoot.token_index
    itemIndex = wantedRoot.item_index
    const wanted = inline(sourceTokens[rootIndex]!.token, itemIndex)
    const expected = markdownRichText(wanted.tokens)
    const serialized = markedText(wanted.text, style({}), "serializer")
    const values = property(block[String(block.type)]).rich_text
    if (!Array.isArray(values) || equationLiteral(values, expected) !== serialized)
      throw refused(
        "The physical equation and links do not reconstruct this exact frozen source leaf.",
      )
    // A duplicate source leaf would leave the source-to-block attribution ambiguous.
    const matches = sourceRoots.filter((leaf) => {
      if (leaf.type !== block.type) return false
      try {
        return inline(sourceTokens[leaf.token_index]!.token, leaf.item_index).text === wanted.text
      } catch {
        return false
      }
    })
    if (matches.length !== 1) throw refused("The frozen source leaf is not unique.")
    const observed = actualTokens[observedRoot.token_index]!
    const observedInline = inline(observed.token, observedRoot.item_index)
    if (!sourceRichTextRepairInlineMatches(observedInline.text, values, selection.kind))
      throw refused(
        "The entire actual Markdown leaf must agree with its complete physical before-image.",
      )
    body = { [String(block.type)]: { rich_text: expected } }
    after = {
      ...structuredClone(block),
      [String(block.type)]: {
        ...property(block[String(block.type)]),
        rich_text: readback(expected),
      },
    }
    projected = replaceLeaf(converted, observed, observedRoot.item_index, wanted.text)
    sourceLeaf = wanted.text
  }
  if (equal(block, after) || projected === converted)
    throw refused("The proposed single-leaf repair makes no change.")
  const proposedBlocks = projectNotionBlockTree(
    page,
    inventory.all.map((value) => (value.id === block.id ? after : value)),
  )
  if (!proposedBlocks) throw refused("The proposed physical graph cannot be projected completely.")
  const effect: SourceRichTextRepairEffect = {
    kind: selection.kind,
    block_id: selection.block_id,
    ancestor_ids: ancestors,
    source_path: portable.main,
    source_sha256: digest(main.bytes),
    source_leaf_sha256: digest(sourceLeaf),
    source_root_index: rootIndex,
    ...(itemIndex === undefined ? {} : { source_item_index: itemIndex }),
    ...(rowIndex === undefined ? {} : { source_row_index: rowIndex }),
    request: { path: `v1/blocks/${selection.block_id}`, method: "PATCH", body },
    before_block: block,
    after_block: after,
    proposed_markdown_sha256: digest(projected),
  }
  return {
    effect,
    proposed_only: true as const,
    snapshot: {
      ...snapshot,
      references: [{ ...root, markdown: projected, blocks: proposedBlocks }],
    },
  }
}
