# AcknowledgedContinuation

TLC reached 717 states, more than the chart budget of 500, so the chart draws only the bug paths: 2 states and 1 arrows.

## CompleteOriginalAuthority breaks
The shortest path has 1 step:
0. 核对原请求和完整 ACK
1. 核对完整原请求与持久 ACK: 违反：原请求或 ACK 集不完整

## Rules that hold
TypeOK, OriginalHistoryPreserved, FreshBodyBeforeWrite, AtMostOneContinuationDispatch, ConfirmationNeedsOriginalAck, EnableRequiresCompleteEvents, ColdVerificationNeedsSharedProof, NoDeadlock
