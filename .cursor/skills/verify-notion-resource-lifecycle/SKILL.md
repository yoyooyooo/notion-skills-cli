---
name: verify-notion-resource-lifecycle
description: "验证当前 Notion Skill 的身份、文件权威、关系闭包、完整读取和只读有界审计的有限状态性质。领域合同或对应状态模型改变时使用；区分待退役历史性质、当前模型、实际实现和真实服务，不以更新 hash 或放宽断言制造通过。"
---

# 当前资源状态验证

按 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 选择当前性质。本入口不负责以有限模型替代完整分页/字节/Notion/Pi 验收，也不负责另建本轮验证平台。

## Launch

从仓库根读取现有 [coverage](../../../verification/models/resource-lifecycle/coverage.json)、[模型说明](../../../verification/models/resource-lifecycle/README.md) 与 [运行器维护说明](../../../docs/formal-verification-maintenance.md)。沿已锁定的 Pstack/TLC 工具与仓库 runner 执行，不复制其内部实现。

现有模型与源码包含待退役历史合同。工具缺失记 blocked；合同或源码对应已不成立记 failed 或待重构，旧模型 PASS 不继承为本轮 PASS。

## Doctor

只对实际改变的状态边界核对 source、model、cfg、view 和规则集合。不要自动同步 coverage hash。先分清产品缺陷、模型漂移和用户已改变的产品合同，再确定需要修改或退役的性质。

| 现有模型/性质 | 本轮处置 |
| --- | --- |
| ProjectionRace / HumanEditPreserved | 保护 Notion-authoritative 当前作者内容；generated 可重建。不可继续要求所有生成页永久保留，也不可取消作者保护 |
| UpdateCommit / SessionPinStable | 保留一次任务的内容一致性、完整当前选择、unknown 不伪造成功；删除永久旧 pin 和历史资源必须保留的承诺 |
| AuditRun / AuditScope | 保留只读、目标与全库分母、完整正反向覆盖、预算暂停。不能由 metadata 完整推导正文完整 |
| ImportCreate / CreateRecovery / AcknowledgedContinuation | 删除当前冷读必须完整原 ACK/event/proof 的要求；当前稳定身份、完整树、unknown 去重及 partial 仍由新对应关系检查 |
| RequestAdmission / SharedProducer | 复用现有请求预算、取消、scope、并发合并规则；它们不能证明内容治理已完成 |

不把旧性质从 cfg 删除后直接报新合同通过。功能实现、对应模型和有区分力的正反例必须一起解释；无新对应关系时保持未通过。

## Drive

只在所选模型仍对应当前实现，或完成了该组合同重构后运行。例如检查已有审计边界：

~~~sh
CURRENT_MODEL_OUT="$(mktemp -d /tmp/notion-current-model.XXXXXX)"
node scripts/verify-resource-lifecycle.mjs --suite lifecycle --model AuditScope --out "$CURRENT_MODEL_OUT"
~~~

检查 HTTP 边界时使用既有 request-engine 组，不扩成所有内容状态的积：

~~~sh
CURRENT_REQUEST_OUT="$(mktemp -d /tmp/notion-current-request.XXXXXX)"
node scripts/verify-resource-lifecycle.mjs --suite request-engine --model RequestAdmission --out "$CURRENT_REQUEST_OUT"
~~~

运行器的完整规则集合、预期负例、tool error、timeout、cut/unexamined 判定不放宽。不要为每张 Issue 新增模型。现有源码 mutation 脚本会写候选工作树，只能在独立且无人并写的副本执行，不能在共享产品树执行。

## Evidence

读实际 report、summary 和反例路径，说明覆盖的有限状态、环境假设、未建模边界。一次结果足够；不追加多层签收、不可变证明链或内容快照。模型、受控代码与真实系统各报实际范围。

普通消费必须远端 0 写，Notion 查询 POST 仍是读。当前 owner/path/引用完整、未知创建不重复和全库清理不能仅靠图或源码 hash 宣称成立。

## Cleanup

保留本次必要结果后，按 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有候选/临时工具。当前任务必要状态有界保留；不以旧模型承诺延长历史 pin 或旧对象生命周期。
