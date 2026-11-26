import { Schema } from "effect"
import { zipSync, type Zippable } from "fflate"
import { parseYaml as parse } from "./yaml.ts"
import type { ImportFile } from "./import.ts"
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
import { fileRef, normalizePath } from "./ref.ts"
import { bindSkillRef, formatSkillIdentity, parseSkillRef } from "./skill-ref.ts"

export const MANIFEST = ".ntn-skills.json"
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export const PortableRelationsSchema = Schema.Struct({
  version: Schema.Literal(1),
  ownership: Schema.Literal("notion"),
  library_id: Schema.String,
  members: Schema.optional(Schema.Array(Schema.String)),
  requires: Schema.optional(Schema.Array(Schema.String)),
})
export type PortableRelations = typeof PortableRelationsSchema.Type

/** Strip only the generated index declared by this explicit portable selection.
 * This is used to compare authored bytes, never to rewrite an arbitrary body. */
export function withoutPortableMemberIndex(
  file: ImportFile,
  kind: ContentKind,
  members: readonly string[] | undefined,
): ImportFile {
  if (members === undefined || (kind === "skill" && members.length === 0)) return file
  const markdown = decoder.decode(file.bytes)
  if (members.length === 0) {
    const empty = /\n\n## Members\n?$/u.exec(markdown)
    if (!empty)
      throw fail(
        "PORTABLE_MEMBER_PROJECTION_INVALID",
        "The portable generated Members index is missing.",
      )
    return { ...file, bytes: encoder.encode(markdown.slice(0, empty.index).trimEnd() + "\n") }
  }
  const marker = "\n\n## Members\n\n",
    at = markdown.lastIndexOf(marker)
  const lines =
    at < 0
      ? []
      : markdown
          .slice(at + marker.length)
          .trimEnd()
          .split("\n")
  if (
    at < 0 ||
    lines.length !== members.length ||
    lines.some(
      (line, index) =>
        !line.startsWith("- [") || !line.includes(`](${fileRef(members[index]!, "SKILL.md")}) — `),
    )
  )
    throw fail(
      "PORTABLE_MEMBER_PROJECTION_INVALID",
      "The portable generated Members index differs from its exact selected identities.",
    )
  return { ...file, bytes: encoder.encode(markdown.slice(0, at).trimEnd() + "\n") }
}

/** Complete author-selected sets, including an intentional empty set. Provider
 * acquisition never treats these portable fields as source-refresh authority. */
export function validatePortableRelations(input: unknown): PortableRelations {
  const value = Schema.decodeUnknownSync(PortableRelationsSchema)(input, {
    onExcessProperty: "error",
  })
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value.library_id))
    throw fail(
      "PORTABLE_RELATION_SCOPE",
      "Portable relations require a stable shared library identity.",
    )
  const selected: { members?: string[]; requires?: string[] } = {}
  for (const field of ["members", "requires"] as const) {
    const refs = value[field]
    if (refs === undefined) continue
    const canonical = refs.map((ref) => {
      try {
        const target = bindSkillRef(parseSkillRef(ref), value.library_id)
        if (
          target.owner.libraryId !== value.library_id ||
          target.path !== "" ||
          target.selection.kind !== "current"
        )
          throw fail(
            "PORTABLE_RELATION_SCOPE",
            "Relations must be current Skills in their exact Library.",
          )
        return formatSkillIdentity(target.owner)
      } catch {
        throw fail(
          "PORTABLE_RELATION_SCOPE",
          "Portable relations require current root Skill refs in their declared Library, without a file path or snapshot.",
          { ref },
        )
      }
    })
    if (new Set(canonical).size !== canonical.length)
      throw fail(
        "PORTABLE_RELATION_INVALID",
        "Portable relations must select each complete Skill identity once.",
      )
    selected[field] = canonical
  }
  return { ...value, ...selected }
}

