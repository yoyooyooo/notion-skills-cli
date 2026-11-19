import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { Command } from "effect/cli"
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareCurrentImport } from "../src/commands-current-import.ts"
import { currentImportCommand } from "../src/commands-current-import.ts"
import { commandSchema } from "../../core/src/command-schema.ts"
import { exportSkill } from "../../core/src/export.ts"
import { property } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { queryCurrentSkillIndex } from "../../core/src/shared-current-index.ts"
import { writeCurrentSkill } from "../../core/src/shared-current-write.ts"
import { readSkill } from "../../core/src/snapshot.ts"
import { currentWriteFixture, library } from "../../core/test/shared-current-write-fixture.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const root = async () => realpath(await mkdtemp(join(tmpdir(), "ntn-cli-import-")))
const run = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const original = encode(
  "\uFEFF---\r\nname: Original\r\ndescription: Exact bytes\r\n---\r\n# Body\r\n",
)
const nativeHeader = "\uFEFF---\r\nname: Native\r\ndescription: Notion authoring\r\n---\r\n\r\n"
const nativeBody = "# Native\n\nRead [guide](references/guide.txt).\n"
const nativeMain = encode(nativeHeader + nativeBody)
const nativeGuide = encode("# Guide\n\nEditable text without an extension restriction.\n")
const nativePaths = ["SKILL.md", "references/guide.txt"]
async function nativeInput() {
  const parent = await root(),
    directory = join(parent, "input")
  await mkdir(join(directory, "references"), { recursive: true })
  await mkdir(join(directory, "scripts"))
  await writeFile(join(directory, "SKILL.md"), nativeMain)
  await writeFile(join(directory, "references/guide.txt"), nativeGuide)
  await writeFile(join(directory, "scripts/run.bin"), new Uint8Array([0, 255, 3]))
  await chmod(join(directory, "scripts/run.bin"), 0o755)
  return { parent, directory }
}

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
  await writeFile(
    file,
    "---\nname: Single\ndescription: Native single file\n---\n# Native single file\n",
  )
  const native = await run(prepareCurrentImport(file, { skillId: "single", native: ["SKILL.md"] }))
  expect(native.plan.files[0]).toMatchObject({ path: "SKILL.md", kind: "native" })
  await expect(
    run(prepareCurrentImport(file, { skillId: "single", native: ["original.md"] })),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "unknown_path" } })
})

test("explicit native paths preserve exact input and participate in the operation fingerprint", async () => {
  const { directory } = await nativeInput()
  const options = { skillId: "native-skill", native: nativePaths }
  const resource = await run(prepareCurrentImport(directory, { skillId: options.skillId })),
    native = await run(prepareCurrentImport(directory, options)),
    reordered = await run(
      prepareCurrentImport(directory, { ...options, native: [...nativePaths].reverse() }),
    )
  expect(native.plan.files.map((file) => [file.path, file.kind, file.mode])).toEqual([
    ["SKILL.md", "native", "100644"],
    ["references/guide.txt", "native", "100644"],
    ["scripts/run.bin", "resource", "100755"],
  ])
  expect(native.plan.files[0]).toMatchObject({
    bytes: nativeMain,
    markdown: nativeBody,
    content: { kind: "native", frontmatter: nativeHeader, mode: "100644" },
  })
  expect(native.plan.files.map((file) => file.bytes)).toEqual(
    resource.plan.files.map((file) => file.bytes),
  )
  expect(native.plan.input_sha256).not.toBe(resource.plan.input_sha256)
  expect(reordered.plan.input_sha256).toBe(native.plan.input_sha256)
})

test("unknown, nonexact and duplicate native paths fail complete local admission", async () => {
  const { directory } = await nativeInput()
  for (const native of [
    ["missing.md"],
    ["./SKILL.md"],
    ["../SKILL.md"],
    [join(directory, "SKILL.md")],
    ["references/*.txt"],
    ["SKILL.md", "SKILL.md"],
  ])
    await expect(
      run(prepareCurrentImport(directory, { skillId: "native-skill", native })),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: native.length === 2 ? "duplicate" : "unknown_path" },
    })
})

