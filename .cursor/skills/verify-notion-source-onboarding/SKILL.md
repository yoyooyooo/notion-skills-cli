---
name: verify-notion-source-onboarding
description: "验证当前 Source 计划、逐文件来源、完整目录、精确按需获取与 Notion 阅读投影。修改来源纳管、刷新或迁移时使用；来源读取通过不代表成员已发布或全 Pro 已迁入。"
---

# 当前来源验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 的来源切片。本入口不负责一般作者编辑，也不负责以部分来源成功替代全库或 Pro 迁移。

## Launch

沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离当前输入、配置和派生状态。绑定 exact Source/member/revision/scope。读取不执行来源脚本，也不改变上游或凭据以制造通过。

## Doctor

~~~sh
bun test packages/core/test/shared-current-source.test.ts packages/core/test/shared-acquisition-contract.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
~~~

这些检查覆盖当前 plan、逐文件获取与原件资源。Source 写入、成员发布、全量 Files 和阅读投影需要自己的实现与实际结果。

## Drive

1. Sources.Content 只接受当前 `{version: 1, plan}`；Last Revision 必须等于 normalized plan 的 SHA-256。稳定 Source ID 不再使用 snapshot/bundle/source-plan carrier。缺 hash 的 Git manifest 明确拒绝，不在 reader 回写补齐。
2. acquisition v5 按文件记录 source_id/revision/source_path 或 resource object_id。同一 Skill 可用多 Source；同一 Source 不可混不同 current revision。只查本次所需 Source，批查询完整分页并拒绝重复物理页。
3. 源文件按固定 revision/hash/bytes/mode 获取。缺 cache 时先核当前 owner/descriptor；变化、停用、未 ready、权限不足或分页不完不得访问旧 Records/history 补救。offline 不探远端。
4. Git-only/mixed/native 每个 supporting 文件都有 Files 身份、唯一 owner 和完整阅读页。有效本地 directory 不是 Notion 投影；文本需要全文，图片/二进制需要有效原件。普通读不为补页远端写入。
5. generated Source/resource body 被编辑也不自动取得权威。显式接管、恢复跟随、刷新与排除属管理写入；当前 public Source writer 尚未接入，不能用已退役 create_git 或 onboard 路径宣称完成。
6. 当前 resource 小文件单 Record inline，大文件单原件 attachment。精确 bytes/mode、上传失败、missing attachment、签名 URL 更新和预算分别检查；URL 不作长期身份。
7. 全 Pro 内容与所有曝光/更新边由 AH-516 对账。provider 可达、已登记、成员完整、字节完整、投影完整和当前可消费分别判定。未知不能算有意停用或已移交。

现有 [resource-sources](../verify-ntn-skills/features/resource-sources.md) 仅提供旧设施定位。其 create_git 零 Files、旧 Source carrier、adoption/retained/ACK 和历史修复配方不执行。本轮只使用上面的 current tests 与实际 current 命令；独立包路径由其 owner 接通后再验。

## Evidence

记录所选 Source/member 范围、完整目录、来源贡献、精确字节、当前权限与请求成本。不得用零 Files 的快速消费样本证明人类阅读已完成。受控 HTTP、实际包、真实 Notion 与 Pi 分开声明。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有临时物。当前唯一字节和必要在途输入先移交；普通消费不清库。旧历史 pin 不成为永久保留根。
