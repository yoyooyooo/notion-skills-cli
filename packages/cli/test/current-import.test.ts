import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCurrentImport } from "../src/commands-current-import.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const root = async () => realpath(await mkdtemp(join(tmpdir(), "ntn-cli-import-")))
const run = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const original = encode(
  "\uFEFF---\r\nname: Original\r\ndescription: Exact bytes\r\n---\r\n# Body\r\n",
)

test("current CLI import prepares a complete resource tree without requiring Notion or changing source bytes", async () => {
  const directory = await root()
  await mkdir(join(directory, "scripts"))
  await writeFile(join(directory, "SKILL.md"), original)
  await writeFile(join(directory, "scripts/run.bin"), new Uint8Array([0, 255, 3]))
  await chmod(join(directory, "scripts/run.bin"), 0o755)
  const prepared = await run(
    prepareCurrentImport(directory, { skillId: "exact-skill", name: "Display name" }),
  )
  expect(prepared.plan.skill_id).toBe("exact-skill")
  expect(prepared.plan.name).toBe("Display name")
  expect(prepared.plan.description).toBe("Exact bytes")
  expect(prepared.plan.files.map((file) => [file.path, file.kind, file.mode])).toEqual([
    ["SKILL.md", "resource", "100644"],
    ["scripts/run.bin", "resource", "100755"],
  ])
  expect(prepared.plan.files[0]!.bytes).toEqual(original)
  expect(prepared.plan.files[1]!.bytes).toEqual(new Uint8Array([0, 255, 3]))
  expect(prepared.input).toEqual({
    kind: "directory",
    files: 2,
    bytes: original.length + 3,
    entrypoint: "SKILL.md",
  })
})

test("only an explicitly selected single Markdown file is renamed to SKILL.md", async () => {
  const directory = await root()
  const file = join(directory, "original.md")
  await writeFile(file, original)
  const prepared = await run(prepareCurrentImport(file, { skillId: "single" }))
  expect(prepared.plan.files).toHaveLength(1)
  expect(prepared.plan.files[0]!.path).toBe("SKILL.md")
  expect(prepared.plan.files[0]!.bytes).toEqual(original)
  expect(prepared.input.renamed_entrypoint_from).toBe("original.md")
  await expect(
    run(prepareCurrentImport(directory, { skillId: "directory" })),
  ).rejects.toMatchObject({ code: "CURRENT_IMPORT_ENTRYPOINT" })
})

test("current portable metadata selects its canonical kind and preserves the whole original file tree", async () => {
  const directory = await root()
  await writeFile(join(directory, "PROMPT.md"), "Exact prompt\r\n")
  await writeFile(join(directory, "empty"), new Uint8Array())
  await writeFile(
    join(directory, ".ntn-skills.json"),
    JSON.stringify({
      format: "ntn-skills",
      version: 2,
      kind: "prompt",
      name: "A prompt",
      description: "Use this prompt",
      main: "PROMPT.md",
    }),
  )
  const prepared = await run(prepareCurrentImport(directory, { skillId: "prompt-id" }))
  expect(prepared.plan.kind).toBe("prompt")
  expect(prepared.plan.main).toBe("PROMPT.md")
  expect(prepared.plan.files.map((file) => file.path)).toEqual(["PROMPT.md", "empty"])
  expect(prepared.plan.files[0]!.bytes).toEqual(encode("Exact prompt\r\n"))
})

test("unsupported portable semantics are rejected explicitly instead of discarding relation or projection intent", async () => {
  const directory = await root()
  await writeFile(join(directory, "SKILL.md"), original)
  const base = {
    format: "ntn-skills",
    version: 2,
    kind: "skill",
    name: "Original",
    description: "Exact bytes",
    main: "SKILL.md",
  }
  for (const extra of [
    { relations: { version: 1, ownership: "notion", library_id: "library", requires: [] } },
    { projection: { name: "Other", description: "Other", body: "generated" } },
    { future_authority: "unknown" },
    { version: 1 },
  ]) {
    await writeFile(join(directory, ".ntn-skills.json"), JSON.stringify({ ...base, ...extra }))
    await expect(
      run(prepareCurrentImport(directory, { skillId: "portable" })),
    ).rejects.toMatchObject({ code: "CURRENT_IMPORT_UNSUPPORTED" })
  }
  await writeFile(join(directory, "different.md"), original)
  await writeFile(
    join(directory, ".ntn-skills.json"),
    JSON.stringify({ ...base, main: "different.md" }),
  )
  await expect(run(prepareCurrentImport(directory, { skillId: "portable" }))).rejects.toMatchObject(
    { code: "CURRENT_IMPORT_ENTRYPOINT" },
  )
})
