import { Lexer, type Token, type Tokens } from "marked"

export interface ZeroTextSpan {
  readonly text: string
  readonly link: string | null
  readonly bold: boolean
  readonly code: boolean
}
export interface ZeroBoundary {
  readonly id: string
  readonly type: string
  readonly has_children: boolean
  readonly rich_text?: readonly ZeroTextSpan[]
}
export interface ZeroItem {
  readonly index: number
  readonly wire: string
  readonly prefix: string
  readonly spans: readonly ZeroTextSpan[]
}
export interface ZeroPresentation {
  readonly codec: "zero-start-paragraphs-v1"
  readonly wire: string
  readonly source_span: { readonly start: number; readonly end: number }
  readonly items: readonly ZeroItem[]
  readonly root_index: number
}
type Structure = (markdown: string) => readonly unknown[]
type SameStructure = (actual: readonly unknown[], target: readonly unknown[]) => boolean
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

// Physical readback may lowercase a root hostname or append its slash. Do not
// normalize ports, paths, queries, fragments, credentials or the URL scheme.
function samePhysicalLink(left: string | null, right: string | null) {
  if (left === right) return true
  if (left === null || right === null) return false
  const root = /^(https?):\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}|localhost)\/?$/i
  const a = root.exec(left),
    b = root.exec(right)
  return a !== null && b !== null && a[1] === b[1] && a[2]!.toLowerCase() === b[2]!.toLowerCase()
}

function samePhysicalSpans(left: readonly ZeroTextSpan[], right: readonly ZeroTextSpan[]) {
  return (
    left.length === right.length &&
    left.every((span, index) => {
      const other = right[index]!
      return (
        span.text === other.text &&
        span.bold === other.bold &&
        span.code === other.code &&
        samePhysicalLink(span.link, other.link)
      )
    })
  )
}

function merge(spans: readonly ZeroTextSpan[]) {
  const result: Array<{ text: string; link: string | null; bold: boolean; code: boolean }> = []
  for (const span of spans) {
    const previous = result.at(-1)
    if (
      previous &&
      previous.link === span.link &&
      previous.bold === span.bold &&
      previous.code === span.code
    )
      previous.text += span.text
    else if (span.text) result.push({ ...span })
  }
  return result
}

function inlineSpans(
  tokens: readonly Token[],
  bold = false,
  link: string | null = null,
): ZeroTextSpan[] | undefined {
  const result: ZeroTextSpan[] = []
  for (const token of tokens) {
    if (token.type === "strong") {
      if (!Array.isArray(token.tokens)) return
      const nested = inlineSpans(token.tokens, true, link)
      if (!nested) return
      result.push(...nested)
    } else if (token.type === "link") {
      if (
        link !== null ||
        token.title ||
        typeof token.href !== "string" ||
        !Array.isArray(token.tokens)
      )
        return
      const nested = inlineSpans(token.tokens, bold, token.href)
      if (!nested) return
      result.push(...nested)
    } else if (token.type === "text" && Array.isArray(token.tokens)) {
      const nested = inlineSpans(token.tokens, bold, link)
      if (!nested) return
      result.push(...nested)
    } else if (
      (token.type === "text" || token.type === "escape" || token.type === "codespan") &&
      typeof token.text === "string"
    ) {
      if (/[\r\n]/.test(token.text)) return
      result.push({ text: token.text, link, bold, code: token.type === "codespan" })
    } else return
  }
  return merge(result)
}

function withoutPrefix(node: unknown, prefix: string) {
  if (!Array.isArray(node) || node[0] !== "paragraph" || !Array.isArray(node[1])) return
  const first: unknown = node[1][0]
  if (typeof first !== "string" || !first.startsWith(prefix)) return
  const rest = first.slice(prefix.length)
  return ["paragraph", [...(rest ? [rest] : []), ...node[1].slice(1)]]
}

function rootStructures(markdown: string, structure: Structure) {
  const roots: unknown[] = []
  for (const token of Lexer.lex(markdown)) {
    if (token.type === "space") continue
    if (token.type === "def") return
    const value = structure(token.raw)
    if (value.length !== 1) return
    roots.push(value[0])
  }
  return roots
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === "list" && typeof token.ordered === "boolean" && Array.isArray(token.items)
}