test("native body rejection never normalizes arbitrary resource bytes", async () => {
  const directory = await root()
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: Main\ndescription: Exact bytes\n---\n# Main\n",
  )
  for (const bytes of [
    encode("# CRLF\r\n"),
    encode("\uFEFF# BOM\n"),
    encode("# Control\u0000\n"),
    new Uint8Array([0xff, 0xfe, 0x41]),
  ]) {
    await writeFile(join(directory, "notes.dat"), bytes)
    const resource = await run(prepareCurrentImport(directory, { skillId: "exact" }))
    expect(resource.plan.files.find((file) => file.path === "notes.dat")?.bytes).toEqual(bytes)
    await expect(
      run(prepareCurrentImport(directory, { skillId: "exact", native: ["notes.dat"] })),
    ).rejects.toMatchObject({ code: "CURRENT_WRITE_INPUT_INVALID" })
    expect(new Uint8Array(await readFile(join(directory, "notes.dat")))).toEqual(bytes)
  }
})

test("the public parser accepts repeatable native flags and rejects duplicates before Notion access", async () => {
  const { parent, directory } = await nativeInput(),
    f = currentWriteFixture(parent)
  await expect(
    f.run(
      Command.runWith(currentImportCommand, { version: "test", renderErrors: false })([
        directory,
        "--entry",
        library.skills.database_id,
        "--skill-id",
        "native-skill",
        "--native",
        "SKILL.md",
        "--native",
        "SKILL.md",
        "--dry-run",
      ]),
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "duplicate" } })
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})

