import { type Token, type Tokens } from "marked"
import { SourceLexer as Lexer } from "./source-lexer.ts"
import type { NotionBlockBoundary, NotionTextSpan } from "./index.ts"

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
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean
type Inline = (text: string, tokens?: readonly Token[], markEscapes?: boolean) => unknown[]
type InlineText = (values: unknown[]) => unknown[]

// These literal placeholder forms contain no attribute values, destinations,
// closing tags, or declarations. The source parser still labels
// them as HTML; the original plain rich-text block preserves their exact bytes.
function literalAnglePlaceholder(text: string) {
  return (
    /^<[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*>$/.test(text) &&
    (text.includes("-") || text.includes(" "))
  )
}

function escapedAngleSource(text: string) {
  const tokens = Lexer.lexInline(text)
  if (tokens.map((token) => token.raw).join("") !== text) return
  let count = 0
  const escaped = tokens
    .map((token) => {
      if (token.type !== "html" || !literalAnglePlaceholder(token.raw)) return token.raw
      count++
      return `\\${token.raw.slice(0, -1)}\\>`
    })
    .join("")
  return count > 0 ? escaped : undefined
}

function literalAngleEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  retainedInline: (block: NotionBlockBoundary) => unknown[] | undefined,
  leafListItem: (item: Tokens.ListItem) => boolean,
  originalListItemRanges: (markdown: string, part: Part) => readonly Range[] | undefined,
  inline: Inline,
) {
  const edits: Edit[] = []
  for (const sourcePart of wanted) {
    const sourceList = sourcePart.token
    if (sourceList.type !== "list" || !sourceList.items.every(leafListItem)) continue
    for (const sourceItem of sourceList.items) {
      const escaped = escapedAngleSource(sourceItem.text)
      if (escaped === undefined) continue
      const marker = /^( {0,3}(?:[-+*]|\d+[.)])[ \t]+)/.exec(sourceItem.raw)
      if (!marker || !sourceItem.raw.startsWith(marker[1]! + sourceItem.text)) continue
      const suffix = sourceItem.raw.slice(marker[1]!.length + sourceItem.text.length)
      if (!/^\n*$/.test(suffix)) continue
      const sourceCopies = wanted
        .flatMap(({ token }) => (token.type === "list" ? token.items : []))
        .filter((item) => item.text === sourceItem.text)
      if (sourceCopies.length !== 1) continue
      const matches = actual.flatMap((part) => {
        const list = part.token
        if (
          list.type !== "list" ||
          list.ordered !== sourceList.ordered ||
          list.start !== sourceList.start ||
          list.items.length !== sourceList.items.length
        )
          return []
        const ranges = originalListItemRanges(markdown, part)
        if (!ranges) return []
        return list.items.flatMap((item: Tokens.ListItem, index: number) => {
          if (item.text !== escaped) return []
          if (item.raw !== marker[1]! + escaped + suffix) return []
          const roots = boundaries.flatMap((block, rootIndex) =>
            block.type === (list.ordered ? "numbered_list_item" : "bulleted_list_item") &&
            !block.has_children &&
            JSON.stringify(retainedInline(block)) === JSON.stringify(inline(escaped))
              ? [rootIndex]
              : [],
          )
          if (roots.length !== 1 || !proves(roots[0]!, [ranges[index]!])) return []
          const start = ranges[index]!.start + marker[1]!.length
          return [{ start, end: start + escaped.length, text: sourceItem.text }]
        })
      })
      if (matches.length === 1) edits.push(matches[0]!)
    }
  }
  const last = wanted.at(-1),
    previous = wanted.at(-2),
    part = actual.at(-1)
  if (
    last?.token.type !== "html" ||
    previous?.token.type !== "paragraph" ||
    part?.token.type !== "paragraph" ||
    target.slice(previous.end, last.start) !== "\n\n" ||
    target.slice(last.end).trim()
  )
    return edits
  const literal = last.token.raw.replace(/\n+$/, "")
  if (
    !literalAnglePlaceholder(literal) ||
    wanted.filter(({ token }) => token.type === "html" && token.raw.replace(/\n+$/, "") === literal)
      .length !== 1
  )
    return edits
  const escaped = `\\${literal.slice(0, -1)}\\>`
  if (!part.token.text.endsWith(`\n${escaped}`) || markdown.slice(part.end).trim()) return edits
  const rootIndex = boundaries.length - 1,
    block = boundaries[rootIndex],
    before = boundaries[rootIndex - 1]
  if (
    block?.type !== "paragraph" ||
    block.has_children ||
    before?.type !== "paragraph" ||
    before.has_children ||
    !block.rich_text?.length ||
    block.rich_text.some((span) => span.code || span.link !== null) ||
    block.rich_text.map((span) => span.text).join("") !== literal ||
    JSON.stringify(retainedInline(before)) !==
      JSON.stringify(inline(previous.token.text, previous.token.tokens))
  )
    return edits
  const start = part.start + part.token.text.length - escaped.length
  if (!proves(rootIndex, [{ start, end: start + escaped.length }])) return edits
  // Restore this original paragraph boundary and its exact literal, not other
  // backslashes or angle text elsewhere in the document.
  edits.push({ start, end: markdown.length, text: `\n${last.token.raw}` })
  return edits
}

