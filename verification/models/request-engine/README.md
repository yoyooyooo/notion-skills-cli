# Request engine 的有限模型与源码对应

本目录检查两组合同：在途读取的 waiter / producer 归属，以及一个逻辑请求的准入与重试。`coverage.json` 绑定实际 owner、相关回归和窄范围依赖；两个 TLA 模块及 21 个配置是完整的正负例清单。运行结果由当次 runner 输出，本文件不保存历史成绩。

## 运行

先安装锁定依赖。工具输入由本目录的 [tool-lock.json](tool-lock.json) 固定；使用对应的 Pstack statechart 和 TLC jar。输出目录必须是新的绝对路径。

```bash
bun install --frozen-lockfile
node scripts/verify-formal.mjs --suite request-engine \
  --statechart /absolute/pinned-pstack/pstack/skills/statechart \
  --jar /absolute/tla2tools.jar \
  --out /absolute/new-request-engine-run

python3 scripts/check-formal-mutations.py --suite request-engine --out /absolute/new-guard-run
```

`PSTACK_STATECHART_ROOT` 与 `TLA2TOOLS` 可分别替代 `--statechart` 与 `--jar`。`--suite request-engine` 明确选择本领域；current-lifecycle 独立运行。已完成对应审阅的局部变更可用 `--model SharedProducer` 或 `--model RequestAdmission`；完整 CI 运行全部 21 个配置。

runner 先核对受保护源文件、工具字节和独立规则清单，再执行模型。正例必须完整探索且没有 broken；负例必须完整探索，broken 集合恰好等于该 case 的 `expected_broken`，并检查同一模型的全部规则。工具错误、截断、遗漏规则、额外失败和未执行都不算通过。源文件哈希检查失败发生在 TLC 之前，不能报告为模型反例。

源码突变在输出目录内的隔离副本执行。每个 case 都运行 baseline、单个 mutant、逐字 restored；mutant 必须触发所选行为断言，解析或导入错误不算捕获。它还核对原 checkout 的受保护字节未被修改。SDK case 使用自有 loopback HTTP 服务，不需要真实凭据或远端写入。

## 有限域与边界

| 模型 | 有限域 | 检查的合同 | 未建模内容 |
| --- | --- | --- | --- |
| `SharedProducer` | 两个 waiter；一个共享或两个独立 producer；一个替代 entry；transport / immutable 两域；五种上下文；单位权重容量 1 / 2 | waiter 归属、隔离、独立 producer 生命周期、完成结果不复用、旧清理与共享准入容量 | 任意 waiter 数和替代次数、带权字节算术、整个 consume、资格判定、Store 持久化、所有 Effect 行为 |
| `RequestAdmission` | 一个逻辑请求及其重试链；最多两次正常 attempt；四个时钟 tick；短/长 queue window；一 tick 的 attempt timer；读/写分支 | cooldown、queue / operation / attempt deadline、次数、permit / lease 归属、拒绝与未知写的重试边界 | 多个成功子请求组成的 writer、字节预算、嵌套包装、multipart、SQLite 崩溃、任意时钟、跨机器调度 |

`RequestAdmission` 的 `Success` 直接到终态。它使用已经提供的 operation allowance 约束单个请求，数值缩放为有限相对顺序；它没有描述整个 current import 的多步骤执行，也不把生产预算简化为“两次请求、四个时间单位”。

`SharedProducer` 的 `scope` 抽象完整共享身份不同；`budget`、`queue`、`service` 分别改变一类身份。transport 域只允许同一 Notion service 共享；immutable 域允许完整身份一致的两个标准 Node SDK runtime 共享在途字节。`active` 详细追踪第一个 producer；独立第二个 producer 的终态只用于隔离观察。

两个模型都检查 safety 和显式 `NoDeadlock`，终态有合法停留边。没有 fairness 假设，也没有证明每次等待最终完成。最后 waiter 释放表示中断 producer；它不等于 finalizer 已结束或 socket 同时关闭。

## 当前源码归属

普通 transport 由 `makeSharedReadCoalescer` 在 service 内共享安全读取。请求 key 包括有效 queue budget 和 `RequestBudget.identity`；写入、file-backed 请求及整次有副作用的 consume 不进入这个共享合同。

当前资源由 `readCurrentSharedResourceBytes` 提供独立的在途字节共享。每个调用者先验证当前 owner 与 File descriptor，再将物理 Store 根、detached 凭据 / origin / API 版本 / timeout / scheduler 身份、library、当前 owner / content 和读取 policy 组成完整 key。producer 通过 `detached.run(read)` 持有自己的只读 transport Scope，调用者各自负责资格判定和本地发布。

