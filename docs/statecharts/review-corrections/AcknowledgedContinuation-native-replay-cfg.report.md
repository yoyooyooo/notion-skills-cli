# AcknowledgedContinuation

TLC reached 698 states, more than the chart budget of 500, so the chart draws only the bug paths: 6 states and 5 arrows.

## AtMostOneContinuationDispatch breaks
The shortest path has 5 steps:
0. 核对原请求和完整 ACK
1. 核对完整原请求与持久 ACK: 独立续接决定已审阅
2. 执行前复核精确原事实集: 本阶段待派发
3. 派发一次已授权续接请求: 本阶段已派发一次
4. 响应或读回变得不确定: 没有原 ACK，结果未知
5. 错误地重发未知原请求: 违反：未知续接请求被重复派发

## Rules that hold
TypeOK, CompleteOriginalAuthority, OriginalHistoryPreserved, FreshBodyBeforeWrite, ConfirmationNeedsOriginalAck, EnableRequiresCompleteEvents, ColdVerificationNeedsSharedProof, NoDeadlock
