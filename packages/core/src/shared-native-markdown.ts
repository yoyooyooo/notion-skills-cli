import { SourceLexer } from "@notion-skills-cli/markdown"
import { fail, property } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

type Style = {
  readonly bold: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly underline: boolean
}
type Link = { readonly href: string; readonly title: string | null }
type Inline =
  | {
      readonly kind: "text"
      readonly text: string
      readonly code: boolean
      readonly style: Style
      readonly link: Link | null
    }
  | { readonly kind: "break"; readonly style: Style; readonly link: Link | null }
  | {
      readonly kind: "image"
      readonly source: Link
      readonly alt: string
      readonly link: Link | null
    }
type Block =
  | { readonly kind: "paragraph"; readonly content: readonly Inline[] }
  | { readonly kind: "heading"; readonly depth: number; readonly content: readonly Inline[] }
  | { readonly kind: "code"; readonly language: string; readonly text: string }
  | { readonly kind: "quote"; readonly blocks: readonly Block[] }
  | { readonly kind: "rule" }
  | {
      readonly kind: "list"
      readonly start: number | null
      readonly items: readonly {
        readonly checked: boolean | null
        readonly blocks: readonly Block[]
      }[]
    }
  | {
      readonly kind: "table"
      readonly align: readonly ("left" | "right" | "center" | null)[]
      readonly header: readonly (readonly Inline[])[]
      readonly rows: readonly (readonly (readonly Inline[])[])[]
    }
type Context = { count: number; readonly destinations: Map<string, Link> }
const plain: Style = { bold: false, italic: false, strike: false, underline: false }
const invalid = (reason: string) =>
  fail(
    "CURRENT_NATIVE_MARKDOWN_UNSUPPORTED",
    "Native authoring requires a completely understood Markdown structure. Keep unsupported content unchanged or select an exact resource.",
    { reason },
  )
function string(value: unknown): string {
  if (typeof value !== "string") throw invalid("invalid_text")
  return value
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid("invalid_children")
  return value
}
function step(context: Context, depth: number): void {
  if (++context.count > 30000 || depth > 64) throw invalid("structure_limit")
}

/** Input bytes remain in the frozen write plan. Only the transport changes CRLF. */
export function nativeMarkdownTransport(markdown: string): string {
  if (
    typeof markdown !== "string" ||
    /\r(?!\n)/u.test(markdown) ||
    markdown.charCodeAt(0) === 0xfeff ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(markdown)
  )
    throw fail(
      "CURRENT_WRITE_INPUT_INVALID",
      "Native authoring requires UTF-8 text with LF or CRLF, without a body BOM, bare CR or control characters.",
      { reason: "invalid_text_encoding" },
    )
  return markdown.replace(/\r\n/g, "\n")
}

