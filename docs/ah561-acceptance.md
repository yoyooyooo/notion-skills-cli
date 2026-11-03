# AH-561 直连引擎与 Skill 依赖图验收记录

任务：[AH-561](https://linear.app/yoyooyooo/issue/AH-561)，共 21 个子任务、33 个用户故事。
日期：2026-11-03。范围：notion-skills-cli、pi-context-broker、既有 Notion 四表库中的 Pstack，以及日用 Pi。

## 当前收口状态

直连引擎、依赖图、Pstack 生产治理、历史恢复与独立安装已完成下列验证。当前候选产品为 CLI9/Broker8，21 张子票中 16 张按独立功能范围完成；AH-566 已完成六份当前 Notion 文档发布和独立读回并转为 Done。H7 通过 96 项回归、两组实际安装 SDK 的分层核对与独立审查，产品实现和验收修复已线性推送两仓 main；最终报告与 33 条故事证据账本由独立文档提交交付。

A 的最新 H6 样本在纠正观察标签后仍缺资源与完整 Skill；B 的 H7 样本在观察完整、服务可用的情况下仍未完成任务。单 Skill 的 17 项要求由 H6 初始 10 个成功病例、H7 targeted 1 个成功病例与 H7 updated 6 个成功病例分别覆盖，原 H6 10/1 结果不变。六份 Notion 文档已全部独立核验：5 页与最终候选逐字相同，05 页接受单独审阅的 3 处 Markdown 转义，原严格比较失败仍保留。生产 census、owned 页/View 和本批 18 个临时目录清理已完成，各自证据与范围如下。

AH-572、AH-573、AH-576、AH-581、AH-582 与父 AH-561 继续 In Progress。当前 flash-free 服务可用而任务未达标，不满足规格规定的 worker fallback 条件；没有另换模型或重复采样隐藏失败。日用配置未激活候选，实际切换仍以全部必要 Gate 通过为前提，此文件不表示 AH-561 已全部通过。

失败结果与修正后结果独立保留。HTTP 200、编译成功、固定 provider、直接调用投影函数或旧版通过，均不代替相应的真实入口验收。

## 产品行为

正式 Notion 请求复用项目的 Effect 4.0.5 HTTP 引擎与请求 scheduler，认证来自项目配置或 NOTION_API_TOKEN。正式链不调用官方 ntn，不尝试其登录、Keychain 或旧协议 fallback。未知写入按原 operation 保留与核对；独立 accept-current 决定可以确认当前内容，但不会把原 unknown 改写为 applied。

普通 Skill 与 Router 都支持人类可读的 Members、Requires 和原生 Notion 链接。CLI 将链接编译为包含稳定 owner、File ID、scope 和 snapshot 的精确引用。文件身份的边界是 (scope, owner Skill ID, File ID)，不同 owner 可以使用相同 File ID，同一 owner 的冲突必须拒绝。

prepare use 准备明确选择的根及递归 Requires，inspect 只观察根。Members 和普通引用保持候选目录语义，不自动变成 Required。Pi 的原生 read、美元选择、原生 Skill 命令使用同一选择、准备、投递与取消合同。原生 skill_search 只发现 metadata，skill_prepare 根据精确引用准备完整必要闭包。

会话锁记录实际选择的版本向量；未选择的 Member 和预取结果不提前绑定。固定图可显式保留到 Records，在另一台空机器恢复准确历史。完整 manifest、所需文件已物化、正文已投递三个状态分别报告。完整 export 始终拿齐并验证全部文件。

预算预取默认 0，复用同一准备与调度器，不能自动注入、派发 provider、改变会话版本或执行内容中的操作。

## 冻结产物

| 产物 | 路径或身份 |
| --- | --- |
| CLI9 源提交 | dd801c17026d9a289c4359c7bfbbf3286cf1ae9d |
| CLI9 archive SHA-256 | 19168be88a6c62b14a48710030cfd940ba241614a53971593d258be7815cc73f |
| CLI9 安装 JS SHA-256 | 8c034f9d0808b7d09a014ed8affdfbe89946d7de498f143a13ab5eacac65f869 |
| Broker8 源提交 | 1809fd7106b2d376e1642b3a29d12c6ee1f07b0a |
| Broker8 archive SHA-256 | bf2edda0f60f78244214dd72d4b255ef829b6345e05bddd58e95fcb86b2b664a |
| Broker8 Pi entry SHA-256 | 1e7f46453945f0a80b3a5b0d8e70de6760cf20e6f280274b0a37c366e1eab5c5 |
| Broker8 随包 CLI SHA-256 | 86beaec4c379c299517b451388d28ef09e014b0b4fc5c45db804d09450683c18 |
| Broker8 host-skills SHA-256 | 1233969300a8050de4be27d886f670d688d0ba84929da8df71345ae4036e8377 |
| H3 历史模型验收脚本集合 SHA-256 | 565d414f70bcfb1742ba94a04efb7f4dad218fc8a3f9324f85eb7560c905d4b6 |
| H4 历史模型验收脚本集合 SHA-256 | a58708b78cb9c4f4029f9c22b81478eccfd0a506828d4a24b9bbc181d4915ddd |
| H5 历史模型验收脚本集合 SHA-256 | 83576bdd32d0e1c3419da8665adf035a0e3b456091dd6e21c46f268ff3532f19 |
| H6 历史模型验收脚本集合 SHA-256 | 293c5d2718f326b43143e68a9623413d31386eae7413546e4713fcabd491726d |
| H7 当前模型验收脚本集合 SHA-256 | b43eeaef8f76b5bf5c97eab4fd10de3367321d1fa5282dde423119e1958910f2 |

CLI8 相对 CLI7 只有 docs/usage.md 变化，JS 字节相同；CLI9 相对 CLI8 的 30 个包文件只有 dist/ntn-skills.js 变化，修正目录发现对共享管理表的误分类。Broker5→6 的 62 个包文件只有 src/host-skills.ts 变化，修正树外路径别名；Broker6→7 只有 dist/ntn-skills.mjs 变化，带入 CLI9；Broker7→8 只有 src/index.ts 与 src/view-prompt.ts 变化，统一原生读取的目录与指导。旧包证据保留自己的身份，不能把历史 Mini8 或旧 TUI 记录改称在最终包上重跑。H3 仅调整观察和验收脚本，未改变产品包。

最终两个包另装到新的日用候选目录，并与各自 tar 成员逐文件核对：CLI 30 个文件、Broker 62 个文件全部相同。此时未修改 Pi settings 或 CLI shim。后续实际切换与新会话结果另记，候选安装不冒充已启用。

产物证据均在 Pro：

- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng02-installed-rfbmoV/manifest.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v7-_kp72c6m/final-package.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/broker-v8-z6qqvihs/final-package.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/no-ntn-audit/final-cli9-broker7-audit.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/no-ntn-audit/final-cli9-broker8-audit.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/daily-cli9-prepare-KaG4qp/result.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21/daily-broker7-prepare-hdi7yg/result.json

## 验证层次与结果

| 层次 | 已观察结果 | 限制 |
| --- | --- | --- |
| CLI9 全量 | 3208 pass / 0 fail，26,736 assertions，229 files，588.61 秒；类型检查、公共包和离线 consumer 合同检查通过 | 完整跑完，未将早先 300 秒超时当作通过；CLI8 的 3203 项另存历史 |
| Broker7 包 | 88 pass / 5 skip / 0 fail，254 assertions，类型检查通过 | 5 项安装 CLI 适配另在真实 Node SQLite 上执行，5/5、59 assertions 全通过；此前 1 fail 的包检查保留 |
| Broker8 包 | 89 pass / 5 skip / 0 fail，259 assertions，类型检查通过 | 新增目录引用回归；两处独立安装的 62 个 tar 成员全部相同。五项适配证据保留 Broker7 身份，对应 host-skills 与 embedded CLI 字节未变 |
| 直连读写 | 真实 Notion owned 创建、正文/字段写、精确回读、52 字节二进制附件、原操作恢复 | 不推断任意生产写入成功；unknown 保留 |
| 关系与链接 | 真实 Notion UI 普通链接、mention、Link to page；精确 File ID 与旧 pin | UI、API 和模型消费分别取证 |
| Pi 图路径 | 独立安装 Pi、受控 provider，16 个图场景通过；Broker8/CLI9 的 H4 实际 SDK 通过，9 次 payload/wire SHA 匹配，56,423 B root 完整投递；H5 SDK 10 对匹配，index 主文到相对资源完整读取 | 受控 provider 不称真实模型；H5 80 项组合回归通过，仍保留每个阶段的产品与 harness 身份 |
| Pi 多节点 A/B | CLI9/Broker7 阶段的实际 Pi、公开 CLI、Node SQLite、受控 HTTPS 共 7 阶段全部通过 | root/Required A、远端 B 后旧会话 A、新会话 B、重启旧 A、首次 optional B、刷新全 B、重启全 B；全部 owned PID 已不存在，但 EOF 后一条 background list 的 close 回执缺失，不能补造退出码 |
| Pi 终端 | 实际 Tab 选择、提交前零正文、Required 齐备、预算提示、Escape 子进程退出、同会话重试 | RPC abort、new_session、EOF 各自单列，不能互相代替 |
| 请求优化 | 同 fixture、基线/优化每条件 n=3；独立 Node HTTPS/SQLite 公共 CLI 61 assertions | 不从受控时间推断生产时延或 p95 |
| 物理双机 | Pro A→当前 B；Mini 自身认证和四个空目录恢复 3 节点 6 文件 A，CLI8 阶段全部 hash/版本向量一致 | 只复制 npm 包，没有复制 token、SQLite 或导出内容 |
| 真实模型 A/B | 最新 A 为 H6 NFvEez，独立纠正观察标签后仍 READ_MISSING；最新 B 为 H7 FUJa9C，原结果 READ_MISSING。各有成功 final，但未具备完整目标资源消费和可执行 Skill | 两条矩阵各 1 个 cold 失败、4 个后续样本未运行；任务失败不满足 worker 的服务不可用条件，也不满足日用激活门禁 |
| 原单 Skill | H6 初始 10 pass / 1 fail；H7 targeted 1/1 pass；从 H6 真实自主读取基线续接的 updated 6/6 pass | 17 项要求分别有通过证据，原 H6 失败保持；不把跨阶段覆盖伪称为某一次 17/17 运行 |

原单 Skill 的第一份新模型失败记录是 LZOyAZ，涉及漏关全局 Skill 和 macOS 路径别名。修正后 X8Dfhw 初始矩阵 10/11 通过，cold-native-command 中模型自行猜错引用，仍记录失败。两份均不能写为 15/15 通过。

新 Gate A 首份正式冷样本是 graph-model-A-SQ1pSW，位于 ng14/final-package。实际 provider 收到完整 Router 20,872 字节和 56 个 Members 链接；模型未读任何 Member，最终任务断言失败。验收驱动也隐藏了产品实际提供的 skill_search/skill_prepare，后续恢复了产品三工具面。TASK v2、私有 oracle、目标身份与内容完整性要求不变，原样本不覆盖、不归类为模型不可用。

恢复正常三工具面后的实际 SDK 回归发现产品路径问题：macOS 的 /tmp 与 /private/tmp 指向相同位置，但尚未物化资源未被 Broker 接管。提交 528753acda5922ac9813f8799e7d745d251493ea 只解析已验证树以外的路径别名，保留树内路径与逐级符号链接检查。新增三项回归在修复前均失败，修复后相关测试 21 pass / 112 assertions，类型检查通过；未声明文件、越界路径和树内符号链接仍拒绝。Broker6 和 Broker7 均已通过实际安装 SDK；Broker8 保留同一份 host-skills 字节。CLI8 与 Mini 的历史恢复证据保留原版本身份。

Broker6 实际 SDK 同病例通过于 ng14/harness-v2/graph-observer-http-M4pV6s/result.json。该阶段实际多节点会话记录 graph-session-CkKuDu/manifest.json（SHA-256 87c87e8532feae47f80645ad862c150263bfd3271438b9111e6b81add3587c9f）包含 4 个实际 Pi 进程、44 个 consumer wrapper/CLI 的退出回执及 93 条 consumer HTTP。

CLI9/Broker7 阶段的多节点记录为 /Users/yoyo/Library/Logs/pi-context-broker/AH-561-20261103/ng15/graph-session-5DdQKn/manifest.json（SHA-256 9fe6078b04d86c62b0e70cef68953d5209c830b5013c6c46b76edbca4950bba5）。公开 CLI 自行建立缓存，七阶段的正文、版本向量和 provider 投递逐项匹配；没有私写 SQLite、会话状态或版本绑定。4 个实际 Pi、43 个 consumer CLI、12 个 oracle CLI；30 条测量命令对应 90 次 HTTP，全服务合计 163 次请求、14 次正文、零错误。consumer 有 43 次 starts、42 次完整 responses，EOF 后一条 list --max-age 0 的 wrapper/CLI close 没有留存；独立进程核验确认所有 owned PID 已不存在。功能证据与这条进程观测缺口分开报告。

随后自有单 Skill 的无数据库参数刷新暴露目录发现错误：Records 表的历史 References/Description 字段误中 legacy 内容表规则，65 次成功 HTTP、206,985,388 响应字节后在 Kind 解析失败，正文和写入均为 0。完整失败保留于 ng20/owned-single-ANVtV1/v6-current-b.stdout。提交 dd801c1 按已验证共享库描述中的 Files/Records/Sources 精确身份排除管理表，不放宽真正内容表的类型校验。58 项相关回归、271 assertions 通过；CLI9 用同一条未加 --database 的命令完成真实当前 B 读取，29 次 HTTP（27 metadata、2 body）、1,245,827 B、零写入/provider，并匹配原 scope、snapshot 与正文 hash。Broker7 带入这份 CLI，日用尚未切换。

H2 的两条最终包模型样本分别保留：A graph-model-A-eXJd7p 有 20 次真实 provider 请求、46 次工具调用，最终因模型输入/任务失败和 300 秒超时未过；B graph-model-B-O04HQP 的八次 before_provider_request hook 因整篇正文正则过大失败，虽然有八次 HTTP 200，但没有完整 payload/wire 证据，分类为 harness-invalid。B 的观察故障不能解释 A 的真实失败，也不能从 session 事后补造缺失的 wire 证明。

H3 将整篇正文正则替换为精确 literal 扫描，观察异常显式登记，并要求 transport 与已验证 payload 对应。冻结回执为 ng14/harness-v3/freeze.json，17 项回归与该阶段产品包的大正文 SDK 通过。相同 TASK、oracle、模型与 300 秒预算下的新冷样本保存在 ng14/final-h3：A graph-model-A-8Plbzx 报 EAGER_MEMBERS，B graph-model-B-TPJVgb 报 CANDIDATE_IDENTITY；二者 availabilityFailure=false，完整生成文件数均为 0，仅保留原方案文字。暖新进程与续接样本未运行，不能将设计的五个样本写为五次观测；下文保留只读诊断和独立派生结果。

H3 完整只读诊断保存在 ng14/final-h3/diagnosis-readonly-vbwed_vc/diagnosis.json（SHA-256 aa052bbb553f627a9ec0975323f1687c1526ef9592520a7ee0b572a4ba993a90）。A 的七个 retained chunk 缺少来源 manifest 归属，原值是 null，不能据此断言提前读未选择成员，也不能补成 0。模型确实主动准备了目标，6,837 B 主文及正确 hash 到达九次 provider，但 README 和两个备选 feature-map 资源全部没有读取，方案没有文件围栏。B 的 55 项目录确实包含目标稳定 ref，原评估错误要求候选字符串已带 pin/file_id；观察器还拒绝了实际提供的 root/Required 原生路径。B 没有目标消费，所生成文件草稿本身也不完整。这些观察器问题与真实任务缺口分别保留，均不触发模型可用性 fallback。

原单 Skill 的 Broker7/CLI9 新初始阶段 pi-cache-evidence-wJfEnl 实际为 1 pass、2 fail、8 未运行。cold-dollar 完整主文 438 B 和资源 201 B 各一份，13 次 Notion 请求、2 次正文、零写入；自主 read 猜错 URI，原生命令场景后来读到了完整内容，但也有已广告路径被观察器误拦。实际系统文本与 provider sourceTextHashes 一致，显示目录只给 location，通用指导却只要求 skill://，且 read-only 场景收到未暴露 prepare 的通用要求。

提交 1809fd7 为 Notion 目录条目同时提供原 location 和精确稳定 ref，统一指导复制任一广告值；只有 read 的宿主可以检查入口与资源，工作流 use 仍由明确宿主入口或可用 prepare 准备依赖。该修复适用于所有 Skill，不含目标名称、答案、特定 ref 或模型提示特例。Broker8 的两处独立安装和 89 项包测试通过；新的真实矩阵等待完整观察器修正后启动，未把提示修复等同于模型已通过。

H4 保留产品原生工具参数，补齐实际广告路径、HOME 展开、未固定候选身份与独立 retained source 归属观察。Pi 自己在 system 中广告的已安装官方帮助文档按独立 host-help 角色记录，不计作 Notion Skill；任意外部文件、私有 oracle、本地 Pstack/Matt 与 shell 仍拒绝。冻结回执 ng14/harness-v4/freeze.json 的 SHA-256 为 3728fe47eee9d1cdd71d5f88f88e49c8b9ffc04109248add3f222ec46e5b31f1。SDK graph-observer-http-ejGbJE 使用同一 Broker8 日用候选，9 次 provider/wire 逐次匹配，完整 56,423 B root 每次一份，115 B Required 经原样 ~/ 路径完整读取，4,080 B 官方帮助与 70 B alias 资源分别记账。前两次受控失败 uGldin、66q5vw 保留；56 KB 文件超过默认 50 KiB 单次 read 限制的截断结果没有计为完整。

独立来源证明只在 consumer 退出后，经既有 Effect 引擎按已观察 bundle ID 查询 metadata。9 份 source manifest、12 个 chunk 经 canonical envelope/payload SHA、同库与唯一 owner 核对，新增成本为 11 metadata、0 body/write/provider；不向模型补正文或资源。H3 原样本的离线派生记录 ng14/harness-v4/offline-h3-Fe0Sip/result.json 将 A 的 7 个、B 的 2 个未知 retained 请求唯一归属，未选 Member 的提前正文读取为 0；两条路线仍为 READ_MISSING，原结果未改。实际 poteto source ZIP 为 122,927 B、46 文件、4 chunks；读取 ZIP 不等于模型消费每个资源。

Broker8/H4 的 pi-cache-evidence-y6izS4 实际执行三场：cold-dollar 与 cold-native-command 通过，自主 native read 失败，其依赖的 8 场跳过，updated 6 场未运行。总计 7 次 provider HTTP 200、84 次 Notion HTTP、6 次正文、0 写入、0 observer-error，24 个 CLI starts 均有 metrics；availabilityFailure=false。失败轨迹 seq23 已完整读到 438 B 主文及其 references/checklist.md 链接，seq29 的同 host-index 资源路径被 Graph guard 误拦。只读回执 ng14/harness-v4/host-index-resource-readonly-6s0pddit/result.json（SHA-256 87fdbdd9abe6a2ec0e5655161eb9605dfbbcf6da485a599aefb6447f690b6d02）核对同 scope/owner/B pin/main SHA/manifest_id 和精确 201 B 资源；产品本身支持该别名。H5 仅补成功完整主文读取后、正文实际发现且 manifest 精确声明的资源映射，不放宽任意兄弟路径。

Broker8 的 A/B 选择预检 graph-selection-inxcZn 与 graph-selection-VufNEJ 各 14 次 metadata，正文、provider 均为 0，进程全部关闭；独立预检根不能复用为正式冷 consumer。H4 未启动 A/B 模型样本，预检可按相同产品 hash 供 H5 使用，不能冒充 H5 模型已通过。

H5 新增两项 exact host-index 回归，修复前 1 fail/1 pass，修复后 2/2，组合共 80/80。实际 Broker8 SDK graph-observer-http-g5KmVF 有 10 对 provider/wire 哈希，广告 index 主文 441 B 完整读取后，精确读取同目录 77 B 资源；原生工具、Required 去重、独立帮助、Optional、外部路径与 shell 拒绝均保留。冻结回执 ng14/harness-v5/freeze.json 的 SHA-256 为 9057024b67af5540810739218c91c6c9d686cc0b262057804f87fcb13f77e226。首轮受控 CAjyRg 失败保留：runner 曾错误要求重复主文在 provider 工具文本继续完整出现，最终按原完整工具回执与 provider 已有正文分别核对，不取消正文去重。

正式 H5 启动回执 ng14/final-h5-config-MXrtFc/launch.json（SHA-256 881dc5fc1cb3714c4f90941343a536715bf8d47ae6cdfc9a26c0e2f99940c730）固定同一 TASK、oracle、owned 项目、flash-free 模型与时间预算。A 矩阵 graph-matrix-A-xvXGEL、B 矩阵 graph-matrix-B-cp5WWT 和原单 Skill pi-cache-evidence-DmSpCQ 各用独立新根，原失败全部保留。实际完成状态和生成规程执行结果另据各最终回执登记。

恢复连接后取回的 H5 原结果均保持不变。A graph-model-A-G3kOyT 与 B graph-model-B-ti3uRk 的原顶层错误为 OBSERVATION_INCOMPLETE，sample 分别记录 300000 ms prompt timeout；A 有 6 次、B 有 24 次 provider HTTP 200，后续各 4 个样本未运行，没有完整生成产物或规程执行。A 已自主选中目标并完整读到 6,837 B 主文、README 2,761 B、create-note 3,374 B、search 4,023 B，三份资源到达最后 provider。其较早三次同 owner/path 引用省略可选 snapshot/file_id，产品已按已发现的 manifest 与会话 pin 完成精确读取，Graph observer 却只因输入 FileID 缺省而误拦；这处接缝由 H6 单独修复。B 曾混接 owner 目录与另一 snapshot，并猜测无效路径，拒绝合理；后来的正确目标 prepare 因无响应而未完成。独立诊断 ng20/h5-gate-diagnosis/diagnosis.json 的 SHA-256 为 4af6fbf11d33ccaae569691b6920b28c59687b29671176a06c3b487b1ef20741，70 份原文件前后 hash 不变。

Pro 电源日志证实 2026-11-03 19:45 起发生合盖睡眠，期间有短暂唤醒，至约 20:17 用户唤醒（UTC+8）。这与 provider 停顿和两个补充 collector 的约 1,075 秒无响应吻合。两份 collector 各只有 2 次无 HTTP status 的 metadata 尝试、0 个 source records，最终 admission 超过等待预算，不能将其未知归属写成提前读 Member，也不能写成 0。原 availabilityFailure=false 保留，环境中断不构成 worker fallback 授权；下一轮以随 utility 生命周期释放的 caffeinate -i 防空闲休眠，并保持原模型、TASK、预算和失败账本。

H5 旧单 Skill 的自主 read 失败发生在睡眠前：模型两次传裸 references/checklist.md，忽略 system 已广告的绝对 Skill 目录和相对资源解析指导，未读到资源。dollar 在睡眠前完整读取主文/资源并成功；native-command 正确资源已读取，随后 provider headers 200 与合盖睡眠重叠，没有成功 final。原 runner 的 8 个依赖场景和 updated 6 场不补算；新 cohort 仍须先建立自己的 cold-autonomous baseline。独立回执 ng20/h5-legacy-diagnosis/diagnosis.json（SHA-256 d15d49f72657d4595f6fdabaf5c976f83edb26d33222ded1d9bc0a3524aba761）核对 84 次 Notion HTTP 全 200（78 metadata/6 body/0 write）、7 次 provider headers、49 个 owned PID 均不存在；57 份原文件未变。电源原记录 power-window.txt 的 SHA-256 为 4044a293e8051359d9e00bede700717e4ab95fe269a077dc8cc326ca8de8409b。

H5 恢复连接后的独立补证位于 ng14/h5-supplementary-source-proof-BJqcCf。既有 collector 核对 9 个 source records、9 个 bundles、12 个唯一 chunks，新增 11 次 metadata、0 body/write/provider，请求 8,024 B、响应 56,968 B，耗时 7,452.536 ms。原 A/B 的 68 项文件和目录成员前后相同。未加补证的 graphTrace 重建与两个原 trace deep-equal；补证后的独立派生仅改变 HTTP 归属字段，A 的 18/18 正文请求、B 的 6/6 正文请求均可唯一归属，未选择成员的提前正文读取为 0。其他原字段、A 的 3 次和 B 的 18 次 blocked 输入均不变，派生仍分别失败于 MODEL_FINAL 与 READ_MISSING。原顶层 OBSERVATION_INCOMPLETE 和两个 300000 ms timeout 没有改写；原 observer 虽有 assistant-final 事件，均 success=false、stopReason=toolUse，不能称成功 final。补证 result SHA-256 为 78b08005a06fab8145fc1cd02a039d0b5874adf15ae37fbae51288295b33fd1f，derivation SHA-256 为 ffa2801e61c9c73b5d27daf1666bc36574569017f01adbc5863a6d810b351f5e。

H6 只调整观察器的已发现引用匹配。无 FileID 的资源必须解析到同 owner、当前 manifest path 的唯一已验证身份；显式 FileID 保留实际已发现的旧显示路径别名，任意未公布路径、显式 pin/FileID 冲突与 scope 歧义仍拒绝。完整 expected 身份在调用时固定，返回内容不能借相同正文换绑 FileID。旧 H5 源上的新增回归先记录 7 fail/2 pass，修复后相关组合 88/88。Broker8/embedded CLI9 的两个实际 SDK 分别验证稳定 FileID 旧路径与省略可选字段的 canonical resource ref，每次 10 对 provider/wire、完整 70 B 资源、441 B host-index 主文和 77 B 相对资源，14/14 source close 与 Pi observedExit。冻结文件 ng14/harness-v6/freeze.json 的 SHA-256 为 b4e28f3bdc6720d87ed155dbb28ebec18663263ad14f954b9ed297f1ee85d48c，SDK 为 graph-observer-http-NGwP8n 与 graph-observer-http-Hgm7jA；这些受控 provider 结果不冒充真实模型通过。

H6 真实运行保持 CLI9/Broker8、TASK、oracle、owned 项目、flash-free 与预算不变，每个 utility 用 caffeinate -i 防空闲睡眠。原启动信息另存 ng14/final-h6-config-a7VrBa/launch.json（SHA-256 6e0df95d98cab1d7336af57278fc68ba306fbc875c7187a53278498331e19f47）。A graph-model-A-NFvEez 原报 EAGER_MEMBERS，B graph-model-B-xoGFQs 原报 READ_MISSING，矩阵各余四项未运行；单 Skill pi-cache-evidence-HEjb03 初始 10/11 通过，仅 cold-native-command 因已公布的原生主文路径被 observer 拒绝而失败。原结果、独立诊断与修正后的必要验证分别登记，不将观察标签纠正等同于实际资源消费或完整规程生成。

H6 A 的独立因果链复核位于 ng20/h6-a-eager-review-JuV3Ra。11 次原 EAGER 计数分别来自 target 5 次、technical-writing 2 次、maintain-verification-skill 2 次和 recall 2 次；每项均有同 callID、模型原参数、scoped prepare/read、HTTP 与 retained proof 的完整链。Pi 在 source 请求前已经收到模型的真实读取调用，但 Broker 的 prepareRead 先运行，后注册的 observer 才记录 admission。独立派生仅将这 11 个 beforeSelection 与合计改为 0，其余 trace 不变，原 evaluator 仍报 READ_MISSING。目标主文有 1 次 native read、6 次 provider 上下文，三份所需资源均为 0。9 次 provider transport 全部 200，成功 stop final 为 22,070 B，运行窗没有新的 Sleep/Wake/DarkWake；availabilityFailure=false。原文本确有 4 个文件标题以及 verify.mjs/run.sh 代码，原 collector 记录 files=0、plan-only，没有 SKILL.md，部分 Markdown 围栏有同长度嵌套歧义，不能将其称为完整 Skill 或已执行规程。52 项原文件与目录成员不变；diagnosis SHA-256 为 00d1f71e0f71eb2e14a06695190db4cd886a742f7096ab62c5812205d007f90b，派生 trace 为 ad787a08cf4c29ac420eb0fc6c0d1ef57e1301d8951b1213852ae69423bd544f。

H6 B 唯一 blocked 调用是对已发现 poteto/unslop 的裸 owner URI 执行 skill_prepare。产品的 parseNativeReference 与 nativeResourcePath 正式支持省略主路径，旧 observer 却另用更窄语法而误拦；H6 native-command 的失败则来自真实 Pi `<skill location="...">` 主文路径没有登记。两个接缝的独立交叉核对位于 ng20/h6-gate-diagnosis/b-and-native-location.json，SHA-256 为 4d5e3e9d1e0d672eb1473f25dea6caafb6d3264d07ba70a50227b3bc501b6e7e。B 当时有 22,213 B 成功 final、8 组文件标题，但没有目标与资源消费或 SKILL.md；原失败不改判。

H7 复用实际安装 Broker8 的公开 parser，按完整 provider/delivery/manifest/public-read 身份登记 native wrapper，并把真实收到的模型 authored call 与其后 allowed admission、完整结果匹配，使用正确选择时点。资源身份与发现边界、真正 eager read 拒绝都保留。收集器另支持实际输出的中文“文件路径”标签和精确 owned root 内的绝对路径，只规范存放路径，正文 bytes/SHA/sourceSpan 原样保留；外部、同前缀兄弟目录、点段、双斜线、围栏歧义与不完整 Skill 仍拒绝。原 94 项与两项格式回归最终 96/96；两个实际 SDK 各 10 对 provider/wire，source 15/15 和 14/14 关闭，Pi 均 observedExit。SDK 原 aggregate 为 c0165eb3923b887a1dd62fa85b11d3794363f0216532992cd79b4cf14074729d；最终唯一 helper 差异的 createOwnedGraphProject/inspectOwnedGraphProject 逐字未变，格式修复由新增回归证明，没有把旧 SDK 冒充为新 aggregate 重跑。freeze.json SHA-256 为 92c369b047339eb1388cb7081890212e539616d074dada0fdb90427849155cd4，两项独立代码审查均无阻断项。

H7 仅补跑受误拦影响的 B 与单 Skill 病例，没有再采 A。B graph-model-B-FUJa9C 仍为 READ_MISSING：9 次真实 provider 全 200、observer-error=0、成功 final 23,643 B。模型首轮把五个已提供绝对路径的开头“/”遗漏，形成 cwd 内的重复嵌套相对路径，拒绝合理；另一次把 Pi docs 目录当文件读取。之后完整读取 12 份帮助与执行一次空搜索，但没有 skill_prepare、目标/资源读取或完整项目文件读取。Consumer 的 27 次 metadata、6 次 body 全部 200；六次正文均归属于 root/Required，提前成员正文读取为 0、归属完整。另一次补证为 4 metadata、0 body/write/provider。只提取出 acceptance/README.md 和 acceptance/results.md 两个文件，artifactStatus=incomplete-generated-files，skillFiles 为空；README 引用未提供的 ./run.sh，results 内 PASS 是模板文字，没有执行证据。原文 sourceSpan 匹配且 fileExtractionIssues 为空，没有完整 Skill，未执行。矩阵 graph-matrix-B-sOq1iM 为 1 个 cold 失败、4 个 notRun；服务可用不满足 worker fallback 条件。8/8 source 已关闭，Pi、collector、outer launcher 均 observedExit，十九个已记录 PID 最后核对均不存在。独立诊断 ng20/h7-b-diagnosis-vmBDYI/diagnosis.json 的 SHA-256 为 293c36c6f0bf188ac4a0ae79a51f43b84391032b2efd91636f1c6c27d8e1c292；41 份原证据 SHA 不变。

单 Skill 的 H7 targeted pi-cache-evidence-Y9H1QF 为 1/1 通过，2 次 provider、28 次 Notion 请求（26 metadata、2 body）全部 200、0 write；1 个 Pi 与 8 组 public command 关闭，17 个 PID 均不存在。独立 broker8-h7-initial-coverage.json 将原 H6 的 10 个通过病例与这 1 个 targeted 病例对应到原 11 项需求，SHA-256 为 05248539256372d63569b4259eb26badf30d1a0f6994c6936d997257cdeb2c6b；HEjb03 原 manifest 仍保持 10/1，未伪称新的一次 11/11。

主文与资源随后各自取得新鲜基线，经过公开单文件 dry-plan、唯一写入和完整独立回读，将远端从 B 恢复为 A；没有 aggregate 重放或 unknown。恢复后 snapshot 为 s_0deb9cf838ab8b7a25e10d09ba5154191dbd10c426c5f1174932342d50018700，主文 438 B、资源 201 B 的 SHA 与原 A 内容相同。updated pi-cache-evidence-tTddSZ 从 HEjb03 真正 cold-autonomous-native 的 B 会话续接，六项全部通过：旧会话在编辑后仍固定 B，刷新后新会话、暖新进程、续接、Broker 暖而 CLI 空和短 TTL 重验均读取 A。既有 case 名中的后缀 b 表示模板的 after 阶段，本次实际 after 内容为 A，不改名或混淆版本。全部成功 final 与实际 provider 的完整主文/资源四个标记一致，正文每份唯一；六个 Pi 都有退出回执。manifest SHA-256 为 a798e564c922c3330da79c4028b4651ccb5f3c1154a0394392997f8d7c37eb13。这些分层证据覆盖原 15 例与新增 2 例，A/B 图模型门禁仍分别未过。

updated 整个阶段记录 116 次 Notion 请求（112 metadata、4 body、0 write）及 10 次真实 provider 请求，全部 HTTP 200；六个 Pi、48 组 public wrapper/CLI 均关闭，包含 runner 与 source 的 151 个记录 PID 最后核对均不存在。原 H6 的 114 项、targeted 的 18 项证据按不变字节或明确允许的 append 前缀核验；9 个冻结 harness 文件和 48 个安装运行文件仍匹配。17 项覆盖总回执 ng20/owned-single-final-ybVxon/broker8-h7-terminal-receipt.json 的 SHA-256 为 9a5168db218dcd5f448e770523693054793bed89c55fd3e3afdf97cd2d11ec55。

## 请求成本

下表每条件基线/优化各 n=3，三个样本请求数一致。冷正文数量仍为 4/101，warm 与 metadata 重验的 current body 为 0，图锁、快照与文件绑定一致。

该表计数来自受控 EffectService；独立公共 CLI 的 HTTPS wire ledger 另行验证，二者不混称同一种网络测量。

| 固定拓扑 | cold | warm | metadata 重验 |
| --- | --- | --- | --- |
| 菱形 | 32 → 16 | 1 → 1 | 25 → 10 |
| 101 节点 | 810 → 115 | 1 → 1 | 509 → 12 |

原 fixture 曾将 leaf-1 前缀匹配到 leaf-10；原始失败保留。正式比较使用符合生产 SQLite 目录语义的同一 fixture。旧 warm 64→1、527 等数值不作为优化成果。

真实 Notion 三节点 B 图的独立只读观测：

| 条件 | metadata | current body | retained body | write/provider |
| --- | --- | --- | --- | --- |
| cold | 18 | 6 | 2 | 0 / 0 |
| warm | 1 | 0 | 0 | 0 / 0 |
| max-age 重验 | 17 | 0 | 2 | 0 / 0 |

重验中的两个 retained 请求对应原 unknown 写与 accept-current 决定的历史证明。最初验证器错误要求 retained 也为零，其失败保留；修正后的核对只读取原结果，没有重新采样隐藏失败。

预算预取的真实小图 on/off 各 n=1：

| 测量（manifest 另列） | 关闭 | 开启 |
| --- | --- | --- |
| 前台等待 | 4832.323 ms | 3999.213 ms |
| 预取耗时 | 0 | 5782.582 ms |
| 预取 + 前台总计 | 4832.323 ms | 9781.795 ms |
| 请求数 | 9 | 13 |
| 响应字节 | 37,730 | 52,821 |

两组 manifest 各为 11 metadata + 1 retained，成本独立保留。开启组只预取一个 root，随后使用同一 A pin；未用预取正文的字节为 0。结果不支持默认开启或通用性能收益，预算继续为 0。

## 按需物化的大、小资源成本

现有独立公共 CLI、core 二进制集成与真实 Mini 各自覆盖入口、指定资源、完整导出。下表是实际内容字节，不等同于网络响应字节。

| 证据层 | 入口后累计内容 | 指定资源后累计内容 | 完整导出内容 |
| --- | --- | --- | --- |
| 独立公共 CLI + 受控 HTTPS | 91 B | 39,291 B | 39,308 B |
| core 固定二进制集成 | 67 B | 96,067 B | 176,089 B |
| 物理 Mini + 真实 Notion + CLI8 | 420 B | 516 B | 1,106 B |

公开 CLI 的 39,200 B 指定资源只取 32,768 + 6,432 B 两块，完整 export 再补另一个 17 B 文件。core 成功用例为 96,000 B 与 80,000 B 二进制；另一个 90,000 B 缺块恢复用例会保留已验证的 65,536 B，只补最后 24,464 B，再验证完整输出。

Mini 的共享缓存序列实际为 41 HTTP、request 2,877 B / response 190,329 B；其中五次 chunk 查询获取六个文件。当前正文、write、provider 均为 0。小文件的 metadata/Records 包装成本不能忽略。公开 CLI 未留存的后续 wire 字节为 null，core 的同内容块复用只标布局推导，不伪装成 wire 测量。

完整 manifest 保留 65,536 B Records envelope 上限，超限明确失败而不截断；首次原生 current 观察也不借旧 hash 跳过验证。ZIP 需整包时仍保留整包成本，没有增加随机读取能力。这些样本不支持通用传输或尾延迟收益。

完整成本、chunk 与原证据 SHA 位于 /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng18/lazy-materialization-costs/receipt.json（SHA-256 a02ed3a034a1ce4af168612a5a09f5e2f0316db22d8f9cd1a7315b517628e844）。

## Pstack 生产变更与保护

核对指定来源提交中的 root + 56 个已绑定成员，共 57 个记录。生产 Router Members 为 56；poteto-mode 保持普通 Skill，Members 为 55、Requires 为 unslop；architect 的 Requires 为 arena。目标叶子未被改为 Required。

四份主文只作必要的引用治理：18 个目标映射、22 处链接。57 个记录的来源、Origin、Selected Version、Kind、Enabled 与稳定身份逐项核对，四表结构保持。最新上游另外两个未绑定成员未在本次擅自导入。

architect 一次正文 PATCH 的原 operation 为 unknown。公开 accept-current 使用原计划、实际事件与当前候选 hash 创建独立的接受决定；原 unknown 仍然保留，没有重发 PATCH 或伪造 applied。

生产治理证据：

- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-result.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/final-census-WFsuRv/result.json
- /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng09/apply-01/architect-body-result.json

### 最终生产复查

清理后完整分页取得 Skills 300 行、Files 818 行、Sources 59 行。公开 catalog 为 298 项，差异恰为原本 Enabled=false 的 Topic Map Governance 与 Resource Tag Governance，不是分页缺失；Records 只核对表结构，未扫描总数。57 个指定 Pstack 页的稳定身份、Origin、Selected Version、Kind、Enabled、Main File ID 与用户字段均匹配，root Members 56、poteto Members 55，所有 Members/Requires 完整。

原始字段对比出现 48 项 Files 附件临时签名和 expiry 轮换；独立离线核对每个附件的名称、类型、HTTPS origin/path 及全部非签名参数相同，未发现未解释的字段变化。没有下载附件或将 metadata 核对当作新的正文 hash 证明。默认 View b6c7bb99-ae7c-4be7-b98b-5703b09e8913 的实际 native query 与目录均为 74 项。当前共有 6 个 View；A/B 两个复现 View 保留，单 Skill 的第三 View 已不存在；两个已归档 owned 页不在活动 Skills/Files 清单。

实际 44 次 HTTP 全 200（首阶段 30、窄续采 14），请求 1,422 B、响应 7,771,834 B，无未知字节。原始计数 42 metadata + 2 unclassified_body 保留；两个被通用计数器归入 body 的响应都只有完整 relation property_item IDs，current/retained 正文、写入与模型请求均为 0。首轮因此中断的 incomplete 和续采初始 differences-or-incomplete-proof 结果未修改，最终通过是独立语义核对，不是把原计数改成零。

表清单与 schema 在 2026-11-03 22:13:35–22:14:08（UTC+8）取得，剩余关系、View 和两页状态在 22:24:14–22:24:23（UTC+8）取得。续采复用原 metadata 原件，未重扫三表或重取 catalog；这些是分阶段观察，不声称一次原子快照或全面 ACL 枚举。最终结论 ng21/final-census-conclusion-JkSnne/result.json 的 SHA-256 为 7f55c7120a7b75aa9f8bb5291fec26eac5316006e5f68dbb66a28dec6cfcaf39。

## 当前 Notion 文档发布

既有文档父页 40c5636c-236e-80e1-b440-c6d4b8310b72 下六个精确页面均完成当前使用说明与本轮证据更新。页身份、parent 和其余 properties 保持；最终独立 CLI9 metadata/body 读回无截断、无 unknown blocks。

| 文档 | 最终正文 bytes | 最终正文 SHA-256 |
| --- | ---: | --- |
| [00 入口](https://app.notion.com/p/00-40c5636c236e81969ba8f77eb650d171) | 3713 | 059f172c8d843e7d213166ebff10fc7aee1ab34ac07a1e1b46d750828b157961 |
| [01 依赖与引用](https://app.notion.com/p/01-40c5636c236e81bea195da74acc3ded0) | 5943 | b7fe6e4edaf433e27a2549276a0c78fc62890dde80b4e3bf048a4f19900ef429 |
| [02 管理与消费](https://app.notion.com/p/02-Skill-Pi-40c5636c236e81fdb1f7f33e52acea02) | 5494 | 56287d1efb73d9eaa1e8da8066363209830dd78ce45d986d9e6017c323193654 |
| [03 状态与历史](https://app.notion.com/p/03-40c5636c236e81aabf70f6d2ab41eaa8) | 7897 | 61323ed0d1dd0bad49e4c2df5a951cbafe18c27c79232a8539963e332e8a8d6a |
| [04 Sources](https://app.notion.com/p/04-Sources-40c5636c236e8118ace7cf318f985e39) | 5341 | baf96d6efa9a79e129092272c570b6704d60cbf08ae9d1b4651faac985f953df |
| [05 验收](https://app.notion.com/p/05-Pi-40d5636c236e813b8b22cb63e2f7d0b5) | 33445 | f5f3a2975ea3826f54083cd14c432e0d043b2d17ef51a73ef1bfd6c27ce162eb |

03 的 AH-558 原始正文 2774 B（SHA-256 c929f25bf545078673e01e1d0bd5d5a4e76cf50aad82e92182cd0fa3ec2263e4）与 05 的 AH-560 原始正文 7292 B（ce1979985249ee384de19ee268da655b9b85ac0366064c5815cc3b605de211be）均作为明确历史段完整保留，并经最终 suffix 比对。

发布中保留三类原失败。初次 Bun 1.4.3 运行因 STATE_RUNTIME_UNSUPPORTED 停在任何页面 intent/PATCH 之前，随后使用实际 Node 24.20。第一次 Node 发布成功写入并逐字核验前四页；02 的 PATCH 已明确成功，但 Notion 自动把裸 SKILL.md 变成链接，原严格比较失败。独立审核把该路径放入 code 标记后，用当前已知正文作为新基线生成明确的新格式修正计划；原 operation、候选与失败均保留，没有重放 unknown。

05 首次派发前同样只对 8 个当前说明中的文件名增加 code 标记，历史段不变。其 PATCH 明确成功，独立读回相对该候选仅多 3 个 Markdown 转义反斜线，分别在表格 EAGER_MEMBERS、snapshot/file_id 与段落 ~/；没有新增链接、命令或可见文字变化。另存 accept-current serialization 决定，精确应用这三处变换后必须与完整读回正文逐字相同；没有再发 PATCH，也没有将 byteExact=false 或原严格比较失败改成 true。最终结论为 5 页 candidate-byte-exact，加 1 页已审序列化差异通过，不声称六页都与原候选相同。

六页共有 7 个明确 Success 的逻辑页面更新操作，包含 02 的一次独立格式修正；未决页面派发为 0。首轮 publisher 的总 HTTP metrics 未在抛错前保存，因此总请求成本未知，不以逻辑更新数补造 HTTP 总数。最后两页 publisher 保留 10 次 HTTP（4 metadata、4 body、2 write），请求 52,344 B、响应 96,193 B。最终独立读回另用 12 条公开 CLI9 命令，全部 exit 0，共 12 次 HTTP（6 metadata、6 body、0 write/provider），请求 0 B、响应 69,128 B。

最终证据均位于 /Users/yoyo/Library/Logs/ntn-skills/AH-561-20261103/ng21：

- publication/accepted-current-serialization-1793717247785.json，SHA-256 3dfc6a08236b0c0af789944da8b6bab6a4126b1230aa7721a8a493b86d2a3628。
- publication/independent-cli9-readback-VEUfV9/result.json，SHA-256 354cb080c95dee3953bbed9e548eeb8c5d89826357034e32f2532ca0846f8fa5。
- publication-complete-TCdBv3/result.json，SHA-256 0b6b59f9e980ec677f30c52679862331b13103b1afcee9413ab278a601ad84bf。

## 历史恢复与清理

保存图 graph-6b42b250d584cdd7faf1b45177c0cb22cc5b9fa1e97a7cd6c93015ed7e6870c2 后，当前三节点六文件均改为 B。Mini8 先只恢复完整 manifest，随后读入口与另一节点资源，最后完整导出全部六文件并离线复读。每个文件与 A 的 bytes/SHA-256 一致，版本向量逐项匹配，所有阶段 current body/write/provider 为 0，离线复读为 0 请求。

这组六个 owned Skill/File 页已经按各原 create operation 经公开 archive 移入 Notion 回收站并 GET 确认。不可变 Records、图与原操作证据保留，永久删除为 0。早期 CLI6 的 full/partial 证据保留自己的包身份。

原生链接测试与附件 owned 页已归档。三个早期失败创建页通过实际 UI 移入回收站，再由 CLI 读回 in_trash 确认。

新单 Skill owner ah561-cache-96603f07 完成全部模型使用后，resource 40d5636c-236e-8140-b88f-fe839939e626 与 main 40d5636c-236e-8166-98db-c522df651215 均按原 create operation 独立 dry-run、单次 archive、公开 GET 回读，精确 ID 与 in_trash=true 全部匹配。六条命令均 exit 0，14 次 Notion HTTP 全 200（12 metadata、2 write），没有 unknown 或重放。第三 View 40d5636c-236e-80da-b51d-000cf22b6b45 在实际 Notion UI 经“删除视图”确认后移除，界面自动回到默认上下文。两页 complete 回执 SHA-256 为 881d2b064ebd302c4824bf0a7fb3a16a2258769080b30f8372513971186bcc07；独立 audit 为 b52f5873cd27ca28a8bc7706d74ed9acc8b06a1a32fb58f68fa7674fa6a852b5；UI after 回执为 8aa3f4a5e93898fed2f32a9808517a37661a2300fcbda976fea386a49b56f651。

本批最后一组 H5/H6 图样本、H6/H7 SDK、H7 B 与单 Skill 的 18 个精确 owned 临时目录，在逐一核对归属及进程关闭后移入本机回收站，未泛扫或清空 /tmp。单 Skill 的 13 份完整 session 与 3 份原始前缀预先复制到 Logs 并逐字节核验；所有原始失败、产物与操作证据保留。三组清理回执分别为 ng20/h7-b-diagnosis-vmBDYI/cleanup-execution-6CsYI1/result.json（83c81a2fccf470853bb42b4528453d303b5c358e737a5d4735487ca14eb16ee2）、ng20/closed-graph-scratch-plan-KMtlaO/execution-tPpHCO/result.json（f257743d7345f2ef7c74b92186f00f6d1274c0711de3e30c0805bd4cdbca0f67）与 ng20/owned-single-final-ybVxon/legacy-h6-h7-scratch-trash-complete.json（6b9933e3276ddd56b9568a8ce0dde5c3e9a8140a3c1ad38fb79462ed1ee21c02）。

旧单 Skill owner owned-single-ANVtV1 的 A2 aggregate apply 保留 parent/main unknown。当前主文经完整原计划、当前事件 frontier、精确候选 hash 核对后创建独立 accept-current 决定；该决定不完成父 skill_apply，也不把缺失的子事件当作未发送。父 fence 保持，两页按原 create operation 各归档一次，并独立 GET 确认 in_trash=true。实际共 10 次 HTTP（8 metadata、2 页面归档 PATCH）、29,318 B；正文、provider、Records 写入、重放与永久删除均为 0。清理回执为 ng20/owned-single-ANVtV1/retirement-execution-1793701037401/result.json（SHA-256 0ba2109d1a5dc1e2c480b7ae7b58b5b5ed658198a4410714c09647f3775a9a5d）。新独立 owner ah561-cache-96603f07 不继承旧操作状态。

## 仓库与日用保护

CLI 原有 1615 个暂存路径的索引和内容逐项保护，恢复连接后的检查仍为 preserved=true。Broker 原 Tern completion 正文字节始终为下列原 SHA；恢复时发现它的索引已从原 HEAD blob 变为暂存同一份脏文件，原保护检查因此只报 index 差异。该变化归属未知，不改写旧基线，也不将旧检查误报为通过；本轮保留恢复时的暂存状态，并从所有任务提交中排除此路径。独立记录为 ng21/resume-protection-O8jK1P/result.json（SHA-256 9af0e44935f089cd31611d2b211a45eed9a84bc8b2e506b57c1e284ed4c5b32b）。没有 reset、clean、force push 或覆盖无关历史。

受保护旧 Tern completion 含历史 ntn 字样，保持用户原文件 SHA-256 262dcf14a6627406926a1ff47a3f0c8fb397b8001f7f8ed40aeff082ca980d0c。它不在新 Pi 包内。新生成的共享 completion 及 9 项共享 CLI/NOTICE/builtin 资产另行审计；没有将保护例外写成“全库所有历史文本 grep 为零”。

日用激活计划只替换 ~/.pi/agent/settings.json 中既有 Broker package 项与 ~/.local/bin/ntn-skills。其余 20 个 package 项、来源配置、认证、模型配置和旧进程保持。候选新目录与回退用的旧文件备份已准备；实际激活仍以最终全部验收为前提，不设置新旧 API fallback。当前 settings SHA-256 为 fb51d3931a0ee3d1b30aac79f9c4ff5198e6d23945c4ce140638f2ae00bf3f8b，旧 shim 为 bb9766af3b8bea9f8252b3fb6c7f1fe19460f75774adda48dbb5140cc40b3549；没有启用候选或以受控 SDK 代替实际日用新会话门禁。

2026-11-03 22:18:05（UTC+8）的独立保护复查为 ng21/final-protection-FnM8Ik/result.json，SHA-256 f65217b64962a26957db42f41fd7ede6f7d41439ec52aa9026accad1991aa792。CLI 的 1615 项完整保留；Broker 原检查仍只报上述 Tern index 差异，恢复时的 index 为 100755 f8c49ae1887ee34b04b6582e99ddd30192ff548b 0，正文 SHA 未变。最终文档提交只含此验收报告及另一仓两份故事账本，不纳入受保护内容或五个独立未跟踪 pycache 文件。

产品源提交 CLI9 dd801c1、Broker8 1809fd7 与测试产物身份固定。已推送的 CLI 检查点 7a8b1e7 和 Broker H7 修复 dfb64d8 及最终文档提交各自记录，不能用后来的验收/文档提交替换包的 source commit。最终 Git 提交、远端相等与保护前后回执另存 Logs 和 Linear，避免账本自引用包含自身的提交。

## 子任务与故事映射

33 个用户故事逐项映射位于 Broker 的 scripts/notion-skill-graph-story-ledger.md 及同名 JSON。原 AH-560 的 15 例与新增 2 例独立编号，不能由新的图场景数量替代。

| Issue | 交付键 | 主要证明 |
| --- | --- | --- |
| [AH-562](https://linear.app/yoyooyooo/issue/AH-562) | NG01 | 冻结两条自然用户任务、私有 oracle、失败基线 |
| [AH-563](https://linear.app/yoyooyooo/issue/AH-563) | NG02 | 独立安装、自己认证、完整公开只读消费 |
| [AH-564](https://linear.app/yoyooyooo/issue/AH-564) | NG03 | 写入、附件、原操作恢复与 unknown |
| [AH-565](https://linear.app/yoyooyooo/issue/AH-565) | NG04 | 多作用域、多进程调度与预算 |
| [AH-566](https://linear.app/yoyooyooo/issue/AH-566) | NG05 | 两仓、当前文档、正式包和 helper 无官方 ntn |
| [AH-567](https://linear.app/yoyooyooo/issue/AH-567) | NG06 | 普通 Skill/Router 原生关系 |
| [AH-568](https://linear.app/yoyooyooo/issue/AH-568) | NG07 | 上游两次刷新与 portable 重导入保护 |
| [AH-569](https://linear.app/yoyooyooo/issue/AH-569) | NG08 | 实际 UI 原生链接和精确 File 引用 |
| [AH-570](https://linear.app/yoyooyooo/issue/AH-570) | NG09 | Pstack 57 条生产关系与引用治理 |
| [AH-571](https://linear.app/yoyooyooo/issue/AH-571) | NG12 | use/inspect 闭包与拒绝边界 |
| [AH-572](https://linear.app/yoyooyooo/issue/AH-572) | NG10 | 无 shell 发现与 exact 原生读取 |
| [AH-573](https://linear.app/yoyooyooo/issue/AH-573) | NG11 | 只选 Router 的真实模型 Gate A |
| [AH-574](https://linear.app/yoyooyooo/issue/AH-574) | NG13 | Pi 各入口、第一次 provider 和实际取消 |
| [AH-575](https://linear.app/yoyooyooo/issue/AH-575) | NG16 | 固定拓扑、批量请求和精确派生失效 |
| [AH-576](https://linear.app/yoyooyooo/issue/AH-576) | NG14 | 只选普通 Skill 的真实模型 Gate B |
| [AH-577](https://linear.app/yoyooyooo/issue/AH-577) | NG15 | 会话图、实际多节点 A/B、分支和压缩 |
| [AH-578](https://linear.app/yoyooyooo/issue/AH-578) | NG17 | 物理 Mini 独立精确历史恢复 |
| [AH-579](https://linear.app/yoyooyooo/issue/AH-579) | NG19 | 默认关闭的预算预取与实际对照 |
| [AH-580](https://linear.app/yoyooyooo/issue/AH-580) | NG18 | 完整 manifest、按需物化与完整 export |
| [AH-581](https://linear.app/yoyooyooo/issue/AH-581) | NG20 | 图/缓存/真实模型/故障全矩阵与 coverage |
| [AH-582](https://linear.app/yoyooyooo/issue/AH-582) | NG21 | 文档、包、保护、日用新会话与双仓交付 |

不为凑第二套生产数据而全量改造 Matt。已有更名、全部 ID 改写、异构 Required 反例和非 Pstack owned 图验证无 Pstack 名字硬编码；最终覆盖决定依这些证据登记。OMP/Tern 的业务产品验收不在本次 Pi 主线完成声明内。

### 尚未完成的验收

| Issue | 已有交付与剩余条件 |
| --- | --- |
| AH-572 | 原生发现、准备和精确读取实现及 SDK 证明已完成；原验收同时要求 NG11/NG14 自主真实模型通过，当前缺口不能由受控 provider 替代。 |
| AH-573 | Gate A 最新 H6 有完整目标主文，三份所需资源未消费、未产出完整 Skill；独立修正观察标签后仍 READ_MISSING。 |
| AH-576 | Gate B 最新 H7 服务可用、观察完整；模型路径输入错误后未取得目标/资源，也未产出完整 Skill，READ_MISSING。 |
| AH-581 | 单 Skill 17 项要求已分别覆盖，图/缓存/故障证据已登记；A/B 各 cold 失败，后续各 4 个样本未运行，完整矩阵未通过。 |
| AH-582 | 包、文档、生产复查、owned 清理与双仓交付已收口；全部门禁与正常日用激活后的新会话仍未完成。 |

原规格只在 magpie/group/flash-free 当前实测不可用时允许改用 magpie/group/worker。A、B 最新样本各有 9 次 provider HTTP 200 和成功 final，availabilityFailure=false；任务未达标不满足该条件。若要在服务可用的情况下用 worker 继续相同验收，需要用户明确调整这一限制，TASK、私有 oracle、工具边界、内容完整性与失败保留规则均不随之放宽。

AH-498 与既有历史 Issue 不随本批次自动关闭。Notion 原 AH-558/AH-560 文档内容以明确历史存档保留，当前使用说明与本轮结果另列。

