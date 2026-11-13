# 原操作恢复的形式化验证

本目录是 [AH-1008](https://linear.app/yoyooyooo/issue/AH-1008) 与 [AH-1009](https://linear.app/yoyooyooo/issue/AH-1009) 的项目验证正本。由 [verify-notion-operation-recovery](../../../.cursor/skills/verify-notion-operation-recovery/SKILL.md) 维护；统一运行器和冻结工具链沿用 [resource-lifecycle](../resource-lifecycle/README.md)。不替换 ImportCreate、CreateRecovery、AcknowledgedContinuation 的既有证明。

## 原操作协议

| 模型 | 有界状态主权 | 正例证明的合同 |
| --- | --- | --- |
| AcknowledgedRecordPrefix | 一个原操作、两个有序 Record 位置、一个已 ACK 前缀和一个未派发后缀 | 原请求与完整载荷绑定 exact ACK GET；前缀无空洞；未知结果不重派发；当前前提和权限复核；独立完成不改写原输入和失败 |
| IndependentAcceptance | 一个已知失败的 add、一个新接受 ID、冻结 File/owner/frontier、review/adopted/completion 三项不可变事实、五类完整冷读证明 | 原失败仍为 needs_review/unproven；接受身份独立；未知同一请求不重派发；精确可见的不可变事实可只读核实，然后仅推进下一个独立 Record |
| RestoreFeedback | 一次冻结提交、一个原 restore 身份、一轮正文动作和一轮最终业务反馈 | 先核实原身份绑定再派发正文；正文已完成而反馈未发时只补反馈；pending/unknown 不换原操作；历史反馈 ACK 与当前正文/Source 前提分离 |

正例只有安全性与有限范围的可达完成路径，不承诺 provider 最终可见、未知结果最终解除或无条件终止。每个反例只启用一个故障常量。完整配置清单和每个配置应检查的全部性质，以 [coverage.json](coverage.json) 的 `cases` 为唯一正本：4 个模型，34 个配置。新增 MaintenanceApply 的实际对应、ACK 抽象和排除项见[维护审阅](../../../docs/maintenance-verification-review.md)。

MaintenanceApply 覆盖一个完整父计划和三个有序子操作：已验证前缀才允许后缀，unknown 不重放，部分树不进入当前消费，旧 pin 保持。具体正文、引用和 Notion 权限由公共实现及安装回归验证。

## 原子边界与源码对应

一次发送、provider 应用、ACK 留存、完整观察分别是不同转移。数据库查询、网络交互和 Store 写入不合并成一个原子事务。

| 模型状态或动作 | 实际源码边界 | 对应解释 |
| --- | --- | --- |
| retainedRecords、CheckOriginal、RejectNonPrefix | `shared-create-recovery-native-authority.ts` 的 `acknowledgedNativeRecoveryPrefix` | 校验同作用域冻结 request 与 ACK、唯一身份、完整请求内容，按计划顺序取前缀。模型集合 {2} 保留第二项却缺第一项，不能借第二项替代第一项 |
| ObserveExactPage | `shared-create-dispatch.ts` 的 observeAcknowledged → observeMutation，`shared-records.ts` 的 verifySharedRecordPage | 由 ACK 响应页 ID 精确 GET，绑定 owner、Record ID、kind、entity、hash、完整 canonical envelope；current equality 不能补造缺失 ACK |
| WaitForCensus、IndexCatchesUp | observeNativeMainRecovery 的 all-kind Records census | query 暂不可见不妨碍 exact GET 核实，但 native suffix 必须等完整 census 与原前缀一致。GET 核实本身不授予继续 suffix 的权限 |
| RecheckBeforeDispatch、RetainSuffixIntent、DispatchSuffix | applySharedCreateNativeRecovery 的每次 beforeDispatch；guardedSourceMutation 的 frozen Store intent → request | 每个新后缀请求前复核当前完整正文、所有权和权限；保留意图后中断仍是未知，不能猜测请求从未送达 |
| ProviderApplies、RetainAck、VerifySuffix | guardedSourceMutation 的 request response → durable ACK → observe → receipt | 原响应和当前观察不同；不从同名页或当前正文猜历史成功 |
| FreezeReview、Revalidate | `shared-file-add-acceptance.ts` 的 original、validateReview、currentReview、writerAuthority | 已知原 mismatch 与完整原 plan/outcome 是接受前提。File、owner、frontier、独立接受身份固定，派发前重新核对 |
| NextFact、CompleteIndependentDecision | applySharedFileAddAcceptance | 三次独立 Record 依次为 review、adopted event、completion；不生成原 add event，不改原 outcome，不写 native body |
| ObserveExactImmutableFact | sharedCreateDispatch.canResume 与不可变 Record 精确读取 | unknown immutable POST 若事后精确可见，可核实该既有事实；不是重派发，也不是补造原 ACK |
| ColdRead、VerifyCold | completedSharedFileAddAcceptance、reconcileSharedFileAddAcceptance | 空 Store 读者核对完整原 plan/outcome、review、adopted event 和 completion 的精确绑定，不能只有目录或当前 File |
| ProcessingReadback、BodyDispatch | `shared-file-request.ts` 的 assertRequestRestorePlan、afterRestorePlanRetained | 精确原 restore ID 先进入 processing receipt 并读回，再允许正文动作。此处从 processing ACK / exact readback 边界建模，不展开这次前置 PATCH 的整个 HTTP 传输 |
| RetainOriginalOutcome、ReconcileOriginal | restoreSelectedSharedFile、reconcileSelectedSharedFileRestore、processSharedFileRequest(reconcile) | 业务反馈引用原操作既有结果；不重新选择 Source，不替换冻结提交，不重新调用正文写入 |
| RetainFeedbackAck、VerifyFeedback、FeedbackDrift | writeFeedback | 先单独核实同一 native 对象的精确 metadata PATCH，再核对当前上下文。后续正文/Source 变化停止新正文授权，但不抹除历史 ACK |
| ReplaceOriginal、PublishInvalidOutcome、GuessOriginalSuccess | unreconciledRestore、assertRequestRestorePlan、verifiedFeedback 与 reconcile 原结果分支 | 故意坏分支：pending/unknown 不能新 submit 替代；取消/superseded/failed/当前相等不能冒充原 applied |

源码文件位于 `packages/core/src/`。准确 SHA256 与同步源码基线在 `coverage.json`；运行器先比对再运行，不能只更新 hash 使检查转绿。这是经过源码审查的有界抽象，不是机器证明的 TypeScript refinement。

## 性质和反例

每个配置同时运行 TypeOK、该模型全部合同和 NoDeadlock，不只运行预期失败的性质。

### 原 ACK 前缀

| 性质 | 故意反例配置 | 实际回归 |
| --- | --- | --- |
| PrefixNeedsOriginalAck | missing-ack | native recovery missing-ack；原 ACK 不齐零 suffix 写入 |
| PrefixMustBeContiguous | noncontiguous-prefix | 后续 ACK Record 不能代替缺失第一项 dispatch |
| ExactRecordBinding | mismatched-binding | changed-ack、changed-record、extra/foreign-dispatch 拒绝 |
| UnknownNeverRedispatched | repeat-unknown | unknown 原 suffix 可见/不可见都不重派发 |
| AckLookupIndependentOfQuery | query-authority | ACK Record exact GET 在 query 仍不可见时续验 |
| DispatchNeedsFreshPremise | stale-premise | 第二项 Record 后正文变化，只保留前两项写入 |
| DispatchNeedsPermission | permission | ACK Record GET 权限拒绝，零 suffix 写入并保留原 Store |
| OriginalFactsPreserved | overwrite-original | 成功 recovery 后原 plan、原页、原失败/未完成事实仍保留 |
| CompletionNeedsVerification | skip-verification | cold original proof 缺失/篡改与未完成 suffix 拒绝 |

用例在 `shared-create-native-recovery.test.ts` 与 `shared-create-known-recovery.test.ts`。

### 独立接受

| 性质 | 故意反例配置 | 实际回归 |
| --- | --- | --- |
| KnownFailureRequired | accept-unknown-original | unknown original create 即使可见仍不接受 |
| FrozenIdentityRequired | stale-context | review 后 target body、frontier、owner 或 author Store 变化拒绝 |
| IndependentIdentity | reuse-original-id | 独立接受只发布自己的 event，原 add event 不出现 |
| OriginalFactsPreserved | equal-current-is-old-success | 当前 File 被接受后原结果仍 needs_review / unproven，旧 outcome 原样 |
| UnknownNeverRedispatched | repeat-unknown | unknown review 不重派发；unknown event 若精确可见，只补独立 completion |
| CompletionNeedsAdoption | skip-adopted-event | 冷读缺少 adopted event 或替代为原 add event 拒绝 |
| ColdRecoveryNeedsCompleteProof | incomplete-cold-proof | 冷读五类事实缺一即拒绝；合法重哈希但 review/event binding 错也拒绝 |

用例在 `shared-file-management.test.ts`。ColdRead 的可用证明只能来自已核实事实；故意跳过 adopted event 不会凭空出现它的共享证明。

### 原 restore 与业务反馈

| 性质 | 故意反例配置 | 实际回归 |
| --- | --- | --- |
| BodyNeedsBoundOriginal | unverified-binding | 原 ID 未完成 processing 读回时正文零派发，后续 process/submit 不换原操作 |
| BodyNeedsCurrentPremise | stale-body | late body edit、取消 intent、submitted body/frontier/Source 变化停止 |
| FeedbackNeverRepeatsBody | repeat-body-after-feedback-loss | 原正文已完成后预算耗尽，只补原反馈，正文总共写一次 |
| FeedbackRequiresRealAck | equal-feedback-is-ack | 当前反馈字段一致不能证明丢失的 metadata ACK |
| UnknownFeedbackNeverRedispatched | repeat-unknown-feedback | unknown metadata 原请求不重派发 |
| OriginalRequestPreserved | replace-pending-original | pending/unknown 不能被新 submit 或显式 legacy ID 替换 |
| SuccessNeedsAppliedOriginal | invalid-original-is-success；equal-current-is-original-success | cancelled/not_applied 只解除旧 barrier；current equal 不能制造缺失原 outcome |
| HistoricalAckPreserved | forget-historical-ack | ACK 后读回前正文变化：保留已知 metadata 历史事实，拒绝新正文动作 |

用例在 `shared-file-request.test.ts`。feedbackAck 表示原 metadata ACK 支持的已知历史结果；故障 DropHistoricalAck 表示把后续正文变化错误地当成历史 metadata 结果未知，不宣称产品会删除原 ACK 字节。

## 可执行验证

从仓库根执行。工具链配置和冷启动步骤见项目 skill；基础安装与 hash 锁见 `../resource-lifecycle/tool-lock.json`。

~~~sh
node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --out "$OPERATION_RECOVERY_OUT"
node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --model AcknowledgedRecordPrefix --out "$OPERATION_PREFIX_OUT"
bun test packages/core/test/shared-create-native-recovery.test.ts packages/core/test/shared-create-known-recovery.test.ts packages/core/test/shared-file-management.test.ts packages/core/test/shared-file-request.test.ts --timeout 60000
~~~

输出目录必须是新的绝对路径，位于 checkout 外；先配置锁定的 PSTACK_STATECHART_ROOT 和 TLA2TOOLS。source hash 漂移、未知性质、少跑性质、额外反例、不完整搜索、tool error、cut 或 unexamined 都不算通过。

真实源码负对照由 `scripts/check-operation-recovery-mutations.py` 执行。只允许在单独 linked candidate worktree 运行，必须传入 --protected-worktree 与新的 --out。脚本校验候选与产品全部覆盖源文件/测试 hash 相同，依赖不得逃出候选树。四处 guard 的 baseline 必须执行预期数量测试并通过；mutant 必须导致真实断言失败，语法或依赖错误不计；最后恢复原字节、文件模式及完整候选树快照，并复跑通过。

| 实际 guard 对照 | 真实变化 | 独立 oracle |
| --- | --- | --- |
| exact ACK GET | 去掉 ACK 响应页 ID 参数，使 observer 误走 query | query 仍不可见时 exact GET 行为断言失败 |
| 每项 suffix 复核 | 去掉 observeNativeMainRecovery beforeDispatch | 第二个 Record 后正文变化，写入数量越过允许的 2 项 |
| 独立 completion 绑定 | 去掉 same(completion, expected) 检查 | 自洽重新计算 Record hash 但 review/event hash 错的冷读由拒绝变接受 |
| metadata ACK 与当前正文分离 | 错把完整 current context 纳入 metadata ACK 验证 | 正文变化后精确 metadata ACK 被误判，原历史反馈断言失败 |

## 生成图和证据边界

中文 view 是展示投影。保留 dispatch、provider apply、ACK 和 verification 顺序、未知停止状态与最短反例；完整 TLC 报告保留原子状态。独立接受图的“本 Record”循环代表三个固定阶段，编号仍在原始状态中。全图同时展示入口拒绝、未知结果和冷读，比单条反例多；不要为了少几条箭头改 TLA/cfg。

原件根：`/Users/yoyo/Documents/code/personal/verification-evidence/ah1006-20261112/operation-recovery/`。保留失败的调模/展示尝试；最终模型输入、工具和源码 hashes 以最后成功完整运行与独立冷跑回执为准。精选图、报告和 manifest 位于本目录 generated/。

分别报告有限模型穷举、真实 TypeScript 公共函数回归、实际 guard 对照和冷 Agent 复跑；均不等于生产 Notion、安装 CLI、跨机器 exactly-once 或任意并发编辑证明。GET 与后续写入之间没有 provider CAS；这里只证明复核得到失效/拒绝结果时停止，不证明观察与写入不可分割。

维护入口：[恢复功能地图](../../../.cursor/skills/verify-ntn-skills/features/import-create-recovery-dry-run.md) · [共享 SSOT 地图](../../../.cursor/skills/verify-ntn-skills/features/shared-ssot.md) · [Notion 验证页](https://app.notion.com/p/4125636c236e819bba12c71af9a0c0f5) · [AH-1006 批次](https://linear.app/yoyooyooo/issue/AH-1006)。
