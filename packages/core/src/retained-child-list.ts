import { fromNotionMarkdown, SourceLexer } from "@notion-skills-cli/markdown"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function identifier(value: unknown) {
  return typeof value === "string" &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : undefined
}
interface Span {
  readonly text: string
  readonly code: boolean
  readonly link: string | null
}
function append(spans: Span[], span: Span) {
  if (!span.text) return
  const previous = spans.at(-1)
  if (!span.code && previous && !previous.code && previous.link === span.link)
    spans[spans.length - 1] = { ...span, text: previous.text + span.text }
  else spans.push(span)
}

function physicalLeaf(root: unknown): readonly Span[] | undefined {
  if (
    !record(root) ||
    root.type !== "bulleted_list_item" ||
    root.has_children !== false ||
    !record(root.bulleted_list_item)
  )
    return
  const body = root.bulleted_list_item
  if (
    Object.keys(body).some((key) => !["rich_text", "color"].includes(key)) ||
    body.color !== "default" ||
    !Array.isArray(body.rich_text) ||
    !body.rich_text.length
  )
    return
  const spans: Span[] = []
  for (const raw of body.rich_text) {
    if (
      !record(raw) ||
      raw.type !== "text" ||
      !record(raw.text) ||
      !record(raw.annotations) ||
      Object.keys(raw).some(
        (key) => !["type", "text", "annotations", "plain_text", "href"].includes(key),
      ) ||
      Object.keys(raw.text).some((key) => !["content", "link"].includes(key)) ||
      Object.keys(raw.annotations).some(
        (key) => !["bold", "italic", "strikethrough", "underline", "code", "color"].includes(key),
      ) ||
      typeof raw.text.content !== "string" ||
      /[\r\n]/.test(raw.text.content) ||
      (raw.plain_text !== undefined && raw.plain_text !== raw.text.content) ||
      raw.annotations.color !== "default" ||
      typeof raw.annotations.code !== "boolean"
    )
      return
    const annotations = raw.annotations
    if (["bold", "italic", "strikethrough", "underline"].some((key) => annotations[key] !== false))
      return
    let link: string | null = null
    if (raw.text.link !== null && raw.text.link !== undefined) {
      if (
        !record(raw.text.link) ||
        Object.keys(raw.text.link).some((key) => key !== "url") ||
        typeof raw.text.link.url !== "string"
      )
        return
      link = raw.text.link.url
    }
    if (raw.href !== undefined && raw.href !== link) return
    append(spans, { text: raw.text.content, code: raw.annotations.code, link })
  }
  return spans.length ? spans : undefined
}

function sourceInline(values: unknown, link: string | null = null): readonly Span[] | undefined {
  if (!Array.isArray(values)) return
  const spans: Span[] = []
  for (const token of values) {
    if (!record(token)) return
    if (token.type === "link") {
      if (
        link !== null ||
        typeof token.href !== "string" ||
        token.title !== null ||
        typeof token.raw !== "string" ||
        !token.raw.startsWith("[") ||
        !token.raw.endsWith(")")
      )
        return
      const children = sourceInline(token.tokens, token.href)
      if (!children?.length) return
      for (const child of children) append(spans, child)
    } else {
      if (
        !["text", "codespan"].includes(String(token.type)) ||
        typeof token.text !== "string" ||
        /[\r\n]/.test(token.text) ||
        (token.type === "text" && token.raw !== token.text)
      )
        return
      append(spans, { text: token.text, code: token.type === "codespan", link })
    }
  }
  return spans
}

const pageTag =
  /^<page url="https:\/\/(?:app\.notion\.com\/p\/|(?:www\.)?notion\.so\/)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})">([^<>\n]*)<\/page>$/i

/** Prove one complete flat list and its separate retained child-page suffix.
 * Marked 18 can otherwise attach that suffix to the last inline link with a
 * different whitespace token. Only this physical root boundary becomes explicit;
 * every list span, destination, tag, child ID, title and order remains intact. */
export function retainedChildListComparison(
  pageId: string,
  markdown: string,
  roots: readonly unknown[],
): string | undefined {
  const owner = identifier(pageId)
  if (!owner || !roots.length || roots.length > 4096) return
  const children = roots.filter((root) => record(root) && root.type === "child_page")
  if (!children.length || children.length >= roots.length) return
  const ids = new Set<string>()
  for (const root of roots) {
    if (!record(root) || root.object !== "block") return
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
  const childStart = roots.length - children.length
  if (roots.slice(childStart).some((root, index) => root !== children[index])) return
  let listStart = childStart
  while (listStart > 0) {
    const previous = roots[listStart - 1]
    if (!record(previous) || previous.type !== "bulleted_list_item") break
    listStart--
  }
  const physical = roots.slice(listStart, childStart).map(physicalLeaf)
  if (!physical.length || physical.some((item) => item === undefined)) return

  const text = markdown.replace(/\r\n/g, "\n"),
    lines = text.split("\n")
  let end = lines.length
  while (end > 0 && lines[end - 1] === "") end--
  let start = end
  while (start > 0 && pageTag.test(lines[start - 1]!)) start--
  if (end - start !== children.length) return
  for (const [index, line] of lines.slice(start, end).entries()) {
    const match = pageTag.exec(line),
      child = children[index]
    if (
      !match ||
      !record(child) ||
      identifier(match[1]) !== identifier(child.id) ||
      typeof child.has_children !== "boolean" ||
      !record(child.child_page) ||
      Object.keys(child.child_page).some((key) => key !== "title") ||
      match[2] !== child.child_page.title
    )
      return
  }
  const offset = lines.slice(0, start).reduce((length, line) => length + line.length + 1, 0)
  // Readback HTML tables need the existing Notion conversion before lexing the
  // authored prefix. The return value still keeps every original Markdown byte
  // except the explicit root separator, and every final list span must match.
  const authored = text.slice(0, offset)
  const last = SourceLexer.lex(fromNotionMarkdown(authored))
    .filter((token) => token.type !== "space")
    .at(-1)
  if (
    !record(last) ||
    last.type !== "list" ||
    last.ordered !== false ||
    last.loose !== false ||
    !Array.isArray(last.items) ||
    last.items.length !== physical.length
  )
    return
  for (const [index, item] of last.items.entries()) {
    if (
      !record(item) ||
      item.type !== "list_item" ||
      item.task !== false ||
      item.loose !== false ||
      !Array.isArray(item.tokens) ||
      item.tokens.length !== 1
    )
      return
    const token = item.tokens[0]
    if (
      !record(token) ||
      token.type !== "text" ||
      typeof token.text !== "string" ||
      /[\r\n]/.test(token.text)
    )
      return
    const source = sourceInline(token.tokens)
    if (!source || JSON.stringify(source) !== JSON.stringify(physical[index])) return
  }
  return `${authored}${authored.endsWith("\n\n") ? "" : "\n"}${text.slice(offset)}`
}
