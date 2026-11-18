import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
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
  NTN_SKILLS_DATA_HOME: "",
  XDG_DATA_HOME: join(scratch, "data"),
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
  ["ctl", "export", "files", "list", "read", "schema", "use"],
)
for (const path of [["read"], ["use"], ["files"], ["export"], ["ctl", "prepare"]]) {
  const schema = await cli(["schema", ...path])
  assert.equal(JSON.stringify(schema).includes('"name":"read-only"'), false)
}
const library = await cli(["schema", "ctl", "library"])
assert.deepEqual(library.schema.commands.map((command: { name: string }) => command.name).sort(), [
  "files",
  "init",
  "inspect",
  "profile",
])
for (const path of [
  ["create"],
  ["adopt"],
  ["apply"],
  ["write"],
  ["replace"],
  ["ctl", "operation"],
  ["ctl", "sync"],
  ["ctl", "library", "sources"],
  ["ctl", "builtin", "publish"],
])
  assert.equal((await cli(["schema", ...path], 2)).error.code, "INVALID_ARGUMENT")
const builtin = await cli(["ctl", "builtin", "list"])
assert.equal(builtin.count, 3)
await mkdir(join(scratch, "exports"))
const files = [
  [
    "notion/ntn-skills",
    "skills/ntn-skills",
    ["SKILL.md", "references/commands.md", "references/integration.md"],
  ],
  [
    "notion/ntn-skills-maintain",
    "skills/notion/ntn-skills-maintain",
    ["SKILL.md", "references/operations.md", "references/setup.md"],
  ],
  [
    "notion/ntn-skills-sync",
    "skills/notion/ntn-skills-sync",
    ["SKILL.md", "references/synchronization.md"],
  ],
] as const
for (const [id, packagePath, paths] of files) {
  const output = join(scratch, "exports", id.split("/")[1]!)
  await cli(["ctl", "builtin", "export", id, "--output", output])
  for (const path of paths) {
    const expected = await readFile(join(installed, packagePath, path), "utf8")
    const read = await cli(["ctl", "builtin", "read", id, "--path", path])
    assert.equal(read.content, expected)
    assert.equal(await readFile(join(output, path), "utf8"), expected)
  }
  await cli(["ctl", "builtin", "install", id, "--agent-dir", join(scratch, "agent")])
  await cli(["ctl", "builtin", "update", id, "--agent-dir", join(scratch, "agent")])
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
    "three_builtins_exact_read_export",
    "builtin_install_update",
  ],
  scratch,
}
await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report))
