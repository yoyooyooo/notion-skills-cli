import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { property } from "../packages/core/src/model.ts"
import { librarySchemaResponse } from "../packages/core/test/library-schema-fixture.ts"
import { currentLibrary } from "../packages/core/test/shared-current-fixture.ts"
const { startSdkSourceFixture } = await import(
  new URL("./sdk-source-fixture.mjs", import.meta.url).href
)

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    archive: { type: "string" },
    registry: { type: "string" },
    runtime: { type: "string" },
  },
  strict: true,
})
assert.notEqual(
  Boolean(values.archive),
  Boolean(values.registry),
  "Select exactly one --archive or --registry",
)
if (values.registry) assert.match(values.registry, /^ntn-skills@\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu)
const evidenceRoot = process.env.NTN_SMOKE_EVIDENCE_ROOT
if (evidenceRoot) {
  assert.ok(isAbsolute(evidenceRoot))
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 })
}
const scratch = await realpath(
  await mkdtemp(join(evidenceRoot ?? tmpdir(), "ntn-skills-consumer-")),
)
const runtimeCommand = values.runtime ? resolve(values.runtime) : Bun.which("node")
assert.ok(runtimeCommand, "A supported Node.js runtime is required")
const runtime = Bun.spawnSync([runtimeCommand, "--print", "process.execPath"], { stdin: "ignore" })
  .stdout.toString()
  .trim()