function entities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (raw: string, entity: string) => {
    if (entity.startsWith("#")) {
      const value = /^#x/iu.test(entity)
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)
      )
        throw invalid("invalid_character_reference")
      return String.fromCodePoint(value)
    }
    switch (entity) {
      case "amp":
        return "&"
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "quot":
        return '"'
      case "apos":
        return "'"
      case "nbsp":
        return "\u00a0"
      default:
        throw invalid(`unsupported_character_reference:${raw}`)
    }
  })
}
function destination(href: unknown, title: unknown, context: Context, literal = false): Link {
  let url = literal ? string(href) : entities(string(href))
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.href
  } catch {
    /* A relative target remains exact. */
  }
  const result = {
    href: url,
    title: title == null || title === "" ? null : entities(string(title)),
  }
  context.destinations.set(canonicalSharedJson(result), result)
  return result
}
function language(value: unknown): string {
  const name = value === undefined ? "" : string(value).toLowerCase()
  if (name && !/^[\w+#.-]+(?: [\w+#.-]+)*$/u.test(name)) throw invalid("code_language")
  switch (name) {
    case "text":
    case "txt":
    case "plaintext":
    case "plain text":
      return ""
    case "js":
      return "javascript"
    case "ts":
      return "typescript"
    case "py":
      return "python"
    case "rb":
      return "ruby"
    case "md":
      return "markdown"
    case "yml":
      return "yaml"
    case "cpp":
      return "c++"
    case "csharp":
      return "c#"
    default:
      return name
  }
}

function inline(
  input: readonly unknown[],
  context: Context,
  depth: number,
  initial = plain,
  link: Link | null = null,
  literal = false,
): readonly Inline[] {
  const result: Inline[] = []
  let style = initial
  const tags: { tag: string; before: Style }[] = []
  const add = (value: Inline) => {
    if (value.kind === "text" && value.text === "") return
    const previous = result.at(-1)
    if (
      previous?.kind === "text" &&
      value.kind === "text" &&
      previous.code === value.code &&
      canonicalSharedJson(previous.style) === canonicalSharedJson(value.style) &&
      canonicalSharedJson(previous.link) === canonicalSharedJson(value.link)
    )
      result[result.length - 1] = { ...previous, text: previous.text + value.text }
    else result.push(value)
  }
  for (const raw of input) {
    step(context, depth)
    const token = property(raw),
      type = string(token.type)
    if (type === "strong" || type === "em" || type === "del") {
      const next =
        type === "strong"
          ? { ...style, bold: true }
          : type === "em"
            ? { ...style, italic: true }
            : { ...style, strike: true }
      for (const child of inline(array(token.tokens), context, depth + 1, next, link, literal))
        add(child)
    } else if (type === "link") {
      if (link !== null) throw invalid("nested_link")
      const selected = destination(token.href, token.title, context, token.autolink === true)
      for (const child of inline(
        array(token.tokens),
        context,
        depth + 1,
        style,
        selected,
        token.autolink === true,
      ))
        add(child)
    } else if (type === "image") {
      add({
        kind: "image",
        source: destination(token.href, token.title, context),
        alt: entities(string(token.text)),
        link,
      })
    } else if (type === "codespan") {
      add({ kind: "text", text: string(token.text), code: true, style, link })
    } else if (type === "br") add({ kind: "break", style, link })
    else if (type === "text" || type === "escape") {
      if (token.tokens !== undefined) {
        for (const child of inline(array(token.tokens), context, depth + 1, style, link, literal))
          add(child)
      } else
        add({
          kind: "text",
          text: (type === "escape" || literal
            ? string(token.text)
            : entities(string(token.text))
          ).replace(/\n/g, " "),
          code: false,
          style,
          link,
        })
    } else if (type === "html") {
      const value = string(token.raw)
      if (/^<br\s*\/?\s*>$/iu.test(value)) add({ kind: "break", style, link })
      else {
        const tag = /^<(\/)?(b|i|s|u)>$/u.exec(value)
        if (tag === null) throw invalid("unsupported_inline_tag")
        if (tag[1] === "/") {
          const previous = tags.pop()
          if (previous === undefined || previous.tag !== tag[2])
            throw invalid("unbalanced_inline_tag")
          style = previous.before
        } else {
          const name = tag[2]!
          tags.push({ tag: name, before: style })
          style =
            name === "b"
              ? { ...style, bold: true }
              : name === "i"
                ? { ...style, italic: true }
                : name === "s"
                  ? { ...style, strike: true }
                  : { ...style, underline: true }
        }
      }
    } else throw invalid(`unsupported_inline:${type}`)
  }
  if (tags.length !== 0) throw invalid("unbalanced_inline_tag")
  return result
}

function blocks(input: readonly unknown[], context: Context, depth: number): readonly Block[] {
  const result: Block[] = []
  for (const raw of input) {
    step(context, depth)
    const token = property(raw),
      type = string(token.type)
    if (type === "space") continue
    if (type === "def") {
      // Used reference definitions are equivalent to inline links. An unused
      // destination cannot disappear unnoticed from the complete document.
      destination(token.href, token.title, context)
    } else if (type === "paragraph" || type === "text") {
      const content = inline(
        token.tokens === undefined
          ? SourceLexer.lexInline(string(token.text))
          : array(token.tokens),
        context,
        depth + 1,
      )
      if (
        content.some((part) => part.kind === "image") &&
        (content.length !== 1 || content[0]?.kind !== "image")
      )
        throw invalid("inline_image_requires_own_block")
      result.push({ kind: "paragraph", content })
    } else if (type === "heading") {
      if (
        typeof token.depth !== "number" ||
        !Number.isInteger(token.depth) ||
        token.depth < 1 ||
        token.depth > 4
      )
        throw invalid("heading_depth")
      result.push({
        kind: "heading",
        depth: token.depth,
        content: inline(array(token.tokens), context, depth + 1),
      })
    } else if (type === "code") {
      if (token.codeBlockStyle === "indented") throw invalid("indented_code_requires_fence")
      result.push({ kind: "code", language: language(token.lang), text: string(token.text) })
    } else if (type === "blockquote")
      result.push({ kind: "quote", blocks: blocks(array(token.tokens), context, depth + 1) })
    else if (type === "hr") result.push({ kind: "rule" })
    else if (type === "list") {
      if (
        typeof token.ordered !== "boolean" ||
        (token.ordered && (typeof token.start !== "number" || !Number.isSafeInteger(token.start)))
      )
        throw invalid("invalid_list")
      const start = token.ordered && typeof token.start === "number" ? token.start : null
      const items = array(token.items).map((raw) => {
        const item = property(raw)
        if (typeof item.task !== "boolean" || (item.task && typeof item.checked !== "boolean"))
          throw invalid("invalid_list_item")
        const children = array(item.tokens)
        if (
          item.task &&
          (property(children[0]).type !== "checkbox" ||
            property(children[0]).checked !== item.checked)
        )
          throw invalid("invalid_task_marker")
        return {
          checked: item.task && typeof item.checked === "boolean" ? item.checked : null,
          blocks: blocks(item.task ? children.slice(1) : children, context, depth + 1),
        }
      })
      result.push({ kind: "list", start, items })
    } else if (type === "table") {
      const align = array(token.align).map((value) => {
        if (value !== null && value !== "left" && value !== "right" && value !== "center")
          throw invalid("table_alignment")
        return value
      })
      const cells = (row: unknown) => {
        const values = array(row)
        if (values.length !== align.length) throw invalid("table_shape")
        return values.map((cell) => inline(array(property(cell).tokens), context, depth + 1))
      }
      result.push({
        kind: "table",
        align,
        header: cells(token.header),
        rows: array(token.rows).map(cells),
      })
    } else if (type === "html" && /^<p\s*\/>\s*$/u.test(string(token.raw)))
      result.push({ kind: "paragraph", content: [] })
    else throw invalid(`unsupported_block:${type}`)
  }
  return result
}
function signature(markdown: string): string {
  const context: Context = { count: 0, destinations: new Map() }
  const document = blocks(SourceLexer.lex(nativeMarkdownTransport(markdown)), context, 0)
  return canonicalSharedJson({
    blocks: document,
    destinations: [...context.destinations]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value),
  })
}

/** Reject unsupported syntax before allocating a remote operation. */
export function validateNativeMarkdown(markdown: string): void {
  signature(markdown)
}

/** Structural equivalence preserves text, formatting, links, nesting and code.
 * It does not treat a text-only rendering or partial body as a successful write. */
export function compareNativeMarkdown(input: {
  readonly expected: string
  readonly observed: string
}): "exact" | "normalized" | "different" {
  const expected = signature(input.expected)
  try {
    if (expected !== signature(input.observed)) return "different"
  } catch {
    return "different"
  }
  return input.expected === input.observed ? "exact" : "normalized"
}
