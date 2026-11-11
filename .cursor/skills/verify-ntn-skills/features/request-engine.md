# 直连请求引擎

这份地图覆盖 AH-561 的请求层；产品名 `ntn-skills` 保留。当前生产、包和验收链不得调用官方 ntn、使用其登录/Keychain 格式或 stderr 协议。历史记录只标明当时实现，不改写成新引擎的证据。

## 功能与证明边界

| Feature ID | Issue | 用户入口和必须观察的结果 |
| --- | --- | --- |
| NG-VC-01 | AH-562 | 既有验证 Skill 的离线反例、两条冻结提示、独立 oracle 与原生 CLI fail-before。自检通过只证明评估器。 |
| NG-RE-02 | AH-563 | 自有 CredentialProvider，经公开 list/views/read/files/export/resolve 驱动直接 HTTP；分页、身份与正文完整。 |
| NG-RE-03 | AH-564 | create/apply/update、附件与原 operation 恢复；明确拒绝可恢复，超时/断连/不明 5xx 保留 unknown，不能重建或重放。 |
| NG-RE-04 | AH-565 | 不同 cache root 的多进程共享机器级准入；可信 connection/workspace/endpoint 冷却、公平优先级、取消与独立预算。 |
| NG-RE-05 | AH-566 | 两仓产品、doctor、安装、CI/helper/随包 Skill 无官方工具依赖；历史不可变回执单列。 |
| NG-RE-21 | AH-582 | 双仓实际交付产物、精确版本/hash、日用 Pi 重启后消费与文档一致。 |

## Launch

复用已构建的 `packages/cli/dist/ntn-skills.js`。在 Broker checkout 执行下列命令，CLI 路径必须指向本次候选产物。证据父目录须在两个 checkout 外。

```bash
node scripts/verify-skill-graph-contract.mjs --help
node --test scripts/verify-skill-graph-contract.test.mjs
node scripts/verify-skill-graph-contract.mjs self-test
```

这些入口没有服务、后台进程、认证读取或网络请求，不初始化生产配置。自检固定区分两个正例合同和拒绝假阳性的反例；输出 tests 必须大于零。

## Doctor

```bash
node scripts/verify-skill-graph-contract.mjs doctor --cli "$CLI_ENTRY"
```

`CLI_ENTRY` 为实际 Node bin 的绝对路径。Doctor 只读取该文件并记录实际 Node 版本与 SHA-256，不运行业务命令、不验证远端认证，也不暖消费缓存。

## Drive

```bash
node scripts/verify-skill-graph-contract.mjs baseline --cli "$CLI_ENTRY" --cli-root "$CLI_CHECKOUT" --evidence-root "$EVIDENCE_ROOT"
```

`CLI_CHECKOUT` 为本 CLI 仓库，`EVIDENCE_ROOT` 为外部持久证据目录。runner 新建 owned scratch，以白名单环境清除继承认证，在真实候选 CLI 上执行 `--version`、`schema ctl prepare`、`schema update`。不存在的 prepare 或 Requires 保留 fail-before；schema 出现仅记 `schema-present-unverified`。源码扫描和提交基线只表明是否观察到旧路径，不能证明新 HTTP 行为。每次重新运行分配新目录，保留先前失败。

NG-RE-02～04 的 live/故障验证随对应实现切片接入既有 control/CLI；运行前用真实 schema 检查公开入口。生产只读验证使用明确授权凭据；429、request_blocked、超时/断连和未知写入在受控 HTTP fixture 注入，不故意撞生产限流。HTTP账本需记录每次 attempt 的 status、request ID、Retry-After、安全 additional_data、scope、queue/attempt/operation 耗时和结果，不能以 CLI 次数代替请求数。Retry-After 是最小等待；未知写必须保留原 operation 和证据。

## Evidence

