import { isDeepStrictEqual } from "node:util"
import { SourceLexer } from "@notion-skills-cli/markdown"
import {
  compileSourceRootBody,
  sourceRootBodyMatches,
  type PhysicalNode,
  type SourceRootBlock,
  type SourceRootBodyModel,
} from "./source-root-completion-physical.ts"

export interface BodyCompletionSnapshot {
  readonly page_before: Record<string, unknown>
  readonly page_after: Record<string, unknown>
  readonly markdown: Record<string, unknown>
  readonly inventories: Readonly<Record<string, Record<string, unknown>>>
}
export interface BodyCompletionRequest {
  readonly method: "PATCH"
  readonly path: string
  readonly body: Record<string, unknown>
}
export interface BodyCompletionDerivation {
  readonly page_id: string
  readonly table_id: string
  readonly row_id: string
  readonly table_root: number
  readonly row: number
  readonly column: number
  readonly before_rows: number
  readonly before_roots: number
  readonly models: readonly SourceRootBodyModel[]
  readonly markdown: readonly string[]
  readonly requests: readonly BodyCompletionRequest[]
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
const without = (value: Record<string, unknown>, omitted: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)))
const active = (value: Record<string, unknown>) =>
  value.in_trash === false &&
  ["archived", "is_archived"].every((key) => value[key] === undefined || value[key] === false)
const time = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : undefined
const advancingTime = (before: unknown, after: unknown) => {
  const first = time(before),
    second = time(after)
  return first !== undefined && second !== undefined && second >= first
}
const childPath = (id: string) => `v1/blocks/${id}/children?page_size=100`
const model = (roots: readonly SourceRootBlock[]): SourceRootBodyModel => ({ version: 1, roots })

/** Only response-envelope request IDs are transport metadata. A property named
 * request_id, a user timestamp, and every physical block field remain bound. */
export function comparableBodyCompletionSnapshot(snapshot: BodyCompletionSnapshot) {
  return {
    page_before: without(snapshot.page_before, ["request_id"]),
    page_after: without(snapshot.page_after, ["request_id"]),
    markdown: without(snapshot.markdown, ["request_id"]),
    inventories: Object.fromEntries(
      Object.entries(snapshot.inventories).map(([path, raw]) => [
        path,
        without(raw, ["request_id"]),
      ]),
    ),
  }
}
export const stableBodyCompletionSnapshot = (
  left: BodyCompletionSnapshot,
  right: BodyCompletionSnapshot,
) =>
  isDeepStrictEqual(comparableBodyCompletionSnapshot(left), comparableBodyCompletionSnapshot(right))

/** The finite completion grammar has only page roots and direct table rows.
 * Consume every supplied GET and node; an opaque/extra/incomplete subtree is
 * not an empty node. The official reader invokes exactly these same GETs. */
