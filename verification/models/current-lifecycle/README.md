# 当前生命周期的有限模型

本套件由 [resource-lifecycle Skill](../../../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md) 维护。
CurrentLifecycle 检查 C06/C07b 与 current 读取的有限交错；SourceSync 检查当前 Source 同步的有限协调次序；
SourceSyncProgress 检查投影和 full 批次的两个有限完成前缀。
LibraryLifecycle 检查独立根页面的初始化、真实物理归属与原操作绑定。
四者不恢复旧 ACK、永久 pin 或历史管理模型。
源码行为由实际 reader/operation 测试回放；模型与生产 guard mutation 各有独立结果。

## 运行

复用 [统一形式驱动](../../../scripts/verify-formal.mjs)，选择当前套件。工具字节继续使用
c742dd61706fbacc1b95f1a20b7b988cf096ce6c 的 statechart 与锁定 TLC 1.7.4；
较新的工具目录不能因版本更高而略过 [tool-lock.json](tool-lock.json) 的逐文件检查。

```sh
node scripts/verify-formal.mjs --suite current-lifecycle \
  --statechart /absolute/pinned-statechart --jar /absolute/tla2tools.jar \
  --out /absolute/new-lifecycle-model-run
python3 scripts/check-formal-mutations.py --suite current-lifecycle \
  --out /absolute/new-lifecycle-guard-run
bun test packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-projection-write.test.ts packages/core/test/shared-current-source-sync-guards.test.ts packages/core/test/shared-current-source-sync-batch.test.ts packages/core/test/shared-current-source-sync-batch-model.test.ts --timeout 60000
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/shared-sqlite.node.test.ts
```

PSTACK_STATECHART_ROOT/TLA2TOOLS 可替代两项工具参数。使用本次新的外部输出目录；错误运行也保留。
CurrentLifecycle 正例为 content/projection/restore 三个配置；四个反例分别移除读回 fence、projection 分类、unknown 不重放和非内容完成资格。
SourceSync 有 fresh/resume/projection/foreign 四个正例和七个故意缺陷配置。
SourceSyncProgress 有 full/resume/hard/completion/foreign-completion 五个正例和八个故意缺陷配置。
LibraryLifecycle 有一个正例和十三个故意缺陷配置；完整套件共 45 个配置。
同一模型的每个配置检查同一份完整规则清单，expected_broken 独立维护。
缺工具、规则遗漏、cut、超时和解析异常都不算通过。

单独定位时使用 `--model SourceSync`、`--model SourceSyncProgress` 或 `--model LibraryLifecycle`；
完整 current-lifecycle 组运行四个模型的全部配置。

## Library 根页面与操作身份

Library 的唯一身份是根页面的 canonical UUID。descriptor v2 的 `library_id`
直接指向这张根页面；独立 `operation_id` 只表达创建来源。初始化 pending v2
在 root CREATE 前持久化，`parent_page_id` 是获准的外层容器，`root_page_id`
从未知变为已知后不再改变。Ready descriptor 不保存另一个冗余 parent 身份。

LibraryLifecycle 有两个根、一个独立 operation、四个角色和十七种输入场景。
根与 Skills CREATE 分别允许已知成功、已接受但响应丢失且随后可见、
已接受但当前仍不可见。不可见时保留原意图并 blocked；不能据 absence 重发。
模型的四表顺序是有限代表，不证明所有表排列，也不证明实际持久化。

描述符声明、真实 DB parent、真实 DS owner 是三份独立输入。
复制到 B 的 A 描述符不能通过“用描述符 A 作为预期 root，再拿 A 验证 A”自证。
四个角色需要完整、唯一的 DB/DS 绑定，完整观察才允许 Ready。
额外普通文档或未注册数据库不属于角色映射，不会靠扫描或名称自动加入。

原 pending 存在与候选 lookup 的结果也分开。根不变而 Skills S1 换成 S2 时，
把 DS 放进 key 会漏掉原 pending；`pending-table-key` 专门复现这条路径。
即使读到了原 pending，`rebind-operation` 仍检查不能把冻结物理目标换成 S2。
改 alias/default、指定新根或看到另一个 root，都不能接管原操作。

