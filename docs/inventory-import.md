# 库存审计与完整 Skill 导入

原生库存导入允许 Notion 改变 Markdown 的空行、强调、标题层级和列表包装。
导入保留原始输入，并以首次完整读回的 Notion 正文建立自定义内容基线。
此后 CLI 消费该 Notion 内容，不要求恢复成本地输入的排版。
正文文字、代码及明确链接目标仍做内容检查；截断或未知内容不算完整导入。
脚本、JSON、图片和二进制继续保留原始资源字节和模式。

上游文件的消费合同独立于阅读页。未接管文件继续来自选定的固定来源，
Notion 排版不应改变其 Git 内容身份。本轮新读回策略用于原生库存导入和
无本地自定义覆盖的固定 Git 库存导入。Git 阅读页的实际指纹由初始 following
事件记录，格式差异不会自动接管上游内容。含本地覆盖的混合来源、保留型
Provider 和旧计划暂沿原规则，不能把它们提前算作新策略已经覆盖。

原生导入结果的 `markdown_acceptance` 标明策略、`roundtrip_required: false`
及表示发生变化的路径。`verified` 指实际读回与保留资源、身份和操作结果已核对，
不代表任意 Markdown 的视觉等价或无损双向转换已证明。

## 内容指纹与重复导入

本地盘点同时保留两种摘要。`manifest_sha256` 绑定本次授权范围，包含真实路径；
`input_content_sha256` 只包含入口文件和按相对路径排序的文件清单，每项包含
内容 SHA-256、字节数及模式。目录迁移或枚举顺序不改变内容指纹，文件改动、
增删、改名或执行模式改变则会改变。未完整读取的实体没有可用内容指纹。

原生 `prepare-import` / `prepare-imports` 会在已盘点的精确身份或同名候选中，
读取 Records 已保留的原始导入清单与成功回执。原始文件集指纹相同且原操作完整
成功时，产生 `reuse_import` 计划；执行返回 `status: already_imported`、
`reused: true`、`current_content: unobserved` 和 `remote_writes: 0`。
这个路径不读取当前正文、不追加历史记录，也不覆盖之后在 Notion 上的编辑。
跨目录重导不需要复制上一台机器的导入状态。

该判断证明“这份输入已导入过”，不证明“Notion 当前内容未变”。同名或相同哈希
本身不授予管理权。没有原回执、原操作尚未完成、目标身份不可访问、请求启用已有
条目或输入发生变化时，不能伪装成复用成功；采用原操作恢复或明确的更新命令。
准备后执行还会重新核对当前页面身份及原清单/回执摘要。原生以外的来源导入继续
使用现有固定来源与原操作路径，不能据本项宣称所有来源都支持跨目录自动复用。

Notion 侧复用已有 Records 文件清单、逐文件内容哈希和 `Hash` 校验，没有给每张
表增加另一套需要同步的摘要字段。当前正文/资源摘要、有效消费快照和管理元数据
仍分别用于审计、变更判断与缓存，不与原始输入摘要跨表示直接比较。未来展示用
字段也只能表示最近一次已观察结果，不能凭一个未刷新字段判断远端没有更新。

这些命令把远端审计、本地文件观察和明确的导入计划连接起来。盘点、对账、准备和 dry-run 不写 Notion 内容；只有执行原导入计划才创建已审阅的条目。输入目录和软链始终保留。

先使用 `ntn-skills schema ctl library inventory` 或对应命令的 `--help` 核对当前安装包。此文档描述当前源码接口，不证明旧安装包或任一真实库存已经完成迁入。

## 1. 取得远端基线

只为新建或重复导入准备目录时，使用 `--census`。它完整读取注册表的元数据和关系，
并比较前后两次目录，但不逐个检查现有 Skill 的正文、文件归属或上游资源。
输出明确标记 `skill_states: unobserved`。`inventory remote` 的总体内容覆盖仍可能
是 partial；只有其中的 `visible_registered_census` 完整、稳定，才允许继续准备新建。

```bash
ntn-skills ctl library audit run --entry ENTRY --census --max-requests 500
ntn-skills ctl library inventory remote --audit-run AUDIT_RUN_ID --output ./remote-inventory.json
```

预算暂停时继续原 run，不重新开始扫描。`--census` 不能与 `--all`、`--target`、
content/history 深度或 pin/graph 组合。需要检查已有 Skill 当前内容是否一致时，
仍使用下面的完整审计流程。

