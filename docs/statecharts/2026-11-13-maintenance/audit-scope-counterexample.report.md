# AuditScope

TLC reached 292 states and 530 steps. The chart draws 25 states and 25 arrows.
The chart does not draw 12 steps that stay in one chart state.

## GlobalCoverageNeedsReverse breaks
The shortest path has 12 steps:
0. 目标可达：已核对 0/4 项归属事实
1. 读取本页与必要归属行: 目标可达：已核对 1/4 项归属事实
2. 读取本页与必要归属行: 目标可达：已核对 2/4 项归属事实
3. 保存原进度: 目标可达：预算耗尽，保留原检查点
4. 按原范围继续: 目标可达：已核对 2/4 项归属事实
5. 读取本页与必要归属行: 目标可达：已核对 3/4 项归属事实
6. 读取本页与必要归属行: 目标可达：已核对 4/4 项归属事实
7. 目标事实观察结束: 目标可达：结束时已复核 0/4 项事实
8. 复核目标闭包: 目标可达：结束时已复核 1/4 项事实
9. 复核目标闭包: 目标可达：结束时已复核 2/4 项事实
10. 复核目标闭包: 目标可达：结束时已复核 3/4 项事实
11. 复核目标闭包: 目标可达：结束时已复核 4/4 项事实
12. 按实际范围出报告: 把目标完整误报成全库完整

## Rules that hold
TypeOK, AuditReadOnly, TargetCoverageNeedsOwnerFacts, ConfirmedEvidenceMonotone, OriginalScopePreserved, NoDeadlock
