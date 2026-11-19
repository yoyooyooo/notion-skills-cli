import { ByteSize, Effect, FileSystem, Option, Path } from "effect"
import type { BigIntStats } from "node:fs"
import { lstatNoFollow } from "./local-locks.ts"
import { parseYaml as parse } from "./yaml.ts"
import { unzipSync } from "fflate"
import { fail, property, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { normalizePath } from "./ref.ts"

export interface ImportFile {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode?: "100644" | "100755"
}
const MAX_BYTES = 128 * 1024 * 1024
// A portable export can contain 128 MiB of incompressible bytes plus ZIP framing.
// Expanded bytes and entry counts remain independently checked before extraction.
const MAX_ZIP_BYTES = MAX_BYTES + 10 * 1024 * 1024
const MAX_FILES = 10_000
const decoder = new TextDecoder("utf-8", { fatal: true })
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

export function readImportZip(bytes: Uint8Array): ImportFile[] {
  try {
    if (bytes.length > MAX_ZIP_BYTES)
      throw fail("ARCHIVE_TOO_LARGE", "ZIP exceeds the bounded portable archive size.")
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
    const expected = new Map<
      string,
      { path: string; size: number; crc: number; mode?: ImportFile["mode"] }
    >()
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
      if (!raw.endsWith("/"))
        expected.set(raw, {
          path,
          size,
          crc: view.getUint32(at + 16, true),
          ...(view.getUint8(at + 5) === 3 && kind === 0x8000
            ? { mode: mode & 0o111 ? "100755" : "100644" }
            : {}),
        })
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
        return {
          path: file.path,
          bytes: data,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }
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

const changedInput = (location: string) =>
  fail(
    "INPUT_CHANGED",
    "The complete import input changed while it was being read. Retry with a stable tree.",
    { path: location },
  )
const sameIdentity = (before: BigIntStats, after: BigIntStats | undefined) =>
  after !== undefined && before.dev === after.dev && before.ino === after.ino
const sameFile = (before: BigIntStats, after: BigIntStats | undefined) =>
  sameIdentity(before, after) &&
  after!.isFile() &&
  before.size === after!.size &&
  before.mode === after!.mode &&
  before.mtimeNs === after!.mtimeNs &&
  before.ctimeNs === after!.ctimeNs

/** The opened descriptor, not a followed pathname, owns the bytes returned. */
function readImportRegular(location: string, before: BigIntStats, limit: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const handle = yield* fs.open(location, { flag: "r", noFollow: true })
      const opened = yield* handle.stat
      if (
        opened.type !== "File" ||
        opened.dev !== BigInt.asUintN(64, before.dev) ||
        Option.getOrUndefined(opened.ino) !== BigInt.asUintN(64, before.ino)
      )
        return yield* Effect.fail(changedInput(location))
      const size = Number(ByteSize.toBigInt(opened.size))
      if (ByteSize.toBigInt(opened.size) !== before.size)
        return yield* Effect.fail(changedInput(location))
      if (!Number.isSafeInteger(size) || size < 0 || size > limit)
        return yield* Effect.fail(
          fail("ARCHIVE_TOO_LARGE", "Import input exceeds its complete byte limit."),
        )
      const bytes = new Uint8Array(size)
      let offset = 0
      while (offset < size) {
        const count = yield* handle.read(bytes.subarray(offset))
        if (!count) break
        offset += count
      }
      const extra = yield* handle.readAlloc(1)
      const after = yield* handle.stat
      if (
        offset !== size ||
        Option.isSome(extra) ||
        opened.size !== after.size ||
        !sameFile(before, yield* lstatNoFollow(location))
      )
        return yield* Effect.fail(changedInput(location))
      return bytes
    }),
  )
}