| 正反配置 | 独立检查 |
| --- | --- |
| candidate | 所有场景遵守完整规则，最后 Ready、rejected 或保留原意图的 blocked |
| intent-after-root | root CREATE 之前必须已有 durable intent |
| replay-root / replay-table | 未知非幂等 CREATE 至多派发一次 |
| trust-descriptor | 请求 root 与实际 DB parent 独立于 descriptor；此例故意同时信任声明身份与声明 parent |
| ignore-parent / ignore-data-source | DB 直属 root，DS 直属注册 DB |
| duplicate-role / early-ready | 角色唯一完整，完整 readback 后才 Ready |
| rebind-operation / ambient-retarget | 原物理表和原 root 不能被新表或新默认值替换 |
| foreign-pending / overwrite-root | 原意图准入与已知 root 单调性 |
| pending-table-key | 表变化不能改变原 pending 的寻址并掩盖其存在 |

`InitializationEventuallyExplained` 只在本地动作获执行、外部观察返回、
调用者按原输入恢复的弱公平假设下成立。blocked/rejected 是解释终点，不是业务成功。
安全性质与这条条件进展分开，NoDeadlock 不代替它。

模型只有一个协作 owner，沿现有本机锁；它不承诺跨机 CAS。
readback 和随后远端写入不是原子事务。Ready 记录核验发布时刻，后续人工移动表
仍需在下一次真实边界重新核对。UUID/URL 规范化、API token 权限、完整分页、
具体 schema/property ID、原 SQLite Store 与真实 Notion 迁移由实现和 live 回放验收。

本增量先建立设计合同，生产 guard 锚点待 Core v2 绑定逻辑审查后接线。
`coverage.json` 的 `library_root_design` 标注这一边界；未刷新旧 source hash，
也不能把新增配置或 view 文件当成已运行的证明。

## 两条状态轴与有限范围

内容 owner 有 ready/applying/attention 及自己的 Operation。独立有限意图有 idle/active/unknown/observed/verified/retiring/retired/blocked。
projection 与 same-page restore 可以保留该意图，同时 owner 仍 ready 且没有内容 Operation。
模型不把这两条轴合并为一个 pending 标志。

有限域是一个 owner、两个抽象内容身份、一个固定种类的意图、一个非幂等产品动作、一个 current 读者及最多一个外部 writer。
动作有成功响应、接受但响应丢失、未观测到接受的未知结果三类。
未知未观察到结果时保留原意图并进入可解释 blocked；不由 absence 重发 CREATE/append。
restore 的 Trash 仅抽象为一位；正式命令的 exact page、四开关、policy、共享预算、两阶段和重跑由现行生产测试覆盖。

current 读分 metadata、body、publication。最终 ready 检查与完整消费 fence 都要成立；writer 已完成并重新 ready 仍不能放过身份变化。
publishedSafe 保存发布时刻的事实，后来的合法 writer 不会把过去的有效读取倒算为失败。
这不是 CAS、分布式锁或多个 Notion owner 的全局事务快照。

## 性质与真实 guard

| 性质/反例 | 实际 owner | 生产回放 |
| --- | --- | --- |
| NoMixedCurrentPublication / read-fence | shared-snapshot 最后 consumptionFence 比较 | writer 在 body 期间开始或完成，完整快照不发布 |
| NonContentPreservesReadiness / projection-owner | withCurrentOperation 的 projection 分类及 preserveReadyOwner 分支 | generated bodies 完成不改 owner metadata/readiness；去分类后行为断言失败 |
| UnknownNonIdempotentNeverRepeated / unknown-replay | dispatch 对既有 never-replay action 的拒绝 | unknown absent append 仍仅派发一次，保留 finite intent |
| NonContentCompletionQualified / completion-owner | ownerObservation 的非 ready 拒绝 | owner 在 projection 期间变 unready，不能宣布完成或退役意图 |
| ReadyHasNoContentOperation、NoFalseComplete、UnknownIntentRetained | 同一有限内核状态顺序 | ready 与 Operation 配对；完整核对后清意图；未知事实保留 |

projection 分类去除后，实际内核把该意图按内容操作处理，因此模型中 owner 会进入 applying；这条反例对应生产回放的真实 owner PATCH 断言。
仅去外层 activation 条件会被另一写入边界拒绝，不能把那种异常误称 readiness 已被更改。
真实 mutation 必须 baseline 通过、移除 guard 后出现行为断言失败、恢复原字节后通过；未执行测试、导入/解析异常不算杀死 mutant。
报告保留实际变异文件和前后 hash，原工作树不变。

