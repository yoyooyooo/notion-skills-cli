import { SourceLexer } from "@notion-skills-cli/markdown"
import type { Token, Tokens } from "marked"
import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"

export type SharedNotionMarkdownPurpose = "body_write" | "data_source_create"
type Projected = { readonly wire: string; readonly markdown: string }
type Style = "b" | "i" | "s" | "code"
type Segment = { text: string; readonly styles: readonly Style[] }
type SerializationPolicy = 2 | 4 | 5

function unsupported(): never {
  throw fail(
    "SHARED_MARKDOWN_PROJECTION_UNSUPPORTED",
    "This Markdown cannot be projected completely by the selected native authoring policy. The complete input is retained by the caller; no write was dispatched.",
  )
}

const unchanged = (raw: string): Projected => ({ wire: raw, markdown: raw })
const styleOrder: readonly Style[] = ["b", "i", "s", "code"]

/** v2 serializes each rich-text segment separately, including its full style
 * stack. In particular, bold + code is one segment between two bold segments. */
function inlineSegments(
  tokens: readonly Token[],
  styles: readonly Style[] = [],
  policy: SerializationPolicy = 2,
): Segment[] {
  const segments: Segment[] = []
  const append = (text: string, selected: readonly Style[]) => {
    const previous = segments.at(-1)
    if (previous !== undefined && previous.styles.join() === selected.join()) previous.text += text
    else segments.push({ text, styles: selected })
  }
  for (const token of tokens) {
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      if (!Array.isArray(token.tokens)) return unsupported()
      const style = token.type === "strong" ? "b" : token.type === "em" ? "i" : "s"
      const selected = styleOrder.filter((value) => styles.includes(value) || value === style)
      for (const segment of inlineSegments(token.tokens, selected, policy))
        append(segment.text, segment.styles)
    } else if (token.type === "codespan") {
      if (typeof token.text !== "string") return unsupported()
      // The native serializer leaves <, >, &, and backticks literal inside code.
      append(
        token.text,
        styleOrder.filter((value) => styles.includes(value) || value === "code"),
      )
    } else if (policy >= 4 && token.type === "link" && token.autolink !== true) {
      if (typeof token.text !== "string" || !Array.isArray(token.tokens)) return unsupported()
      const label = inline(token.text, token.tokens, policy)
      if (label === token.text) append(token.raw, styles)
      else {
        const original = "[" + token.text + "]"
        // Only the visible inline label changes. Keep the exact destination,
        // escaping and optional title from the parsed source span.
        if (styles.length !== 0 || !token.raw.startsWith(original + "(")) return unsupported()
        append("[" + label + "]" + token.raw.slice(original.length), styles)
      }
    } else {
      // Existing Notion XML and link destinations stay byte-for-byte. Do not
      // reinterpret arbitrary HTML as Markdown or split a link's destination.
      if (token.type === "html" && styles.length !== 0) return unsupported()
      append(token.raw, styles)
    }
  }
  return segments
}

function inline(
  raw: string,
  tokens: readonly Token[] = SourceLexer.lexInline(raw),
  policy: SerializationPolicy = 2,
): string {
  const parts = splitNativeInlineCode(raw)
  if (parts === undefined) return unsupported()
  if (parts.some((part) => part.code))
    return parts
      .map((part) => (part.code ? part.raw : inline(part.raw, undefined, policy)))
      .join("")
  if (tokens.map((token) => token.raw).join("") !== raw) return unsupported()
  return inlineSegments(tokens, [], policy)
    .map((segment) =>
      segment.styles.reduceRight((text, style) => `<${style}>${text}</${style}>`, segment.text),
    )
    .join("")
}

function replaceSpan(raw: string, text: string, projected: Projected): Projected {
  const at = raw.indexOf(text)
  if (at < 0) return unsupported()
  const replace = (value: string) => raw.slice(0, at) + value + raw.slice(at + text.length)
  return { wire: replace(projected.wire), markdown: replace(projected.markdown) }
}

/** Reapply only parser-recognized quote/list prefixes. Every source line and
 * its content must match; an unsupported nested shape cannot lose text. */
function decorated(
  raw: string,
  text: string,
  projected: Projected,
  kind: "quote" | "item",
): Projected {
  const source = raw.split("\n"),
    content = text.split("\n")
  const wire = projected.wire.split("\n"),
    markdown = projected.markdown.split("\n")
  if (
    wire.length !== content.length ||
    markdown.length !== content.length ||
    source.length < content.length
  )
    return unsupported()
  for (let index = 0; index < content.length; index++) {
    const line = source[index]!,
      value = content[index]!
    if (!line.endsWith(value)) return unsupported()
    const prefix = line.slice(0, line.length - value.length)
    const valid =
      kind === "quote"
        ? /^(?: {0,3}> ?)?$/u.test(prefix)
        : index === 0
          ? /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/u.test(prefix)
          : /^[ \t]*$/u.test(prefix)
    if (!valid) return unsupported()
    wire[index] = prefix + wire[index]!
    markdown[index] = prefix + markdown[index]!
  }
  const remainder = source.slice(content.length)
  if (remainder.some((line) => line !== "")) return unsupported()
  return {
    wire: [...wire, ...remainder].join("\n"),
    markdown: [...markdown, ...remainder].join("\n"),
  }
}

