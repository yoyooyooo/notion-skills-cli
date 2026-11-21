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
| 原生作者 create/update 与局部保留 | shared-current-skill/skill-patch；同名核心 tests、CLI current-skill.test.ts | 公共动作及未选作者内容保留，真实 Notion 与 Pi 另验 |
| 原页登记、受管删除与自动恢复 | shared-current-skill-register/skill-remove；同名核心 tests | 元数据登记正文零写、有限清理、同命令 ACK 恢复 |
| 原生结构化等价 | shared-native-markdown；同名 test、shared-current-write.test.ts | 支持语法、完整语义读回与规范化回执 |
| 全文投影与受限上传 | shared-current-projection/upload；对应 tests | 完整正文、原件及 multipart HTTP |
| 日用正文管理与有限恢复 | shared-current-daily/projection-write；对应 tests | 日用并集、完整文本、native 保留、非文本跳过、消费不阻断 |
| 原 Skill Trash 恢复后完整投影 | shared-current-projection-restore/operation；现有 projection-write、operation/Node、CLI tests | 同页身份与四开关、native/resource 保留、自身中断同命令恢复、零写复跑 |
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
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library skill update TARGET --entry ENTRY --input LOCAL_FILE
ntn-skills ctl library skill register PAGE_ID --entry ENTRY
ntn-skills ctl library skill remove TARGET --entry ENTRY --dry-run
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library projection PAGE_ID --entry ENTRY --dry-run
ntn-skills ctl library projection PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills export SNAPSHOT_ID --output NEW_DIRECTORY
~~~

files 的完整目录不证明 body 已获取。整包导出、单文件输出和实际 Notion 全文阅读分别核对。日用 main 与全部文本子文件必须有完整正文；非文本明确 skipped，原件消费仍需成立。文本占位、原件缺失、Source-generated body 编辑自动接管均是缺陷。全日用只用同一公开 `projection --daily --entry ENTRY`；重跑时同目标、policy 和完整输入一致才自动续原意图，冲突与未确认的未知写仍停止。显式恢复使用原冻结策略，不另起批量 writer。

