import assert from "node:assert/strict"
import test from "node:test"
import {
  step,
  state,
} from "../verification/models/resource-lifecycle/AcknowledgedContinuation.view.mjs"

test("the graph retains response loss after the service applied the request", () => {
  assert.equal(
    step("RequestUncertain", { phase: "response" }, { phase: "unknown" }),
    "响应或读回变得不确定",
  )
})
test("loss of original evidence stays visible after a body drift", () => {
  assert.equal(step("LoseOriginalEvidence", { fresh: false }, {}), "原始请求事实变得不可用")
})
test("unknown states distinguish the retained acknowledgement", () => {
  const value = {
    phase: "unknown",
    authorityExact: true,
    bodyCheckedBeforeWrite: true,
    attempts: { 1: 1 },
    coldVerified: false,
    proofs: [],
    originalPages: [],
    step: 1,
    acked: [],
  }
  assert.notEqual(state(value), state({ ...value, acked: [1] }))
})