export function bodyCompletionTree(
  snapshot: BodyCompletionSnapshot,
  pageId: string,
): readonly PhysicalNode[] | undefined {
  try {
    if (
      !uuid.test(pageId) ||
      !record(snapshot.page_before) ||
      !record(snapshot.page_after) ||
      snapshot.page_before.object !== "page" ||
      snapshot.page_before.id !== pageId ||
      !active(snapshot.page_before) ||
      time(snapshot.page_before.last_edited_time) === undefined ||
      !isDeepStrictEqual(
        without(snapshot.page_before, ["request_id"]),
        without(snapshot.page_after, ["request_id"]),
      ) ||
      !record(snapshot.markdown) ||
      snapshot.markdown.id !== pageId ||
      typeof snapshot.markdown.markdown !== "string" ||
      snapshot.markdown.truncated !== false ||
      !Array.isArray(snapshot.markdown.unknown_block_ids) ||
      snapshot.markdown.unknown_block_ids.length !== 0 ||
      !keys(snapshot.markdown, [
        "object",
        "id",
        "markdown",
        "truncated",
        "unknown_block_ids",
        "request_id",
      ]) ||
      !record(snapshot.inventories)
    )
      return
    const consumed = new Set<string>(),
      ids = new Set<string>()
    const inventory = (
      parentId: string,
      parentType: "page_id" | "block_id",
    ): PhysicalNode[] | undefined => {
      const path = childPath(parentId),
        list = snapshot.inventories[path]
      if (
        !record(list) ||
        consumed.has(path) ||
        list.object !== "list" ||
        list.type !== "block" ||
        !record(list.block) ||
        Object.keys(list.block).length !== 0 ||
        list.has_more !== false ||
        list.next_cursor !== null ||
        !Array.isArray(list.results) ||
        list.results.length > 100 ||
        !keys(list, ["object", "type", "block", "results", "has_more", "next_cursor", "request_id"])
      )
        return
      consumed.add(path)
      const nodes: PhysicalNode[] = []
      for (const raw of list.results) {
        if (
          !record(raw) ||
          raw.object !== "block" ||
          typeof raw.id !== "string" ||
          !uuid.test(raw.id) ||
          raw.id === pageId ||
          ids.has(raw.id) ||
          ids.size >= 256 ||
          typeof raw.type !== "string" ||
          typeof raw.has_children !== "boolean" ||
          !active(raw) ||
          !advancingTime(raw.created_time, raw.last_edited_time) ||
          !record(raw.created_by) ||
          !record(raw.last_edited_by) ||
          !isDeepStrictEqual(raw.parent, { type: parentType, [parentType]: parentId }) ||
          !keys(raw, [
            "object",
            "id",
            "type",
            "parent",
            "has_children",
            "created_time",
            "last_edited_time",
            "created_by",
            "last_edited_by",
            "archived",
            "is_archived",
            "in_trash",
            raw.type,
          ]) ||
          !record(raw[raw.type])
        )
          return
        ids.add(raw.id)
        if (parentType === "block_id" && (raw.type !== "table_row" || raw.has_children)) return
        if (
          parentType === "page_id" &&
          ![
            "paragraph",
            "heading_1",
            "heading_2",
            "heading_3",
            "code",
            "table",
            "bulleted_list_item",
            "divider",
          ].includes(raw.type)
        )
          return
        if (raw.has_children && raw.type !== "table") return
        const children = raw.has_children ? inventory(raw.id, "block_id") : []
        if (!children || (raw.type === "table" && children.length === 0)) return
        nodes.push({ raw, children })
      }
      return nodes
    }
    const roots = inventory(pageId, "page_id")
    return roots &&
      roots.length > 1 &&
      roots.length <= 64 &&
      consumed.size === Object.keys(snapshot.inventories).length
      ? roots
      : undefined
  } catch {
    return
  }
}

function requestSpans(spans: Extract<SourceRootBlock, { type: "table" }>["rows"][number][number]) {
  return spans.flatMap((span) => {
    const result: Array<Record<string, unknown>> = []
    for (let start = 0; start < span.text.length; start += 2000)
      result.push({
        type: "text",
        text: {
          content: span.text.slice(start, start + 2000),
          ...(span.url === null ? {} : { link: { url: span.url } }),
        },
        annotations: { ...span.style },
      })
    return result
  })
}
const requestCells = (row: Extract<SourceRootBlock, { type: "table" }>["rows"][number]) =>
  row.map(requestSpans)

/** Derive exactly one code-literal bullet correction, a suffix of the final
 * existing table, and one final heading followed by flat bullets. Every other
 * physical field/cell/root must already match the complete immutable source. */
