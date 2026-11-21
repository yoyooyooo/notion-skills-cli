# 当前 Skill 管理验证

主要入口：[verify-notion-management](../../verify-notion-management/SKILL.md)。当前语义以 [current contract](../../../../docs/current-contract.md) 为准。旧逐代恢复、Git 主文 takeover 和 HTTP takeover 专用用例不再定义本轮管理能力。

## 实现与实际边界

| 当前行为 | 实现 / 验证 | 证明范围 |
| --- | --- | --- |
| Content union、state、owner/path、完整分页 | shared-current-file/index；shared-current-index.test.ts | 当前 metadata 合同 |
| Native 直接读、末尾 owner guard、无消费写 | shared-snapshot；shared-current-snapshot.test.ts | 当前受控 reader |
| 完整 current Profile 替换和有限 reconcile | shared-profile；shared-profile.test.ts | 单 Profile 当前规则 |
| Exact resource、单原件 attachment、unknown 去重 | shared-current-resource；shared-current-resource.test.ts | 资源存储/获取 helper |
| 完整导入、相等零写、原件导出、清理 | shared-current-write；shared-current-write.test.ts | 真实变更的受控 current 服务 |
| 全文投影与受限上传 | shared-current-projection/upload；对应 tests | 完整正文、原件及 multipart HTTP |
| 日用正文管理与有限恢复 | shared-current-daily/projection-write；对应 tests | 日用并集、完整文本、native 保留、非文本跳过、消费不阻断 |
| 公共命令与包内指导 | command-registration；builtin-guidance.test.ts | 可调用和可教的 current 入口 |

以上源码均在 packages/core/src，核心测试在 packages/core/test，CLI 测试在 packages/cli/test。完整本地 import 与 portable 关系导回已公开；Source 发布/刷新、跨对象关系治理、完整 census/cleanup 仍分别验收。

## 选择必要切片

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-profile.test.ts packages/core/test/shared-current-write.test.ts packages/cli/test/builtin-guidance.test.ts --timeout 60000
~~~

按实际改动选择其中所需测试，不作为每次全跑的固定门槛。保留有区分力的拒绝：错 owner、重复路径/物理行、非 ready、缺 Content、分页未完、missing 原件、字节不符和 unknown 不重复请求。

管理 metadata 能返回 applying/attention 及 operation ID；普通消费在正文前拒绝。ready 必须为空 Operation，不能用手改 ready 绕过半树。普通 native 编辑不创建 adoption/event/历史资源。

## 当前公开路径

~~~sh
ntn-skills ctl library inspect ENTRY
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library projection PAGE_ID --entry ENTRY --dry-run
ntn-skills ctl library projection PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY
~~~

files 的完整目录不证明 body 已获取。整包导出、单文件输出和实际 Notion 全文阅读分别核对。日用 main 与全部文本子文件必须有完整正文；非文本明确 skipped，原件消费仍需成立。文本占位、原件缺失、Source-generated body 编辑自动接管均是缺陷。全日用只用同一公开 `projection --daily --entry ENTRY`；重跑时同目标、policy 和完整输入一致才自动续原意图，冲突与未确认的未知写仍停止。显式恢复使用原冻结策略，不另起批量 writer。

当前 Profile 用 singular `ctl library profile`。set 传完整规则、必填 name/enabled/expect，遗漏 default-view/freshness-json 表示清除。unknown 后的 reconcile 只读当前规则，不重复 POST/PATCH；当前内容相等不伪造旧 ACK。

## 当前内容 writer 与剩余治理

用一个代表性完整输入覆盖 main、引用、代码、图片/二进制和 mode，检查完整替换范围及权威变化。当前 import 默认采用 resource 原件，并清理遗漏的 supporting Files；Source refresh 不能借此覆盖 native 或其他 Source 贡献。不要调用已退役 apply/file takeover/restore/history 路径。

同一意图检查成功、部分完成和响应未知。按 stable identity 核当前效果，只继续未完成范围；再次执行 no-op。反向关系与完整分页控制删除范围。目标索引通过不是全库清理通过。

真实清理先移交唯一当前内容，移除旧表/字段/记录/附件/导航后重新枚举。当前尚无公开全库治理入口，保持明确缺口，不追加临时 audit 内核。

## 安装与日用

独立候选包用实际 Node CLI 和同包 SDK；离开 checkout、无开发 override、空 Store。沿现有 package-smoke 的 current import 生命周期和 SDK 场景验证，实际执行了哪些结果就报告哪些。旧 controlled-authoring/Pi 配方不能沿固定历史 Broker/原 ACK 门禁宣布新包通过。

实际 Notion 和 Pro Pi 共用 [current-convergence](current-convergence.md) 第六组与 AH-1063 旅程。源码测试、包安装、正文/投影、模型投递各自报告。旧 Git sibling/main-takeover HTTP tests 不再出现在本入口的执行清单。

只保留本次必要结果。未完成当前意图所需状态有界保留；其余自有临时物遵守 [系统 Trash 清理](../references/harness.md#cleanup)。不建设新维护验证平台。
