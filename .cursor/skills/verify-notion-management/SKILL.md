---
name: verify-notion-management
description: "验证 Notion Skill 管理的草稿注册、原生导入、整树维护、文件身份、人工归属、删除恢复和只读审计。修改这些作者行为或原操作恢复时使用；不负责消费新鲜度、宿主注入或以源码测试代替实库维护验收。"
---

# 管理验证

主要对象是同一 Skill、Files、Records 的作者意图与原操作。Source 成员接手交给 [来源专项](../verify-notion-source-onboarding/SKILL.md)；读取、缓存和权限交给 [消费专项](../verify-notion-consumption/SKILL.md)。不负责替代实际 Pi/provider/模型证明。

## Launch

从仓库根执行，沿 [共用隔离设施](../verify-ntn-skills/references/harness.md#launch) 创建本轮证据目录。受控测试不连接生产库；真实写入先明确库/目标/原计划，维持同目标一个writer。不得复制作者Store来证明另一客户端恢复。

## Doctor

```sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
```

需要安装验收时绑定精确CLI/archive/runtime，再按 [维护矩阵](../verify-ntn-skills/features/skill-maintenance.md#joined-installed-acceptance) 检查前提。缺凭据/原ACK/输入记blocked，不转用生产或忽略待恢复操作。

## Drive

先选子模块，不把全部历史迁入和模型作为每次小改的前置：

| 子模块 | 正例与反例 | 规程 |
| --- | --- | --- |
| 初始化/草稿 | 真空库、合法草稿；错误类型/旧身份不可伪装空值 | [empty library](../verify-ntn-skills/features/empty-library.md) |
| 原生导入 | 完整字节、页面语义、原计划冷重建；文字/代码/目标变化及缺块必须失败 | [原生导入](references/native-import.md) |
| 整树维护 | sparse保留、原ID移动/删除/恢复；新页unknown、并发custom、旧pin不可覆盖 | [维护矩阵](../verify-ntn-skills/features/skill-maintenance.md) |
| 审计/修复 | 目标闭包/全库分母、原页修复；半覆盖不得标complete | [audit](../verify-ntn-skills/features/resource-audit.md)、[repair](../verify-ntn-skills/features/maintenance-repair.md) |

整树和审计的最小实现切片：

```sh
bun test packages/core/test/shared-skill-apply-tree.test.ts packages/core/test/shared-maintenance-operations.test.ts packages/core/test/shared-audit-target.test.ts packages/core/test/shared-native-repair.test.ts --timeout 60000
```

原生导入切片与安装命令在子模块。实际安装仍复用 [skill-maintenance](../verify-ntn-skills/features/skill-maintenance.md#joined-installed-acceptance)，由真实Node CLI、SQLite、受控HTTP原件检查；真实Notion另立证据。改ACK/派发/unknown时再路由 [operation recovery](../verify-notion-operation-recovery/SKILL.md)，改归属/审计状态时路由 [lifecycle](../verify-notion-resource-lifecycle/SKILL.md)。

## Evidence

至少核对原页面/文件身份、完整输入及实际树、custom前沿、Selected Version、Members/Requires、Enabled、旧pin，和每次写入的原operation/ACK。展示投影、固定原文、当前消费可有版本化转换，必须分别保存。

完整主操作结果和子动作逐项核对。dry-run需零远端写；重复已完成操作不得增页/增版本；unknown只能核对原操作。未执行的实际服务、冷客户端、Pi和模型不从单测继承passed。独立审计全部正文未执行时明确仅验证哪些字段。

## Cleanup

复用 [harness cleanup](../verify-ntn-skills/references/harness.md#cleanup)。先保存命令/HTTP/状态原件；任何unknown还依赖的journal留存。远端原页和失败历史不因验证结束移除。

## 不能替代的证据

| 看似够用 | 仍须检查 |
| --- | --- |
| create返回verified | 独立固定/当前读取、完整资源、未改属性 |
| 正文看起来一样 | 完整语义、代码、明确链接；不能把加号和圆点等价 |
| 当前页面等于候选 | 原派发/ACK及原恢复权限 |
| audit目标通过 | 全库反向范围是否实际完成 |