## Native 管理的对应边界

`93a895f3` 的 Native 管理变更沿用上述四个守卫。`skill_action` 仍是内容意图，
没有把注册、更新或删除归类为保持 owner ready 的 projection/restore。
模型、七个配置、完整规则清单及四项实际 guard mutation 均保留。
本次源码对应审查区分以下边界：

| 实际路径 | 本模型的范围 | 其余生产义务 |
| --- | --- | --- |
| 已绑定 owner 的 create/update | 内容写入的 applying/attention、核对、ready 和意图退役 | create-only 身份、完整输入指纹、自动匹配恢复以及多文件选择由 `shared-current-skill.test.ts` 与 `shared-current-skill-patch.test.ts` 回放 |
| Native 正文完成 | `VerifyTarget` 只抽象验证成功 | `shared-native-markdown.test.ts`、`shared-current-write-input.test.ts`、CLI import 与 Source file 回归验证准入、完整结构等价、原输入保留及 read/export；模型不证明 Markdown 或实际 Notion 格式 |
| 未绑定的原页注册 | 未枚举；模型从 ready owner 开始，没有 ownerBound 变量 | `shared-current-skill-register.test.ts` 验证 exact-page seed、bind、ACK 丢失／未接受恢复，以及外来 Operation 标记零写拒绝；正文保持当前原件 |
| 未选中的 Native/resource 文件 | 未枚举具体 binding 或正文 | partial patch 只冻结所选写入和目录范围，保留文件的后来作者修改不靠旧正文覆写 |
| 整 Skill 删除 | 未枚举；模型的 content `Finish` 返回 ready，不代表 owner Trash | `shared-current-skill-remove.test.ts` 验证反向关系、Files、Resources、owner 与有限意图的清理顺序，及 Trash 后按冻结物理身份读回 |

Native 允许支持范围内的表示规范化，不能再用“逐字相同”描述其完成条件。
原输入 bytes/hash/frontmatter/mode 仍冻结，Source/resource 仍按原字节核对。
完整读回中的文本、代码、链接或结构改变不能当作 Native 成功。
这些生产判定及其实际 Notion 验收不由模型的 `verified` 位代替。
原生普通文本的自动链接校正仍属于同一内容意图：Markdown 结构动作结束后，先按完整正文和物理块绑定校正请求，
再用原严格全文比较设置 Native 完成。中间结构阶段不代表 ready；校正响应丢失时，原 dispatch 按同一请求先观察再决定是否需要写入。
`shared-native-plain-text.test.ts` 和 `shared-current-skill.test.ts` 验证精确文本、样式、代码、作者链接及接受后未知结果的恢复。
对应实现与永久回归列在 [coverage.json](coverage.json) 的 `unmodeled_bindings`；
列入该部分不表示已新增形式证明，也不替代本次实际运行回执。

本地 selection manifest 的 opaque snapshot ID 同时绑定完整 observed record；名称、描述或 Default Context 改变可产生新 snapshot，
而相同正文及文件仍保持原 content version。A→B→C 的原完整绑定、跨进程和 cache clear、伪造 record 拒绝与旧本地 manifest 恢复属于实现验证。
本模型不枚举 record 字段或 ID 公式；该变更没有新增远端历史服务、持久存储 owner 或保留期限承诺。

## 成功恢复后的查询可见性

精确 owner 的恢复 PATCH 成功后，页面读取与稳定 Skill ID 查询可能尚未一致。
只有成功写响应的确认步骤允许短暂观察到「owner 已 live，但完整身份查询暂缺该页」，
最多观察五次，间隔 1、2、4、8 秒；每次仍检查 exact owner、唯一身份、Source 状态和冻结指纹。
等待复用原 invocation 的时限并支持取消，不重复 PATCH。
初始检查、写入前检查、最终验证及未知写响应的显式恢复规则不变。
永久缺行、身份竞争、内容变化、不完整查询、预算耗尽或取消都保留未完成意图。

模型的单个 Trash 位没有枚举 page 与 query 分别可见的时序，也不证明某个真实服务延迟上界。
这些边界由 `shared-current-projection-write.test.ts` 的实际服务夹具回归覆盖，
列在 coverage 的未建模对应中；七个模型配置和四个生产 guard mutation 保持原范围。

