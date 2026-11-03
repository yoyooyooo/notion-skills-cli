# Sources：可编辑来源与固定内容分层

## 所有权

Sources 是第四张独立全页面 Database。它拥有来源身份、Provider、Location、Ref、选择范围、显式转换选项、启停与更新策略。Skills 通过 Origin Relation 关联它，并保存 Source Member；现有 Source 属性仍保存精确内容 pin，显示为 Selected Version。Files 继续通过 Skill Relation 确定唯一归属，来源可从该关系显示；不维护另一份可分叉的来源字段。Records 的 Origin Relation 连接来源版本与操作审计，原有归档仍不可变。

| 字段或内容 | 权威来源 | 显式来源刷新可做的修改 |
| --- | --- | --- |
| Selected Version（注册属性 ID 为 Source） | 审阅后的固定候选 | 仅选择已完整保留并验证的 bundle |
| following 文件与源资源 | 选中的固定 Source + 原有文件归属事实 | 按新 pin 合成；删除仍在 following 的绑定文件会阻止刷新 |
| custom 主文、资源与额外 frontmatter | Notion 作者与原有 custom 事实 | 保留完整字节；主文中同名额外 frontmatter 覆盖来源默认值 |
| Members / Requires | Notion 作者显式选定的完整关系集合 | 不写入、不重建；空集合也是明确选择 |
| Name / Description / Tags / Enabled / Default Context / 未注册属性 | Notion 作者 | 不写入；源名称差异只进入候选审阅 |
| View 配置 | Notion 数据库 View | 不访问写入端点、不重置 |
| Sources 的 Last Checked / Last Revision / Last Result / Status | 已完成的刷新操作 | 验证成功后写这四个注册属性 |
| 历史 pin、归属事件、原始未知操作 | 不可变 Records 与原始操作凭据 | 保留，不把当前可见状态当成未知请求的成功回执 |

目标 Skill 的 PATCH properties 只包含 Source 的注册 ID。Records 只附加该次来源审计所需的 Origin；Sources 状态只使用表中列出的四项。刷新不会把读到的旧整行属性回写，因此在 Source PATCH 前发生的无关关系编辑仍保留。这是字段级写入边界，不是 Notion 原子 compare-and-swap；正文、归属或选中 pin 漂移仍需要重新准备。

比较过两种方案：把活跃配置混入不可变 Records，或独立 Sources。选后者，避免用户编辑配置破坏历史事件，也不把表数当作产品能力约束。普通 Skill 消费只依赖当前 pin、文件与已确认归属，不扫描 Sources、不访问上游；只有明确的来源管理命令读取配置并启动适配器。

## 来源适配

适配器输出统一的完整文件集合、member key 与解析后的 revision。通用 Git acquisition 使用精确 commit/tree，支持 GitHub、GitLab 和自托管 HTTPS/SSH Git，不以 GitHub API 作为领域模型。Registry 复用已有明确版本的资源读取。Linear 使用只读 GraphQL issue/document 到文件的显式映射；updatedAt 加实际字节摘要固定一次观测，并不冒充可回溯的服务端历史版本。

本机认证与共享配置分离。Linear 使用 LINEAR_API_KEY，Git 使用本机正常认证。Shared JSON 不接受 token/password/authorization/header；不保存凭据，不执行脚本，不让 Notion 配置指定任意命令或本机文件路径。

## 工作流

`ctl library sources list/show` 查询可编辑来源；`put --expect FINGERPRINT` 保存完整配置；`bind` 将一个精确 Skill/member 关联来源且不改变当前 pin。`check` 执行只读发现，`fetch` 导出指定成员的完整目录。显式 prepare/apply 将经过核对的版本冻结到 Records 后选择它；用户 custom 正文、旧 pin 和未结清操作不被来源更新覆盖。

存在“显示配置已改，但当前选择仍是原固定版本”的正常状态。更改 Sources 不自动更新正文；Disable 来源也不删除已发布内容。源配置、成员或当前 pin 在预演后变化必须重新准备。复杂旧共享发布标签留存但不能重新激活旧发布器；不支持的执行选项明确失败，不能静默丢弃。