`ENTRY` 是已注册共享库的 Skills 数据库入口。完整库审计包括禁用条目、Files 和必要 Records 的反向盘点；不依赖默认 View 中的数量。

```bash
ntn-skills ctl library audit run --entry ENTRY --all --depth content \
  --max-requests 500 --max-bytes 67108864 --duration-ms 120000
ntn-skills ctl library audit resume AUDIT_RUN_ID --max-requests 500
ntn-skills ctl library audit report AUDIT_RUN_ID
ntn-skills ctl library inventory remote --audit-run AUDIT_RUN_ID --output ./remote-inventory.json
```

深度 `metadata` 检查身份、目录、归属和关系；`content` 增加当前正文、有效资源字节和确定性引用；`history` 进一步验证保留对象。用于证明内容一致的库存需要完整 content/history 观察。元数据完整不能代替字节核对。

新报告单独记录 `visible_registered_census`：在已记录的 endpoint、权限和注册表范围内，初始与最终元数据分页、关系读取均完整，且两轮语义摘要一致，才标为完整。它只证明当前凭据可见的注册表，不证明整个工作区不存在其他私有对象，也不证明旧资源内容健康。没有这项事实的旧报告仍可查看，准备新的纳管计划前需要重新取得完整元数据观察。

预算耗尽返回可恢复的同一 run ID；只用 `resume` 继续它。每次恢复可设置新的调用预算，但不能换库、凭据或规则身份。丢失标准输出时，`ctl library audit list` 可离线找回运行。报告保存观察时间区间；Notion 没有为这些分页读取提供全库原子快照。

| 审计退出码 | 含义 |
| --- | --- |
| 0 | 执行完成、覆盖完整且没有 error 发现 |
| 3 | 执行完成、覆盖完整，但存在 error 发现 |
| 4 | 覆盖不完整或尚未完成 |
| 75 | 预算暂停，可恢复 |
| 1 | 执行失败 |
| 2 | 参数错误 |

覆盖、执行状态和发现严重程度是独立字段。完整审计可以发现缺陷；零发现的部分审计也不能证明健康。`report` 与 `inventory remote` 从原运行离线生成结果，不会补做当前网络检查。

## 2. 冻结明确的本地范围

使用绝对路径，重复 `--root` 指定每个已授权入口。只有明确列出的真实目标根可通过软链进入；其他目标仅记录边界。

```bash
ntn-skills ctl library inventory local \
  --root /absolute/skills \
  --root /absolute/host/skills \
  --allow-target /absolute/skills \
  --provenance /absolute/agent-kit/.ak/assets.yaml \
  --provenance /absolute/agent-kit/.ak/install-sources.json \
  --provenance /absolute/agent-kit/.ak/upstreams.json \
  --provenance /absolute/agent-kit/.ak/notion-handoffs.json \
  --max-entries 50000 --max-bytes 536870912 --duration-ms 120000 \
  --output ./local-inventory.json
```

按实际目录选择相关 provenance 文件；不用 AK 的目录无需创建这些文件。AK 模式根来自其 assets 配置，安装键已经包含相对的 `into` 路径。来源标签、文件夹显示名和内容 hash 均不能单独取得旧 Notion 记录的管理权。

观察记录逻辑入口、真实实体、完整相对路径、SHA-256、字节数和执行模式。相同真实实体的多个软链只计一次；物理副本仍有自己的实体和差异。断链、越界资源、缺引用、dirty 状态、项目或包归属及疑似凭据保留在结果中；敏感检测不输出秘密值。

扫描不执行 Skill 脚本，不改原文件或软链，不上传内容。结果 `coverage: partial` 返回 4；超出边界或预算不能被当作“目录中没有其他文件”。可对已授权范围内的一组确定候选形成更小的完整观察，但全局清单中的未扫描、冲突和待授权项仍须保留。

## 3. 对账并审阅确定的身份

```bash
ntn-skills ctl library inventory reconcile --remote REMOTE_INVENTORY_ID \
  --local LOCAL_INVENTORY_ID --output ./inventory-review.json
ntn-skills ctl library inventory review RECONCILIATION_ID
ntn-skills ctl library inventory review RECONCILIATION_ID \
  --remote NEW_REMOTE_INVENTORY_ID --local NEW_LOCAL_INVENTORY_ID
```

对账使用精确页面业务身份，或完整 Source/repository/member/固定修订证据。只同名或只同 hash 会成为审阅候选，不会自动绑定。模式未知或与本地不同，即使字节相同，也不能算作完整一致。新增的远端记录、本地文件变化或 provenance 漂移会使旧对账失效。

