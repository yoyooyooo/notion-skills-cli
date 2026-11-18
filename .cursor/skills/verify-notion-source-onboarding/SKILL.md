---
name: verify-notion-source-onboarding
description: "验证当前 Sources 的完整成员、来源贡献、显式刷新、整文件接管和 Notion 全文阅读。修改 Git/HTTP/registry/Notion/local 来源纳管或迁移时使用；保留现有来源能力，不沿旧 retained/proof 代际继续建设兼容。"
---

# 当前来源验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 的来源切片。本入口不负责一般作者编辑，也不负责把部分 Source 成功代替全库或 Pro 全量迁移。

## Launch

从仓库根运行，沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离配置和派生状态。绑定实际 Source、member、revision、scope 和完整文件输入。读取或导出不执行内容中的脚本，不更改上游或凭据来制造通过。

## Doctor

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
~~~

区分来源可达、已登记、完整成员、内容完整、人类阅读及当前可消费。Provider 不可达、身份不明、分页未完或权限不足不能解释为空来源。多 Source 子集完成不等于全库完成。

## Drive

1. 使用当前 Sources 合同求值 provider、位置、选定 revision、include/exclude/mapping/patch 和贡献归属。Git-only/mixed/native 共用一个当前协议，Notion-native 不强迫绑定 Source。
2. 核对完整有效文件树，所有 supporting 文件都有 Files 身份、owner、Path 和可读正文/原件。git-only 不再以稀疏消费为理由省略人类阅读页；普通读取仍不为补这些页写远端。
3. 检查一次显式来源刷新，新增/更新/缺失/改名/排除均有结果。Notion 作者内容、名称/Tags/Default Context、人工 Router 与另一 Source 的贡献不被覆盖。patch 前提不匹配明确失败。
4. 分别检查主文接管与单子文件接管。接管之后读取当前 Notion 内容，其他文件仍按明确来源获取；改回相同字节不能暗中重置权威。恢复跟随是显式动作，不保存旧内容回滚链。
5. 固定来源获取保持 repository/revision/tree/path/blob/hash/mode 和权限范围。仅拉所选内容与必要依赖；签名 URL 不是长期身份。保留实际 Git、HTTP、registry/market、Notion 及 machine/workspace-scoped local 能力。跨机缺合法 local binding 明确不可用，不自动上传私有内容。
6. 一次创建或刷新中断时按当前稳定身份和已确认效果对账，unknown 不盲目重发。转换旧数据只属于 AH-513 的一次性过程，旧 reader/writer/decoder 在日常路径退出。
7. Pro 全本地迁移由 AH-516 逐项核内容、定制和所有曝光/更新边。来源样本通过不等于全部库存移交；有意停用单列，未读/未知不算已完成。

实际安装入口复用 [resource-sources](../verify-ntn-skills/features/resource-sources.md) 的精确安装 bin、同包 SDK、受控 Provider 和空 Store 设施。该 recipe 的旧 create_git 零 Files、历史 retained/ACK 证明或多代修复要求不是当前产品目标；功能 owner 必须修订相应断言，不能拿旧结果替代本轮。

## Evidence

记录当前 Source/member 范围、完整清单、来源贡献、作者覆盖、实际请求和独立读取结果。比较相同输入及 freshness，不更换来源、增加 TTL 或省略文件来降低成本。真实 Notion、受控 HTTP、安装包与 Pi 分别记录。

现有回归定位如下。只运行本次边界所需切片；其中原版本/证明链/兼容用例须随实现退役或改写为当前正确性，不默认复制整个清单：

- packages/core/test/shared-source-onboarding.test.ts
- packages/core/test/shared-source-definitions.test.ts
- packages/core/test/upstream-source-batch.test.ts
- packages/core/test/shared-source-projection-retained.test.ts
- packages/core/test/shared-import-markdown.test.ts
- packages/cli/test/source-onboarding-navigation.test.ts
- packages/core/test/shared-create-retained-recovery.test.ts
- packages/core/test/shared-source-file-resubmission.test.ts
- packages/core/test/shared-native-image-layout.test.ts
- packages/core/test/shared-native-linked-images.test.ts
- packages/core/test/shared-create-scope-cost.test.ts
- packages/cli/test/source-file-resubmission-navigation.test.ts
- packages/cli/test/library-source-file-resubmission-http.test.ts
- packages/core/test/shared-source-projection-repair.test.ts
- packages/core/test/shared-import-table-literals.test.ts
- packages/core/test/shared-source-file-repair.test.ts
- packages/core/test/shared-native-table-literal-repair.test.ts
- packages/core/test/shared-source-file-literal-repair.test.ts
- packages/core/test/shared-import-code-padding.test.ts
- packages/core/test/notion-http.test.ts
- packages/core/test/shared-source-storage.test.ts
- packages/cli/test/library-source-storage-http.test.ts

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 处理自有临时内容。当前唯一字节、未完成操作必要输入和其他 owner 保留；已经失效的历史 pin 不成为永久保护根。Sources 的来源管理与普通消费分开，检查过程不偷偷修库或创建阅读页。
