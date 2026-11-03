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
ntn-skills prepare ROOT_ID OTHER_ROOT_ID --database LIBRARY_ENTRY --purpose use --metrics
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

## 受控前后比较

`scripts/measure-graph-prepare.ts` 固定菱形与 101 节点拓扑，每种拓扑的 cold、warm、metadata revalidate 各预设 3 个样本。先创建远程不可变事实，cold 清空该夹具的本地 JSON 与对象缓存；warm 使用普通 TTL；revalidate 在正文有效期内只过期元数据。它测量受控 Effect service 调用数量与本地执行时间，不代表真实 Notion 网络延迟。

| 拓扑与状态 | 修改前请求数 | 修改后请求数 | 修改后 Skills inventory 页 | 修改后 Files 查询 | 修改后 Records 查询 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 菱形 cold | 32 | 16 | 1 | 2 | 6 |
| 菱形 warm | 1 | 1 | 0 | 0 | 0 |
| 菱形元数据复验 | 25 | 10 | 1 | 2 | 4 |
| 101 节点 cold | 810 | 115 | 2 | 2 | 6 |
| 101 节点 warm | 1 | 1 | 0 | 0 | 0 |
| 101 节点元数据复验 | 509 | 12 | 2 | 2 | 4 |

每行三次请求数一致，前后准确 graph lock/bindings 也逐样本相同。cold 的正文请求仍分别是 4 和 101；warm 与元数据复验均为 0。所有测量阶段写入为 0。样本数不足以作 p95 结论；这组数据不声称热缓存的 CPU 或生产延迟改善。

最初的 memory Store 夹具按任意字符串前缀枚举，误把 `leaf-1` 与 `leaf-10` 混在一起；真实 SQLite 已按目录边界枚举。正式比较已在修改前 commit 的独立只读源码与优化源码中使用同一修正夹具，原始失真报告和失败日志保留。上表只采用修正后的结果，不将夹具修正计为生产收益。消费者继续使用既有目录查询与 scope/identity 校验，无须改变生产枚举规则。

公开 CLI 另用真实 Node、HTTPS 传输、独立进程及 SQLite 重启验证 actual attempts/bytes 与回执计数相等。真实 Notion 小图只做低负载复验，与受控性能比较分开记录。源下载、历史块与大型当前原生观察的能力边界沿既有协议；本项不扩容 v1 observation 的 64 KiB envelope，也不改变按需历史文件的完整性条件。
