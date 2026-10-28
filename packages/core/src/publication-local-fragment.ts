import {
  SourceLexer,
  type NotionBlockBoundary,
  type NotionBlockNode,
  type NotionQuoteNode,
  type NotionTextSpan,
} from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { markdownStructure, samePublishedMarkdown } from "./markdown.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

interface FragmentLink {
  readonly destination: string
  readonly label: string
  readonly bold: boolean
}

// This is a local fragment spelling, never a URL/path normalization. Requiring
// literal Unicode excludes already encoded, reserved and double encoded inputs.
function literalFragment(value: string) {
  const text = value.startsWith("#") ? value.slice(1) : ""
  return /[^\x00-\x7f]/.test(text) && /^[\p{L}\p{N}\p{M}._~-]+$/u.test(text) ? text : undefined
}

function headingFragment(text: string) {
  if (literalFragment(`#${text}`) !== undefined) return text
  // The second retained source shape is one plain "A & B" heading whose
  // authored fragment spells that separator as "--". No other slug rules apply.
  const pair = /^([^\s&]+) & ([^\s&]+)$/.exec(text)
  return pair && literalFragment(`#${pair[1]}--${pair[2]}`) !== undefined
    ? `${pair[1]}--${pair[2]}`
    : undefined
}

function sourceLinks(tokens: readonly Token[]) {
  const result: FragmentLink[] = []
  const visit = (tokens: readonly Token[], bold: boolean, supported: boolean) => {
    for (const token of tokens) {
      if (token.type === "link") {
        if (typeof token.href !== "string" || literalFragment(token.href) === undefined) continue
        const plain = token.tokens?.every(
          (part: Token) => part.type === "text" && part.raw === part.text,
        )
        if (!supported || !plain || typeof token.text !== "string" || token.title != null)
          return false
        result.push({ destination: token.href, label: token.text, bold })
      } else if (token.type === "table") {
        for (const cell of [...token.header, ...token.rows.flat()])
          if (!visit(cell.tokens, bold, supported)) return false
      } else if (token.type === "list") {
        for (const item of token.items) if (!visit(item.tokens, bold, supported)) return false
      } else if ("tokens" in token && Array.isArray(token.tokens)) {
        const plainContext = ["paragraph", "text", "heading", "blockquote", "strong"].includes(
          token.type,
        )
        if (!visit(token.tokens, bold || token.type === "strong", supported && plainContext))
          return false
      }
    }
    return true
  }
  return visit(tokens, false, true) ? result : undefined
}

function physicalSpans(roots: readonly NotionBlockBoundary[]) {
  if (!roots.length || roots.length > 4096) return
  const ids = new Set<string>(),
    spans: NotionTextSpan[] = []
  const add = (values: readonly NotionTextSpan[] | undefined, node?: NotionBlockNode) => {
    if (values === undefined) return true
    if (
      !Array.isArray(values) ||
      values.some(
        (span) =>
          !span ||
          typeof span.text !== "string" ||
          typeof span.bold !== "boolean" ||
          typeof span.code !== "boolean" ||
          (span.link !== null && typeof span.link !== "string"),
      )
    )
      return false
    if (node?.text !== undefined && node.text !== values.map((span) => span.text).join(""))
      return false
    spans.push(...values)
    return true
  }
  for (const root of roots) {
    const nodes: readonly (NotionBlockNode & Pick<NotionQuoteNode, "table_row">)[] = [
      root,
      ...(root.descendants ?? []),
      ...(root.quote_descendants ?? []),
      ...(root.list_table_descendants ?? []),
      ...(root.table_evidence?.rows ?? []),
    ]
    for (const node of nodes) {
      const id = node.id?.replaceAll("-", "").toLowerCase()
      if (!id || ids.has(id) || ids.size >= 4096 || typeof node.has_children !== "boolean") return
      ids.add(id)
      if (!add(node.rich_text, node)) return
      if (node.table_row !== undefined) {
        if (node.table_row === null || !Array.isArray(node.table_row.cells)) return
        for (const cell of node.table_row.cells) if (!add(cell)) return
      }
    }
  }
  return spans
}

/** A comparison view for one source-authored Unicode fragment and its complete
 * ordered occurrences. The source, observed body, raw blocks and external URL
 * policy remain unchanged. Complete page evidence is supplied by the caller. */
export function pageLocalUnicodeFragmentTarget(
  markdown: string,
  roots: readonly NotionBlockBoundary[] | undefined,
) {
  if (!roots || markdown.includes("\r")) return markdown
  const tokens = SourceLexer.lex(markdown),
    links = sourceLinks(tokens),
    spans = physicalSpans(roots)
  if (!links?.length || !spans || new Set(links.map((link) => link.destination)).size !== 1)
    return markdown
  const destination = links[0]!.destination,
    fragment = literalFragment(destination)!
  const headings = tokens.filter(
    (token) => token.type === "heading" && headingFragment(token.text) === fragment,
  )
  const heading = headings[0]
  if (
    headings.length !== 1 ||
    heading?.type !== "heading" ||
    heading.depth > 3 ||
    !Array.isArray(heading.tokens) ||
    !heading.tokens.every((token: Token) => token.type === "text" && token.raw === token.text)
  )
    return markdown
  // Count the public AST too: adding emphasis cannot hide a duplicate heading.
  const sourceHeadings = markdownStructure(markdown).filter(
    (node) =>
      Array.isArray(node) &&
      node[0] === "heading" &&
      Array.isArray(node[2]) &&
      node[2].length === 1 &&
      typeof node[2][0] === "string" &&
      headingFragment(node[2][0]) === fragment,
  )
  if (sourceHeadings.length !== 1) return markdown
  const physicalHeadings = roots.filter((root) => /^heading_[1-3]$/.test(root.type))
  if (physicalHeadings.some((root) => !root.rich_text || typeof root.text !== "string"))
    return markdown
  const matchingHeadings = physicalHeadings.filter(
    (root) => headingFragment(root.text!) === fragment,
  )
  const observedHeading = matchingHeadings[0]
  if (
    matchingHeadings.length !== 1 ||
    !observedHeading ||
    observedHeading.type !== `heading_${heading.depth}` ||
    observedHeading.has_children ||
    observedHeading.text !== heading.text ||
    observedHeading.rich_text!.some((span) => span.bold || span.code || span.link !== null)
  )
    return markdown
  if (links.some((link) => link.label !== heading.text && link.label !== `§ ${heading.text}`))
    return markdown
  let encoded: string
  try {
    encoded = `#${encodeURIComponent(fragment)}`
    if (decodeURIComponent(encoded.slice(1)) !== fragment) return markdown
  } catch {
    return markdown
  }
  const physical = spans.filter((span) => span.link === encoded)
  if (
    physical.length !== links.length ||
    physical.some(
      (span, index) =>
        span.code || span.text !== links[index]!.label || span.bold !== links[index]!.bold,
    )
  )
    return markdown
  // A literal or differently encoded physical occurrence cannot share this
  // authority; every source occurrence must have exactly the canonical spelling.
  if (spans.some((span) => span.link === destination)) return markdown
  let replacements = 0
  const view = mapMarkdownLinks(markdown, (url) => {
    if (url !== destination) return url
    replacements++
    return encoded
  })
  if (replacements !== links.length || view === markdown) return markdown
  return samePublishedMarkdown(
    view,
    markdown,
    (actual, expected) => actual === expected || (actual === encoded && expected === destination),
  )
    ? view
    : markdown
}
