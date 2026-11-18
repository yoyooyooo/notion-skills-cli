---
name: verify-notion-operation-recovery
description: "验证当前管理意图在 unknown、partial、取消、预算暂停和重启后的有限对账。修改稳定身份、去重或当前状态时使用；Profile/resource 现有结果与尚未接入的完整内容 writer 分开判定。"
---

# 当前操作恢复验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 4 组。本入口不负责请求层模型，也不负责把有限受控结果当成真实 Notion、安装或 Pi 已通过。

## Launch

复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 的隔离和现有 HTTP fixture。一次意图只保留稳定身份、目标当前内容、已处理范围和下一步；完成后有界回收。

`verification/models/operation-recovery/coverage.json` 仍映射旧 ACK/review/completion 等证明合同，退出本轮执行入口。它不是当前恢复证明；不更新 hash 或继续运行旧 MaintenanceApply 来制造通过，也不新建替代平台。

## Doctor

当前已有可执行边界：

~~~sh
bun test packages/core/test/shared-profile.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts --timeout 60000
~~~

Profile/resource 检查稳定当前身份、unknown 不重复创建和只读对账；请求检查负责预算与取消。完整 content/Source writer 尚未公开，这些通过不能升级为整树恢复通过。

## Drive

1. CREATE 发出但响应丢失：当前稳定身份查找先于任何重发。当前对象满足意图可确认当前结果，但原请求未知仍是未知。
2. 当前替换响应未知：按同一完整意图 reconcile；未观察到目标不重复 PATCH，观察到第三方规则不覆盖。相同当前内容可收束意图，无需补历史 ACK。
3. 当前 Skills 处于 applying/attention 时，普通消费应停止在正文前。管理可检查有限状态，不能用旧 journal 或临时改 ready 绕过半树。
4. 预算耗尽和取消：同 invocation 重试、排队和子任务共用预算；下一次明确恢复有自己的总预算。不无限 running，不把未派发动作说成完成。
5. 内容 writer 接通后再用一个真实管理意图覆盖部分文件完成及重启，确认只继续未完成范围、重复结果 no-op、完成后回收。没有此入口则报告剩余缺口。

Notion 属性和本地 mutex 不是分布式 CAS。当前对账成立不能证明原请求的网络 ACK；独立当前状态也无需完整历史证明链才能被接受。

## Evidence

一份结果分别写原请求已知结果、当前观察、未完成范围及下一步。真实业务恢复没运行就标 not_run；缺实现标 blocked。Profile/resource 局部通过不等于 AH-507 全部完成。

不保留过去内容、旧 Profile 修订或永久证据档案。旧模型正负例需要其 owner 明确退役或重做对应关系，不能删反例后宣布新合同成立。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有对象。当前仍在执行的意图保留必要状态，完成或明确放弃后回收。旧 unknown 不变成无限恢复产品；当前唯一内容和其他 owner 不误删。