每个候选应保留唯一结果：已有且验证一致、待导入、自定义差异、冲突、受限、待授权或失败。只有明确接受的排除可以移出交付范围。离线 `review` 展示历史冻结观察；传入新观察 ID 才能检验它们与原对账是否一致。

## 4. 准备一份完整导入计划

从对账结果选择一个确切 `ENTITY_ID` 和完整 `MANIFEST_SHA256`，明确批准其中全部文件、模式和读取范围。选择以下一种输入类别：

单份新建需要完整的可见注册表元数据，以及重新核对后的所选本地完整文件树。其他对象的旧模式未知、历史缺失或无关目录边界可以继续留在全局 `partial` 清单中，不会被当作本条已处理，也不必阻断这份已审阅的新建。所选实体自己的不完整、敏感文件、身份冲突或无法验证的来源仍会阻塞；`--verify-existing` 还要求精确目标的全部当前字节、模式和归属已经完整核对。

```bash
# 无上游、自有的完整 Skill
ntn-skills ctl library inventory prepare-import --entry ENTRY \
  --review RECONCILIATION_ID --entity ENTITY_ID --approve-manifest MANIFEST_SHA256 \
  --native --output ./import-plan.json

# 有可靠来源身份的纯上游或本地修改副本
ntn-skills ctl library inventory prepare-import --entry ENTRY \
  --review RECONCILIATION_ID --entity ENTITY_ID --approve-manifest MANIFEST_SHA256 \
  --source SOURCE_ID --member EXACT_MEMBER --output ./import-plan.json

# 已有且已证明完全一致的精确记录，只做再次验证
ntn-skills ctl library inventory prepare-import --entry ENTRY \
  --review RECONCILIATION_ID --entity ENTITY_ID --approve-manifest MANIFEST_SHA256 \
  --verify-existing --output ./verify-plan.json
```

新建条目默认保持禁用；只有准备时加 `--enable` 才要求在完整创建验证后启用。已有条目的验证不接受启用请求，不会改变其 Enabled、分类或关系。

纯上游使用明确 Source/member 的完整固定候选；符合直接读取条件的 Git 不默认上传 ZIP。若本地来自旧 commit，工具先用盘点中的固定 C1 比较本地差异，再选择当前检查冻结的 C2。相对于 C1 未改的路径可继续 following；真正改动、新增或删除的路径保留为明确自定义意图。无法证明或取得 C1 时阻塞，不能用 C2 假造原基线。可用 `--baseline-commit` 选择已有 provenance 中的一个完整 commit，但这个参数本身不是来源证据。

原生输入把 Markdown 放到可读页面，其他资源使用 Files 身份和保留对象。完整主文、reference、脚本、JSON、图片、binary、相对引用和模式共同参与验证；不支持的输入会失败，不能退化为仅导入主文。资源大小和 Markdown 表示限制以对应命令帮助为准。

`.ntn-skills.json` 是可选的 portable 容器，不作为额外内容文件上传。其同库、明确的 Members/Requires 集合可以传给原作者内核；省略字段不要求覆盖，空集合保留明确选择。上游提供的关系建议不获得本库写权限。本地 portable 入口、kind 或元数据与所选 Source 合同冲突时必须先解决，不会静默丢弃。

已有精确记录、不可访问的已知身份、同名冲突或相似候选不能通过创建新名称绕过。当前库存入口为已有完全一致项提供 `--verify-existing`；已有内容的修改需另行准备明确的作者或来源计划。

## 5. 执行、恢复和独立核对

```bash
ntn-skills ctl library inventory apply-import ./import-plan.json --entry ENTRY --dry-run
ntn-skills ctl library inventory apply-import ./import-plan.json --entry ENTRY
ntn-skills ctl library inventory reconcile-import ./import-plan.json --entry ENTRY
```

准备计划冻结原库绑定、远端观察、本地清单、来源修订、文件归属和允许的创建集合。执行前重新扫描并通过真实文件描述符读取输入，拒绝新增文件、改动字节、执行权限变化和链接替换；不会因缓存已有相同 hash 就忽略源树变化。计划必须来自同一 state root 的真实准备记录；复制并重算 JSON 摘要不能取得另一份共享授权。

创建复用现有原操作日志。部分结果保留已创建身份与未开始步骤；只有持久原回执支持的已知步骤才能继续。未知请求不重发，不按同名重建。重复已完成计划返回原结果，不再创建 Skill、Files 或相同历史。新工作需重新准备，原未知操作仍需保留。

