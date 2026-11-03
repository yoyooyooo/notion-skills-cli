import { fail } from "./model.ts"
import { splitNativeInlineCode } from "./shared-native-inline-code.ts"
import { normalizePath } from "./ref.ts"
import type { CompositionFile } from "./shared-composition.ts"
import type { SharedNotionMarkdownVersion } from "./shared-notion-projection.ts"

export type SharedFileReference = {
  readonly from: string
  readonly target: string
  readonly href: string
  readonly line: number
  readonly kind: "link" | "image"
}
const punctuation = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu
const unescape = (value: string) =>
  value
    .replace(punctuation, "$1")
    .replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]+|[0-9]+);/giu, (entity) => {
      const named: Readonly<Record<string, string>> = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      }
      const exact = named[entity.toLowerCase()]
      if (exact !== undefined) return exact
      const numeric = entity.slice(2, -1)
      const code =
        numeric[0]?.toLowerCase() === "x"
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10)
      return Number.isSafeInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity
    })
const label = (value: string) =>
  unescape(value).trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US")
function escaped(text: string, index: number): boolean {
  let count = 0
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) count += 1
  return count % 2 === 1
}

/** Native v2 code spans can contain literal backticks and Markdown links.
 * Locate actual parsed tags first; escaped tags, fenced examples and tags
 * inside Markdown code spans must not hide surrounding real references. */
function withoutNativeCode(text: string): string {
  const parts = splitNativeInlineCode(text)
  if (parts === undefined)
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "The complete native inline text could not be checked without losing source positions.",
    )
  return parts.map((part) => (part.code ? part.raw.replace(/[^\n]/gu, " ") : part.raw)).join("")
}

/** Preserve line positions while removing fenced code, inline code and comments. */
export function referenceProse(markdown: string, policy: SharedNotionMarkdownVersion = 2): string {
  let fence: { marker: string; length: number } | undefined
  const lines = markdown
    .replace(/\r/gu, " ")
    .split("\n")
    .map((line) => {
      const found = /^(?:[ \t]*>[ \t]*)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/u.exec(
        line,
      )
      if (fence !== undefined) {
        if (
          found !== null &&
          found[1]?.[0] === fence.marker &&
          found[1].length >= fence.length &&
          found[2]?.trim() === ""
        )
          fence = undefined
        return " ".repeat(line.length)
      }
      if (found !== null) {
        fence = { marker: found[1]![0]!, length: found[1]!.length }
        return " ".repeat(line.length)
      }
      return line
    })
  const raw = lines
    .join("\n")
    .replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, (frontmatter) =>
      frontmatter.replace(/[^\n]/gu, " "),
    )
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\n]/gu, " "))
  const text = policy === 1 ? raw : withoutNativeCode(raw)
  const output = text.split("")
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "`" || escaped(text, start)) continue
    let width = 1
    while (text[start + width] === "`") width += 1
    let end = start + width
    while (end < text.length) {
      end = text.indexOf("`".repeat(width), end)
      if (end < 0) break
      if (text[end - 1] !== "`" && text[end + width] !== "`") break
      end += width
    }
    if (end < 0 || end >= text.length) {
      start += width - 1
      continue
    }
    for (let at = start; at < end + width; at += 1) if (text[at] !== "\n") output[at] = " "
    start = end + width - 1
  }
  const masked = output.join("")
  return masked.replace(
    /<(script|style|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    (literal: string, _tag: string, offset: number) =>
      escaped(masked, offset) ? literal : literal.replace(/[^\n]/gu, " "),
  )
}
function closingBracket(text: string, start: number): number {
  let depth = 1
  for (let at = start + 1; at < text.length; at += 1) {
    if (escaped(text, at)) continue
    if (text[at] === "[") depth += 1
    else if (text[at] === "]" && --depth === 0) return at
  }
  return -1
}
function destination(text: string, start: number): { href: string; end: number } | undefined {
  let at = start
  while (/\s/u.test(text[at] ?? "") && at < text.length) at += 1
  if (text[at] === "<") {
    const begin = ++at
    while (at < text.length && (text[at] !== ">" || escaped(text, at))) {
      if (text[at] === "\n") return undefined
      at += 1
    }
    return text[at] === ">" ? { href: text.slice(begin, at), end: at + 1 } : undefined
  }
  const begin = at
  let depth = 0
  while (at < text.length) {
    if (escaped(text, at)) {
      at += 1
      continue
    }
    const char = text[at]
    if (char === "(") depth += 1
    else if (char === ")") {
      if (depth === 0) break
      depth -= 1
    } else if (/\s/u.test(char ?? "")) break
    at += 1
  }
  return depth === 0 ? { href: text.slice(begin, at), end: at } : undefined
}

