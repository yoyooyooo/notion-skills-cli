# 当前验证入口

先读 [当前合同索引](../../../../docs/verification-contracts.md)，按 C01–C11 与 T01–T23 选择领域。执行配方复用 [current-convergence](current-convergence.md)。AH-1188 为当前主线；本目录不存运行成绩。

| 改变的行为 | 领域入口 | 当前切片 |
| --- | --- | --- |
| 公开命令、配置、安装与路由 | [verify-ntn-skills](../SKILL.md) | [发现与访问](discovery-config-auth-doctor.md)、[builtin](builtin-management.md)、[独立包](portable-export-package-consumption.md) |
| 当前四表、正文、原件与关系写入 | [verify-notion-management](../../verify-notion-management/SKILL.md) | [空库](empty-library.md)、[完整导入](import-create-recovery-dry-run.md)、[管理边界](skill-maintenance.md) |
| 当前读取、依赖闭包、缓存与成本 | [verify-notion-consumption](../../verify-notion-consumption/SKILL.md) | [消费](skill-consumption.md)、[依赖图](skill-dependency-graph.md)、[请求引擎](request-engine.md)、[有限模型](request-engine-formal.md)、[Broker 交接](broker-consumption.md) |
| 当前 Source、按需文件与原件 | [verify-notion-source-onboarding](../../verify-notion-source-onboarding/SKILL.md) | [来源读取与剩余发布边界](resource-sources.md) |
| 当前权威与资源状态 | [resource lifecycle](../../verify-notion-resource-lifecycle/SKILL.md) | 当前生命周期模型与实际状态正反例 |
| unknown、partial 与有限对账 | [operation recovery](../../verify-notion-operation-recovery/SKILL.md) | 当前稳定身份、预算和恢复 |

[skill-domains.json](../../../../verification/skill-domains.json) 为保留的 feature 指定唯一主要 owner 与实际测试。测试核实文件存在、职责和路由；不会把入口存在视为业务验收，也不要求每次运行一个领域的全部测试。

## 设施与顺序

[harness](../references/harness.md#launch) 只负责运行隔离、凭据注入、当前 CLI、精确测试库和系统 Trash。安装直接运行现有 `package:check`；导入与消费走公开命令，不增加 wrapper。

先确认当前四表、Content 与范围，再按改动选择现有切片。完整本地 import、Profile、当前读取与获取分别已有实现；Source 发布/刷新、跨对象治理、实库转换仍按实际进展报告。缺失能力记 blocked/not_run，不调用已取消流程填补。

保留权限、完整性、分页、预算、取消、未知结果和重复零写的现有正反例。CLI、安装包、真实 Notion、全库清退与实际 Pi 分别有自己的结果；局部受控通过不能替代另一层。

## 完成边界

AH-1197 负责两机实际 next 与后续同步，AH-637 负责 Mini 独立安装，AH-1198 汇总当前真实 Pi。管理 writer 与投影继续引用 AH-501/AH-1141 的准确候选。OMP/Tern 沿 AH-272 延期。

AH-498/500/516/1063 是历史来源；不能作为本次未运行边界的通过。按实际改动重跑受影响层，原失败、blocked 与 not_run 保留，不新增验证平台。
