import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { convertPath, convertPortable } from "../src/converter.ts"
import { readPortable } from "../../core/src/portable.ts"
import { readImportZip } from "../../core/src/import.ts"
const encode = (value: string) => new TextEncoder().encode(value)
const fixture = () => [
  {
    path: ".ntn-skills.json",
    bytes: encode(
      JSON.stringify({
        format: "ntn-skills",
        version: 1,
        name: "Portable Conversion",
        description: "Preserve all bytes",
        main: "workflow.md",
        projection: {
          name: "Portable Conversion",
          description: "Preserve all bytes",
          body: "Read guide",
          references: { "references/guide.md": "Reference bytes" },
        },
      }),
    ),
  },
  { path: "workflow.md", bytes: encode("# Read guide\n") },
  { path: "references/guide.md", bytes: encode("Reference bytes\n") },
  { path: "assets/raw.bin", bytes: new Uint8Array([0, 255, 254, 128, 1]) },
]
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
test("independent converter preserves original FS bytes, main, references and binary hashes; normal consumes only v2", async () => {
  const root = await mkdtemp(join(tmpdir(), "portable-cutover-"))
  try {
    const input = join(root, "input")
    await mkdir(input)
    for (const file of fixture()) {
      await mkdir(join(input, file.path, ".."), { recursive: true })
      await writeFile(join(input, file.path), file.bytes)
    }
    expect(() => readPortable(fixture())).toThrow(
      expect.objectContaining({ code: "PORTABLE_UPGRADE_REQUIRED" }),
    )
    const output = join(root, "output")
    const audit = await Effect.runPromise(
      convertPath(input, output).pipe(Effect.provide(NodeServices.layer)),
    )
    expect(audit.kind_selection).toBe("audited-default-skill")
    const restored = readPortable(readImportZip(await readFile(join(output, "converted.zip"))))!
    expect(restored.kind).toBe("skill")
    expect(restored.main).toBe("workflow.md")
    expect(restored.projection?.references).toEqual({ "references/guide.md": "Reference bytes" })
    for (const file of fixture()) {
      expect(hash(await readFile(join(input, file.path)))).toBe(hash(file.bytes))
      if (file.path !== ".ntn-skills.json")
        expect(hash(restored.files.find((item) => item.path === file.path)!.bytes)).toBe(
          hash(file.bytes),
        )
    }
    const bad = join(root, "bad")
    await mkdir(bad)
    await writeFile(
      join(bad, ".ntn-skills.json"),
      JSON.stringify({ format: "ntn-skills", version: 1, main: "missing.md" }),
    )
    await expect(
      Effect.runPromise(
        convertPath(bad, join(root, "rejected")).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).rejects.toThrow()
    await expect(stat(join(root, "rejected"))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("converter rejects incomplete manifest, duplicate manifest and absent main; explicit kind is audited", () => {
  expect(() => convertPortable(fixture().filter((file) => file.path !== "workflow.md"))).toThrow()
  expect(() => convertPortable([...fixture(), fixture()[0]!])).toThrow()
  expect(convertPortable(fixture(), "prompt").kindSelection).toBe("explicit")
})
