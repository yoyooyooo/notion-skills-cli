import {
  fromNotionMarkdown,
  markdownStructure,
  notionMarkdownForComparison,
  sameMarkdownStructure,
  type MarkdownLinkDestinationMatch,
  type NotionBlockBoundary,
  type NotionQuoteNode,
  type NotionTextSpan,
} from "@notion-skills-cli/markdown"

export {
  zeroStartPresentation,
  codeLanguage,
  fromNotionMarkdown,
  markdownIdentity,
  markdownStructure,
  notionMarkdownForComparison,
  stripNotionInlineBoundaries,
  type MarkdownLinkDestinationMatch,
  type NotionBlockBoundary,
  type NotionQuoteNode,
  type NotionTextSpan,
} from "@notion-skills-cli/markdown"

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
  heading_1: true,
  heading_2: true,
  heading_3: true,
  to_do: true,
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
    if (block.type === "to_do") {
      if (block.has_children || typeof body?.checked !== "boolean") {
        result.push(boundary)
        continue
      }
      boundary = { ...boundary, to_do: { checked: body.checked } }
    }
    if (block.type === "numbered_list_item" && !block.has_children) {
      const numbered = projectNumberedList(body)
      if (numbered) boundary = { ...boundary, numbered_list: numbered }
    }
    const richText = body?.rich_text
    if (
      block.type === "quote" &&
      !block.has_children &&
      Array.isArray(richText) &&
      richText.length === 0
    ) {
      result.push({ ...boundary, rich_text: [], text: "" })
      continue
    }
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

// Quote children use their own complete grammar. Ordinary-list evidence remains separate.
function quoteSpans(values: unknown) {
  if (!Array.isArray(values)) return
  const spans = projectTextSpans(values)
  if (!spans) return
  for (const value of values) {
    const item = record(value)!,
      annotations = record(item.annotations)!
    const link = record(record(item.text)?.link)?.url ?? null
    if (
      (item.href !== undefined && item.href !== link) ||
      annotations.strikethrough === true ||
      annotations.underline === true ||
      (annotations.color !== undefined && annotations.color !== "default")
    )
      return
  }
  return spans
}

function quoteDescendants(
  root: NotionBlockBoundary,
  descendants: readonly (NotionBlockBoundary & { parent_id: string })[],
  rawById: ReadonlyMap<string, unknown>,
) {
  const rawRoot = record(rawById.get(root.id)),
    rootText = quoteSpans(record(rawRoot?.quote)?.rich_text)
  if (
    !root.has_children ||
    !descendants.length ||
    !rootText?.length ||
    rawRoot?.archived === true ||
    rawRoot?.in_trash === true
  )
    return
  const nodes: NotionQuoteNode[] = []
  const counts = new Map<string, number>()
  for (const node of descendants) counts.set(node.parent_id, (counts.get(node.parent_id) ?? 0) + 1)
  if ([root, ...descendants].some((node) => node.has_children !== (counts.get(node.id) ?? 0) > 0))
    return
  for (const node of descendants) {
    const raw = record(rawById.get(node.id)),
      body = record(raw?.[node.type])
    if (!raw || raw.archived === true || raw.in_trash === true) return
    if (node.type === "code") {
      if (
        node.parent_id !== root.id ||
        node.has_children ||
        !node.code ||
        !body ||
        !Array.isArray(body.rich_text) ||
        (body.caption !== undefined && (!Array.isArray(body.caption) || body.caption.length > 0)) ||
        body.rich_text.some((value: unknown) => {
          const span = record(value),
            style = record(span?.annotations)
          return (
            !span ||
            span.href != null ||
            !style ||
            style.color !== "default" ||
            ["bold", "italic", "strikethrough", "underline", "code"].some(
              (key) => style[key] !== false,
            )
          )
        })
      )
        return
      nodes.push(node)
    } else if (node.type === "table") {
      if (
        node.parent_id !== root.id ||
        !node.has_children ||
        typeof body?.table_width !== "number" ||
        !Number.isSafeInteger(body.table_width) ||
        body.table_width < 1 ||
        typeof body.has_column_header !== "boolean" ||
        typeof body.has_row_header !== "boolean"
      )
        return
      nodes.push({
        ...node,
        table: {
          width: body.table_width,
          header_row: body.has_column_header,
          header_column: body.has_row_header,
        },
      })
    } else if (node.type === "table_row") {
      const table = nodes.find((parent) => parent.id === node.parent_id)?.table
      if (
        !table ||
        node.has_children ||
        !Array.isArray(body?.cells) ||
        body.cells.length !== table.width
      )
        return
      const cells: NotionTextSpan[][] = []
      for (const cell of body.cells) {
        const spans = quoteSpans(cell)
        if (!spans) return
        cells.push(spans)
      }
      nodes.push({ ...node, table_row: { cells } })
    } else {
      if (
        node.parent_id !== root.id ||
        node.has_children ||
        !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(node.type) ||
        (node.type === "numbered_list_item" && node.numbered_list === undefined)
      )
        return
      const spans = quoteSpans(body?.rich_text)
      if (!spans?.length) return
      nodes.push({ ...node, rich_text: spans })
    }
  }
  return nodes
}