## 条件进展

OperationEventuallyExplained 要求最终达到 retired 或 blocked；后者明确保留未解意图，不能算业务完成。
ReadEventuallyExplained 仅针对已经开始的读取，要求最终发布或明确拒绝。

这两条性质以模型列出的弱公平性为前提：已开始的外部调用返回，调用方最终重跑相同冻结输入
（CLI 可以自动选择匹配的 resume），
验证/完成/退役与已开始的读继续得到执行。它们不证明永久断网下成功，不自动替用户恢复未知写，
也不保证 Notion 与 provider 的任意延迟。没有这些假设只声明 safety。NoDeadlock 不能替代这些进展性质。

## Source 同步协调

SourceSync 将一次同步调用与当前 Source 的 readiness、有限意图和阅读投影分开。
其状态从检查原意图开始；只有原意图已经处理，才对新 upstream observation 作决定。
Source 已 ready 但父意图尚未退役时，仍沿原 operation 完成退役，不能凭相同 SHA 返回 unchanged。

有限域为一个 Source、两个受影响 Skill、两个 commit 与配置身份、一个旧意图，以及最多一次进程中断和一次上游分支移动。
第二个 Skill 已从新目标集合移除，但仍在完整 affected 集合内；它的旧投影必须在第一条 Source mutation 前收敛。
本任务的投影可以按原 frozen input 续接；外来的 Source 或 projection 意图必须明确阻塞。
续接旧投影成功后完成本轮，下一次调用才选择新的 upstream commit；不会把原意图的完成回执绑定到后来移动的 HEAD。
模型中的 owned/foreign 只抽象已验证的恢复资格，不证明 manager 字符串或凭据本身提供权限隔离。

| 规则 | 协调义务 | 故意缺陷 |
| --- | --- | --- |
| PendingResolvedBeforeDecision | 先处理当前有限 Source 意图，再决定新检查或 no-op | pending 配置跳过原意图选择 |
| AllAffectedProjectionsSettledBeforeSourceWrite | 旧、新目标并集中的投影都先于 Source mutation 收敛 | projection-scope 只检查仍在新集合中的 Skill |
| FrozenCommitPreserved | 一次 operation 始终使用已冻结 commit | moving-ref 在写入时重读移动分支 |
| ConfigurationBoundToNoop | 轻量 no-op 同时比较 commit 与配置身份 | configuration 只比较 commit |
| OnlyAuthorizedIntentResumed | 自动续接只处理已授权意图 | source-owner/projection-owner 接走外来意图 |
| ProjectionFailurePreservesSourceReady | 后续阅读失败保留已经完成的 Source 内容资格 | projection-readiness 将内容降回非 ready |
| NoFalseSyncCompletion | 完成回执要求原 Source 意图退役、目标完成且无旧投影 | 在所有配置检查，不用 ready 位替代这些事实 |

`shared-current-source-sync-guards.test.ts` 只替换 Git provider 边界，实际运行同步协调、Source writer、投影 writer 和有限 operation 内核。
统一 mutation runner 增加五条真实回放；连同 CurrentLifecycle 的四条，共九条。

| 真实 mutation | 对应回放 |
| --- | --- |
| Source fence 只保留新目标，漏掉 removed owner | 原 beta 投影 append 已接受但丢 ACK；Source 在任何 mutation 前拒绝，原 intent 与旧 revision 保留 |
| 同时跳过 local pipeline 与 remote parent 的 pending 拒绝 | Source 已 ready、旧 receipt 仍匹配，但原父意图未退役；重复命令必须收敛原意图，不能返回新的 no-op |
| 去掉初次 prepare 的 exactCommit | ref 检查后分支从 A 移到 B；实际发布仍必须是 A |
| 去掉成功 receipt 的 configuration 比较 | commit 不变而 Selection 缩小；必须执行真实成员 retirement，不能沿旧 receipt 省略 |
| 去掉 manager 与 execution generation 比较 | 新身份不得消费、修改或清退原 pipeline；原身份仍能恢复 |

pending 的两层拒绝是明确的 compound mutation，不能解释为一个 `if` 缺失。
SourceSync 的 projection-owner/projection-readiness 反例是协调义务；完整 affected fence、原有限内核的 projection 分类守卫及直接恢复测试分别约束实际路径。
不会把它们声称为两个新的一行 guard mutation，也不把 lower writer 安全拒绝误报为错误内容已经发布。