/** Reject links at every input ancestor and entry; preserve one bounded complete tree. */
export function loadImport(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const full = path.resolve(input)
    const ancestors = new Map<string, BigIntStats>()
    let current = path.parse(full).root
    const components = full.slice(current.length).split(path.sep).filter(Boolean)
    for (const component of ["", ...components]) {
      if (component) current = path.join(current, component)
      const info = yield* lstatNoFollow(current)
      if (info === undefined)
        return yield* Effect.fail(
          fail("INPUT_FAILED", "The import input is missing.", { path: current }),
        )
      if (info.isSymbolicLink() || (current !== full && !info.isDirectory()))
        return yield* Effect.fail(
          fail(
            "INVALID_INPUT",
            "Import paths and their parents must not contain symbolic links or special files. Select the exact ordinary path.",
            { path: current },
          ),
        )
      ancestors.set(current, info)
    }
    const info = ancestors.get(full)!
    const assertAncestors = Effect.forEach(
      ancestors,
      ([location, before]) =>
        Effect.gen(function* () {
          const after = yield* lstatNoFollow(location)
          if (
            !sameIdentity(before, after) ||
            after!.isSymbolicLink() ||
            (location !== full && !after!.isDirectory())
          )
            return yield* Effect.fail(changedInput(location))
        }),
      { discard: true },
    )
    if (info.isDirectory()) {
      const directories: {
        readonly absolute: string
        readonly relative: string
        readonly before: BigIntStats
        names?: readonly string[]
      }[] = [{ absolute: full, relative: "", before: info }]
      const selected: {
        readonly absolute: string
        readonly relative: string
        readonly before: BigIntStats
      }[] = []
      let entries = 0,
        total = 0
      for (const directory of directories) {
        const names = (yield* fs.readDirectory(directory.absolute)).sort()
        directory.names = names
        entries += names.length
        if (entries > MAX_FILES)
          return yield* Effect.fail(
            fail("ARCHIVE_TOO_LARGE", "Directory contains more than 10,000 entries."),
          )
        for (const name of names) {
          const relative = directory.relative ? directory.relative + "/" + name : name
          const canonical = yield* Effect.try({
            try: () => normalizePath(relative),
            catch: (error) => error as SkillsError,
          })
          if (
            !name ||
            name === "." ||
            name === ".." ||
            name.includes(path.sep) ||
            canonical !== relative ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(relative)
          )
            return yield* Effect.fail(
              fail("INVALID_INPUT", "Import entries require canonical relative file paths.", {
                path: relative,
              }),
            )
          const absolute = path.join(directory.absolute, name)
          const before = yield* lstatNoFollow(absolute)
          if (before === undefined) return yield* Effect.fail(changedInput(absolute))
          if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()))
            return yield* Effect.fail(
              fail(
                "INVALID_INPUT",
                "Import accepts only ordinary files and directories; symbolic links are not followed.",
                { path: relative },
              ),
            )
          // Finder's directory-view cache is not authored Skill content.
          if (name === ".DS_Store" && before.isFile()) continue
          if (before.isDirectory()) directories.push({ absolute, relative, before })
          else {
            const size = Number(before.size)
            total += size
            if (!Number.isSafeInteger(size) || size < 0 || total > MAX_BYTES)
              return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Directory exceeds 128 MiB."))
            selected.push({ absolute, relative, before })
          }
        }
      }
      const files: ImportFile[] = []
      for (const file of selected.sort((a, b) =>
        a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
      ))
        files.push({
          path: file.relative,
          bytes: yield* readImportRegular(file.absolute, file.before, Number(file.before.size)),
          mode: file.before.mode & 0o111n ? "100755" : "100644",
        })
      yield* assertAncestors
      for (const directory of directories) {
        const after = yield* lstatNoFollow(directory.absolute)
        if (
          !sameIdentity(directory.before, after) ||
          !after!.isDirectory() ||
          JSON.stringify((yield* fs.readDirectory(directory.absolute)).sort()) !==
            JSON.stringify(directory.names)
        )
          return yield* Effect.fail(changedInput(directory.absolute))
      }
      for (const file of selected)
        if (!sameFile(file.before, yield* lstatNoFollow(file.absolute)))
          return yield* Effect.fail(changedInput(file.absolute))
      return { kind: "directory" as const, files }
    }
    if (!info.isFile())
      return yield* Effect.fail(
        fail("INVALID_INPUT", "Import requires an ordinary ZIP, Markdown file or directory."),
      )
    const zip = /\.zip$/iu.test(full)
    if (!zip && !/\.(md|markdown)$/iu.test(full))
      return yield* Effect.fail(
        fail("INVALID_INPUT", "Import file must be .zip, .md or .markdown."),
      )
    const limit = zip ? MAX_ZIP_BYTES : MAX_BYTES
    if (info.size > BigInt(limit))
      return yield* Effect.fail(fail("ARCHIVE_TOO_LARGE", "Import input exceeds its size limit."))
    const bytes = yield* readImportRegular(full, info, limit)
    yield* assertAncestors
    return zip
      ? {
          kind: "zip" as const,
          files: yield* Effect.try({
            try: () => readImportZip(bytes),
            catch: (e) => e as SkillsError,
          }),
        }
      : {
          kind: "markdown" as const,
          files: [
            {
              path: path.basename(full),
              bytes,
              mode: info.mode & 0o111n ? ("100755" as const) : ("100644" as const),
            },
          ],
        }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("INPUT_FAILED", "Could not read the import input.", { input }),
    ),
  )
}