export function portableRelationSelection(
  relations: PortableRelations | undefined,
  libraryId: string,
  explicit: { readonly members?: readonly string[]; readonly requires?: readonly string[] } = {},
) {
  const selected = validatePortableRelations({
    version: 1,
    ownership: "notion",
    library_id: libraryId,
    ...explicit,
  })
  if (relations === undefined)
    return {
      ...(selected.members === undefined ? {} : { members: selected.members }),
      ...(selected.requires === undefined ? {} : { requires: selected.requires }),
    }
  const retained = validatePortableRelations(relations)
  if (retained.library_id !== libraryId)
    throw fail(
      "PORTABLE_RELATION_SCOPE",
      "Import these relations into their original shared library; targets are never matched by name.",
    )
  for (const field of ["members", "requires"] as const) {
    if (
      selected[field] !== undefined &&
      retained[field] !== undefined &&
      JSON.stringify([...selected[field]].sort()) !== JSON.stringify([...retained[field]].sort())
    )
      throw fail(
        "PORTABLE_RELATION_CONFLICT",
        "Explicit relation flags differ from the portable selection; review one intended set.",
        { field },
      )
  }
  return {
    ...((selected.members ?? retained.members) === undefined
      ? {}
      : { members: selected.members ?? retained.members }),
    ...((selected.requires ?? retained.requires) === undefined
      ? {}
      : { requires: selected.requires ?? retained.requires }),
  }
}
const PortableManifestSchema = Schema.Struct({
  format: Schema.Literal("ntn-skills"),
  version: Schema.Literal(2),
  kind: ContentKindSchema,
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  relations: Schema.optional(PortableRelationsSchema),
})
export interface PortableSkill {
  readonly kind: ContentKind
  readonly name: string
  readonly description: string
  readonly main: string
  readonly files: readonly ImportFile[]
  readonly relations?: PortableRelations
}
export const fileOrder = (a: ImportFile, b: ImportFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

export function portableFiles(skill: PortableSkill): ImportFile[] {
  if ("projection" in skill)
    throw fail(
      "INVALID_ARCHIVE",
      "Select the current files explicitly; retained projection payloads are not current content.",
    )
  validateDisplayName(skill.name)
  decode(ContentKindSchema, skill.kind)
  validateDescription(skill.description)
  if (!skill.files.some((file) => file.path === skill.main))
    throw fail("INVALID_SKILL", "Portable Skill requires an entrypoint.")
  const seen = new Set<string>()
  for (const file of skill.files) {
    if (file.mode !== undefined && file.mode !== "100644" && file.mode !== "100755")
      throw fail("INVALID_ARCHIVE", "Portable resources require a regular-file mode.", {
        path: file.path,
      })
    if (
      !file.path ||
      normalizePath(file.path) !== file.path ||
      file.path === MANIFEST ||
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
    ...(skill.relations === undefined
      ? {}
      : { relations: validatePortableRelations(skill.relations) }),
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

export function portableZip(skill: PortableSkill) {
  const files = portableFiles(skill)
  const entries: Zippable = Object.create(null)
  for (const file of files)
    entries[file.path] = [
      file.bytes,
      {
        mtime: new Date(1980, 0, 1),
        level: 6,
        ...(file.mode === undefined
          ? {}
          : { os: 3, attrs: ((file.mode === "100755" ? 0o100755 : 0o100644) << 16) >>> 0 }),
      },
    ]
  // The portable tree has its own expanded-size and entry limits. Notion's
  // direct-upload limit belongs to the upload boundary, not local backups.
  return zipSync(entries)
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
    const manifest = Schema.decodeUnknownSync(PortableManifestSchema)(raw, {
      onExcessProperty: "error",
    })
    const files = input.filter((file) => file.path !== MANIFEST).sort(fileOrder)
    if (!files.some((file) => file.path === manifest.main))
      throw fail("INVALID_ARCHIVE", "Portable entrypoint is missing.")
    const portable: PortableSkill = {
      kind: manifest.kind,
      name: manifest.name,
      description: manifest.description,
      main: manifest.main,
      files,
      ...(manifest.relations === undefined
        ? {}
        : { relations: validatePortableRelations(raw.relations) }),
    }
    portableFiles(portable)
    return portable
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
  const text = decoder.decode(previous.bytes)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  const extra = match ? property(parse(match[1]!)) : {}
  const metadata = { ...extra, name: validateDisplayName(name), description }
  const frontmatter = Object.keys(metadata)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}: ${JSON.stringify(metadata[key as keyof typeof metadata])}`,
    )
    .join("\n")
  return {
    path: previous.path,
    ...(previous.mode === undefined ? {} : { mode: previous.mode }),
    bytes: encoder.encode(`---\n${frontmatter}\n---\n\n${body.trim()}${body.trim() ? "\n" : ""}`),
  }
}