function embedded(
  raw: string,
  children: readonly Token[],
  purpose: SharedNotionMarkdownPurpose,
  policy: SerializationPolicy,
): Projected {
  let cursor = 0,
    wire = "",
    markdown = ""
  for (const child of children) {
    const at = raw.indexOf(child.raw, cursor)
    if (at < 0) return unsupported()
    const projected = block(child, purpose, policy)
    wire += raw.slice(cursor, at) + projected.wire
    markdown += raw.slice(cursor, at) + projected.markdown
    cursor = at + child.raw.length
  }
  return { wire: wire + raw.slice(cursor), markdown: markdown + raw.slice(cursor) }
}

function table(
  raw: string,
  header: readonly Tokens.TableCell[],
  rows: readonly (readonly Tokens.TableCell[])[],
  policy: SerializationPolicy,
): Projected {
  const lines = raw.split("\n")
  const cells = [header, ...rows]
  if (policy >= 4) {
    // Native table alignment has not been established by the retained
    // observation. Reject it rather than silently erase its semantics.
    if (cells.some((row) => row.length !== header.length || row.some((cell) => cell.align != null)))
      return unsupported()
    const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")
    const separator = "[ \\t]*\\|[ \\t]*"
    const exactLine = (parts: readonly string[]) =>
      new RegExp("^[ \\t]*\\|?[ \\t]*" + parts.join(separator) + "[ \\t]*\\|?[ \\t]*$", "u")
    if (!exactLine(header.map(() => "-+")).test(lines[1] ?? "")) return unsupported()
    const rendered: string[] = []
    for (let row = 0; row < cells.length; row++) {
      const current = cells[row]!
      if (
        !exactLine(current.map((cell) => escape(cell.text))).test(
          lines[row === 0 ? 0 : row + 1] ?? "",
        )
      )
        return unsupported()
      rendered.push(
        "| " + current.map((cell) => inline(cell.text, cell.tokens, policy)).join(" | ") + " |",
      )
      if (row === 0) rendered.push("| " + header.map(() => "---").join(" | ") + " |")
    }
    const suffix = /\n*$/u.exec(raw)?.[0] ?? ""
    return { wire: raw, markdown: rendered.join("\n") + suffix }
  }
  for (let row = 0; row < cells.length; row++) {
    const at = row === 0 ? 0 : row + 1
    const line = lines[at]
    if (line === undefined) return unsupported()
    let cursor = 0,
      output = ""
    for (const cell of cells[row]!) {
      const found = line.indexOf(cell.text, cursor)
      if (found < 0) return unsupported()
      output += line.slice(cursor, found) + inline(cell.text, cell.tokens)
      cursor = found + cell.text.length
    }
    lines[at] = output + line.slice(cursor)
  }
  return { wire: raw, markdown: lines.join("\n") }
}

