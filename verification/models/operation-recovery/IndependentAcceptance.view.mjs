export const title = "独立接受保留原失败事实"
const faults = (s) => [
  ...(s.authorized && s.originalStatus !== "needs_review" ? ["违反已知原失败前提"] : []),
  ...(!s.sentAgainstFrozen ? ["违反冻结 File 所有者和 frontier"] : []),
  ...(s.authorized && s.acceptanceOperation === s.originalOperation ? ["违反独立接受身份"] : []),
  ...(s.oldCompletion !== "unproven" || s.oldAck ? ["错误地将当前相等改写为原成功"] : []),
  ...(s.replayed || Object.values(s.attempts).some((n) => n > 1)
    ? ["违反未知接受请求禁止重派发"]
    : []),
  ...(s.accepted && ![1, 2, 3].every((r) => s.confirmed.includes(r))
    ? ["违反完整 review adopted completion 顺序"]
    : []),
  ...(s.coldVerified && s.coldAvailable.length !== 5 ? ["违反完整共享证明冷读"] : []),
]
export function state({ s }) {
  const bad = faults(s)
  if (bad.length) return bad.join(" / ")
  if (s.phase === "cold read")
    return s.coldAvailable.length === 5 ? "五项完整共享证明可读" : "共享原事实或独立接受证明缺失"
  if (s.phase === "unknown dispatch")
    return s.acks.includes(s.record)
      ? "本 Record 原 ACK 已留存但读回中断"
      : "本 Record 无 ACK 结果未知"
  if (
    s.phase === "before dispatch" &&
    (s.currentFile !== s.frozenFile ||
      s.currentOwner !== s.frozenOwner ||
      s.currentFrontier !== s.frozenFrontier)
  )
    return "冻结接受上下文已变化"
  return {
    "inspect original": "核对原失败和新的独立接受身份",
    "before dispatch": "派发前复核冻结接受上下文",
    ready: "本 Record 获准派发",
    "intent retained": "本 Record 冻结意图已留存",
    inflight: "本 Record 已派发一次",
    response: "服务端已应用本 Record",
    ACK: "本 Record 原 ACK 已留存",
    "record verified": "本 Record 已精确核实",
    accepted: "独立接受完成 原失败仍未证实成功",
    "cold verified": "冷读核实完整独立接受",
    "cold proof incomplete": "冷读证明不完整 停止",
    "original unresolved": "原结果未知 不接受",
    "identity conflict": "接受身份与原操作冲突 停止",
    "stale review": "冻结 File 所有者或 frontier 变化 停止",
  }[s.phase]
}
export function step(action, from) {
  if (action === "Done") return null
  if (action === "Interrupt" && from.s.phase === "response") return null
  return (
    {
      FreezeReview: "冻结独立 review 和身份",
      RejectOriginal: "拒绝未知原操作",
      RejectIdentity: "拒绝复用原身份",
      Revalidate: "重新核对完整冻结上下文",
      RejectDrift: "拒绝过期 review",
      DriftAfterReview: "当前 frontier 变化",
      RetainIntent: "留存本 Record 意图",
      Dispatch: "只派发一次",
      ProviderApplies: "服务端应用",
      RetainAck: "持久留存原 ACK",
      VerifyAck: "精确读取并核实本 Record",
      Interrupt: "响应或读回中断",
      ObserveExactImmutableFact: "精确核实已存在的不可变事实",
      ReplayUnknown: "错误地重复未知请求",
      NextFact: "按顺序转至 adopted 或 completion",
      SkipAdoptedFact: "错误地跳过 adopted 事件",
      CompleteIndependentDecision: "保留原失败并完成独立接受",
      ColdRead: "空本地 Store 读取共享证明",
      VerifyCold: "核实五项完整证明",
      RejectCold: "拒绝任何缺失证明",
    }[action] ?? action
  )
}
export const group = ({ s }) =>
  faults(s).length
    ? "违例"
    : ["accepted", "cold verified"].includes(s.phase)
      ? "已核实"
      : /unknown|unresolved|conflict|stale|incomplete/.test(s.phase)
        ? "停止或等待"
        : "执行中"
export const colors = { 违例: "pink", 已核实: "teal", 停止或等待: "yellow", 执行中: "blue" }
