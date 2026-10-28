import type { Token, Tokens } from "marked"
import { SourceLexer } from "./source-lexer.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "./index.ts"

interface Part {
  readonly token: Token
  readonly start: number
  readonly end: number
}
interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}
interface ListLeaf {
  readonly marker: string
  readonly text: string
  readonly ordered: boolean
  readonly ordinal: number
  readonly body: number
}

function positioned(markdown: string) {
  const result: Part[] = []
  let cursor = 0
  for (const token of SourceLexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, cursor),
      end = start + token.raw.length
    if (start < cursor || markdown.slice(cursor, start).trim()) return
    if (token.type !== "space" && token.type !== "def") result.push({ token, start, end })
    cursor = end
  }
  return markdown.slice(cursor).trim() ? undefined : result
}

// List items expose their inline grammar one level below the item token.
// Unsupported forms stay unparsed; destinations remain the authored bytes.
function inlineTokens(item: Tokens.ListItem | undefined) {
  const token = item?.tokens[0]
  return token &&
    (token.type === "text" || token.type === "paragraph") &&
    token.text === item.text &&
    token.tokens?.length
    ? token.tokens
    : undefined
}

function sourceSpans(
  tokens: readonly Token[],
  bold = false,
  link: string | null = null,
): NotionTextSpan[] | undefined {
  const result: NotionTextSpan[] = []
  for (const token of tokens) {
    if (
      token.type === "text" &&
      token.raw === token.text &&
      !/[\r\n\t\\*_~`<>\[\]]/.test(token.text)
    ) {
      if (token.text) result.push({ text: token.text, bold, code: false, link })
    } else if (token.type === "codespan" && token.text && !/[\r\n\t\\`]/.test(token.text)) {
      result.push({ text: token.text, bold, code: true, link })
    } else if (
      token.type === "strong" &&
      !bold &&
      token.tokens?.length &&
      token.raw === `**${token.text}**` &&
      token.tokens.map((part: Token) => part.raw).join("") === token.text
    ) {
      const nested = sourceSpans(token.tokens, true, link)
      if (!nested) return
      result.push(...nested)
    } else if (
      token.type === "link" &&
      link === null &&
      token.title == null &&
      token.tokens?.length &&
      typeof token.href === "string" &&
      token.href &&
      !/[\s\\()<>\[\]]/.test(token.href) &&
      token.raw === `[${token.text}](${token.href})` &&
      token.tokens.map((part: Token) => part.raw).join("") === token.text
    ) {
      const nested = sourceSpans(token.tokens, bold, token.href)
      if (!nested) return
      result.push(...nested)
    } else return
  }
  return result
}

function merged(spans: readonly NotionTextSpan[]) {
  const result: NotionTextSpan[] = []
  for (const span of spans) {
    if (
      !span ||
      Object.keys(span).sort().join(",") !== "bold,code,link,text" ||
      typeof span.text !== "string" ||
      !span.text ||
      typeof span.bold !== "boolean" ||
      typeof span.code !== "boolean" ||
      (span.link !== null && typeof span.link !== "string")
    )
      return
    const previous = result.at(-1)
    if (
      previous &&
      previous.bold === span.bold &&
      previous.code === span.code &&
      previous.link === span.link
    )
      result[result.length - 1] = { ...previous, text: previous.text + span.text }
    else result.push({ text: span.text, bold: span.bold, code: span.code, link: span.link })
  }
  return result
}

