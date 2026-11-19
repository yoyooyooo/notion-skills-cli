# 当前验证入口

从 [current-convergence：最新态收敛旅程](current-convergence.md) 开始。它拥有 AH-500 的六组顺序、范围与停止条件；实现由 AH-498 的对应 owner 负责。此目录只保留当前可执行能力及其明确未实现边界。

| 改变的行为 | 领域入口 | 当前切片 |
| --- | --- | --- |
| 公开命令、配置、安装与路由 | [verify-ntn-skills](../SKILL.md) | [发现与访问](discovery-config-auth-doctor.md)、[builtin](builtin-management.md)、[独立包](portable-export-package-consumption.md) |
| 当前四表、正文、原件与关系写入 | [verify-notion-management](../../verify-notion-management/SKILL.md) | [空库](empty-library.md)、[完整导入](import-create-recovery-dry-run.md)、[管理边界](skill-maintenance.md) |
| 当前读取、依赖闭包、缓存与成本 | [verify-notion-consumption](../../verify-notion-consumption/SKILL.md) | [消费](skill-consumption.md)、[依赖图](skill-dependency-graph.md)、[请求引擎](request-engine.md)、[有限模型](request-engine-formal.md)、[Broker 交接](broker-consumption.md) |
| 当前 Source、按需文件与原件 | [verify-notion-source-onboarding](../../verify-notion-source-onboarding/SKILL.md) | [来源读取与剩余发布边界](resource-sources.md) |
| 当前权威与资源状态 | [resource lifecycle](../../verify-notion-resource-lifecycle/SKILL.md) | 当前不变量与真实正反例 |
| unknown、partial 与有限对账 | [operation recovery](../../verify-notion-operation-recovery/SKILL.md) | 当前稳定身份、预算和恢复 |

[skill-domains.json](../../../../verification/skill-domains.json) 为保留的 feature 指定唯一主要 owner 与实际测试。测试核实文件存在、职责和路由；不会把入口存在视为业务验收，也不要求每次运行一个领域的全部测试。

## 设施与顺序

[harness](../references/harness.md#launch) 只负责运行隔离、凭据注入、当前 CLI、精确测试库和系统 Trash。安装直接运行现有 `package:check`；导入与消费走公开命令，不增加 wrapper。

先确认当前四表、Content 与范围，再按改动选择现有切片。完整本地 import、Profile、当前读取与获取分别已有实现；Source 发布/刷新、跨对象治理、实库转换仍按实际进展报告。缺失能力记 blocked/not_run，不调用已取消流程填补。

保留权限、完整性、分页、预算、取消、未知结果和重复零写的现有正反例。CLI、安装包、真实 Notion、全库清退与实际 Pi 分别有自己的结果；局部受控通过不能替代另一层。

## 完成边界

AH-513 负责真实 Notion 清退，AH-517 负责旧 caller/实现退出；AH-1063 共用一次配对安装和真实 Pro Pi 旅程；AH-516 对账全 Pro 内容与所有曝光/更新边。OMP/Tern 适配延期，其宿主目录中的 Skill 内容仍进入 Pro 盘点。

AH-500 交付有限入口与前五组结果，AH-1063 提供同一次第六组，AH-498 汇总。达到本次范围的停止条件后结束验证，不保存历史 feature 配方、内容版本或另一层验收平台。
