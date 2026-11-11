export const title = "更新提交和固定版本消费"
export const state = (v) => {
  const broken = []
  if (v.attempts > 1) broken.push("重复派发")
  if (v.selected === 2 && v.objects.length < 2) broken.push("版本不完整")
  if (v.served > 0 && v.served !== v.sessionPin) broken.push("会话漂移")
  if (v.acknowledged && !v.receipt) broken.push("猜造成功")
  if (broken.length) return "违反：" + broken.join("、")
  return {
    preparing: "准备完整候选",
    ready: "候选已冻结",
    inflight: "一次原始派发",
    response: "服务端已处理",
    unknown: v.receipt ? "原操作回执已可见" : "结果未知且仅可核对原操作",
    verified: "原结果已核实",
    completed: "更新结果已发布",
  }[v.phase]
}
export const step = (action) =>
  ({
    RetainMain: "保留主文",
    RetainReference: "保留引用资源",
    FreezePlan: "冻结完整清单",
    Dispatch: "提交原操作",
    ProviderApplies: "服务端选择候选",
    Acknowledgement: "收到原操作回执",
    ResponseLost: "响应丢失",
    ExposeOriginalReceipt: "原回执变为可见",
    ReconcileOriginal: "核对原回执",
    ReplayUnknown: "错误地重发未知操作",
    GuessFromVisibility: "错误地把当前可见当成成功",
    PublishResult: "报告已完成",
    ReadPinned: "会话继续读取原固定版本",
    Wait: null,
    Done: null,
  })[action] ?? action
