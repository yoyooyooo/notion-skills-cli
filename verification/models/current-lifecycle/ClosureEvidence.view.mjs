export const title = "闭包缓存与完整证据发布边界"

const coverage = (v) => Object.values(v.observed).filter((value) => value !== -1).length
const changed = (v) => v.requiredVersion !== 0 || v.membershipEpoch !== 0

export function state(v) {
  if (v.phase === "cached") return "原闭包完整 旧 TTL 仍有效"
  if (v.phase === "ttl_reused") return "复用原租期 不续租"
  if (v.phase === "blocked") return "停止旧闭包 需要重新验证"
  if (v.phase === "checking") {
    if (changed(v)) return "已接受依赖或集合变化"
    if (coverage(v) === 0) return "等待闭包证据"
    if (coverage(v) === 1) return "仅一项证据未变"
    if (coverage(v) === 2) return "两项证据未变 仍缺闭包覆盖"
    return "完整闭包证据一致"
  }
  if (v.phase === "prepared") {
    if (changed(v)) return "准备后又获知变化"
    return coverage(v) === 3 ? "完整证据已准备" : "局部证据被当作完整"
  }
  if (v.phase === "published") {
    const failures = []
    if (coverage(v) < 3) failures.push("局部证据延长全闭包")
    if (changed(v)) failures.push("旧读集通过发布")
    return failures.length ? "错误 " + failures.join(" 与 ") : "完整闭包可续租"
  }
  throw new Error("Unknown phase: " + v.phase)
}

export function step(action, from, to) {
  const labels = {
    BeginValidation: "开始验证闭包",
    ReadRoot: "读取根 metadata",
    ReadRequires: "读取 Requires metadata",
    ReadMembership: "读取完整 Files/Sources 成员证据",
    ObserveRequiredChange: "接受 Requires 版本变化",
    ObserveMembershipChange: "接受 Files/Sources 集合变化",
    PrepareLease: "准备闭包续租",
    RejectKnownChange: "已知变化阻断复用",
    RejectLateChange: "发布前发现读集已变",
    ReuseOriginalTtl: "复用原 TTL [没有已知变化]",
    Done: "本轮结束",
  }
  if (action === "ObserveMetadata")
    return coverage(to) === 3 ? "补齐完整闭包证据" : "取得一项局部证据"
  if (action === "PublishLease") return changed(to) ? "遗漏读集检查后发布" : "发布闭包续租"
  return labels[action] ?? action
}

export const group = (v) =>
  v.phase === "blocked" || changed(v)
    ? "已知变化"
    : ["published", "ttl_reused"].includes(v.phase)
      ? "可复用"
      : "待核对"
export const colors = { 已知变化: "orange", 可复用: "teal", 待核对: "blue" }
