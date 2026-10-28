import assert from "node:assert/strict"
import { test } from "node:test"
import {
  markdownReplayRequest,
  pendingMarkdownReplayCandidate,
  publicationMarkdownReplayCandidates,
  terminalRecordedMarkdownReplay,
} from "../src/publication-markdown-replay.ts"
const page = "11111111-1111-4111-8111-111111111111"
const path = `v1/pages/${page}/markdown`
const target = "# Keep full source\n\nRead [exact](https://example.test/a?q=1#part).\n"
const body = {
  markdown_version: "v2",
  type: "replace_content",
  replace_content: { new_str: target },
}
const intent = () => ({ path, method: "PATCH", status: "unknown", body: structuredClone(body) })
const receipt = () => ({ guards: { [path]: "" }, intents: [intent()] })
const fail = () => ({
  ...intent(),
  status: "failed",
  response: { prior_status: "unknown", recovery: "known_not_applied", replayed_by_intent: 1 },
})
const ack = () => ({ ...intent(), status: "completed", response: { id: page } })

test("pending terminal full replacement is eligible only when raw Markdown remains exactly before", () => {
  const r = receipt()
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], "").target, target)
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], "\n"), undefined)
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], target), undefined)
  assert.equal(r.intents[0].status, "unknown")
  assert.equal(r.intents[0].response, undefined)
})
test("fenced, nonterminal, acknowledged and typed-link mutations cannot enter the pending replay path", () => {
  for (const change of [
    (r) => (r.conflict = true),
    (r) => r.intents.push(intent()),
    (r) => (r.intents[0].response = { id: page }),
    (r) => (r.intents[0].typed_links = { page_id: page, markdown: target, state: "pending" }),
    (r) => (r.intents[0].status = "completed"),
  ]) {
    const r = receipt()
    const old = r.intents[0]
    change(r)
    assert.equal(pendingMarkdownReplayCandidate(r, old, ""), undefined)
  }
})
test("full request validation rejects partial updates and unknown request effects", () => {
  for (const change of [
    (i) => (i.body.markdown_version = "v1"),
    (i) => (i.body.type = "update_content"),
    (i) => (i.body.replace_content.extra = true),
    (i) => (i.body.allow_deleting_content = true),
    (i) => (i.method = "POST"),
    (i) => (i.path = `v1/blocks/${page}`),
    (i) => (i.recovery = { kind: "remote_orphan" }),
  ]) {
    const i = intent()
    change(i)
    assert.equal(markdownReplayRequest(i), undefined)
  }
})
test("a byte-identical consecutive actual ACK covers only its failed original index", () => {
  const r = { intents: [fail(), ack()] }
  const before = structuredClone(r)
  assert.deepEqual(publicationMarkdownReplayCandidates(r), [
    { path, intent_index: 0, covered_by_intent_index: 1 },
  ])
  assert.deepEqual(r, before)
})
test("multiple no-effect retries require one exact chain ending in a real ACK", () => {
  const a = fail(),
    b = fail()
  b.response.prior_status = "pending"
  b.response.replayed_by_intent = 2
  const r = { intents: [a, b, ack()] }
  assert.deepEqual(publicationMarkdownReplayCandidates(r), [
    { path, intent_index: 0, covered_by_intent_index: 2 },
    { path, intent_index: 1, covered_by_intent_index: 2 },
  ])
})
test("unsettled effect, invalid observed effect, other owner, changed body or changed URL cannot cover history", () => {
  for (const change of [
    (r) => (r.intents[1].status = "unknown"),
    (r) => (r.intents[1].response = { prior_status: "completed", recovery: "observed_applied" }),
    (r) => (r.intents[1].response.id = "22222222-2222-4222-8222-222222222222"),
    (r) => (r.intents[1].body.replace_content.new_str += " "),
    (r) => (r.intents[1].body.replace_content.new_str = target.replace("q=1", "q=2")),
    (r) => (r.intents[0].response.replayed_by_intent = 2),
    (r) => (r.intents[0].response.prior_status = "completed"),
    (r) => (r.intents[1].response.recovery = "observed_applied"),
    (r) => (r.intents[1].typed_links = { state: "completed" }),
  ]) {
    const r = { intents: [fail(), ack()] }
    change(r)
    assert.deepEqual(publicationMarkdownReplayCandidates(r), [])
  }
})
test("a skipped successor or unrelated intervening mutation cannot be covered", () => {
  const a = fail()
  a.response.replayed_by_intent = 2
  const r = {
    intents: [
      a,
      {
        path: `v1/pages/${page}`,
        method: "PATCH",
        body: { properties: {} },
        status: "completed",
        response: { id: page },
      },
      ack(),
    ],
  }
  assert.deepEqual(publicationMarkdownReplayCandidates(r), [])
})

test("an independently observed successor is a candidate but never becomes a manufactured server ACK", () => {
  const terminal = { ...ack(), response: { prior_status: "unknown", recovery: "observed_applied" } }
  const r = { intents: [fail(), terminal] },
    before = structuredClone(r)
  assert.deepEqual(publicationMarkdownReplayCandidates(r), [
    { path, intent_index: 0, covered_by_intent_index: 1 },
  ])
  assert.deepEqual(r, before)
  assert.equal(r.intents[1].response.id, undefined)
})
test("a terminal no-effect checkpoint survives the crash before appending its successor", () => {
  const r = { guards: { [path]: "" }, intents: [fail()] }
  assert.equal(terminalRecordedMarkdownReplay(r), r.intents[0])
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], "").target, target)
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], target), undefined)
  assert.equal(pendingMarkdownReplayCandidate(r, r.intents[0], "external"), undefined)
  const original = structuredClone(r.intents[0])
  r.intents.push(ack())
  assert.equal(terminalRecordedMarkdownReplay(r), undefined)
  assert.deepEqual(r.intents[0], original)
})
