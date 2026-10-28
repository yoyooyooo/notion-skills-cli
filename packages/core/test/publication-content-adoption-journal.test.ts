import { test } from "bun:test"
import assert from "node:assert/strict"
import { Schema } from "effect"
import {
  contentAdoptionJournal,
  contentAdoptionMarkerBody,
  contentAdoptionOwnershipProperties,
  contentAdoptionWriting,
  contentAdoptionHandoffBody,
  ContentAdoptionPlanSchema,
  ContentAdoptionInputSchema,
  type ContentAdoptionPlan,
} from "../src/publication-content-adoption-authority.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import type { Receipt } from "../src/publication-model.ts"
import type { PublicationMarker } from "../src/publication-integrity-state.ts"
import { publicationProperties } from "../src/publication-integrity.ts"

function fixture() {
  const page = "11111111-1111-4111-8111-111111111111",
    database = "22222222-2222-4222-8222-222222222222"
  const source = "33333333-3333-4333-8333-333333333333",
    publisher = "44444444-4444-4444-8444-444444444444",
    hash = "a".repeat(64)
  const frozen = {
    kind: "skill" as const,
    name: "sample",
    description: "Use for sample",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", hash }],
  }
  const old: PublicationMarker = {
    version: 2,
    operation_id: "p_old",
    intended_hash: hash,
    state: "writing",
  }
  const plan: ContentAdoptionPlan = {
    format: 1,
    domain: "content_adoption",
    plan_id: "ca_" + hash,
    plan_hash: hash,
    original_plan: {
      version: 1,
      plan_id: "up_" + hash,
      plan_hash: hash,
      created_at: 1,
      subscription_id: publisher,
      subscription_version: "v",
      scope: hash,
      database_id: database,
      config_hash: hash,
      revision: "original",
      provenance: {},
      publisher_subscription_id: publisher,
      target_database_id: database,
      items: [],
    },
    original_operation: {
      operation_id: "uo_" + hash,
      plan_id: "up_" + hash,
      subscription_id: publisher,
      scope: hash,
      database_id: database,
      target_database_id: database,
      state: "unknown",
      items: [],
    },
    item_index: 0,
    original_publication_id: "p_original",
    original_integrity: {
      version: 1,
      operation_id: "p_original",
      intended_hash: hash,
      marker: { ...old, operation_id: "p_original" },
    },
    old_operation_id: "p_old",
    old_marker: old,
    old_history: "absent_in_current_database",
    page_id: page,
    database_id: database,
    data_source_id: source,
    scope: hash,
    frozen,
    intended_hash: hash,
    ownership: {
      subscription_id: publisher,
      member_key: "skills/sample",
      mode: "tracked",
      published_hash: hash,
      revision: "original",
    },
    evidence: {
      raw: {},
      files: [{ path: "SKILL.md", bytes: 10, sha256: hash }],
      attachments: [],
      page_ids: [page],
      graph_sha256: hash,
    },
    new_operation_id: "p_new",
  }
  const committed: PublicationMarker = {
    version: 2,
    state: "committed",
    operation_id: "p_new",
    intended_hash: hash,
    revision: hash,
    manifest_hash: hash,
    ownership_hash: hash,
  }
  const receipt: Receipt = {
    format: 1,
    operation_id: "p_new",
    operation: "replace",
    page_id: page,
    database_id: database,
    data_source_id: source,
    scope: hash,
    context: {
      ownership: plan.ownership,
      content_adoption: { plan_id: plan.plan_id, plan_hash: hash },
    },
    state: "running",
    portable: { ...frozen, files: [{ path: "SKILL.md", sha256: hash }] },
    guards: { [`v1/pages/${page}`]: { id: page }, [`v1/pages/${page}/markdown`]: "original" },
    intents: [],
    stages: [],
  }
  const bodies = [
    contentAdoptionMarkerBody(contentAdoptionWriting(plan)),
    { properties: contentAdoptionOwnershipProperties(plan) },
    contentAdoptionMarkerBody(committed),
  ]
  function add(stage: number, status: Receipt["intents"][number]["status"] = "completed") {
    receipt.intents.push({
      path: `v1/pages/${page}`,
      method: "PATCH",
      body: bodies[stage],
      guards: structuredClone(receipt.guards),
      status,
      ...(status === "completed" ? { response: { id: page } } : {}),
    })
  }
  return { plan, receipt, committed, bodies, page, add }
}

