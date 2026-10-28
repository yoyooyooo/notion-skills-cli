import { Schema } from "effect"
import { zipSync, type Zippable } from "fflate"
import { parseYaml as parse } from "./yaml.ts"
import { importDocument, type ImportFile } from "./import.ts"
import {
  validateDisplayName,
  validateDescription,
  ContentKindSchema,
  decode,
  fail,
  property,
  SkillsError,
  type ContentKind,
} from "./model.ts"
import { normalizePath } from "./ref.ts"

export const MANIFEST = ".ntn-skills.json"
export const BUNDLE = "ntn-skills-source.zip"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const PortableManifestSchema = Schema.Struct({
  format: Schema.Literal("ntn-skills"),
  version: Schema.Literal(2),
  kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  projection: Schema.optional(Schema.Unknown),
})
export interface PortableSkill {
  readonly kind: ContentKind
  readonly name: string
  readonly description: string
  readonly main: string
  readonly files: readonly ImportFile[]
  readonly projection?: {
    readonly name: string
    readonly description: string
    readonly body: string
    readonly references?: Readonly<Record<string, string>>
    readonly materialization?: {
      readonly authored: string
      readonly generated: string
    }
  }
}

export function authoredPortable(skill: PortableSkill): PortableSkill {
  const materialization = skill.projection?.materialization
  if (skill.kind !== "router" || !materialization) return skill
  const main = skill.files.find((file) => file.path === skill.main)
  if (!main) throw fail("INVALID_SKILL", "Portable Skill entrypoint is missing.")
  const unchanged =
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(main.bytes) ===
    materialization.generated
  const { materialization: _, ...projection } = skill.projection!
  return {
    ...skill,
    files: unchanged
      ? skill.files.map((file) =>
          file === main ? { ...file, bytes: encoder.encode(materialization.authored) } : file,
        )
      : skill.files,
    projection: {
      ...projection,
      body: unchanged
        ? projection.body
        : importDocument(main, { name: skill.name, description: skill.description }).body,
    },
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

export function portableFiles(
  skill: PortableSkill,
  projection = false,
  snapshot = false,
): ImportFile[] {
  validateDisplayName(skill.name)
  if (skill.projection) validateDisplayName(skill.projection.name)
  decode(ContentKindSchema, skill.kind)
  validateDescription(skill.description)
  if (!skill.files.some((file) => file.path === skill.main))
    throw fail("INVALID_SKILL", "Portable Skill requires an entrypoint.")
  const seen = new Set<string>()
  for (const file of skill.files) {
    if (
      !file.path ||
      normalizePath(file.path) !== file.path ||
      file.path === MANIFEST ||
      (file.path === BUNDLE && !snapshot) ||
      seen.has(file.path)
    )
      throw fail("INVALID_ARCHIVE", "Invalid, duplicate or reserved portable file path.", {
        path: file.path,
      })
    seen.add(file.path)
  }
  const metadata = {
    format: "ntn-skills",
    version: 2,
    kind: skill.kind,
    name: skill.name,
    description: skill.description,
    main: skill.main,
    ...((projection || skill.projection?.materialization) && skill.projection
      ? { projection: skill.projection }
      : {}),
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

export function portableZip(skill: PortableSkill, projection = false, snapshot = false) {
  const files = portableFiles(skill, projection, snapshot)
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
  if (input.filter((file) => file.path === MANIFEST).length !== 1)
    throw fail("INVALID_ARCHIVE", "Portable input requires exactly one manifest.")
  try {
    const raw = property(JSON.parse(decoder.decode(file.bytes)))
    if (raw.format === "ntn-skills" && raw.version === 1)
      throw fail(
        "PORTABLE_UPGRADE_REQUIRED",
        "Convert this portable archive with the independent portable converter before using the normal CLI.",
        {
          version: raw.version,
          required_version: 2,
        },
      )
    const manifest = Schema.decodeUnknownSync(PortableManifestSchema)(raw)
    validateDisplayName(manifest.name)
    const kind = manifest.kind
    validateDescription(manifest.description)
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
        typeof projection.body !== "string" ||
        (projection.references !== undefined &&
          (typeof projection.references !== "object" ||
            projection.references === null ||
            Array.isArray(projection.references) ||
            Object.values(projection.references).some((value) => typeof value !== "string"))) ||
        (projection.materialization !== undefined &&
          (kind !== "router" ||
            typeof property(projection.materialization).authored !== "string" ||
            typeof property(projection.materialization).generated !== "string")))
    )
      throw fail("INVALID_ARCHIVE", "Invalid portable projection.")
    if (rawProjection !== undefined) validateDisplayName(projection.name as string)
    return {
      kind,
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
  previous: ImportFile,
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
  const metadata = { ...extra, name: validateDisplayName(name), description }
  delete (metadata as Record<string, unknown>).notion_page_id
  const frontmatter = Object.keys(metadata)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}: ${JSON.stringify(metadata[key as keyof typeof metadata])}`,
    )
    .join("\n")
  return {
    path: previous.path,
    bytes: encoder.encode(`---\n${frontmatter}\n---\n\n${body.trim()}${body.trim() ? "\n" : ""}`),
  }
}
