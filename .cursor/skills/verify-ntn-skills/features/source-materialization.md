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
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/candidate-snapshot.node.test.ts packages/core/test/shared-sqlite.node.test.ts -t "actual SDK Source discovery|Source candidate metadata|unfinished materialization input"
bun test packages/core/test/shared-source-member-discovery.test.ts packages/core/test/shared-source-materialization-management.test.ts packages/core/test/shared-current-source-writer.test.ts packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-source-write.test.ts --timeout 60000
~~~

这些命令分别证明 fixture 机制、实际 core 管理和恢复，不代表 Pi 已取得正文。新增持久地址必须通过真实 SQLite 与另一 Node 进程：候选缓存可更新、清理且不能跨 scope；冻结物化输入不可替换、不能被 cache retirement 清掉，完成才物理退役。只用 Map Store 的管理单测无法覆盖地址分类和 schema，不能替代这一层。正式命令按仓库当前测试入口执行，不能把未找到测试、编译错误或超时算作反例杀死。

## 四个初态

| 初态 | 必须保留及新增的事实 | 必须检查的负面结果 |
| --- | --- | --- |
| `legacy-members` | 已声明三个 Contributions；root 与真实 Requires 两行缺 Content/Current State；沿原 Skill ID、physical page、Main File ID 物化两者 | 第三个 legacy sibling 仍未初始化；人工 Enabled/Default Context/Requires/Members 不变 |
| `source-only` | 已有 Source 注册和完整 Git plan；没有该成员 Skill 行；第一次明确引用建立唯一成员 | 新候选不冒充有 physical page 的 ContentRecord；无同名替代、无全仓成员展开 |
| `legacy-source` | Source Status=applied，Content/Contributions/Operation 为空，Last Revision 是原 Git commit；旧 Skill 用 Origin 和额外 Source Member 字段关联 | 旧 revision 只冻结 accepted commit，不能充当 current plan；不拿旧 ZIP/生成正文推断当前字节；保留旧行身份，不丢 Requires |
| `manifest-growth` | 已 ready 的 M 与新请求 R 合并；完整旧 manifest/Contributions 保留；accepted commit 固定 | Source revision 改变后 M 的 descriptor 也对应新 revision；不顺便物化 unready sibling |

已有 Contributions 是声明集合，不能当成全部 ready。管理写集合是已有可消费成员 M 与本次 R；未初始化但已声明的 sibling 仍保留其声明和原行。完整 apply/refresh 仍按其完整集合合同工作，不能拿一次局部物化覆盖 Source 的其他贡献。

另以 `native-root` 变体验证原生 Skill 明确根：真实 Requires 指向未初始化的 Source root，再指向 required。只读 `requires_of` 返回完整 root/page/scope/requires_digest 证明，管理请求保持该授权；普通 consume 最终交付三篇完整正文，native 权威和 Members sibling 不变。

## Drive

