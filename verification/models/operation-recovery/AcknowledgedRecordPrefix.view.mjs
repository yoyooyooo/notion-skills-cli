export const title = "原 ACK 连续前缀与未派发后缀"
const faults = (s) => [
  ...(s.prefixAuthorized && !s.prefixAck ? ["违反原 ACK 必需条件"] : []),
  ...(s.prefixAuthorized && s.retainedRecords.some((id, i, ids) => !ids.includes(i + 1))
    ? ["违反连续前缀"]
    : []),
  ...((s.prefixAuthorized && !s.requestExact) || (s.prefixVerified && !s.payloadExact)
    ? ["违反原请求与精确 Record 绑定"]
    : []),
  ...(s.replayed || s.suffixAttempts > 1 ? ["违反未知后缀禁止重派发"] : []),
  ...(s.indexBlocked ? ["错误地用 query 可见性代替 exact ACK GET"] : []),
  ...(!s.sentWithFreshPremise ? ["违反当前前提复核"] : []),
  ...(!s.sentWithPermission ? ["违反权限停止"] : []),
  ...(s.originalFailure !== "needs_review" ? ["违反原失败事实保留"] : []),
  ...(s.phase === "completed" && !(s.prefixVerified && s.suffixAck && s.suffixVerified)
    ? ["违反完成前核实"]
    : []),
]
export function state({ s }) {
  const bad = faults(s)
  if (bad.length) return bad.join(" / ")
  if (s.phase === "prefix verified" && (!s.fresh || !s.permitted))
    return "前缀已核实但写入前提已失效"
  if (s.phase === "unknown suffix")
    return s.suffixAck ? "后缀原 ACK 已留存但读回中断" : "后缀无原 ACK 结果未知"
  return {
    inspect: "核对冻结请求和原 ACK 连续前缀",
    "exact GET": "按 ACK 响应页精确读取 Record",
    "prefix verified": "原 ACK 前缀已核实",
    "waiting census": "精确 GET 已核实 等待完整索引清点",
    "suffix ready": "仅未派发后缀获准",
    "intent retained": "冻结后缀意图已留存",
    "suffix inflight": "后缀已派发一次",
    "suffix response": "服务端已应用后缀",
    "suffix ACK": "后缀原 ACK 已留存",
    completed: "独立完成已核实 原事实保留",
    "unknown original": "原操作结果未知 停止",
    "missing ACK": "缺失原 ACK 停止",
    conflict: "原请求或 Record 冲突 停止",
    "noncontiguous prefix": "原 Record 非连续前缀 停止",
    "stale premise": "当前正文或所有权变化 停止",
    "permission denied": "权限拒绝 停止",
  }[s.phase]
}
export function step(action, from, to) {
  if (["Wait", "Done"].includes(action)) return null
  if (action === "Interrupt" && from.s.phase === "suffix response") return null
  return (
    {
      CheckOriginal: "核对完整原请求与 ACK 集",
      RejectMissingAck: "没有原 ACK 不推断成功",
      RejectIdentity: "拒绝不符的冻结身份",
      RejectNonPrefix: "拒绝前缀空洞",
      ObserveExactPage: "核实 exact GET 的身份和完整载荷",
      RejectPayload: "拒绝载荷冲突",
      WaitForCensus: "query 尚不可见时等待清点",
      IndexCatchesUp: "完整清点追上精确事实",
      PremiseChanges: "当前前提变化",
      PermissionDenied: "权限变化",
      RecheckBeforeDispatch: "派发前复核正文 所有权和权限",
      RejectPremise: "拒绝旧前提",
      RejectPermission: "拒绝无权限写入",
      RetainSuffixIntent: "留存冻结意图",
      DispatchSuffix: "只派发从未派发的后缀",
      ProviderApplies: "服务端应用",
      RetainAck: "持久留存原 ACK",
      VerifySuffix: "精确核实独立完成",
      SkipSuffixVerification: "错误地省略 ACK 核实",
      Interrupt: "响应或读回中断",
      ObserveOriginalAck: "依原 ACK 只读续验",
      ReplayUnknownSuffix: "错误地重派发未知请求",
    }[action] ?? action
  )
}
export const group = ({ s }) =>
  faults(s).length
    ? "违例"
    : s.phase === "completed"
      ? "已核实"
      : /unknown|missing|conflict|noncontiguous|stale|denied|waiting/.test(s.phase)
        ? "停止或等待"
        : "执行中"
export const colors = { 违例: "pink", 已核实: "teal", 停止或等待: "yellow", 执行中: "blue" }
