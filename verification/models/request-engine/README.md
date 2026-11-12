# RequestEngine 的有限合同（AH-1013 / FV07）

本目录为已经存在的 RequestEngine 补充两个有限状态模型、源码对应关系及真实守护回放。运行入口复用 `scripts/verify-resource-lifecycle.mjs --suite request-engine`；行为入口复用 `verify-ntn-skills`。这里没有新增传输实现、共享服务或另一个重试 owner，也不把 AH-503 的整体工作标记为完成。

## 2026-11-12 基线

完整模型运行 `models-v4` 的 18 个配置均与预期完全相符：SharedProducer 正例 75 states，RequestAdmission 正例 390 states；16 个负例各自只命中声明的性质。`guards-v4` 的 16 处真实源码突变均被行为断言捕获，逐组恢复后通过，原 checkout 哈希未变。新增公开 transport/scheduler 测试为 4 pass、0 fail。原始证据根为 `/Users/yoyo/Documents/code/personal/verification-evidence/ah1006-20261112/request-engine/`，包括本轮失败迭代；图的输入、状态数和渲染器哈希另保存在 `charts/manifest.json`。

## 运行和证据

先安装仓库锁定依赖，再使用仓库的 `verification/models/resource-lifecycle/tool-lock.json` 对应工具。共享 runner 会检查 Pstack 文件清单、TLC jar、模型/配置、完整规则清单及源码哈希。所有输出目录必须是本轮新建的绝对路径，保留失败和先前运行。

```bash
bun install --frozen-lockfile
PSTACK_STATECHART_ROOT=/absolute/pinned-pstack/pstack/skills/statechart \
TLA2TOOLS=/absolute/tla2tools-1.7.4.jar \
node scripts/verify-resource-lifecycle.mjs --suite request-engine --out /absolute/new-model-run

python3 scripts/check-request-engine-mutations.py --out /absolute/new-guard-run
bun test packages/core/test/request-engine-contract.test.ts
```

模型入口也可加 `--model SharedProducer` 或 `--model RequestAdmission` 只重跑受影响模块。`coverage.json.cases` 是唯一配置目录：正例必须完整探索、没有 broken；每个负例必须完整探索，并且 broken 集合恰好等于预期。工具错误、截断、缺少规则、额外失败或未运行测试均不能算通过。无须真实凭据、Notion HTTP 或后台服务。

守护回放在输出目录内复制受影响源码和 Effect 包，保留每一份原件与变体；其它依赖只读复用。每个 case 都执行原件、单个突变、逐字恢复三次。突变必须触发所选行为测试的断言失败；解析/导入错误不能算被捕获。最终再次核对原 checkout 的全部受保护文件哈希。目录和日志均保留，不改共享 checkout 的生产代码或安装依赖。

## 模型边界

| 模型 | 有限域 | 所证明的边界 | 不包含的证明 |
| --- | --- | --- | --- |
| `SharedProducer` | 两个 waiter；一个共享或两个独立 producer；五种共享上下文；最多一个替代 generation | 同一 Notion service 内 pending 读取的引用归属、隔离和旧清理 | 任意 waiter 数、任意代际、所有 Effect 功能、真实模型收到内容或 Agent Stop |
| `RequestAdmission` | 一次启用 RequestBudget 的调用；最多两次正常 attempt；四个时钟 tick；短/长两种队列预算；一 tick 的 attempt timer；读/写两个分支 | queue、operation、attempt、重试次数、共享冷却和网络 permit 的有限安全性 | SQLite 驱动/崩溃恢复、租约精确 TTL、优先级饥饿、任意时钟跳变、真实配额或跨机器调度 |

`RequestAdmission` 的 operation deadline 来自**显式 RequestBudget**。不能从这个模型推断所有普通请求都有相同的整次操作时限。实际默认 admission deadline、queue budget、每次 HTTP timeout 和 opt-in operation budget 由各自 owner 保持独立。模型把不同数值缩放为有限相对顺序；不声称生产配置就是两次尝试或四个时间单位。

`SharedProducer` 的 `scope` 表示完整共享身份不相等（凭据、origin、内容等），另以 `budget`、`queue`、`service` 分别隔离调用预算、有效排队预算和 service 实例。不同上下文一次只改变一类，以使每个负例的责任明确。`active` 追踪第一个 producer 的 waiter 集合；独立第二个 producer 的终态只用于隔离观察，未展开任意交错或后续工作。

