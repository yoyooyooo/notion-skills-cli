import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  originalObservedMarkdownCorrectionCandidate,
  recordedObservedMarkdownCorrection,
  hasObservedMarkdownCorrection,
  observedMarkdownCorrectionCoverage,
  correctionHash,
} from "../src/publication-markdown-history.ts"
const page = "11111111-1111-4111-8111-111111111111",
  ds = "22222222-2222-4222-8222-222222222222"
const root = `v1/pages/${page}`,
  bodyPath = `${root}/markdown`,
  inventory = `v1/blocks/${page}/children?page_size=100`,
  refs = `${root}/properties/refs?page_size=100`
const text = "# Original text\n\n```text\nexact source\n```\n"
const sha = (x) => createHash("sha256").update(x).digest("hex")
function original() {
  const properties = {
    References: { id: "refs", type: "rich_text", rich_text: [] },
    Files: { id: "files", type: "files", files: [] },
  }
  return {
    format: 1,
    operation_id: "p_original",
    operation: "create",
    scope: "scope-original",
    database_id: "db-original",
    data_source_id: ds,
    page_id: page,
    state: "failed",
    conflict: true,
    failure: { code: "WRITE_CONFLICT", message: "Retained false observation" },
    stages: ["create_page", "references", "checkpoint", "validate"],
    portable: {
      kind: "skill",
      name: "example",
      description: "description",
      main: "SKILL.md",
      files: [{ path: "SKILL.md", sha256: sha("full authored file") }],
    },
    guards: {
      [root]: {
        id: page,
        parent: { data_source_id: ds },
        last_edited_time: "original-revision",
        properties,
      },
      [bodyPath]: "",
      [inventory]: { results: [], has_more: false, next_cursor: null },
      [refs]: { object: "list", results: [], has_more: false, next_cursor: null },
    },
    intents: [
      {
        path: "v1/pages",
        method: "POST",
        status: "completed",
        body: {
          parent: { type: "data_source_id", data_source_id: ds },
          properties: { title: { title: [{ text: { content: "example" } }] } },
        },
        response: { id: page },
      },
      {
        path: root,
        method: "PATCH",
        status: "completed",
        body: { properties: { refs: { rich_text: [] } } },
        response: { id: page },
      },
      {
        path: bodyPath,
        method: "PATCH",
        status: "completed",
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: text },
        },
        response: { prior_status: "unknown", recovery: "observed_applied" },
      },
    ],
  }
}
function corrected() {
  const r = original(),
    checkpoint = {
      version: 1,
      operation_id: r.operation_id,
      page_id: page,
      scope: r.scope,
      database_id: r.database_id,
      data_source_id: ds,
      intended_hash: sha("intended"),
      original_intent_count: 3,
      original_journal_sha256: correctionHash(r.intents),
      original_guards: structuredClone(r.guards),
      original_guards_sha256: correctionHash(r.guards),
      original_portable_sha256: correctionHash(r.portable),
      original_context_sha256: correctionHash(r.context),
      original_receipt_sha256: correctionHash(r),
      integrity_sha256: sha("ledger"),
      source_sha256: r.portable.files[0].sha256,
      target_sha256: sha(text),
      metadata_before_sha256: correctionHash(r.guards[root]),
      metadata_after_sha256: correctionHash(r.guards[root]),
      inventory_sha256: sha("raw inventory"),
      references_sha256: sha("raw property"),
    }
  r.conflict_history = [
    {
      observed_at_ms: 1,
      conflict: true,
      state: r.state,
      stages: [...r.stages],
      failure: structuredClone(r.failure),
      guard_paths: Object.keys(r.guards),
      intent_count: 3,
      intended_hash: checkpoint.intended_hash,
      observed_markdown_correction: checkpoint,
    },
  ]
  delete r.conflict
  r.state = "running"
  return r
}
const successor = () => ({ ...structuredClone(original().intents[2]), response: { id: page } })
test("the exact empty legacy shape is diagnostic eligibility without changing any original bytes", () => {
  const r = original(),
    before = structuredClone(r)
  assert.equal(originalObservedMarkdownCorrectionCandidate(r).target, text)
  assert.deepEqual(r, before)
  assert.equal(recordedObservedMarkdownCorrection(r), undefined)
  assert.equal(observedMarkdownCorrectionCoverage(r), undefined)
})
test("real ACKs, nonempty or incomplete preimages, extra history and different requests do not qualify", () => {
  for (const mutate of [
    (r) => (r.intents[2].response = { id: page }),
    (r) => (r.intents[2].response.prior_status = "completed"),
    (r) => (r.intents[2].guards = {}),
    (r) => (r.guards[bodyPath] = " "),
    (r) => r.guards[inventory].results.push({ id: "external" }),
    (r) => (r.guards[inventory].has_more = true),
    (r) => (r.guards[refs].next_cursor = "next"),
    (r) => r.guards[root].properties.References.rich_text.push({ text: { content: "external" } }),
    (r) => r.intents.push(successor()),
    (r) => r.portable.files.push({ path: "references/a.md", sha256: sha("a") }),
    (r) => (r.owner = { pid: 10, host: "fixture" }),
    (r) => (r.operation = "replace"),
    (r) => (r.conflict_history = [{}]),
  ]) {
    const r = original()
    mutate(r)
    assert.equal(originalObservedMarkdownCorrectionCandidate(r), undefined)
  }
})
test("officially recorded correction preserves original request and requires a new successor", () => {
  const r = corrected(),
    before = structuredClone(r.intents)
  assert.equal(hasObservedMarkdownCorrection(r), true)
  assert.ok(recordedObservedMarkdownCorrection(r))
  assert.equal(observedMarkdownCorrectionCoverage(r), undefined)
  r.intents.push(successor())
  assert.deepEqual(observedMarkdownCorrectionCoverage(r), {
    path: bodyPath,
    intent_index: 2,
    covered_by_intent_index: 3,
  })
  assert.deepEqual(r.intents.slice(0, 3), before)
})
test("changing original journal, source, context, authentication or stored checkpoint refuses the certificate", () => {
  for (const mutate of [
    (r) => (r.intents[0].response.id = "other"),
    (r) => (r.intents[2].body.replace_content.new_str += " "),
    (r) => (r.portable.name = "changed"),
    (r) => (r.context = { ownership: {} }),
    (r) => (r.scope = "new-scope"),
    (r) => (r.database_id = "new-db"),
    (r) => (r.guards[bodyPath] = "external"),
    (r) =>
      (r.conflict_history[0].observed_markdown_correction.original_guards[bodyPath] = "external"),
    (r) => (r.conflict_history[0].observed_markdown_correction.source_sha256 = sha("changed")),
    (r) =>
      (r.conflict_history[0].observed_markdown_correction.metadata_after_sha256 = sha("changed")),
    (r) => r.conflict_history.push(r.conflict_history[0]),
  ]) {
    const r = corrected()
    mutate(r)
    assert.equal(recordedObservedMarkdownCorrection(r), undefined)
    assert.equal(observedMarkdownCorrectionCoverage(r), undefined)
  }
})
test("new unknown and failed sends retain the correction without claiming effect coverage", () => {
  for (const status of ["pending", "unknown", "failed"]) {
    const r = corrected(),
      next = successor()
    next.status = status
    delete next.response
    r.intents.push(next)
    assert.ok(recordedObservedMarkdownCorrection(r))
    assert.equal(observedMarkdownCorrectionCoverage(r), undefined)
  }
})
test("a no-effect chain may cover only an exact later completed request", () => {
  const r = corrected(),
    first = successor()
  first.status = "failed"
  first.response = { prior_status: "unknown", recovery: "known_not_applied", replayed_by_intent: 4 }
  r.intents.push(first, successor())
  assert.equal(observedMarkdownCorrectionCoverage(r).covered_by_intent_index, 4)
  r.intents[4].body.replace_content.new_str += " "
  assert.equal(observedMarkdownCorrectionCoverage(r), undefined)
})
test("an observed successor remains observed and requires independent completed whole-body proof", () => {
  const r = corrected(),
    next = successor()
  next.response = { prior_status: "unknown", recovery: "observed_applied" }
  r.intents.push(next)
  assert.equal(observedMarkdownCorrectionCoverage(r).covered_by_intent_index, 3)
  assert.equal(r.intents[3].response.id, undefined)
})
