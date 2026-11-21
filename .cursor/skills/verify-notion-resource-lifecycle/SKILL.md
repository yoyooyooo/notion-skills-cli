---
name: verify-notion-resource-lifecycle
description: "验证当前 Skill/File 身份、Content 权威、有限 readiness 和精确资源的状态边界。修改领域合同或对应状态模型时使用；当前实现回归、旧模型对应和真实系统结果分别判定。"
---

# 当前资源状态验证

按 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 选择当前性质。本入口拥有当前生命周期模型及其源码对应，不负责真实字节和完整分页，也不负责真实 Pi 与自然模型。实际管理恢复回放由 operation-recovery 所有。

## Launch

复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 的受控输入。
原 event/proof/永久 pin 的模型、coverage 和专属运行入口已经退役。不能用旧 AuditScope 或 ImportCreate 的历史通过证明当前实现。

当前生命周期沿 [CurrentLifecycle](../../../verification/models/current-lifecycle/README.md) 的完整规则清单验证；实际 writer/HTTP/SQLite 结果仍由 operation-recovery 维护。请求模型只拥有请求领域，不因每个 bug 复制模型。

## Doctor

| 当前边界 | 必须保持 |
| --- | --- |
| Content = native / resource / source | 严格唯一 union，不读 Projection/旧事件，不推断 generated 编辑接管 |
| ready / applying / attention | ready 无内容 Operation；projection/restore 可有独立 finite intent；普通 current 消费非 ready 不取正文 |
| File identity/path/owner | 单 owner、stable File ID、完整分页、安全无冲突路径；删除不被 cache 复活 |
| Exact resource | 单当前 object locator、hash/bytes/mode 完整、原件可用；历史 carrier 不 fallback |
| 当前请求 | 预算、取消、scope 和合并边界继续有效，不用降低完整性换成本 |

以上是当前状态义务，不是声称已有形式模型证明。父修订、原 ACK/review/completion 和永久旧选择可恢复不在目标内。

## Drive

先按模型 README 配置与 tool-lock 完全一致的 PSTACK_STATECHART_ROOT/TLA2TOOLS，输出使用新的外部绝对目录：

~~~sh
node scripts/verify-formal.mjs --suite current-lifecycle --out /absolute/new-lifecycle-model-run
python3 scripts/check-formal-mutations.py --suite current-lifecycle --out /absolute/new-lifecycle-guard-run
~~~

检查全部正例/预期反例与条件进展；明确外部返回、显式 resume 及公平性假设。NoDeadlock 不等于最终恢复。实际 guard 原件通过、突变行为失败、恢复通过；导入/语法错误不算检出。

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
~~~

核正例与实际拒绝：excess fields、缺 descriptor、重复 owner/path/物理行、非 ready、partial page、missing attachment、hash/byte mismatch、generated edit、unknown create 不重复 POST。按改动选必要切片，不构造所有维度的乘积。

请求性质直接复用现有 request-budget/request-engine-contract/shared-read-coalescing tests；只有实际请求模型对应仍成立时才由其 owner 运行现有 request-engine 组。它不证明内容治理完整。

来源和关系清理仍需完整当前反向范围与实际库结果。metadata 完整不推导全文完整，局部目标不推导全库无残留。

## Evidence

按 [当前合同与回执](../../../docs/verification-contracts.md) 记录所属场景、准确候选、真实运行层和原件 hash；历史 Done 不填作当前通过。

说明实际覆盖的有限状态、假设及未验部分。源码对应必须指向实际当前行为；不得放宽仍适用的断言或删负例来制造通过。源码、受控代码、实际包和真实系统各自只报实际结果。

普通消费必须语义远端 0 写。resource 存储 helper 的授权写入与普通 reader 分开计数；query POST 是读。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有临时物。当前唯一字节和在途必要状态有界保护；不以已取消的旧模型承诺保留历史对象。
