import type { Token } from "marked"
import { SourceLexer as Lexer } from "./source-lexer.ts"
import type { NotionBlockBoundary } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Positioned extends Range {
  readonly token: Token
}
interface Edit extends Range {
  readonly text: string
}
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean

function paragraphRange(part: Positioned): Range {
  return {
    start: part.start,
    end:
      part.start +
      (part.token.type === "paragraph" ? part.token.text.length : part.token.raw.length),
  }
}

/** Restore one blank line omitted between a heading and its following paragraph.
 * The ordered physical roots and identical heading/paragraph text authorize it. */
export function headingParagraphGapEdits(
  markdown: string,
  actual: readonly Positioned[],
  wanted: readonly Positioned[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  for (const [index, part] of actual.entries()) {
    if (part.token.type !== "heading" || part.token.depth > 3) continue
    const next = actual[index + 1]
    if (next?.token.type !== "paragraph" || markdown.slice(part.end, next.start) !== "\n") continue
    const heading = part.token.raw.replace(/\n+$/, "")
    const headingToken = part.token
    const paragraphToken = next.token
    const sources = wanted.flatMap((item, sourceIndex) =>
      item.token.type === "heading" &&
      item.token.depth === headingToken.depth &&
      item.token.raw.replace(/\n+$/, "") === heading
        ? [sourceIndex]
        : [],
    )
    const sourceIndex = sources[0]
    const following = sourceIndex === undefined ? undefined : wanted[sourceIndex + 1]
    if (
      sources.length !== 1 ||
      following?.token.type !== "paragraph" ||
      following.token.text !== paragraphToken.text
    )
      continue
    const roots = boundaries.flatMap((block, rootIndex) => {
      const paragraph = boundaries[rootIndex + 1]
      const paragraphText = paragraph?.rich_text?.map((span) => span.text).join("")
      return block.type === `heading_${headingToken.depth}` &&
        !block.has_children &&
        paragraph?.type === "paragraph" &&
        !paragraph.has_children &&
        paragraphText === paragraphToken.text
        ? [rootIndex]
        : []
    })
    if (roots.length !== 1 || !proves(roots[0]!, [part, paragraphRange(next)])) continue
    edits.push({ start: part.end, end: part.end, text: "\n" })
  }
  return edits
}

const escapedPunctuation = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g

/** Remove punctuation escapes only where one plain physical paragraph retains
 * the exact unescaped source bytes. Other backslashes remain evidence. */
export function plainPunctuationEscapeEdits(
  actual: readonly Positioned[],
  wanted: readonly Positioned[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  for (const part of actual) {
    if (part.token.type !== "paragraph" || part.token.raw.replace(/\n+$/, "") !== part.token.text)
      continue
    const matches = [...part.token.text.matchAll(escapedPunctuation)]
    if (!matches.length) continue
    const literal = part.token.text.replace(escapedPunctuation, "$1")
    if (literal === part.token.text || literal.includes("\\")) continue
    const parsed = Lexer.lex(literal)
    if (parsed.length !== 1 || parsed[0]?.type !== "paragraph" || parsed[0].text !== literal)
      continue
    const sources = wanted.filter(
      (item) => item.token.type === "paragraph" && item.token.text === literal,
    )
    const roots = boundaries.flatMap((block, index) =>
      block.type === "paragraph" &&
      !block.has_children &&
      block.text === literal &&
      block.rich_text?.length &&
      block.rich_text.every(
        (span) => !span.bold && !span.code && span.link === null && !span.text.includes("\\"),
      ) &&
      block.rich_text.map((span) => span.text).join("") === literal
        ? [index]
        : [],
    )
    if (sources.length !== 1 || roots.length !== 1 || !proves(roots[0]!, [paragraphRange(part)]))
      continue
    for (const match of matches.reverse()) {
      const start = part.start + match.index!
      edits.push({ start, end: start + 1, text: "" })
    }
  }
  return edits
}

export function physicalSpanReadbackEdits(
  markdown: string,
  actual: readonly Positioned[],
  wanted: readonly Positioned[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  return [
    ...headingParagraphGapEdits(markdown, actual, wanted, boundaries, proves),
    ...plainPunctuationEscapeEdits(actual, wanted, boundaries, proves),
  ]
}