function sameSpans(tokens: readonly Token[] | undefined, spans: readonly NotionTextSpan[]) {
  const source = tokens && sourceSpans(tokens),
    physical = merged(spans)
  if (!source || !physical || source.length !== physical.length) return false
  const page = (value: string) =>
    /^https:\/\/(?:www\.notion\.so|app\.notion\.com\/p)\/([0-9a-f]{32})(?=$|[?#])/i.exec(value)
  return source.every((span, index) => {
    const other = physical[index]!
    const left = span.link && page(span.link),
      right = other.link && page(other.link)
    const destination =
      span.link === other.link ||
      (!!left &&
        !!right &&
        left[1]!.toLowerCase() === right[1]!.toLowerCase() &&
        span.link!.slice(left[0].length) === other.link!.slice(right[0].length))
    return (
      span.text === other.text &&
      span.bold === other.bold &&
      span.code === other.code &&
      destination
    )
  })
}

// Notion v1 closes bold before a bold inline-code link and reopens it after.
// The resulting literal ** is the only readback form accepted here.
function splitCodeLinkReadback(spans: readonly NotionTextSpan[]) {
  const result: string[] = []
  let bold = false
  const close = () => {
    if (bold) {
      result.push("**")
      bold = false
    }
  }
  for (const span of spans) {
    if (
      !span.text ||
      /[\r\n\t\\`]/.test(span.text) ||
      (!span.code && /[*_~<>\[\]]/.test(span.text)) ||
      (span.link !== null && (!span.link || /[\s\\()<>\[\]]/.test(span.link)))
    )
      return
    if (span.bold && span.code && span.link !== null) {
      close()
      result.push(`[**\`${span.text}\`**](${span.link})`)
      continue
    }
    if (span.bold !== bold) {
      result.push("**")
      bold = span.bold
    }
    result.push(span.code ? `\`${span.text}\`` : span.text)
  }
  close()
  return result.join("")
}

function listLeaves(token: Token | undefined, start: number) {
  if (token?.type !== "list" || token.loose) return
  const items: ListLeaf[] = []
  let cursor = start
  for (const [index, item] of token.items.entries()) {
    const marker = /^( {0,3}(?:([-+*])|(\d+)[.)]) +)/.exec(item.raw)
    const ordinal = marker?.[3] === undefined ? 0 : Number(marker[3])
    if (
      item.task ||
      item.loose ||
      !inlineTokens(item) ||
      /[\r\n\t]/.test(item.text) ||
      !marker ||
      !item.raw.startsWith(marker[0] + item.text) ||
      !/^\n*$/.test(item.raw.slice(marker[0].length + item.text.length)) ||
      (marker[3] !== undefined &&
        (String(ordinal) !== marker[3] || !Number.isSafeInteger(ordinal) || ordinal < 1)) ||
      token.ordered !== (marker[3] !== undefined) ||
      (token.ordered &&
        (index === 0 ? token.start !== ordinal : ordinal !== items[0]!.ordinal + index))
    )
      return
    items.push({
      marker: marker[0],
      text: item.text,
      ordered: token.ordered,
      ordinal,
      body: cursor + marker[0].length,
    })
    cursor += item.raw.length
  }
  return cursor === start + token.raw.replace(/\n+$/, "").length ? items : undefined
}

function heading(token: Token | undefined, root: NotionBlockBoundary | undefined) {
  return (
    token?.type === "heading" &&
    root?.type === `heading_${token.depth}` &&
    !root.has_children &&
    !/[\r\n]/.test(token.text) &&
    !!root.rich_text?.length &&
    Array.isArray(token.tokens) &&
    token.tokens.every((part: Token) => part.type === "text" && part.raw === part.text) &&
    root.rich_text.every((span) => !span.bold && !span.code && span.link === null) &&
    root.rich_text.map((span) => span.text).join("") === token.text &&
    (root.text === undefined || root.text === token.text)
  )
}

function itemBoundary(part: Part, itemIndex: number, root: NotionBlockBoundary | undefined) {
  const leaves = part.token.type === "list" ? listLeaves(part.token, 0) : undefined
  const leaf = leaves?.[itemIndex],
    item = part.token.type === "list" ? part.token.items[itemIndex] : undefined
  return (
    !!leaf &&
    !!root &&
    root.type === (leaf.ordered ? "numbered_list_item" : "bulleted_list_item") &&
    !root.has_children &&
    !!root.rich_text?.length &&
    (root.text === undefined || root.text === root.rich_text.map((span) => span.text).join("")) &&
    (!leaf.ordered ||
      root.numbered_list?.start === null ||
      root.numbered_list?.start === leaf.ordinal) &&
    sameSpans(inlineTokens(item), root.rich_text)
  )
}

function neighbor(
  parts: readonly Part[],
  part: Part,
  itemIndex: number,
  root: NotionBlockBoundary | undefined,
  length: number,
  side: "before" | "after",
) {
  const inside = side === "before" ? itemIndex > 0 : itemIndex + 1 < length
  if (inside) return itemBoundary(part, side === "before" ? itemIndex - 1 : itemIndex + 1, root)
  const index = parts.indexOf(part) + (side === "before" ? -1 : 1)
  return heading(parts[index]?.token, root)
}

/** Restore one flat list item when bold borders an inline code link and Notion
 * emits literal ** around that link. Source text, code, href, the unique owner,
 * and both neighbors must match; no other asterisk is removed. */
export function boldCodeLinkListReadbackEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
): Edit[] {
  if (markdown.includes("\r") || target.includes("\r")) return []
  const actual = positioned(markdown),
    source = positioned(target),
    result: Edit[] = []
  if (
    !actual ||
    !source ||
    roots.some((root) => !root.id) ||
    new Set(roots.map((root) => root.id)).size !== roots.length
  )
    return result
  for (let rootIndex = 1; rootIndex + 1 < roots.length; rootIndex++) {
    const root = roots[rootIndex]!,
      spans = root.rich_text
    if (
      (root.type !== "bulleted_list_item" && root.type !== "numbered_list_item") ||
      root.has_children ||
      root.descendants !== undefined ||
      root.quote_descendants !== undefined ||
      root.list_table_descendants !== undefined ||
      root.table_evidence !== undefined ||
      root.code !== undefined ||
      root.to_do !== undefined ||
      !spans?.length ||
      !spans.some((span) => span.bold && span.code && span.link !== null) ||
      !spans.some((span) => span.bold && !span.code && span.link === null) ||
      spans.some((span) => span.bold && span.code && span.link === null)
    )
      continue
    const retained = merged(spans),
      readback = retained && splitCodeLinkReadback(retained)
    if (
      !retained ||
      readback === undefined ||
      (root.text !== undefined && root.text !== spans.map((span) => span.text).join(""))
    )
      continue
    const candidates = source.flatMap((part) => {
      const leaves = listLeaves(part.token, part.start)
      if (!leaves) return []
      return leaves.flatMap((leaf, itemIndex) => {
        const item = part.token.type === "list" ? part.token.items[itemIndex] : undefined
        if (
          leaf.ordered !== (root.type === "numbered_list_item") ||
          (root.type === "numbered_list_item" &&
            root.numbered_list?.start !== null &&
            root.numbered_list?.start !== leaf.ordinal) ||
          !neighbor(source, part, itemIndex, roots[rootIndex - 1], leaves.length, "before") ||
          !neighbor(source, part, itemIndex, roots[rootIndex + 1], leaves.length, "after") ||
          !sameSpans(inlineTokens(item), retained)
        )
          return []
        return [leaf]
      })
    })
    if (candidates.length !== 1 || candidates[0]!.text === readback) continue
    const original = candidates[0]!
    const matches = actual.flatMap((part) => {
      const leaves = listLeaves(part.token, part.start)
      if (!leaves) return []
      return leaves.flatMap((leaf, itemIndex) =>
        leaf.marker === original.marker &&
        leaf.text === readback &&
        neighbor(actual, part, itemIndex, roots[rootIndex - 1], leaves.length, "before") &&
        neighbor(actual, part, itemIndex, roots[rootIndex + 1], leaves.length, "after")
          ? [{ start: leaf.body, end: leaf.body + leaf.text.length, text: original.text }]
          : [],
      )
    })
    if (matches.length === 1) result.push(matches[0]!)
  }
  return result
}
