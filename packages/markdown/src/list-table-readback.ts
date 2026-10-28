import { Lexer, type Token } from "marked"
import type {
  MarkdownLinkDestinationMatch,
  NotionBlockBoundary,
  NotionQuoteNode,
  NotionTextSpan,
} from "./index.ts"

type Structure = (markdown: string) => readonly unknown[]
type Same = (
  actual: readonly unknown[],
  expected: readonly unknown[],
  destinations?: MarkdownLinkDestinationMatch,
) => boolean
interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}
interface Line {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly code: boolean
}
interface Table {
  readonly rows: readonly NotionQuoteNode[]
}

function retained(spans: readonly NotionTextSpan[] | undefined) {
  if (!Array.isArray(spans)) return
  const result: unknown[] = []
  for (const span of spans) {
    if (
      !span ||
      typeof span.text !== "string" ||
      typeof span.bold !== "boolean" ||
      typeof span.code !== "boolean" ||
      (span.link !== null && typeof span.link !== "string") ||
      (span.code && /[\r\n]/.test(span.text))
    )
      return
    const value = span.code ? ["code", span.text] : span.text.replace(/\s+/g, " ")
    const part = span.link === null ? value : ["link", span.link, null, [value]]
    if (typeof part === "string" && typeof result.at(-1) === "string")
      result[result.length - 1] = `${result.at(-1)}${part}`.replace(/\s+/g, " ")
    else if (part !== "") result.push(part)
  }
  return result
}

function inline(text: string, structure: Structure) {
  if (/[\r\n]/.test(text)) return
  const parsed = structure(`prefix ${text}`),
    paragraph = parsed[0]
  if (
    parsed.length !== 1 ||
    !Array.isArray(paragraph) ||
    paragraph[0] !== "paragraph" ||
    !Array.isArray(paragraph[1]) ||
    typeof paragraph[1][0] !== "string" ||
    !paragraph[1][0].startsWith("prefix ")
  )
    return
  const result: unknown[] = [paragraph[1][0].slice(7), ...paragraph[1].slice(1)]
  if (result[0] === "") result.shift()
  return result
}

function sameInline(text: string, node: NotionBlockBoundary, structure: Structure, same: Same) {
  const actual = inline(text, structure),
    physical = retained(node.rich_text)
  return !!actual && !!physical?.length && same(actual, physical)
}

function table(root: NotionBlockBoundary): readonly Table[] | undefined {
  const nodes = root.list_table_descendants
  if (
    !root.has_children ||
    root.descendants !== undefined ||
    root.quote_descendants !== undefined ||
    !nodes ||
    nodes.length < 2
  )
    return
  const result: Table[] = []
  let cursor = 0
  while (cursor < nodes.length) {
    if (result.length === 2) return
    const first = nodes[cursor++]!,
      shape = first.table
    if (
      first.type !== "table" ||
      first.parent_id !== root.id ||
      !first.has_children ||
      !shape ||
      !Number.isSafeInteger(shape.width) ||
      shape.width < 1 ||
      !shape.header_row ||
      shape.header_column ||
      first.table_row !== undefined
    )
      return
    const rows: NotionQuoteNode[] = []
    while (cursor < nodes.length && nodes[cursor]!.type === "table_row") {
      const row = nodes[cursor++]!
      if (
        row.parent_id !== first.id ||
        row.has_children ||
        row.table !== undefined ||
        row.table_row?.cells.length !== shape.width ||
        row.table_row.cells.some((cell) => retained(cell) === undefined)
      )
        return
      rows.push(row)
    }
    if (!rows.length) return
    result.push({ rows })
  }
  return result
}

function linesOf(markdown: string): Line[] {
  let offset = 0,
    fence: { marker: string; length: number } | undefined
  return markdown.split("\n").map((text) => {
    const start = offset
    offset += text.length + 1
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text),
      code = !!fence || !!marker
    if (
      fence &&
      marker &&
      marker[1]![0] === fence.marker &&
      marker[1]!.length >= fence.length &&
      !marker[2]!.trim()
    )
      fence = undefined
    else if (!fence && marker) fence = { marker: marker[1]![0]!, length: marker[1]!.length }
    return { start, end: Math.min(offset, markdown.length), text, code }
  })
}

