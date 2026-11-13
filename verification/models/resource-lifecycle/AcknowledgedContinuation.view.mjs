export const title = "原 ACK 续接与同页恢复的验证边界"
const faults = (v) => [
  ...(!v.authorityExact ? ["违反：原请求或 ACK 集不完整"] : []),
  ...(!v.bodyCheckedBeforeWrite ? ["违反：正文变化后仍越过写入边界"] : []),
  ...(Object.values(v.attempts).some((n) => n > 1) ? ["违反：未知续接请求被重复派发"] : []),
  ...(v.coldVerified && v.proofs.length !== v.originalPages.length
    ? ["违反：冷读缺少完整原始共享证明"]
    : []),
]
const originalExact = (v) =>
  v.originalRequestsExact && v.originalAcks.length === v.originalPages.length

export function state(v) {
  const bad = faults(v)
  if (bad.length) return bad.join(" / ")
  if (v.phase === "reviewed" && !originalExact(v)) return "原请求事实已变化，必须停止"
  if (["reviewed", "ready"].includes(v.phase) && !v.fresh) return "当前正文已变化，必须停止"
  if (v.phase === "unknown")
    return v.acked.includes(v.step) ? "原 ACK 已留存，读回中断" : "没有原 ACK，结果未知"
  if (v.phase === "completed" && v.proofs.length !== v.originalPages.length)
    return "共享原始证明不完整，必须停止"
  return {
    inspect: "核对原请求和完整 ACK",
    reviewed: "独立续接决定已审阅",
    ready: "本阶段待派发",
    inflight: "本阶段已派发一次",
    response: "服务端已应用本阶段",
    readback: "原 ACK 已留存，待核实本阶段",
    blocked: "停止，不再派发",
    completed: "独立完成已留存，待冷读核实",
    "cold verified": "冷读已核实独立完成",
  }[v.phase]
}

export function step(action, from, to) {
  if (action === "VerifyStage")
    return to.phase === "completed" ? "核实最后阶段" : "核实本阶段，进入下一阶段"
  return (
    {
      Review: "核对完整原请求与持久 ACK",
      LoseOriginalEvidence: "原始请求事实变得不可用",
      Begin: "执行前复核精确原事实集",
      RejectOriginalEvidence: "拒绝不完整或额外原始派发",
      CurrentBodyChanges: "观察到当前正文变化",
      RejectCurrentBody: "派发前拒绝变化后的正文",
      Dispatch: "派发一次已授权续接请求",
      ProviderApplies: "服务端应用请求",
      PersistAck: "留存本次原始 ACK",
      RequestUncertain: "响应或读回变得不确定",
      ResumeAcknowledgedStage: "依原 ACK 继续读回，不再派发",
      ReplayIncompleteContinuation: "错误地重发未知原请求",
      ProofUnavailable: "完整共享 ACK 事实变得不可用",
      ColdVerify: "独立核对完整不可变证明",
      ColdReject: "拒绝不完整的不可变证据",
      ReadOnlyReconcile: null,
      Terminal: null,
    }[action] ?? action
  )
}
export const group = (v) =>
  faults(v).length
    ? "违例"
    : v.phase === "cold verified"
      ? "已验证"
      : ["blocked", "unknown"].includes(v.phase)
        ? "已停止或等待"
        : "执行中"
export const colors = { 违例: "pink", 已验证: "teal", 已停止或等待: "yellow", 执行中: "blue" }
