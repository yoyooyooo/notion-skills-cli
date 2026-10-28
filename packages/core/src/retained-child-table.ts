import { Lexer } from "marked"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function identifier(value: unknown) {
  return typeof value === "string" &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : undefined
}

const pageTag =
  /^<page url="https:\/\/(?:app\.notion\.com\/p\/|(?:www\.)?notion\.so\/)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})">([^<>\n]*)<\/page>$/i

/** A retained child-page suffix is a separate physical root, even when Marked
 * consumes its single-newline boundary as extra pipe-table rows. Prove the
 * complete suffix against the complete root inventory before parsing only the
 * authored table. The submitted request and publication journal stay intact.
 * Other HTML, code examples and incomplete child inventories are not removed. */
export function retainedChildTableSource(
  pageId: string,
  markdown: string,
  roots: readonly unknown[],
): string | undefined {
  const owner = identifier(pageId)
  if (!owner) return
  const children = roots.filter((root) => record(root) && root.type === "child_page")
  if (!children.length || roots.length <= children.length) return
  const ids = new Set<string>()
  for (const root of roots) {
    if (!record(root)) return
    const id = identifier(root.id)
    if (
      !id ||
      ids.has(id) ||
      root.archived === true ||
      root.is_archived === true ||
      root.in_trash === true ||
      !record(root.parent) ||
      root.parent.type !== "page_id" ||
      identifier(root.parent.page_id) !== owner
    )
      return
    ids.add(id)
  }
  const tail = roots.slice(-children.length)
  if (tail.some((root, index) => root !== children[index])) return
  const previous = roots[roots.length - children.length - 1]
  if (!record(previous) || previous.type !== "table") return

  // Marked normalizes CRLF before lexing; this is an in-memory parser input,
  // never a new Markdown request or a replacement for frozen source bytes.
  const text = markdown.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  let end = lines.length
  while (end > 0 && lines[end - 1] === "") end--
  let start = end
  while (start > 0 && pageTag.test(lines[start - 1]!)) start--
  if (end - start !== children.length) return
  const tags = lines.slice(start, end)
  for (const [index, line] of tags.entries()) {
    const match = pageTag.exec(line)
    const child = children[index]
    if (
      !match ||
      !record(child) ||
      identifier(match[1]) !== identifier(child.id) ||
      typeof child.has_children !== "boolean" ||
      !record(child.child_page) ||
      typeof child.child_page.title !== "string" ||
      match[2] !== child.child_page.title
    )
      return
  }

  // Only the final table token may have absorbed the standalone suffix. This
  // excludes tags inside fences, inline code, quotes, cells or an earlier run.
  const last = Lexer.lex(text)
    .filter((token) => token.type !== "space")
    .at(-1)
  if (
    !record(last) ||
    last.type !== "table" ||
    !Array.isArray(last.header) ||
    !Array.isArray(last.rows) ||
    typeof last.raw !== "string" ||
    !last.raw.trimEnd().endsWith(tags.join("\n")) ||
    last.rows.length < tags.length
  )
    return
  const extraRows = last.rows.slice(-tags.length)
  for (const [index, row] of extraRows.entries()) {
    if (
      !Array.isArray(row) ||
      row.length !== last.header.length ||
      row.some((cell, column) => !record(cell) || cell.text !== (column === 0 ? tags[index] : ""))
    )
      return
  }
  const offset = lines.slice(0, start).reduce((length, line) => length + line.length + 1, 0)
  const authored = text.slice(0, offset)
  const authoredLast = Lexer.lex(authored)
    .filter((token) => token.type !== "space")
    .at(-1)
  if (
    !record(authoredLast) ||
    authoredLast.type !== "table" ||
    JSON.stringify(authoredLast.header) !== JSON.stringify(last.header) ||
    JSON.stringify(authoredLast.rows) !== JSON.stringify(last.rows.slice(0, -tags.length))
  )
    return
  return authored
}

/** Retain the complete page suffix; only the parser boundary becomes explicit.
 * This comparison view is never a request or a replacement for retained bytes. */
export function retainedChildTableComparison(
  pageId: string,
  markdown: string,
  roots: readonly unknown[],
): string | undefined {
  const authored = retainedChildTableSource(pageId, markdown, roots)
  if (authored === undefined) return
  const normalized = markdown.replace(/\r\n/g, "\n")
  return `${authored}\n${normalized.slice(authored.length)}`
}

/** Recover only a complete, ordered root chain from the successful read phase.
 * Descendant inventories cannot substitute for root ownership or cursor proof. */
export function retainedChildTableRootBlocks(
  pageId: string,
  raw: Readonly<Record<string, unknown>>,
): readonly unknown[] | undefined {
  if (!identifier(pageId)) return
  const roots: unknown[] = [],
    cursors = new Set<string>()
  let cursor: string | undefined
  for (let count = 0; count < 50; count++) {
    const path = `v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`
    const page = raw[path]
    if (
      !record(page) ||
      page.object !== "list" ||
      !Array.isArray(page.results) ||
      typeof page.has_more !== "boolean"
    )
      return
    roots.push(...page.results)
    if (roots.length > 4096) return
    if (!page.has_more) return page.next_cursor == null ? roots : undefined
    if (typeof page.next_cursor !== "string" || !page.next_cursor || cursors.has(page.next_cursor))
      return
    cursor = page.next_cursor
    cursors.add(cursor)
  }
}
