---
name: verify-notion-resource-lifecycle
description: "验证当前 Skill/File 身份、Content 权威、有限 readiness 和精确资源的状态边界。修改领域合同或对应状态模型时使用；当前实现回归、旧模型对应和真实系统结果分别判定。"
---

# 当前资源状态验证

按 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 选择当前性质。本入口不负责以模型替代完整分页、真实字节、Notion 投影或 Pi，也不负责另建验证平台。

## Launch

复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 的受控输入。
`verification/models/resource-lifecycle/coverage.json` 仍有 event/proof/永久 pin 的旧对应关系，退出当前执行入口。不能继续运行旧 AuditScope 或 ImportCreate 来证明已删掉的实现。

当前性质直接由已有 current tests 验证。以后只有具体状态风险需要模型时，才在原模型维护机制中建立准确对应；不因每张 Issue 创建模型。

## Doctor

| 当前边界 | 必须保持 |
| --- | --- |
| Content = native / resource / source | 严格唯一 union，不读 Projection/旧事件，不推断 generated 编辑接管 |
| ready / applying / attention | ready 无 operation；其余有当前 operation；普通消费非 ready 不取正文 |
| File identity/path/owner | 单 owner、stable File ID、完整分页、安全无冲突路径；删除不被 cache 复活 |
| Exact resource | 单当前 object locator、hash/bytes/mode 完整、原件可用；历史 carrier 不 fallback |
| 当前请求 | 预算、取消、scope 和合并边界继续有效，不用降低完整性换成本 |

以上是当前状态义务，不是声称已有形式模型证明。父修订、原 ACK/review/completion 和永久旧选择可恢复不在目标内。

## Drive

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
~~~

核正例与实际拒绝：excess fields、缺 descriptor、重复 owner/path/物理行、非 ready、partial page、missing attachment、hash/byte mismatch、generated edit、unknown create 不重复 POST。按改动选必要切片，不构造所有维度的乘积。

请求性质直接复用现有 request-budget/request-engine-contract/shared-read-coalescing tests；只有实际请求模型对应仍成立时才由其 owner 运行现有 request-engine 组。它不证明内容治理完整。

来源和关系清理仍需完整当前反向范围与实际库结果。metadata 完整不推导全文完整，局部目标不推导全库无残留。

## Evidence

说明实际覆盖的有限状态、假设及未验部分。旧 coverage hash 不能替代行为；不得放宽断言或删负例让旧模型变绿。源码、受控代码、实际包和真实系统各自只报实际结果。

普通消费必须语义远端 0 写。resource 存储 helper 的授权写入与普通 reader 分开计数；query POST 是读。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有临时物。当前唯一字节和在途必要状态有界保护；不以已取消的旧模型承诺保留历史对象。