function physicalRootLayout(markdown: string) {
  const types: string[] = [],
    positions: number[] = []
  for (const token of Lexer.lex(markdown)) {
    if (token.type === "space") continue
    positions.push(types.length)
    if (token.type === "paragraph") types.push("paragraph")
    else if (token.type === "heading" && [1, 2, 3].includes(token.depth))
      types.push("heading_" + token.depth)
    else if (token.type === "hr") types.push("divider")
    else if (isListToken(token)) {
      if (!token.items.length) return
      for (const item of token.items) {
        const blocks = item.tokens.filter((child) => child.type !== "space")
        if (
          item.task ||
          blocks.length !== 1 ||
          (blocks[0]!.type !== "paragraph" && blocks[0]!.type !== "text")
        )
          return
        types.push(token.ordered ? "numbered_list_item" : "bulleted_list_item")
      }
    } else if (token.type === "blockquote" && Array.isArray(token.tokens)) {
      const blocks = token.tokens.filter((child: Token) => child.type !== "space")
      if (blocks.length !== 1 || blocks[0]!.type !== "paragraph") return
      types.push("quote")
    } else return
  }
  return { types, positions }
}

/**
 * Version 1 preserves a single flat root zero-start list as visible, escaped
 * numeric paragraph prefixes. Nested, multiline, task and unsupported inline
 * forms are refused. No readback or write authority follows from planning.
 */
export function planZeroStartPresentation(
  source: string,
  structure: Structure,
): ZeroPresentation | undefined {
  if (/[\r\0]/.test(source)) return
  const tokens = Lexer.lex(source)
  const lists = tokens.filter(
    (token): token is Tokens.List => isListToken(token) && token.ordered && token.start === 0,
  )
  if (lists.length !== 1) return
  const list = lists[0]!
  if (list.type !== "list" || !list.items.length || list.items.length > 100) return
  let offset = 0,
    listStart = -1,
    astIndex = 0
  for (const token of tokens) {
    const position = source.indexOf(token.raw, offset)
    if (position < 0 || !/^[ \t\n]*$/.test(source.slice(offset, position))) return
    if (token === list) {
      listStart = position
      break
    }
    offset = position + token.raw.length
    if (token.type !== "space" && token.type !== "def") astIndex++
  }
  if (listStart < 0) return
  const items: ZeroItem[] = []
  for (const [index, item] of list.items.entries()) {
    const raw = /^( {0,3})(\d{1,9})[.)]([ \t]+)([^\r\n]+)\n*$/.exec(item.raw)
    const blocks = item.tokens.filter((token) => token.type !== "space")
    if (
      !raw ||
      item.task ||
      blocks.length !== 1 ||
      (blocks[0]!.type !== "paragraph" && blocks[0]!.type !== "text")
    )
      return
    const body = raw[4]!
    const spans = inlineSpans(Lexer.lexInline(body))
    if (!spans?.length) return
    const prefix = index + ". "
    const wire = index + "\\. " + body
    const original = structure(body),
      encoded = structure(wire)
    if (
      original.length !== 1 ||
      encoded.length !== 1 ||
      !equal(withoutPrefix(encoded[0], prefix), original[0])
    )
      return
    items.push({
      index,
      wire,
      prefix,
      spans: merge([{ text: prefix, link: null, bold: false, code: false }, ...spans]),
    })
  }
  const before = source.slice(0, listStart)
  const after = source.slice(listStart + list.raw.length)
  const wire = before + items.map((item) => item.wire).join("\n\n") + after
  const sourceAst = rootStructures(source, structure),
    wireAst = rootStructures(wire, structure)
  if (!sourceAst || !wireAst) return
  const sourceList = sourceAst[astIndex]
  if (
    !Array.isArray(sourceList) ||
    sourceList[0] !== "list" ||
    sourceList[1] !== true ||
    sourceList[2] !== 0 ||
    !Array.isArray(sourceList[3]) ||
    sourceList[3].length !== items.length
  )
    return
  const expected = [...sourceAst.slice(0, astIndex)]
  for (const [index, item] of items.entries()) {
    const original: unknown = sourceList[3][index]
    const paragraph = structure(item.wire)[0]
    if (
      !Array.isArray(original) ||
      original[0] !== false ||
      original[1] != null ||
      !Array.isArray(original[2]) ||
      original[2].length !== 1 ||
      !equal(withoutPrefix(paragraph, item.prefix), original[2][0])
    )
      return
    expected.push(paragraph)
  }
  expected.push(...sourceAst.slice(astIndex + 1))
  if (!equal(wireAst, expected)) return
  return {
    codec: "zero-start-paragraphs-v1",
    wire,
    source_span: { start: listStart, end: listStart + list.raw.length },
    items,
    root_index: astIndex,
  }
}

