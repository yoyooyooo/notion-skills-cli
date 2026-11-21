---
name: verify-ntn-skills
description: "定位 ntn-skills 当前实现、公共 CLI 与独立安装的验证责任。按 AH-1188 的合同和时间线选择独立领域；修改验证入口、回执或 CLI/SDK/Pi 交接时使用。"
---

# ntn-skills 验证路由

从 [当前合同索引](../../../docs/verification-contracts.md) 选择 C01–C11/T01–T23，再按 [current-convergence](features/current-convergence.md) 进入已有执行配方。本入口不负责替代管理或消费实现，也不负责用受控测试证明真实 Notion、安装包或 Pi 已完成。

当前合同是 Notion 长期 SSOT、最新内容、普通消费远端 0 写。git-only、mixed、native 共用严格 Content 描述符；保留当前 revision/hash、权限、完整树、请求预算及必要在途状态。

| 改变的行为 | 主要入口 | 实际证明范围 |
| --- | --- | --- |
| 原生 CRUD、完整树、Trash 恢复、关系与清理 | [管理](../verify-notion-management/SKILL.md) | 作者命令、当前字段、同页恢复；全库治理单列 |
| 当前读取、选择、缓存、导出 | [消费](../verify-notion-consumption/SKILL.md) | 字节、目录、权限和成本 |
| 当前 Source、来源获取和阅读投影 | [来源](../verify-notion-source-onboarding/SKILL.md) | 精确来源；成员发布与投影单列 |
| 当前权威和资源状态 | [资源状态](../verify-notion-resource-lifecycle/SKILL.md) | 可执行当前不变量；旧模型不继承 |
| unknown、partial 和有限对账 | [操作恢复](../verify-notion-operation-recovery/SKILL.md) | Profile/resource 的当前边界；完整 writer 单列 |

Broker 的 verify-notion-skills-integration 负责 CLI→SDK→Pi 的实际交接；AH-1197 管两机持续同步，AH-637 管 Mini 独立验收，AH-1198 汇总当前真实时间线。AH-1063 只作其版本的历史 Pro 基线。OMP/Tern 沿 AH-272 延期。

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

原生日常管理沿 [skill-maintenance](features/skill-maintenance.md#原生日常管理与实际-pi)
覆盖公开四动作、语义规范化、局部更新与自动清理。真实 `pi -ne` 的 group/worker
用自然任务发现并读取已连接库里的维护 Skill；仅查看仍用 read，真正采用时沿同来源
精确 ref 用 notion_use/CLI use 加载 Requires，被编辑目标仍只 inspect。
无连接或显式离线/随包检查另验 builtin。
不在提示里预填字段或命令来替代指引发现。

[skill-domains.json](../../../verification/skill-domains.json) 记录当前 feature 的唯一主要 owner 与可执行回归。[feature map](features/README.md) 只路由现有能力及明确未实现边界，不保留已取消流程的执行说明。

## Evidence

沿 [结果回执](../../../docs/verification-contracts.md#结果回执) 将合同、场景、run、命令、源码/加载字节和原件 hash 连起来。复用现有输出，标 passed / failed / blocked / not_run、剩余缺口及复验关系。模型、真实 Store、受控服务、安装、live 和 natural 分层；partial 不算完整通过。

没有请求计数不报 0 HTTP；metadata 通过不报全文；目标通过不报全库清理。无需内容版本、多层签收或不可变证据链。

Trash 恢复按 [单条命令验收](features/current-convergence.md#单条命令恢复已完成的投影)
执行：先清生成正文再 trash 整个已完成 Skill，靠一次公开 --restore 恢复并完整
对照，再同命令核零写。额外 Agent 写操作不能拼出通过；未实跑仍记 not_run。

## Cleanup

复用 [harness Cleanup](references/harness.md#cleanup) 的自有范围与系统 Trash。当前未完成操作所需状态暂留，完成或明确放弃后有界回收。保留当前唯一字节；历史 pin 不成为永久保留根。

各域按本次合同停止，不把历史 Done 重计当前通过。AH-1188 是唯一当前主线；AH-498/500/516/1063 保留原版本及范围的历史证据。Skill 作者检查与独立冷启动使用分开，未执行后者记 instruction_evaluation:not_run。
