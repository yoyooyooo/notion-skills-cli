import { Effect, FileSystem, Path } from "effect"
import type { ReadPolicyOptions } from "./cache.ts"
import type { ImportFile } from "./import.ts"
import type { Snapshot } from "./model.ts"
import { fail, SkillsError, snapshotMembers } from "./model.ts"
import type { PortableSkill } from "./portable.ts"
import { fileOrder, MANIFEST, portableFiles, portableZip } from "./portable.ts"
import { normalizePath, parseTarget } from "./ref.ts"
import { snapshotInfo, targetSnapshot } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"

export function snapshotPortable(snapshot: Snapshot) {
  return Effect.gen(function* () {
    if (snapshot.record.locator.type !== "shared_skill" && snapshot.record.locator.type !== "local")
      return yield* Effect.fail(
        fail(
          "CURRENT_TARGET_REQUIRED",
          "Export requires a current Skill or an explicitly selected local file tree.",
        ),
      )
    const store = yield* Store
    const files: ImportFile[] = []
    for (const file of snapshot.files) {
      const bytes = yield* store.readBytes(`objects/${file.sha256}`)
      if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Export file failed its checksum.", { path: file.path }),
        )
      files.push({
        path: file.path,
        bytes,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      })
    }
    return snapshotRelations(snapshot, {
      kind: snapshot.record.kind,
      name: snapshot.record.name,
      description: snapshot.record.description,
      main: snapshot.entrypoint,
      files,
    })
  })
}

function snapshotRelations(snapshot: Snapshot, portable: PortableSkill): PortableSkill {
  if (snapshot.record.locator.type !== "shared_skill" || snapshot.record.kind === "prompt")
    return portable
  const members = snapshotMembers(snapshot),
    required = snapshot.required
  if (members === undefined && required === undefined) return portable
  return {
    ...portable,
    relations: {
      version: 1,
      ownership: "notion",
      library_id: snapshot.record.locator.library_id,
      ...(members === undefined ? {} : { members: members.map((target) => target.id) }),
      ...(required === undefined ? {} : { requires: required.map((target) => target.id) }),
    },
  }
}

export function portableIdentity(skill: PortableSkill) {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => portableFiles(skill), catch: (error) => error as SkillsError })
    const files: Array<[string, string, string]> = []
    for (const file of [...skill.files].sort(fileOrder)) {
      files.push([file.path, yield* sha256(file.bytes), file.mode ?? "100644"])
    }
    return yield* sha256(
      JSON.stringify([
        skill.kind,
        skill.name,
        skill.description,
        skill.main,
        files,
        skill.relations ?? null,
      ]),
    )
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
      catch: (error) => error as SkillsError,
    })
    const snapshot = yield* targetSnapshot(target, options)
    const skill = yield* snapshotPortable(snapshot)
    const exported = yield* exportPortable(skill, options)
    return { ...snapshotInfo(snapshot), ...exported }
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

export function exportPortable(
  skill: PortableSkill,
  options: Pick<ExportOptions, "output" | "format">,
) {
  return Effect.gen(function* () {
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
          const executable =
            ((yield* fs.stat(path.join(destination, normalizePath(file.path)))).mode & 0o111) !== 0
          if (
            (yield* sha256(old)) !== (yield* sha256(file.bytes)) ||
            (file.mode !== undefined && executable !== (file.mode === "100755"))
          )
            return yield* Effect.fail(
              fail("OUTPUT_CONFLICT", "Existing output file differs.", {
                path: file.path,
              }),
            )
        }
        reused = true
      } else {
        yield* fs.makeDirectory(destination, { mode: 0o700 })
        for (const file of files) {
          const output = path.join(destination, normalizePath(file.path))
          yield* fs.makeDirectory(path.dirname(output), {
            recursive: true,
            mode: 0o700,
          })
          yield* fs.writeFile(output, file.bytes, {
            flag: "wx",
            mode: file.mode === "100755" ? 0o700 : 0o600,
          })
        }
      }
    }
    const inventory = []
    for (const file of files)
      inventory.push({
        path: file.path,
        bytes: file.bytes.length,
        hash: yield* sha256(file.bytes),
        ...(file.mode === undefined ? {} : { mode: file.mode }),
        role:
          file.path === MANIFEST
            ? "manifest"
            : file.path === skill.main
              ? "entrypoint"
              : "resource",
      })
    return {
      operation: "export",
      format,
      output: destination,
      reused,
      content_id: yield* portableIdentity(skill),
      main_path: skill.main,
      entrypoint: skill.main,
      projection: "snapshot" as const,
      files: inventory,
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
