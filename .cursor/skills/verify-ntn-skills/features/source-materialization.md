# 首次明确引用时物化 Source 成员

本切片由 [source-onboarding](../../verify-notion-source-onboarding/SKILL.md) 持有，使用当前公开 SDK、管理模块、HTTP fixture 和 paired Pi runner。管理端只补后续消费可复用的 Source / Skill / Content / Current State / Operation 及必要原件资源；Notion 阅读投影没有参与这条路径。

## Launch

先沿 Broker 的隔离环境入口建立本轮配对 clone、私有 build 和独立安装。保存 CLI/Broker commit、dirty diff、包 inventory、CLI/SDK/management 实际加载 SHA。所有 Node 命令使用本轮选定的受支持 Node 绝对路径；下面的 `node` 代表该路径。

从当前 CLI 源码生成新的服务事实，不预植消费快照、SQLite 或 Git cache：

~~~sh
node scripts/sdk-fixture.ts --outdir /absolute/owned/materialization-fixture --catalog --materialization
~~~

固定 manager 使用本轮自己的 canonical Store、固定包 generation、私有 credentials 和明确的 Library/Source allowlist。受控服务的 loopback origin 只能写在固定 manager 配置里；客户端请求不能选择远端 URL、执行文件、凭据或 Store。第二客户端使用独立 NTN state/config/cache、Broker cache 和 Pi session，仅共享固定 manager binding 和远端事实。manager 与消费者使用不同受控凭据，两个消费者可以使用同一只读凭据。生产 Manager 的 Store 不能作为测试输入。

## Doctor

~~~sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-source-fixture.node.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/shared-source-manager-dispatch.node.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/catalog-retirement.node.test.ts packages/core/test/source-materialization-finalization.node.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/candidate-snapshot.node.test.ts packages/core/test/shared-sqlite.node.test.ts -t "actual SDK Source discovery|Source candidate metadata|unfinished materialization input"
bun test packages/core/test/shared-source-registration-compat.test.ts packages/core/test/shared-source-member-discovery.test.ts packages/core/test/shared-source-materialization-management.test.ts packages/core/test/shared-source-materialization-receipt.test.ts packages/core/test/shared-source-materialization-legacy-registration.test.ts packages/cli/test/management.test.ts packages/cli/test/source-manager-transport.test.ts packages/core/test/shared-current-source-writer.test.ts packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-source-write.test.ts --timeout 60000
bun test packages/core/test/shared-source-directory.test.ts packages/core/test/upstream-source.test.ts packages/core/test/upstream-source-batch.test.ts packages/core/test/source-git-runtime.test.ts packages/core/test/shared-current-portable.test.ts --timeout 60000
~~~

这些命令分别证明 fixture 机制、实际 core 管理和恢复，不代表 Pi 已取得正文。 fixture 预检必须经过生产 Source、current owner、Members 和 Requires parser；惰性 Members 保持 enabled 但缺正文，另保留 disabled 关系拒绝反例。新增持久地址必须通过真实 SQLite 与另一 Node 进程：候选缓存可更新、清理且不能跨 scope；冻结物化输入不可替换、不能被 cache retirement 清掉，完成才物理退役。只用 Map Store 的管理单测无法覆盖地址分类和 schema，不能替代这一层。正式命令按仓库当前测试入口执行，不能把未找到测试、编译错误或超时算作反例杀死。

## 历史注册的读取与管理边界

历史 Notion Options 的 version/adapter/settings 信封保留原值参与注册 digest。
`target_mode` 是有界分类标签，prefix 是旧发布身份提示，均不重写 Git 文件路径。
`storage=auto|fixed-git` 沿当前完整固定 Git 文件合同；显式 `retained` 仍需单独管理决定。
共享 target set 必须同时有合法 publisher ID 和固定 accepted commit，完整只读发现
不意味着一个 Source 可以覆盖原合并目标。需要这种写入的候选返回 blocked/reason，
manager 重读声明后独立拒绝；已有 ready 物理记录仍可按普通消费合同处理。