function code(token: Tokens.Code): Projected {
  // Notion guesses a language when none is declared. Freeze an explicit plain
  // text request instead; real v2 readback serializes these aliases as `txt`.
  if (token.codeBlockStyle === "indented") return unsupported()
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n/u.exec(token.raw)
  if (opening === null) return unsupported()
  const language = (token.lang ?? "").trim()
  const plain = ["", "text", "txt", "plaintext", "plain text"].includes(language)
  const wireLanguage = plain ? "text" : language === "js" ? "javascript" : language
  const observedLanguages: Readonly<Record<string, string>> = {
    sh: "bash",
    python: "py",
    typescript: "ts",
  }
  const readLanguage = plain ? "txt" : (observedLanguages[wireLanguage] ?? wireLanguage)
  if (/\s/u.test(wireLanguage)) return unsupported()
  const runs = token.text.match(/`+/gu) ?? []
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  const suffix = /\n*$/u.exec(token.raw)?.[0] ?? ""
  const render = (label: string) => `${fence}${label}\n${token.text}\n${fence}${suffix}`
  return { wire: render(wireLanguage), markdown: render(readLanguage) }
}

function block(
  token: Token,
  purpose: SharedNotionMarkdownPurpose,
  policy: SerializationPolicy,
): Projected {
  if (policy >= 4 && token.type === "space" && /^\n{3,}$/u.test(token.raw))
    return { wire: token.raw, markdown: "\n\n" }
  if (token.type === "code") {
    if (typeof token.text !== "string") return unsupported()
    return code({
      type: "code",
      raw: token.raw,
      text: token.text,
      lang: token.lang,
      codeBlockStyle: token.codeBlockStyle,
    })
  }
  if (token.type === "heading") {
    // Setext also recognizes lines inside supporting-file YAML as headings.
    // Only ATX headings have a frozen native readback policy; do not consume
    // an unverified underline or frontmatter delimiter as presentation syntax.
    if (!/^ {0,3}#{1,4}(?:[ \t]+|\n|$)/u.test(token.raw)) return unsupported()
    if (
      typeof token.text !== "string" ||
      !Number.isInteger(token.depth) ||
      token.depth < 1 ||
      token.depth > 4 ||
      !Array.isArray(token.tokens)
    )
      return unsupported()
    const suffix = /\n*$/u.exec(token.raw)?.[0] ?? ""
    const markdown = `${"#".repeat(token.depth)} ${inline(token.text, token.tokens, policy)}${suffix}`
    // Only data-source creation consumes the first plain H1 in some shapes.
    // XML creates that same heading physically without a synthetic title.
    const wire =
      purpose === "data_source_create" && token.depth === 1
        ? `<h1>${token.text}</h1>${suffix}`
        : token.raw
    return { wire, markdown }
  }
  if (token.type === "paragraph" || token.type === "text") {
    if (typeof token.text !== "string" || !Array.isArray(token.tokens)) return unchanged(token.raw)
    return replaceSpan(token.raw, token.text, {
      wire: token.text,
      markdown: inline(token.text, token.tokens, policy),
    })
  }
  if (token.type === "list") {
    if (!Array.isArray(token.items)) return unsupported()
    const projected = embedded(token.raw, token.items, purpose, policy)
    if (
      policy === 2 ||
      token.items.some(
        (item) =>
          item.task === true ||
          item.tokens.length !== 1 ||
          !["paragraph", "text"].includes(item.tokens[0]!.type) ||
          item.text.replace(/\n+$/u, "").includes("\n"),
      )
    )
      return projected
    if (token.items.map((item) => item.raw).join("") !== token.raw) return unsupported()
    const suffix = /\n*$/u.exec(token.raw)?.[0] ?? ""
    return {
      wire: projected.wire,
      markdown:
        token.items
          .map((item) => block(item, purpose, policy).markdown.replace(/\n+$/u, ""))
          .join("\n") + suffix,
    }
  }
  if (token.type === "list_item" || token.type === "blockquote") {
    if (typeof token.text !== "string" || !Array.isArray(token.tokens)) return unsupported()
    // Marked inserts task markers either as direct children or inside a loose
    // paragraph, while text omits them. Lex that complete content separately;
    // the original marker remains in the validated source prefix.
    const children =
      token.type === "list_item" && token.task === true ? SourceLexer.lex(token.text) : token.tokens
    const projected = blocks(token.text, purpose, children, policy)
    return decorated(
      token.raw,
      token.text,
      projected,
      token.type === "blockquote" ? "quote" : "item",
    )
  }
  if (token.type === "table") {
    if (!Array.isArray(token.header) || !Array.isArray(token.rows)) return unsupported()
    return table(token.raw, token.header, token.rows, policy)
  }
  if (token.type === "html") {
    const heading = /^<h([1-4])>([^\n]*)<\/h\1>(\n*)$/u.exec(token.raw)
    if (heading !== null)
      return {
        wire: token.raw,
        markdown: `${"#".repeat(Number(heading[1]))} ${inline(heading[2]!, undefined, policy)}${heading[3]}`,
      }
  }
  return unchanged(token.raw)
}

function blocks(
  raw: string,
  purpose: SharedNotionMarkdownPurpose,
  tokens: readonly Token[] = SourceLexer.lex(raw),
  policy: SerializationPolicy = 2,
): Projected {
  if (tokens.map((token) => token.raw).join("") !== raw) return unsupported()
  const projected = tokens.map((token) => block(token, purpose, policy))
  if (policy === 5) {
    // A native paragraph and following list are separate blocks even when
    // their authored Markdown has only one newline. Freeze the observed
    // separator without changing list children, code or the request bytes.
    for (let at = 1; at < tokens.length; at++) {
      const previous = tokens[at - 1]!
      if (tokens[at]!.type !== "list" || !["paragraph", "text"].includes(previous.type)) continue
      const part = projected[at - 1]!
      const count = /\n*$/u.exec(part.markdown)?.[0].length ?? 0
      if (count < 2)
        projected[at - 1] = { ...part, markdown: part.markdown + "\n".repeat(2 - count) }
    }
  }
  return {
    wire: projected.map((part) => part.wire).join(""),
    markdown: projected.map((part) => part.markdown).join(""),
  }
}

/** A forward, versioned authoring policy. It never reads the response to learn
 * the expected body, and never changes observed-body normalization. */
export function projectNotionMarkdownV2(
  markdown: string,
  purpose: SharedNotionMarkdownPurpose,
): Projected {
  return blocks(markdown, purpose)
}

/** Policy 4 adds the independently observed link-label, simple-list and
 * unaligned-table serialization. Retained policy 2/3 still use the old branch. */
export function projectNotionMarkdownV4(
  markdown: string,
  purpose: SharedNotionMarkdownPurpose,
): Projected {
  return blocks(markdown, purpose, undefined, 4)
}

/** The exact paragraph/list boundary observed by native migration creation.
 * Policy 4 is retained because an original operation already binds its bytes. */
export function projectNotionMarkdownV5(
  markdown: string,
  purpose: SharedNotionMarkdownPurpose,
): Projected {
  return blocks(markdown, purpose, undefined, 5)
}
