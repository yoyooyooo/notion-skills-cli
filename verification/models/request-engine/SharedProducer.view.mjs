export const title = "共享读取的所有权与取消"
export const state = (v) => {
  const active = v.active.length
  const cancelled = [v.status[1], v.status[2]].filter((s) => s === "cancelled").length
  const errors = [
    v.phase === "shared" && active > 0 && v.stopped ? "存活等待者的 producer 被取消" : null,
    ["shared", "cancelled"].includes(v.phase) &&
    active === 0 &&
    v.status[1] === "cancelled" &&
    !v.stopped
      ? "最后等待者离开但 producer 未释放"
      : null,
    v.joined && v.context !== "same" ? "错误共享 " + v.context : null,
    v.phase === "replacement" && v.calls !== (v.joined ? 2 : 3) ? "复用了已完成的旧结果" : null,
    v.phase === "cleanup" && !v.replacementAlive ? "旧清理误删了新 producer" : null,
  ].filter(Boolean)
  if (errors.length) return errors.join("；")
  if (v.phase === "ready") return "尚无读取"
  if (v.phase === "first") return "首个等待者启动 producer"
  if (v.phase === "shared") {
    if (cancelled === 2) return "所有等待者退出且 producer 已释放"
    if (cancelled === 1)
      return v.joined ? "一个等待者退出其余继续" : "独立请求只取消自己的 producer"
    return v.joined ? "兼容等待者共享 producer" : "身份或预算不同各自执行"
  }
  return {
    settled: "仅存活等待者取得结果",
    replacement: "再次读取启动新 producer",
    independent: "独立请求取得独立结果",
    cancelled: "取消完成原请求保留中断",
    restarted: "原 key 已启动替代 producer",
    cleanup: "旧清理不影响替代 producer",
  }[v.phase]
}
const steps = {
  StartFirst: "发起首个读取",
  StartSecond: "核对完整共享身份",
  Cancel: "一个调用者取消",
  Complete: "producer 返回",
  CompleteIndependent: "独立 producer 返回",
  RestartAfterSettlement: "再次读取同一 key",
  FinishCancelled: "核实所有等待者退出",
  RestartAfterCancellation: "以原 key 发起新读取",
  LateOldCleanup: "已取消旧 producer 的清理迟到",
  Done: null,
}
export const step = (a) => (Object.hasOwn(steps, a) ? steps[a] : a)