function plainLiteralRoot(block: NotionBlockBoundary | undefined, type = "paragraph") {
  if (
    block?.type !== type ||
    block.has_children ||
    !block.rich_text?.length ||
    block.rich_text.some((span) => span.bold || span.code || span.link !== null)
  )
    return
  const text = block.rich_text.map((span) => span.text).join("")
  if (!text || /\r/.test(text) || (block.text !== undefined && block.text !== text)) return
  return text
}

// An inline placeholder is proved as literal rich text, including its complete
// bold spans. Only the angle escapes of the exact source line may be removed.
function literalInlineProof(text: string, allowBold: boolean) {
  if (!text || /[\r\n]/.test(text)) return
  const spans: NotionTextSpan[] = []
  let tags = 0
  const append = (text: string, bold: boolean) => {
    if (!text) return
    const previous = spans.at(-1)
    if (previous?.bold === bold)
      spans[spans.length - 1] = { ...previous, text: previous.text + text }
    else spans.push({ text, bold, code: false, link: null })
  }
  const visit = (text: string, bold: boolean): string | undefined => {
    const tokens = Lexer.lexInline(text)
    if (tokens.map((token) => token.raw).join("") !== text) return
    let escaped = ""
    for (const token of tokens) {
      if (token.type === "text" && token.raw === token.text && !/[<>\\\r\n]/.test(token.text)) {
        append(token.text, bold)
        escaped += token.raw
      } else if (
        token.type === "html" &&
        /^<[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*>$/.test(token.raw)
      ) {
        tags++
        append(token.raw, bold)
        escaped += `\\${token.raw.slice(0, -1)}\\>`
      } else if (
        allowBold &&
        !bold &&
        token.type === "strong" &&
        ["**", "__"].includes(token.raw.slice(0, 2)) &&
        token.raw === token.raw.slice(0, 2) + token.text + token.raw.slice(0, 2)
      ) {
        const content = visit(token.text, true)
        if (content === undefined) return
        escaped += token.raw.slice(0, 2) + content + token.raw.slice(0, 2)
      } else return
    }
    return escaped
  }
  const escaped = visit(text, false)
  return escaped === undefined ? undefined : { escaped, tags, spans }
}

function sameLiteralSpans(
  block: NotionBlockBoundary | undefined,
  type: string,
  spans: readonly NotionTextSpan[],
) {
  if (
    block?.type !== type ||
    block.has_children ||
    !block.rich_text?.length ||
    block.rich_text.some(
      (span) => span.code || span.link !== null || !span.text || /[\r\n]/.test(span.text),
    )
  )
    return false
  const actual: NotionTextSpan[] = []
  for (const span of block.rich_text) {
    const previous = actual.at(-1)
    if (previous?.bold === span.bold)
      actual[actual.length - 1] = { ...previous, text: previous.text + span.text }
    else actual.push({ text: span.text, bold: span.bold, code: false, link: null })
  }
  return (
    (block.text === undefined || block.text === actual.map((span) => span.text).join("")) &&
    JSON.stringify(actual) === JSON.stringify(spans)
  )
}

function inlineLiteralRootEdits(
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  for (const sourcePart of wanted) {
    const source = sourcePart.token
    if (source.type !== "paragraph" && source.type !== "heading") continue
    const proof = literalInlineProof(source.text, source.type === "paragraph")
    if (
      !proof?.tags ||
      wanted.filter(
        ({ token }) =>
          (token.type === "paragraph" || token.type === "heading") &&
          token.type === source.type &&
          token.text === source.text,
      ).length !== 1
    )
      continue
    const type = source.type === "heading" ? `heading_${source.depth}` : "paragraph"
    const roots = boundaries.flatMap((block, index) =>
      sameLiteralSpans(block, type, proof.spans) ? [index] : [],
    )
    if (roots.length !== 1) continue
    const matches = actual.flatMap<{ range: Range; edit: Edit }>((part) => {
      if (source.type === "heading") {
        const token = part.token,
          prefix = "#".repeat(source.depth) + " "
        return token.type === "heading" &&
          token.depth === source.depth &&
          token.text === proof.escaped &&
          token.raw.startsWith(prefix + proof.escaped) &&
          /^\n*$/.test(token.raw.slice(prefix.length + proof.escaped.length))
          ? [
              {
                range: part,
                edit: {
                  start: part.start + prefix.length,
                  end: part.start + prefix.length + proof.escaped.length,
                  text: source.text,
                },
              },
            ]
          : []
      }
      if (part.token.type !== "paragraph") return []
      const result: Array<{ range: Range; edit: Edit }> = []
      let offset = part.start
      for (const line of part.token.text.split("\n")) {
        if (line === proof.escaped)
          result.push({
            range: { start: offset, end: offset + line.length },
            edit: { start: offset, end: offset + line.length, text: source.text },
          })
        offset += line.length + 1
      }
      return result
    })
    if (matches.length === 1 && proves(roots[0]!, [matches[0]!.range])) edits.push(matches[0]!.edit)
  }
  return edits
}

function isolatedHtmlSource(part: Part, wanted: readonly Part[], target: string) {
  if (part.token.type !== "html") return
  const literal = part.token.raw.replace(/\n+$/, ""),
    index = wanted.indexOf(part)
  const previous = wanted[index - 1],
    next = wanted[index + 1]
  if (!literalHtmlPrecedingBoundary(part, previous, target, literal)) return
  if (
    next
      ? part.token.raw !== literal || target.slice(part.end, next.start) !== "\n\n"
      : target.slice(part.end).trim()
  )
    return
  if (
    wanted.filter(({ token }) => token.type === "html" && token.raw.replace(/\n+$/, "") === literal)
      .length !== 1
  )
    return
  return { literal, next }
}

// A single leaf list item can retain simple one-word placeholders as literal
// text. Require its entire source line, marker and physical rich-text spans;
// inline code, links, formatting and nested items cannot authorize this edit.
function literalInlineListEdits(
  markdown: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  leafListItem: (item: Tokens.ListItem) => boolean,
  originalListItemRanges: (markdown: string, part: Part) => readonly Range[] | undefined,
) {
  const edits: Edit[] = []
  for (const sourcePart of wanted) {
    const sourceList = sourcePart.token
    if (
      sourceList.type !== "list" ||
      sourceList.items.length !== 1 ||
      !leafListItem(sourceList.items[0]!)
    )
      continue
    const sourceItem = sourceList.items[0]!,
      proof = literalInlineProof(sourceItem.text, false)
    if (
      !proof?.tags ||
      wanted
        .flatMap(({ token }) => (token.type === "list" ? token.items : []))
        .filter((item) => item.text === sourceItem.text).length !== 1
    )
      continue
    const marker = /^( {0,3}(?:[-+*]|\d+[.)])[ \t]+)/.exec(sourceItem.raw)?.[0]
    if (
      !marker ||
      !sourceItem.raw.startsWith(marker + sourceItem.text) ||
      !/^\n*$/.test(sourceItem.raw.slice(marker.length + sourceItem.text.length))
    )
      continue
    const type = sourceList.ordered ? "numbered_list_item" : "bulleted_list_item"
    const roots = boundaries.flatMap((block, index) =>
      sameLiteralSpans(block, type, proof.spans) &&
      (!sourceList.ordered ||
        (block.numbered_list &&
          (block.numbered_list.start === sourceList.start ||
            (sourceList.start === 1 && block.numbered_list.start === null))))
        ? [index]
        : [],
    )
    if (roots.length !== 1) continue
    const matches = actual.flatMap((part) => {
      const list = part.token
      if (
        list.type !== "list" ||
        list.ordered !== sourceList.ordered ||
        list.start !== sourceList.start ||
        list.items.length !== 1 ||
        !leafListItem(list.items[0]!)
      )
        return []
      const item = list.items[0]!,
        ranges = originalListItemRanges(markdown, part)
      if (
        !ranges ||
        item.text !== proof.escaped ||
        !item.raw.startsWith(marker + proof.escaped) ||
        !/^\n*$/.test(item.raw.slice(marker.length + proof.escaped.length)) ||
        !proves(roots[0]!, ranges)
      )
        return []
      return [
        {
          start: part.start + marker.length,
          end: part.start + marker.length + proof.escaped.length,
          text: sourceItem.text,
        },
      ]
    })
    if (matches.length === 1) edits.push(matches[0]!)
  }
  return edits
}

