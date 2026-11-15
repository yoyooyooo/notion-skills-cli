---
name: verify-ntn-skills
description: "定位 ntn-skills 验证责任、公共 CLI 合同、分发和共用隔离设施。适用于跨域变更、验证入口维护和独立安装门禁；不负责替代管理、消费、来源接手或真实 Pi/模型专项验收。"
---

# ntn-skills 验证路由

按改变的用户行为选择下列唯一主要负责人。旧 feature ID、脚本、模型、失败原件不搬迁或重写；执行脚本仍从仓库根运行。

| 变化 | 入口 | 不可混淆的结果 |
| --- | --- | --- |
| 草稿、正文、整树、归属、删除恢复、审计 | [verify-notion-management](../verify-notion-management/SKILL.md) | 原操作完成、当前内容健康和消费资格 |
| 目录、读取、固定资源、缓存、请求成本、effects | [verify-notion-consumption](../verify-notion-consumption/SKILL.md) | CLI/SDK读取、宿主投递和模型任务成功 |
| Source追加、完整成员发现、新建、原页绑定 | [verify-notion-source-onboarding](../verify-notion-source-onboarding/SKILL.md) | 已登记、已关联、完整内容及原ACK |
| 身份、归属和审计有限模型 | [resource lifecycle](../verify-notion-resource-lifecycle/SKILL.md) | 有限模型结果与真实系统性质 |
| 原派发、ACK、unknown和恢复后缀 | [operation recovery](../verify-notion-operation-recovery/SKILL.md) | 当前值相等与原操作确认 |

Broker 的 `verify-notion-skills-integration` 负责 CLI→SDK→Pi→真实请求交接；`verify-notion-consumer-state` 负责资格/选择/交付有限状态；`verify-context-broker` 负责非 Notion 宿主行为。不负责在本仓另建这些驱动。

完整归属在 [skill-domains.json](../../../verification/skill-domains.json)，细节在 [feature map](features/README.md)。每份 feature 恰有一个主要负责人；一个共享测试可被多个负责人执行。新增测试与实际安装路径必须可定位，不依赖维护者机器或本会话。

## Launch

使用已安装 frozen-lockfile 依赖和仓库支持的 Bun/Node。共用运行隔离、凭据、Node启动器和系统废纸篓规则见 [harness](references/harness.md#launch)。只在缺少依赖/构建时补齐，不复制用户配置或覆盖全局安装。

## Doctor

```sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts packages/cli/test/maintenance-ci.test.ts
```

这些检查只证明入口/接线存在，不证明行为通过。CLI与SDK、源代码与安装包必须分别记录。

## Drive

选一个领域 Skill 的对应切片。跨管理/消费修改依次运行两者受影响的真实测试，并交给原 Broker integration 检查宿主；不要将领域全部套件自动递归组合。

公共分发使用 [portable-export-package-consumption](features/portable-export-package-consumption.md)，复用 `bun scripts/package-check.ts`；全仓门禁仍为 `bun run check`。命令、安装和真实服务层分别留证；不新增常驻 runner。保留的旧References导入/同步路径只在对应历史代码变化时执行，详见 [contract notes](references/contract-notes.md)。

## Evidence

结果使用 `passed / failed / blocked / not_run` 并写明范围、精确commit、脏树文件hash、实际入口、输入、原始stdout/stderr/exit及独立readback。配置/链接检查是结构证据；源测试、受控HTTP、安装产物、真实Notion、真实Pi、真实模型/第二机器各自独立。字段或时间戳不能代替全文和实际请求账本。

新增Skill由作者实跑后，还应由独立冷Agent仅凭仓库、Skill、范围和必要环境重新执行。没有独立冷跑则记 `instruction_evaluation:not_run`，不可用作者的熟悉程度宣称Skill已改善Agent行为。

## Cleanup

依 [harness cleanup](references/harness.md#cleanup) 保留证据并将本轮自有scratch移入系统废纸篓。unknown原操作仍需要的Store不可清空。不能按进程名杀服务、自动删远端页或执行导入脚本。

## 维护规则

修复先保留原反例，再更新实际所有者及必要测试，最后维护Feature/Skill/跨仓引用。状态协议变化才审阅相应模型与守卫；不要自动更新hash、删负例、提高预算后覆盖原失败。进一步拆分只在出现独立不变量、可执行反例和维护责任时进行，不按每张Issue复制一份Skill。
