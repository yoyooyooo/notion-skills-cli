// Frozen root-only projection from core markdown 80762cac488df686592129ea5fbe647da05d6ac0d2c3540275e4fda1b8580862.
// Exact function body slice, no comparison policy or production module import.
import type { NotionBlockBoundary, NotionTextSpan } from "../src/markdown.ts"

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const boundaryTextTypes: Record<string, true> = {
  quote: true,
  paragraph: true,
  bulleted_list_item: true,
  numbered_list_item: true,
}

function projectTextSpans(richText: readonly unknown[]) {
  const spans: NotionTextSpan[] = []
  for (const value of richText) {
    const rich = record(value)
    const source = record(rich?.text)
    const annotations = record(rich?.annotations)
    const link = source?.link == null ? null : record(source.link)?.url
    if (
      rich?.type !== "text" ||
      typeof source?.content !== "string" ||
      (rich.plain_text !== undefined && rich.plain_text !== source.content) ||
      (link !== null && typeof link !== "string") ||
      typeof annotations?.bold !== "boolean" ||
      typeof annotations.code !== "boolean"
    )
      return
    spans.push({ text: source.content, link, bold: annotations.bold, code: annotations.code })
  }
  return spans
}

function projectCode(body: Record<string, unknown> | undefined) {
  if (typeof body?.language !== "string" || !Array.isArray(body.rich_text)) return
  let text = ""
  for (const value of body.rich_text) {
    const rich = record(value)
    const source = record(rich?.text)
    if (
      rich?.type !== "text" ||
      typeof source?.content !== "string" ||
      (rich.plain_text !== undefined && rich.plain_text !== source.content) ||
      source.link != null
    )
      return
    text += source.content
  }
  return { text, language: body.language }
}

// Evidence records physical absence separately from an invalid or unprojected
// field. A missing start is never permission to restore a source-only number.
function projectNumberedList(body: Record<string, unknown> | undefined) {
  if (!body || (body.list_format !== undefined && body.list_format !== "numbers")) return
  const start = body.list_start_index
  if (start === undefined) return { start: null }
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1) return
  return { start }
}

// Preserve every root as a sentinel, including blocks without a supported text projection.
export function projectNotionBlocks(blocks: readonly unknown[]): NotionBlockBoundary[] | undefined {
  const result: NotionBlockBoundary[] = []
  const ids = new Set<string>()
  for (const value of blocks) {
    const block = record(value)
    if (
      !block ||
      typeof block.id !== "string" ||
      !block.id ||
      ids.has(block.id) ||
      typeof block.type !== "string" ||
      !block.type ||
      typeof block.has_children !== "boolean"
    )
      return
    ids.add(block.id)
    let boundary: NotionBlockBoundary = {
      id: block.id,
      type: block.type,
      has_children: block.has_children,
    }
    const body = record(block[block.type])
    if (block.type === "numbered_list_item" && !block.has_children) {
      const numbered = projectNumberedList(body)
      if (numbered) boundary = { ...boundary, numbered_list: numbered }
    }
    const richText = body?.rich_text
    if (block.type === "code") {
      const code = block.has_children ? undefined : projectCode(body)
      result.push(code ? { ...boundary, code } : boundary)
      continue
    }
    if (
      !Object.hasOwn(boundaryTextTypes, block.type) ||
      !Array.isArray(richText) ||
      !richText.length
    ) {
      result.push(boundary)
      continue
    }
    const spans = projectTextSpans(richText)
    if (spans) boundary = { ...boundary, rich_text: spans }
    let text = ""
    let supported = true
    for (const value of richText) {
      const rich = record(value)
      const source = record(rich?.text)
      if (
        rich?.type !== "text" ||
        typeof source?.content !== "string" ||
        (rich.plain_text !== undefined && rich.plain_text !== source.content) ||
        source.link != null
      ) {
        supported = false
        break
      }
      text += source.content
    }
    result.push(supported ? { ...boundary, text } : boundary)
  }
  return result
}