两个模型都检查 safety 与显式 `NoDeadlock`；终态有合法停留边。它们没有添加 fairness 假设，也没有证明所有等待最终结束。取消后的“释放”是本模型的原子清理边界；慢 finalizer 与旧 entry 身份由单独旧清理场景及实际 Effect guard 回放约束。

## 两个共享域

正文 producer 的共享域是**同一个 Notion service 实例**。同机多个 CLI 只通过 scheduler 的 SQLite 状态共享准入、队列与冷却，不共享响应正文、读取 producer 或 Effect cache。模型把 SQL claim 视为原子决定；真实 SQLite、独立进程、租约过期与工作区冷却的行为仍归现有 `request-engine.md` 地图及其受控 Node/Vitest 测试。

`makeSharedReadCoalescer` 的资格判断只接纳现有 safe read；写入、file-backed request 和整个有副作用的 consume 不进入同一个 body coalescing 合同。未知写入只能保留原 operation 的不确定性；本模型没有授权重新创建操作或重发原写入。

## 规则、源码与真实反例

每个模型还包含 `TypeOK` 和 `NoDeadlock`。下表中的 negative config 均保留全部规则，仅开启一处错误；实际源码回放不依靠模型开关，而是在隔离 fixture 修改对应源码，再观察公开行为。

| 模型规则 / negative config | 实际 source guard | 回放必须观察的失败 |
| --- | --- | --- |
| `SurvivingWaiterKeepsProducer` / `SharedProducer.cancel.cfg` | Effect 4.0.5 `Cache.EntryImpl.await` 的 `awaiters > 0` 检查 | 取消 creator 或 joiner 后，另一个 waiter 的 producer 被错误停止 |
| `LastWaiterReleasesProducer` / `SharedProducer.release.cfg` | 同一 finalizer 在最后一个 awaiter 离开时 interrupt producer | 最后 owner 取消后 active producer 仍为 1 |
| `ScopeIsolated` / `SharedProducer.scope.cfg` | `shared-read-coalescing.ts` 的 `ReadKey` 与完整 request identity | 不同 credential/body identity 被合并，实际 producer 数由 4 变为 3 |
| `BudgetIsolated` / `SharedProducer.budget.cfg` | `notion.ts` request key 中的 `budget.identity` | 已耗尽预算的调用者借用另一调用的 producer 并取得 Success |
| `QueueBudgetIsolated` / `SharedProducer.queue.cfg` | `notion.ts` request key 中的有效 `queueBudgetMs` | 短/长预算先到两种顺序不再独立 |
| `ServiceIsolated` / `SharedProducer.service.cfg` | coalescer factory 内独立 `Cache.make` | 不同 service 实例只创建一个 producer |
| `SettledResultNotReused` / `SharedProducer.cache.cfg` | coalescer 的 `timeToLive: 0` | 第二次已完成读取复用旧结果，producer 数不增加 |
| `ReplacementSurvivesOldCleanup` / `SharedProducer.cleanup.cfg` | Effect `Cache.removeEntry` 的 `current.value === entry` | 旧 finalizer 删除替代 entry，后续 waiter 额外创建第三个 producer |
| `CooldownBeforeAdmission` / `RequestAdmission.cooldown.cfg` | scheduler 的 `!decision.admitted` 分支 | 冷却未结束却观察到真实 attempt |
| `CallerDeadlineRespected` / `RequestAdmission.queue.cfg` | scheduler 取 queue deadline 与 operation deadline 的最小值 | 短队列预算到期后仍派发 |
| `CallerDeadlineRespected` / `RequestAdmission.operation.cfg` | transport 取得 RequestBudget，约束 admission deadline | 排队耗尽 operation deadline 后仍派发并成功 |
| `AttemptBudgetRespected` / `RequestAdmission.attempts.cfg` | `request-budget.ts` 的 `attempts >= limits.requests` | 第二个真实 transport attempt 越过剩余请求预算 |
| `UnknownMutationNeverRetried` / `RequestAdmission.unknown.cfg` | transport execute 使用 `isRetryableNotionWriteRejection` | 不明 500 写入被重试，借下一次 200 错误返回 Success |
| `NoPermitDuringQueueOrBackoff` / `RequestAdmission.permit.cfg` | scheduler 的 `withPermitsIfAvailable(1)(take)` 作用域 | 冷却等待仍占唯一网络 permit |
| `CancelledQueueReleasesLease` / `RequestAdmission.lease.cfg` | scheduler release 调用 `state.remove(ticket.id)` | 调用者取消后队列表仍有 owned entry |
| `AttemptDeadlineRespected` / `RequestAdmission.timeout.cfg` | transport 的 `Effect.timeout(timeoutMs)` | 超过单次 HTTP timeout 的写入仍返回 Success |

