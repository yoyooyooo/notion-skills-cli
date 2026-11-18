---
name: verify-notion-operation-recovery
description: "验证当前 Notion 管理操作在 unknown、partial、取消、预算暂停和重启后的有限对账。修改当前意图/稳定身份/去重边界时使用；不要求重放原 ACK、review/completion、Profile 或 file-event 历史链，不为旧修复代际保留兼容。"
---

# 当前操作恢复验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 4 组。本入口不负责网络 retry 的独立请求模型，也不负责把模型或受控测试当成真实 Notion、安装包或 Pi 已通过。

## Launch

读取 [原有模型说明](../../../verification/models/operation-recovery/README.md)、[coverage](../../../verification/models/operation-recovery/coverage.json) 和 [运行器维护说明](../../../docs/formal-verification-maintenance.md)。复用现有 runner、工具和实际 HTTP fixture，不新建独立恢复发行物或多代 adapter。

当前目标来自 AH-507：一次当前意图只保留继续所需的稳定身份、目标内容、已处理范围和下一步，完成后有界回收。原模型记录的是调查起点，不能继续把其全部历史性质当作产品必须保留的行为。

## Doctor

逐项区分准备、已派发、已确认当前效果、unknown、partial、完成/放弃。网络发送、提供方执行和本地记账不是一个原子动作；Notion 普通属性或本地 mutex 不是分布式 CAS。

IndependentAcceptance 的完整旧 proof、ColdRecoveryNeedsCompleteProof，以及旧 review/event/completion 修复代际需要随新实现重做或退役。仅更新 hash、删反例或把当前值相等改称原 ACK 均不能通过。

## Drive

使用一项当前管理意图和三个代表切点，不排列所有历史协议：

1. CREATE 已发送但响应丢失。按当前稳定身份查询和去重；未确认缺失不得盲目重发。当前对象满足目标可继续未完成动作，但原请求仍未知时不能伪造原请求成功。
2. 部分文件已完成后停止或进程重启。重新观察当前目标与范围，只执行尚未完成部分，缺文件/权限/分页明确 partial。旧原 ACK/review 不再阻断已正确当前状态。
3. 预算耗尽或用户取消。当前 invocation 的子任务/重试不重领 budget；新的恢复 invocation 使用自己的总预算，能继续或明确结束，不无限 running。
4. 停旧 writer 并显式放弃旧意图后，允许重建当前状态；识别迟到对象和重复页。不得要求复原完整历史证明，也不得让无关旧操作阻断所有当前消费。

请求边界先复用实际传输回归：

~~~sh
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts --timeout 60000
~~~

这只证明预算与 unknown 传输处理。当前操作组还必须用新合同的真实管理入口检查身份去重、完整读取和重复 no-op；没有对应实现/断言则报告缺口，不能拿上述通过替代。

对 AcknowledgedRecordPrefix、IndependentAcceptance、RestoreFeedback、MaintenanceApply 只运行与改动对应的现有模型组。先完成实际函数、性质和正反例的对应，再执行：

~~~sh
CURRENT_RECOVERY_OUT="$(mktemp -d /tmp/notion-current-recovery.XXXXXX)"
node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --model MaintenanceApply --out "$CURRENT_RECOVERY_OUT"
~~~

源码尚未切到当前合同或 coverage 不对应时，这个命令不是新恢复合同的通过证明。保留完整规则判定，不绕过 runner 的源码/工具检查。涉及真实 mutation 时只在独立候选树操作，不写共享产品树。

## Evidence

分别报告原请求已知结果、当前观察到的效果、尚未完成范围与下一步。当前对账成立不等于历史请求已确认；未执行真实 Notion 或安装层则明确 not_run。

正例、真正违例、缺条件和工具失败分别说明。只保存本次必要命令与输出，不保存多代页面、历史操作档案或新的永久证明平台。第 6 组 Pi 仍由 AH-1063 提供一次结果。

## Cleanup

按 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收本次自有对象。仍在执行的当前操作保留必要状态，完成/显式放弃后按有界策略回收。旧 unknown 不成为无限恢复产品；其他 owner 与当前唯一字节不误删。
