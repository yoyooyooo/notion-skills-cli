import { Effect, FileSystem, Path } from "effect"
import { parseYaml as parse } from "./yaml.ts"
import { unzipSync } from "fflate"
import { fail, property, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { normalizePath } from "./ref.ts"

export interface ImportFile {
  readonly path: string
  readonly bytes: Uint8Array
}
const MAX_BYTES = 128 * 1024 * 1024
const MAX_FILES = 10_000
const decoder = new TextDecoder("utf-8", { fatal: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

export function readImportZip(bytes: Uint8Array): ImportFile[] {
  try {
    if (bytes.length > 32 * 1024 * 1024)
      throw fail("ARCHIVE_TOO_LARGE", "ZIP exceeds 32 MiB compressed.")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.length - 22
    const minimum = Math.max(0, bytes.length - 65_557)
    while (
      end >= minimum &&
      (view.getUint32(end, true) !== 0x06054b50 ||
        end + 22 + view.getUint16(end + 20, true) !== bytes.length)
    )
      end--
    if (end < minimum) throw fail("INVALID_ARCHIVE", "ZIP end record is missing.")
    const count = view.getUint16(end + 10, true)
    if (
      view.getUint16(end + 4, true) ||
      view.getUint16(end + 6, true) ||
      count !== view.getUint16(end + 8, true) ||
      count === 0xffff
    )
      throw fail("INVALID_ARCHIVE", "Multi-volume and ZIP64 archives are not supported.")
    if (count > MAX_FILES) throw fail("ARCHIVE_TOO_LARGE", "ZIP contains too many entries.")
    const offset = view.getUint32(end + 16, true)
    const directoryEnd = offset + view.getUint32(end + 12, true)
    if (directoryEnd !== end) throw fail("INVALID_ARCHIVE", "Invalid ZIP directory bounds.")
    const seen = new Set<string>()
    const expected = new Map<string, { path: string; size: number; crc: number }>()
    let total = 0
    let at = offset
    for (let index = 0; index < count; index++) {
      if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
        throw fail("INVALID_ARCHIVE", "Invalid ZIP directory entry.")
      const flags = view.getUint16(at + 8, true)
      const method = view.getUint16(at + 10, true)
      const length = view.getUint16(at + 28, true)
      const next = at + 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
      if (next > end || flags & 1 || ![0, 8].includes(method))
        throw fail("INVALID_ARCHIVE", "Encrypted or unsupported ZIP entry.")
      const mode = view.getUint32(at + 38, true) >>> 16
      const kind = mode & 0xf000
      if (kind && kind !== 0x8000 && kind !== 0x4000)
        throw fail("INVALID_ARCHIVE", "ZIP links and special files are not supported.")
      const raw = decoder.decode(bytes.subarray(at + 46, at + 46 + length))
      if (raw.split("/").includes(".."))
        throw fail("INVALID_ARCHIVE", "ZIP traversal is not allowed.")
      const path = normalizePath(raw)
      if (!path || seen.has(path))
        throw fail("INVALID_ARCHIVE", "Invalid or duplicate ZIP path.", { path })
      seen.add(path)
      const size = view.getUint32(at + 24, true)
      total += size
      if (total > MAX_BYTES) throw fail("ARCHIVE_TOO_LARGE", "ZIP exceeds 128 MiB expanded.")
      if (!raw.endsWith("/")) expected.set(raw, { path, size, crc: view.getUint32(at + 16, true) })
      at = next
    }
    if (at !== directoryEnd)
      throw fail("INVALID_ARCHIVE", "ZIP entry count differs from its directory.")
    const unpacked = unzipSync(bytes.subarray(0, end + 22), {
      filter: (entry) => {
        const file = expected.get(entry.name)
        if (!file) return false
        if (entry.originalSize !== file.size)
          throw fail("INVALID_ARCHIVE", "ZIP entry size mismatch.")
        return true
      },
    })
    return [...expected]
      .map(([raw, file]) => {
        const data = unpacked[raw]
        if (!data || data.length !== file.size)
          throw fail("INVALID_ARCHIVE", "ZIP entry failed extraction.")
        let crc = 0xffffffff
        for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!
        if ((crc ^ 0xffffffff) >>> 0 !== file.crc)
          throw fail("INVALID_ARCHIVE", "ZIP entry checksum mismatch.", { path: file.path })
        return { path: file.path, bytes: data }
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("INVALID_ARCHIVE", "Could not decode a valid UTF-8 ZIP archive.")
  }
}

export function importEntrypoint(input: readonly ImportFile[], single = false) {
  const files = importFiles(input, single)
  const preferred = files.find((f) => f.path === "SKILL.md")
  const candidates = single
    ? files
    : files.filter((f) => !f.path.includes("/") && /\.(md|markdown)$/i.test(f.path))
  const main = preferred ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!main)
    throw fail("IMPORT_AMBIGUOUS", "Expected SKILL.md or one top-level Markdown file.", {
      candidates: candidates.map((f) => f.path),
    })
  return { main, attachments: files.filter((f) => f !== main) }
}

export interface ImportMetadataOptions {
  readonly name?: string
  readonly description?: string
}
export function importDocument(main: ImportFile, options: ImportMetadataOptions = {}) {
  try {
    const content = decoder.decode(main.bytes)
    if (content.includes("\0")) throw fail("INVALID_INPUT", "Markdown must contain UTF-8 text.")
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
    const metadata = match ? property(parse(match[1]!)) : {}
    const hasMetadata = "name" in metadata || "description" in metadata
    if (metadata.name !== undefined && typeof metadata.name !== "string" && !options.name)
      throw fail(
        "INVALID_SKILL_NAME",
        "Imported frontmatter name must be a string or overridden with --name.",
      )
    const original = typeof metadata.name === "string" ? metadata.name : undefined
    const stem = main.path.replace(/\.(md|markdown)$/i, "")
    const name = validateDisplayName(options.name ?? original ?? stem)
    const description = validateDescription(options.description ?? metadata.description)
    const body =
      match && hasMetadata ? content.slice(match[0].length).replace(/^\r?\n/, "") : content
    return { name, description, body }
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("INVALID_INPUT", "Could not parse UTF-8 Markdown and its frontmatter.")
  }
}
export function importFiles(input: readonly ImportFile[], single = false) {
  let files = [...input]
  if (
    !single &&
    files.length &&
    files.every(
      (file) => file.path.includes("/") && file.path.split("/")[0] === files[0]!.path.split("/")[0],
    )
  )
    files = files.map((file) => ({ ...file, path: file.path.slice(file.path.indexOf("/") + 1) }))
  return files
}

export function loadImport(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const full = path.resolve(input)
    const info = yield* fs.stat(full)
    const files: ImportFile[] = []
    if (info.type === "Directory") {
      const names = yield* fs.readDirectory(full, { recursive: true })
      if (names.length > MAX_FILES)
        return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Directory contains too many entries."))
      let total = 0
      for (const name of names.sort()) {
        const stat = yield* fs.stat(path.join(full, name))
        if (stat.type === "Directory") continue
        if (stat.type !== "File")
          return yield* Effect.fail(
            fail("INVALID_INPUT", "Import accepts only regular files and directories.", {
              path: name,
            }),
          )
        const size = Number(stat.size)
        if (total + size > MAX_BYTES)
          return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Directory exceeds 128 MiB."))
        const bytes = yield* fs.readFile(path.join(full, name))
        total += bytes.length
        if (total > MAX_BYTES)
          return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Directory exceeds 128 MiB."))
        files.push({ path: normalizePath(name.split(path.sep).join("/")), bytes })
      }
      return { kind: "directory" as const, files }
    }
    if (info.type !== "File")
      return yield* Effect.fail(
        fail("INVALID_INPUT", "Import requires a ZIP file, directory or Markdown file."),
      )
    const zip = /\.zip$/i.test(full)
    if (!zip && !/\.(md|markdown)$/i.test(full))
      return yield* Effect.fail(
        fail("INVALID_INPUT", "Import file must be .zip, .md or .markdown."),
      )
    if (Number(info.size) > (zip ? 32 * 1024 * 1024 : MAX_BYTES))
      return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Import input exceeds its size limit."))
    const bytes = yield* fs.readFile(full)
    if (bytes.length > (zip ? 32 * 1024 * 1024 : MAX_BYTES))
      return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Import input exceeds its size limit."))
    return zip
      ? {
          kind: "zip" as const,
          files: yield* Effect.try({
            try: () => readImportZip(bytes),
            catch: (e) => e as SkillsError,
          }),
        }
      : { kind: "markdown" as const, files: [{ path: path.basename(full), bytes }] }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("INPUT_FAILED", "Could not read the import input.", { input }),
    ),
  )
}
