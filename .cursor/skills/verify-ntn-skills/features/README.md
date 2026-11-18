# 当前验证入口

本轮从 [current-convergence：最新态收敛旅程](current-convergence.md) 开始。它拥有 AH-500 的六组顺序、结果边界和停止条件；功能实现分别由 AH-498 列出的唯一 owner 负责。

| 改变的行为 | 领域入口 | 本轮职责 |
| --- | --- | --- |
| 跨域收敛、公开入口与独立包 | [verify-ntn-skills](../SKILL.md) | 当前旅程路由，不能代替各层实际验证 |
| 作者内容、整树、关系与清理 | [verify-notion-management](../../verify-notion-management/SKILL.md) | 完整内容、实际清退、重复 no-op |
| 当前读取、导出、缓存和成本 | [verify-notion-consumption](../../verify-notion-consumption/SKILL.md) | 当前全部字节、任务一致性、普通消费 0 写 |
| 来源成员、贡献、刷新与接管 | [verify-notion-source-onboarding](../../verify-notion-source-onboarding/SKILL.md) | git-only/mixed/native 同合同、全文阅读和当前来源 |
| 当前权威与审计有限模型 | [resource lifecycle](../../verify-notion-resource-lifecycle/SKILL.md) | 当前性质对应、有限范围、真实正反例 |
| unknown/partial 与当前对账 | [operation recovery](../../verify-notion-operation-recovery/SKILL.md) | 当前稳定身份、去重、预算和有限恢复 |

[skill-domains.json](../../../../verification/skill-domains.json) 保持每份既有 feature 的唯一主要 owner；公共路由测试核实路径和接线。该索引不是旧产品合同的永久保留清单，不要求每次运行领域全部测试。旧 operation-recovery/resource-lifecycle coverage 退出本轮当前入口；不运行旧模型来证明新实现。

## 实施顺序与边界

1. 先对照 AH-499 当前四表合同。当前 reader/Profile 已接入严格 Content，公开 content/Source writer 与实库转换仍未完成。按实际 failed/blocked/not_run 记录；不把旧 PASS 迁移成新 PASS。
2. 根据改动选择必要的当前领域切片。复用原测试中的权限、内容完整、路径、分页、预算、取消和 unknown 反例；与已取消历史承诺有关的断言由实现 owner 同步重做或退役。
3. 需要安装时使用实际 archive/bin/SDK，离开 checkout。包装中仍含旧 operator/decoder/fallback 即是单轨未完成，不能靠源码测试绕过。
4. 真实 Notion 清退由 AH-513；旧 caller/实现退出由 AH-517；同一次配对安装和真实 Pro Pi 由 AH-1063；Pro 全本地 Skills 内容及曝光/更新入口由 AH-516 对账。
5. OMP/Tern 适配延期，不加入本轮矩阵，也不为它们保留旧 adapter。其宿主目录中的本地 Skill 内容仍进入 Pro 盘点。全部迁入 Notion 不等于全部加入 Default Context。

## 共用设施与现有实现定位

[harness](../references/harness.md#launch) 提供运行隔离、凭据注入、基础命令记录和系统 Trash。只复用当前仍适用的设施；其中旧 package/history 流程不能成为当前产品前置。

当前切片可定位到 [空库](empty-library.md)、[维护](skill-maintenance.md)、[来源](resource-sources.md)、[请求引擎](request-engine.md)、[独立包消费](portable-export-package-consumption.md) 和 [Broker 消费](broker-consumption.md)。维护和 current-convergence 已按当前实现更新；其余旧 feature 仍有待 AH-517 清退的历史要求，仅作设施定位，不执行旧 writer/operator/历史恢复步骤。

旧 NXT/SC/NG case ID 仅用于定位原实现和失败；固定批次文件数、旧 PR/SHA、原 ACK/review/completion、历史 pin、历史恢复或 OMP/Tern 全矩阵不再定义本轮验收。不要扩旧 nxt-journey runner、复制原配方或新增多层签收来覆盖这些差异。

## 完成条件

入口存在只算路由通过，模型通过只算其有限域通过。真实安装、Notion 内容、清理范围和 Pi 投递必须分别有实际结果；未知、未读和 partial 不算完成。

AH-500 交付有限入口及前五组，AH-1063 共用一次第六组结果，AH-516 收口全 Pro 迁移，AH-498 汇总六组与全量结果。足够证明当前正确和无残留后停止，不建设新的 runner、内容版本库或验证平台。
