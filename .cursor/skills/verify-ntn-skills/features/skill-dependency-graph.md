# Skill 依赖图

跨 Skill 图复用既有 CLI 与 Broker 验证链。先读同目录 [request-engine](request-engine.md) 的 Launch/Doctor/Drive/Evidence/Cleanup，再使用 Broker 的 `.agents/skills/verify-notion-skills-integration/features/skill-dependency-graph.md`；后者定义 observer trace/oracle 合同。AH-560 单 Skill 与资源的旧 pass 不覆盖本地图。

## 后续切片的稳定 feature ID

| Feature ID | Issue | 必须通过的行为 |
| --- | --- | --- |
| NG-SG-06 | AH-567 | 普通 Skill 与 Router 的原生 Members/Requires，准确同库身份、完整关系分页、重复/禁用/越库失败。 |
| NG-SG-07 | AH-568 | 上游刷新仅写白名单；本地关系、手工删除、附加字段、正文/custom/资源和旧 pin 保留。 |
| NG-SG-08 | AH-569 | mention/page link/Link to page 编译准确 Skill/File ref；重名、未受管/越库/无权限目标不猜测。 |
| NG-SG-09 | AH-570 | Pstack 实际原生关系和引用校准；保护已有字段与版本，有变更计划和直接 readback。 |
| NG-SG-10 | AH-572 | 无 shell 的 Agent 通过原生发现/read 取得准确成员和资源，无本地插件副本兜底。 |
| NG-SG-11 | AH-573 | Gate A，只选 Pstack Router，自主选择并读取验收成员主文与 feature-map。 |
| NG-SG-12 | AH-571 | 统一 prepare，use 完成必需闭包、inspect 不采用流程；环、缺失、版本/预算冲突明确失败。 |
| NG-SG-13 | AH-574 | Pi `$`、native `/skill:`、read 和多目标入口共享准备/注入/取消，首次 provider 请求前前置齐备。 |
| NG-SG-14 | AH-576 | Gate B，只选 poteto-mode 类 Kind=skill；不再选择 Router，模型自行继续成员引用链。 |
| NG-SG-15 | AH-577 | 实际选择图的 A/B 版本向量、resume/fork/rewind/compaction 与重复注入边界。 |
| NG-SG-16 | AH-575 | metadata/Files/Records 批量共享、在途复用、正文hash/关系摘要/parser版本绑定的局部图失效。 |
| NG-SG-17 | AH-578 | 完整闭包 manifest，空机器按 Records 恢复精确历史；缺失/坏hash拒绝，不能回退 current。 |
| NG-SG-18 | AH-580 | manifest_complete 与 local_files_ready 分离；固定完整清单可按需物化，完整 export 仍拿齐字节。 |
| NG-SG-19 | AH-579 | 预取默认预算零、低优先可取消、不决定可选版本、不写 loaded/selected 或扩大授权。 |
| NG-SG-20 | AH-581 | 全冷/暖/会话/故障/安装矩阵；仅覆盖缺口需要时选一个 Matt 小图验证通用性。 |

## 两条冻结用户路径

Gate A 的选择只有真实 Pstack Router；Gate B 的选择只有 poteto-mode 类普通 Skill。两者使用同一自然任务：为项目建立可复跑验收流程，覆盖用户入口、正常/失败路径、证据与清理。目标成员名、ref、答案、资源路径只进入私有 oracle，不进入用户提示、首轮 provider 输入或强制工具参数。

`baseline` 的 `prompts.json` 保存默认根选择和精确提示/hash。真实运行须从实际只读目录回执取得根 alias/ref/kind，再以 `--router-selection` / `--ordinary-selection` 冻结该选择；禁止凭名称推测稳定身份。未绑定真实根的模板不算 Gate 已执行。选中 Router 不预读候选正文，且不得读取普通 Skill 充当桥梁；普通 Skill 也不得改 Kind 或把目标叶子加 Requires 来强迫通过。

## 身份、缓存与证据

oracle 与消费者各自隔离配置和内容根，在同一明确授权身份下原位使用凭据，不复制 secret、不交叉暖化。消费侧 CLI/Broker/session 三层的实路径彼此独立，冷场景启动前为空。身份包括 connection/library scope、稳定 Skill/File ID、公开 ref、实际 snapshot、完整字节数和 SHA-256；oracle 不能替消费侧预热，也不能决定模型选择。

离线契约会拒绝隐藏 Pstack/Matt 插件副本、猜名、错误 ref/hash/scope/snapshot、不完整主文/资源、预置叶子、强制工具、HTTP 200 许可消息、缺 final、无真实 provider 字节和缺失进程退出。`contract-valid` 不认证 trace 来源；审阅实际原生调用、provider、HTTP账本和产物后才能作对应层的结论。

