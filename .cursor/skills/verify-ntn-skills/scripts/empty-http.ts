import assert from "node:assert/strict"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { checkAuthoring } from "../../../../scripts/package-smoke/authoring.ts"
import { resolveConsumerRuntime } from "../../../../scripts/package-smoke/consumer.ts"

const { values } = parseArgs({
  options: { out: { type: "string" }, cli: { type: "string" } },
  strict: true,
})
assert.ok(
  values.out && isAbsolute(values.out) && values.cli && isAbsolute(values.cli),
  "Use --out FRESH_DIRECTORY --cli BUILT_CLI_JS",
)
await mkdir(values.out, { mode: 0o700 })
const scratch = await realpath(values.out),
  executable = values.cli,
  runtime = resolveConsumerRuntime("node")
const evidence: Record<string, unknown> = {},
  commands: unknown[] = []
const base = {
  ...process.env,
  NTN_SKILLS_DEV_ROOT: undefined,
  NOTION_API_TOKEN: "",
  NOTION_API_BASE_URL: "http://127.0.0.1:9",
  HOME: join(scratch, "home"),
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  NTN_SKILLS_DATA_HOME: join(scratch, "data"),
}
const run = async (
  args: string[],
  expectedExit = 0,
  overrides: Record<string, string | undefined> = {},
  stdin?: string,
) => {
  assert.equal(stdin, undefined, "This scenario never provides credentials through input")
  const child = Bun.spawn(args, {
    cwd: scratch,
    env: { ...base, ...overrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  commands.push({ argv: args, exit, stdout, stderr })
  await writeFile(join(scratch, "commands.json"), JSON.stringify(commands, null, 2) + "\n", {
    mode: 0o600,
  })
  assert.equal(
    exit,
    expectedExit,
    `Actual Node command failed: ${args.slice(2).join(" ")}; ${stderr || stdout}`,
  )
  return stdout
}
const cli = async (
  args: string[],
  expectedExit = 0,
  overrides: Record<string, string | undefined> = {},
  stdin?: string,
) => JSON.parse(await run([runtime, executable, ...args], expectedExit, overrides, stdin))
try {
  const result = await checkAuthoring(
    { scratch, runtime, executable, cli, run, evidence, installed: resolve(executable, "../..") },
    undefined,
    { emptyLibraryOnly: true },
  )
  await writeFile(join(scratch, "summary.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
} catch (error) {
  await writeFile(
    join(scratch, "failure.json"),
    JSON.stringify({ message: String(error), evidence }, null, 2) + "\n",
  )
  throw error
}
