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

引用作用域、固定 manifest 与导入关系沿 [skill-reference](../verify-ntn-skills/features/skill-reference.md)。
该切片复用同一 runner，分别建模引用选择与冻结导入计划；消费和管理负责实际行为回放。
先读 coverage 中的基线与源码差异，再更新对应，用 pstack /statechart 阅读每条反例。

## Doctor

| 当前边界 | 必须保持 |
| --- | --- |
| Library root / 原操作 | canonical root 唯一身份；root CREATE 前 durable intent；独立查真实 DB/DS parent；原 pending key 和完整物理绑定不随换表/default 漂移 |
| Content = native / resource / source | 严格唯一 union，不读 Projection/旧事件，不推断 generated 编辑接管 |
| ready / applying / attention | ready 无内容 Operation；projection/restore 可有独立 finite intent；普通 current 消费非 ready 不取正文 |
| File identity/path/owner | 单 owner、stable File ID、完整分页、安全无冲突路径；删除不被 cache 复活 |
| Exact resource | 单当前 object locator、hash/bytes/mode 完整、原件可用；历史 carrier 不 fallback |
| 当前请求 | 预算、取消、scope 和合并边界继续有效，不用降低完整性换成本 |
| Source 增量准备 | 单固定 manager 的 read–plan–write fence；保留 Contributions/manifest；ready 的 M 与请求 R 对应同 revision，未 ready sibling 不展开 |
| 原未知写 | durable intent 先于派发；业务与控制请求不重放；唯一因果终结先于后继，取消不释放 gate |

以上是当前状态义务，不是声称已有形式模型证明。父修订、原 ACK/review/completion 和永久旧选择可恢复不在目标内。

## Drive

先按模型 README 配置与 tool-lock 完全一致的 PSTACK_STATECHART_ROOT/TLA2TOOLS，输出使用新的外部绝对目录：

~~~sh
node scripts/verify-formal.mjs --suite current-lifecycle --out /absolute/new-lifecycle-model-run
python3 scripts/check-formal-mutations.py --suite current-lifecycle --out /absolute/new-lifecycle-guard-run
~~~

改变 skill ref 或导入关系时另运行 skill-reference suite 的全部正负配置及其实际 guard。
缺 Library、跨库重叠、失效 Source、缺 manifest、显式空 Members、人工修改与未知 CREATE
不能通过名称、缓存路径、current fallback 或重新推断修复。

改变根页面初始化、descriptor、原 pending 查找或完整 Library binding 时，沿
current-lifecycle 的 LibraryLifecycle 全部正反配置。用独立 world facts 回放复制描述符、
移动 DB、DS 改属、同 root 换 Skills 表、旧 pending 遇到新 root、root CREATE
接受丢响应且不可见。完整读回才 Ready；只读检查零语义写。原 pending 寻址与读到后的
绑定比较要分别验证，不能只测一个 helper。SDK/CLI 和 SQLite 结果沿原领域入口，
Broker 的 branch/turn/迟到目录沿其 consumer-state 的 LibrarySession。
导入计划必须含 `shared-current-import-plan.node.test.ts` 的真实 Store 重启回放。
先保存并观察计划，再跨进程验证重复 apply、同根 Files DB/Skills DS 变化、原 child
续跑与完成退役。地址 helper 和内存 fixture 通过，不能替代 coordinator/SQLite
使用同一地址的证明；`library-import-sqlite-address` 恢复旧含 DS 校验来检出这类裂缝。

检查全部正例/预期反例与条件进展；明确外部返回、显式 resume 及公平性假设。NoDeadlock 不等于最终恢复。实际 guard 原件通过、突变行为失败、恢复通过；导入/语法错误不算检出。

首次引用物化和原请求晚到分别沿同一 suite 的 SourceMaterialization、SourceWriterSettlement 全部正负配置。审阅 [物化合同](../verify-ntn-skills/features/source-materialization.md) 中实际 read–plan–write、原业务/控制 PATCH、retire、父子准入和 input receipt 对应；管理 ACK 与内容核验不能合成一个成功位。完整 current-lifecycle 及实际 guard mutations 为最终门禁，局部模型开发检查不是产品通过。真实 Pi、HTTP/SQLite、独立第二客户端仍由原领域入口执行。

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
