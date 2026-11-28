# 当前形式化验证维护

当前产品合同在 [current-contract](current-contract.md)。形式模型只证明明确映射的有限状态；真实 HTTP、完整内容、Notion 清理、安装包与 Pi 投递各自验收。

## 保留的模型

仓库保留 `verification/models/request-engine` 中的 SharedProducer 和 RequestAdmission。前者检查只读 producer 的所有权、隔离、取消与有限共享容量；后者检查一个逻辑请求的排队、有限重试、attempt deadline 和未知写入禁止重试。两者仍使用原来的 21 个配置及完整规则清单。

原 resource-lifecycle、operation-recovery 模型、专属突变脚本、旧图册和旧维护配方已经退役。它们依赖已取消的 event、永久 pin、ACK/review/completion 和独立接受协议。Git 中的历史足以追溯，不保留可误运行的兼容入口，也不把旧模型通过算作当前实现通过。

当前资源与有限意图由 [资源状态 Skill](../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md) 维护 [current-lifecycle](../verification/models/current-lifecycle/README.md)。CurrentLifecycle 保留七个配置，分开内容 owner Operation 与 projection/restore 的有限意图；覆盖当前读取与 writer 交错、未知写不重放、完成资格，以及声明假设下的进展。SourceSync 的十一个配置另查有限 Source 同步协调：原意图优先、完整 affected owner 的旧投影 fence、冻结 commit、配置参与 no-op、授权恢复，以及 Source 与投影结果分离。SourceSyncProgress 的十三个配置检查预算重入后保留投影游标和 full 批次终结前缀、硬失败不丢失，以及 parent 成功项先保存、child 清理只认精确终结资格。LibraryLifecycle 的十四个配置检查 root CREATE 前的独立意图、canonical root 身份、真实 DB/DS 归属、完整 readback、原 pending 寻址和冻结物理绑定。[操作恢复 Skill](../.cursor/skills/verify-notion-operation-recovery/SKILL.md) 仍拥有实际 writer/HTTP/SQLite 回放。四个模型共 45 个配置，复用同一 runner，不增加总验证平台。

同一 current-lifecycle owner 的 [智能缓存合同](../verification/models/current-lifecycle/smart-cache.md)
新增 ObservationSafety、ClosureEvidence、SelectionPins、AdmissionProgress 和 InformationLimit，
共 16 个配置。另有 SourceMaterialization 七个和 SourceWriterSettlement 九个配置，套件合计 77 个。前四者检查证据时间、已知变化/拒绝、完整读集、
固定选择和条件进展；InformationLimit 用有无隐藏编辑的两份环境假设说明信息边界。
十个模型缺陷变体和能力边界反例不是十一项生产 bug。实现对应状态、实际行为回归
及守卫变异分别记录在 coverage 与该切片文档，设计合同接入不代替源码接线。

Hosted Notion MCP 的独立凭据由 [消费验证 Skill](../.cursor/skills/verify-notion-consumption/SKILL.md) 维护 [notion-mcp-auth](../verification/models/notion-mcp-auth/README.md)。保留审核后的 AuthAcquisition v5 与 RefreshRotation v7，共 31 个完整配置：8 个候选正例、19 个故意缺陷和 4 个成功可达性见证。源代码对应只绑定已审阅的认证、store 和同机锁守卫；这不是完整实现精化证明，也不借模型的 Enabled/sessionEpoch 输入证明 Broker 接线。

同一消费验证 owner 的 [notion-mcp-search](../verification/models/notion-mcp-search/README.md) 独立拥有 SearchAdmission 的 core 资格判定和 SDK Source/auth fence。它复用同一 runner 与冻结工具，保持独立规则与 mutation 清单；Broker 会话和工具投递仍由 Broker 验收。

[skill-reference](../verification/models/skill-reference/README.md) 由同一资源状态 Skill 维护。
ReferenceSelection 的十三个配置检查 containing Library、完整 ref、显式 call scope、
固定 manifest 和 Source authority；ImportRelations 的十一个配置检查冻结批次、
Members 三态、Requires 显式维护和未知 CREATE。两套 Library 可有相同 Skill ID
与路径；相对引用不能凭打平缓存猜身份。实际消费、CLI 导入、SQLite 与包验证分别沿
[引用验证配方](../.cursor/skills/verify-ntn-skills/features/skill-reference.md)。

