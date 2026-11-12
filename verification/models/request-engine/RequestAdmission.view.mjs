export const title = "请求准入与未知写入边界"
export const state = (v) => {
  const errors = [
    v.admittedEarly ? "尚在冷却却已准入" : null,
    v.expiredDispatch ? "调用者期限已过仍准入" : null,
    v.excessAttempt ? "请求次数预算被绕过" : null,
    v.replayedUnknown ? "未知写入被错误重试" : null,
    ["queued", "retry"].includes(v.phase) && v.permit ? "等待期间仍占网络许可" : null,
    v.orphanedLease ? "取消后遗留队列租约" : null,
    v.lateResponse ? "单次请求已超时仍报告成功" : null,
  ].filter(Boolean)
  if (errors.length) return errors.join("；")
  if (v.phase === "queued") return "排队持有短租约且未占网络许可"
  if (v.phase === "inflight") return v.mutating ? "原写入已派发" : "只读请求已派发"
  return {
    ready: "尚未准入",
    admitted: "已获共享准入及网络许可",
    retry: "允许重试并等待共享冷却",
    done: "结果已返回许可已释放",
    budget: "预算耗尽且停止派发",
    cancelled: "调用者取消且租约已释放",
    unknown: "原写入结果未知不得重发",
  }[v.phase]
}
const steps = {
  Enqueue: "申请短队列租约",
  AdvanceClock: "等待时间推进",
  Admit: "核对期限及共享冷却",
  StartAttempt: "核对并消费请求预算",
  RejectBudget: "拒绝已耗尽预算",
  Success: "取得响应并释放许可",
  ReadFailure: "只读失败进入有界重试",
  DefinitiveWriteRejection: "写入被明确拒绝允许原请求重试",
  UnknownWrite: "写入响应不确定",
  AttemptTimeout: "单次请求或整个调用已超时",
  ReplayUnknown: "错误地重试未知写入",
  ExpireQueue: "排队期限耗尽",
  CancelQueue: "取消排队并释放租约",
  Done: null,
}
export const step = (a) => (Object.hasOwn(steps, a) ? steps[a] : a)
