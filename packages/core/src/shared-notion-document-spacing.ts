import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token } from "marked"
import { fail } from "./model.ts"
import {
  projectNotionMarkdownV5,
  type SharedNotionMarkdownPurpose,
} from "./shared-notion-markdown-v2.ts"

function atxHeading(token: Token | undefined) {
  return token?.type === "heading" && /^#{1,4}(?:[ \t]+|\n|$)/u.test(token.raw)
}

/** Predict only the independently observed creation document boundaries.
 * Original wire bytes and all nested block contents keep the retained policy.
 */
export function projectNotionMarkdownV9(markdown: string, purpose: SharedNotionMarkdownPurpose) {
  const projected = projectNotionMarkdownV5(markdown, purpose)
  if (purpose !== "data_source_create") return projected
  const tokens = SourceLexer.lex(projected.markdown)
  if (tokens.map((token) => token.raw).join("") !== projected.markdown)
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
      "Creation document boundaries could not be projected completely before dispatch.",
    )
  const parts = tokens.map((token) => token.raw)
  if (tokens[0]?.type === "space" && parts[0] === "\n" && atxHeading(tokens[1])) parts[0] = ""
  for (let at = 0; at + 1 < tokens.length; at++) {
    if (!atxHeading(tokens[at]) || tokens[at + 1]?.type !== "paragraph") continue
    const heading = parts[at]!
    if (heading.endsWith("\n") && !heading.endsWith("\n\n")) parts[at] = `${heading}\n`
  }
  return { wire: projected.wire, markdown: parts.join("") }
}

export function projectNotionMarkdownV10(markdown: string, purpose: SharedNotionMarkdownPurpose) {
  const projected = projectNotionMarkdownV9(markdown, purpose)
  if (purpose !== "data_source_create") return projected
  const tokens = SourceLexer.lex(projected.markdown)
  if (tokens.map((token) => token.raw).join("") !== projected.markdown)
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
      "Creation paragraph boundaries could not be projected completely before dispatch.",
    )
  const parts = tokens.map((token) => token.raw)
  for (let at = 0; at + 1 < tokens.length; at++) {
    const next = tokens[at + 1]!
    if (
      tokens[at]?.type !== "paragraph" ||
      next.type !== "code" ||
      !/^ {0,3}(?:`{3,}|~{3,})/u.test(next.raw)
    )
      continue
    const paragraph = parts[at]!
    if (paragraph.endsWith("\n") && !paragraph.endsWith("\n\n")) parts[at] = `${paragraph}\n`
  }
  return { wire: projected.wire, markdown: parts.join("") }
}