function literalHtmlPrecedingBoundary(
  part: Part,
  previous: Part | undefined,
  target: string,
  literal: string,
) {
  if (!previous) return !target.slice(0, part.start).trim()
  const gap = target.slice(previous.end, part.start)
  if (gap === "\n\n") return true
  // A closing tag can end an explicit empty quote without a blank line. This
  // source shape still needs the unique empty physical quote in orderedRootProof.
  return (
    gap === "" &&
    /^<\/[A-Za-z][A-Za-z0-9-]*>$/.test(literal) &&
    previous.token.type === "blockquote" &&
    previous.token.text === "" &&
    previous.token.tokens?.length === 0 &&
    /^>[ \t]?\n$/.test(previous.token.raw)
  )
}

function literalHtmlReplacement(
  markdown: string,
  target: string,
  source: Part,
  range: Range,
  terminal: boolean,
): Edit | undefined {
  const prefix =
    markdown.slice(0, range.start).trim() &&
    markdown.slice(Math.max(0, range.start - 2), range.start) !== "\n\n"
      ? "\n"
      : ""
  if (terminal)
    return markdown.slice(range.end).trim()
      ? undefined
      : {
          start: range.start,
          end: markdown.length,
          text: prefix + source.token.raw + target.slice(source.end),
        }
  if (markdown[range.end] !== "\n") return
  return {
    ...range,
    text:
      prefix + source.token.raw + (markdown.slice(range.end, range.end + 2) === "\n\n" ? "" : "\n"),
  }
}

