# 保存和恢复明确选择的 Skill 图

`prepare` 返回所选主文和 Requires 闭包的版本向量。需要在另一台机器恢复这些准确版本时，再显式保存 graph release。日常读取、查看 Members 或准备一个根不要求先发布 release。

## 选择与保存

以下根和库入口必须来自当前任务的准确身份。把可选成员列为第二个根，就能保存它和其 Requires；仅在目录中出现的 Members、原生链接目标和未选择资源 owner 不会自动成为冻结节点。

```bash
ntn-skills prepare "$ROOT_REF" "$OPTIONAL_REF" --database "$LIBRARY_ENTRY" --purpose use --metrics > prepare.json
ntn-skills ctl library graph plan --input prepare.json --entry "$LIBRARY_ENTRY" > graph-plan.json
ntn-skills ctl library graph save --input graph-plan.json --entry "$LIBRARY_ENTRY" > graph-save.json
```

`plan` 接受成功 prepare 响应、原始 `graph_lock`，或 `{ "graphs": [graph_lock, ...] }`。多个向量须属于同一认证 scope，同一稳定身份只能选择一个版本。输入向量须与本地准确 pin、主文 hash、完整文件和关系一致。失败/部分 prepare、缺 Requires、环、重复绑定、篡改 hash 和另一 owner 的 pin 都不能发布。

计划包含原始不可变文件对象，适合审阅并保留给恢复操作。默认范围是明确根和 Requires。`--include-members` 才会递归准备完整 Members 集合；它沿正常当前准备路径获取新增成员，因此仍遵守当前原生观察和保留协议。它不展开普通正文引用。

| 计划参数 | 默认值 | 限制内容 |
| --- | ---: | --- |
| `--max-nodes` | 64 | 明确根、Requires 和显式扩展的 Members 总数 |
| `--max-depth` | 16 | Requires 深度与 Members 扩展轮数 |
| `--max-bytes` | 134217728 | 所有选定节点完整文件的总字节 |
| `--max-instruction-bytes` | 1048576 | 单份主文 |
| `--max-context-bytes` | 1048576 | 计划阶段重新验证的完整 preparation envelope |

超预算或任一明确请求的成员不可用会失败，不截断选择。完整图清单和单节点清单也受现有 Records 的 64 KiB envelope 上限约束；过大的清单返回错误，不能删掉节点来宣称完整。

`save` 先核对当前库和每个 Skill 的准确身份与访问权限，再持久保存原派发计划。每个节点复用已有 snapshot history 协议：32 KiB 精确字节块先保留，完整节点清单后保留。最后在既有 Records 表保存一个 library archive 类型的 graph manifest。没有新增 Notion 表，也没有改写当前正文。

本地来源的受限资源仍需本次明确的 `--allow-local-archive`。这个参数只批准当前计划里的准确字节，不清除资源的原限制。

## 核对未知结果

保留 `graph-plan.json`，使用同一输入检查原操作：

```bash
ntn-skills ctl library graph save --input graph-plan.json --entry "$LIBRARY_ENTRY" --reconcile
ntn-skills ctl library graph inspect "$GRAPH_ID" --entry "$LIBRARY_ENTRY"
```

派发后重试自动进入只读核对。完整 graph record 已存在时，结果标为 `verification: "manifest"`；这证明原完成事实，不声称重新下载了所有历史字节。新的成功保存才返回 `objects_and_manifest`。已有单节点 pin 在复用前仍读取其远端精确对象，避免用本机缓存掩盖缺失的历史对象。

若对象阶段结果未知且完整图记录尚不存在，返回 `GRAPH_RELEASE_UNRESOLVED`，保留原计划和已写事实。不创建替代操作，也不重放未知 POST。核对无法证明完整时，不能报告发布完成。

本地原派发计划和已保存的图保护关联快照、文件对象与块不被 GC 回收。普通 cache clear 只清除可重建的查询索引，保留这些派发和保留事实。

## 在独立机器恢复

目标机器使用自己的认证和空的配置、状态、缓存及导出目录，只需要准确库入口和 graph ID：

```bash
ntn-skills ctl library graph restore "$GRAPH_ID" --entry "$LIBRARY_ENTRY" > restored.json
```

默认 `all` 模式从 Records 验证每个精确历史对象，不用 current 正文或上游重新生成历史。当前 Skill metadata 只用于确认访问权限与稳定身份。每个完整文件都通过大小和 SHA-256 校验后，才发布完整本地 snapshot。

