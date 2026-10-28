import { Lexer, type Token, type Tokens } from "marked"
import { listTableReadbackEdits, nestedTableReadbackEdits } from "./list-table-readback.ts"
import { boldCodeLinkReadbackEdits, sameLiteralInlineSpans } from "./bold-code-link-readback.ts"
import { boldCodeLinkListReadbackEdits } from "./bold-code-link-list-readback.ts"
import type {
  MarkdownLinkDestinationMatch,
  NotionBlockBoundary,
  NotionBlockNode,
  NotionQuoteNode,
  NotionTextSpan,
} from "./index.ts"

type Structure = (markdown: string) => readonly unknown[]
type Same = (
  actual: readonly unknown[],
  expected: readonly unknown[],
  destinations?: MarkdownLinkDestinationMatch,
) => boolean
type Language = (value: string | undefined) => string
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
type Proves = (root: number, ranges: readonly Range[]) => boolean

function positioned(markdown: string): Part[] | undefined {
  const result: Part[] = []
  let cursor = 0
  for (const token of Lexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, cursor),
      end = start + token.raw.length
    if (start < cursor || markdown.slice(cursor, start).trim()) return
    if (token.type !== "space" && token.type !== "def") result.push({ token, start, end })
    cursor = end
  }
  return markdown.slice(cursor).trim() ? undefined : result
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

