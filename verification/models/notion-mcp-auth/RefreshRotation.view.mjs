export const title = "OAuth 刷新令牌"
export function state(v) {
  const phases = Object.values(v.pc)
  const violations = []
  if (
    phases.filter((p) => ["locked", "prepared", "sent", "response", "uncertain"].includes(p))
      .length > 1
  )
    violations.push("并发刷新")
  if (v.badStaleDispatch) violations.push("旧版本发出")
  if (v.badEpochCommit) violations.push("失效授权提交")
  if (v.badRevisionCommit) violations.push("版本覆盖")
  if (v.badAbandonedReplay) violations.push("未完成刷新后的旧令牌重放")
  if (v.badReplay) violations.push("不确定请求重放")
  if (violations.length) return "违规 " + violations.join(" 及 ")
  if (phases.every((p) => p === "done")) return "所有刷新已提交"
  const orphan =
    v.flightOwner !== "none" &&
    ["done", "rejected", "reauth", "timeout", "crashed"].includes(v.pc[v.flightOwner])
  if (phases.every((p) => ["done", "rejected", "reauth", "timeout", "crashed"].includes(p))) {
    if (orphan) return "请求结束并保留孤儿标记"
    if (["uncertain", "reauth_required"].includes(v.grant)) return "请求结束并需要重新授权"
    return "请求已结束"
  }
  if (v.grant === "logged_out") return "已退出等待旧请求收尾"
  if (orphan) return v.lock === "none" ? "孤儿刷新标记等待接管" : "进入刷新但仍有孤儿标记"
  if (v.ambiguousPriorAttempt && v.flightOwner !== "none") return "已覆盖孤儿刷新标记"
  if (v.grant === "reauth_required") return "刷新授权被拒绝"
  if (v.grant === "uncertain") return "刷新结果不确定"
  if (phases.includes("response")) return "新令牌等待提交"
  if (phases.includes("sent")) return "刷新请求在途"
  if (phases.includes("prepared")) return "已持久记录刷新在途"
  if (phases.includes("locked")) return "进入刷新临界区"
  if (phases.includes("done")) return "首个刷新已提交"
  if (phases.includes("snapshot")) return "等待刷新锁"
  return "需要刷新令牌"
}
function label(action, config) {
  const lock = /GuardLock = TRUE/.test(config),
    reread = /ReadInsideLock = TRUE/.test(config)
  const labels = {
    Peek: "读取初始快照",
    Acquire: lock ? (reread ? "取得锁并重读版本" : "取得锁但沿用旧快照") : "绕过互斥进入刷新",
    MarkInFlight: "持久记录刷新在途",
    Crash: "进程崩溃",
    RecoverAbandoned: "发现孤儿标记并要求授权",
    Send: "发送刷新",
    Receive: "收到新令牌",
    LoseResponse: "响应丢失",
    Reject: "服务拒绝",
    Commit: "提交刷新结果",
    RejectCommit: "拒绝迟到提交",
    RequireReauth: "返回需重新授权",
    Replay: "重放不确定请求",
    Logout: "退出授权",
    AdvanceClock: "预算推进",
    Timeout: "预算耗尽",
    Done: "请求结束",
  }
  return labels[action.replace(/\(.*/, "")] ?? action
}
export const step = (action) => label(action, "GuardLock = TRUE\nReadInsideLock = TRUE")
export const forConfig = (config) => ({ title, state, step: (action) => label(action, config) })
