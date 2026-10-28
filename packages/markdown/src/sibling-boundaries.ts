import { Lexer } from "marked"
import type { NotionBlockBoundary, NotionBlockNode } from "./index.ts"

type Structure = (markdown: string) => readonly unknown[]
interface TreeNode extends NotionBlockNode {
  readonly children?: readonly TreeNode[]
}
interface BuiltNode extends NotionBlockNode {
  readonly children: BuiltNode[]
}
interface ListRange {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly contentIndent: number
  readonly body: string
}
const textTypes = new Set(["paragraph", "bulleted_list_item", "numbered_list_item"])
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

// Only compare transport spelling with the physical span that produced it.
// Authored link destinations still use the caller's complete Markdown proof.
function samePhysicalInline(left: unknown, right: unknown): boolean {
  if (same(left, right)) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  if (left[0] === "link" && right[0] === "link") {
    const root = (value: unknown) =>
      typeof value === "string" ? /^(https?:\/\/[^/:?#@\\\s]+)\/?$/.exec(value)?.[1] : undefined
    const actual = root(left[1]),
      physical = root(right[1])
    return actual !== undefined && actual === physical && same(left.slice(2), right.slice(2))
  }
  return left.every((value, index) => samePhysicalInline(value, right[index]))
}

function joinInline(values: readonly unknown[]) {
  const result: unknown[] = []
  for (const value of values) {
    const previous = result.at(-1)
    if (typeof value === "string" && typeof previous === "string")
      result[result.length - 1] = (previous + value).replace(/\s+/g, " ")
    else result.push(value)
  }
  return result
}

function retained(block: NotionBlockNode) {
  if (!Array.isArray(block.rich_text) || !block.rich_text.length) return
  const values: unknown[] = ["prefix "]
  for (const span of block.rich_text) {
    if (
      typeof span.text !== "string" ||
      /[\r\n]/.test(span.text) ||
      typeof span.code !== "boolean" ||
      typeof span.bold !== "boolean" ||
      (span.link !== null && typeof span.link !== "string")
    )
      return
    const value = span.code ? ["code", span.text] : span.text.replace(/\s+/g, " ")
    values.push(span.link === null ? value : ["link", span.link, null, [value]])
  }
  const text = block.rich_text.map((span) => span.text).join("")
  if (!text.trim() || (block.text !== undefined && block.text !== text)) return
  return joinInline(values)
}

function content(line: string, structure: Structure) {
  if (!line || /[\r\n]/.test(line)) return
  const ast = structure(`prefix ${line}`),
    root = ast[0]
  return ast.length === 1 &&
    Array.isArray(root) &&
    root[0] === "paragraph" &&
    Array.isArray(root[1])
    ? root[1]
    : undefined
}

function richParagraphLine(line: string) {
  if (!/^\S/.test(line) || /^(?:[-+*]|\d+[.)])\s|^[#>~]/.test(line)) return false
  if (!line.startsWith("`")) return true
  // A leading inline code span is still paragraph content. A fence, an
  // unmatched delimiter or literal backtick cannot borrow this eligibility.
  const tokens = Lexer.lex(line),
    first = tokens[0]
  return (
    tokens.length === 1 && first?.type === "paragraph" && first.tokens?.[0]?.type === "codespan"
  )
}

// A legacy root without descendants remains usable by older proofs, but cannot
// supply a child boundary. Present descendants must form one complete DFS tree.
function rootTrees(roots: readonly NotionBlockBoundary[]) {
  if (!roots.length || roots.length > 4096) return
  const ids = new Set<string>(),
    result: TreeNode[] = []
  let total = 0
  for (const root of roots) {
    if (
      !root ||
      typeof root.id !== "string" ||
      !root.id ||
      ids.has(root.id) ||
      typeof root.has_children !== "boolean" ||
      ++total > 4096
    )
      return
    ids.add(root.id)
    if (root.descendants === undefined) {
      result.push(root)
      continue
    }
    if (
      !Array.isArray(root.descendants) ||
      !root.has_children ||
      !root.descendants.length ||
      !["bulleted_list_item", "numbered_list_item"].includes(root.type)
    )
      return
    const tree: BuiltNode = { ...root, children: [] },
      stack = [tree],
      nodes = [tree]
    for (const child of root.descendants) {
      if (
        !child ||
        typeof child.id !== "string" ||
        !child.id ||
        ids.has(child.id) ||
        typeof child.parent_id !== "string" ||
        typeof child.has_children !== "boolean" ||
        !textTypes.has(child.type) ||
        ++total > 4096
      )
        return
      ids.add(child.id)
      while (stack.length && stack.at(-1)!.id !== child.parent_id) stack.pop()
      const parent = stack.at(-1)
      if (
        !parent ||
        !parent.has_children ||
        stack.length > 32 ||
        (child.type === "paragraph" && child.has_children)
      )
        return
      const node: BuiltNode = { ...child, children: [] }
      parent.children.push(node)
      nodes.push(node)
      stack.push(node)
    }
    if (nodes.some((node) => node.has_children !== node.children.length > 0)) return
    result.push(tree)
  }
  return result
}

function rootItems(markdown: string) {
  const result: ListRange[] = []
  let cursor = 0
  for (const token of Lexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, cursor)
    if (start < cursor || markdown.slice(cursor, start).trim()) return
    if (token.type === "list") {
      let offset = start
      for (const item of token.items) {
        const at = markdown.indexOf(item.raw, offset)
        if (at !== offset || at + item.raw.length > start + token.raw.length) return
        const first = item.raw.split("\n")[0]!
        const match = /^( {0,3})([-+*]|\d+[.)])([ \t]+)(\S.*)$/.exec(first)
        if (match && !match[3]!.includes("\t"))
          result.push({
            type: token.ordered ? "numbered_list_item" : "bulleted_list_item",
            start: at,
            end: at + item.raw.length,
            contentIndent: match[1]!.length + match[2]!.length + match[3]!.length,
            body: match[4]!,
          })
        offset = at + item.raw.length
      }
    }
    cursor = start + token.raw.length
  }
  return result
}

/** Insert only paragraph linefeeds proved by complete same-parent descendants,
 * exact inline content, indentation and adjacent roots in the unmodified body. */
export function nestedParagraphBoundaries(
  markdown: string,
  boundaries: readonly NotionBlockBoundary[],
  structure: Structure,
) {
  const roots = rootTrees(boundaries),
    ranges = rootItems(markdown)
  if (!roots || !ranges) return
  const located = roots.map((root) =>
    ranges.filter(
      (range) =>
        range.type === root.type &&
        retained(root) !== undefined &&
        same(content(range.body, structure), retained(root)),
    ),
  )
  let previous = -1
  for (const candidates of located)
    if (candidates.length === 1) {
      if (candidates[0]!.start < previous) return
      previous = candidates[0]!.end
    }
  const insertions: number[] = []
  for (let rootIndex = 1; rootIndex + 1 < roots.length; rootIndex++) {
    const root = roots[rootIndex]!
    if (
      !root.has_children ||
      !root.children?.length ||
      !["numbered_list_item", "bulleted_list_item"].includes(root.type) ||
      located[rootIndex]!.length !== 1 ||
      located[rootIndex - 1]!.length !== 1 ||
      located[rootIndex + 1]!.length !== 1
    )
      continue
    const range = located[rootIndex]![0]!,
      before = located[rootIndex - 1]![0]!,
      after = located[rootIndex + 1]![0]!
    if (
      before.end > range.start ||
      after.start < range.end ||
      markdown.slice(before.end, range.start).trim() ||
      markdown.slice(range.end, after.start).trim()
    )
      continue
    const lines: Array<{ text: string; start: number }> = []
    let offset = range.start
    for (const text of markdown.slice(range.start, range.end).split("\n")) {
      lines.push({ text, start: offset })
      offset += text.length + 1
    }
    let cursor = 1
    const proposed: number[] = []
    const consume = (children: readonly TreeNode[], indent: number): boolean => {
      for (const node of children) {
        while (cursor < lines.length && !lines[cursor]!.text.trim()) cursor++
        const line = lines[cursor]
        if (!line || !textTypes.has(node.type) || retained(node) === undefined) return false
        const prefix = /^( *)(\S.*)$/.exec(line.text)
        if (!prefix || prefix[1]!.length !== indent) return false
        let body = prefix[2]!,
          childIndent = indent
        if (node.type !== "paragraph") {
          const list = /^([-+*]|\d+[.)])( +)(\S.*)$/.exec(body)
          if (
            !list ||
            (/^\d/.test(list[1]!) ? "numbered_list_item" : "bulleted_list_item") !== node.type
          )
            return false
          childIndent += list[1]!.length + list[2]!.length
          body = list[3]!
        } else if (/^(?:[-+*]|\d+[.)])\s|^[#>`~]/.test(body) || node.has_children) return false
        if (!same(content(body, structure), retained(node))) return false
        if (node.type === "paragraph" && lines[cursor - 1]?.text.trim()) proposed.push(line.start)
        cursor++
        if (node.has_children && (!node.children || !consume(node.children, childIndent)))
          return false
      }
      return true
    }
    if (
      !consume(root.children, range.contentIndent) ||
      lines.slice(cursor).some((line) => line.text.trim())
    )
      continue
    insertions.push(...proposed)
  }
  if (!insertions.length || new Set(insertions).size !== insertions.length) return
  let result = markdown
  for (const offset of insertions.sort((a, b) => b - a))
    result = result.slice(0, offset) + "\n" + result.slice(offset)
  return result
}

/** A linked quote and its complete run of separate physical paragraphs require
 * a heading before them and a heading or flat bullet after them. Each unindented
 * readback line must match one entire sibling. No content is reconstructed. */
export function richQuoteBoundaries(
  markdown: string,
  roots: readonly NotionBlockBoundary[],
  structure: Structure,
) {
  if (!roots.length || roots.length > 4096) return
  const ids = new Set<string>()
  for (const root of roots) {
    if (
      !root ||
      typeof root.id !== "string" ||
      !root.id ||
      ids.has(root.id) ||
      typeof root.has_children !== "boolean"
    )
      return
    ids.add(root.id)
  }
  const anchors: Array<{ type: string; inline: unknown; start: number; end: number }> = []
  const pairs: Array<{
    start: number
    end: number
    boundary: number
    quote: unknown
    paragraphs: unknown[]
  }> = []
  let cursor = 0
  for (const token of Lexer.lex(markdown)) {
    const start = markdown.indexOf(token.raw, cursor)
    if (start < cursor || markdown.slice(cursor, start).trim()) return
    const end = start + token.raw.length
    if (token.type === "heading" && !/[\r\n]/.test(token.text))
      anchors.push({
        type: `heading_${token.depth}`,
        inline: content(token.text, structure),
        start,
        end,
      })
    if (token.type === "blockquote") {
      const children = token.tokens?.filter((child) => child.type !== "space")
      const lines = token.raw.replace(/\n+$/, "").split("\n")
      const quote =
        lines.length >= 2 && lines.length <= roots.length
          ? /^ {0,3}>[ \t]?([^\r\n]+)$/.exec(lines[0]!)
          : undefined
      if (
        children?.length === 1 &&
        children[0]!.type === "paragraph" &&
        quote &&
        lines.slice(1).every(richParagraphLine)
      )
        pairs.push({
          start,
          end,
          boundary: start + lines[0]!.length + 1,
          quote: content(quote[1]!, structure),
          paragraphs: lines.slice(1).map((line) => content(line, structure)),
        })
    }
    cursor = end
  }
  const items = rootItems(markdown)
  if (!items) return
  for (const item of items)
    if (item.type === "bulleted_list_item")
      anchors.push({
        type: item.type,
        inline: content(item.body, structure),
        start: item.start,
        end: item.end,
      })
  const leaf = (root: NotionBlockBoundary) => (root.has_children ? undefined : retained(root))
  const located = roots.map((root) =>
    anchors.filter(
      (anchor) =>
        anchor.type === root.type &&
        leaf(root) !== undefined &&
        samePhysicalInline(anchor.inline, leaf(root)),
    ),
  )
  let previousEnd = -1
  for (const matches of located)
    if (matches.length === 1) {
      if (matches[0]!.start < previousEnd) return
      previousEnd = matches[0]!.end
    }
  const insertions: number[] = []
  for (let index = 1; index + 2 < roots.length; index++) {
    const quote = roots[index]!
    let endIndex = index + 1
    while (roots[endIndex]?.type === "paragraph") endIndex++
    const paragraphs = roots.slice(index + 1, endIndex)
    if (
      !/^heading_[1-6]$/.test(roots[index - 1]!.type) ||
      quote.type !== "quote" ||
      leaf(quote) === undefined ||
      !paragraphs.length ||
      paragraphs.some((paragraph) => leaf(paragraph) === undefined) ||
      !roots[endIndex] ||
      !quote.rich_text!.some((span) => typeof span.link === "string") ||
      located[index - 1]!.length !== 1 ||
      located[endIndex]!.length !== 1
    )
      continue
    const matches = pairs.filter(
      (pair) =>
        samePhysicalInline(pair.quote, leaf(quote)) &&
        pair.paragraphs.length === paragraphs.length &&
        pair.paragraphs.every((paragraph, at) =>
          samePhysicalInline(paragraph, leaf(paragraphs[at]!)),
        ),
    )
    if (matches.length !== 1) continue
    const pair = matches[0]!,
      before = located[index - 1]![0]!,
      after = located[endIndex]![0]!
    if (
      before.end > pair.start ||
      after.start < pair.end ||
      markdown.slice(before.end, pair.start).trim() ||
      markdown.slice(pair.end, after.start).trim()
    )
      continue
    insertions.push(pair.boundary)
  }
  if (!insertions.length || new Set(insertions).size !== insertions.length) return
  let result = markdown
  for (const boundary of insertions.sort((a, b) => b - a))
    result = result.slice(0, boundary) + "\n" + result.slice(boundary)
  return result
}