function inline(line: string, structure: Structure) {
  if (/[\r\n]/.test(line)) return
  const ast = structure(`prefix ${line}`),
    paragraph = ast[0]
  if (
    ast.length !== 1 ||
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

// Only the physical API/readback serializer comparison uses this equivalence.
// Source destinations are compared separately by the unchanged source policy.
function readbackDestination(actual: string, physical: string) {
  if (actual === physical) return true
  const root = /^(https?:\/\/[^/:?#@\\\s]+)\/?$/
  const left = root.exec(actual),
    right = root.exec(physical)
  return !!left && !!right && left[1] === right[1]
}

function sameInline(
  line: string,
  node: NotionBlockNode,
  structure: Structure,
  same: Same,
  readback = false,
) {
  const actual = inline(line, structure),
    expected = retained(node.rich_text)
  return (
    !!actual && !!expected && same(actual, expected, readback ? readbackDestination : undefined)
  )
}

function uniqueIds(roots: readonly NotionBlockBoundary[]) {
  const ids = new Set<string>()
  let count = 0
  for (const root of roots) {
    if (root.table_evidence?.rows !== undefined && !Array.isArray(root.table_evidence.rows))
      return false
    for (const node of [
      root,
      ...(root.descendants ?? []),
      ...(root.quote_descendants ?? []),
      ...(root.list_table_descendants ?? []),
      ...(root.table_evidence?.rows ?? []),
    ]) {
      if (
        !node ||
        typeof node.id !== "string" ||
        !node.id ||
        ids.has(node.id) ||
        typeof node.has_children !== "boolean" ||
        ++count > 4096
      )
        return false
      ids.add(node.id)
    }
  }
  return true
}

function plain(token: Token) {
  return token.type === "paragraph" &&
    !/[\r\n]/.test(token.text) &&
    token.tokens?.every((part: Token) => part.type === "text" && part.raw === part.text)
    ? token.text
    : undefined
}

function sourceSpaceEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
  proves: Proves,
): Edit[] {
  const actual = positioned(markdown),
    source = positioned(target)
  if (!actual || !source) return []
  const result: Edit[] = []
  for (let at = 1; at + 1 < source.length; at++) {
    const text = plain(source[at]!.token),
      before = source[at - 1]!.token,
      after = source[at + 1]!.token
    if (
      text === undefined ||
      !/\S $/.test(text) ||
      before.type !== "heading" ||
      after.type !== "heading"
    )
      continue
    const original = text.slice(0, -1)
    if (source.filter((part) => plain(part.token) === text).length !== 1) continue
    const indexes = roots.flatMap((node, index) => {
      const left = roots[index - 1],
        right = roots[index + 1]
      return node.type === "paragraph" &&
        !node.has_children &&
        node.text === original &&
        node.rich_text?.every((span) => !span.bold && !span.code && span.link === null) &&
        left?.type === `heading_${before.depth}` &&
        !left.has_children &&
        right?.type === `heading_${after.depth}` &&
        !right.has_children &&
        sameInline(before.text, left, structure, same) &&
        sameInline(after.text, right, structure, same)
        ? [index]
        : []
    })
    const found = actual.filter((part) => plain(part.token) === original)
    if (indexes.length !== 1 || found.length !== 1) continue
    const part = found[0]!,
      range = { start: part.start, end: part.start + original.length }
    if (proves(indexes[0]!, [range])) result.push({ ...range, text })
  }
  return result
}

interface NestedBulletItem extends Range {
  readonly head: string
  readonly textEnd: number
  readonly children: readonly Tokens.ListItem[]
}

function nestedBulletItems(markdown: string): NestedBulletItem[] {
  const parts = positioned(markdown),
    result: NestedBulletItem[] = []
  if (!parts) return result
  for (const part of parts) {
    if (part.token.type !== "list" || part.token.ordered) continue
    let cursor = part.start
    for (const item of part.token.items) {
      const start = markdown.indexOf(item.raw, cursor),
        end = start + item.raw.length
      if (start !== cursor || end > part.end) break
      cursor = end
      const head = item.tokens[0],
        nested = item.tokens[1]
      const marker = /^( {0,3})[-+*] +/.exec(item.raw)
      if (
        item.task ||
        item.tokens.length !== 2 ||
        !head ||
        !["text", "paragraph"].includes(head.type) ||
        !("text" in head) ||
        typeof head.text !== "string" ||
        /[\r\n\t]/.test(head.text) ||
        !marker ||
        !item.raw.startsWith(marker[0] + head.text + "\n") ||
        nested?.type !== "list" ||
        nested.ordered ||
        nested.loose ||
        !nested.items.length ||
        !nested.items.every(
          (child: Tokens.ListItem) =>
            !child.task &&
            !child.loose &&
            child.tokens.length === 1 &&
            ["text", "paragraph"].includes(child.tokens[0]!.type) &&
            typeof child.text === "string" &&
            !/[\r\n\t]/.test(child.text),
        )
      )
        continue
      result.push({
        start,
        end,
        head: head.text,
        textEnd: start + marker[0].length + head.text.length,
        children: nested.items,
      })
    }
  }
  return result
}

// This source form has one parent line ending in exactly two ASCII spaces and
// complete direct bullet children. Preserve those authored bytes only after
// proving every plain/code span in both bodies against the physical subtree.
function sourceNestedListSpaceEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  proves: Proves,
): Edit[] {
  const actual = nestedBulletItems(markdown),
    source = nestedBulletItems(target),
    result: Edit[] = []
  const spans = (values: readonly NotionTextSpan[] | undefined) => {
    if (!values?.length) return
    const output: Array<{ text: string; code: boolean }> = []
    for (const value of values) {
      if (
        !value ||
        typeof value.text !== "string" ||
        !value.text ||
        /[\r\n\t]/.test(value.text) ||
        value.bold !== false ||
        typeof value.code !== "boolean" ||
        value.link !== null
      )
        return
      const previous = output.at(-1)
      if (previous?.code === value.code) previous.text += value.text
      else output.push({ text: value.text, code: value.code })
    }
    return JSON.stringify(output)
  }
  const text = (value: string) => {
    const values: NotionTextSpan[] = []
    for (const token of Lexer.lexInline(value)) {
      if (
        (token.type !== "text" && token.type !== "codespan") ||
        typeof token.text !== "string" ||
        (token.type === "text" && token.raw !== token.text)
      )
        return
      values.push({ text: token.text, code: token.type === "codespan", bold: false, link: null })
    }
    return spans(values)
  }
  for (const wanted of source) {
    if (
      !/\S {2}$/.test(wanted.head) ||
      source.filter((item) => item.head === wanted.head).length !== 1
    )
      continue
    const head = wanted.head.slice(0, -2),
      expected = text(head)
    if (expected === undefined) continue
    const candidates = actual.filter(
      (item) => item.head === head && item.children.length === wanted.children.length,
    )
    if (candidates.length !== 1) continue
    const observed = candidates[0]!
    const indexes = roots.flatMap((root, index) => {
      if (
        root.type !== "bulleted_list_item" ||
        !root.has_children ||
        !root.descendants ||
        root.descendants.length !== wanted.children.length ||
        root.quote_descendants !== undefined ||
        root.list_table_descendants !== undefined ||
        root.table_evidence !== undefined ||
        root.numbered_list !== undefined ||
        root.to_do !== undefined ||
        root.code !== undefined ||
        spans(root.rich_text) !== expected ||
        text(observed.head) !== expected
      )
        return []
      return root.descendants.every((child, at) => {
        const physical = spans(child.rich_text)
        return (
          child.parent_id === root.id &&
          child.type === "bulleted_list_item" &&
          !child.has_children &&
          child.numbered_list === undefined &&
          child.to_do === undefined &&
          child.code === undefined &&
          physical !== undefined &&
          physical === text(wanted.children[at]!.text) &&
          physical === text(observed.children[at]!.text)
        )
      })
        ? [index]
        : []
    })
    if (indexes.length === 1 && proves(indexes[0]!, [observed]))
      result.push({ start: observed.textEnd, end: observed.textEnd, text: "  " })
  }
  return result
}

interface InlineLeaf extends Range {
  readonly type: string
  readonly checked?: boolean
  readonly text: string
  readonly textStart: number
}

function listItems(markdown: string) {
  const parts = positioned(markdown)
  if (!parts) return []
  const result: InlineLeaf[] = []
  for (const part of parts) {
    if (part.token.type !== "list") continue
    let cursor = part.start
    for (const item of part.token.items) {
      const start = markdown.indexOf(item.raw, cursor),
        end = start + item.raw.length
      if (start !== cursor || end > part.end) break
      const content = item.tokens.filter(
        (token: Token) => token.type !== "checkbox" && token.type !== "space",
      )
      const token = content[0]
      const prefix = /^( {0,3})([-+*]|\d+[.)])( +)(?:\[([ xX])\] +)?/.exec(item.raw)
      if (
        content.length === 1 &&
        token &&
        ["paragraph", "text"].includes(token.type) &&
        "text" in token &&
        typeof token.text === "string" &&
        !/[\r\n]/.test(token.text) &&
        prefix &&
        item.raw.slice(prefix[0].length).replace(/\n+$/, "") === token.text &&
        Boolean(prefix[4] !== undefined) === item.task
      )
        result.push({
          start,
          end,
          text: token.text,
          textStart: start + prefix[0].length,
          type: item.task
            ? "to_do"
            : part.token.ordered
              ? "numbered_list_item"
              : "bulleted_list_item",
          ...(item.task ? { checked: item.checked } : {}),
        })
      cursor = end
    }
  }
  return result
}

function backtickLeaves(markdown: string): InlineLeaf[] {
  const parts = positioned(markdown)
  if (!parts) return []
  return [
    ...listItems(markdown),
    ...parts.flatMap((part) => {
      const token = part.token
      if (
        token.type !== "paragraph" ||
        /[\r\n]/.test(token.text) ||
        !token.raw.startsWith(token.text) ||
        !/^\n*$/.test(token.raw.slice(token.text.length))
      )
        return []
      return [
        {
          start: part.start,
          end: part.start + token.text.length,
          text: token.text,
          textStart: part.start,
          type: "paragraph",
        },
      ]
    }),
  ]
}

function backtickEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
  proves: Proves,
): Edit[] {
  const actual = backtickLeaves(markdown),
    source = backtickLeaves(target),
    result: Edit[] = []
  for (const [rootIndex, node] of roots.entries()) {
    if (
      node.has_children ||
      !["paragraph", "numbered_list_item", "bulleted_list_item", "to_do"].includes(node.type) ||
      !node.rich_text?.length ||
      (node.type === "to_do" && typeof node.to_do?.checked !== "boolean")
    )
      continue
    const spans = node.rich_text.filter((span) => span.code && span.text.includes("`"))
    if (!spans.length || spans.some((span) => span.link !== null || /[\\\r\n]/.test(span.text)))
      continue
    const compatible = (item: InlineLeaf) =>
      item.type === node.type && (item.type !== "to_do" || item.checked === node.to_do?.checked)
    const sources = source.filter(
      (item) => compatible(item) && sameInline(item.text, node, structure, same),
    )
    if (sources.length !== 1) continue
    const candidates = actual.flatMap((item) => {
      if (!compatible(item)) return []
      const edits: Edit[] = []
      for (const value of new Set(spans.map((span) => span.text))) {
        const serialized = "`" + value.replaceAll("`", "\\`") + "`"
        const fence = "`".repeat(
          Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
        )
        const replacement = `${fence} ${value} ${fence}`
        const offsets: number[] = []
        let cursor = 0
        for (;;) {
          const found = item.text.indexOf(serialized, cursor)
          if (found < 0) break
          offsets.push(found)
          cursor = found + serialized.length
        }
        if (offsets.length !== spans.filter((span) => span.text === value).length) return []
        edits.push(
          ...offsets.map((start) => ({ start, end: start + serialized.length, text: replacement })),
        )
      }
      edits.sort((a, b) => a.start - b.start)
      if (edits.some((edit, index) => index > 0 && edits[index - 1]!.end > edit.start)) return []
      let corrected = item.text
      for (const edit of edits.reverse())
        corrected = corrected.slice(0, edit.start) + edit.text + corrected.slice(edit.end)
      if (!sameInline(corrected, node, structure, same, true) || !proves(rootIndex, [item]))
        return []
      return [{ start: item.textStart, end: item.textStart + item.text.length, text: corrected }]
    })
    if (candidates.length === 1) result.push(candidates[0]!)
  }
  return result
}