/**
 * Source-bound comparison: the full serialized wire and a unique contiguous
 * physical paragraph group must independently prove every literal number and
 * inline span. Native numbered-list blocks, including absent start fields,
 * never establish this representation.
 */
export function zeroStartPresentationCandidate(
  actual: string,
  target: string,
  boundaries: readonly ZeroBoundary[],
  structure: Structure,
  proves: (
    firstIndex: number,
    ranges: readonly { readonly start: number; readonly end: number }[],
  ) => boolean,
  sameStructure: SameStructure,
): string | undefined {
  const plan = planZeroStartPresentation(target, structure)
  if (!plan || !boundaries.length) return
  const layout = physicalRootLayout(plan.wire)
  if (
    !layout ||
    layout.types.length !== boundaries.length ||
    boundaries.some((block, index) => block.has_children || block.type !== layout.types[index])
  )
    return
  const ids = new Set<string>()
  for (const block of boundaries) {
    if (!block.id || ids.has(block.id)) return
    ids.add(block.id)
  }
  const starts: number[] = []
  for (let start = 0; start + plan.items.length <= boundaries.length; start++) {
    if (
      plan.items.every((item, ordinal) => {
        const block = boundaries[start + ordinal]!
        return (
          block.type === "paragraph" &&
          !block.has_children &&
          block.rich_text &&
          equal(merge(block.rich_text), item.spans)
        )
      })
    )
      starts.push(start)
  }
  if (starts.length !== 1 || starts[0] !== layout.positions[plan.root_index]) return
  const actualRoots = rootStructures(actual, structure),
    expectedRoots = rootStructures(plan.wire, structure)
  if (!actualRoots || !expectedRoots || !sameStructure(actualRoots, expectedRoots)) return
  const positions: Array<{ start: number; end: number; type: string }> = []
  let offset = 0
  for (const token of Lexer.lex(actual)) {
    const start = actual.indexOf(token.raw, offset)
    if (start < 0 || actual.slice(offset, start).trim()) return
    offset = start + token.raw.length
    if (token.type !== "space" && token.type !== "def")
      positions.push({
        start,
        end: start + (token.type === "paragraph" ? token.text.length : token.raw.length),
        type: token.type,
      })
  }
  const ranges = positions.slice(plan.root_index, plan.root_index + plan.items.length)
  if (
    ranges.length !== plan.items.length ||
    ranges.some((range) => range.type !== "paragraph") ||
    !proves(starts[0]!, ranges)
  )
    return
  return target
}

function literalZeroWire(target: string, structure: Structure) {
  const planned = planZeroStartPresentation(target, structure)
  if (planned) return planned
  const tokens = Lexer.lex(target).filter((token) => token.type !== "space")
  const numeric = tokens.flatMap((token, index) => {
    const match =
      token.type === "paragraph" ? /^(\d{1,3})\\\. ([^\r\n]+)\n*$/.exec(token.raw) : undefined
    return match ? [{ token, index, ordinal: Number(match[1]) }] : []
  })
  if (
    !numeric.length ||
    numeric.length > 100 ||
    numeric[0]!.ordinal !== 0 ||
    numeric.some(
      (item, index) => item.ordinal !== index || item.index !== numeric[0]!.index + index,
    )
  )
    return
  const items: ZeroItem[] = []
  for (const { token, ordinal } of numeric) {
    const wire = token.raw.replace(/\n+$/, "")
    const spans = inlineSpans(Lexer.lexInline(wire))
    if (!spans?.length) return
    items.push({ index: ordinal, wire, prefix: ordinal + ". ", spans })
  }
  return { wire: target, items, root_index: numeric[0]!.index }
}

