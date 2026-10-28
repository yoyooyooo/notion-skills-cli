import { spawn } from "node:child_process"
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
const product = spawn(
  "node",
  [
    fileURLToPath(new URL("../packages/cli/dist/ntn-skills.js", import.meta.url)),
    ...process.argv.slice(2),
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
  },
)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => product.kill(signal))
product.once("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
product.once("close", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
})