新 run 固定保存 `run.json`、`prompts.json`、`contract-tests.json`、真实 CLI version/schema 回执、CLI HEAD、请求层源码 hash 与 `result.json`。artifact hash 防止清理后被替换，输出 `baseline-recorded` 不等于产品通过。分栏为 controlled、real_service、real_model、real_ui、installed_package；未执行项保持 not-run。

```bash
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

`RUN_EVIDENCE` 必须来自本次实际输出。保留失败、unknown 与未执行项，不能用新运行覆盖它们；凭据、认证头和原始 stderr 不落盘。工程目录内的既有索引和 Tern 产物不是验收 scratch。

## Cleanup

```bash
node scripts/verify-skill-graph-contract.mjs cleanup --evidence "$RUN_EVIDENCE"
node scripts/verify-skill-graph-contract.mjs evidence --evidence "$RUN_EVIDENCE"
```

只对 ownership 匹配的离线 scratch 使用系统 Trash，不删除证据、不触碰远端或按进程名清理。`preserved` 只证明证据仍在；functionalStatus 与产品结论保持原值。其它 live runner 继续使用自身已有的 process/owned-fixture cleanup，不借用这份离线 ownership。

## NG-RE-04：机器级调度的实际入口

调度状态独立于内容缓存，默认位于操作系统提供的真实用户主目录下 `.local/state/ntn-skills/request-engine`。它不读取 `HOME`、`XDG_CACHE_HOME` 或项目 cache root 来选择协调目录。清空内容缓存不会重置发送预算。目录为 0700，SQLite 文件为 0600；现有目录、数据库、WAL/SHM 以及祖先路径中的符号链接会被拒绝。受控测试先解析系统临时目录的真实路径，再创建 owned 目录。

| 配置 | 默认值与边界 |
| --- | --- |
| `NTN_SKILLS_SCHEDULER_ROOT` | 上述机器级目录；显式覆盖必须是绝对、当前用户私有且无符号链接的目录。故障注入必须使用独立 owned 根。 |
| `NTN_SKILLS_NOTION_QUEUE_LIMIT` | 每个 connection 的待调度上限 256，允许 1–4096。满队列返回 `NOTION_QUEUE_FULL`。 |
| `NTN_SKILLS_NOTION_INTERVAL_MS` | 保守发送间隔 350 ms，允许显式配置 100–60000 ms。降低间隔前应确认适用预算；配置值不是服务端永久配额。 |
| `NTN_SKILLS_REQUEST_TRACE_LIMIT` | 默认 0，不保留明细；显式启用时允许 1–10000 条有界事件。 |

未知身份先使用 credential 与 API origin 的保守引导预算。只有真实身份响应提供的 connection/workspace 才用于归组，数据库 ID、名称和内容缓存目录不决定限流范围。connection、workspace、endpoint 根据结构化 reason 延长对应冷却，未知 reason 保守作用于全部适用范围。同机不同进程共享此 SQLite；另一台机器、其他未接入本引擎的工具不共享这份状态。

`withAdmission` 在真正发送前取得可用网络名额并原子准入。等待、优先级排队和冷却不占网络名额，也不持有 SQL 事务。写连接使用 exact pin 提供的 `BEGIN IMMEDIATE`；取得事务后重新采样时间，避免锁等待把旧时间变成过期发送时隙。每次实际 HTTP attempt 都重新准入，调度器不拥有第二个重试循环。

队列位置有两秒租约，活动等待者至少每秒续租。没有网络容量的等待者仍计入上限并保持租约，但不阻挡其他进程当前可发送的请求。foreground/required 优先于新 prefetch；prefetch 随等待时间老化，避免永久饥饿。取消移除 owned 位置，进程崩溃后的过期位置可回收，不提前预约未来发送时隙。

### 调度与取消复验

从 CLI checkout 执行，使用当前仓库 Node/Vitest 配置：

```bash
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-request-scheduler.node.test.ts packages/core/test/notion-scheduler-multiprocess.node.test.ts
bun test packages/core/test/request-metrics.test.ts packages/core/test/shared-read-coalescing.test.ts
bun run typecheck
```

第一条入口包含真实 SQLite、受控 Effect 时钟和独立 Node 进程；HTTP fixture 只监听 loopback。多进程配置不同内容缓存根和同一个 owned 调度根，观察真实 HTTP 发送与接收、共享 workspace 冷却和另一个 workspace 的进展、队列满载续租、崩溃后恢复、前台越过预取，以及符号链接拒绝。受控时钟另验证老化公平、已老化但网络满载的预取不挡前台、queue/operation 边界、取消后无未来预约和未知 reason 的保守范围。

发送回调时刻与 loopback 接收时刻分别记录。首次 HTTP 客户端初始化、操作系统调度和网络投递可改变接收间隔，不能把接收时间直接当成发送时刻。共享读取反例验证取消一个 waiter 不停止其他消费者，最后一个 waiter 取消后才停止实际 producer。上述结果属于 controlled，不证明真实 Notion 配额、跨机器协调、安装包或真实模型消费。

workspace 冷却用例先让两个 receiver 完成服务和 Request 初始化，通过原 worker 的 ready/release 屏障，再施加原 1500ms 冷却。从同一 owned SQLite 读取实际 `cooldown_until_ms`，断言共享 workspace 的 dispatch 不早于截止时间，无关 workspace 则在冷却仍有效时 dispatch。两个 Node 冷启动后的 server arrival 差不作为隔离证明；原 15s 用例预算不变。故意将共享 receiver 配到无关 workspace 的早发对照，以及将无关 receiver 配到共享 workspace 的误阻塞对照，必须分别被对应断言拒绝，不能只因两个请求成功就通过。

`workspace-cooldown.json`、`workspace-cooldown-early-shared.json`、`workspace-cooldown-blocked-other.json` 在主要断言前保存 ready、实际冷却起止与持久化截止时间、release、全部 worker dispatch/完成回执及 server arrival。记录实际冷却、dispatch 与 arrival 边界，不能把不同采样时点相减后当成提前发出的证明。保留原失败，不通过改写时间或放宽产品门槛求绿。

该目录下 `fixture-repair/local-01/` 保留 Node 24.20.0 原多进程组 8/8 通过和随后类型收窄失败；仅将已检查的时间戳绑定为局部常量后，`local-02/` 的格式、类型检查及 3 个冷却正反例通过（其余 5 项未重复运行）。最终正常样本的共享 dispatch 为实际截止时间 +14ms，无关 dispatch 为截止时间 −1489ms；早发与误阻塞对照分别偏移 −1484ms、+7ms，并被各自断言拒绝。完整 worker 回执与 arrival 原件均保留。此为本机受控验证，不能替代修复提交后 macOS/Node 22.22.3 的新 CI 门禁。

需要机器可读结果时，在本轮新建、位于 checkout 外的 `NG04_EVIDENCE` 目录输出，不覆盖上次结果：

```bash
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-request-scheduler.node.test.ts packages/core/test/notion-scheduler-multiprocess.node.test.ts --reporter=json --outputFile="$NG04_EVIDENCE/scheduler.json"
```

测试只管理自己创建的进程和目录。多进程 fixture 关闭 owned server/worker 后移入可用的系统 Trash；没有 Trash 时保留目录。外部 JSON 证据不随 fixture 清理。

### HTTP 账本合同

AH-631 在同一 trace 的 attempt 与 queue/retry wait 上增加可选 `attribution: {phase, skill_page_id, operation_id}`。这些字段来自实际 producer 的 Effect 调用上下文，未知为 null；不包含正文、路径、token，也不授权任何操作。阶段仅为 consume、retention、author_preflight、author_apply、author_verify、reconcile；同一重试链保持原归属，离开该调用后不泄漏到下一请求。共享请求的标签只证明 producer 的阶段，不能据此把所有 waiter 归到同一 owner；批量跨 owner 的查询保留 null。旧 trace 缺字段也按 unknown 解释，不按序号猜因果。

`request_metrics.trace` 是有界事件数组。attempt 事件记录序号、请求分类及 body 分类、method、发送起点、实际耗时、结果、请求/响应字节、HTTP status、request ID、reason 和 Retry-After；没有观察到的安全字段为 null。wait 事件记录 queue/retry 和实测等待毫秒。数组不保存原始路径、正文、认证头或 token，`trace_dropped` 明确指出截断，不能把不完整账本计为完整请求证据。

完整空账本需要同时看到 `trace_enabled:true`、`total_requests:0`、空 trace 和 `trace_dropped:0`。service 尚未创建或失败回执没有账本时不能推断零请求。真实入口成功与失败的统一输出由 NG-RE-05 验收；retry 策略接入后还须在唯一传输循环核对 `retry_wait_ms` 的实际归因，不能添加第二次 sleep 来满足数字。

`notionRetryDelay` 只计算带 Effect Random jitter 的等待策略，服务端 Retry-After 始终是下限。实际循环、HTTP attempt timeout、operation deadline、明确拒绝恢复和未知写保护仍由同一传输/原 operation 拥有；单独通过策略测试不代表这些集成已通过。

## SC15 消费请求共享与预算

用户从 `read`、`use`、SDK 消费进入同一 Notion 请求服务。共享键包括凭据/API origin、方法、完整路径/查询/body、文件方式、有效 queueBudgetMs，以及适用的 prefetch class/rate share。显式默认队列预算与省略值属于同一资格；不同预算必须各自排队，不能继承先到者的超时或 deferred 结果。普通读取和安全 metadata query 可以共享 pending producer，完成后不作为结果缓存；写入与可能 retention/adoption 的整次 consume 不合并。

```bash
bun test packages/core/test/notion.test.ts packages/core/test/shared-read-coalescing.test.ts packages/core/test/notion-http.test.ts packages/core/test/request-metrics.test.ts --timeout 30000
NG04_EVIDENCE="$NG04_EVIDENCE" node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/notion-request-scheduler.node.test.ts packages/core/test/notion-scheduler-multiprocess.node.test.ts --reporter=json --outputFile="$NG04_EVIDENCE/scheduler.json"
```

保留短预算先到、长预算先到、同一有效预算共享三个观察，以及单 waiter/最后 waiter 取消、429/503、Retry-After、队列满载、未知写和崩溃恢复原例。NG04_EVIDENCE 必须为新 owned 外部目录；`cross-process-spacing.json` 在断言前保存已提交的准入预算，以及每个 worker 的派发、server arrival 与完成时间。三个 worker 经现有 ready/release 屏障，在 owned SQLite fixture 安装审计 trigger 后才开始请求；只取同一 credential scope 的六次 `next_start_ms` 更新，减去默认350ms得到准入时间。准入间隔至少350ms、六次准入跨度至少1750ms；逐请求仍需满足派发≤到达≤完成。保留原始派发和到达间隔诊断，以及后置延迟压缩派发间隔的受控回归。调度器保证准入预算；事务提交、OS 调度和 HTTP 客户端初始化可能延迟后续派发或到达，不能把这些时间点当作准入或宣称它们匀速间隔。

默认消费不启动预取。可选 prefetch 仍限只读叶子并遵守既有预算，不能预取具有 adoption/retention 副作用的整个 current consume。当前 pending 请求共享、机器级 SQLite 准入和已有重试 owner 保持；没有同条件全任务收益证据时，不新增跨进程内容共享服务、后台 daemon 或另一层 retry。独立安装的 AbortSignal 门禁与真实 Pi Stop 各自验收，不能用内部 producer 取消代替 Agent 已停止或模型已收到正文。