function listTableDescendants(
  root: NotionBlockBoundary,
  descendants: readonly (NotionBlockBoundary & { parent_id: string })[],
  rawById: ReadonlyMap<string, unknown>,
) {
  const rawRoot = record(rawById.get(root.id)),
    body = record(rawRoot?.[root.type])
  const spans = quoteSpans(body?.rich_text)
  if (
    !root.has_children ||
    !["numbered_list_item", "bulleted_list_item"].includes(root.type) ||
    rawRoot?.archived === true ||
    rawRoot?.in_trash === true ||
    !spans?.length ||
    !descendants.length
  )
    return
  const nodes: NotionQuoteNode[] = []
  let cursor = 0,
    tables = 0
  while (cursor < descendants.length) {
    const table = descendants[cursor++]!
    if (
      ++tables > 2 ||
      table.type !== "table" ||
      table.parent_id !== root.id ||
      !table.has_children
    )
      return
    const rawTable = record(rawById.get(table.id)),
      shape = record(rawTable?.table)
    if (
      !rawTable ||
      rawTable.archived === true ||
      rawTable.in_trash === true ||
      typeof shape?.table_width !== "number" ||
      !Number.isSafeInteger(shape.table_width) ||
      shape.table_width < 1 ||
      shape.has_column_header !== true ||
      shape.has_row_header !== false
    )
      return
    nodes.push({
      ...table,
      table: { width: shape.table_width, header_row: true, header_column: false },
    })
    let rows = 0
    while (descendants[cursor]?.type === "table_row") {
      const row = descendants[cursor++]!,
        raw = record(rawById.get(row.id)),
        cells = record(raw?.table_row)?.cells
      if (
        row.parent_id !== table.id ||
        row.has_children ||
        !raw ||
        raw.archived === true ||
        raw.in_trash === true ||
        !Array.isArray(cells) ||
        cells.length !== shape.table_width
      )
        return
      const projected: NotionTextSpan[][] = []
      for (const cell of cells) {
        const spans = quoteSpans(cell)
        if (!spans) return
        projected.push(spans)
      }
      nodes.push({ ...row, table_row: { cells: projected } })
      rows++
    }
    if (!rows) return
  }
  const numbered = root.type === "numbered_list_item" ? projectNumberedList(body) : undefined
  if (root.type === "numbered_list_item" && !numbered) return
  return {
    rich_text: spans,
    list_table_descendants: nodes,
    ...(numbered ? { numbered_list: numbered } : {}),
  }
}

