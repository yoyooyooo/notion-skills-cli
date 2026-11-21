import assert from "node:assert/strict"
import test from "node:test"
import { assertRunReceipt, summarizeRunReceipts } from "./run-receipt.mjs"

const sha = "a".repeat(64)
const valid = () => ({
  version: 1,
  run_id: "schema-fixture",
  contract_ids: ["C11"],
  scenario_id: "T23",
  status: "passed",
  command: { argv: ["node", "--test", "verification/run-receipt.test.mjs"], cwd: "/owned/cli" },
  started_at: "2026-11-21T00:00:00Z",
  finished_at: "2026-11-21T00:00:01Z",
  source_tuple: [{ repository: "cli", commit: "b".repeat(40), dirty: false, tree_sha256: sha }],
  loaded_artifacts: [
    { role: "checker", path: "/owned/cli/verification/run-receipt.mjs", sha256: sha },
  ],
  environment: { machine: "fixture", runtime: "Node test", scope_fingerprint: "not_applicable" },
  initial_state: {
    cache: "not_applicable",
    session: "not_applicable",
    oracle: "not_applicable",
    proof: null,
  },
  evidence: {
    layer: "static",
    notion: "not_used",
    host: "not_used",
    provider: "not_used",
    prompt_kind: "none",
  },
  raw_evidence: [{ uri: "/owned/run/test.log", sha256: sha }],
  retest_of: null,
  reason: null,
})

test("field validation is not behavior proof, and non-passed results remain non-passed", () => {
  assertRunReceipt(valid())
  assert.equal(summarizeRunReceipts([]).status, "not_run")
  for (const status of ["failed", "blocked", "not_run"]) {
    const result = {
      ...valid(),
      run_id: status,
      status,
      reason: "deliberate result contract example",
    }
    if (status === "not_run")
      Object.assign(result, {
        command: null,
        started_at: null,
        finished_at: null,
        raw_evidence: [],
      })
    assertRunReceipt(result)
    assert.equal(summarizeRunReceipts([valid(), result]).status, status)
  }
})
test("missing execution, source bytes, raw evidence and cold proof cannot become passed", () => {
  for (const mutate of [
    (r) => {
      r.command = null
    },
    (r) => {
      r.source_tuple = []
    },
    (r) => {
      r.loaded_artifacts = []
    },
    (r) => {
      r.raw_evidence = []
    },
    (r) => {
      r.started_at = r.finished_at = null
    },
    (r) => {
      r.initial_state.cache = "cold"
    },
    (r) => {
      r.source_tuple[0].tree_sha256 = "branch-name"
    },
    (r) => {
      r.source_tuple[0].commit = "next"
    },
  ]) {
    const result = valid()
    mutate(result)
    assert.throws(() => assertRunReceipt(result))
  }
})
test("controlled provider and tool-directed prompts cannot be relabeled as natural live evidence", () => {
  const natural = valid()
  natural.source_tuple.push({ ...natural.source_tuple[0], repository: "broker" })
  natural.evidence = {
    layer: "natural",
    notion: "live",
    host: "pi",
    provider: "live",
    prompt_kind: "natural",
  }
  assertRunReceipt(natural, { layer: "live" })
  for (const [key, value] of [
    ["notion", "fixture"],
    ["host", "fixture"],
    ["provider", "controlled"],
    ["prompt_kind", "tool_directed"],
  ])
    assert.throws(() =>
      assertRunReceipt({ ...natural, evidence: { ...natural.evidence, [key]: value } }),
    )
  assert.throws(() => assertRunReceipt(valid(), { layer: "live" }))
  assert.throws(() => assertRunReceipt(natural, { machine: "Mini" }))
})
test("unknown contracts, old shapes and duplicate attempts are rejected", () => {
  assert.throws(() => assertRunReceipt({ ...valid(), version: 0 }))
  assert.throws(() => assertRunReceipt({ ...valid(), scenario_id: "T99" }))
  assert.throws(() => assertRunReceipt({ ...valid(), contract_ids: ["C01"] }))
  assert.throws(() => assertRunReceipt({ ...valid(), extra_compatibility_field: true }))
  assert.throws(() => summarizeRunReceipts([valid(), valid()]))
  assert.throws(() => assertRunReceipt({ ...valid(), retest_of: "schema-fixture" }))
})
test("cold execution retains independent initial-state proof", () => {
  const result = valid()
  result.initial_state = {
    cache: "cold",
    session: "new",
    oracle: "independent",
    proof: result.raw_evidence[0],
  }
  assertRunReceipt(result)
  assert.throws(() =>
    assertRunReceipt({
      ...result,
      initial_state: { ...result.initial_state, oracle: "same_store" },
    }),
  )
  assert.throws(() =>
    assertRunReceipt({
      ...result,
      initial_state: { ...result.initial_state, proof: { uri: "/missing", sha256: sha } },
    }),
  )
})
