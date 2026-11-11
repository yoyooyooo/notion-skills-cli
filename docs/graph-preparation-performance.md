# 图准备的批量读取与派生缓存

`prepare` 仍从明确根节点沿 Requires 选择内容。Members 和原生引用只提供目录；`inspect` 只准备根节点。性能优化在同一次准备的读取与目录派生层共享工作，不改变图锁、会话版本、授权范围或正文就绪条件。

## 一次准备共用哪些观察

准备先取得实际认证 scope，再建立只属于本次调用的读取上下文。同一 shared library 的完整 descriptor 必须一致；Skills inventory 使用注册 property ID，逐页读取所有身份与关系字段，包含 disabled 行。重复页面、错误 parent、未完成分页、重复 cursor 或权限失败都不会生成完整观察。后续逻辑 ID、物理页面、Members、Requires 和原生引用的 Skills 元数据使用这份目录。

| 数据 | 查询范围 | 完整性与边界 |
| --- | --- | --- |
| Skills | 准备实际使用的库，每库一份完整 inventory | 页面大小 100；完整耗尽分页，校验精确 data source 与逻辑身份冲突 |
| Files | 明确根与已解码的直接 Requires owner 提示 | owner OR 最多 80 项一批，每批继续完整分页；inspect 不加入 Requires，节点与深度预算限制提示 |
| 初始 file events | 批次内全部 owner 的完整事件目录 | 先读取不含 Payload 的元数据，再按实际缺失 Entity ID、每批最多 80 项读取并校验原始 envelope |
| Operation index | 同批 owner 的完整 operation headers | 不把 headers 当成已验证 Payload；需要的原计划仍由既有精确读取验证 |
| 原生外链的 Files | 既有同库完整 Files inventory | 选中 owner 的 Files 子集不会伪装成全库完整目录 |

Files 的逻辑身份为 `(scope, owner Skill ID, file_id)`。不同 owner 可使用相同 File ID；同 owner 的重复 File ID、同一物理页的多 owner 或多绑定、同 owner 的路径碰撞仍失败。Records 的去重也保留 owner，因此不同 Skill 使用相同内容对象 ID 不会产生伪冲突。

事件目录先覆盖 owner 的全部事实，随后才选择具体 Entity Payload。一个事件若引用已消失的 File 绑定，仍产生 `UNBOUND_FILE_STATE`，不会被“只查询现存 Files”的过滤隐藏。初始观察只用于当前消费；显式写入、reconcile 和未知结果恢复仍查询各自的最新事实。

## 派生目录与完整正文分开

派生目录缓存按 scope、父节点身份、主文 SHA-256、关系摘要、准确 snapshot/version、完整文件与 File ID 绑定、原生引用索引及编译器/物化版本寻址。单个节点变化只增加该节点的新键。无关节点的正文变化不会使整库正文失效。

缓存保存在既有 SQLite cache 类别：`cache/shared-derived-graphs/<scope>/<parent-id-sha>/<input-sha>.json`。它只包含文件、Requires、Members、原生引用目录及校验信息，不保存正文、freshness、完整图选择或 prepared/loaded 回执。读取仍验证准确主文 bytes/hash，并重新计算本次节点、深度、指令与完整上下文预算。损坏的派生回执明确失败。`cache clear` 可清理这些派生项；原始派发与历史 pin 的保留协议不变。

现有 native reference index 已绑定原始正文、关系和 parser version。跨准备的目录缓存复用这份精确 snapshot 证据，不把上次目录当成当前远程授权。已有 session binding 继续固定自己的版本；刷新当前数据不会替换旧图锁。

同一 Notion service 的在途 GET/只读 POST 查询继续由原有 coalescer 管理。请求身份包含实际凭据、路径、body 与内容分类。取消一个等待者不终止其他等待者；最后一个等待者取消会释放真实请求。成功、失败与取消后的在途结果都不变成永久响应缓存。批量读取没有另一套重试或速率调度器。

## 公开度量

```sh
ntn-skills ctl prepare ROOT_ID OTHER_ROOT_ID --database LIBRARY_ENTRY --purpose use --metrics
```

`--metrics` 返回原有 `request_metrics`，即使未开启详细 trace 也返回真实计数。`NTN_SKILLS_REQUEST_TRACE_LIMIT` 可启用有界诊断；Entity IDs 来自实际已序列化查询中的精确过滤条件，不取自计划或预期闭包。

新增 `preparation_metrics` 仅在显式 metrics 请求下返回：

| 字段 | 含义 |
| --- | --- |
| `root_ready_ms` | 从本次 prepare 开始，到所有明确根的主文与目录验证完成 |
| `required_ready_ms` | 到本次所选 Requires 闭包的主文全部验证完成 |
| `elapsed_ms` | 完整准备与上下文预算验证的耗时 |
| `derived_cache_hits` / `derived_cache_misses` | 本次实际使用的节点派生目录缓存结果 |

这些诊断与 `request_metrics` 一样不计入 `maxContextBytes`，也不进入 graph lock。CLI 进程启动耗时由外部调用者单独记录。HTTP attempts、请求/响应 bytes、正文类别、provider、coalesced、queue wait、retry wait 与准备阶段各自保留，不能相互替代。

## 有界历史与本地成本（AH-506）

2026-11-11 的独立安装 Node SDK 样本使用同一四文件菱形、最终正文、credential scope、空 Store seed 与 cold → warm → expired-unchanged → single-cold 顺序。历史档位为 H=1/101/301；只改变共享 Requires 文件的合法历史数量。运行时为 CLI commit `147ac9386f014853545334c624347da0a42e4ff3`，SDK SHA-256 为 `0da69d00f5377a94b6f37fe844d0702494ea6f110d647593bcd954a32afad0f5`。这是受控 loopback HTTP 与真实 Node SQLite，不能替代生产 Notion 或长期日用样本。

