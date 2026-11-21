import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { assertFormalCase } from "./formal-result-contract.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const suites = ["request-engine", "current-lifecycle"]
test("current suites share one driver and frozen tools while owning independent inventories", () => {
  const locks = []
  for (const suite of suites) {
    const directory = join(root, "verification/models", suite)
    const coverage = JSON.parse(readFileSync(join(directory, "coverage.json"), "utf8"))
    locks.push(JSON.parse(readFileSync(join(directory, "tool-lock.json"), "utf8")))
    assert.equal(coverage.maintenance.runner, "scripts/verify-formal.mjs --suite " + suite)
    assert.ok(coverage.cases.length)
    const ids = new Set()
    for (const row of coverage.cases) {
      assertFormalCase(row)
      assert.ok(!ids.has(row.model + "/" + row.config), "duplicate configured case")
      ids.add(row.model + "/" + row.config)
      assert.ok(existsSync(join(directory, row.model + ".tla")))
      assert.ok(existsSync(join(directory, row.model + "." + row.config)))
      assert.ok(existsSync(join(directory, row.model + ".view.mjs")))
      assert.ok(row.expected_rules.includes("NoDeadlock"))
    }
    for (const model of new Set(coverage.cases.map((row) => row.model))) {
      assert.ok(coverage.cases.some((row) => row.model === model && !row.expected_broken.length))
      assert.ok(coverage.cases.some((row) => row.model === model && row.expected_broken.length))
    }
  }
  assert.deepEqual(locks[0], locks[1], "an unreviewed tool upgrade cannot hide in a new suite")
  assert.equal(existsSync(join(root, "scripts/verify-request-engine.mjs")), false)
  assert.equal(existsSync(join(root, "scripts/check-request-engine-mutations.py")), false)
})
test("unknown or omitted suite is rejected before any output workspace is created", () => {
  for (const tool of [
    ["node", "scripts/verify-formal.mjs"],
    ["python3", "scripts/check-formal-mutations.py"],
  ]) {
    for (const args of [[], ["--suite", "retired-ack"]]) {
      const out = join(tmpdir(), "notion-formal-must-not-exist-" + randomUUID())
      const result = spawnSync(tool[0], [...tool.slice(1), ...args, "--out", out], {
        cwd: root,
        encoding: "utf8",
      })
      assert.notEqual(result.status, 0)
      assert.equal(existsSync(out), false)
    }
    const help = spawnSync(tool[0], [...tool.slice(1), "--help"], { cwd: root, encoding: "utf8" })
    assert.equal(help.status, 0)
    assert.ok(help.stdout.includes("current-lifecycle") && help.stdout.includes("request-engine"))
  }
})