test("only the exact ordered three property effects complete the new adoption journal", () => {
  const f = fixture()
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, undefined)?.completed, 0)
  f.add(0)
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, undefined)?.completed, 1)
  f.add(1)
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, undefined)?.completed, 2)
  f.add(2)
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed)?.completed, 3)
})
test("unflagged adoption retains its original serialized plan, input and first property request", () => {
  const f = fixture()
  const decoded = Schema.decodeUnknownSync(ContentAdoptionPlanSchema)(f.plan, {
    onExcessProperty: "error",
  })
  assert.equal(canonical(decoded), canonical(f.plan))
  assert.equal(Object.hasOwn(decoded, "descriptor_migration"), false)
  const input = {
    original_plan_id: "up_original",
    member_key: "skills/sample",
    page_id: f.page,
    old_operation_id: "p_old",
  }
  assert.deepEqual(
    Schema.decodeUnknownSync(ContentAdoptionInputSchema)(input, { onExcessProperty: "error" }),
    input,
  )
  assert.equal(
    JSON.stringify(contentAdoptionHandoffBody(decoded)),
    JSON.stringify(contentAdoptionMarkerBody(contentAdoptionWriting(f.plan))),
  )
})
test("a decoded committed marker expects the exact native commit JSON string order", () => {
  const f = fixture()
  assert.equal(f.committed.state, "committed")
  if (f.committed.state !== "committed") throw new Error("Expected the committed marker")
  const decoded: PublicationMarker = {
    version: 2,
    operation_id: f.committed.operation_id,
    intended_hash: f.committed.intended_hash,
    state: "committed",
    revision: f.committed.revision,
    manifest_hash: f.committed.manifest_hash,
    ownership_hash: f.committed.ownership_hash,
  }
  const nativeBody = { properties: publicationProperties(f.committed) }
  assert.notEqual(JSON.stringify(decoded), JSON.stringify(f.committed))
  assert.deepEqual(contentAdoptionMarkerBody(decoded), nativeBody)
  f.add(0)
  f.add(1)
  f.add(2)
  f.receipt.intents[2] = { ...f.receipt.intents[2]!, body: nativeBody }
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, decoded)?.completed, 3)
})
test("native commit serialization still rejects every changed commit hash", () => {
  const f = fixture()
  f.add(0)
  f.add(1)
  f.add(2)
  for (const field of ["intended_hash", "revision", "manifest_hash", "ownership_hash"] as const) {
    f.receipt.intents[2] = {
      ...f.receipt.intents[2]!,
      body: { properties: publicationProperties({ ...f.committed, [field]: "b".repeat(64) }) },
    }
    assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed), undefined)
  }
})
for (const status of ["completed", "unknown", "pending"] as const)
  test(`a missing committed marker never admits an undefined third ${status} request`, () => {
    const f = fixture()
    f.add(0)
    f.add(1)
    f.add(2, status)
    const { body: _body, ...withoutBody } = f.receipt.intents[2]!
    f.receipt.intents[2] = withoutBody
    assert.equal(contentAdoptionJournal(f.receipt, f.plan, undefined), undefined)
  })
for (const stage of [0, 1, 2])
  test(`a terminal unknown effect ${stage} retains its index without completing it`, () => {
    const f = fixture()
    for (let i = 0; i < stage; i++) f.add(i)
    f.add(stage, "unknown")
    assert.deepEqual(contentAdoptionJournal(f.receipt, f.plan, f.committed), {
      completed: stage,
      pending_index: stage,
      pending_effect: stage,
    })
  })
