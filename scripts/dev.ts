import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const build = spawn(process.execPath, ["run", "build"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
})
const buildDiagnostics: Buffer[] = []
build.stdout.on("data", (chunk: Buffer) => buildDiagnostics.push(chunk))
build.stderr.on("data", (chunk: Buffer) => buildDiagnostics.push(chunk))
const built = await new Promise<number>((resolve, reject) => {
  build.once("error", reject)
  build.once("close", (code) => resolve(code ?? 1))
})
if (built !== 0) {
  for (const chunk of buildDiagnostics) process.stderr.write(chunk)
  process.exit(built)
}
const entry = fileURLToPath(new URL("../packages/cli/dist/ntn-skills.js", import.meta.url))
const args = process.argv.slice(2)
const timingFile = process.env.NTN_SKILLS_VERIFY_CLI_TIMING_FILE
const timing = timingFile
  ? {
      version: 1,
      kind: "node_cli_process",
      command_id: process.env.NTN_SKILLS_VERIFY_CLI_TIMING_ID,
      entry,
      entry_sha256: createHash("sha256")
        .update(await readFile(entry))
        .digest("hex"),
      argv_sha256: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      build_included: false,
      boundary: "spawn_to_close",
      started_at: new Date().toISOString(),
    }
  : undefined
// Build and all receipt hashes above are outside the Node CLI process interval.
const started = timing === undefined ? undefined : process.hrtime.bigint()
const product = spawn("node", [entry, ...args], {
  cwd: process.cwd(),
  stdio: "inherit",
})
let spawned = false
product.once("spawn", () => {
  spawned = true
})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => product.kill(signal))
product.once("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
product.once("close", async (code, signal) => {
  const elapsed =
    started === undefined || !spawned ? null : Number(process.hrtime.bigint() - started) / 1_000_000
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
  if (timingFile && timing) {
    try {
      await writeFile(
        timingFile,
        JSON.stringify({
          ...timing,
          finished_at: new Date().toISOString(),
          status: spawned ? "completed" : "not_started",
          pid: product.pid ?? null,
          exit_code: process.exitCode,
          signal,
          wall_elapsed_ms: elapsed,
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      )
    } catch {
      // Measurement failure must not reinterpret or replay the product command.
      console.error("The CLI process timing receipt could not be retained.")
    }
  }
})
