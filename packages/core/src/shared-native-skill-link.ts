import { parseSkillRef } from "./skill-ref.ts"

// Notion rejects some valid custom-scheme URLs, including a default entrypoint
// and an extensionless path. This ordinary POSIX path pair cancels before Skill
// selection; it does not name a file or require reading the target Library.
const prefix = "/entrypoint.md/.."
const authority = /^(skill:\/\/[^/?#]+)(.*)$/u

function reference(href: string): string | undefined {
  try {
    return JSON.stringify(parseSkillRef(href))
  } catch {
    return
  }
}

/** Decode one native hyperlink boundary, never prose, code or an image source.
 * Preserve the raw authority/query/path spelling except this exact neutral pair.
 * Both complete references must validate and select the same logical target. */
export function decodeNativeSkillLink(href: string): string {
  const match = authority.exec(href)
  if (match === null) return href
  const tail = match[2]!
  if (
    !tail.startsWith(prefix) ||
    !["", "/", "?"].includes(tail.slice(prefix.length, prefix.length + 1))
  )
    return href
  const original = reference(href)
  if (original === undefined) return href
  const decoded = match[1]! + tail.slice(prefix.length)
  return reference(decoded) === original ? decoded : href
}

/** Encode the already-decoded original inline span exactly once. In particular,
 * do not skip an existing prefix: decoding one layer must recover this input. */
export function encodeNativeSkillLink(href: string): string {
  if (reference(href) === undefined) return href
  const match = authority.exec(href)!
  return match[1]! + prefix + match[2]!
}