| H | cold HTTP attempts | decoded response bytes | `boundedEnvelope` | `decodeHeader` | DB 文件长度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 15 | 24,475 | 4 | 8 | 299,008 B |
| 101 | 18 | 374,591 | 104 | 208 | 397,312 B |
| 301 | 24 | 1,074,823 | 304 | 608 | 565,248 B |

| H | `shared_local_records` 行 | objects 文件数 / bytes | manifest 文件数 / bytes | expired HTTP / response bytes |
| --- | ---: | ---: | ---: | ---: |
| 1 | 20 | 12 / 2,188 | 4 / 6,178 | 10 / 19,571 |
| 101 | 120 | 112 / 52,288 | 4 / 6,178 | 12 / 211,715 |
| 301 | 320 | 312 / 152,488 | 4 / 6,178 | 16 / 596,003 |

三个档位的当前 observation 与 snapshot 表均保持 4 行；warm 和 expired-unchanged 没有增加这些逻辑行、objects、manifest 或 cache 目录文件。warm 的 `validated_at` 原样保留。物理 objects 包含缓存的历史 envelope 等对象，不等于业务文件数。历史 Payload 缓存仍有线性增长项，不能把 latest 单槽称为全部缓存恒定。

每档图 warm 保留一次身份请求、61 response bytes，正文请求与上述解码计数均为零；expired-unchanged 的正文请求也为零，但完整 metadata 校验与本地 envelope 校验仍随 H 增长。WAL/SHM 在每次 SDK scope 关闭后的采样点不存在；这不代表运行期间的峰值为零。DB 文件长度、SQLite page/free-page 计数与逻辑行分别记录，cache clear 不承诺文件立即缩小。

H=301 的 cold / single-cold 样本为 15.35s / 15.16s，均未超过事前沿用的 30s 单次预算；完整历史消费预算为 240s，producer 为 60s，重试预算为零。进程 CPU 的 user/system 微秒另存原报告，包含 SDK、同进程受控 HTTP 服务和 V8 覆盖率开销；独立 replay CPU、wire bytes 和真实长期趋势仍未知。H301 single-cold 的 V8 输出缺少 `recordFromEnvelope` 条目，该字段保留 null，跨根完整解码比较也为 unknown；已报告的 `boundedEnvelope=304`、`decodeHeader=608` 与完整正文/身份/关系 oracle 独立成立。旧包重复 header 的原数据仍会失败于 `decodeHeader === 2 * boundedEnvelope`。

本样本不采用新 checkpoint：所有冻结时间、完整性和复用预算满足，已有缓存守住未变观察与单槽。H>301、更多/更大业务文件或实际日用超出 30s 单次预算时，应先记录同条件成本，再比较可重建 checkpoint 与完整 replay；不外推无限历史的恒定成本。本切片只改验证与观测，没有修改 cache 生命周期转移，因此保留既有有限模型及其范围，不以新哈希冒充模型扩展。

单 reference 变化另走 `shared-snapshot-costs.test.ts` 的 N=1/10/100/101/300、k=1/3。N>1、k=1 明确只改变 reference 页，并核对正文请求的精确 page；未变 metadata 仍批量分页。101 文件的 fixed/current-proof 场景保留缺失与损坏的未选对象，按需主文成功而显式选择坏对象失败。Node SQLite 的旧观察发布、权限否定、clear fence 和未决操作保护继续由原测试覆盖；原 GC 用例只把不可达 owned 对象移入 Trash，并验证仍能读回被引用历史。

复跑时先保存一份 history 输入，再固定同一 loopback 端口，端口占用直接失败：

```sh
node scripts/sdk-fixture.ts --outdir "$RUN/history" --records-history
NTN_SKILLS_RECORDS_HISTORY_FIXTURE="$RUN/history/history.json" NTN_SKILLS_SOURCE_FIXTURE_PORT=45036 node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$SDK_FIXTURE" --outdir "$RUN/history-installed" --case records-history
NTN_SKILLS_SOURCE_FIXTURE_PORT=45037 node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$SDK_FIXTURE" --outdir "$RUN/scalar-installed" --case scalar-inventory
```

`RUN` 和 fixture/archive 必须是本次 owned 的绝对路径，每次使用新输出目录。scalar 原场景补记 warm、expired、refresh、offline、旧 pin、权限恢复与 clear 的逻辑/物理状态；完整 export 文件字节另列，不计作默认消费。缺失或截断观测不能记零，保留失败及未知字段。

## 可复跑测量

`scripts/measure-graph-prepare.ts` 固定菱形与 101 节点拓扑，分别测 cold、warm 与 metadata revalidation。比较前冻结拓扑、缓存状态、样本数、完整 graph lock 与预算，分别保存修改前后的原始调用、字节与结果。cold 使用该夹具的空派生缓存，warm 使用普通 TTL，revalidation 只使元数据到期。受控服务调用数和本地执行时间不等于真实 Notion 网络延迟。

核对每次完整 graph lock、bindings、所选正文与未选对象零读取；保留全部失败和独立来源账本。小样本不报告 p95，不将不同切片的收益相加成全任务收益。公开 CLI 的实际 Node/HTTPS/SQLite 请求账本与真实 Notion 复验分别运行，不能用 fixture 计数替代。

来源下载、历史块与大型当前原生观察的边界沿现有协议。优化不得扩容 v1 observation 的 64 KiB envelope，或放宽固定历史文件的完整性、权限与取消条件。
