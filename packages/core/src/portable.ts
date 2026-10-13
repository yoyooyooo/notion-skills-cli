import { zipSync, type Zippable } from "fflate"
import { parse } from "effect/encoding/Yaml"
import { importDocument, type ImportFile } from "./import.ts"
import { aliasFor, fail, property, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"

export const MANIFEST = ".ntn-skills.json"
export const BUNDLE = "ntn-skills-source.zip"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export interface PortableSkill {
  readonly name: string
  readonly description: string
  readonly main: string
  readonly files: readonly ImportFile[]
  readonly projection?: {
    readonly name: string
    readonly description: string
    readonly body: string
  }
}
export function bodyIdentity(body: string) {
  const lines: string[] = []
  let fence: { marker: string; length: number } | undefined
  for (const line of body.replace(/\r\n/g, "\n").trim().split("\n")) {
    if (fence) {
      lines.push(line)
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length)
        fence = undefined
      continue
    }
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (open) {
      fence = { marker: open[2]![0]!, length: open[2]!.length }
      const language = open[3]!.trim()
      lines.push(
        language === "plain text" || language === "txt" || language === "text"
          ? `${open[1]}${open[2]}text`
          : line,
      )
    } else if (line) lines.push(line)
  }
  // The page and Skills endpoints use different paragraph spacing and plain-text labels.
  return lines.join("\n")
}
export const fileOrder = (a: ImportFile, b: ImportFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

export function portableFiles(skill: PortableSkill, projection = false): ImportFile[] {
  aliasFor(skill.name)
  if (
    !skill.description.trim() ||
    skill.description.length > 1024 ||
    !skill.files.some((file) => file.path === skill.main)
  )
    throw fail("INVALID_SKILL", "Portable Skill requires a valid description and entrypoint.")
  const seen = new Set<string>()
  for (const file of skill.files) {
    if (
      !file.path ||
      normalizePath(file.path) !== file.path ||
      file.path === MANIFEST ||
      file.path === BUNDLE ||
      seen.has(file.path)
    )
      throw fail("INVALID_ARCHIVE", "Invalid, duplicate or reserved portable file path.", {
        path: file.path,
      })
    seen.add(file.path)
  }
  const metadata = {
    format: "ntn-skills",
    version: 1,
    name: skill.name,
    description: skill.description,
    main: skill.main,
    ...(projection && skill.projection ? { projection: skill.projection } : {}),
  }
  const files = [
    { path: MANIFEST, bytes: encoder.encode(JSON.stringify(metadata) + "\n") },
    ...skill.files,
  ].sort(fileOrder)
  if (
    files.length > 10_000 ||
    files.reduce((size, file) => size + file.bytes.length, 0) > 128 * 1024 * 1024
  )
    throw fail("ARCHIVE_TOO_LARGE", "Portable Skill exceeds 128 MiB or 10,000 entries.")
  return files
}

export function portableZip(skill: PortableSkill, projection = false) {
  const files = portableFiles(skill, projection)
  const entries: Zippable = Object.create(null)
  for (const file of files)
    entries[file.path] = [file.bytes, { mtime: new Date(1980, 0, 1), level: 6 }]
  const bytes = zipSync(entries)
  if (bytes.length > 20 * 1024 * 1024)
    throw fail("FILE_TOO_LARGE", "Portable Skill ZIP must fit Notion's 20 MiB direct upload limit.")
  return bytes
}

export function readPortable(input: readonly ImportFile[]): PortableSkill | undefined {
  const file = input.find((file) => file.path === MANIFEST)
  if (!file) return undefined
  try {
    const manifest = property(JSON.parse(decoder.decode(file.bytes)))
    if (
      manifest.format !== "ntn-skills" ||
      manifest.version !== 1 ||
      typeof manifest.name !== "string" ||
      typeof manifest.description !== "string" ||
      typeof manifest.main !== "string"
    )
      throw fail("INVALID_ARCHIVE", "Unsupported portable Skill manifest.")
    aliasFor(manifest.name)
    if (!manifest.description.trim() || manifest.description.length > 1024)
      throw fail("INVALID_SKILL", "Portable Skill requires a description of 1–1024 characters.")
    const files = input.filter((file) => file.path !== MANIFEST).sort(fileOrder)
    const seen = new Set<string>()
    for (const file of files) {
      if (
        !file.path ||
        normalizePath(file.path) !== file.path ||
        file.path === BUNDLE ||
        seen.has(file.path)
      )
        throw fail("INVALID_ARCHIVE", "Invalid, duplicate or reserved portable file path.", {
          path: file.path,
        })
      seen.add(file.path)
    }
    if (!seen.has(manifest.main)) throw fail("INVALID_ARCHIVE", "Portable entrypoint is missing.")
    const rawProjection = manifest.projection
    const projection = property(rawProjection)
    if (
      rawProjection !== undefined &&
      (typeof projection.name !== "string" ||
        typeof projection.description !== "string" ||
        typeof projection.body !== "string")
    )
      throw fail("INVALID_ARCHIVE", "Invalid portable projection.")
    return {
      name: manifest.name,
      description: manifest.description,
      main: manifest.main,
      files,
      ...(rawProjection === undefined
        ? {}
        : { projection: projection as NonNullable<PortableSkill["projection"]> }),
    }
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("INVALID_ARCHIVE", "Could not decode the portable Skill manifest.")
  }
}

export function canonicalMain(
  name: string,
  description: string,
  body: string,
  previous?: ImportFile,
): ImportFile {
  let extra: Record<string, unknown> = {}
  if (previous) {
    const text = decoder.decode(previous.bytes)
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (match) {
      const metadata = property(parse(match[1]!))
      if ("name" in metadata || "description" in metadata) extra = metadata
    }
  }
  const metadata = { ...extra, name: aliasFor(name), description }
  delete (metadata as Record<string, unknown>).notion_page_id
  const frontmatter = Object.keys(metadata)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}: ${JSON.stringify(metadata[key as keyof typeof metadata])}`,
    )
    .join("\n")
  return {
    path: previous?.path ?? "SKILL.md",
    bytes: encoder.encode(`---\n${frontmatter}\n---\n\n${body.trim()}${body.trim() ? "\n" : ""}`),
  }
}
