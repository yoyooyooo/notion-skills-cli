# AcknowledgedRecordPrefix

TLC reached 115 states and 173 steps. The chart draws 20 states and 26 arrows.
The chart does not draw 46 steps that stay in one chart state.
The view hides 59 steps, so the chart does not draw them.

## PrefixNeedsOriginalAck breaks
The shortest path has 1 step:
0. 核对冻结请求和原 ACK 连续前缀
1. 核对完整原请求与 ACK 集: 违反原 ACK 必需条件

## Rules that hold
TypeOK, PrefixMustBeContiguous, ExactRecordBinding, UnknownNeverRedispatched, AckLookupIndependentOfQuery, DispatchNeedsFreshPremise, DispatchNeedsPermission, OriginalFactsPreserved, CompletionNeedsVerification, NoDeadlock