// Notion can emit each span of one italic paragraph as *span*, including
// *`code`*. At a span edge the adjacent delimiters become literal ** in the
// parsed body. Recognize only the complete finite serializer and source leaf;
// asterisks elsewhere, including inside code, are never removed.
function emphasisCodeEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
): Edit[] {
  const source = positioned(target),
    lines = linesOf(markdown)
  if (!source) return []
  const physicalTables = roots.filter((root) => root.type === "table")
  const actualTables: Array<{ readonly line: number; readonly start: number }> = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.code || !/^<table(?: header-row="true")?>$/.test(lines[index]!.text)) continue
    const start = index
    while (++index < lines.length && lines[index]!.text !== "</table>") {
      if (lines[index]!.code || !/^(?:|<tr>|<\/tr>|<td>[^\r\n]*<\/td>)$/.test(lines[index]!.text))
        return []
    }
    if (!lines[index]) return []
    const parsed = structure(markdown.slice(lines[start]!.start, lines[index]!.end))
    if (parsed.length !== 1 || !Array.isArray(parsed[0]) || parsed[0][0] !== "table") return []
    actualTables.push({ line: start, start: lines[start]!.start })
  }
  if (physicalTables.length !== actualTables.length) return []
  const result: Edit[] = []
  for (let index = 1; index + 1 < roots.length; index++) {
    const node = roots[index]!,
      before = roots[index - 1]!,
      after = roots[index + 1]!
    const spans = node.rich_text
    if (
      node.type !== "paragraph" ||
      node.has_children ||
      !spans?.length ||
      !/^heading_[1-6]$/.test(before.type) ||
      before.has_children ||
      after.type !== "table" ||
      !after.has_children ||
      spans.some(
        (span) =>
          !span.text ||
          span.bold ||
          span.link !== null ||
          /[\r\n`\\]/.test(span.text) ||
          (!span.code && /[*_]/.test(span.text)),
      ) ||
      !spans.some((span) => span.code) ||
      spans[0]!.code ||
      !spans.at(-1)!.code ||
      (node.text !== undefined && node.text !== spans.map((span) => span.text).join(""))
    )
      continue
    const serialized = spans
      .map((span) => `*${span.code ? "`" + span.text + "`" : span.text}*`)
      .join("")
    const candidates = source.flatMap((part, at) => {
      const token = part.token,
        heading = source[at - 1]?.token,
        table = source[at + 1]?.token
      const emphasis =
        token.type === "paragraph" && token.tokens?.length === 1 ? token.tokens[0] : undefined
      if (
        token.type !== "paragraph" ||
        /[\r\n]/.test(token.text) ||
        emphasis?.type !== "em" ||
        emphasis.raw !== token.text ||
        !emphasis.tokens?.every(
          (child) =>
            child.type === "codespan" || (child.type === "text" && child.raw === child.text),
        ) ||
        heading?.type !== "heading" ||
        before.type !== `heading_${heading.depth}` ||
        table?.type !== "table" ||
        !sameInline(heading.text, before, structure, same) ||
        !sameInline(token.text, node, structure, same)
      )
        return []
      return [{ source: token.text, heading }]
    })
    if (candidates.length !== 1) continue
    const expected = candidates[0]!,
      table = actualTables[physicalTables.indexOf(after)]!
    const found = lines.flatMap((line, at) => {
      if (line.code || line.text !== serialized) return []
      let previous = at - 1,
        next = at + 1
      while (lines[previous]?.text === "") previous--
      while (lines[next]?.text === "") next++
      const headingLine = lines[previous],
        heading = headingLine && /^(#{1,6}) (.+)$/.exec(headingLine.text)
      if (
        !headingLine ||
        headingLine.code ||
        !heading ||
        before.type !== `heading_${heading[1]!.length}` ||
        !sameInline(heading[2]!, before, structure, same, true) ||
        !same(structure(headingLine.text), structure(expected.heading.raw)) ||
        next !== table.line
      )
        return []
      return [{ start: line.start, end: line.start + line.text.length, text: expected.source }]
    })
    if (found.length === 1) result.push(found[0]!)
  }
  return result
}

interface QuoteChild extends NotionQuoteNode {
  readonly rows?: readonly NotionQuoteNode[]
}
function quoteChildren(root: NotionBlockBoundary): QuoteChild[] | undefined {
  if (!root.has_children) return root.quote_descendants === undefined ? [] : undefined
  const nodes = root.quote_descendants
  if (!nodes?.length || root.descendants !== undefined) return
  const children: QuoteChild[] = []
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (node.parent_id !== root.id) return
    if (node.type === "code") {
      if (
        node.has_children ||
        !node.code ||
        typeof node.code.text !== "string" ||
        typeof node.code.language !== "string" ||
        node.code.text.includes("\r") ||
        node.rich_text !== undefined ||
        node.text !== undefined ||
        node.numbered_list !== undefined ||
        node.to_do !== undefined ||
        node.table !== undefined ||
        node.table_row !== undefined
      )
        return
      children.push(node)
    } else if (node.type === "table") {
      const table = node.table
      if (
        !node.has_children ||
        !table ||
        !Number.isSafeInteger(table.width) ||
        table.width < 1 ||
        !table.header_row ||
        table.header_column ||
        node.table_row !== undefined
      )
        return
      const rows: NotionQuoteNode[] = []
      while (nodes[index + 1]?.parent_id === node.id) {
        const row = nodes[++index]!
        if (
          row.type !== "table_row" ||
          row.has_children ||
          row.table !== undefined ||
          row.table_row?.cells.length !== table.width ||
          row.table_row.cells.some((cell) => retained(cell) === undefined)
        )
          return
        rows.push(row)
      }
      if (!rows.length) return
      children.push({ ...node, rows })
    } else {
      if (
        node.has_children ||
        !["paragraph", "bulleted_list_item", "numbered_list_item"].includes(node.type) ||
        !retained(node.rich_text)?.length ||
        node.table !== undefined ||
        node.table_row !== undefined ||
        (node.type === "numbered_list_item" && node.numbered_list === undefined)
      )
        return
      children.push(node)
    }
  }
  return children
}

function quoteStructure(
  root: NotionBlockBoundary,
  children: readonly QuoteChild[],
  language: Language,
) {
  const first = retained(root.rich_text)
  if (!first?.length) return
  const content: unknown[] = [["paragraph", first]]
  const paragraph = (parts: readonly unknown[]) => {
    const previous = content.at(-1)
    if (!Array.isArray(previous) || previous[0] !== "paragraph" || !Array.isArray(previous[1])) {
      content.push(["paragraph", parts])
      return
    }
    // The public Markdown structure coalesces consecutive paragraphs. Preserve
    // physical child boundaries for readback consumption, then use that same AST shape.
    const merged: unknown[] = []
    for (const part of [...previous[1], " ", ...parts]) {
      if (typeof part === "string" && typeof merged.at(-1) === "string")
        merged[merged.length - 1] = `${merged.at(-1)}${part}`.replace(/\s+/g, " ")
      else merged.push(part)
    }
    previous[1] = merged
  }
  for (let index = 0; index < children.length; index++) {
    const node = children[index]!
    if (node.type === "code") {
      content.push(["code", language(node.code!.language), node.code!.text])
    } else if (node.type === "table") {
      content.push([
        "table",
        node.rows!.map((row) => row.table_row!.cells.map((cell) => retained(cell)!)),
      ])
    } else if (node.type === "paragraph") paragraph(retained(node.rich_text)!)
    else {
      const start = node.type === "numbered_list_item" ? (node.numbered_list!.start ?? 1) : ""
      const items: unknown[] = []
      do {
        const child = children[index]!
        if (
          items.length &&
          child.type === "numbered_list_item" &&
          child.numbered_list?.start !== null
        )
          return
        items.push([false, null, [["paragraph", retained(child.rich_text)!]]])
        index++
      } while (children[index]?.type === node.type)
      index--
      content.push(["list", node.type === "numbered_list_item", start, items])
    }
  }
  return ["blockquote", content]
}

interface Line extends Range {
  readonly text: string
  readonly code: boolean
  readonly opening: boolean
}
function linesOf(markdown: string): Line[] {
  let cursor = 0,
    fence: { marker: string; length: number } | undefined
  return markdown.split("\n").map((text) => {
    const start = cursor
    cursor += text.length + 1
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text)
    const code = !!fence || !!marker,
      opening = !fence && !!marker
    if (
      fence &&
      marker &&
      marker[1]![0] === fence.marker &&
      marker[1]!.length >= fence.length &&
      !marker[2]!.trim()
    )
      fence = undefined
    else if (!fence && marker) fence = { marker: marker[1]![0]!, length: marker[1]!.length }
    return { text, start, end: Math.min(cursor, markdown.length), code, opening }
  })
}

function anchor(
  node: NotionBlockBoundary,
  line: Line | undefined,
  structure: Structure,
  same: Same,
) {
  if (!line || line.code || node.has_children || !retained(node.rich_text)?.length) return false
  let body = line.text
  if (node.type === "paragraph") {
    if (!/^\S/.test(body) || /^(?:>|#|[-+*] |\d+[.)] )/.test(body)) return false
  } else {
    const heading = /^heading_([123])$/.exec(node.type)
    const marker = /^(#{1,3}) (.*)$/.exec(body)
    if (!heading || !marker || marker[1]!.length !== Number(heading[1])) return false
    body = marker[2]!
  }
  return sameInline(body, node, structure, same, true)
}

function tableAnchorStructure(root: NotionBlockBoundary) {
  const table = root.table_evidence
  if (
    root.type !== "table" ||
    !root.has_children ||
    !table ||
    Object.keys(table).some(
      (key) => !["width", "header_row", "header_column", "rows"].includes(key),
    ) ||
    !Number.isSafeInteger(table.width) ||
    table.width < 1 ||
    table.header_row !== true ||
    table.header_column !== false ||
    !Array.isArray(table.rows) ||
    !table.rows.length ||
    root.descendants !== undefined ||
    root.quote_descendants !== undefined ||
    root.list_table_descendants !== undefined
  )
    return
  const rows: unknown[] = []
  for (const row of table.rows) {
    if (
      Object.keys(row).some(
        (key) => !["id", "type", "has_children", "parent_id", "table_row"].includes(key),
      ) ||
      row.type !== "table_row" ||
      row.has_children ||
      row.parent_id !== root.id ||
      !row.table_row ||
      Object.keys(row.table_row).some((key) => key !== "cells") ||
      !Array.isArray(row.table_row.cells) ||
      row.table_row.cells.length !== table.width
    )
      return
    const cells: (readonly unknown[] | undefined)[] = row.table_row.cells.map(
      (cell: readonly NotionTextSpan[]) => retained(cell),
    )
    if (cells.some((cell) => cell === undefined)) return
    rows.push(cells)
  }
  return ["table", rows]
}

function anchorEnd(
  node: NotionBlockBoundary,
  lines: readonly Line[],
  index: number,
  structure: Structure,
  same: Same,
  language: Language,
) {
  if (node.type === "divider")
    return !node.has_children && !lines[index]?.code && lines[index]?.text === "---"
      ? index + 1
      : undefined
  if (node.type === "table") {
    if (
      !tableAnchorStructure(node) ||
      lines[index]?.code ||
      lines[index]?.text !== '<table header-row="true">'
    )
      return
    let cursor = index + 1
    if (lines[cursor]?.text === "") cursor++
    for (const row of node.table_evidence!.rows) {
      if (lines[cursor]?.code || lines[cursor]?.text !== "<tr>") return
      cursor++
      for (const cell of row.table_row!.cells) {
        const line = lines[cursor],
          match = line && /^<td>(.*)<\/td>$/.exec(line.text)
        const actual = match && inline(match[1]!, structure),
          physical = retained(cell)
        if (
          !line ||
          line.code ||
          !actual ||
          !physical ||
          !same(actual, physical, readbackDestination)
        )
          return
        cursor++
      }
      if (lines[cursor]?.code || lines[cursor]?.text !== "</tr>") return
      cursor++
    }
    return !lines[cursor]?.code && lines[cursor]?.text === "</table>" ? cursor + 1 : undefined
  }
  if (node.type !== "code")
    return anchor(node, lines[index], structure, same) ? index + 1 : undefined
  const line = lines[index],
    code = node.code
  const marker = line?.opening && /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line.text)
  if (node.has_children || !code || !marker || language(marker[2]) !== language(code.language))
    return
  let cursor = index + 1
  for (; cursor < lines.length; cursor++) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[cursor]!.text)
    if (!close || close[1]![0] !== marker[1]![0] || close[1]!.length < marker[1]!.length) continue
    return lines
      .slice(index + 1, cursor)
      .map((line) => line.text)
      .join("\n") === code.text
      ? cursor + 1
      : undefined
  }
}

function sourceAnchor(
  node: NotionBlockBoundary,
  token: Token | undefined,
  structure: Structure,
  same: Same,
  language: Language,
) {
  if (node.type === "divider")
    return !node.has_children && token?.type === "hr" && token.raw.trim() === "---"
  if (node.type === "table") {
    const table = tableAnchorStructure(node)
    return (
      !!table &&
      token?.type === "table" &&
      token.align.every((value: "left" | "center" | "right" | null) => value === null) &&
      same([table], structure(token.raw))
    )
  }
  if (token?.type === "code")
    return (
      node.type === "code" &&
      !node.has_children &&
      !!node.code &&
      token.text === node.code.text &&
      language(token.lang) === language(node.code.language)
    )
  return (
    !!token &&
    !node.has_children &&
    ((token.type === "paragraph" && node.type === "paragraph") ||
      (token.type === "heading" && node.type === `heading_${token.depth}`)) &&
    "text" in token &&
    typeof token.text === "string" &&
    sameInline(token.text.replace(/\n/g, " "), node, structure, same)
  )
}

interface QuoteListAnchor {
  readonly nodes: readonly NotionBlockBoundary[]
  readonly ordered: boolean
  readonly start: number
}

// A list anchor consumes the complete contiguous root run, never just the
// nearest item. Descendant lists and task lists have no authority in this path.
function quoteListAnchor(
  roots: readonly NotionBlockBoundary[],
  index: number,
  side: "before" | "after",
): QuoteListAnchor | undefined {
  const root = roots[index]
  if (!root || !["bulleted_list_item", "numbered_list_item"].includes(root.type)) return
  let start = index,
    end = index + 1
  if (side === "before") while (roots[start - 1]?.type === root.type) start--
  else while (roots[end]?.type === root.type) end++
  const nodes = roots.slice(start, end),
    ordered = root.type === "numbered_list_item"
  if (
    nodes.some(
      (node) =>
        node.has_children ||
        !node.rich_text?.length ||
        node.descendants !== undefined ||
        node.quote_descendants !== undefined ||
        node.list_table_descendants !== undefined ||
        node.table_evidence !== undefined ||
        node.code !== undefined ||
        node.to_do !== undefined ||
        (node.text !== undefined && node.text !== node.rich_text.map((span) => span.text).join("")),
    )
  )
    return
  const ordinal = nodes[0]!.numbered_list?.start
  if (
    (ordered &&
      (ordinal === undefined ||
        (ordinal !== null && (!Number.isSafeInteger(ordinal) || ordinal < 1)) ||
        nodes.slice(1).some((node) => node.numbered_list?.start !== null))) ||
    (!ordered && nodes.some((node) => node.numbered_list !== undefined))
  )
    return
  return { nodes, ordered, start: ordinal ?? 1 }
}

function sourceListAnchor(anchor: QuoteListAnchor, token: Token | undefined) {
  if (
    token?.type !== "list" ||
    token.ordered !== anchor.ordered ||
    token.loose ||
    token.items.length !== anchor.nodes.length ||
    (anchor.ordered && token.start !== anchor.start)
  )
    return false
  return token.items.every((item: Tokens.ListItem, index: number) => {
    const part = item.tokens[0],
      prefix = /^( {0,3})([-+*]|\d+[.)]) +/.exec(item.raw)
    return (
      !item.task &&
      !item.loose &&
      item.tokens.length === 1 &&
      part &&
      (part.type === "text" || part.type === "paragraph") &&
      part.text === item.text &&
      prefix !== null &&
      /^\d/.test(prefix[2]!) === anchor.ordered &&
      (!anchor.ordered || Number(prefix[2]!.slice(0, -1)) === anchor.start + index) &&
      item.raw.startsWith(prefix[0] + item.text) &&
      /^\n*$/.test(item.raw.slice(prefix[0].length + item.text.length)) &&
      sameLiteralInlineSpans(item.text, anchor.nodes[index]!.rich_text)
    )
  })
}

function readbackListAnchorEnd(anchor: QuoteListAnchor, lines: readonly Line[], index: number) {
  const sameKind = (line: Line | undefined) =>
    !!line &&
    !line.code &&
    (anchor.ordered ? /^\d+[.)] /.test(line.text) : /^[-+*] /.test(line.text))
  let previous = index - 1
  while (lines[previous]?.text === "") previous--
  if (sameKind(lines[previous])) return
  let first: number | undefined
  for (const [offset, node] of anchor.nodes.entries()) {
    const line = lines[index + offset],
      marker = line && /^([-+*]|\d+[.)]) +(.*)$/.exec(line.text)
    if (
      !line ||
      line.code ||
      !marker ||
      /^\d/.test(marker[1]!) !== anchor.ordered ||
      !sameLiteralInlineSpans(marker[2]!, node.rich_text)
    )
      return
    if (anchor.ordered) {
      const ordinal = Number(marker[1]!.slice(0, -1))
      if (String(ordinal) !== marker[1]!.slice(0, -1)) return
      if (offset === 0) {
        if (ordinal !== 1 && ordinal !== anchor.start) return
        first = ordinal
      } else if (ordinal !== first! + offset) return
    }
  }
  let next = index + anchor.nodes.length
  while (lines[next]?.text === "") next++
  return sameKind(lines[next]) ? undefined : index + anchor.nodes.length
}

function quoteEdits(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
  language: Language,
): Edit[] {
  const source = positioned(target),
    lines = linesOf(markdown),
    result: Edit[] = []
  if (!source) return result
  for (let rootIndex = 1; rootIndex + 1 < roots.length; rootIndex++) {
    if (roots[rootIndex]!.type !== "quote" || roots[rootIndex - 1]!.type === "quote") continue
    const plainRun =
      !roots[rootIndex]!.has_children &&
      roots[rootIndex + 1]?.type === "paragraph" &&
      !roots[rootIndex + 1]!.has_children &&
      roots[rootIndex + 2]?.type === "paragraph" &&
      !roots[rootIndex + 2]!.has_children
    let endIndex = rootIndex,
      separatedLeaves = false
    if (plainRun) {
      let cursor = rootIndex + 1
      while (roots[cursor]?.type === "paragraph" && !roots[cursor]!.has_children) cursor++
      if (roots[cursor]?.type === "quote") {
        endIndex = cursor + 1
        for (;;) {
          if (
            roots[endIndex]?.type !== "paragraph" ||
            roots[endIndex]!.has_children ||
            roots[endIndex + 1]?.type !== "paragraph" ||
            roots[endIndex + 1]!.has_children
          )
            break
          let next = endIndex
          while (roots[next]?.type === "paragraph" && !roots[next]!.has_children) next++
          if (roots[next]?.type !== "quote") break
          endIndex = next + 1
        }
      }
    } else {
      // A separate paragraph between a leaf quote and a complete second quote can
      // be swallowed into one lazy quote. Consume all three physical siblings as
      // one source-bound interval; neither quote alone proves that paragraph.
      const separated =
        !roots[rootIndex]!.has_children &&
        roots[rootIndex + 1]?.type === "paragraph" &&
        !roots[rootIndex + 1]!.has_children &&
        roots[rootIndex + 2]?.type === "quote"
      endIndex = separated ? rootIndex + 3 : rootIndex
      if (!separated) while (roots[endIndex]?.type === "quote") endIndex++
      separatedLeaves =
        separated && roots.slice(rootIndex, endIndex).every((root) => !root.has_children)
    }
    let leafEnd = rootIndex
    while (
      ["quote", "paragraph"].includes(roots[leafEnd]?.type ?? "") &&
      !roots[leafEnd]!.has_children
    )
      leafEnd++
    // One leaf quote followed by a separate paragraph is also a complete
    // interval; the serializer's lazy continuation must not absorb the paragraph.
    const leafInterval = leafEnd > rootIndex + 1 && leafEnd >= endIndex
    if (leafInterval) endIndex = leafEnd
    const group = roots.slice(rootIndex, endIndex),
      before = roots[rootIndex - 1]!,
      after = roots[endIndex]
    const plainLeaves =
      plainRun && endIndex > rootIndex && group.every((root) => !root.has_children)
    if (
      !after ||
      (!group.some((root) => root.has_children) &&
        !leafInterval &&
        !separatedLeaves &&
        !plainLeaves)
    )
      continue
    const beforeList = quoteListAnchor(roots, rootIndex - 1, "before"),
      afterList = quoteListAnchor(roots, endIndex, "after")
    // The additional interval is bounded by a complete flat bullet run and
    // one source/physical numbered leaf. Other list/container combinations
    // keep their existing eligibility rules.
    if (
      (beforeList || afterList) &&
      (!beforeList ||
        beforeList.ordered ||
        !afterList ||
        !afterList.ordered ||
        afterList.nodes.length !== 1)
    )
      continue
    const trees = group.map((root) => (root.type === "paragraph" ? [] : quoteChildren(root)))
    if (trees.some((tree) => tree === undefined)) continue
    const expected = group.map((root, index) =>
      root.type === "paragraph"
        ? retained(root.rich_text)?.length
          ? ["paragraph", retained(root.rich_text)!]
          : undefined
        : quoteStructure(root, trees[index]!, language),
    )
    if (expected.some((value) => value === undefined)) continue
    const sourceMatches = source.flatMap((part, index) => {
      if (
        !(beforeList
          ? sourceListAnchor(beforeList, source[index - 1]?.token)
          : sourceAnchor(before, source[index - 1]?.token, structure, same, language)) ||
        !(afterList
          ? sourceListAnchor(afterList, source[index + group.length]?.token)
          : sourceAnchor(after, source[index + group.length]?.token, structure, same, language))
      )
        return []
      const quotes = source.slice(index, index + group.length)
      return quotes.length === group.length &&
        quotes.every(
          (part, at) =>
            part.token.type === (group[at]!.type === "paragraph" ? "paragraph" : "blockquote"),
        ) &&
        same(
          expected,
          quotes.flatMap((part) => structure(part.token.raw)),
        )
        ? [index]
        : []
    })
    if (sourceMatches.length !== 1) continue
    const candidates: Edit[][] = []
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const anchored = beforeList
        ? readbackListAnchorEnd(beforeList, lines, lineIndex)
        : anchorEnd(before, lines, lineIndex, structure, same, language)
      if (anchored === undefined) continue
      let cursor: number = anchored
      while (lines[cursor]?.text === "") cursor++
      const start = lines[cursor]?.start
      if (start === undefined) continue
      const rendered: string[] = []
      let valid = true
      for (const [index, root] of group.entries()) {
        if (root.type === "paragraph") {
          const line = lines[cursor]
          if (!line || !anchor(root, line, structure, same)) {
            valid = false
            break
          }
          rendered.push("", line.text, "")
          cursor++
          while (lines[cursor]?.text === "") cursor++
          continue
        }
        const line = lines[cursor],
          head = line && /^> (.*)$/.exec(line.text)
        if (!line || line.code || !head || !sameInline(head[1]!, root, structure, same, true)) {
          valid = false
          break
        }
        if (index && !(plainRun && group[index - 1]?.type === "paragraph")) rendered.push("")
        rendered.push(line.text)
        cursor++
        const children = trees[index]!
        for (let childIndex = 0; childIndex < children.length; childIndex++) {
          // The ordinary converter separates a lifted list from its following
          // tab-indented sibling. Consume only empty serializer lines here;
          // code contents and every nonempty child still match in full below.
          while (lines[cursor]?.text === "") cursor++
          const child = children[childIndex]!
          if (child.type === "code") {
            const line = lines[cursor],
              code = child.code!
            const open = line?.opening && /^\t(`{3,}|~{3,})([^`]*)$/.exec(line.text)
            const content = code.text === "" ? [] : code.text.split("\n")
            const closeIndex: number = cursor + content.length + 1,
              closing = lines[closeIndex]
            const close = closing && /^\t(`{3,}|~{3,})[ \t]*$/.exec(closing.text)
            if (
              !line ||
              !open ||
              language(open[2]) !== language(code.language) ||
              content.some((text, at) => lines[cursor + at + 1]?.text !== text) ||
              !closing ||
              !close ||
              close[1]![0] !== open[1]![0] ||
              close[1]!.length < open[1]!.length
            ) {
              valid = false
              break
            }
            rendered.push(
              ">",
              `> ${line.text.slice(1)}`,
              ...content.map((text) => `> ${text}`),
              `> ${closing.text.slice(1)}`,
            )
            cursor = closeIndex + 1
            while (lines[cursor]?.text === "") cursor++
          } else if (child.type === "table") {
            if (lines[cursor]?.text !== '\t<table header-row="true">') {
              valid = false
              break
            }
            rendered.push(">", '> <table header-row="true">')
            cursor++
            for (const row of child.rows!) {
              if (lines[cursor]?.text !== "<tr>") {
                valid = false
                break
              }
              rendered.push("> <tr>")
              cursor++
              for (const cell of row.table_row!.cells) {
                const line = lines[cursor],
                  match = line && /^<td>(.*)<\/td>$/.exec(line.text)
                const parsed = match && inline(match[1]!, structure),
                  physical = retained(cell)
                if (
                  !line ||
                  line.code ||
                  !match ||
                  !parsed ||
                  !physical ||
                  !same(parsed, physical, readbackDestination)
                ) {
                  valid = false
                  break
                }
                rendered.push(`> ${line.text}`)
                cursor++
              }
              if (!valid || lines[cursor]?.text !== "</tr>") {
                valid = false
                break
              }
              rendered.push("> </tr>")
              cursor++
            }
            if (!valid || lines[cursor]?.text !== "\t</table>") {
              valid = false
              break
            }
            rendered.push("> </table>")
            cursor++
          } else if (child.type === "paragraph") {
            const line = lines[cursor]
            if (
              !line ||
              line.code ||
              !/^\t[^\t]/.test(line.text) ||
              !sameInline(line.text.slice(1), child, structure, same, true)
            ) {
              valid = false
              break
            }
            rendered.push(">", `> ${line.text.slice(1)}`)
            cursor++
          } else {
            rendered.push(">")
            let ordinal = child.numbered_list?.start ?? 1
            const type = child.type
            do {
              const item = children[childIndex]!,
                line = lines[cursor]
              const match = line && /^(?:\t|> )([-+*]|\d+[.)]) +(.*)$/.exec(line.text)
              const ordered = type === "numbered_list_item"
              if (
                !line ||
                line.code ||
                !match ||
                /^\d/.test(match[1]!) !== ordered ||
                (ordered && Number(match[1]!.slice(0, -1)) !== ordinal) ||
                !sameInline(match[2]!, item, structure, same, true)
              ) {
                valid = false
                break
              }
              rendered.push(`> ${line.text.slice(line.text.startsWith("> ") ? 2 : 1)}`)
              cursor++
              ordinal++
              childIndex++
            } while (children[childIndex]?.type === type)
            childIndex--
            if (!valid) break
          }
        }
        if (!valid) break
        while (lines[cursor]?.text === "") cursor++
      }
      if (
        !valid ||
        (afterList
          ? readbackListAnchorEnd(afterList, lines, cursor)
          : anchorEnd(after, lines, cursor, structure, same, language)) === undefined
      )
        continue
      const replacement = rendered.join("\n") + "\n\n"
      const sourceIndex = sourceMatches[0]!
      const sourceInterval = source
        .slice(sourceIndex, sourceIndex + group.length)
        .map((part) => part.token.raw)
        .join("\n\n")
      if (!same(structure(replacement), structure(sourceInterval), readbackDestination)) continue
      const edits: Edit[] = [{ start, end: lines[cursor]!.start, text: replacement }]
      // The same complete interval already proved this leaf against the
      // original source and its physical start. Recover only the API's reset
      // "1" here; no generated quote text authorizes a later numbering proof.
      if (afterList && afterList.start > 1 && /^1[.)] /.test(lines[cursor]!.text))
        edits.push({
          start: lines[cursor]!.start,
          end: lines[cursor]!.start + 1,
          text: String(afterList.start),
        })
      candidates.push(edits)
    }
    if (candidates.length === 1) result.push(...candidates[0]!)
    rootIndex = endIndex - 1
  }
  return result
}

