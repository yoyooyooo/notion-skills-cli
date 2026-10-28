import { mkdtemp, readFile, writeFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

export async function prepareConsumer() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      archive: { type: "string" },
      registry: { type: "string" },
      runtime: { type: "string" },
      "migration-archive": { type: "string" },
    },
    strict: true,
  })
  if (Boolean(values.archive) === Boolean(values.registry))
    throw new Error("Select exactly one --archive or --registry input.")
  if (values.registry && !/^ntn-skills@\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(values.registry))
    throw new Error("--registry must select an exact ntn-skills version.")
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "ntn-skills-consumer-")))
  console.error(JSON.stringify({ consumer_smoke_scratch: scratch }))
  const runtime = values.runtime ? resolve(values.runtime) : Bun.which("node")
  if (!runtime)
    throw new Error(
      "Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+, must be installed for consumer checks.",
    )
  const dependency = values.archive
    ? `file:${resolve(values.archive)}`
    : values.registry!.split("@")[1]!
  await writeFile(
    join(scratch, "package.json"),
    JSON.stringify({ private: true, dependencies: { "ntn-skills": dependency } }),
  )
  const env = {
    ...process.env,
    PATH: `${dirname(runtime)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    NOTION_API_TOKEN: "",
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: "https://api.notion.com", // Match authScope and localIdentity defaults.
    HOME: join(scratch, "home"),
    NTN_SKILLS_DATA_HOME: "",
    XDG_DATA_HOME: join(scratch, "xdg", "data"),
    NTN_SKILLS_HOME: join(scratch, "state"),
    NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
    NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
    XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
    XDG_STATE_HOME: join(scratch, "xdg", "state"),
    XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
    NTN_SKILLS_NTN_BIN: join(scratch, "missing-ntn"),
  }
  let executable: string | undefined
  let operatorExecutable: string | undefined
  async function run(
    command: string[],
    expectedExit = 0,
    overrides: Record<string, string | undefined> = {},
    stdin?: string,
  ) {
    const child = Bun.spawn(command, {
      cwd: scratch,
      env: { ...env, ...overrides },
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== expectedExit)
      throw new Error(
        `Consumer command ${JSON.stringify(command)} exited ${exit}, expected ${expectedExit}; scratch=${scratch}: ${stderr || stdout}`,
      )
    if (command[0] === runtime && [executable, operatorExecutable].includes(command[1]) && stderr)
      throw new Error(
        `CLI command ${JSON.stringify(command)} emitted unexpected stderr; scratch=${scratch}: ${stderr}`,
      )
    return stdout
  }
  await run([
    "npm",
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ])
  const installed = join(scratch, "node_modules/ntn-skills")
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  if (values.registry && values.registry !== `${manifest.name}@${manifest.version}`)
    throw new Error("Registry installation selected a different version.")
  executable = join(installed, manifest.bin["ntn-skills"])
  if (!values["migration-archive"])
    throw new Error(
      "--migration-archive must select the independent ntn-skills-state-migration archive for fixture import.",
    )
  const migrationPrefix = join(scratch, "migration-tool")
  await run([
    "npm",
    "install",
    "--prefix",
    migrationPrefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(values["migration-archive"]),
  ])
  const migrationPackage = join(migrationPrefix, "node_modules", "ntn-skills-state-migration")
  const migrationManifest = JSON.parse(
    await readFile(join(migrationPackage, "package.json"), "utf8"),
  )
  if (
    migrationManifest.name !== "ntn-skills-state-migration" ||
    Object.keys(migrationManifest.bin ?? {})
      .sort()
      .join(",") !== "ntn-skills-migrate,ntn-skills-operator" ||
    migrationManifest.bin["ntn-skills-migrate"] !== "ntn-skills-migrate.js" ||
    migrationManifest.bin["ntn-skills-operator"] !== "ntn-skills-operator.js"
  )
    throw new Error(
      "Migration archive must expose the independent importer and historical operator executables.",
    )
  if (Object.keys(manifest.bin ?? {}).join(",") !== "ntn-skills")
    throw new Error("Normal package must expose only ntn-skills.")
  const migrationExecutable = join(migrationPackage, migrationManifest.bin["ntn-skills-migrate"])
  operatorExecutable = join(migrationPackage, migrationManifest.bin["ntn-skills-operator"])
  const operatorBin = join(migrationPrefix, "node_modules/.bin/ntn-skills-operator")
  const consumerBin = join(scratch, "node_modules/.bin/ntn-skills")
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message)
  }
  const cli = async (
    args: string[],
    expectedExit = 0,
    overrides: Record<string, string | undefined> = {},
    stdin?: string,
  ) => {
    const stdout = await run([runtime, executable, ...args], expectedExit, overrides, stdin)
    check(stdout.trim().split("\n").length === 1, `CLI emitted multiple values: ${args.join(" ")}`)
    const result = JSON.parse(stdout)
    check(
      result.ok === (expectedExit === 0),
      `CLI result disagrees with its exit: ${args.join(" ")}`,
    )
    if (expectedExit !== 0)
      check(
        typeof result.error?.message === "string" && result.error.message.length > 0,
        "CLI error omitted a meaningful message.",
      )
    return result
  }
  const rejectedCommands: Array<{ args: string[]; exit: number; output: unknown }> = []
  const rejected = async (
    args: string[],
    code = "INVALID_ARGUMENT",
    exit = 2,
    overrides: Record<string, string | undefined> = {},
  ) => {
    const result = await cli(args, exit, overrides)
    check(result.error.code === code, `Expected ${code}: ${JSON.stringify(result)}`)
    rejectedCommands.push({ args, exit, output: result })
    return result
  }
  const evidence: Record<string, unknown> = {}
  return {
    scratch,
    runtime,
    env,
    installed,
    manifest,
    executable,
    migrationExecutable,
    operatorExecutable,
    operatorBin,
    consumerBin,
    run,
    check,
    cli,
    rejected,
    rejectedCommands,
    evidence,
  }
}
