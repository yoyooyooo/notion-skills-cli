# UpdateCommit

TLC reached 31 states and 62 steps. The chart draws 11 states and 12 arrows.
The chart does not draw 43 steps that stay in one chart state.

## AtMostOneDispatch breaks
The shortest path has 7 steps:
0. 候选资源尚未保留
1. 保留主文: 主文已保留，引用尚未齐全
2. 保留引用资源: 完整候选已保留
3. 冻结完整清单: 候选已冻结
4. 提交原操作: 一次原始派发
5. 服务端选择候选: 服务端已处理
6. 响应丢失: 结果未知且仅可核对原操作
7. 错误地重发未知操作: 违反：重复派发

## Rules that hold
TypeOK, SelectedVersionComplete, SessionPinStable, NoInventedOutcome, NoDeadlock