仅历史 Notion 注册读取接受精确 Selection version=1，再交给原严格成员选择 schema。
新声明 API 的 schema 没有放宽，未知版本、多余字段、非法路径和未知 adapter/settings
仍拒绝。每个失败绑定已验证的 Source ID；不能因无匹配候选而隐藏 partial，不能跳过
一个未完成的 Source 来证明名字全库唯一。新回归使用实际注册 parser、只读发现和
core manager 的远端写账本；真实 Git/包/宿主和多 Source 覆盖另验，不扩大有限模型结论。

## 固定树上的完整名字目录

首次名字发现不获取所有已登记成员的完整资源。独立 `SourceDirectory` 绑定真实固定
commit/tree，完整枚举 configured roster，保留每个 member 的 name/description/main，
没有 files、正文或 content hash。它不能通过完整 `SourceSnapshot` 的 schema，管理端
仍用原完整获取、原件 hash、资源与引用校验准备精确目标。

目录与完整读取共用 Git runtime、安全环境、pin、完整 tree、批量对象获取和 scoped
取消边界，以及 portable 元数据 schema、frontmatter、mapping 和元数据 patch 解释。
只取 SKILL.md、存在的 .ntn-skills.json 及这些元数据实际引用的固定树链接；main 路径
必须能在该 member 的固定树内解析为普通 blob，但查名字不要求读取其正文。
非元数据附件与资源 patch 的内容验证留在完整 preparation；未知 manifest/schema、
不可解析元数据或缺 entrypoint 仍使该 Source 失败，保留 Source ID 并返回 partial。

同 Source 内重复 alias 是完整目录中的多个候选，不能自动去重，也不能使另一个名字
的查询失去完整性。注册身份与 duplicate Source ID 在任何并发 Git 获取之前核验；
最多四个 Source 共享原 invocation budget 和取消，独立返回结果后按注册顺序合并。
该限制不增加 Pi 的 180 秒 Source 准备额度，也不为每个 Source 或 member 重开时限。
生产 `discoverSourceMembers` 在 Library 读取之前安装一次现役整次 RequestBudget，
默认上限仍为 600000ms；它包含这次完整目录与 Requires 查询，并继承原取消 signal。
纯 core 的 `discoverSourceDirectory` 由调用者持有期限，不自行创建 per-Source timer。
公共 SDK 已经耗尽的预算必须以错误结束，不能只把预算失败塞入 partial 并晚写候选。

`shared-source-directory.test.ts` 使用真实过滤 Git HTTP、实际 core 目录入口和既有
Notion/Store fixture：目录不取大附件，无关坏资源与 alias 冲突不吞掉完整名字集合；
精确 `prepareCurrentSource` 仍取得目标全部资源并拒绝坏资源。另核 portable/mapping/
patch 同义、metadata link、未知元数据、重复注册与四路并发。共享父期限反例保留
四个实际 pending Git HTTP 请求、真实 process handle 退出观察及 PGID 前后；后两项
不能重新启动 fetch，候选 cache 和管理写均为零。signal 退出保持其真实异常观察，
不伪造退出码；这层不宣称实际 Pi 取消。保存 cat-file、object
storage 和真实 HTTP 分层证据；它不证明真实 61 个远端可达、实库或 Pi 已完成交付，
也不把不支持 filter 的 Git 服务端正常 pack 回退说成元数据传输上限。

## 幂等管理回执

用 `shared-source-materialization-receipt.test.ts` 核验真实 writer 返回值：另一 request 已完成后，原候选的新 request 返回 `already_ready`、零写和真实 target Source revision；目标已 ready、仅另一 Source 的 Requires 发生写时，回执同时保留目标与写入 Source 的 revision。成功回执缺 target revision 必须同时被 CLI 与 Broker decoder 拒绝，pending/blocked 仍可没有 revision。矛盾的 Source Content/plan/hash 不得产生成功回执。

