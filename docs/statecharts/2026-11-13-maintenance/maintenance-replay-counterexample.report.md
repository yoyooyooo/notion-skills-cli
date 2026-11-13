# MaintenanceApply

TLC reached 389 states and 1043 steps. The chart draws 13 states and 18 arrows.
The chart does not draw 770 steps that stay in one chart state.
The view hides 164 steps, so the chart does not draw them.

## UnknownNeverRepeated breaks
The shortest path has 5 steps:
0. 完整目标树已规划，尚未写入
1. 留存完整父计划并设消费屏障: 当前子操作：复核当前前沿
2. 确认前缀后留存下一子意图: 当前子操作：原意图已留存
3. 派发原请求: 当前子操作：原请求已派发一次
4. 进程或响应中断: 当前子操作结果未知，不重发也不越过
5. 错误地重复未知写入: 重复派发未知写入

## Rules that hold
TypeOK, ConfirmedPrefixBeforeSuffix, CompletionNeedsAllChildren, PendingTreeNotPublished, ObservedDriftStopsDispatch, OriginalOutcomeAuthority, OldPinPreserved, NoDeadlock