## 运行入口

先安装仓库锁定依赖，按 [request-engine README](../verification/models/request-engine/README.md) 配置与 `tool-lock.json` 相同的 statechart 工具及 TLC jar。

```sh
node --test scripts/formal-result-contract.test.mjs
node scripts/verify-formal.mjs --suite request-engine --out /absolute/new-model-run
node scripts/verify-formal.mjs --suite current-lifecycle --out /absolute/new-lifecycle-run
node scripts/verify-formal.mjs --suite notion-mcp-auth --out /absolute/new-mcp-auth-run
node scripts/verify-formal.mjs --suite notion-mcp-search --out /absolute/new-mcp-search-run
node scripts/verify-formal.mjs --suite skill-reference --out /absolute/new-reference-run
node --test scripts/formal-runner-contract.test.mjs
```

`--model` 接受 SharedProducer、RequestAdmission、CurrentLifecycle、SourceSync、
SourceSyncProgress、LibraryLifecycle、AuthAcquisition、RefreshRotation、SearchAdmission、
ReferenceSelection、ImportRelations、ObservationSafety、ClosureEvidence、SelectionPins、
AdmissionProgress、InformationLimit、SourceMaterialization 或 SourceWriterSettlement，选择该模型的全部正负配置。
五个现役 suite 为 request-engine/current-lifecycle/notion-mcp-auth/notion-mcp-search/skill-reference，
不兼容已退役模型。输出使用本次新的外部空绝对目录；失败保留原结果，下一次使用新目录。

运行器检查源码对应、工具字节、完整规则清单和每个配置。正例的 broken 集合必须为空；负例必须精确等于声明的集合。未执行的规则、缺失 NoDeadlock、cut、超时、解析失败、额外失败和工具异常都不能算通过。不能从已经删减的配置反向生成较弱规则清单。

## 源码对应与实际守卫

| 变更 | 最小必要验证 |
| --- | --- |
| 展示文字或 view | 检查没有隐藏性质相关状态和坏路径，运行受影响模型全部配置 |
| 模型、配置或性质 | 审阅有限域、原子步骤、环境假设和完整规则，运行其全部正负配置 |
| 对应实现或测试 | 读实际调用路径和差异，运行相应实现回归，确认受影响真实 guard 的破坏与恢复 |

coverage hash 用于阻止未经审阅的漂移。先核当前行为，再更新准确映射；不批量刷新 hash 来制造通过。删除产品协议时，连同不再适用的模型和调用入口退役，保留仍适用的权限、完整性、预算和取消守卫。

LibraryLifecycle 与 ReferenceSelection 的显式 scope 新增量先保留
`design_contract_pending_implementation_binding` 标记。实际 Core v2 守卫、调用方、
反例回归和 mutation 审阅完成后才能更新对应；不能通过旧实现 hash 未变来声称新合同已接线。
root/DB/DS 的独立事实及原 pending 存在是 oracle，不能直接复用候选 descriptor 的判断结果。

真实 mutation 可以运行在官方 paired run 的无 `.git` 私有源码快照中。
现役 runner 核对 `PAIRED_CLI_SOURCE` 的实际路径、run/build 的 root 与身份、原始源码清单摘要，
并要求受保护 source/test、coverage 和验证器字节与选定 build 一致；原有 coverage hash 检查仍执行。
回执明确记录 `checkout_commit: null`、原仓库 commit 与 paired snapshot 身份，不伪造 Git checkout。
普通 Git checkout 路径保持原行为。缺失、无效或互相不符的 provenance 由同一 runner contract 拒绝。

