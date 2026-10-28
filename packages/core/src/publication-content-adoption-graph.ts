import type { NotionBlockBoundary, NotionQuoteNode, NotionTextSpan } from "./markdown.ts"

interface GraphPage {
  readonly id: string
  readonly path: string
  readonly markdown: string
  readonly blocks?: readonly NotionBlockBoundary[]
}

function headingSpans(value: readonly NotionTextSpan[]) {
  return (
    value.length > 0 &&
    value.every(
      (span) =>
        span !== null &&
        typeof span === "object" &&
        Object.keys(span).sort().join(",") === "bold,code,link,text" &&
        typeof span.text === "string" &&
        (span.link === null || typeof span.link === "string") &&
        typeof span.bold === "boolean" &&
        typeof span.code === "boolean",
    )
  )
}

/** Reconstruct only the prior root-heading projection. This is a digest
 * preimage, never a content-equivalence decision. The caller must first compare
 * every retained raw resource, then require this entire graph to reproduce the
 * original frozen digest. IDs, paths, Markdown, order, other block fields and
 * newly added descendants/empty quotes are all preserved. */
export function priorHeadingContentAdoptionGraph(pages: readonly GraphPage[]) {
  const result: Array<{
    id: string
    path: string
    markdown: string
    blocks: NotionBlockBoundary[]
  }> = []
  const ids = new Set<string>(),
    paths = new Set<string>()
  let changed = false
  for (const page of pages) {
    if (
      typeof page.id !== "string" ||
      !page.id ||
      ids.has(page.id) ||
      typeof page.path !== "string" ||
      !page.path ||
      paths.has(page.path) ||
      typeof page.markdown !== "string" ||
      !Array.isArray(page.blocks)
    )
      return
    ids.add(page.id)
    paths.add(page.path)
    const blocks: NotionBlockBoundary[] = [],
      roots = new Set<string>()
    for (const block of page.blocks) {
      if (
        !block ||
        typeof block.id !== "string" ||
        !block.id ||
        roots.has(block.id) ||
        typeof block.type !== "string" ||
        !block.type ||
        typeof block.has_children !== "boolean"
      )
        return
      roots.add(block.id)
      const before = { ...block }
      if (["heading_1", "heading_2", "heading_3"].includes(block.type)) {
        const hasText = Object.hasOwn(block, "text"),
          hasSpans = Object.hasOwn(block, "rich_text")
        if (
          (hasText && typeof block.text !== "string") ||
          (hasSpans && (!Array.isArray(block.rich_text) || !headingSpans(block.rich_text)))
        )
          return
        if (
          hasText &&
          hasSpans &&
          (block.rich_text!.some((span: NotionTextSpan) => span.link !== null) ||
            block.rich_text!.map((span: NotionTextSpan) => span.text).join("") !== block.text)
        )
          return
        if (hasText || hasSpans) {
          delete before.text
          delete before.rich_text
          changed = true
        }
      }
      blocks.push(before)
    }
    result.push({ id: page.id, path: page.path, markdown: page.markdown, blocks })
  }
  return changed ? result : undefined
}

type EvidenceNode = NotionBlockBoundary &
  Partial<Pick<NotionQuoteNode, "parent_id" | "table" | "table_row">>
const nodeKeys = [
  "id",
  "type",
  "has_children",
  "text",
  "rich_text",
  "code",
  "numbered_list",
  "to_do",
]
const identity = (value: string) =>
  /^[0-9a-f-]+$/i.test(value) && value.replaceAll("-", "").length === 32
    ? value.replaceAll("-", "").toLowerCase()
    : value
