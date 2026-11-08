# Sources：可编辑来源与固定内容分层

## 所有权

Sources 是第四张独立全页面 Database。它拥有来源身份、Provider、Location、Ref、选择范围、显式转换选项、启停与更新策略。Skills 通过 Origin Relation 关联它，并保存 Source Member；现有 Source 属性仍保存精确内容 pin，显示为 Selected Version。Files 继续通过 Skill Relation 确定唯一归属，来源可从该关系显示；不维护另一份可分叉的来源字段。Records 的 Origin Relation 连接来源版本与操作审计，原有归档仍不可变。

| 字段或内容 | 权威来源 | 显式来源刷新可做的修改 |
| --- | --- | --- |
| Selected Version（注册属性 ID 为 Source） | 审阅后的固定候选 | 选择完整验证的固定 Git 清单或保留源；不保存浮动 HEAD |
| following 文件与源资源 | 选中的固定 Source + 原有文件归属事实 | 按新 pin 合成；删除仍在 following 的绑定文件会阻止刷新 |
| custom 主文、资源与额外 frontmatter | Notion 作者与原有 custom 事实 | 保留完整字节；主文中同名额外 frontmatter 覆盖来源默认值 |
| Members / Requires | Notion 作者显式选定的完整关系集合 | 不写入、不重建；空集合也是明确选择 |
| Name / Description / Tags / Enabled / Default Context / 未注册属性 | Notion 作者 | 不写入；源名称差异只进入候选审阅 |
| View 配置 | Notion 数据库 View | 不访问写入端点、不重置 |
| Sources 的 Last Checked / Last Revision / Last Result / Status | 已完成的来源检查及其应用结果 | 完整检查后更新，并明确待确认、已应用、部分或阻塞；失败检查不冒充完成 |
| 历史 pin、归属事件、原始未知操作 | 不可变 Records 与原始操作凭据 | 保留，不把当前可见状态当成未知请求的成功回执 |

目标 Skill 的 PATCH properties 只包含 Source 的注册 ID。Records 只附加该次来源审计所需的 Origin；Sources 状态只使用表中列出的四项。刷新不会把读到的旧整行属性回写，因此在 Source PATCH 前发生的无关关系编辑仍保留。这是字段级写入边界，不是 Notion 原子 compare-and-swap；正文、归属或选中 pin 漂移仍需要重新准备。

Sources 单独保存可编辑配置，Records 保留不可变历史。普通 Skill 消费只依赖当前 pin、文件与已确认归属，不扫描 Sources，也不重新发现分支或成员。缺少所需字节时可以按冻结的 acquisition 位置读取精确 Git 对象、HTTP 资源或保留对象；只有来源管理命令读取可编辑配置并启动候选发现。

## 来源适配

适配器输出统一的完整文件集合、member key 与解析后的 revision。通用 Git acquisition 使用精确 commit/tree，支持 GitHub、GitLab 和自托管 HTTPS/SSH Git，不以 GitHub API 作为领域模型。Registry 复用已有明确版本的资源读取。Linear 使用只读 GraphQL issue/document 到文件的显式映射；updatedAt 加实际字节摘要固定一次观测，并不冒充可回溯的服务端历史版本。

本机认证与共享配置分离。Linear 使用 LINEAR_API_KEY，Git 使用本机正常认证。Shared JSON 不接受 token/password/authorization/header；不保存凭据，不执行脚本，不让 Notion 配置指定任意命令或本机文件路径。

## 工作流

`ctl library sources list/show` 查询可编辑来源；`put --expect FINGERPRINT` 保存完整配置；`bind` 将一个精确 Skill/member 关联来源且不改变当前 pin。`check` 执行只读发现，`fetch` 导出指定成员的完整目录。显式 prepare/apply 将经过核对的版本冻结到 Records 后选择它；用户 custom 正文、旧 pin 和未结清操作不被来源更新覆盖。

存在“显示配置已改，但当前选择仍是原固定版本”的正常状态。更改 Sources 不自动更新正文；Disable 来源也不删除已发布内容。源配置、成员或当前 pin 在预演后变化必须重新准备。复杂旧共享发布标签留存但不能重新激活旧发布器；不支持的执行选项明确失败，不能静默丢弃。

## 数据库迁入约束

