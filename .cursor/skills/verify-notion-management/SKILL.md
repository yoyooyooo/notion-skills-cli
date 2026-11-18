---
name: verify-notion-management
description: "验证 Notion Skills 当前作者内容、整树更新、文件权威、关系闭包、有限恢复与残留清理。修改 Skills/Files/Records 管理或迁移清退时使用；以当前完整性和实际无残留判定，不要求旧 ACK 或历史证明链。"
---

# 当前管理验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 的第 1、2、4 组。本入口不负责消费缓存，也不负责用模型或源码测试代替真实 Notion 清理、安装或 Pi 验收。

## Launch

从仓库根执行，沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离。受控测试不写生产库。实际管理使用任务已授权的目标和完整意图，不重复索取已给定授权；不因测试成功扩大到其他库或业务动作。维持受影响范围的单一当前 writer。

## Doctor

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
~~~

确定 AH-499 当前字段合同、目标 owner、支持文件范围和 AH-513 退役对象集合。旧格式仍是当前唯一字节时，先迁出再清理。缺权限、未枚举分页或尚未迁出的内容明确阻塞清理，不把它们当空值。

## Drive

1. 独立比对输入与当前树，覆盖主文、文本/代码、图片/二进制、相对链接、path/mode、Requires/Members 和当前排除。Skills 只有一个主文作者入口，Files 各文本子文档正文完整。
2. 分别验证 Notion-authoritative 和 generated。来源刷新不能覆盖前者；后者可按当前来源重建。显式整文件接管和恢复跟随共用当前写入入口，不自动备份旧版本。
3. 改名、移动、删除/排除、换源和 Source 停用均核对反向闭包。源刷新不能使已排除文件复生，多来源贡献和其他 owner 不误伤。
4. 区分目标检查与全库 census。全库必须含完整分页、反向关系及权限缺口；metadata 不能代替全文。清退旧表/字段/页/Records/附件/导航后再次枚举，再做同一治理应 no-op。
5. 对一次代表性管理意图检查成功、partial 和响应未知。unknown CREATE 先按当前稳定身份核对，不能盲目重发；当前结果已正确不再要求补旧 review/completion。只继续仍未完成的当前目标，原请求未知不能写成已 ACK。
6. 删除旧 writer/协议入口归 AH-513/AH-517，先于最终安装。含唯一内容的本地正本归 AH-516，在对应当前消费和 AH-1063 成立后退场；不得把这道内容保护门槛用来保留旧 writer。

实际安装复用 [skill-maintenance](../verify-ntn-skills/features/skill-maintenance.md) 中的真实 Node CLI、同包 SDK 和受控 HTTP 入口。原 ACK/旧版本等过时断言先由功能 owner 改到当前合同，不能整套照跑后宣称本轮通过。

## Evidence

一份结果列目标、覆盖、effects、cost、剩余范围和下一步。当前正文正确、原请求结果、全库清理分别判定。真实唯一字节先移交，再删除废弃绑定或将页面/库移入 Notion Trash；不保留可见平行旧库来留证。

现有回归定位如下，按当前功能边界修订与执行，不默认重跑全部历史恢复：

- packages/core/test/shared-skill-apply-tree.test.ts
- packages/core/test/shared-maintenance-operations.test.ts
- packages/core/test/shared-audit-target.test.ts
- packages/core/test/shared-native-repair.test.ts

## Cleanup

复用 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup)。仅处理已确认归属和已转移内容的对象。当前未完成操作的必要状态有界保留；历史 pin、原 ACK 缺失或过去 unknown 不能无限阻断已确认的新当前态。所有本地移除遵守可恢复 Trash。
