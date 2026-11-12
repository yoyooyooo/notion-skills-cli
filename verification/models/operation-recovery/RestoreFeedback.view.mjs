export const title = "原恢复操作与业务反馈分别核实"
const faults = (s) => [
  ...(!s.bodySentWithBinding ? ["违反派发前原操作绑定"] : []),
  ...(!s.bodySentWithPremise ? ["违反当前正文和 Source 前提"] : []),
  ...(s.bodyAttempts > 1 ? ["违反反馈失败不得重做正文"] : []),
  ...(s.published && !s.historicalAck ? ["错误地将当前反馈相等视为原 ACK"] : []),
  ...(s.feedbackReplayed || s.feedbackAttempts > 1 ? ["违反未知反馈不得重派发"] : []),
  ...(s.pendingReplaced || s.originalOperation !== "original"
    ? ["违反 pending 原操作身份保留"]
    : []),
  ...(s.published && (s.originalOutcome !== "applied" || s.submissionStatus !== "submitted")
    ? ["违反反馈成功需要原 applied 结果"]
    : []),
  ...(s.historicalAck && !s.feedbackAck ? ["违反已知历史反馈 ACK 保留"] : []),
]
export function state({ s }) {
  const bad = faults(s)
  if (bad.length) return bad.join(" / ")
  if (s.phase === "feedback unknown")
    return s.feedbackAck ? "历史反馈 ACK 留存 读回中断" : "反馈 ACK 未知 停止重派发"
  if (s.phase === "published" && !s.currentPremise) return "历史反馈 ACK 仍有效 当前前提已变化"
  if (s.phase === "needs review" && s.historicalAck) return "保留历史反馈 ACK 当前前提不再授权正文"
  return {
    inspect: "核对冻结提交和原恢复身份",
    "binding retained": "原恢复计划已保留",
    "binding ACK": "原身份处理回执 ACK 已留存",
    "binding unknown": "原身份绑定未核实 停止",
    "before body": "原身份已核实 复核当前前提",
    "body ready": "正文派发已授权",
    "body inflight": "原正文动作已派发一次",
    "body response": "服务端已应用正文",
    "body known": "原恢复 applied 结果已保留",
    "body unknown": "原正文结果未知 停止",
    "feedback ready": "仅业务反馈待派发",
    "feedback intent": "反馈冻结意图已保留",
    "feedback inflight": "反馈已派发一次",
    "feedback response": "服务端已应用反馈",
    "feedback ACK": "历史反馈 ACK 已留存",
    published: "原恢复和业务反馈分别核实",
    "needs reconcile": "正文已完成但反馈未派发",
    "original blocked": "取消 superseded 或失败前提 停止",
    "needs review": "原身份或当前前提变化 停止",
  }[s.phase]
}
export function step(action, from) {
  if (action === "Done") return null
  return (
    {
      RetainOriginalPlan: "保留原计划和冻结提交",
      InvalidPremise: "拒绝无效原前提",
      ProcessingAck: "留存原身份绑定 ACK",
      ProcessingReadback: "读回核实精确原身份",
      BindingLost: "绑定读回中断",
      BindingConflict: "拒绝原身份冲突",
      IgnoreUnverifiedBinding: "错误地越过未核实绑定",
      CheckBodyPremise: "复核当前正文 frontier 和 Source",
      RejectBodyPremise: "拒绝过期正文前提",
      BodyDispatch: "派发原正文动作",
      BodyProviderApplies: "服务端应用正文",
      RetainOriginalOutcome: "留存原 applied 结果",
      BodyUnknown: "原响应丢失 不推断成功",
      PrepareFeedback: "准备原操作的业务反馈",
      FeedbackBudgetExhausted: "预算停止在反馈派发前",
      ReconcileOriginal: "只核对原恢复并补反馈",
      RejectReconcilePremise: "当前变化则停止补反馈",
      RepeatBody: "错误地因反馈失败重做正文",
      ExistingFeedbackRemainsUnknown: "既有反馈意图仍未解决",
      RetainFeedbackIntent: "留存反馈意图",
      FeedbackDispatch: "派发一次反馈",
      FeedbackProviderApplies: "服务端应用反馈",
      RetainFeedbackAck: "持久留存反馈 ACK",
      VerifyFeedback: "核实反馈和当前前提",
      FeedbackDrift: "正文或 Source 后续变化",
      RejectLateDrift: "保留历史 ACK 并停止新正文动作",
      FeedbackUnknown: "响应或读回中断",
      ObserveHistoricalAck: "依历史 ACK 只读核实",
      GuessFeedbackAck: "错误地从当前反馈推断 ACK",
      RedispatchFeedback: "错误地重派发未知反馈",
      ReplaceOriginal: "错误地替换 pending 原操作",
      PublishInvalidOutcome: "错误地把无效原前提视为成功",
      GuessOriginalSuccess: "错误地从当前正文相等推断原成功",
      ForgetHistoricalAck: "错误地抹除已知反馈 ACK",
    }[action] ?? action
  )
}
export const group = ({ s }) =>
  faults(s).length
    ? "违例"
    : s.phase === "published"
      ? "已核实"
      : /unknown|blocked|review|reconcile/.test(s.phase)
        ? "停止或等待"
        : "执行中"
export const colors = { 违例: "pink", 已核实: "teal", 停止或等待: "yellow", 执行中: "blue" }
