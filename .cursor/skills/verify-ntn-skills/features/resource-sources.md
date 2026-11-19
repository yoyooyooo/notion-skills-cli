# 当前 Source 与精确资源

主要入口：[verify-notion-source-onboarding](../../verify-notion-source-onboarding/SKILL.md)。本页定位现有 Source plan、按文件获取与原件资源能力；完整导入沿 [当前导入](import-create-recovery-dry-run.md)，跨 Source 发布和刷新不由一次读取代替。

## 当前读取入口

~~~sh
bun test packages/core/test/shared-current-source.test.ts packages/core/test/shared-acquisition-contract.test.ts packages/core/test/shared-current-resource.test.ts --timeout 60000
~~~

这些检查执行当前服务边界。Sources 的 Content 使用唯一当前格式：小 plan 直接内联，较大 plan 使用一个 Source-owned current resource。两种存储的 Last Revision 都是完整规范化 plan 的 SHA-256，不是历史指针。超出内联限额时不得截断；resource 的 owner、完整 bytes、hash 与 plan 必须一致。

acquisition v5 按文件保存 source_id/revision/source_path 或 resource object_id；一个 Skill 可以混合多个 Source、native 和 resource，同一 Source 不能混不同 revision。Git plan 必须已含每个文件的准确 SHA-256；缺项不由 consumer 写回补齐。

## 只保留受改动影响的边界

- 多个所选 Source 共用有界 metadata 查询，查询完整分页，重复物理页、停用、非 ready、缺行与不匹配的 Last Revision 均失败。验证所有所选行后才下载所需 manifest 或文件。
- 完整目录与按需 bytes 分开。只获取所请求的固定文件，核 path、bytes、SHA-256、Git identity 与 mode；本机来源另需明确 machine binding，远端 plan 不携带本机私有路径。
- 缺本地所选 bytes 时先检查当前 owner 和 descriptor。声明变化要求重选；offline 不探远端，不从旧 Records 或历史缓存恢复成当前内容。
- Resource 小文件为单 Record inline，大文件为单原件 attachment；不支持直接上传的原件用单文件 ZIP。读回恢复原始 bytes 和 mode，不把 ZIP 传输字节误作原件。
- Source-owned resource 使用 Origin，不能被当作 Skill-owned resource 读取。签名 URL 更新不改变对象身份；缺附件、未知格式、错误 hash、重复 Record 与预算耗尽不能产出完整结果。
- 当前 resource helper 的 unknown CREATE 只按稳定 ID 对账，不重复 POST。它通过不代表 Source 成员发布、刷新或整个库已治理。

修改 provider 获取时才补跑现有 `packages/core/test/shared-source-materialization.test.ts`，检查固定 revision、按需下载、损坏拒绝与在途共享。不要为此另造 Source runner。

## 人类阅读与未实现边界

Git-only、mixed、native 的每个 supporting 文件都需要 Files 身份、唯一 owner 和完整阅读页。文本检查全文；图片或 opaque 文件检查可用原件。读取 Source 的本地 exact bytes 不证明 Notion 已有这些投影，普通消费也不能为了补页而写 Notion。

当前 public CLI 支持完整本地树的 `ctl library import`。Source 写入、成员发布/刷新、显式接管与跨对象治理仍需当前实现和实际验收；目前不可用的部分标为 blocked/not_run，不调用已退出的命令。

独立安装沿 [package check](portable-export-package-consumption.md) 的同 archive CLI/SDK。只声明其实际覆盖的当前读取样本；没有执行的 Source 发布或真实 Notion 投影保持未验收。AH-516 继续负责全 Pro 内容与所有曝光/更新边，AH-1063 负责真实 Pi。

## 结果与清理

报告所选 Source/member、完整目录、实际获取文件、请求/bytes、原件与页面正文分别覆盖的范围。沿 [harness](../references/harness.md#cleanup) 回收自有派生物，当前唯一内容先移交。只读 `shared-migration-inventory.ts` 暂用于识别旧载体的唯一当前 bytes，不进入普通消费或发布路径。
