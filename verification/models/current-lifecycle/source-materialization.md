# 增量物化与原未知写

本页属于现役 current-lifecycle suite。SourceMaterialization 的七个、SourceWriterSettlement 的九个和 SourceMemberAdmission 的八个配置使用同一固定 pstack/TLC 工具、coverage、source hash gate 和 mutation runner。它们不建立另一套产品状态或验收入口。

## SourceMaterialization

有限域为一个注册 Source、两个独立请求 A/B、一个已 ready 成员 old 和一个已声明但未初始化的 legacy sibling。covered、growth、empty 三个正初态分别覆盖完整已有 manifest、请求需要扩展 manifest、没有既有 plan。模型把 plan 的完整集合身份用作 revision，具体规范化 SHA、path/hash/bytes/mode 由生产回放核验。

| 状态性质 | 实现对应 | 故意缺陷 |
| --- | --- | --- |
| SingleSourceWriter | 固定 manager 的 canonical Store fence 覆盖读、计划、全部子写；嵌套调用仅重入已拥有范围 | gate-negative 让两个请求冻结同一个旧视图 |
| PublishedContributionsRemain | 先保留完整声明和 manifest，再追加本次请求；writer 独立拒绝遗漏旧贡献 | replace-negative 将集合替换成当前请求 |
| ReadyRevisionCoherent | 已物化 M 与请求 R 都对应接受的完整 Source revision；writer 独立拒绝漏掉 ready M 的 scope | revision-negative 留下旧 M 的 descriptor |
| LegacySiblingUntouched | 未 ready 的既有声明仍保留，写集合只包含 M 与 R | eager-negative 初始化未请求 sibling |
| MaterializationEventuallyExplained | 有限两个请求在声明的弱公平和外部动作返回下解释为 complete/blocked | 不把 blocked 当作物化成功 |

ReadAndFreeze 是 admission 之后的完整观察，PublishPlan 是 Source applying 期间的计划发布，BindSelectedOwners 抽象已经核验的 M∪R 写入，Finish 才开放普通 current 消费。完整 owner 写入不是 Notion 原子事务；其真实子操作、失败、预算、取消和未知结果由下一模型及 HTTP/Store 回放承担。

## SourceMemberAdmission

三个成员分别表示未转换的 plain、需要转换的 patched 和已有可消费记录 ready。
legacy/current 两个正初态分别从旧候选槽与当前 v2 槽开始；六个反例移除成员分类、
旧候选隔离、地址分代、manager 独立拒绝、ready 保持或 blocked 零派发。
每个配置检查同一完整规则清单，view 保留所有违例组合。

| 规则 | 实现对应 |
| --- | --- |
| CurrentCandidatesRequireV2 | 新快照不采用旧 v1 materializable 声明，fresh 发现后才复用 v2 |
| UnsupportedIsBlocked | 已声明 patch 或已知非普通 Git 表示的待物化成员明确 blocked |
| ReadyRemainsReadable | 已 ready 精确物理记录不因新写能力或 acquisition 限制降级 |
| OldCacheSlotPreserved | 新实现使用 `.v2.json`，保留旧地址与格式 |
| BlockedCandidateDoesNotDispatch | consumer 选择 blocked 候选不调用 manager |
| WriterRechecksTransformation | 即使绕过候选直接提交，manager 仍独立拒绝转换字节 |
| AdmissionEventuallyExplained | 在完整元信息已经返回的有限流程中，成员最终得到解释 |

`oldSlot` 的整数只抽象旧地址/格式保持，不证明原 payload 全部字节或整个 Store 不变。
真实 SQLite 回放核 version/address/scope 严格匹配、旧槽字节不变与 fresh v2 可读；
实际旧 SDK 与新 SDK 对同一 Store 的 catalog/snapshot/consume 兼容另留包身份和原件。
模型假设元信息、物理 ready 与成员身份已经可信，弱公平不保证 provider 获取能够终止。
exact stable ID 快路径没有获取完整树时，未知表示仍由 manager 完整验证；该未知分支没有
被模型中的已分类 patched/plain 替代。真实 Git 模式、文件内容、前台授权和 Pi wire
属于实现和配对 integration 回放，不从此有限模型推导。

## SourceWriterSettlement

unique 正例抽象原 control-record write_id 或 exact monotonic retirement witness；ambiguous 正例的原属性在派发前已经等于 desired，因而一次相等观察不能解释原请求。模型允许原派发在断开或取消之后才应用。取消只让前台脱离，原 gate/意图仍在。

