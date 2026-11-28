export const title = "上游版本、采用版本与会话固定内容"
export const state = (v) => {
  if (v.selected !== v.authorizedSelection) return "读取擅自采用上游版本"
  if (v.pin !== v.originalPin) return "旧会话版本被替换"
  if (v.pin === -1)
    return v.selected === 1
      ? "已采用新版，尚无会话"
      : v.upstream === 1
        ? "上游已变，仍采用旧版"
        : "采用旧版，尚无会话"
  if (v.pin === 1) return "会话固定新版"
  return v.selected === 1
    ? "已采用新版，旧会话保留旧版"
    : v.upstream === 1
      ? "上游已变，会话仍固定旧版"
      : "会话固定旧版"
}
export const step = (action) =>
  ({
    UpstreamAdvances: "上游更新",
    AdoptUpstream: "明确采用新版",
    OpenSession: "打开新会话",
    ReadPinned: "继续读取会话内容",
    Idle: null,
  })[action] ?? action
