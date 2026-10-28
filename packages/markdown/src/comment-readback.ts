import { type Token } from "marked"
import { SourceLexer as Lexer } from "./source-lexer.ts"
import type { NotionBlockBoundary } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Part extends Range {
  readonly token: Token
}
interface Edit extends Range {
  readonly text: string
}
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean
type Inline = (text: string, tokens?: readonly Token[]) => unknown[]
type Visible = (content: readonly unknown[]) => string

const paragraphRange = (part: Part): Range => ({
  start: part.start,
  end:
    part.start + (part.token.type === "paragraph" ? part.token.text.length : part.token.raw.length),
})

function commentEdits(
  markdown: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  inlineTokens: Inline,
  visible: Visible,
) {
  const edits: Edit[] = []
  for (let index = 1; index + 1 < wanted.length; index++) {
    const previous = wanted[index - 1]!.token
    const comment = wanted[index]!.token
    const next = wanted[index + 1]!.token
    if (previous.type !== "paragraph" || comment.type !== "html" || next.type !== "code") continue
    const match = /^(<!--(?:(?!-->)[^\r\n])*-->)(\n+)$/.exec(comment.raw)
    if (!match) continue
    const text = match[1]!
    const escaped = `\\${text.slice(0, -1)}\\>`
    const beforeText = visible(inlineTokens(previous.text, previous.tokens))
    const roots = boundaries.flatMap((block, blockIndex) => {
      const before = boundaries[blockIndex - 1]
      const after = boundaries[blockIndex + 1]
      return block.type === "paragraph" &&
        !block.has_children &&
        block.text === text &&
        before?.type === "paragraph" &&
        !before.has_children &&
        before.text === beforeText &&
        after?.type === "code" &&
        !after.has_children
        ? [blockIndex]
        : []
    })
    if (
      roots.length !== 1 ||
      wanted.filter(({ token }) => token.type === "html" && token.raw.trimEnd() === text).length !==
        1
    )
      continue
    const candidates = actual.flatMap((part, partIndex) => {
      if (part.token.type !== "paragraph" || actual[partIndex + 1]?.token.type !== "code") return []
      const prefix = part.token.text.endsWith(`\n${escaped}`)
        ? part.token.text.slice(0, -escaped.length - 1)
        : undefined
      if (prefix === undefined || visible(inlineTokens(prefix)) !== beforeText) return []
      const commentStart = part.start + prefix.length + 1
      if (
        !proves(roots[0]! - 1, [
          { start: part.start, end: part.start + prefix.length },
          { start: commentStart, end: commentStart + escaped.length },
          actual[partIndex + 1]!,
        ])
      )
        return []
      return [
        {
          start: part.start,
          end: actual[partIndex + 1]!.start,
          text: `${prefix}\n\n${comment.raw}`,
        },
      ]
    })
    if (candidates.length === 1) edits.push(candidates[0]!)
  }
  return edits
}

function singleLineComment(token: Token) {
  if (token.type !== "html") return
  const match = /^(<!--(?:(?!-->)[^\r\n])*-->)(\n*)$/.exec(token.raw)
  if (!match) return
  const text = match[1]!
  return { text, raw: token.raw }
}

function literalCommentReadback(serialized: string, text: string) {
  if (
    !serialized.startsWith("\\<!--") ||
    !serialized.endsWith("--\\>") ||
    serialized.includes("\n")
  )
    return false
  const tokens = Lexer.lexInline(serialized)
  if (tokens.map((token) => token.raw).join("") !== serialized) return false
  if (
    !tokens.every(
      (token) =>
        (token.type === "escape" && token.raw === `\\${token.text}`) ||
        (token.type === "text" && token.raw === token.text),
    )
  )
    return false
  return tokens.map((token) => (token.type === "escape" ? token.text : token.raw)).join("") === text
}