/** The Markdown endpoint can put adjacent numeric paragraphs on one linefeed.
 * Restore only their literal escapes and paragraph separators after a unique,
 * complete flat root layout and every numeric rich-text span agree. The whole
 * resulting document must still equal the complete derived wire structure. */
export function zeroStartParagraphReadbackCandidate(
  actual: string,
  target: string,
  boundaries: readonly ZeroBoundary[],
  structure: Structure,
  sameStructure: SameStructure,
): string | undefined {
  const plan = literalZeroWire(target, structure)
  if (!plan || /[\r\0]/.test(actual) || !boundaries.length || boundaries.length > 100) return
  const layout = physicalRootLayout(plan.wire)
  if (
    !layout ||
    layout.types.length !== boundaries.length ||
    boundaries.some((block, index) => block.has_children || block.type !== layout.types[index]) ||
    new Set(boundaries.map((block) => block.id)).size !== boundaries.length ||
    boundaries.some((block) => !block.id)
  )
    return
  const physical: number[] = []
  for (let index = 0; index + plan.items.length <= boundaries.length; index++) {
    if (
      plan.items.every((item, ordinal) => {
        const block = boundaries[index + ordinal]!
        return (
          block.type === "paragraph" && block.rich_text && equal(merge(block.rich_text), item.spans)
        )
      })
    )
      physical.push(index)
  }
  if (physical.length !== 1 || physical[0] !== layout.positions[plan.root_index]) return
  const lines = actual.split("\n")
  const content = lines.flatMap((line, index) => (line === "" ? [] : [{ line, index }]))
  const located: number[] = []
  for (let index = 0; index + plan.items.length <= content.length; index++) {
    if (
      plan.items.every((item, ordinal) => {
        const line = content[index + ordinal]!.line
        if (!line.startsWith(item.prefix) && !line.startsWith(item.index + "\\. ")) return false
        const spans = inlineSpans(Lexer.lexInline(line))
        return spans !== undefined && equal(spans, item.spans)
      })
    )
      located.push(index)
  }
  if (located.length !== 1 || content.length !== boundaries.length || located[0] !== physical[0])
    return
  // A single-line endpoint response also joins neighboring ordinary paragraphs.
  // Each such line must bind to its same-position physical paragraph before a
  // separator can be restored; no other root receives a text transformation.
  const paragraphs = content.filter((_, index) => boundaries[index]!.type === "paragraph")
  for (const paragraph of paragraphs) {
    const index = content.indexOf(paragraph),
      block = boundaries[index]!
    const spans = inlineSpans(Lexer.lexInline(paragraph.line))
    if (!block.rich_text || !spans || !samePhysicalSpans(spans, merge(block.rich_text))) return
  }
  const selected = content.slice(located[0]!, located[0]! + plan.items.length)
  const insertions = new Set<number>()
  for (const { index } of paragraphs) {
    if (index > 0 && lines[index - 1] !== "") insertions.add(index)
    if (index + 1 < lines.length && lines[index + 1] !== "") insertions.add(index + 1)
  }
  const escaped = new Set(selected.map((line) => line.index))
  const output: string[] = []
  for (const [index, line] of lines.entries()) {
    if (insertions.has(index)) output.push("")
    output.push(escaped.has(index) ? line.replace(/^(\d+)\. /, "$1\\. ") : line)
  }
  const candidate = output.join("\n")
  if (candidate === actual) return
  const observed = rootStructures(candidate, structure),
    expected = rootStructures(plan.wire, structure)
  return observed && expected && sameStructure(observed, expected) ? candidate : undefined
}