assert.ok(isAbsolute(runtime))
const env = {
  ...process.env,
  PATH: `${dirname(runtime)}:${process.env.PATH ?? ""}`,
  NTN_SKILLS_DEV_ROOT: undefined,
  NOTION_API_TOKEN: "",
  NOTION_WORKSPACE_ID: "",
  NOTION_API_BASE_URL: "http://127.0.0.1:9",
  HOME: join(scratch, "home"),
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  XDG_DATA_HOME: join(scratch, "data"),
  NTN_SKILLS_NOTION_INTERVAL_MS: "100",
  NTN_SKILLS_SCHEDULER_ROOT: join(scratch, "scheduler"),
}
async function run(argv: string[], expectedExit = 0) {
  const child = Bun.spawn(argv, {
    cwd: scratch,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, expectedExit, `${argv.join(" ")}: ${stderr || stdout}`)
  return stdout
}
await writeFile(
  join(scratch, "package.json"),
  JSON.stringify({
    private: true,
    dependencies: {
      "ntn-skills": values.archive
        ? `file:${resolve(values.archive)}`
        : values.registry!.slice("ntn-skills@".length),
    },
  }) + "\n",
)
await run(["npm", "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"])
const installed = join(scratch, "node_modules/ntn-skills")
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
assert.deepEqual(Object.keys(manifest.bin), ["ntn-skills"])
const executable = join(installed, manifest.bin["ntn-skills"])
assert.equal(
  (await run([join(scratch, "node_modules/.bin/ntn-skills"), "--version"])).trim(),
  `ntn-skills v${manifest.version}`,
)
const cli = async (argv: string[], exit = 0) => {
  const value = JSON.parse(await run([runtime, executable, ...argv], exit))
  assert.equal(value.ok, exit === 0)
  return value
}
const rootSchema = await cli(["schema"])
assert.deepEqual(
  rootSchema.schema.commands.map((command: { name: string }) => command.name).sort(),
  ["auth", "ctl", "export", "files", "list", "read", "schema", "skills", "use"],
)
for (const path of [["read"], ["use"], ["files"], ["export"], ["ctl", "prepare"]]) {
  const schema = await cli(["schema", ...path])
  assert.equal(JSON.stringify(schema).includes('"name":"read-only"'), false)
}
const library = await cli(["schema", "ctl", "library"])
assert.deepEqual(library.schema.commands.map((command: { name: string }) => command.name).sort(), [
  "files",
  "import",
  "import-batch",
  "init",
  "inspect",
  "members-plan",
  "operation",
  "profile",
  "projection",
  "skill",
  "source",
])
const skillSchema = await cli(["schema", "ctl", "library", "skill"])
assert.deepEqual(
  skillSchema.schema.commands.map((command: { name: string }) => command.name).sort(),
  ["create", "register", "remove", "update"],
)
const sourceSchema = await cli(["schema", "ctl", "library", "source"])
assert.deepEqual(
  sourceSchema.schema.commands.map((command: { name: string }) => command.name).sort(),
  [
    "apply",
    "check",
    "disable",
    "enable",
    "manager",
    "materialize",
    "refresh",
    "remove",
    "restore-follow",
    "sync",
    "takeover",
  ],
)
for (const path of [
  ["create"],
  ["adopt"],
  ["apply"],
  ["write"],
  ["replace"],
  ["ctl", "operation"],
  ["ctl", "sync"],
  ["ctl", "library", "sources"],
  ["ctl", "builtin"],
])
  assert.equal((await cli(["schema", ...path], 2)).error.code, "INVALID_ARGUMENT")
const builtin = await cli(["skills", "list", "--json"])
assert.equal(builtin.count, 3)
assert.equal(
  builtin.skills.some((skill: object) => "installation" in skill),
  false,
)
assert.deepEqual((await cli(["skills", "--json"])).skills, builtin.skills)
const files = [
  [
    "ntn-skills",
    "skills/ntn-skills",
    ["SKILL.md", "references/commands.md", "references/integration.md"],
  ],
  [
    "ntn-skills-maintain",
    "skills/notion/ntn-skills-maintain",
    ["SKILL.md", "references/operations.md", "references/setup.md"],
  ],
  [
    "ntn-skills-sync",
    "skills/notion/ntn-skills-sync",
    ["SKILL.md", "references/synchronization.md"],
  ],
] as const
for (const [name, packagePath, paths] of files) {
  const directory = (await run([runtime, executable, "skills", "path", name])).trim()
  assert.equal(directory, join(installed, packagePath))
  const full = await cli(["skills", "get", name, "--full", "--json"])
  assert.deepEqual(
    full.files.map((file: { path: string }) => file.path),
    paths,
  )
  const rendered = await run([runtime, executable, "skills", "get", name, "--full"])
  for (const path of paths) {
    const expected = await readFile(join(installed, packagePath, path), "utf8")
    const read = await cli(["skills", "get", name, "--path", path, "--json"])
    assert.equal(read.content, expected)
    assert.equal(await run([runtime, executable, "skills", "get", name, "--path", path]), expected)
    assert.equal(full.files.find((file: { path: string }) => file.path === path).content, expected)
    assert.ok(rendered.includes(expected))
  }
  assert.equal(
    await run([runtime, executable, "skills", "get", name]),
    await readFile(join(directory, "SKILL.md"), "utf8"),
  )
}
assert.equal((await cli(["skills", "get", "--all", "--full", "--json"])).count, 3)
assert.equal((await run([runtime, executable, "skills", "path"])).trim(), join(installed, "skills"))
for (const command of ["list", "read", "status", "install", "update", "export"])
  assert.equal((await cli(["ctl", "builtin", command], 2)).error.code, "INVALID_ARGUMENT")
for (const directory of [
  env.NTN_SKILLS_HOME,
  env.NTN_SKILLS_CONFIG_HOME,
  env.NTN_SKILLS_CACHE_HOME,
  env.XDG_DATA_HOME,
])
  assert.equal(
    await stat(directory).then(
      () => true,
      () => false,
    ),
    false,
  )
// A real path must identify these exact package bytes, including supporting files.
const referencePath = join(installed, "skills/ntn-skills/references/commands.md")
const originalReference = await readFile(referencePath)
await writeFile(referencePath, "changed outside the package")
assert.equal(
  (await cli(["skills", "path", "ntn-skills", "--json"], 1)).error.code,
  "BUILTIN_PATH_UNAVAILABLE",
)
await writeFile(referencePath, originalReference)
await mkdir(join(scratch, "exports"))
const currentFiles = [
  {
    path: "SKILL.md",
    content:
      "---\r\nname: installed-current\r\ndescription: Installed current import lifecycle.\r\n---\r\n# Current import\r\nRead [guide](references/guide.md).\r\n",
    executable: false,
  },
  {
    path: "references/guide.md",
    content: "# Complete guide\n\n原始正文 α 😀.\r\n[Run](../scripts/run.sh)\n",
    executable: false,
  },
  {
    path: "scripts/run.sh",
    content: "#!/bin/sh\nprintf 'installed current original\\n'",
    executable: true,
  },
]
const inputDirectory = join(scratch, "current-input")
for (const file of currentFiles) {
  const target = join(inputDirectory, file.path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, file.content, { mode: file.executable ? 0o700 : 0o600, flag: "wx" })
  if (file.executable) await chmod(target, 0o700)
}
const source = await startSdkSourceFixture(
  {
    notion: {
      library: currentLibrary,
      root: librarySchemaResponse("v1/pages/" + currentLibrary.library_id, currentLibrary),
      root_children: property(
        librarySchemaResponse(
          "v1/blocks/" + currentLibrary.library_id + "/children",
          currentLibrary,
        ),
      ).results,
      databases: (["skills", "files", "records", "sources"] as const).map((role) =>
        librarySchemaResponse("v1/databases/" + currentLibrary[role].database_id, currentLibrary),
      ),
      data_sources: (["skills", "files", "records", "sources"] as const).map((role) =>
        librarySchemaResponse(
          "v1/data_sources/" + currentLibrary[role].data_source_id,
          currentLibrary,
        ),
      ),
      main: null,
      skills: [],
      files: [],
      records: [],
      sources: [],
      bodies: {},
    },
  },
  join(scratch, "current-import-requests.jsonl"),
  { allowCurrentWrites: true },
)
const semanticWrites = () =>
  source.requests.filter((call: { semantic_write?: boolean }) => call.semantic_write === true)
    .length
let currentImport
let currentProjection
try {
  env.NOTION_API_TOKEN = "current-cli-owned-token"
  env.NOTION_API_BASE_URL = source.origin
  const importArgs = [
    "ctl",
    "library",
    "import",
    inputDirectory,
    "--library",
    currentLibrary.library_id,
    "--skill-id",
    "installed-current",
    "--native",
    "scripts/run.sh",
  ]
  const inspected = await cli([...importArgs, "--dry-run"])
  assert.equal(inspected.dry_run, true)
  assert.equal(inspected.remote_writes, 0)
  assert.equal(inspected.input.files, currentFiles.length)
  assert.equal(semanticWrites(), 0)
  const beforeRejectedLibrary = source.requests.length
  for (const entry of [
    `notion_page:${currentLibrary.skills.database_id}`,
    `ftp://www.notion.so/${currentLibrary.skills.database_id.replaceAll("-", "")}`,
  ]) {
    const invalidLibrary = [...importArgs]
    invalidLibrary[5] = entry
    assert.equal((await cli(invalidLibrary, 2)).error.code, "INVALID_ARGUMENT")
  }
  for (const removed of ["--entry", "--database"]) {
    const invalidLibrary = [...importArgs]
    invalidLibrary[4] = removed
    assert.equal((await cli(invalidLibrary, 2)).error.code, "INVALID_ARGUMENT")
  }
  assert.equal(source.requests.length, beforeRejectedLibrary)
  const beforeBudget = source.requests.length
  const limited = await cli([...importArgs, "--dry-run", "--max-requests", "1"], 1)
  assert.equal(limited.error.code, "REQUEST_BUDGET_EXHAUSTED")
  assert.equal(limited.error.details.budget.attempts, 1)
  assert.equal(source.requests.length - beforeBudget, 1)
  assert.equal(semanticWrites(), 0)
  assert.equal(
    source.notion.skills.length + source.notion.files.length + source.notion.records.length,
    0,
  )
  const imported = await cli([...importArgs, "--operation", "installed-current-first"])
  assert.equal(imported.status, "applied")
  assert.equal(imported.state, "ready")
  assert.equal(imported.files, currentFiles.length)
  assert.deepEqual(imported.library, {
    library_id: currentLibrary.library_id,
    database_id: currentLibrary.skills.database_id,
    data_source_id: currentLibrary.skills.data_source_id,
  })
  assert.deepEqual(imported.budget.limits, {
    requests: 1000,
    bytes: 512 * 1024 * 1024,
    duration_ms: 600000,
  })
  assert.ok(imported.budget.attempts > 0 && imported.budget.attempts <= 1000)
  assert.equal(source.notion.skills.length, 1)
  assert.equal(source.notion.files.length, currentFiles.length - 1)
  const liveRecords = source.notion.records.filter(
    (row: { in_trash?: boolean }) => row.in_trash !== true,
  )
  assert.equal(liveRecords.length, currentFiles.length - 1)
  assert.ok(
    liveRecords.every(
      (row: { properties: Record<string, { select?: { name: string } }> }) =>
        row.properties[currentLibrary.records.property_ids.Kind!]?.select?.name === "resource",
    ),
  )
  for (const row of [...source.notion.skills, ...source.notion.files]) {
    const path =
      row.properties[currentLibrary.files.property_ids.Path!]?.rich_text?.[0]?.text?.content
    if (path === "scripts/run.sh") {
      const content = JSON.parse(
        row.properties[currentLibrary.files.property_ids.Content!].rich_text[0].text.content,
      )
      assert.equal(content.kind, "native")
      assert.equal(content.mode, "100755")
      assert.equal(source.notion.bodies[row.id], currentFiles[2]!.content)
      continue
    }
    const contentProperty =
      row.id === imported.page_id
        ? currentLibrary.skills.property_ids.Content!
        : currentLibrary.files.property_ids.Content!
    const content = JSON.parse(row.properties[contentProperty].rich_text[0].text.content)
    assert.equal(content.kind, "resource")
    assert.equal(typeof content.object_id, "string")
    assert.ok(content.object_id.length > 0)
    const matchingResources = liveRecords.filter(
      (record: { properties: Record<string, { rich_text: { text: { content: string } }[] }> }) =>
        record.properties[currentLibrary.records.property_ids["Record ID"]!]?.rich_text
          .map((item) => item.text.content)
          .join("") === content.object_id,
    )
    assert.equal(
      matchingResources.length,
      1,
      "Every resource Content must name exactly one live resource Record",
    )
  }
  const afterImport = semanticWrites()
  assert.ok(afterImport > 0)
  const listing = await cli(["files", imported.page_id, "--library", currentLibrary.library_id])
  assert.deepEqual(
    listing.files.map((file: { path: string }) => file.path).sort(),
    currentFiles.map((file) => file.path).sort(),
  )
  for (const file of currentFiles) {
    const selected = listing.files.find((entry: { path: string }) => entry.path === file.path)
    assert.ok(selected?.ref)
    const read = await cli(["read", selected.ref])
    assert.equal(read.content, file.content, file.path)
  }
  const output = join(scratch, "exports", "installed-current")
  await cli([
    "export",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
    "--output",
    output,
    "--format",
    "directory",
  ])
  for (const file of currentFiles) {
    const actual = join(output, file.path)
    assert.deepEqual(await readFile(actual), Buffer.from(file.content), file.path)
    assert.equal(((await stat(actual)).mode & 0o111) !== 0, file.executable, file.path)
  }
  assert.equal(semanticWrites(), afterImport, "Current consumption must not mutate Notion")
  const beforeNoop = source.notion.records.length
  const unchanged = await cli([...importArgs, "--operation", "installed-current-next"])
  assert.equal(unchanged.status, "unchanged")
  assert.equal(unchanged.state, "ready")
  assert.equal(
    semanticWrites(),
    afterImport,
    "A new operation with the same complete input must do zero semantic writes",
  )
  assert.equal(
    source.notion.records.length,
    beforeNoop,
    "A no-op must not allocate another Operation Record",
  )
  const portable = JSON.parse(await readFile(join(output, ".ntn-skills.json"), "utf8"))
  assert.deepEqual(portable.relations, {
    version: 1,
    ownership: "notion",
    library_id: currentLibrary.library_id,
    members: [],
    requires: [],
  })
  const roundtripArgs = [...importArgs]
  roundtripArgs[3] = output
  const retained = await cli([...roundtripArgs, "--operation", "installed-portable-unchanged"])
  assert.equal(retained.status, "unchanged")
  assert.equal(semanticWrites(), afterImport, "Unchanged exported relations must remain a no-op")
  const edited = currentFiles[1]!.content + "\nEdited through the exported current package.\n"
  await writeFile(join(output, "references/guide.md"), edited)
  const reapplied = await cli([...roundtripArgs, "--operation", "installed-portable-edited"])
  assert.equal(reapplied.status, "applied")
  assert.equal(reapplied.page_id, imported.page_id)
  assert.equal(reapplied.state, "ready")
  const roundtripWrites = semanticWrites() - afterImport
  const roundtripOutput = join(scratch, "exports", "installed-current-roundtrip")
  await cli([
    "export",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
    "--output",
    roundtripOutput,
    "--format",
    "directory",
  ])
  assert.equal(await readFile(join(roundtripOutput, "references/guide.md"), "utf8"), edited)
  assert.deepEqual(
    JSON.parse(await readFile(join(roundtripOutput, ".ntn-skills.json"), "utf8")).relations,
    portable.relations,
  )
  assert.equal(semanticWrites(), afterImport + roundtripWrites)
  const projectionArgs = [
    "ctl",
    "library",
    "projection",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
  ]
  const beforeProjection = semanticWrites()
  const beforeProjectionFiles = await cli([
    "files",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
    "--refresh",
  ])
  assert.equal(typeof beforeProjectionFiles.snapshot_id, "string")
  const projectionPlan = await cli([...projectionArgs, "--dry-run"])
  assert.equal(projectionPlan.status, "inspected")
  assert.equal(projectionPlan.results[0].counts.would_write, 2)
  assert.equal(projectionPlan.results[0].counts.native_verified, 1)
  assert.equal(semanticWrites(), beforeProjection)
  const projected = await cli([...projectionArgs, "--operation", "installed-projection"])
  assert.equal(projected.status, "complete")
  assert.equal(projected.results[0].counts.applied, 2)
  assert.equal(projected.results[0].counts.native_verified, 1)
  const projectionWrites = semanticWrites() - beforeProjection
  assert.ok(projectionWrites > 0)
  const projectedBodies = projected.results[0].files.filter(
    (file: { status: string }) => file.status === "applied",
  )
  for (const file of projectedBodies) {
    assert.ok(source.notion.blocks[file.page_id].length > 0)
    assert.ok(
      source.notion.bodies[file.page_id].includes(
        file.path === "SKILL.md" ? "Current import" : "原始正文 α 😀",
      ),
    )
  }
  const repeatedProjection = await cli([
    ...projectionArgs,
    "--operation",
    "installed-projection-repeat",
  ])
  assert.equal(repeatedProjection.results[0].counts.unchanged, 2)
  assert.equal(repeatedProjection.results[0].counts.applied, 0)
  assert.equal(semanticWrites(), beforeProjection + projectionWrites)
  const afterProjectionFiles = await cli([
    "files",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
    "--refresh",
  ])
  assert.equal(afterProjectionFiles.snapshot_id, beforeProjectionFiles.snapshot_id)
  const afterProjectionRead = await cli([
    "read",
    imported.page_id,
    "--library",
    currentLibrary.library_id,
    "--path",
    "references/guide.md",
    "--refresh",
    "--json",
  ])
  assert.equal(afterProjectionRead.content, edited)
  assert.equal(semanticWrites(), beforeProjection + projectionWrites)
  const owner = source.notion.skills.find((row: { id: string }) => row.id === imported.page_id)
  assert.ok(owner)
  owner.properties[currentLibrary.skills.property_ids.Enabled!].checkbox = false
  owner.properties[currentLibrary.skills.property_ids["Default Context"]!].checkbox = true
  owner.properties["日用"] = { id: "daily", type: "checkbox", checkbox: true }
  owner.properties["期望删除"] = { id: "desired-delete", type: "checkbox", checkbox: true }
  owner.last_edited_time = new Date().toISOString()
  const native = source.notion.files.find(
    (row: { properties: Record<string, { rich_text?: { text: { content: string } }[] }> }) =>
      row.properties[currentLibrary.files.property_ids.Path!]?.rich_text?.[0]?.text.content ===
      "scripts/run.sh",
  )
  assert.ok(native)
  const nativeAuthorContent = currentFiles[2]!.content + "# Kept current native author edit.\n"
  source.notion.bodies[native.id] = nativeAuthorContent
  native.last_edited_time = new Date().toISOString()
  const ownerProperties = structuredClone(owner.properties)
  const fileState = () =>
    source.notion.files.map(
      (row: { id: string; properties: unknown; in_trash: boolean; archived: boolean }) => ({
        id: row.id,
        properties: structuredClone(row.properties),
        in_trash: row.in_trash,
        archived: row.archived,
        body: source.notion.bodies[row.id],
        blocks: structuredClone(source.notion.blocks[row.id]),
      }),
    )
  const liveRecordIds = () =>
    source.notion.records
      .filter((row: { in_trash?: boolean }) => row.in_trash !== true)
      .map((row: { id: string }) => row.id)
  const retainedFiles = fileState()
  const retainedRecords = liveRecordIds()
  const mainBody = source.notion.bodies[owner.id]
  const mainBlocks = source.notion.blocks[owner.id].map(
    (block: { type: string; [key: string]: unknown }) => ({
      type: block.type,
      content: block[block.type],
    }),
  )
  const oldBlockIds = new Set(
    source.notion.blocks[owner.id].map((block: { id: string }) => block.id),
  )
  assert.ok(oldBlockIds.size > 0)
  source.notion.blocks[owner.id] = []
  source.notion.bodies[owner.id] = ""
  owner.in_trash = true
  const restoreArgs = [
    ...projectionArgs,
    "--restore",
    "--include",
    "**/*.md",
    "--exclude",
    "**/tests/**",
    "--max-requests",
    "250",
    "--timeout",
    "120000",
  ]
  const beforeRestore = semanticWrites()
  const restored = await cli(restoreArgs)
  assert.equal(restored.status, "complete")
  assert.equal(restored.results[0].page_id, imported.page_id)
  assert.equal(restored.results[0].skill_id, "installed-current")
  assert.equal(restored.results[0].restoration.status, "restored")
  assert.equal(typeof restored.results[0].restoration.operation_id, "string")
  assert.equal(restored.results[0].counts.applied, 1)
  assert.equal(restored.results[0].counts.unchanged, 1)
  assert.equal(restored.results[0].counts.native_verified, 1)
  assert.deepEqual(restored.results[0].policy, {
    include: ["**/*.md"],
    exclude: ["**/tests/**"],
  })
  assert.equal(restored.budget.limits.requests, 250)
  assert.equal(restored.budget.limits.duration_ms, 120000)
  assert.equal(source.notion.skills.length, 1, "Restoration must not create a replacement Skill")
  assert.equal(owner.in_trash, false)
  assert.deepEqual(owner.properties, ownerProperties, "Restore every original human property")
  assert.deepEqual(fileState(), retainedFiles, "Retain File identities and current native bodies")
  assert.deepEqual(liveRecordIds(), retainedRecords, "Both finite intents must retire")
  assert.equal(source.notion.bodies[owner.id], mainBody)
  assert.equal(source.notion.bodies[native.id], nativeAuthorContent)
  assert.deepEqual(
    source.notion.blocks[owner.id].map((block: { type: string; [key: string]: unknown }) => ({
      type: block.type,
      content: block[block.type],
    })),
    mainBlocks,
    "The cleared main body must be completely regenerated",
  )
  assert.ok(
    source.notion.blocks[owner.id].every((block: { id: string }) => !oldBlockIds.has(block.id)),
    "Untrashing an existing body is not regeneration",
  )
  const restorationWrites = semanticWrites() - beforeRestore
  assert.ok(restorationWrites > 0)
  const restorationOperation = await cli([
    "ctl",
    "library",
    "operation",
    "installed-current",
    "--kind",
    "skill",
    "--library",
    currentLibrary.library_id,
  ])
  assert.equal(restorationOperation.status, "not_found")
  assert.equal(restorationOperation.operation, null, "No local or remote intent may remain")
  const repeatedRestore = await cli(restoreArgs)
  assert.equal(repeatedRestore.status, "complete")
  assert.equal(repeatedRestore.results[0].restoration.status, "unchanged")
  assert.equal(repeatedRestore.results[0].counts.unchanged, 2)
  assert.equal(repeatedRestore.results[0].counts.applied, 0)
  assert.equal(repeatedRestore.results[0].counts.native_verified, 1)
  assert.equal(repeatedRestore.request_metrics.requests.notion_write, 0)
  assert.equal(semanticWrites(), beforeRestore + restorationWrites)
  assert.deepEqual(owner.properties, ownerProperties)
  assert.deepEqual(fileState(), retainedFiles)
  assert.deepEqual(liveRecordIds(), retainedRecords)
  currentProjection = {
    text_files: 2,
    native_verified: 1,
    dry_run_writes: 0,
    projection_writes: projectionWrites,
    repeated_projection_writes: 0,
    consumption_writes: 0,
    snapshot_identity_preserved: true,
    restoration: {
      writes: restorationWrites,
      repeated_writes: 0,
      original_skill_and_file_identities: true,
      human_properties_preserved: true,
      current_native_author_edit_preserved: true,
      regenerated_main_blocks: mainBlocks.length,
      pending: 0,
    },
  }
  assert.equal(source.unexpected.length, 0, JSON.stringify(source.unexpected))
  currentImport = {
    files: currentFiles.length,
    dry_run_writes: 0,
    import_writes: afterImport,
    consumption_writes: 0,
    repeated_import_writes: 0,
    portable_roundtrip: true,
    roundtrip_import_writes: roundtripWrites,
    budget_preflight_attempts: limited.error.details.budget.attempts,
    exact_export: true,
    executable_mode: true,
    explicit_native_path: "scripts/run.sh",
    requests: source.requests.length,
  }
} finally {
  await source.close()
}
const report = {
  name: manifest.name,
  version: manifest.version,
  contract: "current-only",
  runtime: (await run([runtime, "--version"])).trim(),
  executable,
  checks: [
    "installed_bin",
    "current_schema",
    "removed_routes_rejected",
    "read_only_consumption_has_no_flag",
    "bundled_skills_raw_json_full_and_matching_paths",
    "bundled_skills_zero_state_writes_and_retired_lifecycle",
    "installed_current_import_dry_run_apply_read_files_export_noop",
    "installed_portable_roundtrip_and_invocation_budget",
    "installed_current_projection_full_bodies_noop_and_read_only_consumption",
    "installed_current_projection_restore_same_identity_regenerate_native_preserve_noop",
  ],
  current_import: currentImport,
  current_projection: currentProjection,
  scratch,
}
await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report))