test("mixed CLI import writes editable native bodies, reads and exports exact files, and repeats without writes", async () => {
  const { parent, directory } = await nativeInput(),
    f = currentWriteFixture(parent)
  const prepared = await f.run(
    prepareCurrentImport(directory, { skillId: "native-skill", native: nativePaths }),
  )
  const written = await f.run(
    writeCurrentSkill(library, { plan: prepared.plan, operation_id: "native-import" }),
  )
  expect(written).toMatchObject({ status: "applied", state: "ready", files: 3 })
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  expect([index.main, ...index.files].map((file) => [file.path, file.content.kind])).toEqual([
    ["SKILL.md", "native"],
    ["references/guide.txt", "native"],
    ["scripts/run.bin", "resource"],
  ])
  const writes = f.calls.filter(
    (call) => call.method === "PATCH" && call.path.endsWith("/markdown"),
  )
  expect(writes.map((call) => property(property(call.body).replace_content).new_str)).toEqual([
    nativeBody,
    new TextDecoder().decode(nativeGuide),
  ])
  for (const write of writes)
    expect(
      f.calls
        .slice(f.calls.indexOf(write) + 1)
        .some((call) => call.method === "GET" && call.path.startsWith(write.path)),
    ).toBe(true)
  f.clearCalls()
  const main = await f.run(
      readSkill(written.page_id, { database: library.skills.database_id, refresh: true }),
    ),
    guide = await f.run(
      readSkill(written.page_id, {
        database: library.skills.database_id,
        path: "references/guide.txt",
      }),
    )
  expect(main).toMatchObject({ content: nativeHeader + nativeBody })
  expect(guide).toMatchObject({ content: new TextDecoder().decode(nativeGuide) })
  const output = join(parent, "exported")
  await f.run(
    exportSkill(written.page_id, {
      database: library.skills.database_id,
      output,
      format: "directory",
    }),
  )
  for (const file of prepared.plan.files) {
    expect(new Uint8Array(await readFile(join(output, file.path)))).toEqual(
      new Uint8Array(file.bytes),
    )
    expect(((await stat(join(output, file.path))).mode & 0o111) !== 0).toBe(file.mode === "100755")
  }
  expect(f.mutations()).toEqual([])
  f.clearCalls()
  expect(
    await f.run(writeCurrentSkill(library, { plan: prepared.plan, operation_id: "native-noop" })),
  ).toMatchObject({ status: "unchanged", state: "ready" })
  expect(f.mutations()).toEqual([])

  const humanBody = "# Edited in Notion\n\nRead [guide](references/guide.txt).\n"
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${written.page_id}/markdown`,
        {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: humanBody },
        },
        { method: "PATCH" },
      ),
    ),
  )
  f.clearCalls()
  expect(
    await f.run(
      readSkill(written.page_id, { database: library.skills.database_id, refresh: true }),
    ),
  ).toMatchObject({ content: nativeHeader + humanBody })
  expect(f.mutations()).toEqual([])
  expect(
    await f.run(
      writeCurrentSkill(library, { plan: prepared.plan, operation_id: "explicit-replacement" }),
    ),
  ).toMatchObject({ status: "applied", state: "ready" })
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(1)
  expect(
    await f.run(
      readSkill(written.page_id, { database: library.skills.database_id, refresh: true }),
    ),
  ).toMatchObject({ content: nativeHeader + nativeBody })
})

test("a changed native round-trip remains pending and a resume cannot change native selection", async () => {
  const { parent, directory } = await nativeInput(),
    f = currentWriteFixture(parent)
  const prepared = await f.run(
    prepareCurrentImport(directory, { skillId: "native-skill", native: nativePaths }),
  )
  let bodyWritten = false
  const failed = f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* writeCurrentSkill(library, {
        plan: prepared.plan,
        operation_id: "native-roundtrip",
      }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.map((response) => {
                if (options?.method === "PATCH" && path.endsWith("/markdown")) bodyWritten = true
                if (
                  bodyWritten &&
                  (options?.method ?? "GET") === "GET" &&
                  path.includes("/markdown")
                )
                  return { ...property(response), markdown: "Notion changed the representation.\n" }
                return response
              }),
            ),
        }),
      )
    }),
  )
  await expect(failed).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
    details: { cause_code: "CURRENT_NATIVE_ROUNDTRIP" },
  })
  const page = String(f.table("skills")[0]!.id),
    pending = structuredClone(
      [...f.json].filter(([key]) => key.startsWith("operations/current-write-pending/")),
    )
  expect(pending).toHaveLength(1)
  expect((await f.run(queryCurrentSkillIndex(library, page))).state).toEqual({
    state: "applying",
    operation_id: "native-roundtrip",
  })
  await expect(
    f.run(readSkill(page, { database: library.skills.database_id, refresh: true })),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })

  const resource = await f.run(prepareCurrentImport(directory, { skillId: "native-skill" }))
  f.clearCalls()
  await expect(
    f.run(
      writeCurrentSkill(library, {
        plan: resource.plan,
        operation_id: "native-roundtrip",
        mode: "resume",
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
  expect(f.mutations()).toEqual([])
  expect(
    [...f.json].filter(([key]) => key.startsWith("operations/current-write-pending/")),
  ).toEqual(pending)
  expect(
    await f.run(
      writeCurrentSkill(library, {
        plan: prepared.plan,
        operation_id: "native-roundtrip",
        mode: "resume",
      }),
    ),
  ).toMatchObject({ state: "ready" })
  expect(
    [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
  ).toEqual([])
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
  await writeFile(join(directory, "PROMPT.md"), "# Editable prompt\n")
  const native = await run(
    prepareCurrentImport(directory, { skillId: "prompt-id", native: ["PROMPT.md"] }),
  )
  expect(native.plan.main).toBe("PROMPT.md")
  expect(native.plan.files[0]).toMatchObject({ kind: "native", markdown: "# Editable prompt\n" })
  expect(native.plan.files[1]).toMatchObject({ path: "empty", kind: "resource" })
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
    parameters: {
      name: string
      primitive: string
      description: string
      min_occurrences: number
      max_occurrences: number | null
    }[]
  }
  expect(value.parameters.find((parameter) => parameter.name === "native")).toMatchObject({
    primitive: "String",
    min_occurrences: 0,
    max_occurrences: null,
    description: expect.stringContaining("exact final input path"),
  })
  for (const name of ["max-requests", "max-bytes", "timeout"]) {
    const parameter = value.parameters.find((parameter) => parameter.name === name)!
    expect(parameter.primitive).toBe("Int")
    expect(parameter.description).toContain("Positive")
  }
  expect(value.parameters.find((parameter) => parameter.name === "timeout")?.description).toContain(
    "ms",
  )
})

test("current import rejects ambiguous supersede identities before input or remote acquisition", async () => {
  const directory = await root(),
    f = currentWriteFixture(directory)
  const base = ["missing.md", "--entry", library.skills.database_id, "--skill-id", "import-target"]
  for (const flags of [
    ["--supersede", "old-intent"],
    ["--supersede", "same-intent", "--operation", "same-intent"],
    ["--supersede", "old-intent", "--operation", "new-intent", "--resume"],
    ["--supersede", "old-intent", "--operation", "new-intent", "--dry-run"],
  ])
    await expect(
      f.run(Command.runWith(currentImportCommand, { version: "0" })([...base, ...flags])),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  await expect(
    f.run(
      Command.runWith(currentImportCommand, { version: "0" })([
        ...base,
        "--supersede",
        "invalid operation",
        "--operation",
        "new-intent",
      ]),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_WRITE_INPUT_INVALID" })
  expect(f.calls).toEqual([])
  expect(f.pages.size).toBe(0)
})