// A two-line HTML source block may be represented by a literal paragraph and
// an actual heading. Both complete leaf roots must precede any reconstruction.
function literalHtmlHeadingEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  for (const sourcePart of wanted) {
    const source = isolatedHtmlSource(sourcePart, wanted, target)
    if (!source) continue
    const lines = source.literal.split("\n"),
      heading = lines.length === 2 ? /^(#{1,3}) ([^\r\n]+)$/.exec(lines[1]!) : undefined
    if (!/^<[A-Za-z][A-Za-z0-9-]*>$/.test(lines[0]!) || !heading) continue
    const content = literalInlineProof(heading[2]!, false)
    if (!content || content.tags) continue
    const roots = boundaries.flatMap((block, index) =>
      plainLiteralRoot(block) === lines[0] &&
      sameLiteralSpans(boundaries[index + 1], `heading_${heading[1]!.length}`, content.spans)
        ? [index]
        : [],
    )
    if (roots.length !== 1) continue
    const escaped = `\\${lines[0]!.slice(0, -1)}\\>`
    const matches = actual.flatMap((part, index) => {
      const following = actual[index + 1]
      if (
        part.token.type !== "paragraph" ||
        !following ||
        following.token.type !== "heading" ||
        following.token.depth !== heading[1]!.length ||
        following.token.text !== heading[2] ||
        following.token.raw.replace(/\n+$/, "") !== lines[1]
      )
        return []
      const text = part.token.text
      if (text !== escaped && !text.endsWith("\n" + escaped)) return []
      const paragraph = {
        start: part.start + text.length - escaped.length,
        end: part.start + text.length,
      }
      if (
        markdown.slice(paragraph.end, following.start) !== "\n" ||
        !proves(roots[0]!, [paragraph, following])
      )
        return []
      return [{ start: paragraph.start, end: following.start + lines[1]!.length }]
    })
    if (matches.length !== 1) continue
    const edit = literalHtmlReplacement(markdown, target, sourcePart, matches[0]!, !source.next)
    if (edit) edits.push(edit)
  }
  return edits
}