返回 `origin_graph` 和本机 `graph_lock`。相同 scope 的 snapshot ID 相同。另一个当前获授权的 scope 可按已有单节点历史规则得到本机 pin；原生产者向量和历史字节保持原样。输入 save 计划属于另一 scope 时直接拒绝。跨库、改名后冒用另一 Skill ID、权限撤销、缺失对象和坏 hash 都没有 current 替代路径。

明确写进 Requires 的生产者 scope 固定 ref 无法在另一 scope 下静默重写。此情况返回 `GRAPH_RELEASE_SCOPE_REBIND_UNAVAILABLE`；通常由原生关系编译的无 pin Requires 可正常恢复。相同 scope 不受此限制。

把返回的 bindings 用作后续 `prepare --session-bindings` 输入，就能在同一选择中继续固定所有节点。完整历史正文不会为了指向本机而改写；单独打开未固定的原生页面链接仍是当前页面访问。

## 按需物化

只有已经验证完整的不可变历史清单才支持部分下载。正在变化的原生页面仍须完成原有观察；不完整观察不得转为 metadata-only ready。

```bash
ntn-skills ctl library graph restore "$GRAPH_ID" --entry "$LIBRARY_ENTRY" --materialize manifest
ntn-skills ctl library graph restore "$GRAPH_ID" --entry "$LIBRARY_ENTRY" --materialize entrypoints
ntn-skills files "$NODE_ROOT_PIN_REF"
ntn-skills read "$NODE_MAIN_PIN_REF"
ntn-skills read "$EXACT_RESOURCE_PIN_REF" --output ./resource.bin
ntn-skills export "$NODE_MAIN_PIN_REF" --projection snapshot --output ./complete-export
```

| 状态 | 已证明的内容 | 不包含的承诺 |
| --- | --- | --- |
| `manifest_complete: true` | 完整文件清单、准确节点、版本、路径、hash 与固定对象布局 | 文件已全部下载 |
| `local_files_ready: true` | 该节点所有文件已经在本机逐一通过大小和 hash 校验 | 主文已送进模型上下文 |
| `loaded: false` | CLI 没有声称模型投递或会话激活 | 任何 Broker loaded proof |

`manifest` 只读取图与节点清单；`entrypoints` 再取各节点主文。`files` 返回完整目录和稳定 File ID 绑定。`read` 只物化指定文件，`prepare` 只物化主文；未选资源保持目录状态。返回的 `materialization.materialized_paths` 是本次需求实际校验的文件集合，不为推断其他文件是否齐备而扫描全部对象。只有已校验集合覆盖完整清单时才报告 `local_files_ready: true`；具体边界见[按需快照消费](selected-snapshot-consumption.md)。

缺文件时按相同 Skill 下的精确 chunk Entity IDs 查询，每批最多 80 项，正常处理分页。块和组装后文件分别校验 SHA-256。每个通过校验的块才能进入共用对象缓存；中断后可复用这些块，缺失或损坏仍明确失败。不会按文件名、当前 URL 或相似内容补齐。

`--offline` 只能使用已有完整清单和已校验对象，缺块返回 `SNAPSHOT_NOT_MATERIALIZED`。完全没有对应历史索引的旧缺失 pin 保持原 `SNAPSHOT_MISSING`，不会因此启动网络查询。

部分状态存放在独立的 retained-manifest 索引中，绝不写入原 `snapshots/` 完成态。完整 `export` 会获取所有剩余文件；任一对象缺失或损坏都不产生完整输出目录。原有完整导出 receipt 语义保持不变，不能用部分目录冒充。

## 已知边界与验证

现有自然编辑观察的 v1 操作计划内嵌 raw Markdown，仍受 64 KiB Records envelope 限制。超大当前正文可能在 `prepare` 阶段返回 `SHARED_RECORD_TOO_LARGE`，不产生 graph lock。固定历史的分块恢复支持更大文件；这不扩大首次原生观察协议。

graph retention 使用既有精确字节块，不依赖 ZIP 的随机访问。其他仍以整包 ZIP 提供字节的来源不会因为这个功能就变为随机获取；其实际传输成本须单独记录。

Pi 的图准备路径使用独立的 entry-ready receipt：先物化并核对根与 Requires 的完整主文，保留完整资源目录，再由原生 read 按准确 File ID 物化所选文件。host index 只证明主文及别名的归属，保持 `loaded: false`；实际投递回执才证明 loaded。未选择的大资源不因目录存在而提前下载。原有 Prompt 或直接完整 export 路径仍要求所有文件齐备；部分目录不能复用完整导出凭证。其他宿主的产品切换与验收不由 Pi 的结果推断。

复验入口见 [Skill 依赖图 feature map](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/skill-dependency-graph.md)。受控 HTTPS、真实 Node/SQLite 与真实双机 Notion 验证分别留证，不互相替代。
