import { spawnSync } from "node:child_process"

let failed = false
for (const lane of ["test:unit", "test:node"]) {
  const result = spawnSync(process.execPath, ["run", lane], { stdio: "inherit" })
  if (result.error) console.error(result.error)
  if (result.status !== 0) failed = true
}
if (failed) process.exitCode = 1