完成 Source 写入后，本地 phase 保存仍可能失败。专属回归在此处注入 Store 失败，再将真实 Skill 主文 Content 指到另一成员的 source_path，
要求原输入只读核验并拒绝漂移：Source、Record 与 owner 均零新写，原 pending 保留；恢复原 metadata 后只读收敛。
该 Store seam 使用内存 Map；真实 SQLite 与独立进程验证仍须单列。

child cursor 只有 0、1、2；每次前进抽象的是一个已观察并核验的目标。
CREATE/append 接受却丢响应、父游标写入丢响应、实际 SQLite 崩溃、完整目录和逐文件字节不在这个原子步骤内。
它们继续由现有 Source writer、operation 与专属 sync guard 回归验证，不能把本模型通过当作全部 writer 的证明。
provider 不可达产生 explained blocked，模型不会把失败转换成完整空集；完整 discovery 的真实性仍由生产边界验证。

SyncEventuallyExplained 只保证到达 complete、unchanged、partial 或 blocked 之一。
它假设该 affected 范围内只有一个协作内容 writer，外部观察能够返回，已开始的步骤与一次原意图重入得到弱公平调度。
partial 保留 Source 成功与投影未完成的区别；blocked 可以保留未决意图，均不算业务全成功。
没有跨机 CAS、调度器 exactly-once、永久断网下成功或 Notion 多 owner 原子事务的保证。

模型不替代 Mini 的调度、重启、时区、installed package generation、持久 Store、磁盘保留和实际请求成本验收。
`SourceSync.view.mjs` 保留旧投影归属、被移除的 owner、ready-but-pending 与候选/上游分支差异。
图合并已验证 child 的具体序号、绝对 commit 值和违反同一规则之后的状态；同标签内的动作不画箭头。
所有动作仍参与 TLC 检查，反例路径上的关键变化与不同规则的失败状态保持可见。
运行器输出的每个 Mermaid 和反例路径用于核对真实 guard，不能只交一张人工流程图作为形式验证结果。

## 预算中断后的有限进度

SourceSyncProgress 从已经冻结的输入开始，单独枚举两种当前前缀：每个 Source 的投影 `next_index`，以及 full 批次的终结结果序列。
投影成功核验后才保存下一游标；进程在两者之间退出时，可以重验当前未提交目标，但不能重新进入已经持久完成的前缀。
full 的 retryable 项不进入终结前缀；hard failure 会进入前缀并保留完整失败结果，不能在后来重跑成功时消失。
Source 的成功终结项先写入原 dispatch parent，再清理该 Source child。
如果 parent 已保存而 child 清理中断，只有完全匹配的成功终结项才能允许纯本地收尾；不能凭 parent 存在或历史 hard failure 清理 child。
批次结束后退役唯一在途记录，不保留逐 tick 历史。可重建的 latest observation 不承担 full 进度。

| 规则 | 有限义务 | 故意缺陷 |
| --- | --- | --- |
| ProjectionCursorVerified | 游标只越过已经核验的目标 | skip-target 在只核验目标 1 后保存游标 2 |
| CursorBoundToFrozenInput | 原游标只能继续原冻结输入 | rebind-input 用新输入续接旧前缀 |
| CommittedTargetNotReentered | 重入不再处理已提交的投影前缀 | repeat-target 从目标 1 重来 |
| CommittedSourceNotReentered | 同一 full 批次不再处理已提交的 Source 前缀 | drop-batch-prefix 重启时丢弃已保存结果 |
| OnlyTerminalSourceResults | retryable 不能成为已完成 Source | advance-retry 将重试项写入终结前缀 |
| HardFailureRetained | 最终报告保留此前的 hard failure | forget-hard-failure 在最后一次调用只报告后续成功 |
| ParentCompletionBeforeChildRetirement | 模型中原 parent 的下一成功项先保存；免远端复核的 child 收尾只认精确成功资格 | early-child-retirement 提前清 child；foreign-parent-proof 接受不匹配的 parent 资格 |