children 正例增加两个独立、已经派发的原子请求。父原写先终结仍不足以替换父操作；必须核完 first 和 last 两个 child。每个 child 的因果完成可以在父返回后发生。这个有限边界检测只看父、先改父后查子和漏掉一子的问题；它不是任意数量子操作的实现精化证明。

| 规则 | 实际核验 |
| --- | --- |
| OriginalIntentPrecedesDispatch | control_write 先落原 Store 再出站；旧 pending 缺 dispatch_protocol 时保留 unresolved |
| UnknownMutationDispatchedOnce | 已发出的未知 business/record/retire action 不因 idempotent 或 resume 重发 |
| UnknownOriginalKeepsAdmission | timeout、SSH 断开和取消不清 pending、不释放未知写给后继 |
| OriginalSettlementIsCausal | 只有原 ACK 或唯一原写见证才能解释原派发；当前 desired 相等不够 |
| OriginalGateRetainsUnsettledWrite | 原动作或任一 child 尚可晚到时保留 admission |
| SuccessorWaitsForSettlement | 原未知业务 mutation 不被新 intent 接班 |
| AllOriginalChildrenSettledBeforeSuccessor | 父首次 replacement/retirement mutation 前检查全部原 children，不能仅靠 child 自己晚一步拒绝 |
| SettledSuccessorNeverOverwritten | 后继完成后没有旧派发再覆盖结果 |
| WriterEventuallyExplained | 在有限公平调度下 complete 或保留原意图的 blocked；不保证远端最终可见 |

known successful reply 证明原派发已结束，不证明内容正确；生产的 settled_action 与随后 verify 失败分开。成功回复但不合格的内容可保持原需要处理状态，不能因缺少“业务完成”就误把已终结请求当成晚到风险。

六个缺陷配置分别移除 replay、release、cancel、value-only、intent 和全部 child fence。每个配置都检查完整相同规则清单，coverage 的 expected_broken 独立列出完整失败集合，不能只检第一条反例。statechart 投影保留每一种破坏组合，包括 parent 已返回但 child 仍未结清。

## 生产回放与实际 guards

操作内核的行为负例在 shared-current-operation.test.ts：unknown idempotent absent/visible、control PATCH 原 write_id、exact retirement、未知原目标下拒绝 successor，以及下一 control checkpoint 被明确拒绝时保留前一业务 ACK。Source 父子用 shared-current-source-write.test.ts 的原 unique child CREATE、before/after-child 未决反例和第一 child 已完成但第二 child 仍未知的完整前置拒绝。固定 manager 的完整 read–plan–write fence 和客户端无本地 fallback 用 shared-current-source-writer.test.ts。物化的四个初态、M/声明集合、ready root 与 Requires、原 native 依赖授权、稳定身份和人工字段由 shared-source-materialization-management.test.ts 与 shared-source-member-discovery.test.ts 覆盖。

scripts/check-formal-mutations.py 在独立副本中删除实际守卫，保留 baseline、mutated、restore 三段命令、输出和源码 hash。每条必须触发对应行为断言；语法/导入错误、fixture 缺失、timeout 和另一冗余 guard 安全拒绝都不代称目标性质被破坏。单 guard 安全存活时保留该事实，只有确有模型对应时才声明 compound mutation。

正式验证先审阅实际改动及源码对应，再更新 coverage.files。当前 SHA 是输入绑定，不是“已验证”标志。全部现役配置和 guard run 的结果独立保存；开发过程中单独跑新模型不替代完整门禁。

## 未由模型证明的边界

模型假设所有协作 Source writer 使用同一固定管理端、同一 canonical Store；不提供跨主机 Notion CAS，不覆盖绕过管理端的外部作者。它抽象持久化与唯一见证，不证明磁盘 fsync、SSH 身份、完整 HTTP 分页或实际 package generation。

旧行 Source Member/Origin 的匹配、无物理行候选、真实 bytes/modes、native/resource 权威、完整 Requires、惰性 Members、注册和授权 digest、跨层事实失效、input receipt、旧 pins、取消后 provider fence、五分钟新 PID 和独立第二客户端都保留实际回放。相关执行入口见 [Source 物化](../../../.cursor/skills/verify-ntn-skills/features/source-materialization.md)；真实 Pi 与包的结果由配对 Broker integration 持有。Notion 阅读投影调用为零不等于人类阅读面已经建设完成。