// The closing literal can remain inside the single physical numbered item.
// Its newline, complete text and source number are proved together; no extra
// closing paragraph is invented to make the source wrapper fit.
function literalHtmlListEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  for (const sourcePart of wanted) {
    const source = isolatedHtmlSource(sourcePart, wanted, target)
    if (!source) continue
    const lines = source.literal.split("\n"),
      opened = lines.length === 3 ? /^<([A-Za-z][A-Za-z0-9-]*)>$/.exec(lines[0]!) : undefined
    const item = opened ? /^([1-9][0-9]{0,8})([.)]) ([^\r\n]+)$/.exec(lines[1]!) : undefined
    if (!opened || !item || lines[2] !== `</${opened[1]}>`) continue
    const content = literalInlineProof(item[3]!, false)
    if (!content || content.tags) continue
    const start = Number(item[1]),
      marker = item[1]! + item[2]! + " ",
      text = item[3] + "\n" + lines[2]
    const roots = boundaries.flatMap((block, index) => {
      const next = boundaries[index + 1]
      return plainLiteralRoot(block) === lines[0] &&
        plainLiteralRoot(next, "numbered_list_item") === text &&
        next!.numbered_list &&
        (next!.numbered_list.start === start || (start === 1 && next!.numbered_list.start === null))
        ? [index]
        : []
    })
    if (roots.length !== 1) continue
    const escapedOpen = `\\${lines[0]!.slice(0, -1)}\\>`,
      escapedClose = `\\${lines[2]!.slice(0, -1)}\\>`
    const matches = actual.flatMap((part, index) => {
      const following = actual[index + 1],
        list = following?.token
      if (
        part.token.type !== "paragraph" ||
        list?.type !== "list" ||
        !list.ordered ||
        list.start !== start ||
        list.items.length !== 1
      )
        return []
      const entry = list.items[0]!,
        paragraphText = part.token.text
      const newline = entry.text === item[3] + "\n" + escapedClose
      const breakTag = entry.text === item[3] + "<br>" + escapedClose
      if (
        entry.task ||
        entry.tokens.length !== 1 ||
        !["text", "paragraph"].includes(entry.tokens[0]!.type) ||
        (!newline && !breakTag) ||
        entry.raw !== list.raw ||
        (paragraphText !== escapedOpen && !paragraphText.endsWith("\n" + escapedOpen))
      )
        return []
      const body = entry.raw.replace(/\n+$/, "")
      // Only this physical leaf's exact retained LF may be serialized as <br>.
      // Attribute, case, slash or additional-break variants prove no boundary.
      if (
        breakTag
          ? body !== marker + item[3] + "<br>" + escapedClose
          : !["", "\t", " ".repeat(marker.length)].some(
              (indent) => body === marker + item[3] + "\n" + indent + escapedClose,
            )
      )
        return []
      const paragraph = {
        start: part.start + paragraphText.length - escapedOpen.length,
        end: part.start + paragraphText.length,
      }
      if (
        markdown.slice(paragraph.end, following!.start) !== "\n" ||
        !proves(roots[0]!, [paragraph, following!])
      )
        return []
      return [{ start: paragraph.start, end: following!.start + body.length }]
    })
    if (matches.length !== 1) continue
    const edit = literalHtmlReplacement(markdown, target, sourcePart, matches[0]!, !source.next)
    if (edit) edits.push(edit)
  }
  return edits
}