function keys(value: unknown, allowed: readonly string[]) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  )
}
function spans(value: unknown): value is readonly NotionTextSpan[] {
  return Array.isArray(value) && (value.length === 0 || headingSpans(value))
}
function nodeShape(node: EvidenceNode, additional: readonly string[]) {
  if (
    !node ||
    !keys(node, [...nodeKeys, ...additional]) ||
    typeof node.id !== "string" ||
    !node.id ||
    typeof node.type !== "string" ||
    !node.type ||
    typeof node.has_children !== "boolean" ||
    (node.text !== undefined && typeof node.text !== "string") ||
    (node.rich_text !== undefined && !spans(node.rich_text))
  )
    return false
  if (
    node.text !== undefined &&
    node.rich_text !== undefined &&
    (node.rich_text.some((span) => span.link !== null) ||
      node.rich_text.map((span) => span.text).join("") !== node.text)
  )
    return false
  if (
    node.code !== undefined &&
    (node.type !== "code" ||
      node.has_children ||
      !keys(node.code, ["text", "language"]) ||
      typeof node.code.text !== "string" ||
      typeof node.code.language !== "string")
  )
    return false
  if (
    node.numbered_list !== undefined &&
    (node.type !== "numbered_list_item" ||
      !keys(node.numbered_list, ["start"]) ||
      (node.numbered_list.start !== null &&
        (!Number.isSafeInteger(node.numbered_list.start) || node.numbered_list.start < 1)))
  )
    return false
  if (
    node.to_do !== undefined &&
    (node.type !== "to_do" ||
      node.has_children ||
      !keys(node.to_do, ["checked"]) ||
      typeof node.to_do.checked !== "boolean")
  )
    return false
  return true
}

function completeTree(
  root: NotionBlockBoundary,
  nodes: readonly EvidenceNode[],
  grammar: "ordinary" | "quote" | "list_table",
  ids: Set<string>,
) {
  if (!root.has_children || !Array.isArray(nodes) || !nodes.length) return false
  const counts = new Map<string, number>(),
    stack: EvidenceNode[] = [root]
  for (const node of nodes) {
    if (
      !nodeShape(
        node,
        grammar === "ordinary" ? ["parent_id"] : ["parent_id", "table", "table_row"],
      ) ||
      typeof node.parent_id !== "string" ||
      !node.parent_id ||
      ids.has(identity(node.id))
    )
      return false
    ids.add(identity(node.id))
    while (stack.length && stack.at(-1)!.id !== node.parent_id) stack.pop()
    const parent = stack.at(-1)
    if (
      !parent?.has_children ||
      node.to_do !== undefined ||
      (node.code !== undefined && grammar !== "quote")
    )
      return false
    counts.set(parent.id, (counts.get(parent.id) ?? 0) + 1)
    if (grammar === "ordinary") {
      if (
        !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(node.type) ||
        (node.type === "paragraph" && node.has_children)
      )
        return false
    } else if (node.type === "table") {
      if (
        parent.id !== root.id ||
        !node.has_children ||
        node.rich_text !== undefined ||
        node.text !== undefined ||
        !keys(node.table, ["width", "header_row", "header_column"]) ||
        !node.table ||
        !Number.isSafeInteger(node.table.width) ||
        node.table.width < 1 ||
        node.table.header_row !== true ||
        node.table.header_column !== false ||
        node.table_row !== undefined
      )
        return false
    } else if (node.type === "table_row") {
      if (
        parent.type !== "table" ||
        !parent.table ||
        node.has_children ||
        node.table !== undefined ||
        node.rich_text !== undefined ||
        node.text !== undefined ||
        !keys(node.table_row, ["cells"]) ||
        !Array.isArray(node.table_row?.cells) ||
        node.table_row.cells.length !== parent.table.width ||
        !node.table_row.cells.every(spans)
      )
        return false
    } else if (grammar === "quote" && node.type === "code") {
      if (
        parent.id !== root.id ||
        node.has_children ||
        !node.code ||
        node.text !== undefined ||
        node.rich_text !== undefined ||
        node.numbered_list !== undefined ||
        node.table !== undefined ||
        node.table_row !== undefined
      )
        return false
    } else if (grammar === "quote") {
      if (
        parent.id !== root.id ||
        node.has_children ||
        !node.rich_text?.length ||
        !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(node.type) ||
        node.table !== undefined ||
        node.table_row !== undefined ||
        (node.type === "numbered_list_item" && node.numbered_list === undefined)
      )
        return false
    } else return false
    stack.push(node)
  }
  if (
    ids.size > 4096 ||
    [root, ...nodes].some((node) => node.has_children !== (counts.get(node.id) ?? 0) > 0)
  )
    return false
  if (grammar !== "list_table") return true
  const tables = nodes.filter((node) => node.type === "table")
  return tables.length >= 1 && tables.length <= 2
}