function rootTableEvidence(
  root: NotionBlockBoundary,
  descendants: readonly (NotionBlockBoundary & { parent_id: string })[],
  rawById: ReadonlyMap<string, unknown>,
) {
  const raw = record(rawById.get(root.id)),
    shape = record(raw?.table)
  if (
    root.type !== "table" ||
    !root.has_children ||
    !descendants.length ||
    !raw ||
    raw.archived === true ||
    raw.in_trash === true ||
    !shape ||
    Object.keys(shape).some(
      (key) => !["table_width", "has_column_header", "has_row_header"].includes(key),
    ) ||
    typeof shape.table_width !== "number" ||
    !Number.isSafeInteger(shape.table_width) ||
    shape.table_width < 1 ||
    shape.has_column_header !== true ||
    shape.has_row_header !== false
  )
    return
  const rows: NotionQuoteNode[] = []
  for (const row of descendants) {
    const rawRow = record(rawById.get(row.id)),
      body = record(rawRow?.table_row),
      cells = body?.cells
    if (
      row.type !== "table_row" ||
      row.parent_id !== root.id ||
      row.has_children ||
      !rawRow ||
      rawRow.archived === true ||
      rawRow.in_trash === true ||
      !body ||
      Object.keys(body).some((key) => key !== "cells") ||
      !Array.isArray(cells) ||
      cells.length !== shape.table_width
    )
      return
    const projected: NotionTextSpan[][] = []
    for (const cell of cells) {
      const spans = quoteSpans(cell)
      if (
        !spans ||
        !Array.isArray(cell) ||
        cell.some((value: unknown) => {
          const span = record(value),
            text = record(span?.text),
            style = record(span?.annotations)
          const link = text?.link == null ? null : record(text.link)
          return (
            !span ||
            !text ||
            !style ||
            span.plain_text !== text.content ||
            span.href !== (link === null ? null : link?.url) ||
            Object.keys(text).some((key) => key !== "content" && key !== "link") ||
            (link !== null && (!link || Object.keys(link).some((key) => key !== "url"))) ||
            Object.keys(style).some(
              (key) =>
                !["bold", "italic", "strikethrough", "underline", "code", "color"].includes(key),
            ) ||
            style.italic !== false ||
            style.strikethrough !== false ||
            style.underline !== false ||
            style.color !== "default"
          )
        })
      )
        return
      projected.push(spans)
    }
    rows.push({ ...row, table_row: { cells: projected } })
  }
  return { width: shape.table_width, header_row: true, header_column: false, rows }
}

// A flat DFS inventory keeps ownership explicit in snapshots. Descendant proof
// is attached only for complete ordinary list trees; other roots remain sentinels.
export function projectNotionBlockTree(page: string, blocks: readonly unknown[]) {
  const projected = projectNotionBlocks(blocks)
  if (!projected || blocks.length > 4096) return
  const identity = (value: string) =>
    /^[0-9a-f-]+$/i.test(value) && value.replaceAll("-", "").length === 32
      ? value.replaceAll("-", "").toLowerCase()
      : value
  const owner = identity(page),
    ids = new Set<string>([owner])
  const roots: Array<{
    block: NotionBlockBoundary
    descendants: Array<NotionBlockBoundary & { parent_id: string }>
    depths: number[]
  }> = []
  const stack: Array<{ id: string; key: string; has_children: boolean }> = []
  for (const [index, value] of blocks.entries()) {
    const raw = record(value),
      block = projected[index]!,
      parent = record(raw?.parent)
    const parentId =
      parent?.type === "page_id"
        ? parent.page_id
        : parent?.type === "block_id"
          ? parent.block_id
          : undefined
    if (typeof parentId !== "string" || !parentId) return
    const key = identity(block.id),
      parentKey = identity(parentId)
    if (ids.has(key)) return
    ids.add(key)
    if (parentKey === owner) {
      roots.push({ block, descendants: [], depths: [] })
      stack.length = 0
    } else {
      if (parent?.type !== "block_id") return
      while (stack.length && stack.at(-1)!.key !== parentKey) stack.pop()
      const ancestor = stack.at(-1),
        root = roots.at(-1)
      if (!ancestor || !ancestor.has_children || !root) return
      root.descendants.push({ ...block, parent_id: ancestor.id })
      root.depths.push(stack.length)
    }
    stack.push({ id: block.id, key, has_children: block.has_children })
  }
  const supported = new Set(["paragraph", "bulleted_list_item", "numbered_list_item"])
  const rawById = new Map(blocks.map((block, index) => [projected[index]!.id, block]))
  return roots.map(({ block, descendants, depths }): NotionBlockBoundary => {
    if (block.type === "table" && block.has_children && depths.every((depth) => depth === 1)) {
      const table = rootTableEvidence(block, descendants, rawById)
      if (table) return { ...block, table_evidence: table }
    }
    if (block.type === "quote" && block.has_children) {
      const complete = depths.every((depth) => depth <= 2)
        ? quoteDescendants(block, descendants, rawById)
        : undefined
      return complete ? { ...block, quote_descendants: complete } : block
    }
    if (
      block.has_children &&
      ["bulleted_list_item", "numbered_list_item"].includes(block.type) &&
      depths.every((depth) => depth <= 2)
    ) {
      const table = listTableDescendants(block, descendants, rawById)
      if (table) return { ...block, ...table }
    }
    if (
      !block.has_children ||
      !["bulleted_list_item", "numbered_list_item"].includes(block.type) ||
      !descendants.length ||
      depths.some((depth) => depth > 32) ||
      descendants.some(
        (child) => !supported.has(child.type) || (child.type === "paragraph" && child.has_children),
      )
    )
      return block
    const childCounts = new Map<string, number>()
    for (const child of descendants)
      childCounts.set(child.parent_id, (childCounts.get(child.parent_id) ?? 0) + 1)
    if (
      [block, ...descendants].some(
        (node) => node.has_children !== (childCounts.get(node.id) ?? 0) > 0,
      )
    )
      return block
    const rawRoot = record(rawById.get(block.id))
    const numbered =
      block.type === "numbered_list_item"
        ? projectNumberedList(record(rawRoot?.[block.type]))
        : undefined
    return { ...block, descendants, ...(numbered ? { numbered_list: numbered } : {}) }
  })
}