function localTarget(from: string, raw: string): string | undefined {
  const href = unescape(raw).trim()
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//")) return undefined
  const withoutFragment = href.split(/[?#]/u, 1)[0] ?? ""
  if (withoutFragment === "") return from
  let decoded: string
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "A local Markdown reference contains malformed URL escaping.",
      { from, href: raw },
    )
  }
  if (
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(decoded)
  )
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "A local reference must stay within the complete relative file tree.",
      { from, href: raw },
    )
  const segments = from.split("/").slice(0, -1)
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0)
        throw fail("SHARED_REFERENCE_INVALID", "A local reference escapes the shared Skill root.", {
          from,
          href: raw,
        })
      segments.pop()
    } else segments.push(segment)
  }
  const target = segments.join("/")
  if (target === "" || normalizePath(target) !== target)
    throw fail(
      "SHARED_REFERENCE_INVALID",
      "A local Markdown reference has no canonical file target.",
      { from, href: raw },
    )
  return target
}

/** Deterministic Markdown links/images only; this does not infer script or prose dependencies. */
export function sharedMarkdownReferences(
  path: string,
  markdown: string,
  policy: SharedNotionMarkdownVersion = 5,
): readonly SharedFileReference[] {
  const text = referenceProse(markdown, policy)
  const definitions = new Map<string, string>()
  const definitionRanges: Array<readonly [number, number]> = []
  const definitionPattern = /^ {0,3}\[([^\]\n]+)\]:[ \t]*/gmu
  for (const match of text.matchAll(definitionPattern)) {
    if (match[1]?.startsWith("^")) continue
    const start = match.index + match[0].length
    const parsed = destination(text, start)
    if (parsed === undefined || parsed.href === "") continue
    const key = label(match[1] ?? "")
    if (!definitions.has(key)) definitions.set(key, parsed.href)
    const end = text.indexOf("\n", start)
    definitionRanges.push([match.index, end < 0 ? text.length : end])
  }
  const result: SharedFileReference[] = []
  const targetRanges: Array<readonly [number, number]> = []
  const remember = (href: string, at: number, kind: SharedFileReference["kind"]) => {
    const target = localTarget(path, href)
    if (target !== undefined)
      result.push({
        from: path,
        target,
        href,
        line: 1 + text.slice(0, at).split("\n").length - 1,
        kind,
      })
  }
  for (let at = 0; at < text.length; at += 1) {
    if (
      text[at] !== "[" ||
      escaped(text, at) ||
      definitionRanges.some(([start, end]) => at >= start && at < end) ||
      targetRanges.some(([start, end]) => at >= start && at < end)
    )
      continue
    const close = closingBracket(text, at)
    if (close < 0) continue
    const kind =
      text[at - 1] === "!" && !escaped(text, at - 1) ? ("image" as const) : ("link" as const)
    const next = text[close + 1]
    if (next === "(") {
      const parsed = destination(text, close + 2)
      if (parsed !== undefined) {
        const tail = text.slice(parsed.end)
        const end =
          /^\s*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))\s*)?\)/u.exec(tail)
        if (end !== null) {
          remember(parsed.href, at, kind)
          targetRanges.push([close + 1, parsed.end + end[0].length])
          continue
        }
      }
    } else if (next === "[") {
      const referenceEnd = closingBracket(text, close + 1)
      if (referenceEnd >= 0) {
        const key = label(text.slice(close + 2, referenceEnd) || text.slice(at + 1, close))
        const href = definitions.get(key)
        if (href !== undefined) remember(href, at, kind)
        targetRanges.push([close + 1, referenceEnd + 1])
        continue
      }
    } else {
      const href = definitions.get(label(text.slice(at + 1, close)))
      if (href !== undefined) remember(href, at, kind)
    }
  }
  // Notion v2 also renders native assets as explicit src/href attributes.
  for (const match of text.matchAll(
    /<(?:a|img|file|pdf|video|audio)\b[^>]*?\b(href|src)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'|([^\s"'<>]+))[^>]*>/giu,
  ))
    remember(
      match[2] ?? match[3] ?? match[4] ?? "",
      match.index,
      /^<img\b/iu.test(match[0]) ? "image" : "link",
    )
  return result
}

/** The caller must supply the complete, byte-verified proposed tree. Retained
 * authoring-v1 creation plans explicitly select policy 1 so their original
 * reference counts and hashed identities do not change during reconstruction.
 * All policies check every file; policies 2 and later understand native code spans. */
export function assertSharedFileReferences(
  files: readonly CompositionFile[],
  policy: SharedNotionMarkdownVersion = 5,
) {
  const paths = new Set(files.map((file) => file.path))
  const references: SharedFileReference[] = []
  let checkedFiles = 0
  for (const file of files) {
    if (!/\.(?:md|markdown)$/iu.test(file.path)) continue
    let markdown: string
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    } catch {
      throw fail(
        "SHARED_REFERENCE_INVALID",
        "A Markdown file cannot be checked as complete UTF-8 text.",
        { path: file.path },
      )
    }
    checkedFiles += 1
    references.push(...sharedMarkdownReferences(file.path, markdown, policy))
  }
  const missing = references.filter((reference) => !paths.has(reference.target))
  if (missing.length !== 0)
    throw fail(
      "SHARED_REFERENCE_BROKEN",
      "The proposed complete tree contains unresolved local Markdown links or images. Update those explicit references before changing file membership.",
      { references: missing, checked_files: checkedFiles },
    )
  return { checked_files: checkedFiles, local_references: references.length }
}