function completeRootTable(root: NotionBlockBoundary, ids: Set<string>) {
  const table = root.table_evidence
  if (
    root.type !== "table" ||
    !root.has_children ||
    !table ||
    root.text !== undefined ||
    root.rich_text !== undefined ||
    root.code !== undefined ||
    root.numbered_list !== undefined ||
    root.to_do !== undefined ||
    !keys(table, ["width", "header_row", "header_column", "rows"]) ||
    !Number.isSafeInteger(table.width) ||
    table.width < 1 ||
    table.header_row !== true ||
    table.header_column !== false ||
    !Array.isArray(table.rows) ||
    !table.rows.length
  )
    return false
  for (const row of table.rows) {
    if (
      !nodeShape(row, ["parent_id", "table_row"]) ||
      ids.has(identity(row.id)) ||
      row.type !== "table_row" ||
      row.has_children ||
      row.parent_id !== root.id ||
      row.text !== undefined ||
      row.rich_text !== undefined ||
      row.code !== undefined ||
      row.numbered_list !== undefined ||
      row.to_do !== undefined ||
      !keys(row.table_row, ["cells"]) ||
      !Array.isArray(row.table_row?.cells) ||
      row.table_row.cells.length !== table.width ||
      !row.table_row.cells.every(spans)
    )
      return false
    ids.add(identity(row.id))
  }
  return ids.size <= 4096
}

/** These are digest preimages of deployed readers, never alternate body
 * proofs. Call only after complete raw resources, page IDs and Files evidence
 * are equal. New projection fields must have their complete supported shape;
 * unknown fields and partial trees do not authorize a compatibility candidate. */
