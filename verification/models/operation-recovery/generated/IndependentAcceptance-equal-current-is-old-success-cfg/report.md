# IndependentAcceptance

TLC reached 216 states and 305 steps. The chart draws 15 states and 19 arrows.
The chart does not draw 96 steps that stay in one chart state.
The view hides 95 steps, so the chart does not draw them.

## OriginalFactsPreserved breaks
The shortest path has 22 steps:
0. 核对原失败和新的独立接受身份
1. 冻结独立 review 和身份: 派发前复核冻结接受上下文
2. 重新核对完整冻结上下文: 本 Record 获准派发
3. 留存本 Record 意图: 本 Record 冻结意图已留存
4. 只派发一次: 本 Record 已派发一次
5. 服务端应用: 服务端已应用本 Record
6. 持久留存原 ACK: 本 Record 原 ACK 已留存
7. 精确读取并核实本 Record: 本 Record 已精确核实
8. 按顺序转至 adopted 或 completion: 派发前复核冻结接受上下文
9. 重新核对完整冻结上下文: 本 Record 获准派发
10. 留存本 Record 意图: 本 Record 冻结意图已留存
11. 只派发一次: 本 Record 已派发一次
12. 服务端应用: 服务端已应用本 Record
13. 持久留存原 ACK: 本 Record 原 ACK 已留存
14. 精确读取并核实本 Record: 本 Record 已精确核实
15. 按顺序转至 adopted 或 completion: 派发前复核冻结接受上下文
16. 重新核对完整冻结上下文: 本 Record 获准派发
17. 留存本 Record 意图: 本 Record 冻结意图已留存
18. 只派发一次: 本 Record 已派发一次
19. 服务端应用: 服务端已应用本 Record
20. 持久留存原 ACK: 本 Record 原 ACK 已留存
21. 精确读取并核实本 Record: 本 Record 已精确核实
22. 保留原失败并完成独立接受: 错误地将当前相等改写为原成功

## Rules that hold
TypeOK, KnownFailureRequired, FrozenIdentityRequired, IndependentIdentity, UnknownNeverRedispatched, CompletionNeedsAdoption, ColdRecoveryNeedsCompleteProof, NoDeadlock
