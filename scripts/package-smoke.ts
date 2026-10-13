import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    archive: { type: "string" },
    registry: { type: "string" },
    runtime: { type: "string" },
  },
  strict: true,
})
if (Boolean(values.archive) === Boolean(values.registry))
  throw new Error("Select exactly one --archive or --registry input.")
if (values.registry && !/^notion-skills-cli@\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(values.registry))
  throw new Error("--registry must select an exact notion-skills-cli version.")
const scratch = await mkdtemp(join(tmpdir(), "ntn-skills-consumer-"))
const runtime = values.runtime ? resolve(values.runtime) : "bun"
const dependency = values.archive
  ? `file:${resolve(values.archive)}`
  : values.registry!.split("@")[1]!
await writeFile(
  join(scratch, "package.json"),
  JSON.stringify({ private: true, dependencies: { "notion-skills-cli": dependency } }),
)
const env = {
  ...process.env,
  NOTION_API_TOKEN: "",
  NOTION_WORKSPACE_ID: "",
  NOTION_API_BASE_URL: "",
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_NTN_BIN: join(scratch, "missing-ntn"),
}
async function run(command: string[], expectedExit = 0) {
  const child = Bun.spawn(command, {
    cwd: scratch,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== expectedExit)
    throw new Error(`${command[0]} exited ${exit}, expected ${expectedExit}: ${stderr || stdout}`)
  return stdout
}
await run([
  "bun",
  "install",
  "--production",
  "--ignore-scripts",
  "--registry=https://registry.npmjs.org",
])
const installed = join(scratch, "node_modules/notion-skills-cli")
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
if (values.registry && values.registry !== `${manifest.name}@${manifest.version}`)
  throw new Error("Registry installation selected a different version.")
const executable = join(installed, manifest.bin["ntn-skills"])
const cli = async (args: string[], expectedExit = 0) =>
  JSON.parse(await run([runtime, executable, ...args], expectedExit))
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}
check(
  (await run([runtime, executable, "--version"])).trim() === `ntn-skills v${manifest.version}`,
  "CLI version differs from package.",
)
check((await run([runtime, executable, "--help"])).includes("SUBCOMMANDS"), "Missing CLI help.")
const snapshotId = `s_${"a".repeat(64)}`
const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const databaseId = "11111111-1111-4111-8111-111111111111"
const ref = `skill://${pageId}/SKILL.md?snapshot=${snapshotId}`
const resolved = await cli([
  "resolve",
  "../assets/template.md",
  "--from",
  `skill://${pageId}/references/guide.md?snapshot=${snapshotId}`,
])
check(
  resolved.ref === `skill://${pageId}/assets/template.md?snapshot=${snapshotId}`,
  "Relative refs lost path or version.",
)
const config = await cli(["config", "show"])
check(
  config.ok && config.config.token_configured === false && !config.config.token,
  "Configuration is not sanitized.",
)
const repeated = await cli(["list", "--database=frontend", "--database=ops"], 2)
check(repeated.error.code === "INVALID_ARGUMENT", "Repeated database selector was accepted.")
const main =
  "---\nname: package-smoke\ndescription: Verify installed offline consumption\n---\n# Package Smoke\n\nRead supporting files from the same snapshot.\n"
const supporting = "first\nsecond\nthird\n"
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const contents = [
  { path: "SKILL.md", bytes: Buffer.from(main) },
  { path: "references/guide.md", bytes: Buffer.from(supporting) },
]
const files = contents.map((file) => ({
  path: file.path,
  bytes: file.bytes.length,
  sha256: digest(file.bytes),
}))
for (const file of contents) {
  const destination = join(env.NTN_SKILLS_HOME, "objects", digest(file.bytes))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, file.bytes, { mode: 0o600 })
}
await mkdir(join(env.NTN_SKILLS_HOME, "snapshots"), { recursive: true, mode: 0o700 })
await writeFile(
  join(env.NTN_SKILLS_HOME, "snapshots", `${snapshotId}.json`),
  JSON.stringify({
    snapshot_id: snapshotId,
    scope: "consumer-smoke",
    skill: {
      id: pageId,
      name: "Package Smoke",
      alias: "package-smoke",
      description: "Verify installed offline consumption",
      database_id: databaseId,
      data_source_id: "22222222-2222-4222-8222-222222222222",
      ref: `skill://${pageId}/SKILL.md`,
    },
    skill_name: "package-smoke",
    version_id: "consumer-version",
    created_at: 0,
    files,
  }),
  { mode: 0o600 },
)
const read = await cli(["read", ref])
check(
  read.ok && read.content === main && read.source === "local_snapshot",
  "Installed snapshot read differs.",
)
const listed = await cli(["files", snapshotId])
check(
  listed.files
    .map((file: { path: string }) => file.path)
    .sort()
    .join(",") === "SKILL.md,references/guide.md",
  "Installed snapshot file listing omitted supporting files.",
)
const range = await cli(["read", "references/guide.md", "--from", ref, "--lines", "2-2"])
check(
  range.content === "second" && range.range.start === 2 && range.has_more,
  "Installed ranged relative read differs.",
)
const output = join(scratch, "portable.zip")
const exported = await cli(["export", ref, "--output", output])
const reused = await cli(["export", ref, "--output", output])
check(
  exported.ok && !exported.reused && reused.reused && exported.content_id === reused.content_id,
  "Portable export reuse differs.",
)
const configRoot = env.NTN_SKILLS_CONFIG_HOME
await mkdir(configRoot, { recursive: true, mode: 0o700 })
await writeFile(
  join(configRoot, "config.json"),
  JSON.stringify({
    sources: [{ alias: "smoke", database_id: databaseId, title: "Smoke", data_source_ids: [] }],
  }),
  { mode: 0o600 },
)
const constrained = await cli(["read", ref, "--database", "smoke"])
check(constrained.content === main, "Offline registered alias constraint failed.")
await writeFile(join(env.NTN_SKILLS_HOME, "objects", files[0]!.sha256), "corrupt", { mode: 0o600 })
const corrupt = await cli(["read", ref], 1)
check(corrupt.error.code === "STATE_CORRUPT", "Installed reader accepted corrupted content.")
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    runtime: (await run([runtime, "--version"])).trim(),
    checks: [
      "version",
      "help",
      "resolve",
      "sanitized_config",
      "duplicate_arguments",
      "offline_read",
      "relative_range",
      "snapshot_files",
      "portable_export_reuse",
      "offline_alias",
      "corruption_rejected",
    ],
    scratch,
  }),
)