有限域为两个 Source、每个两个投影目标、一次进程中断、一次 retryable 停止，最多六次调用。
这一次中断可以发生在目标核验后、游标保存前，也可以发生在 parent 成功项保存后、child 清理前。
completion 与 foreign-completion 分别从匹配和不匹配的成功 parent 开始，后者必须保留 child 并明确拒绝。
hard 场景在 child 分配前失败；模型不枚举旧 hard 前缀后的 child 续接，以及 parent 已退役或换代的情况。
生产在这些情况下仍须实际核验原 Source/projection，保留既有 hard 结果且不创建或改写其他 parent；它们不能使用成功 parent 的免远端复核捷径。
每次预算为“完整 scope preflight + 一个目标核验”；真实系统也必须留出完整 preflight 后至少推进一个剩余目标的预算。
模型不证明任意小预算都能前进，也不证明生产 HTTP 数量或耗时。
ProgressEventuallyExplained 在单协作 writer、外部观察返回及原输入得到弱公平重入的前提下，最终完成或明确阻塞；不承诺永久错误后业务成功。

实际实现映射到 `continueOwned` 的成功后保存、`checkpointSourceCompletion` 的 parent 先行、`completedBatchChild` 的精确资格、`executeBatch` 的终结前缀，以及 batch helper/schema 和 SQLite 的单步不可变检查。
专属 guard 用实际共享 RequestBudget 停在第一个目标后，检查重跑只读取剩余目标的正文；游标保存失败允许重验当前目标，但不重复其已完成正文 mutation。
batch 回归覆盖预算续接、保留早先 hard failure，以及 full 的 B 由 changed 完成后，再连续发布 C/D 仍不丢失原 parent 前缀；原 full 返回其 B 结果，新 full 才重新对账。
缓存的 `completed_at` 改为 0 或未来值也不参与这个资格。parent 保存失败时 child 必须保留，下一次先完成原 checkpoint，不能被新 HEAD 或后续 cache 覆盖替代。
另一组 guard 在 parent 保存成功后让 child 清理报 STATE_BUSY：本轮报告 75，并保留双方记录；下一 full 只做本地清理，再报告完成。
operation ID、commit、配置、revision 或投影目标任一字段不符，full 与 changed 都拒绝清 child；恢复精确 parent 后 changed 只清理，原 full 结果仍保留到 full 返回并退役。
这些测试运行真实协调与 writer 内核，受控 provider/Notion 与内存 Map 不代表 SQLite 持久性；独立进程的 SQLite 回归另外验证初始空前缀、仅原位或下一项、原输入/目标顺序/批次身份不可变，以及退役后不增长历史。

已完成投影前缀后来出现 pending，即使使用原 deterministic operation ID，也必须在下一目标写入前阻塞。
该精确 guard 和配置漂移由实现回归覆盖，本模型未增加“完成后新远端 intent”状态；九个实际 mutation 的范围也不因此扩大。
parent 完成资格抽象为两个身份，并不枚举真实 UUID、每个字段的值或 SQLite 的断电行为；真实字段比较和两个 Store 边界由上述实际回归约束。
前缀表示本轮曾完成该目标，不是跨 owner 的持续原子快照。Source 的合法权威转移会修改当前 Contributions，受冻结配置检查约束；不把 Main descriptor 的 schema 合法误称为完整 Source authority 校验，也不为已完成前缀重读所有正文。

## 图、源码对应及未覆盖范围

runner 为每次配置保留实际 TLA/cfg/view、TLC 原件、规则结果、报告和可生成的 Mermaid。
view 按内容 owner、finite intent 和 current read 展开并行区域；相同标签的内部转换会折叠。
超过工具图形状态预算时可能只生成反例路径，不能把图节点数当完整状态数量；TLC 完整探索仍须通过。

[coverage.json](coverage.json) 固定实际 source/test 输入和原子边界。
源码变更先审具体 diff；更新 hash 只表示对应关系已审，不是 refinement 或新的通过回执。
CurrentLifecycle 没有枚举 Source 父子游标；SourceSync 的抽象 child 步骤不等于持久投影/批次前缀，后者由 SourceSyncProgress 在上述范围内单独检查。
三者均未枚举完整多文件/owner 写入、schema 升级、multipart、SQLite 崩溃、跨机 CAS、
精确 path/hash/mode、自然语言、Pi 会话及 provider 行为。它们沿各自现役入口验证，不由本套件代填。
