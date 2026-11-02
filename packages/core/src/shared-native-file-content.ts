import { posix } from "node:path"
import { withoutCreationMarker } from "./publication-create-identity.ts"
import { pageId, parseRef, normalizePath } from "./ref.ts"
import { mapMarkdownLinks } from "./typed-links.ts"
import { fail } from "./model.ts"

export type SharedFileLink = {
  readonly from: string
  readonly href: string
  readonly target: string
}

export function sharedNativeAuthoredBody(markdown: string): string {
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
): string {
  const byId = new Map(files.map((file) => [file.page_id, file.path]))
  const authored = sharedNativeAuthoredBody(markdown)
  return mapMarkdownLinks(authored, (href) => {
    const explicit = links.find((link) => link.from === path && link.href === href)
    if (explicit !== undefined) return explicit.target
    if (!/^https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\//u.test(href)) return href
    const id = pageId(href)
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
  })
}
