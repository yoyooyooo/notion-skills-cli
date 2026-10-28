import { test } from "node:test"
import assert from "node:assert/strict"
import { contentAdoptionEditTimeFenceCandidate as candidate } from "../src/publication-content-adoption-metadata.ts"

const page = "11111111-1111-4111-8111-111111111111",
  path = `v1/pages/${page}`
const oldTime = "2026-10-21T00:00:00.000Z",
  ackTime = "2026-10-21T00:01:00.000Z"
const root = (time) => ({
  id: page,
  last_edited_time: time,
  properties: {
    Updated: { id: "updated", type: "last_edited_time", last_edited_time: time, keep: "exact" },
  },
})
function original() {
  return {
    page_id: page,
    operation: "replace",
    operation_id: "p_original",
    state: "failed",
    conflict: true,
    stages: [],
    context: { content_adoption: { plan_id: "ca_original", plan_hash: "original" } },
    failure: {
      code: "WRITE_CONFLICT",
      message: "An unrequested original field or physical resource changed.",
      details: { path },
    },
    guards: { [path]: root(ackTime) },
    intents: [
      {
        path,
        method: "PATCH",
        status: "completed",
        response: { id: page },
        guards: { [path]: root(oldTime) },
      },
    ],
  }
}

test("the exact historical shape is eligibility only and retains original ACK, fence and metadata", () => {
  const receipt = original(),
    before = structuredClone(receipt)
  const found = candidate(receipt)
  assert.equal(found.rootPath, path)
  assert.equal(found.before.last_edited_time, oldTime)
  assert.equal(found.acknowledged.last_edited_time, ackTime)
  assert.deepEqual(found.fields, [
    {
      name: "Updated",
      id: "updated",
      definition: { id: "updated", type: "last_edited_time", keep: "exact" },
    },
  ])
  assert.deepEqual(receipt, before)
})
test("other failures, paths and operation states cannot request correction", () => {
  for (const alter of [
    (r) => (r.conflict = false),
    (r) => (r.state = "unknown"),
    (r) => (r.operation = "create"),
    (r) => (r.failure.code = "CONTENT_ADOPTION_REFUSED"),
    (r) => (r.failure.message = "Other conflict"),
    (r) => (r.failure.details.path = path + "/markdown"),
    (r) => delete r.context.content_adoption,
    (r) => r.stages.push("other-stage"),
  ]) {
    const receipt = original()
    alter(receipt)
    assert.equal(candidate(receipt), undefined)
  }
})
test("live owners, completed results or existing correction history remain fenced", () => {
  for (const alter of [
    (r) => (r.owner = { pid: 1, host: "fixture" }),
    (r) => (r.result = { verified: true }),
    (r) => (r.conflict_history = [{ conflict: true }]),
  ]) {
    const receipt = original()
    alter(receipt)
    assert.equal(candidate(receipt), undefined)
  }
})
test("only one actual root property ACK is eligible; observed or unrelated effects stay out", () => {
  for (const alter of [
    (r) => r.intents.push(structuredClone(r.intents[0])),
    (r) => (r.intents[0].status = "unknown"),
    (r) => (r.intents[0].response.id = "other"),
    (r) => (r.intents[0].response.recovery = "observed_applied"),
    (r) => (r.intents[0].response.extra = true),
    (r) => (r.intents[0].method = "POST"),
    (r) => (r.intents[0].path += "/markdown"),
    (r) => (r.intents[0].typed_links = {}),
    (r) => (r.intents[0].zero_list_repair = {}),
    (r) => (r.intents[0].artifact = {}),
  ]) {
    const receipt = original()
    alter(receipt)
    assert.equal(candidate(receipt), undefined)
  }
})
test("a missing, unchanged or different acknowledged root identity cannot support correction", () => {
  for (const alter of [
    (r) => delete r.intents[0].guards,
    (r) => delete r.guards[path],
    (r) => (r.guards[path].id = "other"),
    (r) => (r.intents[0].guards[path].id = "other"),
    (r) => (r.guards[path].last_edited_time = oldTime),
    (r) => (r.guards[path].last_edited_time = ""),
    (r) => (r.intents[0].guards[path].last_edited_time = ""),
  ]) {
    const receipt = original()
    alter(receipt)
    assert.equal(candidate(receipt), undefined)
  }
})
test("automatic metadata must bind both revisions and preserve every field definition key", () => {
  for (const alter of [
    (r) => (r.guards[path].properties.Updated.last_edited_time = oldTime),
    (r) => (r.intents[0].guards[path].properties.Updated.last_edited_time = ackTime),
    (r) => (r.guards[path].properties.Updated.id = ""),
    (r) => (r.guards[path].properties.Updated.type = "date"),
    (r) => (r.guards[path].properties.Updated.extra = true),
    (r) => delete r.guards[path].properties.Updated,
    (r) => delete r.guards[path].properties.Updated.last_edited_time,
  ]) {
    const receipt = original()
    alter(receipt)
    assert.equal(candidate(receipt), undefined)
  }
})