export function deriveBodyCompletion(
  source: string,
  marker: string,
  snapshot: BodyCompletionSnapshot,
): BodyCompletionDerivation | undefined {
  try {
    const pageId = snapshot.page_before.id
    if (typeof pageId !== "string" || source.includes("\r") || !marker || /[\r\n]/.test(marker))
      return
    const roots = bodyCompletionTree(snapshot, pageId),
      full = compileSourceRootBody(source),
      markerModel = compileSourceRootBody(marker)
    if (!roots || !full || !markerModel || !sourceRootBodyMatches(markerModel, roots.slice(0, 1)))
      return
    // The complete result must remain readable by the same finite reader.
    // Do not begin a repair whose append would make verification impossible.
    if (
      full.roots.some((block) => block.type === "table" && block.rows.length > 100) ||
      1 +
        full.roots.reduce(
          (count, block) => count + 1 + (block.type === "table" ? block.rows.length : 0),
          0,
        ) >
        256
    )
      return
    const authored = roots.slice(1),
      rootIndex = authored.length - 1
    const table = full.roots[rootIndex],
      current = authored[rootIndex]
    const tail = full.roots.slice(authored.length)
    if (
      !current ||
      current.raw.type !== "table" ||
      table?.type !== "table" ||
      current.children.length < 2 ||
      table.rows.length - current.children.length < 1 ||
      table.rows.length - current.children.length > 10 ||
      tail.length < 2 ||
      tail.length > 9 ||
      tail[0]?.type !== "heading_2" ||
      tail.slice(1).some((block) => block.type !== "bulleted_list_item") ||
      full.roots.length > 63 ||
      !sourceRootBodyMatches(model(full.roots.slice(0, rootIndex)), authored.slice(0, rootIndex))
    )
      return
    const prefix = { ...table, rows: table.rows.slice(0, current.children.length) }
    const candidates: Array<{
      row: number
      column: number
      before: SourceRootBlock
      raw: string
      replacement: string
    }> = []
    for (const [row, cells] of prefix.rows.entries())
      for (const [column, spans] of cells.entries())
        for (const [position, span] of spans.entries()) {
          if (!span.style.code || span.url !== null || !/^- [^\r\n`]+$/.test(span.text)) continue
          const changed = { ...span, text: `  • ${span.text.slice(2)}` }
          const before = {
            ...prefix,
            rows: prefix.rows.map((values, i) =>
              i !== row
                ? values
                : values.map((parts, j) =>
                    j !== column
                      ? parts
                      : parts.map((part, k) => (k === position ? changed : part)),
                  ),
            ),
          }
          if (sourceRootBodyMatches(model([before]), [current]))
            candidates.push({
              row,
              column,
              before,
              raw: `\`${span.text}\``,
              replacement: `\`${changed.text}\``,
            })
        }
    if (candidates.length !== 1) return
    const change = candidates[0]!,
      tableId = current.raw.id,
      rowId = current.children[change.row]?.raw.id
    if (typeof tableId !== "string" || typeof rowId !== "string") return
    // Bind the truncated raw Markdown to this exact table. No arbitrary slice,
    // line replacement, or HTML removal may stand in for physical consumption.
    const tokens = SourceLexer.lex(source)
    if (tokens.map((token) => token.raw).join("") !== source) return
    let offset = 0,
      ordinal = 0,
      tableStart = -1,
      tableEnd = -1,
      rawTable = ""
    for (const token of tokens) {
      if (ordinal === rootIndex && token.type === "table") {
        tableStart = offset
        tableEnd = offset + token.raw.length
        rawTable = token.raw
      }
      offset += token.raw.length
      if (token.type === "space") continue
      if (token.type === "list") {
        if (!Array.isArray(token.items)) return
        ordinal += token.items.length
      } else ordinal++
    }
    const lines = rawTable.split("\n")
    while (lines.at(-1) === "") lines.pop()
    if (
      tableStart < 0 ||
      lines.length !== table.rows.length + 1 ||
      lines.some((line) => !/^\|.*\|[ \t]*$/.test(line))
    )
      return
    const truncated =
      source.slice(0, tableStart) + lines.slice(0, current.children.length + 1).join("\n") + "\n"
    if (truncated.split(change.raw).length !== 2) return
    const beforeSource = truncated.replace(change.raw, change.replacement)
    const fullTableSource = source.slice(0, tableEnd)
    const stages = [beforeSource, truncated, fullTableSource, source]
    const models = stages.map(compileSourceRootBody)
    if (models.some((value) => value === undefined)) return
    const completeModels: SourceRootBodyModel[] = []
    for (const value of models) {
      if (!value) return
      completeModels.push(value)
    }
    if (
      !sourceRootBodyMatches(completeModels[0]!, authored) ||
      !isDeepStrictEqual(completeModels[3], full) ||
      !isDeepStrictEqual(completeModels[1], model([...full.roots.slice(0, rootIndex), prefix])) ||
      !isDeepStrictEqual(completeModels[2], model(full.roots.slice(0, authored.length)))
    )
      return
    const suffix = tail.map((block) => {
      if (block.type !== "heading_2" && block.type !== "bulleted_list_item") return
      return {
        object: "block",
        type: block.type,
        [block.type]: { rich_text: requestSpans(block.rich_text), color: "default" },
      }
    })
    if (suffix.some((value) => value === undefined)) return
    return {
      page_id: pageId,
      table_id: tableId,
      row_id: rowId,
      table_root: rootIndex,
      row: change.row,
      column: change.column,
      before_rows: current.children.length,
      before_roots: authored.length,
      models: completeModels,
      markdown: stages.map((value) => `${marker}\n\n${value}`),
      requests: [
        {
          method: "PATCH",
          path: `v1/blocks/${rowId}`,
          body: { table_row: { cells: requestCells(table.rows[change.row]!) } },
        },
        {
          method: "PATCH",
          path: `v1/blocks/${tableId}/children`,
          body: {
            children: table.rows.slice(current.children.length).map((row) => ({
              object: "block",
              type: "table_row",
              table_row: { cells: requestCells(row) },
            })),
          },
        },
        { method: "PATCH", path: `v1/blocks/${pageId}/children`, body: { children: suffix } },
      ],
    }
  } catch {
    return
  }
}

