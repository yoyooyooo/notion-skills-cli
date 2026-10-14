import { Effect, FileSystem, Path } from "effect"
import { importDocument, readImportZip, type ImportFile } from "./import.ts"
import { fail, SkillsError, type Snapshot } from "./model.ts"
import {
  BUNDLE,
  MANIFEST,
  bodyIdentity,
  canonicalMain,
  fileOrder,
  portableFiles,
  portableZip,
  readPortable,
  type PortableSkill,
} from "./portable.ts"
import { normalizePath, parseTarget } from "./ref.ts"
import { targetSnapshot, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { type ReadPolicyOptions } from "./cache.ts"

export function snapshotPortable(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: ImportFile[] = []
    for (const file of snapshot.files) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Export file failed its checksum.", { path: file.path }),
        )
      files.push({ path: file.path, bytes })
    }
    return yield* Effect.try({
      try: () => {
        const main = files.find((file) => file.path === "SKILL.md")
        if (!main) throw fail("INVALID_SKILL", "Snapshot has no SKILL.md.")
        const doc = importDocument(main, {
          name: snapshot.skill.name,
          description: snapshot.skill.description,
        })
        const bundle = files.find((file) => file.path === BUNDLE)
        const source = bundle ? readPortable(readImportZip(bundle.bytes)) : undefined
        if (bundle && !source)
          throw fail("INVALID_ARCHIVE", "Reserved source attachment has no portable manifest.")
        if (!source)
          return {
            name: snapshot.skill.name,
            description: doc.description,
            main: "SKILL.md",
            files: [
              canonicalMain(snapshot.skill.name, doc.description, doc.body),
              ...files.filter((file) => file.path !== "SKILL.md"),
            ].sort(fileOrder),
          } satisfies PortableSkill
        const projection = source.projection
        const unchanged =
          projection &&
          projection.name === snapshot.skill.name &&
          projection.description === doc.description &&
          projection.body === bodyIdentity(doc.body)
        const original = source.files.find((file) => file.path === source.main)!
        const merged = new Map(source.files.map((file) => [file.path, file]))
        if (snapshot.references && projection?.references) {
          const live = new Set(snapshot.references.map((page) => page.path))
          for (const path of Object.keys(projection.references))
            if (!live.has(path)) merged.delete(path)
        }
        // Source main remains byte-exact until the live body or metadata changes.
        if (!unchanged)
          merged.set(
            source.main,
            canonicalMain(snapshot.skill.name, doc.description, doc.body, original),
          )
        for (const file of files)
          if (
            file.path !== "SKILL.md" &&
            file.path !== BUNDLE &&
            file.path !== MANIFEST &&
            file.path !== source.main
          )
            if (snapshot.references && projection?.references?.[file.path] !== undefined) {
              const currentBody = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
              if (bodyIdentity(currentBody) === projection.references[file.path]) continue
              merged.set(file.path, file)
            } else merged.set(file.path, file)
        return {
          name: snapshot.skill.name,
          description: doc.description,
          main: source.main,
          files: [...merged.values()].sort(fileOrder),
        } satisfies PortableSkill
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_SKILL", "Could not construct a reversible export."),
    })
  })
}

export function portableIdentity(skill: PortableSkill) {
  return Effect.gen(function* () {
    const files: Array<[string, string]> = []
    for (const file of [...skill.files].sort(fileOrder))
      files.push([file.path, yield* sha256(file.bytes)])
    return yield* sha256(JSON.stringify([skill.name, skill.description, skill.main, files]))
  })
}

export interface ExportOptions extends ReadPolicyOptions {
  readonly database?: string
  readonly output: string
  readonly format?: "zip" | "directory"
}
export function exportSkill(selectorInput: string, options: ExportOptions) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => parseTarget(selectorInput),
      catch: (e) => e as SkillsError,
    })
    const snapshot = yield* targetSnapshot(target, options)
    const skill = yield* snapshotPortable(snapshot)
    const format = options.format ?? (/\.zip$/i.test(options.output) ? "zip" : "directory")
    const files = yield* Effect.try({
      try: () => portableFiles(skill),
      catch: (e) => e as SkillsError,
    })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const destination = path.resolve(options.output)
    let reused = false
    if (format === "zip") {
      const bytes = yield* Effect.try({
        try: () => portableZip(skill),
        catch: (e) => e as SkillsError,
      })
      const store = yield* Store
      reused = (yield* store.output(destination, bytes)).reused
    } else {
      const exists = yield* fs.exists(destination)
      if (exists) {
        const names = yield* fs
          .readDirectory(destination, { recursive: true })
          .pipe(
            Effect.mapError(() =>
              fail("OUTPUT_CONFLICT", "Output is not an identical Skill directory."),
            ),
          )
        const existing: string[] = []
        for (const name of names)
          if ((yield* fs.stat(path.join(destination, name))).type !== "Directory")
            existing.push(name.split(path.sep).join("/"))
        if (
          JSON.stringify(existing.sort()) !== JSON.stringify(files.map((file) => file.path).sort())
        )
          return yield* Effect.fail(
            fail("OUTPUT_CONFLICT", "Output directory contains different files."),
          )
        for (const file of files) {
          const old = yield* fs.readFile(path.join(destination, normalizePath(file.path)))
          if ((yield* sha256(old)) !== (yield* sha256(file.bytes)))
            return yield* Effect.fail(
              fail("OUTPUT_CONFLICT", "Existing output file differs.", { path: file.path }),
            )
        }
        reused = true
      } else {
        yield* fs.makeDirectory(destination, { mode: 0o700 })
        for (const file of files) {
          const output = path.join(destination, normalizePath(file.path))
          yield* fs.makeDirectory(path.dirname(output), { recursive: true, mode: 0o700 })
          yield* fs.writeFile(output, file.bytes, { flag: "wx", mode: 0o600 })
        }
      }
    }
    return {
      ...snapshotInfo(snapshot),
      operation: "export",
      format,
      output: destination,
      reused,
      content_id: yield* portableIdentity(skill),
      main_path: skill.main,
      files: files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "OUTPUT_FAILED",
            "Could not write the Skill export; inspect output before retrying.",
            { output: options.output },
          ),
    ),
  )
}
