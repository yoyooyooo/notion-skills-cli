import { posix } from "node:path"
import { withoutCreationMarker } from "./publication-create-identity.ts"
import { pageId, parseRef, normalizePath } from "./ref.ts"
import { mapMarkdownLinks } from "./typed-links.ts"
import { fail } from "./model.ts"
import { referenceProse, mapSharedMarkdownReferences } from "./shared-file-references.ts"
import {
  materializeNativeAliases,
  type NativeBodyCompletion,
} from "./shared-native-body-completion.ts"

export type SharedFileLink = {
  readonly from: string
  readonly href: string
  readonly target: string
}

/** A fresh owner snapshot supplies exact native bindings for authoring. Restore
 * consumer-relative destinations before writing them back to Notion; provider-only
 * files, foreign refs, external URLs and code keep their original spelling. */
export function restoreSharedNativeFileLinks(
  markdown: string,
  path: string,
  files: readonly { readonly page_id: string; readonly path: string }[],
): string {
  if (!/\.(?:md|markdown)$/iu.test(path)) return markdown
  return mapSharedMarkdownReferences(path, markdown, (reference) => {
    const href = reference.href
    if (href.startsWith("#") || href.startsWith("?")) return href
    const matches = files.filter((file) => file.path === reference.target)
    if (matches.length === 0) return href
    const selected = matches[0]
    if (
      matches.length !== 1 ||
      selected === undefined ||
      pageId(selected.page_id) !== selected.page_id
    )
      throw fail(
        "SHARED_REFERENCE_INVALID",
        "A local reference must resolve to one exact native page in the selected owner snapshot.",
        { from: path, target: reference.target },
      )
    const suffix = href.search(/[?#]/u)
    return (
      `https://app.notion.com/p/${selected.page_id.replaceAll("-", "")}` +
      (suffix < 0 ? "" : href.slice(suffix))
    )
  })
}

/** Page mentions are inline entities; page tags are child pages unless the
 * original block inventory proves that the target is an authored link_to_page. */
export function nativeReferenceTags(markdown: string) {
  const visible = referenceProse(markdown)
  const result: {
    start: number
    end: number
    kind: "mention" | "page"
    href: string
    label: string
  }[] = []
  const pattern = /<(mention|page)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gu
  for (const match of visible.matchAll(pattern)) {
    let slashes = 0
    for (let at = match.index - 1; at >= 0 && markdown[at] === "\\"; at--) slashes++
    if (slashes % 2 === 1 || /\btype="(?:database|user|date)"/u.test(match[2] ?? "")) continue
    const href = /\burl="([^"]+)"/u.exec(match[2] ?? "")?.[1]
    if (href === undefined || !nativeNotionPageId(href)) continue
    result.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: match[1] === "mention" ? "mention" : "page",
      href,
      label: match[3]?.trim() || "Notion page",
    })
  }
  return result
}

export function nativeNotionPageId(href: string): string | undefined {
  try {
    const url = new URL(href)
    return url.protocol === "https:" && /(^|\.)notion\.(?:so|com|site)$/u.test(url.hostname)
      ? pageId(href)
      : undefined
  } catch {
    return undefined
  }
}

export function materializeNativeReferenceTags(
  markdown: string,
  change: (href: string) => string,
  linkedPages: ReadonlySet<string> = new Set(),
) {
  let output = markdown
  for (const tag of nativeReferenceTags(markdown).reverse()) {
    if (tag.kind === "page" && !linkedPages.has(nativeNotionPageId(tag.href)!)) continue
    const target = change(tag.href)
    // Keep an unmanaged mention intact; converting it must not suggest registration.
    if (target === tag.href) continue
    const label = tag.label.replace(/\s+/gu, " ").replace(/([\[\]])/gu, "\\$1")
    output = output.slice(0, tag.start) + `[${label}](${target})` + output.slice(tag.end)
  }
  return output
}