从保留的原始记录恢复 Sources 行时，原档案仍留在 Records。先建立稳定 ID 与关系，再逐项核对 Skill 的来源和成员；原生主文、支持页、资源包、custom/following 事件及旧 pin 不变。以当前完整审计报告计数，不把历史配置数量当作当前库存。已有来源过滤 View 需按审阅后的计划切到 Origin 关系；旧归档关系仍可解释历史。Sources、Skills、Files、Records 均在指定父页下，内部身份不依赖表名。

## 验证边界

来源列表必须完整分页，长配置需完整属性读取，重复 Source ID 或多重 Origin 不能以第一条兜底。核心、Node SQLite、公开 CLI、独立安装与真实服务分别留证。每次运行都使用明确 Source 和目标范围；真实外部 Provider 与受控测试分别报告。

## 日常命令

`ENTRY` 始终是 Skills 数据库 ID，不是 Sources 表 ID；`SOURCE` 可用稳定 Source ID 或来源页面 ID。

```bash
# 只发现、读取管理配置；members 走完整正向关系查询
ntn-skills ctl library sources list --entry ENTRY
ntn-skills ctl library sources show SOURCE --entry ENTRY
ntn-skills ctl library sources members SOURCE --entry ENTRY
ntn-skills ctl library sources providers

# 读取上游候选，不改变 Notion 正文、当前 pin 或来源状态
ntn-skills ctl library sources check SOURCE --entry ENTRY
ntn-skills ctl library sources fetch SOURCE --entry ENTRY --member skills/example --output ./source-files

# 保存完整来源配置；已有条目使用 show 返回的 fingerprint
ntn-skills ctl library sources put --entry ENTRY --input ./source.json --expect FINGERPRINT --dry-run
ntn-skills ctl library sources put --entry ENTRY --input ./source.json --expect FINGERPRINT

# 精确绑定，不改变当前文件内容；首次绑定期望值为 none
ntn-skills ctl library sources bind SOURCE --entry ENTRY --target SKILL_PAGE_ID --member skills/example --expect-origin none

# 单个已绑定 Skill 的显式版本推进
ntn-skills ctl library sources prepare SOURCE --entry ENTRY --target SKILL_PAGE_ID --output ./refresh.json
ntn-skills ctl library sources apply ./refresh.json --entry ENTRY --dry-run
ntn-skills ctl library sources apply ./refresh.json --entry ENTRY

# 原始选择操作核对；不重发写入
ntn-skills ctl library sources reconcile ./refresh.json --entry ENTRY
```

`prepare` 会读取完整上游候选、当前自定义正文和绑定，并将待选字节写入私有本地计划。计划包含资源，可能有敏感业务内容；不要上传到公开仓库。`apply` 不再次追逐分支，用原计划中的字节、fingerprint、member、当前 pin 和快照核对后执行。内容变化需重新准备；未知写入继续核对原操作，不能通过改输入强行重发。普通 `read/files/export` 仍使用同一固定快照接口。

成功 `apply` 可以反馈该次显式推进。有限的 `run --mode policy` 在完整检查后反馈检查时间、精确修订、可取得的提交时间、应用状态和保留的自定义路径；即使需要确认，也能区分“检查完成”和“内容已应用”。`check/fetch`、`run --mode check` 和 `run --mode prepare` 保持远端只读。Router 的 Members/Requires、启停和分类不由来源检查重建。

`check` 与新建 `prepare` 返回 `member_review`，按精确 Source Member key 比较当前完整 Origin 绑定与上游候选，列出新增、缺失和待确认映射。这个比较基线是当前来源绑定，不是历史上游目录，也不是作者的 Members。缺失项要求明确决策；不能按显示名替换或清空 Requires。新增成员通过 `admit` 或完整库存导入计划接纳。来源刷新忽略上游包里的关系字段，不能通过来源内容取得修改本地关系的权限。

当前来源工作流没有持续托管 Members 的模式。旧发布档案及其中的 baseline、显式 add/remove 和未结清操作继续保留，不能从当前差异猜造旧 baseline，也不能据此恢复旧发布器。若迁入的旧工作流仍声称持续管理成员，先审阅它的完整基线和增删意图，再明确选择当前 Notion 集合；不提供隐式 reseed 或自动跟随。

