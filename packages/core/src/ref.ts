import { fail } from "./model.ts"

export interface SkillRef {
  readonly selector: string
  readonly path: string
  readonly snapshot?: string
}

export function normalizePath(input: string, base = ""): string {
  if (
    input.includes("\\") ||
    input.includes("\0") ||
    input.startsWith("/") ||
    /^[a-zA-Z]:/.test(input)
  ) {
    throw fail("INVALID_PATH", "A skill file must use a relative POSIX path.")
  }
  const parts = base ? base.split("/").slice(0, -1) : []
  for (const part of input.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (!parts.length) throw fail("INVALID_PATH", "The path escapes the skill root.")
      parts.pop()
    } else parts.push(part)
  }
  return parts.join("/")
}

export function parseRef(input: string): SkillRef {
  // Parse before URL normalization so traversal cannot disappear during URL parsing.
  const match = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/.exec(input)
  if (!match) throw fail("INVALID_REF", "Expected skill://<name-or-page-id>/<path>?snapshot=<id>.")
  try {
    const selector = decodeURIComponent(match[1]!)
    const path = normalizePath(decodeURIComponent((match[2] ?? "/SKILL.md").slice(1))) || "SKILL.md"
    const params = new URLSearchParams(match[3] ?? "")
    for (const key of params.keys())
      if (key !== "snapshot") throw fail("INVALID_REF", `Unknown ref query parameter: ${key}.`)
    if (params.getAll("snapshot").length > 1)
      throw fail("INVALID_REF", "A ref may contain one snapshot parameter.")
    if (!selector.trim() || selector.includes("/") || selector.includes("\0"))
      throw fail("INVALID_REF", "Invalid skill selector.")
    const snapshot = params.get("snapshot") ?? undefined
    if (snapshot !== undefined && !/^s_[a-f0-9]{64}$/.test(snapshot))
      throw fail("INVALID_REF", "Invalid snapshot ID.")
    return { selector, path, ...(snapshot ? { snapshot } : {}) }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error
    throw fail("INVALID_REF", "The ref contains invalid percent encoding.")
  }
}

export function fileRef(selector: string, path: string, snapshot?: string): string {
  return `skill://${encodeURIComponent(selector)}/${path.split("/").map(encodeURIComponent).join("/")}${snapshot ? `?snapshot=${snapshot}` : ""}`
}

export function resolveRef(base: string, relative: string): string {
  const parsed = parseRef(base)
  if (relative.startsWith("skill://")) {
    parseRef(relative)
    return relative
  }
  if (relative.includes("?") || relative.includes("#") || /^[a-z]+:/i.test(relative)) {
    throw fail("INVALID_PATH", "Only relative file paths can be resolved within a skill.")
  }
  return fileRef(parsed.selector, normalizePath(relative, parsed.path), parsed.snapshot)
}

export function pageId(input: string): string | undefined {
  const raw = /^[a-f\d-]{32,36}$/i.test(input)
    ? input.replaceAll("-", "")
    : (() => {
        try {
          const url = new URL(input)
          if (!/(^|\.)notion\.(com|site|so)$/.test(url.hostname)) return undefined
          return /([a-f\d]{32})\/?$/i.exec(url.pathname)?.[1]
        } catch {
          return undefined
        }
      })()
  if (!raw || !/^[a-f\d]{32}$/i.test(raw)) return undefined
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toLowerCase()
}

export interface SkillTarget {
  readonly selector: string
  readonly path?: string
  readonly snapshot?: string
}

export function parseTarget(input: string, path?: string): SkillTarget {
  if (!input.trim()) throw fail("INVALID_ARGUMENT", "Provide a Skill target.")
  let target: SkillTarget
  if (input.startsWith("skill://")) {
    const ref = parseRef(input)
    target = {
      selector: ref.selector,
      snapshot: ref.snapshot,
      path: /^skill:\/\/[^/?#]+\/[^?#]+/.test(input) ? ref.path : undefined,
    }
  } else if (input.startsWith("s_")) {
    if (!/^s_[a-f0-9]{64}$/.test(input)) throw fail("INVALID_SNAPSHOT", "Invalid snapshot ID.")
    target = { selector: "", snapshot: input }
  } else target = { selector: input }
  if (path !== undefined && target.path !== undefined)
    throw fail("INVALID_ARGUMENT", "The target already contains a file path; omit --path.")
  return { ...target, path: path === undefined ? target.path : normalizePath(path) }
}
