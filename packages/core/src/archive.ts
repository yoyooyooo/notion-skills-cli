import { Gunzip } from "fflate"
import { parseYaml as parse } from "./yaml.ts"
import { aliasFor, fail, validateDescription, validateDisplayName } from "./model.ts"
import { normalizePath } from "./ref.ts"

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const decoder = new TextDecoder("utf-8", { fatal: true })

export interface ArchiveFile {
  readonly path: string
  readonly data: Uint8Array
}
export interface SkillArchive {
  readonly name: string
  readonly files: readonly ArchiveFile[]
}

export function readArchive(compressed: Uint8Array): SkillArchive {
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    const unzip = new Gunzip((chunk) => {
      size += chunk.length
      if (size > MAX_ARCHIVE_BYTES)
        throw fail("ARCHIVE_TOO_LARGE", "Expanded skill archive exceeds 128 MiB.")
      chunks.push(chunk)
    })
    for (let offset = 0; offset < compressed.length; offset += 64 * 1024) {
      unzip.push(
        compressed.subarray(offset, offset + 64 * 1024),
        offset + 64 * 1024 >= compressed.length,
      )
    }
    const tar = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      tar.set(chunk, at)
      at += chunk.length
    }
    const field = (start: number, length: number) => {
      const bytes = tar.subarray(start, start + length)
      const end = bytes.indexOf(0)
      return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
    }
    const files: ArchiveFile[] = []
    const paths = new Set<string>()
    let root: string | undefined
    let nextPath: string | undefined
    let offset = 0
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((b) => b === 0)) break
      const checksum = Number.parseInt(field(offset + 148, 8).trim(), 8)
      let actual = 0
      for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i]!
      if (actual !== checksum) throw fail("INVALID_ARCHIVE", "Tar header checksum mismatch.")
      const length = Number.parseInt(field(offset + 124, 12).trim() || "0", 8)
      if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length)
        throw fail("INVALID_ARCHIVE", "Invalid tar entry size.")
      const data = tar.subarray(offset + 512, offset + 512 + length)
      const type = field(offset + 156, 1)
      const prefix = field(offset + 345, 155)
      const entry = `${prefix ? prefix + "/" : ""}${field(offset, 100)}`
      if (type === "x" || type === "g") {
        let pos = 0
        while (pos < data.length) {
          const space = data.indexOf(32, pos)
          const recordLength = Number(decoder.decode(data.subarray(pos, space)))
          if (
            space < pos ||
            !Number.isSafeInteger(recordLength) ||
            recordLength <= space - pos + 1 ||
            pos + recordLength > data.length
          )
            throw fail("INVALID_ARCHIVE", "Invalid PAX record.")
          const record = decoder
            .decode(data.subarray(space + 1, pos + recordLength))
            .replace(/\n$/, "")
          const equals = record.indexOf("=")
          if (type === "x" && record.slice(0, equals) === "path")
            nextPath = record.slice(equals + 1)
          pos += recordLength
        }
      } else if (type === "L") {
        nextPath = decoder.decode(data).replace(/\0.*$/s, "").replace(/\n$/, "")
      } else {
        const raw = (nextPath ?? entry).replace(/^\.\//, "")
        nextPath = undefined
        if (raw.split("/").includes(".."))
          throw fail("INVALID_ARCHIVE", "Tar traversal paths are not allowed.")
        const normalized = normalizePath(raw)
        const [directory, ...parts] = normalized.split("/")
        if (!directory || (root !== undefined && directory !== root))
          throw fail("INVALID_ARCHIVE", "A skill archive must have one top-level directory.")
        root = directory
        if (type !== "5") {
          if (type !== "0" && type !== "")
            throw fail("INVALID_ARCHIVE", "Links and special tar entries are not supported.")
          const path = parts.join("/")
          if (!path || paths.has(path))
            throw fail("INVALID_ARCHIVE", "Invalid or duplicate skill file path.")
          paths.add(path)
          files.push({ path, data })
          if (files.length > 10_000)
            throw fail("ARCHIVE_TOO_LARGE", "A skill archive contains too many files.")
        }
      }
      offset += 512 + Math.ceil(length / 512) * 512
    }
    const main = files.find((file) => file.path === "SKILL.md")
    if (!main || !root) throw fail("INVALID_SKILL", "The exported archive must include SKILL.md.")
    const content = decoder.decode(main.data)
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
    const metadata: unknown = frontmatter ? parse(frontmatter[1]!) : undefined
    const name =
      metadata && typeof metadata === "object" && "name" in metadata ? metadata.name : undefined
    if (typeof name !== "string")
      throw fail("INVALID_SKILL", "SKILL.md must contain a valid name matching its directory.")
    validateDisplayName(name)
    if (name !== root && aliasFor(name) !== root)
      throw fail("INVALID_SKILL", "SKILL.md name must match its directory or invocation alias.")
    const description =
      metadata && typeof metadata === "object" && "description" in metadata
        ? metadata.description
        : undefined
    validateDescription(description)
    return { name, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error
    throw fail("INVALID_ARCHIVE", "Could not decode a valid gzip/tar skill archive.")
  }
}