### 一次检查完整来源，按原计划推进

`--all-bound` 冻结该 Source 的完整 Origin 成员观察，并为启用的 Skill 形成逐项候选。上游只获取一次；未启用的绑定仍参与成员和重复身份检查。它与 `--target` 互斥。

```bash
ntn-skills ctl library sources prepare SOURCE --entry ENTRY --all-bound --output ./source-batch.json
ntn-skills ctl library sources apply ./source-batch.json --entry ENTRY --dry-run
ntn-skills ctl library sources apply ./source-batch.json --entry ENTRY
ntn-skills ctl library sources reconcile ./source-batch.json --entry ENTRY
```

批次保存来源配置指纹、成员清单、每项原选择与原操作。结果逐项报告；一项未知不会把其他项改成成功，也不会重建整批。来源状态反馈和内容推进是两个独立结果。`reconcile` 只核对原操作；当前 Source 值恰好等于目标值，不能证明响应丢失的请求已成功。

`--storage auto` 默认将未转换、完整且可公开直接读取的 GitHub 树保存为固定 Git 清单；它包含精确 commit/tree、Git blob OID、字节数、已验证的 SHA-256 和执行模式。其他已支持输入使用保留源。`--storage fixed-git` 要求满足直接读取条件，失败时不会悄悄改策略；`--storage retained` 明确保留完整资源。LFS 指针、子模块、不可读取对象或不完整成员不能形成完整候选。

### 有限运行与策略

```bash
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode check
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode prepare --output ./candidate.json
ntn-skills ctl library sources run SOURCE --entry ENTRY --all-bound --mode policy --due \
  --max-requests 2000 --max-bytes 134217728 --duration-ms 300000
ntn-skills ctl library sources run-list
ntn-skills ctl library sources run-status SOURCE_RUN_ID --output ./original-candidate.json
```

每次 `run` 都有确定终点和本地 run ID。`check` 只检查，`prepare` 形成只读候选，`policy` 按来源配置执行：禁用来源跳过；`pinned` 不重新发现上游；`manual` 保留待确认候选；`auto` 只推进满足当前保护条件的候选。`--due` 以 `options.check_interval_ms` 判断是否到期，最小一分钟，最大 366 天；`auto` 配置必须明确提供该间隔。

启用来源中的已登记文件请求，即使没有新 commit、尚未到期或策略为 pinned，仍会在 `policy` 运行中处理。请求和结果分别保留；受保护条件阻塞的请求不会消失。来源检查不会安装定时器、守护进程或 webhook。

默认预算为 2,000 次实际 HTTP 尝试、128 MiB HTTP payload 和五分钟总时长。重试计入次数，排队与等待计入时长；已放行响应造成的字节超额会如实报告。Git 子进程受超时和整次调用期限约束，其传输字节不冒充 HTTP 计量。相同 state root 内同库使用本地写锁；跨机器仍须安排单一管理写入者，这不是 Notion 原子事务或跨机器锁。

`run-status` / `run-list` 完全离线。仍处于 running 的 checkpoint 可能是运行中或被中断；请求计量仅是最近持久 checkpoint 的下界。预算暂停保留已冻结计划和逐项结果。恢复先导出原计划并 `reconcile`，不能将新运行当作原未知请求未派发的证明。

| 退出码 | `sources run` / `run-status` 含义 |
| --- | --- |
| 0 | 调用完成，没有阻塞或未知工作；检查或手动候选完成不表示已应用 |
| 3 | 有需要审阅、阻塞或失败的逐项结果 |
| 4 | 原结果未知或调用尚不完整 |
| 75 | 预算暂停，保留原计划与 checkpoint |
| 1 | 执行失败 |
| 2 | 参数错误 |

现有 Notion API 没有已证实的正文原子前置条件。自动运行遇到需要替换的可编辑正文时返回 `BODY_REPLACEMENT_UNSAFE`；需要建立的新 Markdown 页面返回 `INITIAL_PROJECTION_REQUIRED`。这类项不能报告为“Notion 页面已同步”。选择版本、实际页面表示、自定义基线与会话 pin 是不同状态，可用 `ctl library state` 核对。

### 显式接纳和成员变化

