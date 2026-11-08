export const title = "完整导入和原操作恢复"
const stages = {
  1: "新主记录",
  2: "文件与原始资源",
  3: "关系与版本选择",
  4: "明确启用",
  5: "完整结果",
}
export const state = (v) => {
  const broken = []
  if (Object.values(v.attempts).some((n) => n > 1)) broken.push("重复派发")
  if (
    v.enabled &&
    (![1, 2, 3].every((n) => v.verified.includes(n)) || !v.original || v.objects.length !== 2)
  )
    broken.push("过早启用")
  if (v.verified.some((n) => !v.acked.includes(n))) broken.push("猜造回执")
  if (!v.allDispatchesReviewed) broken.push("输入漂移后写入")
  if (broken.length) return "违反：" + broken.join("、")
  if (v.phase === "preparing") return v.objects.length === 2 ? "完整输入已保留" : "保留完整输入"
  if (v.phase === "completed") return "原操作已全部验证"
  if (v.phase === "blocked") return "保留已完成步骤并等待重新审阅"
  const stage = stages[v.step]
  return (
    stage +
    "：" +
    {
      ready: v.inputMatches ? "可继续原未派发步骤" : "输入已漂移",
      inflight: "一次原始派发",
      response: "服务端已处理",
      readback: "原 ACK 已持久化",
      unknown: v.acked.includes(v.step) ? "原 ACK 可核对" : "结果未知，禁止重发",
    }[v.phase]
  )
}
export const step = (action) =>
  ({
    RetainOne: "保留一类输入",
    FreezeOriginal: "冻结原计划",
    InputChanges: "源树或身份变化",
    Dispatch: "派发原未开始步骤",
    RejectChangedInput: "拒绝过期计划",
    ProviderApplies: "服务端处理原请求",
    DispatchInterrupted: "派发后中断",
    ResponseLost: "原响应丢失",
    PersistOriginalAck: "保存原成功响应",
    ReadbackInterrupted: "读回中断",
    VerifyStage: "核实该原步骤",
    ReconcileOriginal: "按原 ACK 继续核对",
    ReplayUnknown: "错误重发未知请求",
    InferFromVisible: "错误地由当前可见猜造成功",
    PublishEarly: "错误提前启用",
    Finish: "报告原操作完成",
    HoldUnknown: null,
    Terminal: null,
  })[action] ?? action