test("a proven unapplied unknown remains failed while its exact next real retry can complete", () => {
  const f = fixture()
  f.add(0, "failed")
  f.receipt.intents[0]!.response = {
    recovery: "known_not_applied",
    prior_status: "unknown",
    replayed_by_intent: 1,
  }
  assert.deepEqual(contentAdoptionJournal(f.receipt, f.plan, f.committed), {
    completed: 0,
    retry_index: 0,
  })
  f.add(0)
  f.add(1)
  f.add(2)
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed)?.completed, 3)
  assert.equal(f.receipt.intents[0]!.status, "failed")
})
test("the new observed-applied effect remains confined to the exact same page and field", () => {
  const f = fixture()
  f.add(0)
  f.receipt.intents[0]!.response = {
    id: f.page,
    prior_status: "unknown",
    recovery: "observed_applied",
  }
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed)?.completed, 1)
  f.receipt.intents[0]!.response = {
    id: f.page,
    prior_status: "unknown",
    recovery: "another_protocol",
  }
  assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed), undefined)
})
for (const change of [
  "extra_body",
  "other_page",
  "post",
  "missing_guards",
  "wrong_guard_type",
  "wrong_response",
  "failed_without_proof",
  "old_recovery",
  "superseded",
  "wrong_retry",
  "later_unknown",
  "fourth_effect",
] as const)
  test(`journal refuses ${change}`, () => {
    const f = fixture()
    f.add(0)
    f.add(1)
    f.add(2)
    const first = f.receipt.intents[0]!
    if (change === "extra_body")
      f.receipt.intents[0] = { ...first, body: { ...f.bodies[0], archived: true } }
    if (change === "other_page")
      f.receipt.intents[0] = { ...first, path: "v1/pages/55555555-5555-4555-8555-555555555555" }
    if (change === "post") f.receipt.intents[0] = { ...first, method: "POST" }
    if (change === "missing_guards") {
      const { guards: _guards, ...rest } = first
      f.receipt.intents[0] = rest
    }
    if (change === "wrong_guard_type")
      f.receipt.intents[0] = {
        ...first,
        guards: { ...first.guards, [`v1/pages/${f.page}/markdown`]: {} },
      }
    if (change === "wrong_response") first.response = { id: "another-page" }
    if (change === "failed_without_proof") {
      first.status = "failed"
      first.response = undefined
    }
    if (change === "old_recovery") first.response = { id: f.page, recovery: "known_not_applied" }
    if (change === "superseded") first.response = { id: f.page, superseded_by: "p_other" }
    if (change === "wrong_retry") {
      first.status = "failed"
      first.response = {
        recovery: "known_not_applied",
        prior_status: "unknown",
        replayed_by_intent: 2,
      }
    }
    if (change === "later_unknown") {
      first.status = "unknown"
      first.response = undefined
    }
    if (change === "fourth_effect") f.add(2)
    assert.equal(contentAdoptionJournal(f.receipt, f.plan, f.committed), undefined)
  })
for (const change of [
  "plan",
  "hash",
  "ownership",
  "portable",
  "operation",
  "write_path",
  "members",
] as const)
  test(`journal does not borrow a different ${change} authority`, () => {
    const f = fixture()
    f.add(0)
    let receipt: Receipt = f.receipt
    if (change === "plan")
      receipt = {
        ...receipt,
        context: {
          ...receipt.context,
          content_adoption: { plan_id: "ca_other", plan_hash: f.plan.plan_hash },
        },
      }
    if (change === "hash")
      receipt = {
        ...receipt,
        context: {
          ...receipt.context,
          content_adoption: { plan_id: f.plan.plan_id, plan_hash: "b".repeat(64) },
        },
      }
    if (change === "ownership")
      receipt = {
        ...receipt,
        context: { ...receipt.context, ownership: { ...f.plan.ownership, member_key: "other" } },
      }
    if (change === "portable")
      receipt = { ...receipt, portable: { ...receipt.portable, description: "changed" } }
    if (change === "operation") receipt = { ...receipt, operation: "create" }
    if (change === "write_path")
      receipt = { ...receipt, context: { ...receipt.context, write_path: "@properties" } }
    if (change === "members") receipt = { ...receipt, context: { ...receipt.context, members: [] } }
    assert.equal(contentAdoptionJournal(receipt, f.plan, f.committed), undefined)
  })