// Page URL aliases and mention placement are publication policy, not syntax.
const pageHtml = (node: unknown) =>
  Array.isArray(node) &&
  node[0] === "html" &&
  typeof node[1] === "string" &&
  /^<\/?page\b/i.test(node[1])
const pageLink = (node: unknown) =>
  Array.isArray(node) &&
  node[0] === "link" &&
  typeof node[1] === "string" &&
  node[1].startsWith("skill://")
const pageMention = (node: unknown) => pageHtml(node) || pageLink(node)
const pageParagraph = (node: unknown) =>
  Array.isArray(node) &&
  node[0] === "paragraph" &&
  Array.isArray(node[1]) &&
  node[1].some(pageMention) &&
  node[1].every((part: unknown) => typeof part === "string" || pageMention(part))
const foldPages = (nodes: readonly unknown[]) => {
  const result: unknown[] = []
  for (const node of nodes) {
    const previous = result.at(-1)
    if (
      !Array.isArray(node) ||
      !pageParagraph(node) ||
      !Array.isArray(previous) ||
      previous[0] !== "list" ||
      !Array.isArray(previous[3])
    ) {
      result.push(node)
      continue
    }
    const items = previous[3]
    const last = items.at(-1)
    const itemBlocks = Array.isArray(last) ? last[2] : undefined
    const paragraph = Array.isArray(itemBlocks) ? itemBlocks.at(-1) : undefined
    if (
      !Array.isArray(last) ||
      !Array.isArray(itemBlocks) ||
      !Array.isArray(paragraph) ||
      paragraph[0] !== "paragraph" ||
      !Array.isArray(paragraph[1]) ||
      !Array.isArray(node[1])
    ) {
      result.push(node)
      continue
    }
    const inline = [...paragraph[1]]
    const pages = [...node[1]]
    if (typeof inline.at(-1) === "string" && !/\s$/.test(inline.at(-1)!) && pages.length)
      inline[inline.length - 1] = `${inline.at(-1)} `
    result[result.length - 1] = [
      previous[0],
      previous[1],
      previous[2],
      [
        ...items.slice(0, -1),
        [last[0], last[1], [...itemBlocks.slice(0, -1), ["paragraph", [...inline, ...pages]]]],
      ],
    ]
  }
  return result
}
const notionPage = (url: string) => {
  const match =
    /^https:\/\/(?:www\.notion\.so|app\.notion\.com\/p)\/([0-9a-f]{32})(?=$|[?#])/i.exec(url)
  return match
    ? `https://www.notion.so/${match[1]!.toLowerCase()}${url.slice(match[0].length)}`
    : url
}

function publicationStructure(nodes: readonly unknown[]): unknown[] {
  const mapped = nodes.map((node) => (Array.isArray(node) ? publicationStructure(node) : node))
  if (mapped[0] === "link" && typeof mapped[1] === "string") mapped[1] = notionPage(mapped[1])
  return foldPages(mapped)
}

export function samePublishedMarkdown(
  actual: string,
  target: string,
  sameLinkDestination?: MarkdownLinkDestinationMatch,
  blocks?: readonly NotionBlockBoundary[],
) {
  const expected = publicationStructure(markdownStructure(target))
  const matches =
    sameMarkdownStructure(
      publicationStructure(markdownStructure(actual)),
      expected,
      sameLinkDestination,
    ) ||
    sameMarkdownStructure(
      publicationStructure(markdownStructure(fromNotionMarkdown(actual, blocks))),
      expected,
      sameLinkDestination,
    )
  if (matches) return true
  const candidate = notionMarkdownForComparison(actual, target, blocks)
  return (
    candidate !== undefined &&
    sameMarkdownStructure(
      publicationStructure(markdownStructure(candidate)),
      expected,
      sameLinkDestination,
    )
  )
}