```bash
ntn-skills ctl library sources admit SOURCE --entry ENTRY --member EXACT_MEMBER \
  --skill-id NEW_STABLE_ID --output ./admission.json
ntn-skills ctl library sources admit-apply ./admission.json --entry ENTRY --dry-run
ntn-skills ctl library sources admit-apply ./admission.json --entry ENTRY
ntn-skills ctl library sources admit-reconcile ./admission.json --entry ENTRY

ntn-skills ctl library sources member-prepare SOURCE --entry ENTRY --target SKILL_PAGE_ID \
  --member EXACT_NEW_MEMBER --output ./member-decision.json
ntn-skills ctl library sources member-apply ./member-decision.json --entry ENTRY
ntn-skills ctl library sources member-reconcile ./member-decision.json --entry ENTRY
```

`admit` 使用现有创建事务保存完整输入、建立可读 Markdown 页与资源，并验证完整目录。默认新条目保持禁用；只有准备时显式 `--enable` 才在验证后启用。已存在的相同 Source/member，包括禁用条目，不能重复创建。来源提供的 Members/Requires 不获得本库关系写权限。

若旧 v1 固定 Git 接纳计划采用 v8 投影，原主页 POST 已收到持久化 ACK，却在保存创建清单前因已知的文档空白差异中断，可审阅同一原操作的有限恢复：

```bash
ntn-skills ctl library sources recovery review ./admission.json --entry ENTRY \
  --target ORIGINAL_MAIN_PAGE_ID --output ./recovery-review.json
ntn-skills ctl library sources recovery apply ./admission.json --entry ENTRY \
  --review ./recovery-review.json --review-id REVIEW_ID --dry-run
ntn-skills ctl library sources recovery apply ./admission.json --entry ENTRY \
  --review ./recovery-review.json --review-id REVIEW_ID
ntn-skills ctl library sources recovery reconcile ./admission.json --entry ENTRY \
  --target ORIGINAL_MAIN_PAGE_ID
```

先检查 `review` 返回的完整决定、`review_id` 和 dry-run 写入上界，再执行原决定。首次恢复要求原凭据范围内的完整本地 journal 与匹配 ACK、原主页仍禁用、Source 与身份未变，以及完整当前正文恰好符合独立冻结的 v9 预测。恢复保留原输入、请求正文与主页，只创建原计划尚未派发的支持页，并另存恢复事实；不会修改已有正文或补造原创建结果。缺失 ACK、未知请求、人工正文变化或额外原始派发均保持待核对，不能靠换页、改计划或重试绕过。已开始的恢复再次调用只核对原结果；完成后仍须重新读取当前快照。

确认上游已移除成员而要保留当前内容时，使用 `member-prepare ... --retain-removed`，与 `--member` 互斥。它只解除后续发现绑定，保留 Selected Version、自定义正文、资源、用户关系和历史 pin。明确重新绑定也不自动切换内容版本。相似名字或字节不会自动生成改名映射。

完整本地 Skill 的三类导入、逐项授权与源树漂移检查见[库存审计与导入](inventory-import.md)。

### 导出与重导入关系

同库 Skill 的现有 `.ntn-skills.json` 可携带可选 `relations`，包含 `ownership: "notion"`、稳定 `library_id` 以及明确的 `members` / `requires` 逻辑 Skill ID 集合。空数组保留删除意图，省略字段不产生覆盖请求。目录导出、ZIP 备份和读取该包使用同一清单，不需要手工维护额外关系 JSON；没有此字段的旧 v2 包保持原有格式与行为。

显式导入或 `apply --input` 才会把该集合交给现有冻结元数据计划。所有目标仍按同库 Library + Skill 身份解析；跨库、缺失目标、同名替身以及与显式关系参数冲突的集合在写入前失败。完整导出中未改变的文件不会被重新写成 native custom：源资源、额外 frontmatter 与原归属保持。改变的正文仍受原生作者入口的完整校验约束；重导入不是跨库克隆或任意 frontmatter 编辑接口。

## 配置示例

以下 GitLab 配置也可换成 GitHub 或自托管 Git 地址。名称是来源标签，不会覆盖已绑定 Skill 的人类标题。