旧清理合同只覆盖取消 producer 对替代 entry 的影响；operation 发布/恢复、写入 journal 与远端身份证据由 operation-recovery 模型负责。请求字节预算和响应反序列化仍受实际 RequestBudget 测试保护，本目录没有声明它们被 TLA+ 穷举。

### 固定依赖的窄边界

上述 waiter 引用计数和 entry 身份清理确实在 Effect 中实现，不在本仓库重复实现。对应版本为 `effect@4.0.5`，由 `packages/core/package.json` 和 `bun.lock` 固定；`node_modules/effect/dist/Cache.js` 的受审 SHA-256 是：

```text
435911c3d851939b72c8cd189d78e928cdd6ac861495c5435d3c658e8c39c16c
```

`coverage.json` 同时固定这些文件。升级 Effect 后先重新审查实际 waiter/finalizer 及 entry 身份实现，更新有限模型或回放，再更新 hash。不得只更新 lock/hash 来绕过模型失配；这里并非整个 Effect 库的形式化验证。

## 图和证据如何阅读

`charts/` 保存两个正例与两个代表性反例的 Mermaid/SVG，来源是共享 runner 对同一模型、同一配置产生的图，附输入和渲染器哈希。正例显示阶段和分支；反例分别显示“取消一个 waiter 伤及其他调用者”和“未知写入错误重试”的最短错误路径。完整 18 配置的原始输出仍保存在该轮外部证据中。

| 图 | 可读 SVG | 同源 Mermaid |
| --- | --- | --- |
| 共享读取正例 | [shared-producer.svg](charts/shared-producer.svg) | [shared-producer.mmd](charts/shared-producer.mmd) |
| 请求准入正例 | [request-admission.svg](charts/request-admission.svg) | [request-admission.mmd](charts/request-admission.mmd) |
| waiter 取消反例 | [cancel-surviving-waiter.svg](charts/cancel-surviving-waiter.svg) | [cancel-surviving-waiter.mmd](charts/cancel-surviving-waiter.mmd) |
| 未知写入重试反例 | [unknown-write-retry.svg](charts/unknown-write-retry.svg) | [unknown-write-retry.mmd](charts/unknown-write-retry.mmd) |

前三张来自不超过 500 states 的完整图；未知写入负例为 715 states，按 statechart 的既有规则只展示错误路径，完整 TLC 探索仍保留。SVG 由 Pele 1.9.0 渲染，并使用该 skill 提供的 CSS 主题；查看器需支持 SVG CSS 变量。

视图合并同阶段的数值状态并隐藏终态停留；通向错误的时间推进保留明确标签，独立错误性质不合并为同一个好状态。不要把图节点数误当 TLC distinct state 数。重新生成图时调用既有 `/statechart`，遵循其当前渲染步骤；不用手改 Mermaid 来营造模型中不存在的边。

## 维护门槛

| 变更 | 必须同步的证据 |
| --- | --- |
| shared key、coalescer 生命周期、Effect Cache 升级 | 审查源码映射；SharedProducer 全配置；对应真实 guard 回放；刷新图 |
| scheduler queue/lease/permit/cooldown | RequestAdmission 全配置；受影响 guard；现有真实 SQLite/多进程测试中的对应边界 |
| 请求 timeout、RequestBudget 或写入 retry 分类 | RequestAdmission 全配置；实际 transport 断言；确认未知写仍归原 operation |
| 只有文档/视图文案 | 核对视图不改变规则、坏状态分组或路径；重新渲染所展示 SVG |
| coverage hash 变化 | 先解释行为对应，再更新 hash；工具版本与源码漂移必须 fail closed |

维护者在 PR 中说明哪条合同改变、受影响有限域、正负结果与真实代码反例。出现产品缺陷时先修实现；出现模型缺口时修抽象并保留旧失败。没有实际执行的 live/installed/real-model 项保持 not-run。这个有限合同允许日后按已观察到的缺口扩展，不预先建立跨仓统一调度平台。