// CommonMark treats an isolated custom tag as HTML. The physical page may keep
// the exact tag as a plain paragraph and escape it in readback. Recover only
// those literal bytes and the original block boundary, with no HTML stripping.
function literalRootHtmlEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*>$/
  const escaped = (text: string) => text.replace(/[<>]/g, (character) => `\\${character}`)
  for (const [sourceIndex, sourcePart] of wanted.entries()) {
    if (sourcePart.token.type !== "html") continue
    const literal = sourcePart.token.raw.replace(/\n+$/, ""),
      lines = literal.split("\n")
    if (
      !tag.test(lines[0]!) ||
      lines.some((line) => !line || /\r/.test(line) || (/[<>]/.test(line) && !tag.test(line)))
    )
      continue
    const previous = wanted[sourceIndex - 1],
      next = wanted[sourceIndex + 1]
    if (!literalHtmlPrecedingBoundary(sourcePart, previous, target, literal)) continue
    if (
      next
        ? sourcePart.token.raw !== literal || target.slice(sourcePart.end, next.start) !== "\n\n"
        : target.slice(sourcePart.end).trim()
    )
      continue
    if (
      wanted.filter(
        ({ token }) => token.type === "html" && token.raw.replace(/\n+$/, "") === literal,
      ).length !== 1
    )
      continue
    const groups = boundaries.flatMap((block, index) => {
      const parts: string[] = []
      for (let end = index; end < boundaries.length; end++) {
        const text = plainLiteralRoot(boundaries[end])
        if (text === undefined) break
        parts.push(text)
        const joined = parts.join("\n")
        if (joined === literal) return [{ index, parts }]
        if (!literal.startsWith(joined + "\n")) break
      }
      return []
    })
    if (groups.length !== 1) continue
    const group = groups[0]!,
      readback = escaped(literal)
    const matches = actual.flatMap((part) => {
      if (part.token.type !== "paragraph") return []
      const text = part.token.text,
        matches: Range[] = []
      for (
        let offset = text.indexOf(readback);
        offset >= 0;
        offset = text.indexOf(readback, offset + 1)
      ) {
        const end = offset + readback.length
        if (
          (offset === 0 || text[offset - 1] === "\n") &&
          (end === text.length || text[end] === "\n")
        )
          matches.push({ start: part.start + offset, end: part.start + end })
      }
      return matches
    })
    if (matches.length !== 1) continue
    const match = matches[0]!,
      ranges: Range[] = []
    let offset = match.start
    for (const text of group.parts) {
      const length = escaped(text).length
      ranges.push({ start: offset, end: offset + length })
      offset += length + 1
    }
    if (ranges.at(-1)?.end !== match.end || !proves(group.index, ranges)) continue
    const prefix =
      markdown.slice(0, match.start).trim() &&
      markdown.slice(Math.max(0, match.start - 2), match.start) !== "\n\n"
        ? "\n"
        : ""
    if (!next) {
      if (markdown.slice(match.end).trim()) continue
      edits.push({
        start: match.start,
        end: markdown.length,
        text: prefix + sourcePart.token.raw + target.slice(sourcePart.end),
      })
    } else {
      if (markdown[match.end] !== "\n") continue
      const suffix = markdown.slice(match.end, match.end + 2) === "\n\n" ? "" : "\n"
      edits.push({ ...match, text: prefix + literal + suffix })
    }
  }
  return edits
}

// A single physical quote can retain inline placeholder tags literally. Match
// the complete source sentence and every escape before changing any angle byte.
function quotedLiteralEdits(
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
) {
  const edits: Edit[] = []
  const paragraph = (part: Part) => {
    const children =
      part.token.type === "blockquote"
        ? part.token.tokens?.filter((token) => token.type !== "space")
        : undefined
    const child = children?.length === 1 ? children[0] : undefined
    return child?.type === "paragraph" &&
      !/[\r\n]/.test(child.text) &&
      /^> [^\r\n]+\n*$/.test(part.token.raw)
      ? child
      : undefined
  }
  for (const sourcePart of wanted) {
    const source = paragraph(sourcePart)
    if (!source) continue
    const tokens = source.tokens ?? Lexer.lexInline(source.text)
    if (
      tokens.map((token) => token.raw).join("") !== source.text ||
      !tokens.some((token) => token.type === "html") ||
      tokens.some(
        (token) =>
          token.type !== "text" &&
          !(
            token.type === "html" &&
            /^<[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z][A-Za-z0-9-]*)*>$/.test(token.raw)
          ),
      )
    )
      continue
    const escaped = tokens
      .map((token) => (token.type === "html" ? `\\${token.raw.slice(0, -1)}\\>` : token.raw))
      .join("")
    if (wanted.filter((part) => paragraph(part)?.text === source.text).length !== 1) continue
    const roots = boundaries.flatMap((block, index) =>
      plainLiteralRoot(block, "quote") === source.text ? [index] : [],
    )
    const matches = actual.filter((part) => paragraph(part)?.text === escaped)
    if (roots.length !== 1 || matches.length !== 1 || !proves(roots[0]!, [matches[0]!])) continue
    const part = matches[0]!
    if (!part.token.raw.startsWith("> " + escaped)) continue
    edits.push({ start: part.start + 2, end: part.start + 2 + escaped.length, text: source.text })
  }
  return edits
}

