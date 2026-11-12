# RestoreFeedback

TLC reached 99 states and 150 steps. The chart draws 24 states and 35 arrows.
The chart does not draw 56 steps that stay in one chart state.
The view hides 34 steps, so the chart does not draw them.

## FeedbackNeverRepeatsBody breaks
The shortest path has 11 steps:
0. 核对冻结提交和原恢复身份
1. 保留原计划和冻结提交: 原恢复计划已保留
2. 留存原身份绑定 ACK: 原身份处理回执 ACK 已留存
3. 读回核实精确原身份: 原身份已核实 复核当前前提
4. 复核当前正文 frontier 和 Source: 正文派发已授权
5. 派发原正文动作: 原正文动作已派发一次
6. 服务端应用正文: 服务端已应用正文
7. 留存原 applied 结果: 原恢复 applied 结果已保留
8. 预算停止在反馈派发前: 正文已完成但反馈未派发
9. 错误地因反馈失败重做正文: 原身份已核实 复核当前前提
10. 复核当前正文 frontier 和 Source: 正文派发已授权
11. 派发原正文动作: 违反反馈失败不得重做正文

## Rules that hold
TypeOK, BodyNeedsBoundOriginal, BodyNeedsCurrentPremise, FeedbackRequiresRealAck, UnknownFeedbackNeverRedispatched, OriginalRequestPreserved, SuccessNeedsAppliedOriginal, HistoricalAckPreserved, NoDeadlock
