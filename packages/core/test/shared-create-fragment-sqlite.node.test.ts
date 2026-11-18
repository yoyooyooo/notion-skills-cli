import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("UTF-8 sole-main recovery and a cold normal consumer use real SQLite across Node processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ntn-fragment-sqlite-"))
  const worker = new URL("./shared-create-fragment-sqlite-worker.ts", import.meta.url).pathname
  let original: { review_id: string; page_id: string } | undefined
  for (const phase of ["writer", "cold"]) {
    const child = spawn(process.execPath, [worker, root, phase], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const [exit] = await once(child, "close")
    expect(exit, stderr).toBe(0)
    const report = JSON.parse(stdout)
    expect(report).toMatchObject({
      reopen: phase === "cold",
      sole_main_bootstrap: true,
      complete_files: 4,
      raw_mode: "100755",
      normal_read_writes: 0,
    })
    if (original === undefined) original = report
    else {
      expect(report.review_id).toBe(original.review_id)
      expect(report.page_id).toBe(original.page_id)
    }
  }
}, 60_000)