标准 CLI / SDK runtime 显式启用独立读取。没有 detached context 的自定义 transport，以及带 `RequestBudget` 的调用，都绕过跨 runtime 共享。registry 只保留在途条目，限制为 64 条 / 16 MiB 声明字节；完成结果不缓存。最后 waiter 离开后 entry 不再接受新加入者，已启动 producer 的容量要到 finalizer 完成才释放。

模型的 `admitted` 用单位权重容量 1 / 2 表达这项归属。实际 entry 与字节限制由实现测试检查。容量满时调用者独立读取，所以 `SharedAdmissionBounded` 不是全进程 HTTP 并发上限。同机跨进程的 scheduler SQLite 准入、队列和 cooldown 由实际 Node 测试覆盖，模型只把 SQL claim 抽象为原子决定。

## 规则、guard 与行为反例

每个配置还检查 `TypeOK` 和 `NoDeadlock`。下表的 negative config 只开启对应错误，保留该模型的全部规则。源码回放直接改变 guard，再观察实际行为。

| 模型规则 / negative config | 实际 guard | mutant 必须造成的行为失败 |
| --- | --- | --- |
| `SurvivingWaiterKeepsProducer` / `SharedProducer.cancel.cfg` | Effect `Cache.EntryImpl.await` 的 `awaiters > 0` | 一个 waiter 取消后，仍有 owner 的 producer 被停止 |
| `LastWaiterReleasesProducer` / `SharedProducer.release.cfg` | 最后 awaiter 的 finalizer 中断 producer | 最后 owner 离开后 producer 仍活动 |
| `ScopeIsolated` / `SharedProducer.scope.cfg` | `ReadKey` 与完整 request identity | 不同 credential / body 被合并 |
| `BudgetIsolated` / `SharedProducer.budget.cfg` | `notion.ts` request key 的 `budget.identity` | 已耗尽预算的调用借用另一调用的 producer 成功 |
| `QueueBudgetIsolated` / `SharedProducer.queue.cfg` | request key 的有效 `queueBudgetMs` | 短 / 长 queue budget 发生串用 |
| `ServiceIsolated` / `SharedProducer.service.cfg` | factory 内独立 `Cache.make` | 不同 service 只创建一个 producer |
| `SettledResultNotReused` / `SharedProducer.cache.cfg` | `timeToLive: 0` | 后续读取复用已完成结果 |
| `ReplacementSurvivesOldCleanup` / `SharedProducer.cleanup.cfg` | Effect `Cache.removeEntry` 的 `current.value === entry` | 旧 finalizer 删除替代 entry |
| `SurvivingWaiterKeepsProducer` / `SharedProducer.runtime.cfg` | `shared-current-resource.ts` 的 `detached.run(read)` | creator 关闭后继续完整分页，绑回 creator 的 producer 因其 scheduler 或 SQLite connection 已关闭而使 survivor 读取失败 |
| `SharedAdmissionBounded` / `SharedProducer.capacity.cfg` | immutable coalescer 的 entry / byte admission | 超额读取错误进入共享 registry |
| `SharedAdmissionBounded` / `SharedProducer.cleanup-capacity.cfg` | 已启动 producer 等自己的 finalizer 才 finish | 慢清理尚未完成就释放容量并共享替代读取 |
| `CooldownBeforeAdmission` / `RequestAdmission.cooldown.cfg` | scheduler 的 `!decision.admitted` | cooldown 结束前派发真实 attempt |
| `CallerDeadlineRespected` / `RequestAdmission.queue.cfg` | queue 与 operation deadline 取最小值 | queue budget 到期后仍派发 |
| `CallerDeadlineRespected` / `RequestAdmission.operation.cfg` | transport 取得 `RequestBudget` 并约束 admission | 排队耗尽 operation deadline 后仍派发成功 |
| `AttemptBudgetRespected` / `RequestAdmission.attempts.cfg` | `attempts >= limits.requests` | 真实重试越过剩余请求次数 |
| `UnknownMutationNeverRetried` / `RequestAdmission.unknown.cfg` | `isRetryableNotionWriteRejection` | 不明 500 写入被重试，借后续 200 返回成功 |
| `NoPermitDuringQueueOrBackoff` / `RequestAdmission.permit.cfg` | `withPermitsIfAvailable(1)(take)` | cooldown 等待仍占唯一网络 permit |
| `CancelledQueueReleasesLease` / `RequestAdmission.lease.cfg` | release 调用 `state.remove(ticket.id)` | 取消后队列表仍保留 owned entry |
| `AttemptDeadlineRespected` / `RequestAdmission.timeout.cfg` | transport 的 `Effect.timeout(timeoutMs)` | 超过单次 HTTP timeout 的写入仍返回成功 |