新增实现时保持上表 ID，更新此地图和 Broker 对应入口，把精确命令及实际结果加入外部证据。不得仅凭 schema、静态扫描、零测试、目录存在、模型自述或编译通过把后续切片记 Done。

## NG-SG-06 原生关系复验

沿既有 Launch/Doctor/Evidence/Cleanup，使用新的外部 run 目录。记录源码和安装包版本、命令、连接 scope、library/Skill/page/property ID、HTTP attempt 账本、快照与正文 hash。受控测试不代替实际 Notion 页面点击证据。

### 受控入口

```bash
bun test packages/core/test/shared-native-relations.test.ts packages/core/test/shared-router-members.test.ts packages/core/test/shared-metadata-write.test.ts packages/core/test/shared-library.test.ts packages/core/test/shared-create.test.ts packages/core/test/shared-create-public.test.ts --timeout 30000
bun test packages/cli/test/cli.test.ts --timeout 30000
```

检查普通 `skill` 和 `router` 的 `Members`/`Requires`，包含 101 项分页读、循环/缺失游标、重复 stable identity、Prompt/嵌套 Router、禁用、越库与缺权限目标。所选目录仅含轻量元数据，目标 `/markdown`、Files、Records 正文请求数必须为零。调用方可复用同一 data source 已完整分页的 metadata inventory；不完整集合不得标记 complete。

分别保留 schema PATCH 和 descriptor PATCH 的已接收/未接收未知响应证据。原计划重复 apply 只观察已派发步骤；reconcile 全程只读。schema 已观察而 descriptor 未派发时，原计划可显式继续注册。原字段删除重建、同名未注册属性、篡改计划应在修改前失败。旧 Router `router_members` pin 和未包含新字段的 snapshot 保持原 JSON/hash；新普通 Skill 目录使用 `members`，必需目录使用 `required`。

### 公开命令与原生 UI

对任务指定的库先保存计划，再执行同一计划。以下变量必须来自本 run 的明确目标和回执。

```bash
node "$CLI_BIN" ctl library relations plan --entry "$LIBRARY_ENTRY" > "$RUN/evidence/relations-plan.json"
node "$CLI_BIN" ctl library relations apply --input "$RUN/evidence/relations-plan.json"
node "$CLI_BIN" ctl library relations reconcile --input "$RUN/evidence/relations-plan.json"
node "$CLI_BIN" ctl doctor --database "$LIBRARY_ENTRY"
node "$CLI_BIN" update "$SKILL_PAGE" --member "$MEMBER_PAGE" --require "$REQUIRED_PAGE" --dry-run
node "$CLI_BIN" update "$SKILL_PAGE" --member "$MEMBER_PAGE" --require "$REQUIRED_PAGE"
node "$CLI_BIN" read "$SKILL_PAGE" --refresh --metrics
```

对 ordinary Skill 与 Router 各执行一次。选取确实无条件需要的前置作为 Requires，条件候选放 Members。`--clear-members` 与 `--clear-requires` 独立清空；省略的关系、附加字段、正文与原 pin 必须保持。更新前后读回 registered property ID、完整集合、Kind、物理 parent、原正文 hash，再读旧 pin。重命名关系列后仍按原 ID 读写；不要在生产删除或重建字段来模拟故障。

