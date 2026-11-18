---
name: verify-ntn-skills
description: "定位 ntn-skills 验证责任、公共 CLI 合同与独立安装入口。验证 AH-498 最新态单轨收敛、四表清理、当前读取和 Pro 日用时，执行 current-convergence 有限旅程；跨域变更按实际影响路由，不组合全部历史矩阵。"
---

# ntn-skills 验证路由

本轮从 [current-convergence](features/current-convergence.md) 开始。它把 AH-500 的六组检查交给现有负责人，不创建新 runner、模型平台或永久证据库。本入口不负责替代具体管理/消费实现，也不负责代替真实 Notion、安装包或 Pi 投递验收。

唯一当前合同是 Notion 长期 SSOT、只管理最新内容、普通消费远端 0 写、CLI/SDK/Broker/schema 配对升级。git-only、mixed、Notion-native 是来源模式。删除旧协议兼容，不删除当前 hash/revision、权限、完整树、请求预算和必要在途恢复。

| 改变的行为 | 主要入口 | 必须区分 |
| --- | --- | --- |
| 作者内容、整树、关系闭包、清理 | [verify-notion-management](../verify-notion-management/SKILL.md) | 当前内容正确、全库覆盖、旧对象退出 |
| 当前读取、选择一致性、缓存、导出 | [verify-notion-consumption](../verify-notion-consumption/SKILL.md) | 取得字节、宿主投递、模型任务结果 |
| Source 成员、贡献、刷新、接管 | [verify-notion-source-onboarding](../verify-notion-source-onboarding/SKILL.md) | 来源可达、成员完整、当前内容及阅读 |
| 权威、关系与审计有限模型 | [resource lifecycle](../verify-notion-resource-lifecycle/SKILL.md) | 有限模型、实际实现、真实系统 |
| unknown、partial、预算暂停与当前对账 | [operation recovery](../verify-notion-operation-recovery/SKILL.md) | 原请求结果、已确认当前效果、未完成范围 |

Broker 的 verify-notion-skills-integration 负责 CLI→SDK→Pi 的真实交接。第六组复用 AH-1063 的一次 Pro Pi 旅程，不在本仓复制驱动。OMP/Tern、Mini 和额外 provider 不进入本轮宿主矩阵；Pro 宿主目录里的 Skill 内容仍由 AH-516 盘点。

## Launch

从仓库根运行。复用 [harness Launch](references/harness.md#launch) 的 config/state/cache/data 隔离及凭据注入，不复制个人配置或作者缓存。只补缺少的依赖/构建。harness 的旧 package/历史导入配方不是当前合同；发现它仍要求旧 operator 或历史证明，交 AH-517 修正并报告缺口。

记录实际 checkout、候选包和本次范围。分支更名、旧候选通过、开发源码可运行均不代表当前包已安装。实际写入只使用任务已授权的库和对象。

## Doctor

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts packages/cli/test/maintenance-ci.test.ts
~~~

这些命令只检查入口与接线。当前 schema、reader 或清理尚未实现时，记录实际失败或阻塞，不能把路由通过写成六组通过。

## Drive

按 [current-convergence](features/current-convergence.md) 选择一组或同次工作必要的组。领域的完整回归目录不是每次必跑清单。旧 recipe、测试或模型与当前合同冲突时，先由功能 owner 改实现和对应断言，不沿旧要求补历史，不删负例来制造通过。

安装产物复用 [portable-export-package-consumption](features/portable-export-package-consumption.md) 中仍适用的独立包入口。包尚携带旧 migration/operator、旧 decoder 或 fallback 时，第 3 组失败，不能靠源码测试替代。实际包清理后再运行已有 package-check，不扩 control.ts 或旧 nxt-journey.ts。

完整 feature 归属在 [skill-domains.json](../../../verification/skill-domains.json)，当前导航在 [feature map](features/README.md)。同一 feature 只有一个主要 owner。

## Evidence

保留一份本次结果，列出组号、实际范围、passed / failed / blocked / not_run、覆盖缺口、实际命令及必要输出位置。partial 是未完成覆盖，不是通过。配置检查、受控测试、安装包、真实 Notion 和真实 Pi 各自只声明实际做过的层级。

不要求保存旧内容版本、多层签收或不可变证明链。缺请求账本不能报 0 HTTP，目录/metadata 通过不能报全文，单个目标通过不能报全库清理。

## Cleanup

复用 [harness Cleanup](references/harness.md#cleanup) 的系统 Trash 和自有范围规则。当前未完成操作仍需的状态暂留；完成后按当前有界策略回收，不为永久旧 pin 或历史失败长期保留数据。未知对象、无关脏工作和凭据不动。

## 停止

六组在各自范围通过后停止加验证。AH-500 先交付入口及前五组，AH-1063 补同一次真实 Pi 结果，AH-516 补全 Pro 内容/入口对账，AH-498 汇总最终完成。每个失败归回一个功能 owner；不新增兼容 adapter、特例 fixture 或第二套验证平台。