`scripts/check-formal-mutations.py --suite request-engine` 在独立副本中回放 19 个实际 guard。每个必须原件通过、突变导致行为断言失败、恢复后通过。`formal_mutation_result.py` 只接受真实断言诊断；expect 统计行、超时、导入失败或语法错误都不算捕获，混有断言的工具失败也拒绝。现有 runner contract 测试用实际 Bun 输出和 Vitest 结构化错误核对判据。异步用例必须无条件释放自有 latch，让断言错误能够完成退出。当前 immutable runtime case 修改 `shared-current-resource.ts`，并通过公开 SDK 取消 creator，确认另一个 runtime 的读取仍可完成。

同一入口的 `--suite current-lifecycle` 当前回放四十二个实际 guard。智能缓存四条回放见该 suite 的 `smart-cache.md`，Source 物化新增十三条见 `source-materialization.md`。此前二十五条中包括 current 最后读回 fence、projection 分类、never-replay 的未知 action、非内容完成时的 owner 资格，以及 Source 完整 affected 范围、pending 优先、精确 observed commit、no-op 配置 receipt 与 manager/generation 恢复资格。pending mutation 同时移除本地 pipeline 和远端原意图两道拒绝，因为单独去掉一层仍会安全阻塞。只改 projection 外层 activation 条件也会被下一层写入边界拒绝；这种未触发对应行为断言的异常不是该性质已被杀死。各 mutation 必须与模型的真实坏路径一致。Library 的十三条回放另查原 root CREATE 意图、未知写入、根单调性、真实 DB/DS parent、完整 schema/分页、原 current/import pending 寻址和 SQLite 完整绑定；独立物理事实和原 Store 意图不能由候选描述符或新 lookup key 自证。 DS parent 有首次表检查与最终 Sources relation readback 两个独立 enforcers；单守卫存活保留为冗余防御证据。对应 mutation 明确同时移除这两处 parent 检查，逐文件保存/恢复与核 hash，不能把单守卫存活改报通过。 新增真实 SQLite 地址回放专门复现 coordinator 已改为 root/operation、持久层仍含 DS 的裂缝；四个 Node 子进程贯穿真实保存、重启、换表拒绝、child 恢复和退役。其 mutant 必须以行为断言失败，不能用类型或导入错误替代。

Source 物化的十三条实际回放分别检查未知业务值与重发、control Record PATCH/retirement 的原写见证、派发前 durable intent、未知 successor、父操作预检全部 child（含第一 child 已结束而第二 child 仍未知）、同一 manager read–plan–write fence、禁止 local fallback、已物化成员 revision 重绑、惰性 sibling 和 Contributions 保留。保留集合 mutation 同时移除 planner 与 writer 两个独立集合守卫；不能把其中另一层安全拒绝计为模型的集合丢失。ACK 与内容验证分别建证，客户端取消和跨主机路由仍由实际进程/HTTP 回归补足。

Profile 的三条实际回放检查完整 pending binding、锁内真实 root/四表 readback 与 root/Profile 稳定 local fence。真实 Store 测试跨四个 Node 进程，拒绝新 Records 表的相同 fingerprint 吞掉旧 unknown CREATE，保留完整意图并仅在原绑定恢复后按既有当前规则语义收敛。旧 pending 缺 frozen Library 时明确阻断。认证 GET /users/me 单独允许和计量，不能把它抹去当零 HTTP；拒绝后的 Library/Record I/O 和语义写入仍须为零。local fence 落实单协作 owner 假设，有限模型没有 Profile fingerprint、SQLite 或操作系统锁状态。

SourceSync 的七个故意缺陷配置不等于七个独立实现 guard。旧投影归属和 Source/projection 结果分离还依赖原有有限内核，专属 sync 回归在真实协调路径中验证它们，不虚构每条性质都有一个可删除的 `if`。完成 Source 写入后丢失本地 phase 保存，再发生人工 Main metadata 漂移的情况由真实 writer 的只读 `verify_only` 回放；该边界没有被两个抽象 child 步骤证明。

SourceSyncProgress 的八个故意缺陷也不是新增的八条生产 mutation。对应的真实进度、配置冻结、游标保存失败、completed prefix 新 pending、批次预算续接、硬失败保留、parent checkpoint 失败及成功后 child 清理中断回归分别运行协调内核。只有同 batch 的精确成功终结项能授权本地清 child；可重建缓存不承担 full 进度，后续 changed 发布和缓存时间戳都不能抹去原 parent 前缀。真实 SQLite 独立进程验证原子单步与不可变身份。Map 夹具不能替代磁盘证明，有限模型的核验动作也不展开真实 HTTP、Files 或完整 authority inventory。completed prefix 记录过去完成事实，不提供后续外部编辑下的全库原子快照。

