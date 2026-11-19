import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Path } from "effect"
import { chmod, mkdir, mkdtemp, open, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync } from "fflate"
import { loadImport } from "../src/import.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const root = async () => realpath(await mkdtemp(join(tmpdir(), "ntn-current-import-")))
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

test("complete directory admission preserves hidden files, original bytes, empty files and executable mode", async () => {
  const directory = await root()
  await mkdir(join(directory, "scripts"))
  const main = encode(
    "\uFEFF---\r\nname: exact\r\ndescription: Keep original bytes\r\n---\r\nBody\r\n",
  )
  const script = encode("#!/bin/sh\nexit 0\n")
  const binary = new Uint8Array([0, 255, 128, 13, 10])
  await Promise.all([
    writeFile(join(directory, "SKILL.md"), main),
    writeFile(join(directory, "scripts/run.sh"), script),
    writeFile(join(directory, ".authored"), binary),
    writeFile(join(directory, "empty"), new Uint8Array()),
    writeFile(join(directory, ".DS_Store"), "Finder cache"),
  ])
  await chmod(join(directory, "scripts/run.sh"), 0o755)
  const result = await run(loadImport(directory))
  expect(result.kind).toBe("directory")
  expect(result.files).toEqual([
    { path: ".authored", bytes: binary, mode: "100644" },
    { path: "SKILL.md", bytes: main, mode: "100644" },
    { path: "empty", bytes: new Uint8Array(), mode: "100644" },
    { path: "scripts/run.sh", bytes: script, mode: "100755" },
  ])
})

test("input roots, ancestors, files and directories never follow symlinks", async () => {
  const directory = await root()
  const actual = join(directory, "actual")
  await mkdir(actual)
  await writeFile(join(actual, "SKILL.md"), "original")
  await symlink(actual, join(directory, "linked-root"))
  await symlink(directory, join(directory, "linked-parent"))
  for (const input of [join(directory, "linked-root"), join(directory, "linked-parent/actual")])
    await expect(run(loadImport(input))).rejects.toMatchObject({ code: "INVALID_INPUT" })
  for (const type of ["file", "directory"] as const) {
    const selected = join(directory, type)
    await mkdir(selected)
    await writeFile(join(selected, "SKILL.md"), "selected")
    await symlink(type === "file" ? join(actual, "SKILL.md") : actual, join(selected, "linked"))
    await expect(run(loadImport(selected))).rejects.toMatchObject({ code: "INVALID_INPUT" })
  }
  await symlink(join(actual, "SKILL.md"), join(directory, "linked.md"))
  await expect(run(loadImport(join(directory, "linked.md")))).rejects.toMatchObject({
    code: "INVALID_INPUT",
  })
})

test("directory limits reject aggregate sparse bytes and too many entries before opening content", async () => {
  const directory = await root()
  for (const name of ["first.bin", "second.bin"]) {
    const file = await open(join(directory, name), "w")
    try {
      await file.truncate(70 * 1024 * 1024)
    } finally {
      await file.close()
    }
  }
  await expect(run(loadImport(directory))).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE" })
  const empty = await root()
  await expect(
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* loadImport(empty).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (path, options) =>
              path === empty
                ? Effect.succeed(Array.from({ length: 10001 }, (_, index) => `entry-${index}`))
                : fs.readDirectory(path, options),
          }),
        )
      }),
    ),
  ).rejects.toMatchObject({ code: "ARCHIVE_TOO_LARGE" })
})

test("a file added while the complete tree is being read rejects the whole input", async () => {
  const directory = await root()
  await writeFile(join(directory, "SKILL.md"), "original")
  let observations = 0
  await expect(
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* loadImport(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (path, options) =>
              Effect.gen(function* () {
                if (path === directory && ++observations === 2)
                  yield* Effect.promise(() => writeFile(join(directory, "added.txt"), "concurrent"))
                return yield* fs.readDirectory(path, options)
              }),
          }),
        )
      }),
    ),
  ).rejects.toMatchObject({ code: "INPUT_CHANGED" })
})

test("an already-read file changed during a later read cannot produce a mixed import tree", async () => {
  const directory = await root()
  const main = join(directory, "SKILL.md")
  const later = join(directory, "later.txt")
  await writeFile(main, "original")
  await writeFile(later, "later")
  await expect(
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* loadImport(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path, options) =>
              Effect.gen(function* () {
                if (path === later) yield* Effect.promise(() => writeFile(main, "modified"))
                return yield* fs.open(path, options)
              }),
          }),
        )
      }),
    ),
  ).rejects.toMatchObject({ code: "INPUT_CHANGED" })
})

test("single Markdown and ZIP admission retain mode while ZIP paths remain unchanged", async () => {
  const directory = await root()
  const markdown = join(directory, "named.md")
  const body = encode("# Exact\r\n")
  await writeFile(markdown, body)
  await chmod(markdown, 0o755)
  expect((await run(loadImport(markdown))).files).toEqual([
    { path: "named.md", bytes: body, mode: "100755" },
  ])
  const archive = join(directory, "skill.zip")
  await writeFile(
    archive,
    zipSync({
      "SKILL.md": [body, { os: 3, attrs: (0o100644 << 16) >>> 0 }],
      "scripts/run.sh": [encode("exit 0\n"), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    }),
  )
  expect((await run(loadImport(archive))).files).toEqual([
    { path: "scripts/run.sh", bytes: encode("exit 0\n"), mode: "100755" },
    { path: "SKILL.md", bytes: body, mode: "100644" },
  ])
})