/** Comparison-only decoding. Every replacement is bound to unmodified readback,
 * complete physical ownership and the source. Callers still compare the entire
 * candidate with their own destination policy; no source or remote bytes change. */
export function physicalReadbackCandidate(
  markdown: string,
  target: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
  same: Same,
  proves: Proves,
  language: Language,
) {
  if (markdown.includes("\r") || target.includes("\r") || !uniqueIds(roots)) return
  const edits = [
    ...sourceSpaceEdits(markdown, target, roots, structure, same, proves),
    ...sourceNestedListSpaceEdits(markdown, target, roots, proves),
    ...boldCodeLinkReadbackEdits(markdown, target, roots),
    ...boldCodeLinkListReadbackEdits(markdown, target, roots),
    ...backtickEdits(markdown, target, roots, structure, same, proves),
    ...emphasisCodeEdits(markdown, target, roots, structure, same),
    ...quoteEdits(markdown, target, roots, structure, same, language),
    ...listTableReadbackEdits(markdown, target, roots, structure, same),
    ...nestedTableReadbackEdits(markdown, target, roots, structure, same),
  ]
  edits.sort((a, b) => a.start - b.start)
  if (!edits.length || edits.some((edit, index) => index > 0 && edits[index - 1]!.end > edit.start))
    return
  let result = markdown
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result === markdown ? undefined : result
}