## 数据库迁入约束

原59份配置从保留的原始记录恢复为 Sources 行，原档案仍留在 Records。先建立稳定ID与关系，再核对每个Skill的来源和成员；原生主文、支持页、资源包、custom/following事件及旧pin不变。已有来源过滤View需切到新的Origin关系；旧归档关系只作历史说明且默认隐藏。Sources、Skills、Files、Records均在用户指定父页下，内部身份不依赖表名。

## 验证边界

来源列表必须完整分页，长配置需完整属性读取，重复Source ID或多重Origin不能以第一条兜底。相关核心、Node SQLite、公开CLI、独立安装与真实服务分别留证。新模型不恢复旧Upstream库，也不主动全量抓取或应用59个上游；真实外部Provider与受控测试必须分别报告。

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

成功 `apply` 更新 Sources 的 Last Checked / Last Revision / Last Result，表示最后一次完成验证的显式推进，**不是自动轮询或后台同步状态**。`check/fetch` 是只读操作，不修改这些栏位。一个来源对应多个 Skill 时逐个目标显式推进；Router 的成员索引与正文不被来源检查隐式重建。

`check` 与新建 `prepare` 返回 `member_review`，按精确 Source Member key 比较当前完整 Origin 绑定与上游候选，列出 `added`、`missing`、`renamed`。这个比较基线是当前来源绑定，不是历史上游目录，也不是作者的 Members。缺失项要求人工判断；不能按显示名替换或清空 Requires。新增成员先按普通创建/导入流程建立，再由作者明确接受关系。来源刷新忽略上游包里的关系字段，不能通过来源内容取得修改本地关系的权限。

当前来源工作流没有持续托管 Members 的模式。旧发布档案及其中的 baseline、显式 add/remove 和未结清操作继续保留，不能从当前差异猜造旧 baseline，也不能据此恢复旧发布器。若迁入的旧工作流仍声称持续管理成员，先审阅它的完整基线和增删意图，再明确选择当前 Notion 集合；不提供隐式 reseed 或自动跟随。

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

新建使用 `--expect absent`。`policy=pinned` 的 Git 配置必须指定完整 commit；`manual` 允许分支，但只有显式检查/准备时解析当前 commit。导入保留的 `accepted_ref` 是额外固定选择，不能在未检查它的情况下把 Ref 展示值当成实际推进版本。HTTP(S)/SSH 是 Git 传输边界；共享配置不能指向 `file://` 或本机目录，私有仓库仍由本机正常认证。

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
- `prepare/apply` 针对已绑定 Skill，不会新增或删除整组成员，也不会后台抓取全部59个来源。新增成员先通过正常内容创建/导入明确建立，再绑定；取得合法目录不等于任意 Markdown 都能无损写成原生页面。
- 自定义文件保持其完整正文；上游删除尚在跟随的原生文件、最终链接破损、文件归属变化和本地权限限制均会阻止更新。二进制/脚本可在完整资源包中消费，不执行，也不强制创建可编辑文本页。
- 原生页面的自动投影回写仍是独立能力：推进当前固定版本不自动覆盖用户看到的 custom 页面。当前读取会按归属合成完整目录。
- 初始化或字段变更采用明确操作，不以显示名推断数据库身份。原3表合同及旧pin可读，日用正式库使用4表；这是原模型升级和历史解释，不是恢复旧Upstream运行链。

## 原始计划的版本

当前新建 refresh v3 延续 v2 的精确原生 Source 选择操作，并把只供审阅的 `member_review` 绑定进同一计划摘要和来源审计。执行复用已有共享元数据日志，没有第二套关系同步账本。保存的 v1/v2 计划继续按原语义核对，不为它们制造历史成员基线；失败或未知结果不会因新版本发布被改写。原计划与新计划分别留证，不把当前 pin 可见当作旧请求成功。候选 bundle、来源审计和字节块在任何远端派发之前检查64KiB单记录限额；长资源走现有有界分块，不能通过先写完再发现清单超限。