1. 对同一精确 Library/Source/member 运行 readonly discoverSourceMembers，记录 scope、registration digest、accepted commit/revision、真实物理候选和覆盖失败。源码、补全、列表、模型 read/use 和普通 SDK consume 都不获得管理权限。不存在的行只返回 SourceMemberCandidate。
2. 真正用户输入的字面 `$name` 才签发当前 input receipt。引用/代码围栏里的美元名、模型生成文本、旧分支、旧 session、取消或过期 receipt 不得派发管理。候选不唯一、停用、未知、native 权威、注册改变均明确拒绝。
3. 固定管理端在 canonical Store 的同一 fence 内完成完整 read–plan–write；apply、refresh、sync、materialize、相关 Source 文件/生命周期命令都受该边界约束。配置了 manager 的客户端不得落回本地 writer。SSH 断开、前台取消或超时不能释放未知写或转给新主机。
4. 管理回执绑定 request、scope、Library、Source/member、accepted commit/revision 和真实物理 records。SDK 必须用消费者自身实际鉴权得到公共 scope，原管理 scope 保存在 manager_scope；不同凭据的真实 SQLite identities 要与回执逐项相符。ready 只说明管理目标已落地；它不能替代消费、正文或 provider 证据。回执先失效受影响事实，再走普通 SDK consume。use 包含全部真实 Requires，Members 保持惰性；旧 pins 不被回执直接替换。
5. 对响应丢失的业务 mutation、Operation Record PATCH/retire 和父 Source/子 Skill 分别验证。未知原请求不因 desired 值相等或 idempotent 标签重发；只有原唯一写的终结证据才可放行。已知 ACK 与内容校验成功分开：ACK 可以终结派发，内容仍可能不合格。任何一个 child 仍可晚到时，父 successor 必须在首个 mutation 前拒绝。缺 dispatch 协议标记的旧 pending 保留并报告 unresolved。
6. 对 accepted mutation 的真实 HTTP 连接丢失，再让原请求延迟应用。断言无重复派发、原 pending/owner applying 保留、无后继覆盖；取消仅取消等待，迟到 receipt 不发布当前会话内容。不能清空 Store、强写 ready 或启动另一操作来获得成功。
7. 真 Pi 第一次 `$` 管理后核普通 consume 的 remote_writes=none、完整 root + Requires provider 字节、独立 management effects、固定 ref 和 session。全部 Notion markdown/blocks 投影写尝试为 0，既有阅读正文保持不变。
8. 五分钟内用同 Store、不同 Pi PID、不同空 session 重新提交同一 `$`。source-only 重用首次未物化候选产生的精确 `alias@skill%3A<stable-id>@namespace` token，证明物化后的真实目录仍识别原选择。整个暖阶段 Notion HTTP、Git HTTP 和管理调用都为 0，所选 root/Requires 的完整正文仍真正进入 provider。再用独立空客户端读同一远端，观察它自己的 metadata/Git 请求且语义写为 0；不得复制第一个客户端 cache/Store。

实际 Pi 命令由 Broker 的 `verify-notion-skills-integration/features/source-materialization.md` 持有，复用 `scripts/notion-sdk-pi.mjs run/evidence` 的五个 source-materialize 场景。缓存语义同时交接现有四个 http-warm / http-smart 场景，不能只跑新增案例。

## 形式化与 statechart

在同一 current-lifecycle suite 中维护 SourceMaterialization 与 SourceWriterSettlement。前者覆盖 additive 集合、同一 Source writer、完整 revision 绑定和惰性 sibling；后者覆盖 durable dispatch、晚到写、唯一因果见证、取消和后继准入。枚举有限模型的边界、外部 actor 假设和每条预期失败规则，保存 TLC、完整投影和 pstack statechart。

先审阅实际实现差异和 behavioral tests，再更新 coverage source hashes，运行整个现役 current-lifecycle 正负配置和实际 guard mutations。mutation 必须从 baseline pass 到行为断言失败，再精确还原通过。模型不证明 Notion 原子事务、外部非协作 writer、跨主机 CAS、fsync 或真实 provider；单 Source/有限动作抽象必须由实际多客户端/父子故障回放补齐。

## Evidence 与 Cleanup

保留源事实、真实 Git commit/blob/hash/bytes/mode、管理 request/receipt、HTTP 调用与阶段、进程 PID/exit、独立 Store 路径、原始 session、provider 请求和完整正文 hash。只测读取原件或管理状态不得写成全链路通过。

fixture、core、SQLite、包、controlled Pi、live Notion、natural model 和普通日用安装分别记录 passed/failed/blocked/not_run。Skill 作者执行与独立冷启动 instruction evaluation 分开。首次失败、修正和 retest_of 保留；没有独立评估时写 instruction_evaluation:not_run。

等本轮 manager 所有原派发可解释并退出后再回收自有进程与文件。未结清的 pending、唯一原件和原 Store 保留。用系统 Trash 处理自有绝对路径，不能借清理操作消掉未知写。