跨 SDK 边界另留实际消费者鉴权、scope 重绑定、SQLite 失效和严格 Broker 解码的原始证据。普通暖 Pi 的 management=0 证明未调用管理端，不能替代 `already_ready` 管理回执验证。有限模型中的成功事件是抽象，不证明真实 JSON 字段完整。

严格校验管理 envelope、request、execution、Library、target 与 authorization_root 后，
消费者 Library/身份读取、缓存退休或取消仍可能失败。此时公共管理 SDK 继续抛原错误，
在 `details.phase=consumer_finalization` 中分别保留原 `local_error_code` 和
`verified_management`。后者包含原 request_id、execution_id、library 与管理 receipt；
receipt.scope 始终是管理端身份，不能冒充尚未完成验证的消费者 scope。已有错误 details
保存在 `local_error_details`，非领域异常只返回固定安全错误码。

`source-materialization-finalization.node.test.ts` 使用真实本地传输子进程发送受控回执，
记录子进程提交的回执内容、输入与退出回调，结合 loopback HTTP 和 SQLite 核 ready 后本地失效失败、
blocked 后消费者鉴权失败，以及取得回执后的实际 abort。实际 stdout/stderr/close 由 Broker 全链路观测。
传输或回执验证前的失败没有这份证明；远端 error.details
即使伪造相同字段也不能升级为已验证结果。管理事实的保留不允许进入后续完整目录、
普通 consume 或 provider 发布。非领域 defect 通过 runtime 边界单点注入；这条反例不代表
实际远端 writer 故障。实际宿主诊断和取消会话边界仍由 Broker integration 核验。

## 真实管理进程的未决派发

`shared-source-manager-dispatch.node.test.ts` 已进入标准 `test:node`。正常测试链先完成当前 build；该 suite 只执行一次正常 `npm pack` 与独立 consumer install，四例共用完整只读安装。已有 paired artifact 时设置 `NTN_SKILLS_MANAGER_TEST_GENERATION` 为包含依赖的完整 installed/cli prefix，不能只给 dist。`NTN_SKILLS_MANAGER_TEST_OUT` 可指定一个尚不存在的绝对证据目录；不指定时保留 suite 新建的目录，并在输出中报告路径。

每例建立自己的 canonical SQLite Store、固定 manager 配置和真实 HTTP 服务。等精确 mutation 的完整请求到达后终止该自有 manager 进程，服务端保留原请求；随后用相同 Store 与原 intent 启动新 manager，先重试，再释放原请求迟到应用，再次重试。按原始账本核 exact method/page/body hash 只派发一次，核被拒绝的重试和后继没有语义写、全程没有投影写，保存 manager PID/exit、原 SQLite 与一致副本。

| 原派发 | 迟到前必须成立 | 迟到后必须成立 |
| --- | --- | --- |
| Source 业务 PATCH | 原 intent 未决，重试零写 | desired Content 的 GET 相等不能解锁；保持原 intent 并明确 blocked/unresolved |
| 控制 Record PATCH | 原 `control_write` 和唯一 nonce 未决，重试零写 | 仅原物理 Record 中原 nonce 的证据可结清；后续恢复不得重放原请求 |
| 控制 Record retire | 原 locator/hash 未决，重试零写 | 仅原 Record 的实际归档证据可结清，不能重复 retire |
| 子 Skill CREATE | 父子 pending 保持原 scope/intent；不同 request_id 的父后继首次 mutation 前拒绝 | 原子请求晚到后仍拒绝其他父请求；只有原操作可恢复或明确 blocked |

本 suite 终止的是已派发的实际管理进程，不把结果记成 Pi 取消验收。公开 manager 的不同 request_id 后继与 kernel `supersede` 分开记录，后者仍由既有 unit/有限模型覆盖；不新增管理入口来模拟该能力。

## 四个初态

