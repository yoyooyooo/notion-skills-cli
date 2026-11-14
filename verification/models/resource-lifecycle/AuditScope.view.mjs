export const title = "目标审计与全库反向覆盖"
function faults({ s }) {
  return [
    ...(s.writes ? ["只读审计发生写入"] : []),
    ...(s.targetFull && (s.initial.length !== 4 || s.final.length !== 4)
      ? ["目标闭包证据缺失仍报完整"]
      : []),
    ...(s.globalFull && (s.mode !== "library" || !s.reverse || !s.orphan)
      ? ["把目标完整误报成全库完整"]
      : []),
    ...(s.checkpoint.some((value) => !s.initial.includes(value)) ? ["原检查点事实丢失"] : []),
    ...(s.mode !== s.originalMode ? ["原审计范围被切换"] : []),
  ]
}
export function state(value) {
  const bad = faults(value),
    { s } = value
  if (bad.length) return bad.join("；")
  const mode = s.mode === "target" ? "目标可达" : "全库反向"
  if (s.phase === "reported")
    return s.targetFull
      ? s.globalFull
        ? "目标与全库反向均完整"
        : "目标完整；全库反向未观察"
      : "权限受限；不声称完整"
  if (s.phase === "initial owner") return `${mode}：已核对 ${s.initial.length}/4 项归属事实`
  if (s.phase === "final owner") return `${mode}：结束时已复核 ${s.final.length}/4 项事实`
  return s.phase === "paused" ? `${mode}：预算耗尽，保留原检查点` : "独立反向查找失去关系的孤儿"
}
export const step = (action) =>
  ({
    ReadInitial: "读取本页与必要归属行",
    Pause: "保存原进度",
    Resume: "按原范围继续",
    OwnerDone: "目标事实观察结束",
    Reverse: "完成独立全库反向盘点",
    ReadFinal: "复核目标闭包",
    Report: "按实际范围出报告",
    PermissionLimited: "记录权限不足",
    Stop: null,
  })[action] ?? action
export const group = (value) =>
  faults(value).length
    ? "违例"
    : value.s.phase === "reported"
      ? "报告"
      : value.s.phase === "paused"
        ? "等待续跑"
        : "观察中"
export const colors = { 违例: "pink", 报告: "teal", 等待续跑: "yellow", 观察中: "blue" }
