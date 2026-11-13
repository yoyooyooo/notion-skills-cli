export const title = "整树维护的原操作与消费屏障"
function faults({ s }) {
  return [
    ...(!s.prefixBeforeSend ? ["前缀未确认却派发后缀"] : []),
    ...(Object.values(s.attempts).some((value) => value > 1) ? ["重复派发未知写入"] : []),
    ...(s.phase === "complete" && s.verified.length !== 3 ? ["半套文件树被标为完成"] : []),
    ...(s.pending && s.currentRead === "new" ? ["未决文件树进入当前消费"] : []),
    ...(!s.frozenBeforeSend ? ["已知人工变更后仍派发"] : []),
  ]
}
export function state(value) {
  const { s } = value,
    bad = faults(value)
  if (bad.length) return bad.join("；")
  if (s.phase === "complete") return "三个子操作有完整原结果；允许新选择"
  if (s.phase === "unknown")
    return s.outcomes.includes(s.child)
      ? `子操作 ${s.child} 的原结果已留存，父进度待续接`
      : `子操作 ${s.child} 结果未知，不重发也不越过`
  if (s.phase === "stopped") return "当前内容已变化；保留既有结果并停止"
  if (s.phase === "plan") return "完整目标树已规划，尚未写入"
  return (
    `子操作 ${s.child}：` +
    {
      boundary: "复核当前前沿",
      intent: "原意图已留存",
      sent: "原请求已派发一次",
      response: "服务端已应用",
      ack: "原 ACK 已持久化",
      outcome: "原结果已精确验证并留存",
      verified: "父操作已记入确认前缀",
    }[s.phase]
  )
}
export const step = (action) =>
  ({
    RetainParent: "留存完整父计划并设消费屏障",
    ExternalEdit: "用户修改当前内容",
    RetainChildIntent: "确认前缀后留存下一子意图",
    RejectDrift: "停止未派发后缀",
    Send: "派发原请求",
    ServiceApplies: "服务端应用请求",
    RetainAck: "保留原响应",
    VerifyOutcome: "核实完整子结果",
    CheckpointChild: "确认父进度",
    Interrupt: "进程或响应中断",
    ReconcileOriginal: "读取同一原结果",
    RepeatUnknown: "错误地重复未知写入",
    NextChild: "进入下一冻结子操作",
    Complete: "全部验证后完成父操作",
    ObserveCurrent: null,
    Stop: null,
  })[action] ?? action
export const group = (value) =>
  faults(value).length
    ? "违例"
    : value.s.phase === "complete"
      ? "已完成"
      : ["stopped", "unknown"].includes(value.s.phase)
        ? "保留并停止"
        : "维护中"
export const colors = { 违例: "pink", 已完成: "teal", 保留并停止: "yellow", 维护中: "blue" }