| 初态 | 必须保留及新增的事实 | 必须检查的负面结果 |
| --- | --- | --- |
| `legacy-members` | 已声明三个 Contributions；root 与真实 Requires 两行的 Content/Current State 属性存在且值为空；沿原 Skill ID、physical page、Main File ID 物化两者 | 第三个 legacy sibling 仍未初始化；人工 Enabled/Default Context/Requires/Members 不变 |
| `source-only` | 已有 Source 注册和完整 Git plan；没有该成员 Skill 行；第一次明确引用建立唯一成员 | 新候选不冒充有 physical page 的 ContentRecord；无同名替代、无全仓成员展开 |
| `legacy-source` | Source Status=applied，Content/Contributions/Operation 为空，Last Revision 是原 Git commit；旧 Skill 用 Origin 和额外 Source Member 字段关联 | 旧 revision 只冻结 accepted commit，不能充当 current plan；不拿旧 ZIP/生成正文推断当前字节；保留旧行身份，不丢 Requires |
| `manifest-growth` | 已 ready 的 M 与新请求 R 合并；完整旧 manifest/Contributions 保留；accepted commit 固定 | Source revision 改变后 M 的 descriptor 也对应新 revision；不顺便物化 unready sibling |

已有 Contributions 是声明集合，不能当成全部 ready。管理写集合是已有可消费成员 M 与本次 R；未初始化但已声明的 sibling 仍保留其声明和原行。完整 apply/refresh 仍按其完整集合合同工作，不能拿一次局部物化覆盖 Source 的其他贡献。

另以 `native-root` 变体验证原生 Skill 明确根：真实 Requires 指向未初始化的 Source root，再指向 required。只读 `requires_of` 返回完整 root/page/scope/requires_digest 证明，管理请求保持该授权；普通 consume 最终交付三篇完整正文，native 权威和 Members sibling 不变。 管理前已选过的原生快照须经历管理后的强制 consume，再以不同 PID/空 session 验证同 ID 快照和 tree proof 一致；原生根与两个 Source 节点全部命中本地，不能只检查 Source 节点或以较短响应时间替代 0 HTTP。

## Drive

1. 对同一精确 Library/Source/member 运行 readonly discoverSourceMembers，记录 scope、registration digest、accepted commit/revision、真实物理候选和覆盖失败。源码、补全、列表、模型 read/use 和普通 SDK consume 都不获得管理权限。不存在的行只返回 SourceMemberCandidate。
2. 真正用户输入的字面 `$name` 才签发当前 input receipt。引用/代码围栏里的美元名、模型生成文本、旧分支、旧 session、取消或过期 receipt 不得派发管理。候选不唯一、停用、未知、native 权威、注册改变均明确拒绝。
3. 固定管理端在 canonical Store 的同一 fence 内完成完整 read–plan–write；apply、refresh、sync、materialize、相关 Source 文件/生命周期命令都受该边界约束。配置了 manager 的客户端不得落回本地 writer。SSH 断开、前台取消或超时不能释放未知写或转给新主机。
4. 管理回执绑定 request、scope、Library、Source/member、accepted commit/revision 和真实物理 records。SDK 必须用消费者自身实际鉴权得到公共 scope，原管理 scope 保存在 manager_scope；不同凭据的真实 SQLite identities 要与回执逐项相符。ready 只说明管理目标已落地；它不能替代消费、正文或 provider 证据。回执先失效受影响事实，再完成并持久化同一 Library/消费者 scope 的真实完整 SDK catalog，最后走普通 SDK consume。仅有目标闭包的局部目录不能标成全量缓存；目录失败、非完整或 scope 改变时不能继续发布 ready 正文。use 包含全部真实 Requires，Members 保持惰性；旧 pins 不被回执直接替换。
   这一链路须包含已有日用缓存升级的初态：同 scope 存在旧 v1 和当前 v2 目录，管理后的
   退休不能依赖解码旧目录的全部消费字段。沿 Broker 的 `source-materialize-cache-upgrade`
   运行真实首次引用、完整 provider 和新 PID 零远端暖读，不能用空 Store 成功替代。
