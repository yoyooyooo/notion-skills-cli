#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { inspect } from "node:util"

const repository = path.resolve(import.meta.dirname, "..")
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const out = path.resolve(
  option("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "notion-formal-")),
)
const tool = option("--statechart") ?? process.env.PSTACK_STATECHART_ROOT
const jar = option("--jar") ?? process.env.TLA2TOOLS
if (!tool || !jar)
  throw new Error(
    "Pass --statechart PATH_TO_PINNED_SKILL and --jar PATH_TO_TLA2TOOLS_1_7_4. See verification/models/resource-lifecycle/README.md.",
  )
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const coverage = JSON.parse(
  fs.readFileSync(
    path.join(repository, "verification/models/resource-lifecycle/coverage.json"),
    "utf8",
  ),
)
for (const [file, expected] of Object.entries(coverage.files))
  assert.equal(
    hash(fs.readFileSync(path.join(repository, file))),
    expected,
    `Model/source correspondence needs review before verification: ${file}`,
  )
assert.equal(
  hash(fs.readFileSync(jar)),
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
)
const upstream = spawnSync("git", ["-C", tool, "rev-parse", "HEAD"], { encoding: "utf8" })
assert.equal(upstream.status, 0)
assert.equal(upstream.stdout.trim(), "c742dd61706fbacc1b95f1a20b7b988cf096ce6c")
if (fs.existsSync(out)) assert.equal(fs.readdirSync(out).length, 0, "Use a new output directory")
else fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const tmp = path.join(out, "scratch"),
  retained = path.join(out, "retained-tool-temporaries"),
  models = path.join(out, "model-inputs")
for (const p of [tmp, retained, models]) fs.mkdirSync(p, { mode: 0o700 })
fs.cpSync(path.join(repository, "verification/models/resource-lifecycle"), models, {
  recursive: true,
})
process.env.TMPDIR = tmp
process.env.TLA2TOOLS = path.resolve(jar)
// Pstack normally deletes its own temporary directories. The user's project
// policy requires retention instead. This adapter preserves those directories
// and changes neither TLC options nor the chart/check algorithms.
const rm = fs.rmSync
fs.rmSync = (name, ...rest) => {
  const absolute = path.resolve(String(name))
  assert.equal(path.dirname(absolute), tmp, "Refuse cleanup outside this owned run")
  assert.ok(path.basename(absolute).startsWith("statechart-"))
  fs.renameSync(absolute, path.join(retained, path.basename(absolute)))
}
const matrix = [
  ["ProjectionRace", "cfg", []],
  ["ProjectionRace", "broken.cfg", ["HumanEditPreserved"]],
  ["UpdateCommit", "cfg", []],
  [
    "UpdateCommit",
    "broken.cfg",
    ["AtMostOneDispatch", "SelectedVersionComplete", "SessionPinStable", "NoInventedOutcome"],
  ],
  ["UpdateCommit", "retry.cfg", ["AtMostOneDispatch"]],
  ["UpdateCommit", "early.cfg", ["SelectedVersionComplete"]],
  ["UpdateCommit", "moving.cfg", ["SessionPinStable"]],
  ["UpdateCommit", "inference.cfg", ["NoInventedOutcome"]],
  ["AuditRun", "cfg", []],
  ["AuditRun", "broken.cfg", ["CompleteMeansCovered"]],
  ["AuditRun", "mutating.cfg", ["AuditReadOnly"]],
  ["AuditRun", "reset.cfg", ["CheckpointMonotone", "EventuallyReport"]],
  ["AuditRun", "limited.cfg", []],
  ["AuditRun", "liveness.cfg", []],
  ["ImportCreate", "cfg", []],
  ["ImportCreate", "retry.cfg", ["AtMostOneDispatch"]],
  ["ImportCreate", "early.cfg", ["EnableRequiresComplete"]],
  ["ImportCreate", "inference.cfg", ["ConfirmationNeedsOriginalAck"]],
  ["ImportCreate", "stale.cfg", ["FrozenInputRequired"]],
]
const summary = {
  source_commit: coverage.synchronized_commit,
  source_hashes_verified: Object.keys(coverage.files),
  source_hashes: coverage.files,
  review_basis: coverage.review_basis,
  model_import_commit: coverage.model_import_commit,
  model_kinds: Object.fromEntries(
    Object.entries(coverage.models).map(([name, model]) => [name, model.kind]),
  ),
  pstack_commit: upstream.stdout.trim(),
  tlc: "1.7.4",
  runs: [],
  complete: false,
}
const writeSummary = () =>
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
try {
  const { check } = await import(pathToFileURL(path.join(tool, "scripts/run.ts")))
  const { compile } = await import(pathToFileURL(path.join(tool, "scripts/pipeline.ts")))
  const { checkView } = await import(pathToFileURL(path.join(tool, "scripts/frontends/view.ts")))
  for (const [name, suffix, expected] of matrix) {
    const destination = path.join(out, `${name}-${suffix.replaceAll(".", "-")}`)
    fs.mkdirSync(destination)
    const result = await check(
      path.join(models, name + ".tla"),
      path.join(models, name + "." + suffix),
    )
    const view = checkView(
      await import(pathToFileURL(path.join(models, name + ".view.mjs"))),
      inspect,
    )
    const rendered = compile(result, view)
    for (const [file, parts] of rendered.files) {
      const fd = fs.openSync(path.join(destination, file), "wx")
      try {
        for (const part of parts)
          fs.writeSync(fd, typeof part === "string" ? Buffer.from(part) : part)
        fs.writeSync(fd, "\n")
      } finally {
        fs.closeSync(fd)
      }
    }
    const rules = [...result.rules, ...result.properties].map(({ rule, outcome }) => ({
      name: rule.name,
      kind: rule.kind,
      outcome,
    }))
    const broken = rules
      .filter((x) => x.outcome === "broken")
      .map((x) => x.name)
      .sort()
    const row = {
      model: name,
      config: suffix,
      states: result.states,
      exit: result.exit,
      rules,
      expected_broken: [...expected].sort(),
      matches: JSON.stringify(broken) === JSON.stringify([...expected].sort()),
      report: path.relative(out, path.join(destination, "report.md")),
    }
    summary.runs.push(row)
    writeSummary()
    console.log(JSON.stringify(row))
    assert.notEqual(result.exit, 2, `Tool/model error: ${name}/${suffix}`)
    assert.ok(
      result.states.complete && !result.states.cut,
      `Incomplete state exploration: ${name}/${suffix}`,
    )
    assert.ok(row.matches, `Unexpected verification result: ${name}/${suffix}`)
    assert.ok(
      rules.every((x) => x.outcome === "holds" || x.outcome === "broken"),
      "A rule remained unchecked",
    )
  }
  summary.complete = true
  writeSummary()
} finally {
  fs.rmSync = rm
  writeSummary()
}
console.log(`Formal model and shortest-path charts saved: ${out}`)
