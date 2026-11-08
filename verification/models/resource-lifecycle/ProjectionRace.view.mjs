export const title = "可编辑页面的并发写入边界"
export const state = (v) => {
  if (v.humanCreated && v.body !== "human" && !v.retained) return "人工内容已被覆盖"
  return {
    idle: v.body === "human" ? "页面已有人工编辑" : "页面仍展示上游 v1",
    checked: v.body === "human" ? "检查后发生人工编辑" : "已读回原文一致",
    authorized: v.body === "human" ? "写入前发生人工编辑" : "准备执行覆盖",
    blocked: "缺少服务端保护而停止自动覆盖",
    custom: "保留正文并接管此文件",
    written: "已写入上游 v2",
    reported: "读回并报告结果",
  }[v.phase]
}
export const step = (action) =>
  ({
    ReadUnchanged: "检查当前正文",
    ReadCustom: "确认已有人工内容",
    HumanEdit: "你编辑 Notion 页面",
    Authorize: "检查写入能力",
    ProviderReplace: "服务端执行覆盖",
    ReadBack: "读取写后结果",
    Done: null,
  })[action] ?? action
