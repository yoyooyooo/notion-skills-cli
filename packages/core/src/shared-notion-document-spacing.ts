import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token, Tokens } from "marked"
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

/** Predict the independently observed separators for each authoring purpose.
 * Body writes keep their own H1 wire and leading-LF policy; old policies stay fixed.
 */
export function projectNotionMarkdownV12(markdown: string, purpose: SharedNotionMarkdownPurpose) {
  const projected = projectNotionMarkdownV10(markdown, purpose)
  const tokens = SourceLexer.lex(projected.markdown)
  if (tokens.map((token) => token.raw).join("") !== projected.markdown)
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
      "The selected native document boundaries could not be projected completely before dispatch.",
    )
  const parts = tokens.map((token) => token.raw)
  for (let at = 0; at + 1 < tokens.length; at++) {
    const token = tokens[at]!
    const next = tokens[at + 1]!
    const fence = next.type === "code" && /^ {0,3}(?:`{3,}|~{3,})/u.test(next.raw)
    const headingBoundary =
      atxHeading(token) &&
      (purpose === "body_write" ? next.type === "paragraph" : next.type === "list" || fence)
    const paragraphFence = purpose === "body_write" && token.type === "paragraph" && fence
    if (!headingBoundary && !paragraphFence) continue
    const previous = parts[at]!
    if (previous.endsWith("\n") && !previous.endsWith("\n\n")) parts[at] = `${previous}\n`
  }
  return { wire: projected.wire, markdown: parts.join("") }
}

function oneLineParagraph(token: Token | undefined) {
  return (
    token !== undefined &&
    (token.type === "paragraph" || token.type === "text") &&
    !token.raw.replace(/\n+$/u, "").includes("\n")
  )
}

function isList(token: Token): token is Tokens.List {
  return token.type === "list"
}

function simpleChildList(token: Token) {
  return (
    isList(token) &&
    !token.ordered &&
    token.items.every(
      (item) => !item.task && item.tokens.length === 1 && oneLineParagraph(item.tokens[0]),
    )
  )
}

function creationListItem(item: Tokens.ListItem) {
  if (
    item.task ||
    item.tokens.map((token) => token.raw).join("") !== item.text ||
    item.tokens.some((token) => token.type === "space" && !/^\n+$/u.test(token.raw))
  )
    return
  const children = item.tokens.filter((token) => token.type !== "space")
  if (!oneLineParagraph(children[0])) return
  const multiple = children.length > 1
  if (
    multiple &&
    (!children.some((token) => token.type === "code") ||
      !children.slice(1).some(oneLineParagraph) ||
      children.some(
        (token) =>
          !oneLineParagraph(token) &&
          !(token.type === "code" && /^`{3,}[^\n]*\n/u.test(token.raw)) &&
          !simpleChildList(token),
      ))
  )
    return
  const marker = /^[1-9]\d*\. /u.exec(item.raw)?.[0]
  if (marker === undefined) return
  const indent = " ".repeat(marker.length)
  const decorate = (body: string) =>
    body
      .split("\n")
      .map((line, at) => (at === 0 ? marker + line : line === "" ? "" : indent + line))
      .join("\n")
  const suffix = /\n*$/u.exec(item.raw)?.[0] ?? ""
  if (decorate(item.text.replace(/\n+$/u, "")) + suffix !== item.raw) return
  const parts = children.map((token, at) => {
    const body = token.raw.replace(/\n+$/u, "")
    return at > 0 && oneLineParagraph(token) ? `<p>\n${body}\n</p>` : body
  })
  return {
    multiple,
    markdown: decorate(parts[0]! + (parts.length > 1 ? "\n" + parts.slice(1).join("\n\n") : "")),
  }
}

/** Creation readback wraps continuation paragraphs of the observed ordered
 * list shape. Other list shapes and retained projection versions stay exact.
 */
export function projectNotionMarkdownV13(markdown: string, purpose: SharedNotionMarkdownPurpose) {
  const projected = projectNotionMarkdownV12(markdown, purpose)
  if (purpose !== "data_source_create") return projected
  const tokens = SourceLexer.lex(projected.markdown)
  if (tokens.map((token) => token.raw).join("") !== projected.markdown)
    throw fail(
      "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
      "The selected creation list boundaries could not be projected completely before dispatch.",
    )
  return {
    wire: projected.wire,
    markdown: tokens
      .map((token) => {
        if (!isList(token) || !token.ordered || !token.loose) return token.raw
        if (token.items.map((item) => item.raw).join("") !== token.raw) return token.raw
        const items = token.items.map(creationListItem)
        if (items.some((item) => item === undefined) || !items.some((item) => item?.multiple))
          return token.raw
        return items.map((item) => item!.markdown).join("\n") + (/\n*$/u.exec(token.raw)?.[0] ?? "")
      })
      .join(""),
  }
}