```json
{
  "version": 1,
  "source_id": "team-skills",
  "name": "Team Skills",
  "description": "Reusable workflows maintained by the team.",
  "enabled": true,
  "policy": "manual",
  "adapter": {
    "type": "git",
    "url": "https://gitlab.example.com/team/skills.git",
    "ref": "main"
  },
  "selection": {
    "roots": ["skills"],
    "include": [],
    "exclude": [],
    "mapping": {}
  },
  "options": {}
}
```

新建使用 `--expect absent`。`policy=pinned` 的 Git 配置必须指定完整 commit；`manual` 允许分支，并在明确的检查或准备中解析当前 commit。`auto` 使用同样的冻结候选，再由有限 `run --mode policy` 按保护条件推进；配置例如 `"options": { "check_interval_ms": 3600000 }`。保留的 `accepted_ref` 是额外固定选择，不能在未检查它的情况下把 Ref 展示值当成实际推进版本。HTTP(S)/SSH 是 Git 传输边界；共享配置不能指向 `file://` 或本机目录，私有仓库由本机正常认证读取，并遵守明确的共享保留权限。

Linear 来源明确把 issue/document 映射成文件，主入口必须有 `SKILL.md`；附属文档可保存到任意安全相对路径。凭据不出现在配置中。

```json
{
  "version": 1,
  "source_id": "team-review-linear",
  "name": "team-review",
  "description": "Review a proposal against the maintained checklist.",
  "enabled": true,
  "policy": "manual",
  "adapter": {
    "type": "linear",
    "resources": [
      { "kind": "issue", "id": "TEAM-123", "path": "SKILL.md" },
      { "kind": "document", "id": "11111111-1111-4111-8111-111111111111", "path": "references/checklist.md" }
    ]
  },
  "selection": { "roots": ["."], "include": [], "exclude": [], "mapping": {} },
  "options": {}
}
```

将示例 ID 替换成有权限读取的真实对象。issue 支持精确 identifier 或 UUID；document 使用 UUID。GraphQL 任一错误、缺失正文、返回对象身份不符都会拒绝形成完整来源。读取支持最多80个明确资源，单次响应上限8MiB，有界并发为4；不会根据页面文本递归访问任意链接、执行指令或扫描整座 Linear 工作区。

## 边界与恢复

- 共享管理选择以 Notion 为权威；本地只保存派生缓存和原始写入凭据。已确认的历史配置更新可再次有意调整，未确认请求不可用不同输入绕过。当前协议不提供跨机器写锁或 Notion 原子 compare-and-swap，管理仍需单写者。
- 一个 Skill 的主 Origin/member 明确且唯一。原有 shared_target_set 配置及来源归档被保留；多贡献者合并不能由单来源 refresh 整体覆盖，需要明确的固定 composition。检查和导出来源本身仍可使用。
- `prepare/apply` 针对明确已绑定范围；新成员必须 `admit` 或完整库存导入。取得合法目录不等于任意 Markdown 都能无损写成原生页面，不能丢弃无法表示的文件后启用。
- 自定义文件保持其完整正文；上游删除尚在跟随的原生文件、最终链接破损、文件归属变化和本地权限限制均会阻止更新。二进制/脚本可在完整资源包中消费，不执行，也不强制创建可编辑文本页。
- 原生页面的自动投影回写仍是独立能力：推进当前固定版本不自动覆盖用户看到的 custom 页面。当前读取会按归属合成完整目录。
- 初始化或字段变更采用明确操作，不以显示名推断数据库身份。原3表合同及旧pin可读，日用正式库使用4表；这是原模型升级和历史解释，不是恢复旧Upstream运行链。

## 原始计划的版本

固定 Git refresh v4 保存完整固定清单；保留源继续使用 v3。两者都绑定精确 Source 选择、`member_review` 和同一来源审计，执行复用现有共享元数据日志。保存的 v1/v2/v3 计划继续按原语义核对，不为旧计划制造历史成员基线；失败或未知结果不会因新版本发布被改写。所有原计划分别留证，不把当前 pin 可见当作旧请求成功。候选清单、来源审计和字节块在远端派发前检查单记录限额；长资源使用已有有界分块。

新操作把原请求、成功响应 ACK 和验证结果分别持久化。收到并保存原 ACK 后发生读回失败，可以在后续精确核对中确认原结果。没有原 ACK 的旧未知操作仍保持未知；当前布局或属性相等不能补造回执。