恢复已完成后被移入 Trash 的 Skill，使用原页的 `projection PAGE_ID --restore
--entry ENTRY`。核 exact-only/default-auto 和与 daily/dry-run/手工恢复参数互斥。
完整实跑沿 [单条命令验收](current-convergence.md#单条命令恢复已完成的投影)：
先清生成正文再 trash，恢复后完整对照和同命令零写，不用额外写操作补结果。
仅恢复同页和当前 Source，不创建替代 owner，不把永久丢失或旧 pending 被外部
trash 说成可自动恢复。

当前 Profile 用 singular `ctl library profile`。set 传完整规则、必填 name/enabled/expect，遗漏 default-view/freshness-json 表示清除。unknown 后的 reconcile 只读当前规则，不重复 POST/PATCH；当前内容相等不伪造旧 ACK。

## 原生日常管理与实际 Pi

复用当前管理 fixture、公开 CLI 与既有安装/Pi 入口，记录 C06/C07b/C08/C10 的实际层级，
不新增 runner。按已授权范围选择代表流程：

1. 用 `skill create` 新建带主文、Markdown 子文档和一个 resource 的 Skill。Markdown 默认
   native；普通末尾 LF/CRLF、列表、代码、链接等使用受支持语法。核完整真实 Notion 读回、
   reported normalized_paths、可发现/可消费及同命令重跑 0 写。Source/resource 比精确原件，
   native 比内容结构及当前实际导出，不拿规范化后的 hash 冒充原始 hash。
2. 只更新主文或一个子文件；先有的另一个 native 编辑、未选的 native/resource、身份与
   作者策略必须保留。含 Source binding 或实际 Source contribution 的目标在此入口分配意图、
   远端写入前拒绝；涉及 Source 内容的变更沿当前 Source 管理入口，不放松 authority guard。
   支持文件删除和 Members/Requires 的空集合各按实际 API 验证。
   日常局部修改不得要求 Agent 导出整树、逐文件 --native 或事后再投影。
3. 在自有 Skills 表内登记已写正文但缺登记的页面：保原 page/body，CLI 补机器字段；有
   支持行时保显式 Path/单 owner。合法 native 重跑零写。缺业务描述要明确报告输入要求；
   外库、重复身份、路径歧义、resource/source 转权或旧 pending 不能被猜测修复。
4. 用 `skill remove` 删除该自有目标，核 Files、无引用自有 resources 与同库入向 Members/
   Requires 一起收敛；引用方、其它关系与 Profile 保持。覆盖分页、删除目标仍 live 时
   收集关系、unknown PATCH/Trash 后继续及重复零写。不得靠 Trash 隐藏的 relation 当已清理。
   首次完成须为 removed/cleanup_verified:true；无 pending 的 already_trashed 或 not_found
   为 cleanup_verified:false，重复零写不能代替首次完整清理证据。
5. 中断/预算/unknown 使用现有 finite operation 回归，普通同意图命令只继续能确认的
   自身动作。完整语义不同、未知语法或并发修改不得伪报 ready；失败证据保留。

真实宿主验收使用用户要求的 `pi -ne` 和实际 group/worker：给自然的新建、修改、读取、
登记与删除目标，让模型从已连接库发现并普通读取 maintain，沿同一选择读取必要 reference 后自行选择
公共动作。任务输入可以给内容和已授权对象，不能预填内部字段、正确命令或期望答案。
核 group/worker 实际调用与 provider 收到的完整正文、后续 native 编辑可读、最终有限
意图清空。缺管理能力、靠外部 Agent 扫尾或只跑准备命令都不能记 passed。真实写入仅
限授权对象；cleanup 也走同一公开 remove。受控、安装、live、natural 结果分开，不提前填数。

维护说明随包和 Notion 投影分别保留身份；无连接或显式离线检查另验包内入口。
发布指导更新后，用现有安装包运行
`node scripts/verify-projected-builtins.mjs --cli CLI --entry ENTRY`，
核全部主文/附件 hash 和发现 Description。脚本只读；Source refresh 不覆盖人工描述。
目录晚到或 View 未含维护项时仍应查询当前库，不能把不完整发现当作切换包内版本的理由。

## 当前内容 writer 与剩余治理

用一个代表性完整输入覆盖 main、引用、代码、图片/二进制和 mode，检查完整替换范围及权威变化。当前 import 默认采用 resource 原件，并清理遗漏的 supporting Files；Source refresh 不能借此覆盖 native 或其他 Source 贡献。不要调用已退役 apply/file takeover/restore/history 路径。

同一意图检查成功、部分完成和响应未知。按 stable identity 核当前效果，只继续未完成范围；再次执行 no-op。反向关系与完整分页控制删除范围。目标索引通过不是全库清理通过。

真实清理先移交唯一当前内容，移除旧表/字段/记录/附件/导航后重新枚举。当前尚无公开全库治理入口，保持明确缺口，不追加临时 audit 内核。

## 安装与日用

独立候选包用实际 Node CLI 和同包 SDK；离开 checkout、无开发 override、空 Store。沿现有 package-smoke 的 current import 生命周期和 SDK 场景验证，实际执行了哪些结果就报告哪些。旧 controlled-authoring/Pi 配方不能沿固定历史 Broker/原 ACK 门禁宣布新包通过。

实际 Notion 和两机 Pi 沿 [current-convergence](current-convergence.md) 第六组与 AH-1197/AH-637/AH-1198。源码测试、包安装、正文/投影、模型投递各自报告。旧 Git sibling/main-takeover HTTP tests 不再出现在本入口的执行清单。

只保留本次必要结果。未完成当前意图所需状态有界保留；其余自有临时物遵守 [系统 Trash 清理](../references/harness.md#cleanup)。不建设新维护验证平台。
