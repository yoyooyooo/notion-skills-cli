import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const index = JSON.parse(readFileSync(new URL("./skill-domains.json", import.meta.url), "utf8"))
const layers = ["static", "model", "unit", "store", "sdk", "host", "installed", "live", "natural"]
const statuses = ["passed", "failed", "blocked", "not_run"]
const text = (value, name) => assert.ok(typeof value === "string" && value.trim(), name)
const hash = (value) => assert.match(value, /^[a-f0-9]{64}$/u)
function artifact(value) {
  text(value.uri, "artifact uri")
  hash(value.sha256)
}
function exact(value, keys, name) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), name)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), name + " fields")
}

/** Validate a receipt from an existing runner. This neither runs tests nor proves its claims. */
export function assertRunReceipt(value, required = {}) {
  exact(
    value,
    [
      "version",
      "run_id",
      "contract_ids",
      "scenario_id",
      "status",
      "command",
      "started_at",
      "finished_at",
      "source_tuple",
      "loaded_artifacts",
      "environment",
      "initial_state",
      "evidence",
      "raw_evidence",
      "retest_of",
      "reason",
    ],
    "receipt",
  )
  assert.equal(value.version, 1, "unsupported receipt version")
  text(value.run_id, "run_id")
  assert.ok(statuses.includes(value.status), "result status")
  assert.ok(Array.isArray(value.contract_ids) && value.contract_ids.length, "contract_ids")
  assert.equal(new Set(value.contract_ids).size, value.contract_ids.length, "duplicate contract")
  const scenario = index.scenarios.find((item) => item.id === value.scenario_id)
  assert.ok(scenario, "unknown scenario")
  for (const id of value.contract_ids)
    assert.ok(
      scenario.contracts.includes(id) ||
        (id === "C07" && scenario.contracts.some((c) => c.startsWith("C07"))),
      "scenario/contract mismatch",
    )
  assert.ok(
    value.retest_of === null ||
      (typeof value.retest_of === "string" && value.retest_of !== value.run_id),
    "retest_of",
  )
  if (value.status === "passed") assert.equal(value.reason, null, "passed reason")
  else text(value.reason, "non-passed reason")
  exact(value.environment, ["machine", "runtime", "scope_fingerprint"], "environment")
  for (const field of ["machine", "runtime", "scope_fingerprint"])
    text(value.environment[field], field)
  exact(value.evidence, ["layer", "notion", "host", "provider", "prompt_kind"], "evidence")
  const evidence = value.evidence
  assert.ok(layers.includes(evidence.layer), "evidence layer")
  assert.ok(["not_used", "fixture", "live"].includes(evidence.notion), "Notion provenance")
  assert.ok(["not_used", "fixture", "pi"].includes(evidence.host), "host provenance")
  assert.ok(["not_used", "controlled", "live"].includes(evidence.provider), "provider provenance")
  assert.ok(["none", "tool_directed", "natural"].includes(evidence.prompt_kind), "prompt kind")
  if (evidence.layer === "live") {
    assert.equal(evidence.notion, "live", "live Notion is required")
    assert.equal(evidence.host, "pi", "live Pi is required")
    assert.equal(evidence.provider, "live", "live provider is required")
  }
  if (evidence.layer === "natural") {
    assert.notEqual(evidence.notion, "fixture", "fixture cannot establish natural live use")
    assert.equal(evidence.host, "pi", "natural task requires Pi")
    assert.equal(evidence.provider, "live", "controlled provider is not a natural model")
    assert.equal(evidence.prompt_kind, "natural", "tool-directed prompt is not natural")
  }
  if (required.layer) {
    assert.ok(
      evidence.layer === required.layer ||
        (required.layer === "live" && evidence.layer === "natural" && evidence.notion === "live"),
      "required evidence layer not established",
    )
  }
  if (required.machine)
    assert.equal(value.environment.machine, required.machine, "physical machine mismatch")
  exact(value.initial_state, ["cache", "session", "oracle", "proof"], "initial_state")
  assert.ok(
    ["cold", "warm", "partial", "unknown", "not_applicable"].includes(value.initial_state.cache),
    "cache state",
  )
  text(value.initial_state.session, "session state")
  assert.ok(
    ["independent", "same_store", "not_applicable"].includes(value.initial_state.oracle),
    "oracle provenance",
  )
  assert.ok(Array.isArray(value.raw_evidence), "raw evidence")
  value.raw_evidence.forEach(artifact)
  if (value.initial_state.proof !== null) artifact(value.initial_state.proof)
  if (value.initial_state.cache === "cold" && value.status === "passed") {
    assert.equal(
      value.initial_state.oracle,
      "independent",
      "cold oracle must not prewarm the consumer",
    )
    assert.ok(value.initial_state.proof, "cold initial-state proof")
    assert.ok(
      value.raw_evidence.some(
        (item) =>
          item.uri === value.initial_state.proof.uri &&
          item.sha256 === value.initial_state.proof.sha256,
      ),
      "initial-state proof must be retained",
    )
  }
  assert.ok(
    Array.isArray(value.source_tuple) && Array.isArray(value.loaded_artifacts),
    "source and loaded artifacts",
  )
  for (const source of value.source_tuple) {
    exact(source, ["repository", "commit", "dirty", "tree_sha256"], "source")
    assert.ok(["cli", "broker"].includes(source.repository), "repository")
    assert.match(source.commit, /^[a-f0-9]{40}$/u)
    assert.equal(typeof source.dirty, "boolean")
    hash(source.tree_sha256)
  }
  assert.equal(
    new Set(value.source_tuple.map((s) => s.repository)).size,
    value.source_tuple.length,
    "duplicate source",
  )
  for (const loaded of value.loaded_artifacts) {
    exact(loaded, ["role", "path", "sha256"], "loaded artifact")
    text(loaded.role, "loaded role")
    text(loaded.path, "actual loaded path")
    hash(loaded.sha256)
  }
  if (value.command !== null) {
    exact(value.command, ["argv", "cwd"], "command")
    assert.ok(
      Array.isArray(value.command.argv) &&
        value.command.argv.length &&
        value.command.argv.every((arg) => typeof arg === "string"),
      "argv",
    )
    text(value.command.argv[0], "executable")
    text(value.command.cwd, "cwd")
  }
  const executed = value.started_at !== null || value.finished_at !== null
  if (executed) {
    const start = Date.parse(value.started_at),
      finish = Date.parse(value.finished_at)
    assert.ok(
      Number.isFinite(start) && Number.isFinite(finish) && finish >= start,
      "execution timestamps",
    )
    assert.ok(value.command && value.raw_evidence.length, "executed command and retained evidence")
  }
  if (["passed", "failed"].includes(value.status)) {
    assert.ok(
      executed && value.source_tuple.length && value.loaded_artifacts.length,
      "executed source and actual loaded identity",
    )
  }
  if (value.status === "not_run")
    assert.equal(executed, false, "not_run cannot contain an executed interval")
  if (
    value.status === "passed" &&
    ["host", "installed", "live", "natural"].includes(evidence.layer)
  )
    assert.deepEqual(
      value.source_tuple.map((s) => s.repository).sort(),
      ["broker", "cli"],
      "paired source tuple",
    )
  return value
}

/** Summarize this selected run set. Preserve earlier failed attempts through retest_of and raw evidence. */
export function summarizeRunReceipts(receipts) {
  receipts.forEach((receipt) => assertRunReceipt(receipt))
  assert.equal(
    new Set(receipts.map((receipt) => receipt.run_id)).size,
    receipts.length,
    "duplicate run",
  )
  const counts = Object.fromEntries(
    statuses.map((status) => [status, receipts.filter((r) => r.status === status).length]),
  )
  const status = counts.failed
    ? "failed"
    : counts.blocked
      ? "blocked"
      : !receipts.length || counts.not_run
        ? "not_run"
        : "passed"
  return { status, counts, run_ids: receipts.map((r) => r.run_id) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(
      "Usage: node verification/run-receipt.mjs /absolute/existing/receipt.json\nChecks fields and proof level only; does not run or certify the underlying task.",
    )
  } else {
    assert.equal(process.argv.length, 3, "Supply one existing receipt")
    assertRunReceipt(JSON.parse(readFileSync(process.argv[2], "utf8")))
    console.log(JSON.stringify({ status: "receipt-valid", behavior_verified: false }))
  }
}
