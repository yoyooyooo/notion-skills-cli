---
name: verify-ntn-skills
description: "定位 ntn-skills 当前实现、公共 CLI 与独立安装的验证责任。最新态单轨收敛、四表清理和 Pro 日用从 current-convergence 有限旅程进入；按实际改动选择领域，不组合历史矩阵。"
---

# ntn-skills 验证路由

从 [current-convergence](features/current-convergence.md) 开始。它复用六组必要检查，不新建 runner、证明链或永久结果库。本入口不负责替代管理或消费实现，也不负责用受控测试证明真实 Notion、安装包或 Pi 已完成。

当前合同是 Notion 长期 SSOT、最新内容、普通消费远端 0 写。git-only、mixed、native 共用严格 Content 描述符；保留当前 revision/hash、权限、完整树、请求预算及必要在途状态。

| 改变的行为 | 主要入口 | 实际证明范围 |
| --- | --- | --- |
| 当前内容、整树、Trash 恢复、关系与清理 | [管理](../verify-notion-management/SKILL.md) | 当前字段、同页恢复和 Profile；内容 writer、全库清理单列 |
| 当前读取、选择、缓存、导出 | [消费](../verify-notion-consumption/SKILL.md) | 字节、目录、权限和成本 |
| 当前 Source、来源获取和阅读投影 | [来源](../verify-notion-source-onboarding/SKILL.md) | 精确来源；成员发布与投影单列 |
| 当前权威和资源状态 | [资源状态](../verify-notion-resource-lifecycle/SKILL.md) | 可执行当前不变量；旧模型不继承 |
| unknown、partial 和有限对账 | [操作恢复](../verify-notion-operation-recovery/SKILL.md) | Profile/resource 的当前边界；完整 writer 单列 |

Broker 的 verify-notion-skills-integration 负责 CLI→SDK→Pi 的实际交接。第六组共用 AH-1063 的一次 Pro Pi 旅程。OMP/Tern 宿主适配延期，其目录中的 Skill 内容仍属 AH-516 的 Pro 盘点。

## Launch

从仓库根执行。复用 [harness Launch](references/harness.md#launch) 的运行目录、配置、状态、cache、data 隔离和凭据注入；不复制作者 Store。只补实际缺少的依赖/构建。controller 只负责 init/doctor/cli/empty/cleanup；安装直接运行现有 package:check，导入使用当前公开 CLI。

记录实际 checkout、候选包和范围。源码可运行不代表包已安装；分支更名不证明当前内容已转换。写入仅针对任务已授权的对象。

## Doctor

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts packages/cli/test/builtin-guidance.test.ts packages/cli/test/installed-package-ci.test.ts
~~~

这些检查只证明路由、包内说明、引用和 CI 接线。安装包门禁要求 CLI 与 SDK 使用同一 archive、失败不被忽略，并始终上传报告和请求日志，排除 node_modules。实际安装结果仍由 package:check 提供；正文、全库清理和 Pi 按各自入口验证。

## Drive

按 [current-convergence](features/current-convergence.md) 选必要组。领域内只跑对应当前回归。当前入口和实现已经移除的行为，不为旧测试补回兼容或历史证明。

安装检查复用 [portable-export-package-consumption](features/portable-export-package-consumption.md) 的当前 archive/bin/SDK 设施与全部当前用例。受控安装通过不能替代真实 Notion 清理或 Pi 日用。未执行的边界明确 blocked/not_run，只沿现有领域入口补必要检查。

[skill-domains.json](../../../verification/skill-domains.json) 记录当前 feature 的唯一主要 owner 与可执行回归。[feature map](features/README.md) 只路由现有能力及明确未实现边界，不保留已取消流程的执行说明。

## Evidence

保留一份结果，列组号、范围、passed / failed / blocked / not_run、剩余缺口及实际命令。配置、受控代码、安装包、真实 Notion、真实 Pi 分开声明。partial 不算完整通过。

没有请求计数不报 0 HTTP；metadata 通过不报全文；目标通过不报全库清理。无需内容版本、多层签收或不可变证据链。

Trash 恢复按 [单条命令验收](features/current-convergence.md#单条命令恢复已完成的投影)
执行：先清生成正文再 trash 整个已完成 Skill，靠一次公开 --restore 恢复并完整
对照，再同命令核零写。额外 Agent 写操作不能拼出通过；未实跑仍记 not_run。

## Cleanup

复用 [harness Cleanup](references/harness.md#cleanup) 的自有范围与系统 Trash。当前未完成操作所需状态暂留，完成或明确放弃后有界回收。保留当前唯一字节；历史 pin 不成为永久保留根。

六组在各自实际范围足够证明后停止扩验证。AH-500 交付有限入口与前五组结果，AH-1063 提供同一次第六组，AH-516 对账全 Pro 内容与曝光/更新边，AH-498 汇总最终完成。
