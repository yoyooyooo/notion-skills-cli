export const title = "整树维护的原操作与消费屏障"
function faults({ s }) {
  return [
    ...(!s.prefixBeforeSend ? ["前缀未确认却派发后缀"] : []),
    ...(!s.nativeBodyBoundBeforeSend ? ["未按原分配结果绑定正文引用"] : []),
    ...(Object.values(s.attempts).some((value) => value > 1) || s.bindingAttempts > 1
      ? ["重复派发未知写入"]
      : []),
    ...(s.phase === "complete" && s.verified.length !== 3 ? ["半套文件树被标为完成"] : []),
    ...(s.pending && s.currentRead === "new" ? ["未决文件树进入当前消费"] : []),
    ...(!s.frozenBeforeSend ? ["已知人工变更后仍派发"] : []),
    ...(s.phase === "partial" && !s.reviewed.includes(s.child) ? ["未审阅原失败却解除屏障"] : []),
  ]
}
export function state(value) {
  const { s } = value,
    bad = faults(value)
  if (bad.length) return bad.join("；")
  if (s.phase === "complete") return "三个子操作有完整原结果；允许新选择"
  if (s.phase === "known_failed") return "原响应已确认但结果需审阅；后缀未派发"
  if (s.phase === "reviewed_failure") return "原失败已明确审阅；不把原写入改为成功"
  if (s.phase === "partial") return "父操作部分完成；未发后缀保持未发，重新读取当前内容"
  if (s.phase === "binding unknown") return "原引用绑定结果未知；正文尚未派发"
  if (s.phase === "unknown")
    return s.outcomes.includes(s.child)
      ? "当前子操作的原结果已留存，父进度待续接"
      : "当前子操作结果未知，不重发也不越过"
  if (s.phase === "stopped") return "当前内容已变化；保留既有结果并停止"
  if (s.phase === "plan") return "完整目标树已规划，尚未写入"
  return (
    "当前子操作：" +
    {
      boundary: "复核当前前沿",
      intent: "原意图已留存",
      sent: "原请求已派发一次",
      response: "服务端已应用",
      ack: "原 ACK 已持久化",
      outcome: "原结果已精确验证并留存",
      verified: "父操作已记入确认前缀",
      "binding intent": "按两个原分配结果冻结引用绑定",
      "binding sent": "原引用绑定记录已派发一次",
      "binding response": "服务端已保留引用绑定",
      "binding ACK": "原引用绑定 ACK 已留存",
    }[s.phase]
  )
}
export const step = (action) => {
  const labels = {
    RetainParent: "留存完整父计划并设消费屏障",
    ExternalEdit: "用户修改当前内容",
    RetainChildIntent: "确认前缀后留存下一子意图",
    RetainNativeBindingIntent: "从原分配结果绑定最终正文",
    SendNativeBinding: "留存一次原引用绑定",
    NativeBindingApplies: "服务端保留原绑定",
    RetainNativeBindingAck: "持久保留原绑定 ACK",
    VerifyNativeBinding: "核对原分配身份和绑定",
    InterruptNativeBinding: "绑定派发或响应中断",
    ReconcileNativeBinding: "仅依原绑定 ACK 核对",
    RepeatUnknownBinding: "错误地重派发未知绑定",
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
    RecordKnownFailure: "记录有原响应的已知失败",
    ReviewKnownFailure: "显式审阅原失败和完整当前观察",
    SettlePartial: "按原事实结为部分完成，不派发后缀",
    ObserveCurrent: "请求读取当前文件树",
    Stop: null,
  }
  return Object.hasOwn(labels, action) ? labels[action] : action
}
export const group = (value) =>
  faults(value).length
    ? "违例"
    : value.s.phase === "complete"
      ? "已完成"
      : [
            "stopped",
            "unknown",
            "binding unknown",
            "known_failed",
            "reviewed_failure",
            "partial",
          ].includes(value.s.phase)
        ? "保留并停止"
        : "维护中"
export const colors = { 违例: "pink", 已完成: "teal", 保留并停止: "yellow", 维护中: "blue" }