function anchor(
  node: NotionBlockBoundary,
  line: Line | undefined,
  structure: Structure,
  same: Same,
) {
  if (!line || line.code || node.has_children) return false
  if (node.type === "paragraph")
    return (
      /^\S/.test(line.text) &&
      !/^(?:>|#|[-+*] |\d+[.)] )/.test(line.text) &&
      sameInline(line.text, node, structure, same)
    )
  const heading = /^heading_([123])$/.exec(node.type),
    text = /^(#{1,3}) (.*)$/.exec(line.text)
  return (
    !!heading &&
    !!text &&
    text[1]!.length === Number(heading[1]) &&
    sameInline(text[2]!, node, structure, same)
  )
}

function sourceAnchor(
  node: NotionBlockBoundary,
  token: Token | undefined,
  structure: Structure,
  same: Same,
) {
  if (
    !token ||
    node.has_children ||
    !(
      (token.type === "paragraph" && node.type === "paragraph") ||
      (token.type === "heading" && node.type === `heading_${token.depth}`)
    ) ||
    !("text" in token) ||
    typeof token.text !== "string"
  )
    return false
  return sameInline(token.text, node, structure, same)
}
interface ListNode {
  readonly id: string
  readonly type: string
  readonly has_children: boolean
  readonly children: ListNode[]
  readonly rich_text?: readonly NotionTextSpan[]
  readonly numbered_list?: { readonly start: number | null }
}
function listTree(root: NotionBlockBoundary): ListNode | undefined {
  if (root.quote_descendants !== undefined || root.list_table_descendants !== undefined) return
  const node: ListNode = {
    id: root.id,
    type: root.type,
    has_children: root.has_children,
    rich_text: root.rich_text,
    numbered_list: root.numbered_list,
    children: [],
  }
  if (root.descendants === undefined) return node
  if (!root.has_children || !root.descendants.length) return
  const ids = new Set([root.id]),
    stack = [node],
    nodes = [node]
  for (const child of root.descendants) {
    if (
      !child.id ||
      ids.has(child.id) ||
      !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(child.type) ||
      ["quote_descendants", "list_table_descendants", "descendants"].some((key) => key in child)
    )
      return
    ids.add(child.id)
    while (stack.length && stack.at(-1)!.id !== child.parent_id) stack.pop()
    const parent = stack.at(-1)
    if (
      !parent?.has_children ||
      stack.length > 32 ||
      (child.type === "paragraph" && child.has_children)
    )
      return
    const built: ListNode = {
      id: child.id,
      type: child.type,
      has_children: child.has_children,
      rich_text: child.rich_text,
      numbered_list: child.numbered_list,
      children: [],
    }
    parent.children.push(built)
    nodes.push(built)
    stack.push(built)
  }
  return nodes.every((item) => item.has_children === item.children.length > 0) ? node : undefined
}

function itemBody(node: ListNode): unknown[] | undefined {
  const text = retained(node.rich_text)
  if (!text?.length || node.type === "paragraph") return
  const body: unknown[] = [["paragraph", text]]
  let cursor = 0
  while (cursor < node.children.length) {
    const child = node.children[cursor]!
    if (child.type === "paragraph") {
      const paragraph = retained(child.rich_text)
      if (!paragraph?.length || child.children.length) return
      body.push(["paragraph", paragraph])
      cursor++
      continue
    }
    const childOrdered = child.type === "numbered_list_item"
    const childStart = childOrdered ? (child.numbered_list?.start ?? 1) : ""
    if (
      childOrdered &&
      (typeof childStart !== "number" || !Number.isSafeInteger(childStart) || childStart < 1)
    )
      return
    const items: unknown[] = []
    while (cursor < node.children.length && node.children[cursor]!.type === child.type) {
      const item = node.children[cursor]!,
        itemStart = childOrdered ? (item.numbered_list?.start ?? null) : null
      if (childOrdered && (items.length === 0 ? itemStart !== childStart : itemStart !== null))
        return
      const nested = itemBody(item)
      if (!nested) return
      items.push([false, null, nested])
      cursor++
    }
    body.push(["list", childOrdered, childStart, items])
  }
  return body
}

function listStructure(
  node: ListNode,
  ordered: boolean,
  start: number | "",
): unknown[] | undefined {
  const body = itemBody(node)
  return body && ["list", ordered, start, [[false, null, body]]]
}

/** One direct table whose opening tag kept only a tab. Its rows and closing
 * tag stay exactly as read back. Reindenting every captured line is safe only
 * when that whole table, its list run and both anchors already match. */
export function nestedTableReadbackEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
): Edit[] {
  if (markdown.includes("\r") || target.includes("\r")) return []
  const source = Lexer.lex(target).filter((token) => token.type !== "space" && token.type !== "def")
  const lines = linesOf(markdown),
    result: Edit[] = []
  for (let first = 1; first + 1 < roots.length; first++) {
    const type = roots[first]!.type
    if (
      !["numbered_list_item", "bulleted_list_item"].includes(type) ||
      roots[first - 1]!.type === type
    )
      continue
    let end = first
    while (roots[end]?.type === type) end++
    const group = roots.slice(first, end),
      before = roots[first - 1]!,
      after = roots[end]
    first = end - 1
    const terminal = !after && end === roots.length
    if (!terminal || group.filter((root) => root.list_table_descendants !== undefined).length !== 1)
      continue
    const tables = group.map((root) => (root.has_children ? table(root) : undefined))
    const ordered = type === "numbered_list_item",
      start = ordered ? (group[0]!.numbered_list?.start ?? 1) : ""
    if (
      ordered &&
      (typeof start !== "number" ||
        !Number.isSafeInteger(start) ||
        start < 1 ||
        start > 999999999 ||
        group.some(
          (root, index) => !root.numbered_list || (index > 0 && root.numbered_list.start !== null),
        ))
    )
      continue
    if (
      group.some(
        (root, index) =>
          !retained(root.rich_text)?.length ||
          (tables[index]
            ? root.descendants !== undefined || root.quote_descendants !== undefined
            : root.list_table_descendants !== undefined || root.quote_descendants !== undefined),
      )
    )
      continue
    const trees = group.map((root) => (tables[group.indexOf(root)] ? undefined : listTree(root)))
    if (trees.some((tree, index) => !tables[index] && !tree)) continue
    if (tables.filter((value) => value?.length === 1).length !== 1) continue
    const items = group.map((root, index) => {
      if (tables[index])
        return [
          false,
          null,
          [
            ["paragraph", retained(root.rich_text)!],
            ...tables[index]!.map((value) => [
              "table",
              value.rows.map((row) => row.table_row!.cells.map((cell) => retained(cell)!)),
            ]),
          ],
        ]
      const nested = listStructure(trees[index]!, ordered, index ? "" : start)
      return nested && (nested[3] as unknown[])[0]
    })
    if (items.some((item) => !item)) continue
    const expected = [["list", ordered, start, items]]
    const sources = source.flatMap((token, index) =>
      token.type === "list" &&
      sourceAnchor(before, source[index - 1], structure, same) &&
      (terminal
        ? index + 1 === source.length
        : sourceAnchor(after!, source[index + 1], structure, same)) &&
      same(structure(token.raw), expected)
        ? [index]
        : [],
    )
    if (sources.length !== 1) continue
    const candidates: Edit[] = []
    for (let index = 0; index < lines.length; index++) {
      if (!anchor(before, lines[index], structure, same)) continue
      let cursor = index + 1,
        valid = true,
        edit: Edit | undefined
      const consume = (nodes: readonly ListNode[], indent: number): boolean => {
        for (const node of nodes) {
          while (lines[cursor]?.text === "") cursor++
          const line = lines[cursor]
          if (!line || line.code) return false
          if (node.type === "paragraph") {
            const prefix = /^( *)(\S.*)$/.exec(line.text)
            if (
              !prefix ||
              prefix[1]!.length !== indent ||
              node.children.length ||
              !sameInline(prefix[2]!, node as NotionBlockBoundary, structure, same)
            )
              return false
            cursor++
            continue
          }
          const marker = /^( *)([-+*]|\d+[.)])( +)(.*)$/.exec(line.text)
          const childOrdered = node.type === "numbered_list_item"
          if (
            !marker ||
            marker[1]!.length !== indent ||
            /^\d/.test(marker[2]!) !== childOrdered ||
            !sameInline(marker[4]!, node as NotionBlockBoundary, structure, same)
          )
            return false
          cursor++
          if (
            node.children.length > 0 !== node.has_children ||
            (node.children.length &&
              !consume(node.children, indent + marker[2]!.length + marker[3]!.length))
          )
            return false
        }
        return true
      }
      for (const [itemIndex, root] of group.entries()) {
        while (lines[cursor]?.text === "") cursor++
        const line = lines[cursor],
          marker = line && /^([-+*]|\d+[.)])( +)(.*)$/.exec(line.text)
        if (
          !line ||
          line.code ||
          !marker ||
          /^\d/.test(marker[1]!) !== ordered ||
          (ordered && Number(marker[1]!.slice(0, -1)) !== Number(start) + itemIndex) ||
          !sameInline(marker[3]!, root, structure, same)
        ) {
          valid = false
          break
        }
        cursor++
        const indent = " ".repeat(marker[1]!.length + marker[2]!.length)
        const physical = tables[itemIndex]
        if (!physical) {
          if (
            trees[itemIndex]!.children.length &&
            !consume(trees[itemIndex]!.children, indent.length)
          )
            valid = false
          continue
        }
        const opening = lines[cursor]
        if (
          !opening ||
          opening.code ||
          !['\t<table header-row="true">', `${indent}<table header-row="true">`].includes(
            opening.text,
          )
        ) {
          valid = false
          break
        }
        const rendered = [`${indent}<table header-row="true">`]
        cursor++
        if (lines[cursor]?.text === "") cursor++
        const [value] = physical
        for (const row of value!.rows) {
          if (lines[cursor]?.code || lines[cursor]?.text !== "<tr>") {
            valid = false
            break
          }
          rendered.push(`${indent}<tr>`)
          cursor++
          for (const cell of row.table_row!.cells) {
            const cellLine = lines[cursor],
              match = cellLine && /^<td>(.*)<\/td>$/.exec(cellLine.text)
            const actual = match && inline(match[1]!, structure),
              retainedCell = retained(cell)
            if (
              !cellLine ||
              cellLine.code ||
              !actual ||
              retainedCell === undefined ||
              !same(actual, retainedCell)
            ) {
              valid = false
              break
            }
            rendered.push(`${indent}${cellLine.text}`)
            cursor++
          }
          if (!valid || lines[cursor]?.code || lines[cursor]?.text !== "</tr>") {
            valid = false
            break
          }
          rendered.push(`${indent}</tr>`)
          cursor++
        }
        const closing = lines[cursor]
        if (!valid || !closing || closing.code || closing.text !== "\t</table>") {
          valid = false
          break
        }
        rendered.push(`${indent}</table>`)
        cursor++
        edit = {
          start: opening.start,
          end: closing.end,
          text:
            rendered.join("\n") + (closing.end > closing.start + closing.text.length ? "\n" : ""),
        }
      }
      while (lines[cursor]?.text === "") cursor++
      const ended = terminal
        ? cursor === lines.length
        : anchor(after!, lines[cursor], structure, same)
      if (valid && edit && ended) candidates.push(edit)
    }
    if (candidates.length === 1) result.push(candidates[0]!)
  }
  return result
}