export function sharedNativeAuthoredBody(
  markdown: string,
  linkedPages: ReadonlySet<string> = new Set(),
): string {
  const source = withoutCreationMarker(markdown)
  const lines = source.split("\n"),
    output: string[] = []
  let fence: { marker: string; width: number } | undefined
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    const code = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence !== undefined) {
      output.push(line)
      if (code?.[0] === fence.marker && code.length >= fence.width) fence = undefined
      continue
    }
    if (code) {
      fence = { marker: code[0]!, width: code.length }
      output.push(line)
      continue
    }
    const linked = /^<page\b[^>]*\burl="([^"]+)"[^>]*>/u.exec(line)?.[1]
    if (linked !== undefined && linkedPages.has(nativeNotionPageId(linked)!)) {
      output.push(line)
      continue
    }
    if (/^<page\b[^>]*\burl="[^"]+"[^>]*>[^\n]*<\/page>\s*$/u.test(line)) continue
    if (/^<page\b[^>]*\burl="[^"]+"[^>]*>\s*$/u.test(line)) {
      const end = lines.findIndex((item, index) => index > at && /^<\/page>\s*$/u.test(item))
      if (end !== -1) {
        at = end
        continue
      }
    }
    output.push(line)
  }
  return output.join("\n")
}

/** Explicit per-file links belong to Notion metadata. They are not search
 * guesses, basename aliases, or permission to load another Skill's body. */
export function parseSharedFileLinks(
  encoded: string,
  libraryId: string,
): readonly SharedFileLink[] {
  if (encoded === "") return []
  const invalid = () =>
    fail("SHARED_FILE_LINKS_INVALID", "References must contain a complete versioned file-link map.")
  let value: { version?: unknown; kind?: unknown; links?: unknown }
  try {
    value = JSON.parse(encoded)
  } catch {
    throw invalid()
  }
  if (
    value === null ||
    value.version !== 1 ||
    value.kind !== "file_links" ||
    !Array.isArray(value.links) ||
    Object.keys(value).sort().join(",") !== "kind,links,version"
  )
    throw invalid()
  const seen = new Set<string>()
  return value.links.map((raw: unknown) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid()
    const link = raw as SharedFileLink
    if (
      Object.keys(link).sort().join(",") !== "from,href,target" ||
      typeof link.from !== "string" ||
      normalizePath(link.from) !== link.from ||
      !link.from ||
      typeof link.href !== "string" ||
      !link.href ||
      typeof link.target !== "string"
    )
      throw invalid()
    const key = JSON.stringify([link.from, link.href])
    if (seen.has(key)) throw invalid()
    seen.add(key)
    if (link.target.startsWith("skill://")) {
      const parsed = parseRef(link.target)
      if (
        !parsed.selector.startsWith(`shared_skill:${encodeURIComponent(libraryId)}:`) ||
        !parsed.path
      )
        throw invalid()
    } else if (
      !/^https:\/\/(?:raw\.githubusercontent\.com\/[^/]+\/[^/]+\/|github\.com\/[^/]+\/[^/]+\/blob\/)[a-f0-9]{40}\//u.test(
        link.target,
      )
    )
      throw invalid()
    return { from: link.from, href: link.href, target: link.target }
  })
}

/** Body fingerprints remain the exact native response. This is a separate
 * consumer projection: omit transport-only identity paragraphs and render links
 * between the selected Skill's own native pages as local file references.
 * Unknown Notion pages, prose, code, and external links remain unchanged.
 */
export function materializeSharedNativeFile(
  markdown: string,
  path: string,
  files: readonly { readonly page_id: string; readonly path: string }[],
  links: readonly SharedFileLink[] = [],
  linkedPages: ReadonlySet<string> = new Set(),
  completion?: NativeBodyCompletion,
): string {
  const byId = new Map(files.map((file) => [file.page_id, file.path]))
  const resolve = (href: string) => {
    const explicit = links.find((link) => link.from === path && link.href === href)
    if (explicit !== undefined) return explicit.target
    const id = nativeNotionPageId(href)
    const target = id && byId.get(id)
    if (!target) return href
    const parsed = new URL(href)
    const relative = posix.relative(posix.dirname(path), target)
    const suffix = parsed.hash.startsWith("#ntn-skills-path=") ? "" : parsed.hash
    return (
      relative
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/") + suffix
    )
  }
  const projected =
    completion === undefined
      ? markdown
      : materializeNativeAliases(markdown, completion, (href, page) => {
          const explicit = links.find((link) => link.from === path && link.href === href)
          return explicit?.target ?? resolve(`https://www.notion.so/${page.replaceAll("-", "")}`)
        })
  const authored = sharedNativeAuthoredBody(
    materializeNativeReferenceTags(projected, resolve, linkedPages),
    linkedPages,
  )
  return mapMarkdownLinks(authored, resolve)
}
