import { samePublishedMarkdown, type NotionBlockBoundary } from "./markdown.ts"
import { mapMarkdownLinks } from "./typed-links.ts"

/** Spell an already graph-mapped source using only its observed Notion URL
 * aliases. The existing publication comparator must independently prove this
 * target unchanged; paths, query strings, fragments and external URLs cannot
 * acquire a new equivalence from physical readback evidence. */
export function physicalReadbackTarget(
  markdown: string,
  blocks: readonly NotionBlockBoundary[] | undefined,
) {
  if (!blocks) return markdown
  const identity = (url: string) => {
    const match =
      /^https:\/\/(?:www\.notion\.so|app\.notion\.com\/p)\/([0-9a-f]{32})(?=$|[?#])/i.exec(url)
    return match ? `${match[1]!.toLowerCase()}${url.slice(match[0].length)}` : undefined
  }
  const observed = new Map<string, Set<string>>()
  const add = (url: string | null) => {
    if (url === null) return
    const key = identity(url)
    if (key === undefined) return
    const values = observed.get(key) ?? new Set<string>()
    values.add(url)
    observed.set(key, values)
  }
  for (const root of blocks) {
    for (const node of [root, ...(root.descendants ?? [])])
      for (const span of node.rich_text ?? []) add(span.link)
    for (const node of [
      ...(root.quote_descendants ?? []),
      ...(root.list_table_descendants ?? []),
      ...(root.table_evidence?.rows ?? []),
    ]) {
      for (const span of node.rich_text ?? []) add(span.link)
      for (const cell of node.table_row?.cells ?? []) for (const span of cell) add(span.link)
    }
  }
  const result = mapMarkdownLinks(markdown, (url) => {
    const key = identity(url),
      values = key === undefined ? undefined : observed.get(key)
    return values?.size === 1 ? values.values().next().value! : url
  })
  return result === markdown || samePublishedMarkdown(result, markdown) ? result : markdown
}