/** Decode only Notion's split indentation for one or two complete list-owned tables.
 * The original source, all list roots, every table cell and both root anchors
 * must agree before any container whitespace changes. No cell bytes are copied
 * from the source, and a same-content sibling table supplies no ownership. */
export function listTableReadbackEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
): Edit[] {
  if (markdown.includes("\r") || target.includes("\r")) return []
  const source = Lexer.lex(target).filter((token) => token.type !== "space" && token.type !== "def")
  const lines = linesOf(markdown),
    result: Edit[] = []
  for (let first = 1; first + 1 < roots.length; first++) {
    const type = roots[first]!.type
    if (
      !["numbered_list_item", "bulleted_list_item"].includes(type) ||
      roots[first - 1]!.type === type
    )
      continue
    let end = first
    while (roots[end]?.type === type) end++
    const group = roots.slice(first, end),
      before = roots[first - 1]!,
      after = roots[end]
    first = end - 1
    if (!after || group.filter((root) => root.list_table_descendants !== undefined).length !== 1)
      continue
    const tables = group.map((root) => (root.has_children ? table(root) : undefined))
    const ordered = type === "numbered_list_item",
      start = ordered ? (group[0]!.numbered_list?.start ?? 1) : ""
    if (
      ordered &&
      (typeof start !== "number" ||
        !Number.isSafeInteger(start) ||
        start < 1 ||
        start > 999999999 ||
        group.some(
          (root, index) => !root.numbered_list || (index > 0 && root.numbered_list.start !== null),
        ))
    )
      continue
    if (
      group.some(
        (root, index) =>
          !retained(root.rich_text)?.length ||
          (root.has_children
            ? !tables[index]
            : root.list_table_descendants !== undefined ||
              root.descendants !== undefined ||
              root.quote_descendants !== undefined),
      )
    )
      continue
    const tableCount = tables.reduce((count, values) => count + (values?.length ?? 0), 0)
    const items = group.map((root, index) => [
      false,
      null,
      [
        ["paragraph", retained(root.rich_text)!],
        ...(tables[index] ?? []).map((value) => [
          "table",
          value.rows.map((row) => row.table_row!.cells.map((cell) => retained(cell)!)),
        ]),
      ],
    ])
    const expected = [["list", ordered, start, items]]
    const sources = source.flatMap((token, index) =>
      token.type === "list" &&
      sourceAnchor(before, source[index - 1], structure, same) &&
      sourceAnchor(after, source[index + 1], structure, same) &&
      same(structure(token.raw), expected)
        ? [index]
        : [],
    )
    if (sources.length !== 1) continue
    const candidates: Edit[][] = []
    for (let index = 0; index < lines.length; index++) {
      if (!anchor(before, lines[index], structure, same)) continue
      let cursor = index + 1,
        valid = true
      const edits: Edit[] = []
      for (const [itemIndex, root] of group.entries()) {
        while (lines[cursor]?.text === "") cursor++
        const line = lines[cursor],
          marker = line && /^([-+*]|\d+[.)])( +)(.*)$/.exec(line.text)
        if (
          !line ||
          line.code ||
          !marker ||
          /^\d/.test(marker[1]!) !== ordered ||
          (ordered && Number(marker[1]!.slice(0, -1)) !== Number(start) + itemIndex) ||
          !sameInline(marker[3]!, root, structure, same)
        ) {
          valid = false
          break
        }
        cursor++
        const physical = tables[itemIndex]
        if (!physical) continue
        const indent = " ".repeat(marker[1]!.length + marker[2]!.length)
        for (const [tableIndex, value] of physical.entries()) {
          const opening = lines[cursor]
          const expectedOpening =
            tableIndex === 0 ? `${indent}<table header-row="true">` : '\t<table header-row="true">'
          // The second direct table follows the complete first closing line.
          // No intervening line is skipped and its retained tab is exact.
          if (!opening || opening.code || opening.text !== expectedOpening) {
            valid = false
            break
          }
          const rendered = [`${indent}<table header-row="true">`]
          cursor++
          // Preserve the existing first-table serializer exception only.
          if (tableIndex === 0 && lines[cursor]?.text === "") cursor++
          for (const row of value.rows) {
            if (lines[cursor]?.code || lines[cursor]?.text !== "<tr>") {
              valid = false
              break
            }
            rendered.push(`${indent}<tr>`)
            cursor++
            for (const cell of row.table_row!.cells) {
              const line = lines[cursor],
                match = line && /^<td>(.*)<\/td>$/.exec(line.text)
              const actual = match && inline(match[1]!, structure),
                retainedCell = retained(cell)
              if (!line || line.code || !actual || !retainedCell || !same(actual, retainedCell)) {
                valid = false
                break
              }
              rendered.push(`${indent}${line.text}`)
              cursor++
            }
            if (!valid || lines[cursor]?.code || lines[cursor]?.text !== "</tr>") {
              valid = false
              break
            }
            rendered.push(`${indent}</tr>`)
            cursor++
          }
          const closing = lines[cursor]
          if (!valid || !closing || closing.code || closing.text !== "\t</table>") {
            valid = false
            break
          }
          rendered.push(`${indent}</table>`)
          cursor++
          // Source and physical evidence both require two distinct tables.
          // One blank line keeps their HTML readback tokens distinct.
          edits.push({
            start: opening.start,
            end: closing.end,
            text:
              (tableIndex === 0 ? "" : "\n") +
              rendered.join("\n") +
              (closing.end > closing.start + closing.text.length ? "\n" : ""),
          })
        }
        if (!valid) break
      }
      while (lines[cursor]?.text === "") cursor++
      if (valid && edits.length === tableCount && anchor(after, lines[cursor], structure, same))
        candidates.push(edits)
    }
    if (candidates.length === 1) result.push(...candidates[0]!)
  }
  return result
}
