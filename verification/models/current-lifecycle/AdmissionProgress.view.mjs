export const title = "一次当前内容请求必须结束"
export const state = (v) => {
  if (v.phase === "ready") return "完整验证成功"
  if (v.phase === "unavailable") return "明确返回暂不可用"
  return v.phase === "requested" ? `待校验，已用 ${v.attempts} 次` : `校验中，已用 ${v.attempts} 次`
}
export const step = (action) =>
  ({
    Start: "开始校验",
    Verified: "完整验证成功",
    FailedOrInvalidated: "失败或候选失效",
    AnotherHint: "又收到变化信号",
    Terminal: null,
  })[action] ?? action