这些 guard 的对应文件和实际回归由 `coverage.json.files` 固定。更新调用路径时，突变必须改到实际执行的 owner，并跨过实际生命周期边界。只等已开始的单页响应结束，无法检查关闭 runtime 后的后续读取。该突变保留全部必要 service，要求两个 eligibility delay 的 survivor 都在 `ready` 断言处失败，并解析实际 SDK 错误：`NOTION_SCHEDULER_UNAVAILABLE`，或 `STATE_CONFIG_ERROR` 且 `phase=sqlite_state`、`error_tag=SqlError`、`operation=execute`、`native_code=ERR_INVALID_STATE`。后者是 current-evidence hook 先触到 creator 已关闭连接的现役反例。任意配置错误、缺 service、模块加载失败、语法错误或超时均不算检出；报告逐例保留实际关闭的 owner。

### Effect 依赖的窄边界

引用计数和 entry 身份清理实际由 `effect@4.0.5` 实现。`packages/core/package.json`、`bun.lock` 和 `node_modules/effect/dist/Cache.js` 一并受 hash 约束。这里仅覆盖 pending Cache 的 awaiter / finalizer / current-entry guard。升级时先审查这些行为和对应突变，再更新 hash；没有对整个 Effect 库作证明。

## Current invocation：实现测试覆盖的边界

`withCurrentInvocationBudget` 为最外层 current 调用安装默认 1000 次 HTTP、512 MiB payload bytes 和 600000 ms deadline；外层可显式调整。嵌套调用复用同一个 identity、计数和 permit，并拒绝更换限制。每次 resume 都是新的 invocation 和新预算，不恢复旧预算历史。

Notion 请求、provider 下载及 multipart 共用计数；重复包装不会重复收费。limits 被复制并冻结，第一次 exhaustion 后不可再准入，包括 attention / cleanup。已准入响应采用 `finish_admitted_response` 字节策略，可能产生 `byte_overshoot`；payload 计数不包含 HTTP / TLS framing。未知写的结果分类仍由 transport 的实际 deadline 处理。

这些行为由 `shared-current-invocation.test.ts` 的真实 HTTP 与可变 current 服务回归覆盖：混合 transport 计数、nested / fresh allowance、超大请求后的小请求禁止准入、未知写 timeout、合法 ZIP wire 上限，以及 writer 到预算后保留当前 intent、无额外治理 HTTP、同输入 resume 收敛。

```bash
bun test packages/core/test/shared-current-invocation.test.ts
```

这组回归与 TLA 互补。两个模型都没有 byte counter、wrapper nesting、multipart protocol、`ready / applying / attention`、当前 Operation 清退或恢复状态。`coverage.json.unmodeled_bindings` 固定其直接实现与回归输入，便于发现漂移；这些 hash 不会新增模型定理。

公开 SDK 的 current owner 与独立 runtime 边界使用 `sdk-immutable-read.node.test.ts`；实际 SQLite / 多进程调度分别使用 `notion-request-scheduler.node.test.ts` 和 `notion-scheduler-multiprocess.node.test.ts`。按变更影响选择对应测试，使用现有 `vitest.config.ts`。

## 输出与维护

runner 在当次输出目录保留 `summary.json`、模型输入、工具临时产物和每个配置的报告及生成视图。视图合并阶段相同的数值状态，不能把图节点数当 TLC distinct states；反例必须来自相同模型、配置和完整规则检查。需要 SVG 时沿用锁定 statechart 的渲染步骤，结果仍属于当次运行。

| 变更 | 必要核对 |
| --- | --- |
| shared key、waiter / producer 生命周期、runtime Scope、共享容量或 Effect Cache | 审实际 caller 与 guard；`SharedProducer` 全配置；对应源码突变及行为回归 |
| scheduler queue / lease / permit / cooldown | `RequestAdmission` 全配置；对应 guard；受影响 SQLite / 多进程边界 |
| timeout、attempt budget、unknown-write retry 分类 | `RequestAdmission` 全配置；实际 transport 断言；核对 unknown 未被重发 |
| current helper、byte latch、provider / multipart 计数 | 对应真实 HTTP 回归；说明未建模范围；仅当 count / deadline guard 变化时重新审模型映射 |
| 只有 view 文案 | 核对不改变规则、坏状态分组或路径；重生成受影响视图 |
| 任一受保护 hash 改动 | 先解释行为与 named guard 对应，再更新 hash；不能用准入刷新代替审阅 |

`cases.expected_rules` 是独立审阅清单，不从变动后的 cfg 自动重建。产品缺陷先修实现，模型缺口先修抽象；未执行项目保持未执行。无需为一次清理另建验证平台、永久成绩册或全套历史证据链。
