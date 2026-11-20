---
name: verify-notion-source-onboarding
description: "验证当前 Source 计划、逐文件来源、完整目录、精确按需获取与独立的 Notion 阅读投影。修改来源纳管、刷新或迁移时使用；来源读取通过不代表成员已发布或全 Pro 已迁入。"
---

# 当前来源验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 的来源切片。本入口不负责一般作者编辑，也不负责以部分来源成功替代全库或 Pro 迁移。

## Launch

沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离当前输入、配置和派生状态。绑定 exact Source/member/revision/scope。读取不执行来源脚本，也不改变上游或凭据以制造通过。

## Doctor

~~~sh
bun test packages/core/test/shared-current-source.test.ts packages/core/test/shared-current-source-input.test.ts packages/core/test/shared-current-source-management.test.ts packages/core/test/shared-current-source-write.test.ts packages/core/test/shared-current-source-file.test.ts packages/core/test/shared-current-source-lifecycle.test.ts packages/core/test/shared-acquisition-contract.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
~~~

这些检查覆盖当前 plan、Git 声明、批量管理范围、真实协调 writer/HTTP、逐文件获取与原件资源。受控成员写入通过仍不能替代实库全量 Files 和阅读覆盖。

## Drive

1. Sources.Content 接受当前内联 `{version: 1, plan}` 或指向一个 Source-owned current resource 的 `{version: 1, resource}`；较大 plan 不截断，两种存储的 Last Revision 都必须等于完整 normalized plan 的 SHA-256。稳定 Source ID 不再使用 snapshot/bundle/source-plan carrier。缺 hash 的 Git manifest 明确拒绝，不在 reader 回写补齐。
2. acquisition v5 按文件记录 source_id/revision/source_path 或 resource object_id。同一 Skill 可用多 Source；同一 Source 不可混不同 current revision。只查本次所需 Source，批查询完整分页并拒绝重复物理页。
3. 源文件按固定 revision/hash/bytes/mode 获取。缺 cache 时先核当前 owner/descriptor；变化、停用、未 ready、权限不足或分页不完不得访问旧 Records/history 补救。offline 不探远端。
4. Source/resource/native 每个 supporting 文件都有 Files 身份和唯一 owner。Native 正文及 resource 原件完整；生成阅读投影后置，不作为 Source ready 或消费前置，普通读不补页。
5. 用 ctl library source apply 的完整 declaration 与 refresh 的 Notion 当前 declaration 进入同一 writer。发现的所有成员自动纳入，已有 contribution 保留稳定身份，新成员使用确定身份；纯 Source 消失成员和其 Files 退出，完整空集也收敛。Contribution 的文件 mapping/exclude 与 Selection 的成员筛选分开。显式 desired 同 path 覆盖 native/resource 并在 dry-run 展示；排除和无关原生内容保留，另一 Source 不可覆盖。核改名保留 File ID、精确 bytes/mode、删后重建及 unchanged 0 写。generated body 编辑不转权威。
6. 当前 resource 小文件单 Record inline，大文件单原件 attachment。精确 bytes/mode、上传失败、missing attachment、签名 URL 更新和预算分别检查；URL 不作长期身份。
7. AH-516 先对账日用并集与真实更新来源。provider 可达、成员完整、字节完整、投影完整和当前可消费分别判定。GitHub 与私有 HTTP(S) Git 使用同一固定对象入口；保存声明可重建 Source。权限故障、不完整发现或未知状态不能当上游删除。
8. 对一个 exact Source/path/Skill/File 执行 takeover，核同 File/page/path、当前原件、精确 exclude；人改 native 后 refresh 必须保留。restore-follow 使用当前已选 manifest，覆盖选中文件并撤 exclude，不重新发现 Git HEAD，不保留历史 Origin。native 实际往返失败不能假成功或悄悄变 resource。disabled 但完整 Source 可以接管，恢复跟随要求 enabled。
9. enable/disable 只改 Source 消费资格，不改 Skill 的人工 Enabled。remove 先完整查库内 Skills/Main/Files 的语义引用和 Origin；缺 Origin、跨分页文件或孤儿均不能漏。先显式接管被引用文件，再清退无引用 Source 及自有资源。无变化启停 0 写，metadata 动作不产生逐 Skill 写入。

[resource-sources](../verify-ntn-skills/features/resource-sources.md) 连接当前测试、精确原件与实际安装边界。来源读取、Source 写入和实库全文覆盖分别验收；未支持 provider 明确拒绝，没执行的真实范围记 not_run。

## Evidence

记录所选 Source/member 范围、完整目录、来源贡献、精确字节、当前权限与请求成本。不得用零 Files 的快速消费样本证明人类阅读已完成。受控 HTTP、实际包、真实 Notion 与 Pi 分开声明。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有临时物。当前唯一字节和必要在途输入先移交；普通消费不清库。旧历史 pin 不成为永久保留根。
