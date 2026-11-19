import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCurrentImport } from "../src/commands-current-import.ts"
import { currentImportCommand } from "../src/commands-current-import.ts"
import { commandSchema } from "../../core/src/command-schema.ts"

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

test("unsupported projection and unknown portable semantics are rejected instead of discarded", async () => {
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

test("current portable relations survive local admission and invalid selections fail locally", async () => {
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
  const relations = {
    version: 1 as const,
    ownership: "notion" as const,
    library_id: "library",
    members: [],
    requires: ["shared_skill:library:target"],
  }
  await writeFile(join(directory, ".ntn-skills.json"), JSON.stringify({ ...base, relations }))
  const admitted = await run(prepareCurrentImport(directory, { skillId: "portable" }))
  expect(admitted.plan.relations).toEqual(relations)
  expect(admitted.plan.files[0]!.bytes).toEqual(original)
  for (const extra of [
    { requires: ["Display name"] },
    { requires: ["shared_skill:other:target"] },
    { requires: ["shared_skill:library:portable"] },
    { requires: ["shared_skill:library:target", "shared_skill:library:target"] },
    { future_relation: [] },
  ]) {
    await writeFile(
      join(directory, ".ntn-skills.json"),
      JSON.stringify({ ...base, relations: { ...relations, ...extra } }),
    )
    await expect(
      run(prepareCurrentImport(directory, { skillId: "portable" })),
    ).rejects.toBeDefined()
  }
  await writeFile(join(directory, "PROMPT.md"), original)
  await writeFile(
    join(directory, ".ntn-skills.json"),
    JSON.stringify({ ...base, kind: "prompt", main: "PROMPT.md", relations }),
  )
  await expect(run(prepareCurrentImport(directory, { skillId: "portable" }))).rejects.toMatchObject(
    { code: "CURRENT_RELATION_INVALID" },
  )
})

test("the import machine schema exposes bounded integer HTTP controls and timeout units", () => {
  const value = commandSchema(currentImportCommand) as {
    parameters: { name: string; primitive: string; description: string }[]
  }
  for (const name of ["max-requests", "max-bytes", "timeout"]) {
    const parameter = value.parameters.find((parameter) => parameter.name === name)!
    expect(parameter.primitive).toBe("Int")
    expect(parameter.description).toContain("Positive")
  }
  expect(value.parameters.find((parameter) => parameter.name === "timeout")?.description).toContain(
    "ms",
  )
})
