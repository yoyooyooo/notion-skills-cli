import { posix } from "node:path"
import { pageId } from "./ref.ts"
import { mapMarkdownLinks } from "./typed-links.ts"
import { referenceProse } from "./shared-file-references.ts"
import {
  materializeNativeAliases,
  type NativeBodyCompletion,
} from "./shared-native-body-completion.ts"

export type SharedFileLink = {
  readonly from: string
  readonly href: string
  readonly target: string
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
  const lines = markdown.split("\n"),
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

/** Body fingerprints remain the exact native response. This is a separate
 * consumer projection: render links between the selected Skill's own native
 * pages as local file references, without treating author text as hidden metadata.
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
