---
name: verify-notion-consumption
description: "验证 ntn-skills 当前目录、正文与全部子文件、任务内选择一致性、缓存新鲜度、完整导出和零远端消费写。修改 list/read/use/resources/export、权限、获取或缓存时使用；不把长期历史恢复或旧协议兼容作为目标。"
---

# 当前消费验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 的第 1、3、5 组。本入口负责 CLI/SDK 取得的当前字节及成本，不负责作者写入恢复，也不负责把读取成功当成 Pi 已投递或模型任务完成。

## Launch

从仓库根执行，沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离运行。安装检查使用实际安装的 bin/SDK，移除开发覆盖；冷客户端不复制作者 Store。认证、endpoint、scope 和 freshness 保持实际边界。

## Doctor

~~~sh
bun test packages/cli/test/verification-skill-map.test.ts
bun test packages/core/test/notion-readonly.test.ts packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-read-coalescing.test.ts --timeout 60000
~~~

后一组只验证现有语义只读、预算、取消及请求合并底座，不证明普通 consumer 已使用这些边界。当前 reader 仍留存 observation/object/adopted 时，第 3 组必须失败；不能用严格 audit 拒绝写入代替正常 read 成功且 0 写。

## Drive

1. 从当前授权集合选取 git-only、mixed、Notion-native 的必要样本。核完整 path/mode/owner、主文、子文件、Requires/Members 和 exclusions。默认 View 不是权限边界，启停与可访问性分别检查。
2. 修改一份 Notion-authoritative 正文后 fresh read 取得修改。生成阅读页仍按 Source 权威读取，不能因页上有正文自动接管。当前内容缺失、权限不足或分页未完明确失败/partial，不回旧 reader 或历史版本。
3. 在同一任务内固定必要文件清单、来源与内容身份。后续读取不得混入后来内容；旧选择失效、缓存缺失或旧协议输入给出重新选择动作，不远端复活旧 pin。
4. 对整包和明确路径集合导出独立核对完整 bytes/path/mode。保留当前 provider 的固定 Git revision 与按需获取，不因取消版本管理改读上游最新 HEAD。下载/读取不授权执行脚本。
5. 在同 scope、相同内容和有效 freshness/TTL 内重复暖读，要求 0 HTTP；过期后只发生必要核验。目录只取必要 metadata，无变化正文写 0。合并请求不共享错误权限或借用另一调用的 budget。
6. 分别查看普通 list/read/use/resources/export 的实际语义写计数，全部为 0。Notion 查询 POST 是读；创建 Record、adopt、补阅读和清理都是写，不能改名为 retention 后排除。

安装层复用 [portable-export-package-consumption](../verify-ntn-skills/features/portable-export-package-consumption.md) 的实际 archive/bin/SDK 入口。若现有 recipe 仍要求远端历史恢复或旧包，不执行该旧合同来证明新目标。Pi 由 AH-1063 与 Broker 既有 integration 完成，不扩 OMP/Tern。

## Evidence

记录选定范围、当前身份/来源、完整内容比对、freshness、HTTP attempts/bytes 和语义写。保留固定来源原始模板字节；阅读布局相同不能替代原 bytes 检查。身份/完整性失败不得换来源掩盖，当前允许的等价 Git 获取通道也不能变成旧协议 fallback。

以下文件是现有实现回归的定位入口，按实际改动选择；其中旧 pin/retention/代际兼容断言必须随当前实现迁移，旧 PASS 不计入本轮：

- packages/core/test/shared-freshness-consumer.test.ts
- packages/core/test/fixed-snapshot-files.test.ts
- packages/core/test/resource-read.test.ts
- packages/core/test/consumer-effects.test.ts
- packages/cli/test/sdk.test.ts
- packages/core/test/shared-fixed-git-transport.test.ts
- packages/core/test/github-api-access.test.ts
- packages/core/test/shared-github-routing.test.ts
- packages/core/test/shared-source-materialization.test.ts

## Cleanup

按 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收本次自有派生物。保留仍在执行任务必要的当前字节，任务结束后可回收；不承诺旧选择跨机或永久可恢复。当前唯一内容和其他任务状态不误删。
