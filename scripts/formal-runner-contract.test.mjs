import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

test("guard mutation classification requires real assertions and rejects runner failures", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "notion-formal-mutation-results-"))
  const assertion = 'test("behavior", () => expect(1).toBe(2))'
  const timeout =
    'test("unfinished cleanup", async () => { expect(true).toBe(true); await new Promise(() => {}) })'
  const cases = [
    { name: "assertion", body: assertion, expected: true },
    { name: "assertion-github", body: assertion, github: true, expected: true },
    {
      name: "async-rejects",
      body: 'test("rejects", async () => { await expect(Promise.resolve({ ok: true })).rejects.toMatchObject({ code: "broken" }) })',
      expected: true,
    },
    {
      name: "async-resolves",
      body: 'test("resolves", async () => { await expect(Promise.resolve(1)).resolves.toBe(2) })',
      expected: true,
    },
    {
      name: "async-rejects-not",
      body: 'test("rejects not", async () => { await expect(Promise.reject({ code: "broken" })).rejects.not.toMatchObject({ code: "broken" }) })',
      expected: true,
    },
    {
      name: "async-resolves-not",
      body: 'test("resolves not", async () => { await expect(Promise.resolve(1)).resolves.not.toBe(1) })',
      expected: true,
    },
    { name: "timeout-with-expect-count", body: timeout, expected: false },
    { name: "timeout-github", body: timeout, github: true, expected: false },
    { name: "assertion-and-timeout", body: assertion + "\n" + timeout, expected: false },
    {
      name: "module-load",
      body: 'import "./missing-module.ts"\n' + assertion,
      expected: false,
    },
    {
      name: "assertion-and-module-error",
      body: assertion + '\ntest("load", async () => import("./missing-module.ts"))',
      expected: false,
    },
    { name: "syntax", body: "const = ;\n" + assertion, expected: false },
    { name: "passed", body: 'test("behavior", () => expect(1).toBe(1))', expected: false },
  ]
  const observations = cases.map(({ name, body, github, expected }) => {
    const path = join(scratch, name + ".test.ts")
    writeFileSync(path, 'import { expect, test } from "bun:test"\n' + body + "\n")
    const result = spawnSync("bun", ["test", path, "--timeout", "50"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, GITHUB_ACTIONS: github ? "true" : "" },
    })
    assert.equal(result.signal, null, `${name}: the subprocess must finish itself`)
    assert.equal(result.error, undefined)
    assert.equal(result.status, name === "passed" ? 0 : 1)
    writeFileSync(join(scratch, name + ".stdout.log"), result.stdout)
    writeFileSync(join(scratch, name + ".stderr.log"), result.stderr)
    return {
      name,
      returncode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      expected,
    }
  })
  const timedOut = observations.find(({ name }) => name === "timeout-with-expect-count")
  observations.push({
    name: "failure-and-expect-statistics-without-a-diagnostic",
    returncode: timedOut.returncode,
    stdout: "",
    stderr: timedOut.stderr
      .split("\n")
      .filter((line) => line.startsWith("(fail)") || line.includes("expect() calls"))
      .join("\n"),
    expected: false,
  })
  for (const [name, failures, expected] of [
    ["vitest-assertion", ["AssertionError: expected 1 to be 2"], true],
    ["vitest-assertion-ansi", ["\u001b[31mAssertionError: expected 1 to be 2\u001b[0m"], true],
    ["vitest-timeout", ["Error: Test timed out in 10000ms."], false],
    ["vitest-module", ["Error: Cannot find package 'missing' imported from test.ts"], false],
    ["vitest-syntax", ["SyntaxError: Unexpected token '='"], false],
    [
      "vitest-partial-assertion",
      ["AssertionError: expected 1 to be 2", "Error: Test timed out in 10000ms."],
      false,
    ],
    ["vitest-no-assertion", [], false],
  ])
    observations.push({
      name,
      returncode: 1,
      stdout: "",
      stderr: "",
      assertion_failures: failures,
      expected,
    })
  const classified = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sys",
        "from types import SimpleNamespace",
        "from scripts.formal_mutation_result import failed_assertion",
        "print(json.dumps([failed_assertion(SimpleNamespace(**row)) for row in json.load(sys.stdin)]))",
      ].join("\n"),
    ],
    { cwd: root, encoding: "utf8", input: JSON.stringify(observations) },
  )
  assert.equal(classified.status, 0, classified.stderr)
  const actual = JSON.parse(classified.stdout)
  writeFileSync(
    join(scratch, "observations.json"),
    JSON.stringify({ observations, actual }, null, 2),
  )
  t.diagnostic("Retained test-runner outputs: " + scratch)
  assert.deepEqual(
    actual,
    observations.map(({ expected }) => expected),
    observations.map(({ name }) => name).join(", "),
  )
})