// A word-local placeholder can be escaped when two original paragraphs are
// serialized as one. The complete original pair and its unmodified ranges must
// prove the literal; an arbitrary HTML token provides no such evidence.
function inlinePlaceholderEdits(
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  retainedInline: (block: NotionBlockBoundary) => unknown[] | undefined,
  inline: Inline,
  inlineText: InlineText,
) {
  const edits: Edit[] = []
  const signature = (text: string) => JSON.stringify(inline(text, undefined, true))
  const htmlCount = (tokens: readonly Token[]): number =>
    tokens.reduce(
      (count, token) =>
        count +
        (token.type === "html"
          ? 1
          : token.type === "strong" || token.type === "em"
            ? htmlCount(token.tokens ?? [])
            : 0),
      0,
    )
  const plainParagraph = (block: NotionBlockBoundary | undefined) => {
    if (
      block?.type !== "paragraph" ||
      block.has_children ||
      !block.rich_text?.length ||
      block.rich_text.some((span) => span.code || span.link !== null)
    )
      return
    const text = block.rich_text.map((span) => span.text).join("")
    if (!text.trim() || /[\r\n]/.test(text)) return
    return retainedInline(block)
  }
  for (const [sourceIndex, sourcePart] of wanted.entries()) {
    const source = sourcePart.token
    if (source.type !== "paragraph") continue
    const tokens = Lexer.lexInline(source.text)
    if (tokens.map((token) => token.raw).join("") !== source.text || htmlCount(tokens) !== 1)
      continue
    let sourceOffset = 0
    const tags = tokens.flatMap<{ tag: string; bold?: { prefix: string; text: string } }>(
      (token) => {
        const start = sourceOffset
        sourceOffset += token.raw.length
        if (
          token.type === "html" &&
          /[A-Za-z0-9]+-$/.test(source.text.slice(0, start)) &&
          /^[ \t\n]/.test(source.text.slice(sourceOffset))
        )
          return [{ tag: token.raw }]
        if (
          token.type !== "strong" ||
          token.tokens?.length !== 2 ||
          !["**", "__"].includes(token.raw.slice(0, 2)) ||
          token.raw !== token.raw.slice(0, 2) + token.text + token.raw.slice(0, 2) ||
          !/^[ \t\n]/.test(source.text.slice(sourceOffset))
        )
          return []
        const [prefix, tag] = token.tokens
        if (
          prefix?.type !== "text" ||
          prefix.raw !== prefix.text ||
          !/^[A-Za-z][A-Za-z0-9_-]*-$/.test(prefix.text) ||
          tag?.type !== "html" ||
          token.text !== prefix.text + tag.raw
        )
          return []
        return [{ tag: tag.raw, bold: { prefix: prefix.text, text: token.text } }]
      },
    )
    if (tags.length !== 1) continue
    const descriptor = tags[0]!,
      tag = descriptor.tag,
      match = /^<([A-Za-z][A-Za-z0-9]*)>$/.exec(tag)
    if (!match || new RegExp(`</[ \\t\\r\\n]*${match[1]}(?:[ \\t\\r\\n/>]|$)`, "i").test(target))
      continue
    const sourceInline = inline(source.text, tokens, true)
    if (
      sourceInline.filter(
        (value) => Array.isArray(value) && value[0] === "html" && value[1] === tag,
      ).length !== 1 ||
      sourceInline.some(
        (value) =>
          typeof value !== "string" &&
          !(Array.isArray(value) && value[0] === "html" && value[1] === tag),
      )
    )
      continue
    const literalInline = inlineText(
      sourceInline.map((value) => (Array.isArray(value) ? tag : value)),
    )
    const sourceProofs: { literal: string; first?: string; second?: string }[] = [
      { literal: JSON.stringify(literalInline) },
    ]
    const nextSource = wanted[sourceIndex + 1]
    if (
      descriptor.bold &&
      nextSource?.token.type === "paragraph" &&
      target.slice(sourcePart.end, nextSource.start) === "\n\n"
    ) {
      const nextInline = inline(nextSource.token.text, nextSource.token.tokens, true)
      if (
        nextInline.length &&
        nextInline.every((value) => typeof value === "string") &&
        nextInline.some((value) => typeof value === "string" && value.trim())
      )
        sourceProofs.push({
          literal: JSON.stringify(inlineText([...literalInline, " ", ...nextInline])),
          first: JSON.stringify(literalInline),
          second: JSON.stringify(nextInline),
        })
    }
    if (
      wanted.filter(
        ({ token }) =>
          token.type === "paragraph" && signature(token.text) === JSON.stringify(sourceInline),
      ).length !== 1
    )
      continue
    for (const sourceProof of sourceProofs) {
      const literal = sourceProof.literal
      const roots = boundaries.flatMap((block, index) => {
        const first = plainParagraph(block),
          second = plainParagraph(boundaries[index + 1])
        if (
          sourceProof.first !== undefined &&
          (JSON.stringify(first) !== sourceProof.first ||
            JSON.stringify(second) !== sourceProof.second)
        )
          return []
        if (
          descriptor.bold &&
          boundaries
            .slice(index, index + 2)
            .flatMap((root) => root.rich_text ?? [])
            .filter((span) => span.bold && span.text === descriptor.bold!.text).length !== 1
        )
          return []
        return first && second && JSON.stringify(inlineText([...first, " ", ...second])) === literal
          ? [{ index, first: JSON.stringify(first), second: JSON.stringify(second) }]
          : []
      })
      const parts = actual.filter(
        ({ token }) => token.type === "paragraph" && signature(token.text) === literal,
      )
      if (roots.length !== 1 || parts.length !== 1) continue
      const root = roots[0]!,
        part = parts[0]!
      if (part.token.type !== "paragraph") continue
      const text = part.token.text,
        escaped = `\\${tag.slice(0, -1)}\\>`
      const offset = text.indexOf(escaped)
      if (offset < 0 || text.indexOf(escaped, offset + escaped.length) >= 0) continue
      if (descriptor.bold) {
        let actualOffset = 0
        const wrappers = Lexer.lexInline(text).flatMap((token) => {
          const start = actualOffset
          actualOffset += token.raw.length
          return token.type === "strong" &&
            token.text === descriptor.bold!.prefix + escaped &&
            ["**", "__"].includes(token.raw.slice(0, 2)) &&
            token.raw === token.raw.slice(0, 2) + token.text + token.raw.slice(0, 2)
            ? [start + 2 + descriptor.bold!.prefix.length]
            : []
        })
        if (wrappers.length !== 1 || wrappers[0] !== offset) continue
      }
      const splits = [...text.matchAll(/\n/g)].flatMap((match) => {
        const split = match.index
        return signature(text.slice(0, split)) === root.first &&
          signature(text.slice(split + 1)) === root.second
          ? [split]
          : []
      })
      if (splits.length !== 1) continue
      const split = splits[0]!
      if (
        !proves(root.index, [
          { start: part.start, end: part.start + split },
          { start: part.start + split + 1, end: part.start + text.length },
        ])
      )
        continue
      edits.push({
        start: part.start + offset,
        end: part.start + offset + escaped.length,
        text: tag,
      })
    }
  }
  return edits
}

