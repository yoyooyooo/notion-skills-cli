---
name: verify-notion-source-onboarding
description: "验证Source追加后的完整成员对账、冻结接纳、原页面关联、Git获取、CLI/SDK接手和原操作核对。新增或修改Sources及其成员链路时使用；不负责一般正文编辑、消费缓存或以部分来源成功代替全库覆盖。"
---

# 来源接手验证

不负责把Source ready解释为成员齐全，或把registered解释为正文健康。现有 [Sources规程](../verify-ntn-skills/features/resource-sources.md) 是本领域具体合同；[管理](../verify-notion-management/SKILL.md)负责原生导入/作者操作，[消费](../verify-notion-consumption/SKILL.md)负责当前与固定读取。

## Launch

从仓库根运行，使用 [共用隔离设施](../verify-ntn-skills/references/harness.md#launch)。记录精确候选commit、安装CLI/SDK hash与既有冻结计划。不要复制作者Store、修改上游或手工补Skills/Files/Records来通过。

## Doctor

```sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
```

实库必须明确entry和Source；--all是独立授权范围。多来源审阅须用重复的
`--source EXACT_SOURCE_ID`，保存原始已选分母、单来源超时与总预算未审阅的独立结果；
`scope.kind=sources` 中的 `complete` 只覆盖该批，不能冒充全库绿色。
Provider不可用、缺原输入、无完整cursor或认证不明分别报告，不作为空库。

真实GitHub超时时必须把Git智能HTTP链路与GitHub API、DNS/直连和宿主代理分别诊断。macOS系统代理已开启但Git子进程不继承时，先验证宿主可用回环HTTP代理及GitHub域名；仅在本次CLI进程的可信机器环境中设置`HTTPS_PROXY="$VERIFIED_HOST_HTTP_PROXY"`，按原固定Scope/commit和预算重测。不要变更Source URL、上游仓库或全局FlClash配置来造成功。区分`coverage=complete`的单Source子集与`admit`待接纳、已正式接纳和可消费。每次保存请求/字节/时间/0写账本，不因代理恢复而回写历史失败成成功。

固定 Git 内容消费走上游 commit/tree/blob 与本机缓存，Notion 只维护授权身份、接管和必要历史。针对多成员上游，验证 `review/onboard --source SOURCE --member KEY` 在源码层把范围下推到 Git blob 获取之前；必须仍核对完整配置选路与 commit/tree、只取得所选成员及必要引用的原字节、保留其余成员/正文/原pin、零 Notion 写入。单成员的完整原资源仍按原合同读取；不得将“免拉其他成员”冒充“单成员 123 文件零下载”。普通 Git 日用不要求先补满 Notion Files/Records，也不以历史 retained/native 创建恢复作为发布前置。

新 `create_git` 与独立消费测试必须另核：单个 Disabled 控制页 + 一条必要 pin 证明、0 支持 File/原文件实体、重复执行零新页、unknown POST 可见/不可见均不得重派发，原生人工正文编辑/关系漂移/错误 Git hash 明确拒绝；开启资格只允许另一个显式授权决定。`shared-git-only-consumer.test.ts` 与 `shared-source-onboarding.test.ts` 驱动真实同核 `openSharedConsumer`→按需 `openFixedSnapshotFiles`；原生 `--storage retained` 的旧创建/恢复负例不能消失。Git-only 原字节读取不应“成功地”删除相邻兄弟 Skill 链接，跨成员链接解析需单独证明。真实 Notion 只执行冻结 plan/dry-run 前不得宣称 production admission。

新合同还核验 `Projection=git-only/v1:<SOURCE_PAGE_ID>` 的原始 Owner 与唯一 Origin 一致；之前不含该原始 Source 身份的冻结 `create_git` 计划必须拒绝并重新准备。跨成员资源只经真实 `read ../sibling/SKILL.md --from PINNED_REF` 触发，同 Source/commit/tree、目标已启用、OID/SHA256和目标固定snapshot均通过时才返回精确引用。负例包含 disabled、变更commit或Origin、找不到成员和越界；普通 main read 不允许批量取得兄弟 Git blob 或建立 Notion Files。

## Drive

实现切片（受控数据，不写真实库）：

```sh
bun test packages/core/test/shared-source-onboarding.test.ts packages/core/test/shared-source-definitions.test.ts packages/core/test/upstream-source-batch.test.ts packages/core/test/shared-source-projection-retained.test.ts packages/core/test/shared-import-markdown.test.ts --timeout 60000
```

安装代表沿 [resource-sources](../verify-ntn-skills/features/resource-sources.md) 已有入口：

```sh
# INSTALLED_BIN来自本轮独立安装的package.json bin；EVIDENCE为新私有目录。
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_MEMBERS_EVIDENCE_DIR="$EVIDENCE"   bun test packages/cli/test/library-source-members-http.test.ts --timeout 300000
```

未设精确安装bin时不得报告安装证明。该测试使用真实Git HTTP、实际Node/SQLite及同包SDK，但服务为受控Notion；不证明实际Notion导入。

扩展后的同一旅程包含清单前失败、终局审阅、SDK恢复、冷读及重复核对，受控总时限为
300秒并写入receipt；原100毫秒请求调度和产品预算保持。旧短时限超时原件不能改判为通过，
调整时限后的独立运行须保存新证据，不能用总时限变化掩盖未知写入或省略冷读阶段。

| 子模块 | 正例 | 关键反例 |
| --- | --- | --- |
| 配置/发现 | Selection原字段/v1封装、commit/branch/tag完整固定树 | 未知版本/字段、逃逸/缺资源、超时、半分页 |
| 身份/范围 | disabled已接纳、原页绑定、Router单列、精确--member、重复--source的有界部分范围 | 同名≠原身份；多个Source冲突；伪造member/目标；相同Source别名重复；子集不能伪装全库；不可把Router补成Skill |
| 冻结/执行 | 一个plan由CLI→SDK→CLI交接、零写预览、默认disabled | 来源/目标漂移、失ACK、未知POST、重复建页 |
| 完整资源 | 大清单、100 KiB文本、脚本/binary/mode、冷重建 | 缺块/篡改、丢supporting文件、语义变化不能当格式 |

实库沿review → onboard → dry-run → 同plan apply → 原reconcile → 独立read。
一次多来源review复用一份完整Skills清单，每个选中来源仍独立检查提供方；预算耗尽或单源超时
明确保留未审阅项。`--member` 和 `--bind` 只限精确单来源，不因多个来源只读审阅获得自动绑定授权。
跨Skill引用应保留待审查，不删链接或放开路径逃逸。

错误返回、已分配主页面、原ACK、manifest和不可变终局是不同事实。清单前读回被拒绝，
但原主ACK和journal完整时，已有apply可复用原页并继续未派发后缀；不需要重建或新恢复器。
`onboard-reconcile` 对精确绑定的缺manifest/outcome结果会指向同plan的只读preview，
而非无限重复reconcile；unknown、终局拒绝、其他owner或无法关联的错误不因此获得续写权限。
核对 [原生导入分支表](../verify-notion-management/references/native-import.md)，并运行
`packages/cli/test/source-onboarding-navigation.test.ts` 与原安装HTTP旅程。
已持久化的保留型语义失败另运行 `packages/core/test/shared-create-retained-recovery.test.ts`：
原父计划精确选子、明确review、零写preview、同producer后缀、独立冷读；不以普通apply跳过终局。
原主页面table-plus修复由 `packages/core/test/shared-source-projection-repair.test.ts` 和
`packages/core/test/shared-import-table-literals.test.ts` 验证。原安装旅程增加公开CLI审阅、
同包SDK一次原页修复、原create继续及冷读取；修复未知时改走original apply也必须拒绝。
这不授权重放400拒绝文件或省略不支持资源，具体分支见管理native-import子模块。

### 明确拒绝文件的独立提交

链接图片的第二代表示必须使用明确`wirePolicy/native_linked_images_v2`并绑定第一代
完整review、实际dispatch、明确400负回执与无ACK/完成。验证原图及target保留、旧slot/
共享记录不覆盖、unknown可见/不可见不重放、缺前任冷证明拒绝。运行新增
`packages/core/test/shared-native-linked-images.test.ts`与扩充的`shared-source-file-resubmission.test.ts`；
安装HTTP旅程分别核验v1和v2，v2原POST/第一代/第二代各一次，独立空Store读取全部原文件。

后续已ACK文件经独立修复完成后，原恢复review保持，复核当前连续ACK前缀；扩展completion
把新增修复proof集合绑定到外层身份。运行`shared-source-file-literal-repair.test.ts`中的
progressive前缀、缺ACK/正文/路径变化、冷缺proof和降版删索引反例。不能将局部repair完成
当作整Skill成功，不能放宽默认预算或把mock结果当提供方接纳。

原400负回执只允许评审一个独立新请求；原POST和失败事实保持原样。完整当前前缀、
新ACK和共享proof核验后，原producer显式采用新分配继续；unknown不换身份或重复发送。
单文件完成仍不是整个Skill完成。先读恢复guardian的对应边界，并运行：

```sh
bun test packages/core/test/shared-source-file-resubmission.test.ts packages/core/test/shared-native-image-layout.test.ts packages/core/test/shared-create-scope-cost.test.ts packages/cli/test/source-file-resubmission-navigation.test.ts --timeout 60000
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_FILE_RESUBMISSION_EVIDENCE_DIR="$EVIDENCE" bun test packages/cli/test/library-source-file-resubmission-http.test.ts --timeout 300000
```

安装旅程使用真实Node CLI、同包SDK、真实SQLite和独立空状态冷读；核对完整原内容及
原POST/新POST各自次数。父completion版本必须绑定完整proof集合；同时降版本和丢索引
仍应拒绝。首次全局准入与后续精确范围检查分开，预算维持默认值。实库接口拒绝、
受控提供方通过和真实页面完成分别记证据，不能互相替代。

## Evidence

### 外部直取优先与旧库存储对齐

```sh
bun test packages/core/test/shared-source-storage.test.ts packages/core/test/shared-source-member-url.test.ts packages/core/test/shared-source-batch.test.ts packages/core/test/shared-source-run.test.ts --timeout 60000
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_STORAGE_EVIDENCE="$EVIDENCE" bun test packages/cli/test/library-source-storage-http.test.ts --timeout 180000
```

新的storage review只读完整元数据，不把retained选择当作完成；prepare冻结原commit和
完整path/hash/bytes/mode一致的选择，apply复用原v4metadata journal。正例须保留disabled、
custom、原页、原正文和旧包；负例须覆盖变更原文件/Enabled、丢选择响应的两种可见性、
明确retention、无历史commit及未完成原创建。已证明可Git直取不等于可删除旧历史。

新auto不得因非GitHub、补丁或物化失败静默上传完整包。旧GitLab/转换型的保留路径测试
明确选择retained，继续覆盖原守卫而不偷换它们的目的。安装验收必须实际走CLI审阅/
preview、同包SDKapply、CLIreconcile和独立冷SDK原资源校验；实际Notion另记，不手填
成功记录。Git通道与字节/执行安全交给消费入口，不在此复制新的下载或缓存平台。

已审阅恢复的后缀被明确拒绝也不能自动重派发；`shared-create-retained-recovery.test.ts`
保留该反例及未完成审计。恢复错误应只带原operation/file/path与只读精确next.argv，
不能把整份source包或大计划重复返回给Agent。review通过不证明后续每份Markdown均被提供方接纳。

每个来源保存配置指纹、范围、revision、观察区间、成员分母、registered/admit/bind/blocked、原操作及原页。一次全库观察可能跨越其他写入；记录时间区间，最终再对账，不把旧pending覆盖成当前事实。

新成员默认disabled，因此分别核对主表存在与普通目录曝光。父结果partial、失败页存在、原操作确认、完整文件和当前可消费必须逐项判定。失败只回传定位信息与私有原计划路径，不向Agent灌入正文/签名URL/整份原计划。重复已完成动作必须零新增页和业务版本。

## Cleanup

复用 [harness cleanup](../verify-ntn-skills/references/harness.md#cleanup)。保留旧失败、原输入、ACK和已分配页面；原unknown未结清不能清理Store或换计划。导入脚本只做字节校验，不运行。独立冷Agent仅按该Skill的执行评估尚未完成时明确not_run。

### 支持文件物理代码修复交接

v2普通表格连字符修复使用同一repair-file入口和原dispatcher，不增加第二套状态机。
运行 `packages/core/test/shared-native-table-literal-repair.test.ts` 与
`packages/core/test/shared-source-file-literal-repair.test.ts`，核对多行完整审阅、真实ACK
前缀后中断、丢ACK可见/不可见、物理行换序、人工改文、冷证明缺失和旧v1兼容。
原生页面或源输入不替换，不以全局字符等价修补；默认预算不变。

shared-source-file-repair.test.ts与shared-import-code-padding.test.ts覆盖原已ACK文件的
局部代码修复。原安装旅程须实际走repair-file→SDK→original recovery→冷读取；
未知row响应不能凭当前正文或另一入口放行。API拒绝的有限诊断仅服务定位，不提供
新的原生请求权限；长正文保留复用现有chunk codec，不扩大普通事实限额。

```sh
bun test packages/core/test/shared-source-file-repair.test.ts packages/core/test/shared-import-code-padding.test.ts packages/core/test/notion-http.test.ts --timeout 60000
```
