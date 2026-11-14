# MaintenanceApply

TLC reached 118 states and 301 steps. The chart draws 16 states and 20 arrows.
The chart does not draw 123 steps that stay in one chart state.
The view hides 69 steps, so the chart does not draw them.

## PartialRequiresOriginalReview breaks
The shortest path has 7 steps:
0. 完整目标树已规划，尚未写入
1. 留存完整父计划并设消费屏障: 当前子操作：复核当前前沿
2. 确认前缀后留存下一子意图: 当前子操作：原意图已留存
3. 派发原请求: 当前子操作：原请求已派发一次
4. 服务端应用请求: 当前子操作：服务端已应用
5. 保留原响应: 当前子操作：原 ACK 已持久化
6. 记录有原响应的已知失败: 原响应已确认但结果需审阅；后缀未派发
7. 按原事实结为部分完成，不派发后缀: 未审阅原失败却解除屏障

## Rules that hold
TypeOK, ConfirmedPrefixBeforeSuffix, UnknownNeverRepeated, CompletionNeedsAllChildren, PendingTreeNotPublished, ObservedDriftStopsDispatch, OriginalOutcomeAuthority, PartialTailNeverSent, OldPinPreserved, NoDeadlock
