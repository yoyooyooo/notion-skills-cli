export const title = "当前缓存观察与失效"
export const state = (v) => {
  if (v.served.present && v.served.at >= v.served.metadataProofAt + 2)
    return "超出原观察期限仍被使用"
  if (v.served.present && v.served.at >= v.served.bodyProofAt + 3) return "超出原正文期限仍被使用"
  if (v.publication.present && v.publication.startEpoch !== v.publication.currentEpoch)
    return "旧结果覆盖新变化"
  if (v.checkedAt !== v.metadataProofAt) return "失败检查伪造新有效期"
  if (v.bodyAt !== v.bodyProofAt) return "元信息检查伪造正文验证"
  if (v.served.present && v.served.dirty) return "使用已知待更新内容"
  if (v.served.present && v.served.denied) return "使用已拒绝内容"
  if (v.denied) return "访问已拒绝"
  if (v.dirty) return "已知需要更新"
  if (v.pending.kind !== "none") return "正在检查"
  if (v.now >= v.bodyAt + 3) return "正文需复核"
  if (v.now >= v.checkedAt + 2) return "观察已过期"
  return "可复用"
}
export const step = (action) =>
  ({
    StartMetadata: "开始检查元信息",
    StartFull: "开始完整验证",
    MetadataUnchanged: "收到未变结果",
    FullVerified: "完整验证返回",
    ProbeUnknown: "检查无法确认",
    ObserveChange: "收到变化信号",
    ObserveDenial: "确认访问拒绝",
    Tick: "时间推进",
    Consume: "新会话读取",
    Idle: null,
  })[action] ?? action