export function bodyCompletionStageMatches(
  derived: BodyCompletionDerivation,
  stage: number,
  snapshot: BodyCompletionSnapshot,
) {
  const tree = bodyCompletionTree(snapshot, derived.page_id),
    expected = derived.models[stage]
  const marker = derived.markdown[0]?.split("\n", 1)[0],
    markerModel = marker && compileSourceRootBody(marker)
  return Boolean(
    tree &&
      expected &&
      markerModel &&
      sourceRootBodyMatches(markerModel, tree.slice(0, 1)) &&
      sourceRootBodyMatches(expected, tree.slice(1)),
  )
}

/** Full old-node identity is retained; only the exact row payload and genuine
 * edit timestamps of that row/table/owner can change. Appends consume all new
 * IDs, parent links and nodes. No same-content ID swap is accepted. */
export function bodyCompletionTransition(
  derived: BodyCompletionDerivation,
  step: number,
  before: BodyCompletionSnapshot,
  after: BodyCompletionSnapshot,
) {
  try {
    if (
      ![0, 1, 2].includes(step) ||
      !bodyCompletionStageMatches(derived, step, before) ||
      !bodyCompletionStageMatches(derived, step + 1, after) ||
      !advancingTime(before.page_after.last_edited_time, after.page_before.last_edited_time) ||
      !isDeepStrictEqual(
        without(before.page_after, ["request_id", "last_edited_time"]),
        without(after.page_before, ["request_id", "last_edited_time"]),
      )
    )
      return false
    const oldRoots = bodyCompletionTree(before, derived.page_id),
      newRoots = bodyCompletionTree(after, derived.page_id)
    if (!oldRoots || !newRoots) return false
    const oldNodes = oldRoots.flatMap((root) => [root, ...root.children]),
      newNodes = newRoots.flatMap((root) => [root, ...root.children])
    const later = new Map(newNodes.map((node) => [node.raw.id, node]))
    if (oldRoots.some((root, index) => root.raw.id !== newRoots[index]?.raw.id)) return false
    const oldTable = oldRoots[derived.table_root + 1],
      newTable = newRoots[derived.table_root + 1]
    if (
      !oldTable ||
      !newTable ||
      oldTable.children.some((node, index) => node.raw.id !== newTable.children[index]?.raw.id)
    )
      return false
    for (const node of oldNodes) {
      const current = later.get(node.raw.id)
      if (!current) return false
      const affectedRow = step === 0 && node.raw.id === derived.row_id
      const affectedTable = step < 2 && node.raw.id === derived.table_id
      if (
        (affectedRow || affectedTable) &&
        !advancingTime(node.raw.last_edited_time, current.raw.last_edited_time)
      )
        return false
      const omitted = affectedRow
        ? ["last_edited_time", "table_row"]
        : affectedTable
          ? ["last_edited_time"]
          : []
      if (!isDeepStrictEqual(without(node.raw, omitted), without(current.raw, omitted)))
        return false
    }
    const added = newNodes.filter((node) => !oldNodes.some((old) => old.raw.id === node.raw.id))
    const request = derived.requests[step],
      children = request?.body.children
    return step === 0
      ? added.length === 0 && newNodes.length === oldNodes.length
      : Array.isArray(children) &&
          added.length === children.length &&
          newNodes.length === oldNodes.length + children.length &&
          (step === 1
            ? newRoots.length === oldRoots.length
            : newTable.children.length === oldTable.children.length)
  } catch {
    return false
  }
}

/** Real ACK identity is useful evidence, never a fabricated substitute for a
 * response. Unknown sends may instead acquire a separately labelled observed
 * applied disposition after the complete transition and stable dual read. */
export function bodyCompletionAckMatches(
  derived: BodyCompletionDerivation,
  step: number,
  response: unknown,
  before: BodyCompletionSnapshot,
  after: BodyCompletionSnapshot,
) {
  if (!record(response) || !bodyCompletionTransition(derived, step, before, after)) return false
  if (step === 0)
    return (
      response.object === "block" && response.id === derived.row_id && response.type === "table_row"
    )
  if (
    response.object !== "list" ||
    response.has_more !== false ||
    response.next_cursor !== null ||
    !Array.isArray(response.results)
  )
    return false
  const old = bodyCompletionTree(before, derived.page_id),
    current = bodyCompletionTree(after, derived.page_id)
  if (!old || !current) return false
  const added =
    step === 1
      ? current[derived.table_root + 1]!.children.slice(derived.before_rows)
      : current.slice(derived.before_roots + 1)
  return (
    response.results.length === added.length &&
    response.results.every(
      (value, index) =>
        record(value) &&
        value.object === "block" &&
        value.id === added[index]!.raw.id &&
        value.type === added[index]!.raw.type &&
        isDeepStrictEqual(value.parent, added[index]!.raw.parent),
    )
  )
}
