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
const suites = ["request-engine", "current-lifecycle", "notion-mcp-auth", "notion-mcp-search"]
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
  for (const lock of locks.slice(1))
    assert.deepEqual(locks[0], lock, "an unreviewed tool upgrade cannot hide in a new suite")
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
    for (const suite of suites) assert.ok(help.stdout.includes(suite))
  }
})

test("MCP auth keeps every reviewed candidate, defect and reachability witness", () => {
  const directory = join(root, "verification/models/notion-mcp-auth")
  const coverage = JSON.parse(readFileSync(join(directory, "coverage.json"), "utf8"))
  assert.equal(coverage.cases.length, 31)
  for (const [model, expected] of [
    ["AuthAcquisition", [6, 12, 3]],
    ["RefreshRotation", [2, 7, 1]],
  ]) {
    const rows = coverage.cases.filter((row) => row.model === model)
    assert.deepEqual(
      ["candidate", "deliberate-defect", "reachability-witness"].map(
        (kind) => rows.filter((row) => row.kind === kind).length,
      ),
      expected,
    )
    for (const row of rows) {
      assert.ok(row.expected_rules.includes("RequestsTerminate"))
      assert.ok(row.expected_rules.includes("NoDeadlock"))
      if (row.kind === "reachability-witness")
        assert.ok(
          row.expected_broken.every((rule) =>
            ["NoSuccessfulPair", "NoLocalCancelSuccess"].includes(rule),
          ),
        )
    }
  }
})

test("MCP views describe the checked guards and preserve the no-timeout temporal trace", async () => {
  const refresh = await import("../verification/models/notion-mcp-auth/RefreshRotation.view.mjs")
  const auth = await import("../verification/models/notion-mcp-auth/AuthAcquisition.view.mjs")
  const directory = join(root, "verification/models/notion-mcp-auth")
  const config = (name) => readFileSync(join(directory, name), "utf8")
  assert.equal(
    refresh.forConfig(config("RefreshRotation.no-lock.cfg")).step("Acquire"),
    "绕过互斥进入刷新",
  )
  assert.equal(
    refresh.forConfig(config("RefreshRotation.stale-read.cfg")).step("Acquire"),
    "取得锁但沿用旧快照",
  )
  assert.equal(
    refresh.forConfig(config("RefreshRotation.candidate.cfg")).step("Acquire"),
    "取得锁并重读版本",
  )
  assert.equal(
    auth.forConfig(config("AuthAcquisition.negative-no-timeout.cfg")).title,
    "Authorization wait without a timeout temporal counterexample",
  )
})
