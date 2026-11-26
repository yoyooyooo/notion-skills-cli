#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
const repo = resolve(fileURLToPath(new URL("../../../../", import.meta.url)))
const sourceEntry = join(repo, "packages/cli/src/main.ts")
const sourceLaunch = ["bun", join(repo, "scripts/dev.ts")]
const split = process.argv.indexOf("--", 2)
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, split < 0 ? undefined : split),
  options: {
    help: { type: "boolean", short: "h" },
    live: { type: "boolean" },
    run: { type: "string" },
    library: { type: "string" },
    stage: { type: "string" },
    parent: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
})
const usage =
  "Usage: bun .cursor/skills/verify-ntn-skills/scripts/control.ts MODE --run ABSOLUTE_DIRECTORY [--live] [-- CLI_ARGS]\nModes: init, doctor, cli, empty, cleanup\nEmpty: --stage init --parent AUTHORIZED_TEST_CONTAINER, or --stage census. Doctor is offline by default; --live explicitly runs the project direct-HTTP doctor. Help never initializes a run or starts a child."
if (values.help || positionals[0] === "help") {
  console.log(usage)
  process.exit(0)
}
const mode = positionals[0]
if (
  positionals.length !== 1 ||
  !["init", "doctor", "cli", "empty", "cleanup"].some((candidate) => candidate === mode) ||
  !values.run ||
  !isAbsolute(values.run)
)
  throw new Error(usage)
