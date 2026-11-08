# 库存审计与完整 Skill 导入

这些命令把远端审计、本地文件观察和明确的导入计划连接起来。盘点、对账、准备和 dry-run 不写 Notion 内容；只有执行原导入计划才创建已审阅的条目。输入目录和软链始终保留。

先使用 `ntn-skills schema ctl library inventory` 或对应命令的 `--help` 核对当前安装包。此文档描述当前源码接口，不证明旧安装包或任一真实库存已经完成迁入。

## 1. 取得远端基线

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

