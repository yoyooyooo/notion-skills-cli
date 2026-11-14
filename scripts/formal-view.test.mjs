import assert from "node:assert/strict"
import test from "node:test"
import { state as maintenanceState } from "../verification/models/operation-recovery/MaintenanceApply.view.mjs"
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

test("reviewed partial presentation never relabels the original write as successful", () => {
  const s = {
    phase: "reviewed_failure",
    attempts: { 1: 1 },
    verified: [],
    reviewed: [1],
    child: 1,
    pending: true,
    currentRead: "old",
    prefixBeforeSend: true,
    frozenBeforeSend: true,
    outcomes: [],
  }
  assert.match(maintenanceState({ s }), /不把原写入改为成功/)
  assert.match(
    maintenanceState({ s: { ...s, phase: "partial", pending: false } }),
    /父操作部分完成/,
  )
  assert.match(
    maintenanceState({ s: { ...s, phase: "partial", pending: false, reviewed: [] } }),
    /未审阅原失败/,
  )
})