const root = resolve(values.run)
const scratch = join(root, "scratch")
const evidence = join(root, "evidence")
const marker = join(root, "verification-run.json")
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}
async function load(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(value)) throw new Error("Verification run identity must be an object")
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
async function exists(path: string) {
  return Bun.file(path).exists()
}
async function trash(path: string) {
  if (process.platform !== "darwin")
    throw new Error(
      "Automatic cleanup requires verified macOS /usr/bin/trash; preserve scratch on other hosts until a recycle-bin command is verified.",
    )
  await access("/usr/bin/trash", constants.X_OK)
  const child = Bun.spawn(["/usr/bin/trash", path], { stdout: "pipe", stderr: "pipe" })
  const [, , exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit) throw new Error("System trash operation failed; scratch was retained.")
}
const env: Record<string, string | undefined> & {
  NTN_SKILLS_CONFIG_HOME: string
  NTN_SKILLS_HOME: string
  NTN_SKILLS_CACHE_HOME: string
  NTN_SKILLS_DATA_HOME: string
} = {
  ...process.env,
  NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
  NTN_SKILLS_HOME: join(scratch, "state"),
  NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
  NTN_SKILLS_DATA_HOME: join(scratch, "data"),
  XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
  XDG_STATE_HOME: join(scratch, "xdg", "state"),
  XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
  XDG_DATA_HOME: join(scratch, "xdg", "data"),
}
// A controlled command must not inherit an unrelated source checkout launcher.
delete env.NTN_SKILLS_DEV_ROOT
// The project's direct HTTP engine consumes inherited token configuration in place.
async function command(args: string[], cwd = repo, childEnv = env) {
  if (args.includes("set-token") || args.some((arg) => /^(?:Bearer |secret_|ntn_)/.test(arg)))
    throw new Error("Do not pass credentials to the verification harness.")
  const commandId = randomUUID()
  const record = join(evidence, "commands", `${Date.now()}-${commandId}.json`)
  const sourceCli = args[0] === sourceLaunch[0] && args[1] === sourceLaunch[1]
  const timingFile = sourceCli ? join(evidence, "cli-timing", `${commandId}.json`) : undefined
  if (timingFile) await mkdir(dirname(timingFile), { recursive: true, mode: 0o700 })
  const started = new Date().toISOString()
  const child = Bun.spawn(args, {
    cwd,
    env: timingFile
      ? {
          ...childEnv,
          NTN_SKILLS_VERIFY_CLI_TIMING_FILE: timingFile,
          NTN_SKILLS_VERIFY_CLI_TIMING_ID: commandId,
        }
      : childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timeout = false
  let escalation: NodeJS.Timeout | undefined
  const timer = setTimeout(
    () => {
      timeout = true
      child.kill()
      escalation = setTimeout(() => child.kill("SIGKILL"), 2_000)
    },
    15 * 60 * 1000,
  )
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    let output: unknown
    try {
      output = JSON.parse(stdout)
    } catch {
      output = stdout
    }
    let cliProcessTiming: unknown
    if (timingFile) {
      try {
        const bytes = await readFile(timingFile)
        const measured = JSON.parse(bytes.toString("utf8"))
        const valid =
          measured !== null &&
          typeof measured === "object" &&
          measured.version === 1 &&
          measured.kind === "node_cli_process" &&
          measured.command_id === commandId &&
          measured.entry === sourceEntry &&
          measured.entry_sha256 === digest(await readFile(sourceEntry)) &&
          measured.argv_sha256 ===
            digest(Buffer.from(JSON.stringify(args.slice(sourceLaunch.length)))) &&
          measured.build_included === false &&
          measured.boundary === "spawn_to_close" &&
          Number.isInteger(measured.exit_code) &&
          measured.exit_code === exit &&
          (measured.signal === null || typeof measured.signal === "string") &&
          (measured.status === "completed"
            ? Number.isInteger(measured.pid) &&
              measured.pid > 0 &&
              Number.isFinite(measured.wall_elapsed_ms) &&
              measured.wall_elapsed_ms >= 0
            : measured.status === "not_started" && measured.wall_elapsed_ms === null)
        cliProcessTiming = {
          receipt: timingFile,
          sha256: digest(bytes),
          measured,
          sample_status: !valid
            ? "invalid"
            : !timeout &&
                exit === 0 &&
                measured.status === "completed" &&
                measured.signal === null &&
                output !== null &&
                typeof output === "object" &&
                "ok" in output &&
                output.ok === true
              ? "eligible"
              : "failed",
        }
      } catch {
        cliProcessTiming = { receipt: timingFile, sample_status: "unavailable" }
      }
    }
    await save(record, {
      command: args,
      cwd,
      started,
      finished: new Date().toISOString(),
      exit,
      pid: child.pid,
      signal: child.signalCode,
      observed_exit: true,
      timeout,
      ...(cliProcessTiming === undefined ? {} : { cli_process_timing: cliProcessTiming }),
      output:
        sourceCli && args[sourceLaunch.length] === "ctl" && args[sourceLaunch.length + 1] === "api"
          ? apiInventoryOutput(output)
          : output,
      stderr: {
        bytes: Buffer.byteLength(stderr),
        sha256: digest(Buffer.from(stderr)),
        raw_retained: false,
      },
    })
    return { output, exit, record }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalation)
  }
}
function apiInventoryOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("response" in value)) return value
  const response = value.response
  if (
    !response ||
    typeof response !== "object" ||
    !("results" in response) ||
    !Array.isArray(response.results)
  )
    return value
  return {
    ...value,
    response: {
      ...response,
      results: response.results.map((raw: unknown) => {
        if (!raw || typeof raw !== "object") return {}
        return {
          ...("id" in raw ? { id: raw.id } : {}),
          ...("type" in raw ? { type: raw.type } : {}),
          ...("child_page" in raw ? { child_page: raw.child_page } : {}),
        }
      }),
    },
  }
}
async function cli(args: string[]) {
  const json =
    ["list", "read"].includes(args[0] ?? "") && !args.includes("--json") && !args.includes("--raw")
      ? ["--json"]
      : []
  const result = await command([...sourceLaunch, ...args, ...json])
  if (result.exit || !isRecord(result.output) || result.output.ok !== true)
    throw new Error(`CLI failed; inspect ${result.record}`)
  return result.output
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function main() {
  if (mode === "init") {
    check(!(await exists(marker)), "Run already exists; choose a new directory")
    await mkdir(root, { recursive: true, mode: 0o700 })
    check(
      !(await lstat(root)).isSymbolicLink() && (await readdir(root)).length === 0,
      "Verification run must be an empty owned directory without symlinks",
    )
    await chmod(root, 0o700)
    await mkdir(env.NTN_SKILLS_CONFIG_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_CACHE_HOME, { recursive: true, mode: 0o700 })
    await mkdir(env.NTN_SKILLS_DATA_HOME, { recursive: true, mode: 0o700 })
    await mkdir(join(scratch, "builtin-home"), { recursive: true, mode: 0o700 })
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await save(marker, { repo, root, scratch, evidence, created: new Date().toISOString() })
    return { ready: true, run: root, evidence }
  }
  check(await exists(marker), "Run init first")
  const identity = await load(marker)
  check(
    identity.repo === repo && identity.root === root && identity.scratch === scratch,
    "Run ownership differs",
  )
  if (mode === "empty") {
    check(
      (await realpath(scratch)) === join(await realpath(root), "scratch"),
      "Scratch directory must belong to this run and not be a symlink",
    )
    const { runEmptyLibrary } = await import("./empty-library.ts")
    return await runEmptyLibrary({
      root,
      stage: values.stage ?? "init",
      container: values.parent,
      argv: split < 0 ? [] : process.argv.slice(split + 1),
      drive: (args) => command([...sourceLaunch, ...args]),
      probe: async (request) => {
        const inputFile = join(evidence, "empty-library", `probe-${randomUUID()}.json`)
        await save(inputFile, request)
        const result = await command([
          "node",
          "--import",
          join(repo, "scripts/source-loader.ts"),
          join(repo, ".cursor/skills/verify-ntn-skills/scripts/empty-library.ts"),
          "--probe",
          inputFile,
        ])
        check(
          result.exit === 0 && isRecord(result.output),
          `Independent Node observation failed; inspect ${result.record}`,
        )
        return result.output
      },
    })
  }
  if (mode === "cleanup") {
    try {
      await realpath(scratch)
      await trash(scratch)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    await save(join(evidence, "cleanup.json"), {
      local_scratch_trashed: true,
      remote_skills_retained: true,
      evidence_retained: true,
    })
    check(
      (await exists(marker)) && (await exists(join(evidence, "cleanup.json"))),
      "Cleanup lost evidence",
    )
    return { cleaned: true, evidence }
  }
  check(
    (await realpath(scratch)) === join(await realpath(root), "scratch"),
    "Scratch directory must belong to this run and not be a symlink",
  )
  if (mode === "doctor") {
    const version = await command([...sourceLaunch, "--version"])
    const help = await command([...sourceLaunch, "--help"])
    check(
      version.exit === 0 && help.exit === 0,
      "Offline CLI readiness failed; inspect command evidence",
    )
    const result = {
      ready: true,
      mode: values.live ? "live" : "offline",
      authentication: values.live ? "probed by the project direct-HTTP doctor" : "not probed",
      entry: { path: sourceEntry, sha256: digest(await readFile(sourceEntry)) },
      version: version.output,
      scope: {
        config: env.NTN_SKILLS_CONFIG_HOME,
        state: env.NTN_SKILLS_HOME,
        cache: env.NTN_SKILLS_CACHE_HOME,
        data: env.NTN_SKILLS_DATA_HOME,
      },
      ...(values.live
        ? {
            live: await cli([
              "ctl",
              "doctor",
              ...(values.library ? ["--library", values.library] : []),
            ]),
          }
        : {}),
    }
    await save(join(evidence, "doctor.json"), result)
    return result
  }
  if (mode === "cli") {
    check(split >= 0 && process.argv.length > split + 1, "cli requires -- CLI_ARGS")
    const cliArgs = process.argv.slice(split + 1)
    // Offline builtin commands isolate native Skill roots; online commands inherit the project token.
    // Both paths always use the scratch application and XDG data roots above.
    const childEnv =
      cliArgs[0] === "ctl" &&
      cliArgs[1] === "builtin" &&
      ["list", "read", "export", "status", "install", "update"].includes(cliArgs[2] ?? "")
        ? { ...env, HOME: join(scratch, "builtin-home") }
        : env
    const result = await command([...sourceLaunch, ...cliArgs], repo, childEnv)
    return { exit: result.exit, evidence: result.record, output: result.output }
  }
  throw new Error(`Unknown mode: ${mode}`)
}
try {
  console.log(JSON.stringify(await main()))
} catch (error) {
  if (await exists(marker)) {
    await save(join(evidence, "failure.json"), {
      mode,
      message: error instanceof Error ? error.message : "Verification failed",
      at: new Date().toISOString(),
    })
    console.error(
      `Verification failed; evidence retained at ${evidence}. Preserve scratch while an original write still needs it; inspect that original result before cleanup or a new run.`,
    )
  } else console.error(error instanceof Error ? error.message : "Verification failed")
  process.exitCode = 1
}