`--suite notion-mcp-auth` 回放十二个实际 guard 变体：callback issuer、独立 waiter 取消、退出后的 code exchange 与 grant commit、派发前在途标记、跨进程刷新互斥、崩溃与独立 deadline 后禁止重放、过期 store 发布，以及定时器尚未执行时过期 waiter 的 exchange/commit 和原子发布前 owner 核对。前置 exchange 和未知刷新有多层防御；对应 mutation 明确同时移除这些防御，不能称作单个 if 缺失。锁 mutation 观测的是失去等待重读后第二进程无法复用赢家，pending 守卫仍阻止双派发；不声称该回放观察到重叠 HTTP。断电持久性、真实浏览器、发行包、Hosted 服务行为和跨机锁不在该回放证明内。

AuthAcquisition 只穷举两位同时开始的 waiter 和一份抽象期限；真实不同 deadline 由 Node 回归覆盖。RefreshRotation 为两个进程分别推进期限，保留崩溃前派发标记及未知结果。生产实现对受信 issuer 已解析的 invalid_scope 拒绝保留原 grant，但普通 403/429 不能证明 refresh token 未被消费；模型的 Reject 只抽象终结的 grant 拒绝。查看对应 README 的分层边界，不能把抽象原子提交扩大成真实 fsync/OS 证明。

RequestAdmission 不建模多步骤 import、字节流、multipart 或有限 Operation。默认总预算、嵌套共用预算、耗尽后停止派发、partial writer 与显式 resume 由 `shared-current-invocation.test.ts` 和已有当前操作测试验证。不要把请求模型通过扩大成整个 writer 的证明。

## CI 与结束条件

`.github/workflows/formal.yml` 按现役 suite 运行模型、严格结果测试、实际 guard mutation 和对应实现回归，包含 next 的相关变更。CI 是否通过以该提交的实际日志为准，本地通过不替代它。当前必需回执及原始失败保存到本轮已有证据归档；不能只依赖会过期的 CI artifact 链接，也不建立内容版本库或新证明平台。

请求模型仍只证明 safety/NoDeadlock；CurrentLifecycle 的条件进展要求外部调用返回、准确显式 resume 及所列弱公平性。SourceSync 另假设 affected 范围内的单写者与一次保留原意图的重入；它的两个 child 步骤不证明真实多文件事务、未知请求或 SQLite 持久性。SourceSyncProgress 限于两个 Source 各两个目标、一次崩溃及一次 retryable，最多六次调用，且每次预算必须覆盖完整 scope preflight 加一个剩余目标。这一次崩溃可在目标游标保存前或 parent checkpoint 成功后发生；精确 parent 完成资格抽象为两个身份。永久失败和任意小预算不在进展承诺内；full 进度保存在原 dispatch parent，缓存和墙钟不授权 child 清理。blocked 是保留未知意图的明确结果，partial 也不算业务全完成；这些假设必须随回执保留。Mini 调度、时区、升级、installed package generation 和磁盘治理沿真实运行验收，不能由模型代填。

发现当前未建模的具体风险，优先给实际行为加必要的反例；只有状态分析确实需要时才扩展对应模型。达到本次行为和边界的验证目标后停止。

## 无 Git 的官方源码快照

正式 model runner 和 mutation runner 共用 `formal_source_identity.py`。真实 Git checkout
保留其 HEAD；官方 paired command 的无 Git 源码则校验 run/build manifest、原始 commit、
源清单及受保护源码、模型、配置和 runner 的实际字节，并明确记录 `checkout_commit: null`。
开发 overlay 不属于选中 build，仍须拒绝；不能补造 HEAD 或借用旧候选的来源身份。
Broker 的无 Git model runner 复用 paired CLI 中同一份、先经原始清单校验的 helper。
