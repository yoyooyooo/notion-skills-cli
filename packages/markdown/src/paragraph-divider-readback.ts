import type { Token, Tokens } from "marked"
import { SourceLexer as Lexer } from "./source-lexer.ts"
import type { NotionBlockBoundary } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Part extends Range {
  readonly token: Token
}
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean
type Inline = (text: string, tokens?: readonly Token[]) => unknown[]
type Visible = (content: readonly unknown[]) => string
type InlineText = (values: unknown[]) => unknown[]
type Same = (actual: readonly unknown[], expected: readonly unknown[]) => boolean

// A source-bound divider may follow a paragraph whose ordinary rich text
// contains a soft line break. Apply the existing inline whitespace semantics
// only to non-code spans; code bytes and complete link destinations stay exact.
function paragraphDividerInlineMatches(
  block: NotionBlockBoundary,
  content: readonly unknown[],
  visible: Visible,
  inlineText: InlineText,
) {
  const text = block.rich_text?.map((span) => span.text).join("") ?? block.text
  if (text === visible(content)) return true
  const spans = block.rich_text
  if (!spans?.length) return false
  const retained = inlineText(
    spans.map((span) => {
      const value = span.code ? ["code", span.text] : span.text.replace(/\s+/g, " ")
      return span.link === null ? value : ["link", span.link, null, [value]]
    }),
  )
  return JSON.stringify(retained) === JSON.stringify(content)
}

interface ParagraphDividerBinding {
  readonly part: Part
  readonly paragraph: Part
  readonly divider: Part
  readonly rootIndex: number
  readonly sourceIndex: number
}

// Distinguish a paragraph followed by a divider from a setext heading using
// source inline structure and ordered original roots, before changing bytes.
function paragraphDividerReadbackCandidate(
  markdown: string,
  target: string,
  boundaries: readonly NotionBlockBoundary[] | undefined,
  structure: Same,
  inline: Inline,
  visible: Visible,
  inlineText: InlineText,
  positioned: (markdown: string) => Part[] | undefined,
  proof: (
    markdown: string,
    tokens: readonly Part[],
    boundaries: readonly NotionBlockBoundary[],
  ) => Proves,
) {
  if (!boundaries?.length || markdown.includes("\r") || target.includes("\r")) return
  if (
    boundaries.some((block) => !block.id) ||
    new Set(boundaries.map((block) => block.id)).size !== boundaries.length
  )
    return
  const actual = positioned(markdown)
  const wanted = positioned(target)
  if (!actual || !wanted) return
  const bindings: ParagraphDividerBinding[] = []
  for (const part of actual) {
    const heading = part.token
    if (
      heading.type !== "heading" ||
      heading.depth !== 2 ||
      !heading.tokens ||
      !heading.raw.startsWith(`${heading.text}\n`)
    )
      continue
    const rule = heading.raw.slice(heading.text.length + 1)
    if (!/^ {0,3}---[ \t]*(?:\n*)$/.test(rule)) continue
    const ruleLine = rule.replace(/\n+$/, "")
    const content = inline(heading.text, heading.tokens)
    const sourcePairs = wanted.flatMap((item, index) => {
      const next = wanted[index + 1]
      return item.token.type === "paragraph" &&
        next?.token.type === "hr" &&
        next.token.raw.replace(/\n+$/, "") === ruleLine &&
        structure(content, inline(item.token.text, item.token.tokens))
        ? [index]
        : []
    })
    const rootPairs = boundaries.flatMap((block, index) => {
      const next = boundaries[index + 1]
      return block.type === "paragraph" &&
        !block.has_children &&
        paragraphDividerInlineMatches(block, content, visible, inlineText) &&
        next?.type === "divider" &&
        !next.has_children
        ? [index]
        : []
    })
    if (sourcePairs.length !== 1 || rootPairs.length !== 1) continue
    const paragraphToken: Tokens.Paragraph = {
      type: "paragraph",
      raw: heading.text,
      text: heading.text,
      tokens: heading.tokens,
    }
    const dividerToken: Tokens.Hr = { type: "hr", raw: rule }
    bindings.push({
      part,
      rootIndex: rootPairs[0]!,
      sourceIndex: sourcePairs[0]!,
      paragraph: {
        token: paragraphToken,
        start: part.start,
        end: part.start + heading.text.length,
      },
      divider: {
        token: dividerToken,
        start: part.start + heading.text.length + 1,
        end: part.end,
      },
    })
  }
  if (!bindings.length) return
  if (
    new Set(bindings.map((binding) => binding.rootIndex)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.sourceIndex)).size !== bindings.length
  )
    return
  // These split ranges come from the unchanged raw token plus exact original
  // paragraph evidence; no generated candidate text participates in the proof.
  const positions = actual.flatMap((part) => {
    const binding = bindings.find((candidate) => candidate.part === part)
    return binding ? [binding.paragraph, binding.divider] : [part]
  })
  const proves = proof(markdown, positions, boundaries)
  const proven = bindings.filter((binding) =>
    proves(binding.rootIndex, [binding.paragraph, binding.divider]),
  )
  if (!proven.length) return
  let candidate = markdown
  for (const binding of [...proven].sort((a, b) => b.paragraph.end - a.paragraph.end))
    candidate =
      candidate.slice(0, binding.paragraph.end) + "\n" + candidate.slice(binding.paragraph.end)
  return candidate
}

export function paragraphDividerCandidate(
  markdown: string,
  target: string,
  boundaries: readonly NotionBlockBoundary[] | undefined,
  structure: Same,
  inline: Inline,
  visible: Visible,
  inlineText: InlineText,
  positioned: (markdown: string) => Part[] | undefined,
  proof: (
    markdown: string,
    tokens: readonly Part[],
    boundaries: readonly NotionBlockBoundary[],
  ) => Proves,
) {
  return paragraphDividerReadbackCandidate(
    markdown,
    target,
    boundaries,
    structure,
    inline,
    visible,
    inlineText,
    positioned,
    proof,
  )
}