export function priorContentAdoptionGraphs(pages: readonly GraphPage[]) {
  const result: Array<{
    id: string
    path: string
    markdown: string
    blocks: NotionBlockBoundary[]
  }> = []
  const beforeQuoteCode: typeof result = []
  const beforeRootTable: typeof result = []
  const beforeOrdinaryNumbered: typeof result = []
  const beforeTwoListTables: typeof result = []
  const pageIds = new Set<string>(),
    paths = new Set<string>()
  let changed = false,
    quoteCodeChanged = false,
    rootTableChanged = false,
    ordinaryNumberedChanged = false,
    twoListTablesChanged = false
  for (const page of pages) {
    if (
      typeof page.id !== "string" ||
      !page.id ||
      pageIds.has(identity(page.id)) ||
      typeof page.path !== "string" ||
      !page.path ||
      paths.has(page.path) ||
      typeof page.markdown !== "string" ||
      !Array.isArray(page.blocks)
    )
      return
    pageIds.add(identity(page.id))
    paths.add(page.path)
    const ids = new Set<string>(),
      blocks: NotionBlockBoundary[] = [],
      priorQuoteBlocks: NotionBlockBoundary[] = [],
      priorTableBlocks: NotionBlockBoundary[] = [],
      priorNumberedBlocks: NotionBlockBoundary[] = [],
      priorTwoTableBlocks: NotionBlockBoundary[] = []
    for (const block of page.blocks) {
      if (
        !nodeShape(block, [
          "descendants",
          "quote_descendants",
          "list_table_descendants",
          "table_evidence",
        ]) ||
        ids.has(identity(block.id))
      )
        return
      ids.add(identity(block.id))
      const list = ["numbered_list_item", "bulleted_list_item"].includes(block.type)
      const trees = [
        block.descendants,
        block.quote_descendants,
        block.list_table_descendants,
        block.table_evidence,
      ]
      if (trees.filter((value) => value !== undefined).length > 1) return
      if (block.table_evidence !== undefined && !completeRootTable(block, ids)) return
      if (
        block.descendants !== undefined &&
        (!list || !completeTree(block, block.descendants, "ordinary", ids))
      )
        return
      if (
        block.quote_descendants !== undefined &&
        (block.type !== "quote" ||
          !block.rich_text?.length ||
          !completeTree(block, block.quote_descendants, "quote", ids))
      )
        return
      if (
        block.list_table_descendants !== undefined &&
        (!list ||
          !block.rich_text?.length ||
          (block.type === "numbered_list_item" && block.numbered_list === undefined) ||
          !completeTree(block, block.list_table_descendants, "list_table", ids))
      )
        return
      if (
        block.type === "numbered_list_item" &&
        block.has_children &&
        block.numbered_list !== undefined &&
        block.list_table_descendants === undefined &&
        block.descendants === undefined
      )
        return
      // The prior reader omitted a list-table projection for two direct
      // tables. Reconstruct that one model only after the complete tree above
      // validates; single tables and ordinary numbered starts remain intact.
      const priorTwoTables = { ...block }
      if (
        block.list_table_descendants?.filter((node: NotionQuoteNode) => node.type === "table")
          .length === 2
      ) {
        delete priorTwoTables.list_table_descendants
        if (block.type === "numbered_list_item") delete priorTwoTables.numbered_list
        twoListTablesChanged = true
      }
      priorTwoTableBlocks.push(priorTwoTables)
      // Only this new root field is removed after its complete ordinary tree
      // validates. Every older read model starts from this immediate prior view.
      const priorNumbered = { ...priorTwoTables }
      if (
        block.type === "numbered_list_item" &&
        block.has_children &&
        block.descendants !== undefined &&
        block.numbered_list !== undefined
      ) {
        delete priorNumbered.numbered_list
        ordinaryNumberedChanged = true
      }
      priorNumberedBlocks.push(priorNumbered)
      // The immediately prior reader rejected the entire quote descendant
      // projection when any direct child was code. All pre-existing container,
      // task, numbered-start and heading fields survive this one transition.
      const priorTable = { ...priorNumbered }
      if (block.table_evidence !== undefined) {
        delete priorTable.table_evidence
        rootTableChanged = true
      }
      priorTableBlocks.push(priorTable)
      const priorQuote = { ...priorTable }
      if (block.quote_descendants?.some((node: NotionQuoteNode) => node.type === "code")) {
        delete priorQuote.quote_descendants
        quoteCodeChanged = true
      }
      priorQuoteBlocks.push(priorQuote)
      const before = { ...priorTable }
      if (block.quote_descendants !== undefined) {
        delete before.quote_descendants
        changed = true
      }
      if (block.list_table_descendants !== undefined) {
        delete before.list_table_descendants
        if (block.type === "numbered_list_item") delete before.numbered_list
        changed = true
      }
      if (block.type === "to_do") {
        if (
          block.descendants !== undefined ||
          block.quote_descendants !== undefined ||
          block.list_table_descendants !== undefined ||
          ((block.text !== undefined || block.rich_text !== undefined) && block.to_do === undefined)
        )
          return
        if (
          block.to_do !== undefined ||
          block.rich_text !== undefined ||
          block.text !== undefined
        ) {
          delete before.to_do
          delete before.rich_text
          delete before.text
          changed = true
        }
      }
      blocks.push(before)
    }
    if (ids.size > 4096) return
    result.push({ id: page.id, path: page.path, markdown: page.markdown, blocks })
    beforeQuoteCode.push({
      id: page.id,
      path: page.path,
      markdown: page.markdown,
      blocks: priorQuoteBlocks,
    })
    beforeRootTable.push({
      id: page.id,
      path: page.path,
      markdown: page.markdown,
      blocks: priorTableBlocks,
    })
    beforeOrdinaryNumbered.push({
      id: page.id,
      path: page.path,
      markdown: page.markdown,
      blocks: priorNumberedBlocks,
    })
    beforeTwoListTables.push({
      id: page.id,
      path: page.path,
      markdown: page.markdown,
      blocks: priorTwoTableBlocks,
    })
  }
  const candidates: Array<{
    model:
      | "before-two-list-tables"
      | "before-ordinary-numbered-start"
      | "before-root-table-evidence"
      | "before-quote-code-evidence"
      | "root-headings-before-container-evidence"
      | "before-root-headings"
    pages: readonly GraphPage[]
  }> = []
  if (twoListTablesChanged)
    candidates.push({ model: "before-two-list-tables", pages: beforeTwoListTables })
  if (ordinaryNumberedChanged)
    candidates.push({ model: "before-ordinary-numbered-start", pages: beforeOrdinaryNumbered })
  // These readers existed in sequence. Older candidates also omit root-table
  // evidence, which did not exist in either of the preceding container models.
  if (rootTableChanged)
    candidates.push({ model: "before-root-table-evidence", pages: beforeRootTable })
  if (quoteCodeChanged)
    candidates.push({ model: "before-quote-code-evidence", pages: beforeQuoteCode })
  // Reader immediately before quote/table and task evidence: headings already
  // projected; tasks were sentinels and non-leaf numbered starts were absent.
  if (changed) candidates.push({ model: "root-headings-before-container-evidence", pages: result })
  // Earlier reader also represented root headings as the same three-field
  // sentinel. Ordinary list descendants and all other fields remain unchanged.
  const headings = priorHeadingContentAdoptionGraph(result)
  if (headings) candidates.push({ model: "before-root-headings", pages: headings })
  return candidates.length ? candidates : undefined
}