5. 对响应丢失的业务 mutation、Operation Record PATCH/retire 和父 Source/子 Skill 分别验证。未知原请求不因 desired 值相等或 idempotent 标签重发；只有原唯一写的终结证据才可放行。已知 ACK 与内容校验成功分开：ACK 可以终结派发，内容仍可能不合格。任何一个 child 仍可晚到时，父 successor 必须在首个 mutation 前拒绝。缺 dispatch 协议标记的旧 pending 保留并报告 unresolved。
6. 用上述 Node suite 覆盖真实管理进程断连与原请求迟到应用，核原 pending/owner applying、零重放和后继拒绝。另沿实际 Pi `source-materialize-cancel-late` 场景，在精确业务 HTTP 已到达后执行真实 RPC abort 与 new_session；释放原请求后，以原 manager stdout/exit 和 Store 核验结清，证明迟到 receipt 没有向已取消回合或新 session 发布正文、绑定和选中图。新的明确 `$` 仍可正常消费，且不重复业务写。未执行该 Pi 场景时记录 `actual_pi_cancellation:not_run`。不能清空 Store、强写 ready 或启动另一操作来获得成功。
7. 真 Pi 第一次 `$` 管理后核普通 consume 的 remote_writes=none、完整 root + Requires provider 字节、独立 management effects、固定 ref 和 session。全部 Notion markdown/blocks 投影写尝试为 0，既有阅读正文保持不变。
8. 五分钟内用同 Store、不同 Pi PID、不同空 session 重新提交同一 `$`。source-only 重用首次未物化候选产生的精确 `alias@skill%3A<stable-id>@namespace` token，证明物化后的真实目录仍识别原选择。整个暖阶段 Notion HTTP、Git HTTP 和管理调用都为 0，所选 root/Requires 的完整正文仍真正进入 provider。再用独立空客户端读同一远端，观察它自己的 metadata/Git 请求且语义写为 0；不得复制第一个客户端 cache/Store。

实际 Pi 命令由 Broker 的 `verify-notion-skills-integration/features/source-materialization.md` 持有，复用 `scripts/notion-sdk-pi.mjs run/evidence` 的五个成功初态场景，以及独立的 `source-materialize-cancel-late` 取消场景；每例 run 后都以相同证据目录执行 evidence 回放。缓存语义同时交接现有四个 http-warm / http-smart 场景，不能只跑新增案例。

## 形式化与 statechart

在同一 current-lifecycle suite 中维护 SourceMaterialization 与 SourceWriterSettlement。前者覆盖 additive 集合、同一 Source writer、完整 revision 绑定和惰性 sibling；后者覆盖 durable dispatch、晚到写、唯一因果见证、取消和后继准入。枚举有限模型的边界、外部 actor 假设和每条预期失败规则，保存 TLC、完整投影和 pstack statechart。

先审阅实际实现差异和 behavioral tests，再更新 coverage source hashes，运行整个现役 current-lifecycle 正负配置和实际 guard mutations。mutation 必须从 baseline pass 到行为断言失败，再精确还原通过。模型不证明 Notion 原子事务、外部非协作 writer、跨主机 CAS、fsync 或真实 provider；单 Source/有限动作抽象必须由实际多客户端/父子故障回放补齐。

## Evidence 与 Cleanup

保留源事实、真实 Git commit/blob/hash/bytes/mode、管理 request/receipt、HTTP 调用与阶段、进程 PID/exit、独立 Store 路径、原始 session、provider 请求和完整正文 hash。只测读取原件或管理状态不得写成全链路通过。

fixture、core、SQLite、包、controlled Pi、live Notion、natural model 和普通日用安装分别记录 passed/failed/blocked/not_run。Skill 作者执行与独立冷启动 instruction evaluation 分开。首次失败、修正和 retest_of 保留；没有独立评估时写 instruction_evaluation:not_run。

等本轮 manager 所有原派发可解释并退出后再回收自有进程与文件。未结清的 pending、唯一原件和原 Store 保留。用系统 Trash 处理自有绝对路径，不能借清理操作消掉未知写。