Notion 当前 [request limits](https://developers.notion.com/reference/request-limits) 限制一次 relation 请求 100 项；[page property values](https://developers.notion.com/reference/page-property-values) 明确数组是整个值的替换。公开写入超过 100 项返回 `RELATION_WRITE_LIMIT`，不得伪造 append 分批覆盖。读取仍必须拿齐 100 项以上集合，清空或缩小大集合允许完整 before 基线后一次写入。

在真实 Notion UI 打开两个根和一个目标，确认正常标题、可点击 Members/Requires、同库关系以及 Skills/Files 扁平 database 记录。保留点击和页面截图与 API readback 分开的证据。仅 read 不做依赖闭包激活；use/inspect、环和预算在 NG-SG-12 验收，不从这一步推定已通过。

清理只使用本 run 记录的原始 create operation 与 owned page IDs；schema 升级属于所选库正式配置，不因测试结束删除字段或历史 Records。保留未知原操作及失败日志。

## NG-SG-08 原生引用与稳定 File ID

先走既有 Launch/Doctor/Evidence，使用本 run 的 owned Skill 与 Files。真实页面编辑、API readback、受控测试分别留证；受控 block fixture 不算真实 Notion UI 点击通过。

### 受控公开消费链

运行以下测试，保留退出码和原始输出：

~~~bash
bun test packages/core/test/shared-native-references.test.ts packages/core/test/shared-native-reference-consumption.test.ts packages/core/test/shared-native-file-content.test.ts packages/core/test/shared-snapshot.test.ts packages/core/test/shared-target-snapshot.test.ts packages/core/test/shared-snapshot-history.test.ts packages/core/test/shared-history-workflow.test.ts packages/core/test/shared-file-management.test.ts packages/core/test/ref-archive.test.ts packages/core/test/typed-links-code-label.test.ts
~~~

检查 mention、普通 page link 和真实类型为 `link_to_page` 的 block。[Notion v2 Markdown](https://developers.notion.com/guides/data-apis/notion-flavored-markdown) 的 `<page>` 默认是子页；只有原 block 证据中的 Link to page 才能将它编译为引用。按需读取当前正文中有歧义标签的 block tree，不读取子页正文，不对所有文件无条件扫描 block。

目录 `native_references` 包含 `parent_id`、`parser_version`、每个源文件的原始 `body_sha256` 与投影输入 `input_sha256`、关系摘要 `relations_sha256` 和完整目录 `index_sha256`。已编译条目包含准确 library/Skill/page 身份；File 条目另含 owner 和稳定 `file_id`，公开 ref 使用 `?file_id=…`。跨 owner 资源只确认 metadata，标为 `metadata_only`；实际读取仍验证目标完整 snapshot，不能把 Files 的 Status 展示列当成权威 ownership。

验证 fenced/native inline code、嵌套代码围栏、script 字符串、转义 mention、裸名和 `../<name>` 模板不会形成引用。重复 Skill ID/File ID、多个 owner、错误 data source 必须明确失败。未受管或不可见 Notion 目标列为 `unmanaged_or_unavailable` 并保留原链接，普通外链不抓取、不注册。引用目录不新增 Requires、不激活目标、不下载目标正文。

### 实际 Notion 与公开命令

在 owned 根中分别插入原生页面 mention、普通页面链接和 UI 的 Link to page，目标覆盖同库 Skill、同 owner File、其他 owner File。保存原目标 URL、page/File/owner ID、父正文原始 hash 和 UI 点击证据。保留一个未受管普通链接与一个代码中的相同 URL。

~~~bash
node "$CLI_BIN" read "$OWNED_SKILL_PAGE" --refresh --metrics > "$RUN/evidence/native-reference-read.json"
node "$CLI_BIN" read "$EXACT_FILE_REF" --metrics > "$RUN/evidence/native-resource-read.json"
node "$CLI_BIN" export "$PARENT_PIN_REF" --projection snapshot --format zip --output "$RUN/evidence/native-reference.zip"
node "$CLI_BIN" read "$PARENT_PIN_REF" --offline > "$RUN/evidence/native-reference-pin.json"
~~~

所有 ref 从本 run 的读取回执取值。确认主文内有可读链接和轻量目录，资源独立读取的 owner/File ID、字节数与 hash 均准确。修改父正文中的真实链接后，只有当前目录更新；旧 pin 字节、目录和旧快照 JSON 不变。改变 Members/Requires 时关系摘要变化，但链接不会反向变为 Requires。

通过公开文件 move 改变资源路径并在原路径放置另一个 File；旧的未固定 ref 必须按 File ID 读取移动后的当前文件。带 snapshot 的 ref 必须使用对应历史绑定；缺失 File ID 或旧快照未含绑定应明确失败，不能按同名/旧路径回退。`read --from` 从移动后的实际路径解析相对引用。删除或失去目标访问权限时同样不能读到同名替身。

显式保存 parent 的 Records 历史，清空本机对应缓存后恢复，比较原始目录及完整文件字节。没有新可选字段的旧 pin 保持原 manifest 形状并可用原 path ref 读取。这里保留的是父 snapshot 的目录；跨 Skill 完整闭包版本向量在 NG-SG-17 另验，不把这一步当成闭包历史通过。

清理只处理本 run 的 owned 操作和对象；保留原始失败、未知派发、原生 URL、安装包身份和完整测试日志，不修改生产 Pstack 的普通外链来迎合运行时。

## NG-SG-12 统一 prepare 与必需闭包

沿既有 Launch/Doctor/Evidence/Cleanup，先确认所选 shared library 的原生 Requires schema 已显式注册。使用同一个已安装 CLI、明确授权 scope 和本 run 的 exact roots；把控制夹具、真实 Notion 回读和 Broker 首次 provider 注入分别留证。

### 公开入口与协议

~~~bash
node "$CLI_BIN" schema prepare > "$RUN/evidence/prepare-schema.json"
node "$CLI_BIN" prepare --help > "$RUN/evidence/prepare-help.txt"
node "$CLI_BIN" prepare "$ROOT_REF" --purpose inspect --metrics > "$RUN/evidence/prepare-inspect.json"
node "$CLI_BIN" prepare "$ROOT_REF" "$SECOND_ROOT_REF" --purpose use --metrics > "$RUN/evidence/prepare-use.json"
node "$CLI_BIN" prepare "$ROOT_REF" --purpose use --session-bindings "$RUN/evidence/session-bindings.json" --refresh --metrics > "$RUN/evidence/prepare-extend.json"
~~~

`ROOT_REF`/`SECOND_ROOT_REF` 必须来自本 run 的准确 canonical ID、page URL/UUID 或固定主文 ref；不允许猜裸名，不以资源 ref 作为主文激活。`--purpose` 默认 `use`。将成功响应的 `session_bindings` 数组原样保存到该 JSON 文件；每项包含完整 `record`、`scope`、`snapshot_id`、`version_id`、`body_sha256` 和固定主文 `ref`。已有绑定优先，`--refresh`、`--max-age` 只影响新增身份；offline 从当前凭据的缓存 scope 验证绑定。在线 prepare 使用当前连接身份核对 scope，不能信任输入文件自报的 scope。缺 pin 不回退 current，显式冲突 pin、record/hash 篡改和另一 owner 冒用同一 snapshot 必须失败。

核心权威 schema 位于 `packages/core/src/graph-prepare-model.ts`，由 core 包导出；入口为 `prepareGraph({roots,purpose,sessionBindings?,freshness?,budget?}, {database?})`。`freshness.policy` 取 `default`、`refresh`、`offline`、`max_age`，最后一项须带 `max_age_ms`。CLI 参数 AST 继续由 `schema prepare` 输出，不另写一套参数清单。

成功 JSON 的 `status` 为 `ready`，同时返回 `purpose`、`scope`、`roots[].readiness`、`nodes`、`required`、`required_closure`、`session_bindings`、`graph_lock`、`budget`、`usage`。每个节点带 `roles`（root/required/member/reference）与 `state`：

- `prepared` 包含完整主文 `content`、准确 `path`/`bytes`/`body_sha256`/`binding`、固定 files 清单、`required`、`candidates`、`references` 和 `unresolved_references`。正文与 hash 必须对应同一实际 snapshot。
- `known` 仅是可读目录，不是 selected、loaded、已注入或激活。Native File 的 `metadata_only` 不能提升为正文已可用。
- `failed`/`deferred` 保留准确错误，供未完成结果定位，不充当占位正文。

`use` 仅沿 Requires 递归，根与所有必需 Skill 完成才 ready；`inspect` 只准备根，列出关系目录，`required_closure` 为空且 lock 的 purpose 保持 inspect。成员、正文引用和引用环都不自动展开。Prompt/Router 不允许作为隐式 Requires 节点；显式 Prompt 根仍可检查。资源只返回固定清单，现有 snapshot 读取的资源物化行为不在本切片改变。

`graph_lock.kind = observed_version_vector`，含 scope、purpose、根、Requires 边、所选 bindings 和确定摘要。它描述本次各节点已观察的版本，不宣称 Notion 跨页面事务快照，也不替代完整历史 manifest、会话生命周期或 provider 已投递证明。Broker 必须按 purpose 消费 lock，不能把 inspect ready 当作 use 前置已齐备。

| 预算参数 | 默认值 | 核对方式 |
| --- | ---: | --- |
| `--max-nodes` | 64 | 唯一根/必需身份计数；目录候选不冒充准备节点。 |
| `--max-depth` | 16 | 从根沿 Requires 的边深度；复用节点还要计算其后代高度，零只允许根。 |
| `--max-instruction-bytes` | 1048576 | 每份必读主文的完整 UTF-8 字节数。 |
| `--max-context-bytes` | 262144 | 完整成功 preparation JSON envelope 的 UTF-8 字节数，含正文、目录、固定清单、bindings 和 lock；不含可选请求遥测。 |

预算不足、环、禁用、缺失、权限或版本冲突返回 `ok:false`；`error.details.preparation.status` 为 failed/partial/deferred，保留 `observed_bindings` 和各节点实际状态，不返回可提交的 `graph_lock` 或 `session_bindings`。缺失前置的根必须 not_ready，不能截断正文、丢依赖或把部分结果作为激活成功。原始 admission `retry_after`/`deferred` 细节须透传；CLI 不另套重试。参数错误退出 2，其他 SkillsError 退出 1，取消退出 130；取消沿现有 Effect/Notion request owner 传播。

### 受控与实际验收

~~~bash
bun test packages/core/test/graph-prepare.test.ts --timeout 30000
bun test packages/cli/test/prepare.test.ts --timeout 30000
~~~

core 测试必须覆盖多根菱形去重、稳定版本、准确环路径、缺失 pin、disabled/Prompt、错误 owner、scope/hash 冲突、各预算、较长路径经过已复用子图、队列 deferral、取消和可选引用环。当前共享快照 transport 夹具应证明每个必需正文只读一次，inspect 只读根，Members 与引用目标正文读取数为零；所有网络仍走同一 Notion Service。

CLI 测试必须先构建正式产物，用真实 Node 进程经 StoreLive 写入 SQLite 快照/对象与 scope，再用独立 Node CLI 读取；不能用 MemoryStore 成功替代该边界。可设置 `NTN_SKILLS_PREPARE_EVIDENCE_DIR` 到本 run 外部目录，保留 seed、完整 argv、stdout/stderr、退出码和 HTTP 探针计数。正常 use/inspect/会话绑定、坏参数、缺依赖、上下文预算失败与离线 help/schema 都必须经过该入口。

真实 Notion 验收从 owned 或任务明确授权的根读取一条真实 Requires 闭包，比较每个 binding 的准确 ID/snapshot/main bytes/hash，再读其固定 ref。单根、重复根与多根结果应保持每身份一个版本。选择仅有 Members 的根做 inspect，确认没有候选正文请求。保留失败、原始 pins、源码/安装包身份与 HTTP 账本；仅受控测试或编译成功不能记为真实 Notion/Broker 注入验收通过。

## NG-SG-07 来源刷新字段归属

沿现有 Launch/Doctor/Evidence 流程，先读取 `docs/sources-management.md` 的字段归属矩阵。使用明确的测试目标和完整来源配置；不得将 Pstack 当前成员清单当作允许刷新全部上游的授权，也不得重建关系字段。

~~~bash
NTN_NG07_EVIDENCE_DIR="$RUN/evidence" bun test packages/core/test/shared-source-refresh.test.ts packages/core/test/shared-source-protection.test.ts packages/core/test/shared-source-selection.test.ts packages/core/test/shared-skill-apply.test.ts
NTN_NG07_EVIDENCE_DIR="$RUN/evidence" bun test packages/cli/test/library-source-refresh.test.ts packages/cli/test/library-source-definitions.test.ts
~~~

公开 CLI 回归启动受控 HTTPS registry 和 Notion 服务，运行构建后的 Node 入口；不改变生产认证、不禁用 TLS 校验、不改变请求限流。记录命令、CLI SHA-256、property ID → 完整值、实际 PATCH property keys、每次固定版本的文件 hash 与 ntn poison 调用数。该证据类型为 `controlled_http_public_cli`，不得报告成真实 Notion 或真实上游发布。

先形成 A，再人工添加 Requires/Member、删除一个 Member，然后以公开 prepare/apply 连续推进 B、C。确认目标 PATCH 仅 Source；原关系准确保留，删除项不复活，Tags/未知属性和 View 写请求为零，custom 主文/资源及额外 frontmatter 保留，following 资源推进，A 的源字节和原 snapshot JSON 不变。真实 View 的可见设置仍需单独 UI 读回，不能以受控服务证明其展示行为。

检查 `member_review` 基线明确为 `current_origin_bindings`；新增、缺失、改名只产候选，不改变 Members。用同名不同 ID 的替身复验缺失 Requires 仍失败；在最终 Source PATCH 前注入人工 Requires 编辑，验证只写白名单保留编辑，不声称有 Notion CAS。提供带关系意图的上游输入时刷新仍不得采用其集合。

导出包含可选 `relations` 的原有 portable 清单，ZIP 备份后读取，再通过公开 apply 在同库恢复显式空集合。核对原文件/资源 hash、custom 归属和 source pin，确认未改变的导出文件不触发 native body PATCH。跨库或与显式参数冲突必须在写入前失败；旧无该字段的包与原 v1/v2 refresh 计划保持原语义，未知原操作仍阻止重发。不要新增手工维护的第二份关系 JSON 或推测旧持续管理基线。

保留外部证据与原未知操作。NG-SG-09 对生产 Pstack 的关系校准与只读核对另行记录；本节受控通过不代替生产数据或 UI 点击验收。
