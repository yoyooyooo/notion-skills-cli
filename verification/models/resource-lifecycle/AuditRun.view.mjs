export const title = "只读审计和预算续跑"
export const state = (v) => {
  const broken = []
  if (v.writes) broken.push("审计写入了归属")
  if (v.complete && (!v.reverseDone || !v.orphanFound)) broken.push("漏查孤立资源仍报完整")
  if (v.checkpoint.some((x) => !v.checked.includes(x))) broken.push("续跑丢失进度")
  if (broken.length) return broken.join("、")
  return {
    inventory: "盘点身份与可见范围",
    skills:
      v.checked.length === 2
        ? "两个 Skill 已深审"
        : v.checked.length === 1
          ? v.budget > 0
            ? "从检查点继续第二个 Skill"
            : "已深审一个 Skill"
          : "逐个 Skill 深审",
    paused: v.resumes === 2 ? "本模型的两次续跑耗尽仍未完成" : "预算耗尽并保存检查点",
    reverse: v.reverseDone ? "发现已失去主记录的资源" : "反向扫描 Files 与历史引用",
    limited: "权限范围不足",
    reported: v.complete ? "完整覆盖并报告发现" : "报告部分覆盖",
  }[v.phase]
}
export const step = (action) =>
  ({
    Inventory: "查询库范围",
    InspectOne: "检查下一个 Skill",
    ObserveHumanChange: "发现未确认的人工编辑",
    Pause: "耗尽本次预算",
    Resume: "Dagu 继续原审计",
    MoveToReverse: "顺向完成",
    ReverseInventory: "盘点无入口资源",
    Report: "生成覆盖报告",
    ReportLimited: "报告权限边界",
    NeedsResume: null,
    Done: null,
  })[action] ?? action