export function literalHtmlReadbackEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  retainedInline: (block: NotionBlockBoundary) => unknown[] | undefined,
  leafListItem: (item: Tokens.ListItem) => boolean,
  originalListItemRanges: (markdown: string, part: Part) => readonly Range[] | undefined,
  inline: Inline,
  inlineText: InlineText,
) {
  const deps = [retainedInline, leafListItem, originalListItemRanges, inline] as const
  return [
    ...literalAngleEdits(markdown, target, actual, wanted, boundaries, proves, ...deps),
    ...inlinePlaceholderEdits(
      target,
      actual,
      wanted,
      boundaries,
      proves,
      retainedInline,
      inline,
      inlineText,
    ),
  ]
}
export function literalHtmlBoundaryEdits(
  markdown: string,
  target: string,
  actual: readonly Part[],
  wanted: readonly Part[],
  boundaries: readonly NotionBlockBoundary[],
  proves: Proves,
  leafListItem: (item: Tokens.ListItem) => boolean,
  originalListItemRanges: (markdown: string, part: Part) => readonly Range[] | undefined,
) {
  return [
    ...literalRootHtmlEdits(markdown, target, actual, wanted, boundaries, proves),
    ...quotedLiteralEdits(actual, wanted, boundaries, proves),
    ...inlineLiteralRootEdits(actual, wanted, boundaries, proves),
    ...literalInlineListEdits(
      markdown,
      actual,
      wanted,
      boundaries,
      proves,
      leafListItem,
      originalListItemRanges,
    ),
    ...literalHtmlHeadingEdits(markdown, target, actual, wanted, boundaries, proves),
    ...literalHtmlListEdits(markdown, target, actual, wanted, boundaries, proves),
  ]
}