function listCommentEdits(
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  inlineTokens: Inline,
  visible: Visible,
) {
  const edits: Edit[] = []
  for (let index = 1; index + 1 < wanted.length; index++) {
    const previous = wanted[index - 1]!.token
    const next = wanted[index + 1]!.token
    const comment = singleLineComment(wanted[index]!.token)
    if (
      previous.type !== "list" ||
      next.type !== "heading" ||
      !comment ||
      wanted.filter(({ token }) => singleLineComment(token)?.text === comment.text).length !== 1
    )
      continue
    const roots = boundaries.flatMap((block, blockIndex) => {
      const before = boundaries[blockIndex - 1]
      const after = boundaries[blockIndex + 1]
      const text = block.rich_text?.map((span) => span.text).join("") ?? block.text
      return block.type === "paragraph" &&
        !block.has_children &&
        text === comment.text &&
        before?.type === (previous.ordered ? "numbered_list_item" : "bulleted_list_item") &&
        !before.has_children &&
        after?.type === `heading_${next.depth}` &&
        !after.has_children
        ? [blockIndex]
        : []
    })
    if (roots.length !== 1) continue
    const candidates = actual.flatMap((part, partIndex) => {
      const following = actual[partIndex + 1]
      if (
        part.token.type !== "paragraph" ||
        !literalCommentReadback(part.token.text, comment.text) ||
        following?.token.type !== "heading" ||
        following.token.depth !== next.depth ||
        !proves(roots[0]!, [paragraphRange(part)])
      )
        return []
      return [{ start: part.start, end: following.start, text: comment.raw }]
    })
    if (candidates.length === 1) edits.push(candidates[0]!)
  }
  return edits
}

function terminalCommentEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  inlineTokens: Inline,
  visible: Visible,
): Edit[] {
  const last = wanted.at(-1)
  const previous = wanted.at(-2)
  const part = actual.at(-1)
  if (
    !last ||
    previous?.token.type !== "paragraph" ||
    previous.token.text.includes("\n") ||
    part?.token.type !== "paragraph" ||
    part.token.text.includes("\n") ||
    target.slice(paragraphRange(previous).end, last.start) !== "\n"
  )
    return []
  const comment = singleLineComment(last.token)
  if (
    !comment ||
    wanted.filter(({ token }) => singleLineComment(token)?.text === comment.text).length !== 1
  )
    return []
  if (part.token.tokens?.map((token) => token.raw).join("") !== part.token.text) return []
  // The break must be a real readback HTML token, never text inside a code span.
  let offset = 0
  const breaks: number[] = []
  for (const token of part.token.tokens ?? []) {
    if (token.type === "html" && token.raw === "<br>") breaks.push(offset)
    offset += token.raw.length
  }
  if (breaks.length !== 1) return []
  const prefix = part.token.text.slice(0, breaks[0]!)
  const suffix = part.token.text.slice(breaks[0]! + "<br>".length)
  const beforeText = visible(inlineTokens(previous.token.text, previous.token.tokens))
  if (
    !prefix ||
    prefix.includes("<br>") ||
    visible(inlineTokens(prefix)) !== beforeText ||
    !literalCommentReadback(suffix, comment.text)
  )
    return []
  const text = `${beforeText}\n${comment.text}`
  const roots = boundaries.flatMap((block, index) =>
    block.type === "paragraph" &&
    !block.has_children &&
    (block.rich_text?.map((span) => span.text).join("") ?? block.text) === text
      ? [index]
      : [],
  )
  if (roots.length !== 1 || !proves(roots[0]!, [paragraphRange(part)])) return []
  return [{ start: part.start, end: markdown.length, text: `${prefix}\n${comment.raw}` }]
}
export function commentReadbackEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  inlineTokens: Inline,
  visible: Visible,
) {
  return [
    ...commentEdits(markdown, actual, wanted, boundaries, proves, inlineTokens, visible),
    ...listCommentEdits(actual, wanted, boundaries, proves, inlineTokens, visible),
    ...terminalCommentEdits(
      markdown,
      target,
      actual,
      wanted,
      boundaries,
      proves,
      inlineTokens,
      visible,
    ),
  ]
}