`reconcile-import` 不读本地源树、不重新发现 Provider、不写远端，只核对原冻结操作。原源树随后改变不妨碍核对既有操作。没有原响应证明时，当前页面恰好匹配也不能补造成功。

真实搬入时，先在授权的小批次执行，再用新的只读 audit、独立安装的 `read/files/export` 和操作前冻结清单核对实际远端字节。导入器自己的 `verified` 结果不能替代这项迁入验收。冷读取使用另一个正常状态目录和现有凭据提供方，不能复制导入器数据库、token 或已填满的资源缓存来证明冷恢复。

计划可能包含全部私有内容，应留在受控目录；不要提交到公开 Git 仓库。此流程不删除本地 Skill，不修改宿主全局投影，不执行脚本，不安装依赖或定时更新。后续的管理权移交另行按已核对身份处理。

## 6. 一次执行已审定的批次

同一库、同一对账中的多个实体可以交给 CLI 串行准备和执行。调用方不必逐项调度 `prepare-import` 和 `apply-import`，也不需要专用 Python 上传或恢复脚本。批次仍使用上面的单项导入内核。

`approved-imports.json` 声明完整的授权集合。每项 `entity_id` 和 `approved_manifest` 来自原本地观察，不能用目录名称代替。

```json
{
  "version": 1,
  "reconciliation_id": "RECONCILIATION_ID",
  "items": [
    {
      "entity_id": "ENTITY_ID",
      "approved_manifest": "MANIFEST_SHA256",
      "decision": { "kind": "native" }
    }
  ]
}
```

来源项的 `decision` 使用 `{"kind":"source","source":"SOURCE_ID","member":"EXACT_MEMBER"}`，必要时增加已有来源证明中的 `baselineCommit`。已有一致项使用 `{"kind":"verify_existing"}`。`enabled` 省略时为 false；已有项不能请求启用。一次最多 1000 个不重复实体。

```bash
ntn-skills ctl library inventory prepare-imports --entry ENTRY \
  --input ./approved-imports.json --output ./import-batch.json
ntn-skills ctl library inventory apply-imports ./import-batch.json --entry ENTRY --dry-run
ntn-skills ctl library inventory apply-imports ./import-batch.json --entry ENTRY \
  --output ./import-attempt-1.json
ntn-skills ctl library inventory reconcile-imports ./import-batch.json --entry ENTRY
```

部分准备失败时，`prepare-imports` 仍保存包含全部原输入及错误的批次，退出码为 4。成功准备的条目可继续执行，失败条目不会从总数中消失。修复准备问题后可对相同授权清单重新准备，旧批次和旧错误保持不变；已经派发的原操作不能靠新批次重建身份。

执行前验证整个批次及全部子计划的本地原始准备记录，然后逐项核对源树并调用现有作者内核。确定的正文不匹配、正文不完整或需要内容审阅，只保留该项失败并继续独立的后续项。未知写入及其他执行错误停止新的派发，剩余项明确为 `not_started`。这不是全库事务，也不提供跨机器分布式锁。

继续执行使用原 `import-batch.json` 和原 state root。已有完成项通过原操作核对，不再创建页面；未完成项仍受原日志的 ACK、未知写入和内容保护限制。未知响应不能因为重跑命令就自动获得再次写入许可。整次调用预算中断时，批次和子操作日志仍是恢复依据，不能把缺少最终标准输出视为零写入。`reconcile-imports` 不读取本地源树、不重新获取 Provider、不写远端。

报告保留每项原身份、计划 ID、结果或原错误，以及 `total`、`confirmed`、`reused`、`preparation_failed`、`failed`、`not_started` 计数。`reused` 是 `confirmed` 的子集，不能再次相加。dry-run 使用 `validated`，不算作导入成功。执行或核对未全部确认时退出 4。输出文件只允许新建或内容相同，后续调用应选择新的报告文件名。

### 用真实输入改进成功率

批次报告表示本次调用结果，不能直接当作当前版本的首次导入成功率。评估需要另外固定候选版本、完整授权样本和执行覆盖，并区分首次无需 Agent 完成、CLI 沿原操作恢复后完成、已有对象复用、需要人工介入、失败与未执行。

技术失败继续保留在授权样本中，权限未决或未批准共享的项单列。不能通过删除 reference、忽略二进制、放宽完整性比较或过滤难例提高比例。修复一类真实问题后，用正式 CLI 复验受影响样本和成功样本；受控服务结果、真实 Notion 结果及历史累计完成数分别记录。

