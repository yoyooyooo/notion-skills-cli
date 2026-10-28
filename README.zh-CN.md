<h1 align="center">ntn-skills</h1>

<p align="center">让 Agent 和终端用上你在 Notion 中维护的工作流。<br>先找到合适的 Skill，再读取指令，整项任务始终使用同一版本。</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#安装">安装</a> · <a href="#快速开始">快速开始</a> · <a href="#常用场景">常用场景</a> · <a href="#接入-agent">接入 Agent</a> · <a href="./docs/README.md">文档</a>
</p>

<p align="center">
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/status-experimental-orange" alt="状态：实验性"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js%2022.22.3%2B%20(22.x)%20or%2024.20.0%2B-green" alt="运行时：Node.js 22.22.3+ (22.x) or 24.20.0+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="许可证：MIT"></a>
</p>

```bash
ntn-skills list
ntn-skills read 'Release Review'
```

`Release Review` 是示例名称，请选择你自己的 `list` 返回的 Skill。npm 安装包、命令和入口 Skill 都叫 **`ntn-skills`**。入口、内容维护与同步三个 Skill 均可通过 `ctl builtin` 独立管理，见[接入 Agent](#接入-agent)。

已发布到 [npm](https://www.npmjs.com/package/ntn-skills)。从源码构建见[贡献指南](CONTRIBUTING.md#development-setup)。

## 它解决什么问题？

你在 Notion 中维护了一组可复用的操作指令，但 Agent 在当前任务里只需要其中几项。`ntn-skills list` 先提供名称和描述，让 Agent 选出适用的工作流，再用 `read` 读取需要的文件，同时把该 Skill 的完整导出保存到本地。

任务执行期间，Notion 内容可能被修改。第一次成功读取会返回一个**快照**，把工作流和附件固定为一个本地版本。任务中持续使用返回的引用。普通未固定版本的读取可复用五分钟内验证过的内容；新任务需要确认远端最新内容时，在当前目标上加 `--refresh`。 已提交内容在 Notion 中的稳定手改可沿同一 current read 路径读取，旧 pinned 快照保持不变；未完成发布仍保留原恢复约束。

对于已提交且源 ZIP 与正文一致的原生 Skill，首次完整校验后会记录本地版本基线。之后普通读取可先核对主页面、引用页、完整包含关系和附件身份；一致时复用完整本地文件，不再逐页读取正文或重复下载源包，结果标记 `freshness.validation="metadata"`。修改时间未变化的编辑可能被快检漏过；`--refresh` 或显式 `--max-age 0` 始终完整校验正文和资源。新机器或没有基线时先走完整读取。详见[读取策略](docs/protocol.md#read-policy-and-cache-management)。

| 你想做什么 | 使用的命令 |
| --- | --- |
| 找到工作流，避免一次加载整座库的正文 | `list` |
| 从同一版本读取指令和附件 | `read`，再用 `files` |
| 在本地文件和 Notion 之间迁移完整 Skill | `create`、`replace`、`export` |
| 对固定页面一次应用文件和属性变更 | `apply` |
| 将 Git Skills 订阅到 Notion 并持续更新 | `sync upstream connect`、`sync upstream run` |
| 同步已有 Notion 页面与本地 Skill 目录 | `sync local connect`、`sync local run` |

## 安装

安装 [Node.js](https://nodejs.org) **22.x 分支的 22.22.3+，或 24.20.0+**，其中包含 npm。在线操作还需要支持 `api --notion-version` 的[官方 Notion CLI](https://developers.notion.com/cli) **`ntn`**；本项目已使用 `ntn` 0.22.12 验证。

从官方 npm registry 安装已发布版本：

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

版本命令输出已安装版本；帮助列出可用命令。使用者需要 Node.js 和 npm。[项目内安装](docs/usage.md#install-in-a-consuming-project)、[PATH 配置](docs/usage.md#install-from-npm-globally)与[本地 tarball 安装](docs/usage.md#install-a-local-tarball-globally)见使用指南。

需要自行生成安装包时，按[贡献指南中的开发与构建步骤](CONTRIBUTING.md#development-setup) 操作。Bun 用于安装依赖和构建；开发 CLI 与真实 SQLite 消费者均由 Node.js 执行。

## 快速开始

### 1. 连接 Notion

按[官方认证指南](https://developers.notion.com/cli/get-started/authentication) 配置 `ntn`。连接需要 Read content 权限，并能访问具备 `Description` 和 `References` 两个富文本属性的数据库。`References` 保存 Notion 页面提及或页面链接，CLI 将这些页面转成 `references/` 下的 Markdown。已有原生 Skills 数据库及其导出模式也可继续使用。

数据库中至少需要一个有效 Skill。Notion Name 和作者填写的 frontmatter `name` 是人类可读的名称，按原值保留；允许 Unicode、数字、空格和连字符，名称必须非空且不含控制字符。例如，`Tty7` 保持为 `Tty7`，调用别名为 `tty7`。别名按 NFC 规范化并转为小写，去掉首尾空白，将连续空白替换为 `-`，对 Unicode 字母、组合标记、数字、`_` 和 `-` 以外的字符做百分号编码。别名只用于选择，不是身份；冲突时须使用精确页面 ID 或引用。`--name` 显式覆盖人类标题，不改变页面身份。[命名与数据库要求](docs/protocol.md#identity-and-references)。

`ctl database init --parent PAGE_ID` 会在自有父页下创建内容表与独立的上游订阅表；接入已有两表时使用 `--content-database ID --upstream-database ID`。命令先验证字段类型和原生关系目标，通过读回后才保存配置；同一目标可安全重入。普通默认写入库独立，只有显式 `--set-default` 才改变。

内容来源使用独立的 `Source Type`（`builtin`、`upstream`、`manual`）与保存精确包 ID 的 rich-text `Builtin ID`，不与 Kind 或 Sync Mode 混用。显式 init 可升级已有两表，包括重复已发布的 attach operation；不会回填旧记录。普通 create 兼容缺少字段的旧表，replace/write 保留来源。builtin/upstream 发布要求先升级字段。正文相同而来源不同只更新元数据；全部一致时无远端修改地复用。详见[来源与冻结恢复协议](docs/protocol.md)。

用 `ntn-skills sync upstream connect SOURCE --database DATABASE` 注册 Git 来源并同步其中的 Skills；重复相同连接会复用订阅。后续 `sync upstream run` 使用可重复的 `--target SUBSCRIPTION_ID` 或 `--all`，二选一。每次运行记录同步状态、尝试与成功时间及摘要；失败或部分完成时继续其他目标，并以非零退出码结束。高级注册与 plan/apply 仍位于 `sync upstream`。[持续同步与两表配置](docs/usage.md#recurring-upstream-synchronization)。

普通 `run` 先检查原有未完成工作，再规划新变更；原归属页可读取且确认位于 Notion Trash 时，会恢复受管的 tracked 成员。旧页仍留在 Trash，经过验证的新页替换该成员映射。找不到页面或权限错误会明确失败。历史重建、adopt 和专项修复使用独立的 [operator 工件](docs/historical-operations.md)。

内容表支持 `Kind=skill|router|prompt`：Skill 入口为 `SKILL.md`；Router 入口为 `ROUTER.md`，包含成员元数据与稳定引用，由 Agent 按需读取成员；Prompt 入口为 `PROMPT.md`，每次显式引用都成为本轮用户要求。`list` 返回带 kind、稳定身份、locator 和 entrypoint 的 `records`；读取与导出返回同一 `record` 与固定快照。历史缺少 Kind 的条目按 Skill 处理。

创建 Prompt 或 Router 时，先准备 portable v2 manifest 与正文文件，再使用现有 `create` 参数：[完整 Prompt/Router 文件与命令示例](docs/usage.md#creating-a-prompt-or-router-from-portable-v2)。文件名或 frontmatter 不会决定 kind；详见 [portable 输入契约](docs/protocol.md#portable-input-contract)。

上游订阅只有至少两个已验证、已发布的有效 Skill 时才提供自动 Router。零个或一个成员不会产生 Router 目录项；单成员直接使用该 Skill 的引用。当前版本的精确 Router 读取也会拒绝不足两个成员的订阅。内容表中手工编写的 Router 继续按作者设置的 Members 工作，详见[订阅与 Router 用法](docs/usage.md#initialize-content-and-subscription-tables)。

Skill 与 Router 的 `Default Context` 复选框各自独立，缺失或未勾选均为 false。Prompt 始终排除默认发现、后台预取和原生 Skill 安装；下一轮再次选择会重新加入本轮要求。初始化会创建该复选框，但不会自动勾选。

认证优先级为：已保存的 `config.token` → 非空 `NOTION_API_TOKEN` → 已有 `ntn login` 登录态。保存的 token 以明文存入私有配置文件；`ctl config show` 只显示是否已配置。[设置与移除 token](docs/usage.md#authentication)。

### 2. 检查访问权限，选择工作流

```bash
ntn-skills ctl doctor
ntn-skills list
```

有效 Skill 可访问时，`ctl doctor` 应返回 `ok: true`、`authentication: "available"`、大于零的 `skill_count`，以及 `skill_read.available: true`。它实际读取并缓存一个 Skill，验证当前存储模式。`list` 返回元数据和覆盖范围，不加载工作流正文。

Notion Search 可能漏掉数据库。请查看 `coverage`；如果已知数据库，可使用 `ntn-skills list --database 'DATABASE_ID_OR_URL'`，将其中的值替换成实际数据库 ID 或 URL。

### 3. 读取选中的 Skill

从 `records` 中复制一个条目的 `ref`，替换下面的占位值：

```bash
ntn-skills read 'REF_FROM_LIST'
```

成功响应包含 `ok: true`、`content` 中的指令、以 `s_` 开头的 `snapshot_id`，以及包含 `?snapshot=...` 的固定版本 `ref`。`source: "notion"` 表示本次在线验证，`source: "local_cache"` 表示有时间边界的缓存观察。将 `freshness`、引用和快照 ID 保留在任务上下文中；需要确认当前访问权限与远端内容时，对当前引用加 `--refresh`。[响应字段说明](docs/protocol.md#success)。

### 4. 从同一版本读取附件

每一步都用前一个命令返回的实际值替换占位值：

```bash
ntn-skills files 'SNAPSHOT_ID_FROM_READ'
ntn-skills read 'ATTACHMENT_REF_FROM_FILES'
```

用快照 ID 列出**全部**文件；传入某个文件的引用，只会列出那个文件。请选择 `files` 实际返回的附件。它的固定版本引用使用同一个快照，即使没有认证或网络，读取也会返回 `source: "local_snapshot"`。历史版本只能读取本机已经保存过的快照。

二进制附件加上 `--output ./attachment.bin`，再用合适的查看器打开。文本可用 `--lines 10-30` 读取包含首尾的行区间，或用 `--raw` 输出 UTF-8 原文。脚本不会被自动执行。

## 常用场景

### 按领域选择工作流库

为已知数据库注册领域别名，然后明确选择它。执行前替换数据库占位值：

```bash
ntn-skills ctl database register ops --database 'DATABASE_ID_OR_URL'
ntn-skills list --database ops
ntn-skills read 'Release Review' --database ops
```

数据库别名精确匹配，区分大小写。两个数据库存在同名 Skill 时，选择数据库，或使用 `list` 返回的包含页面 ID 的引用。已注册的来源会补充自动发现的范围。[发现、别名与覆盖范围](docs/usage.md#discovery-and-identity)。

### 导入、导出或更新 Skill

Skill 可以来自文件夹、ZIP 或 Markdown 文件。先预览远端变更，再执行：

```bash
ntn-skills create ./my-skill --database ops --dry-run
ntn-skills create ./my-skill --database ops
ntn-skills export 'My Skill' --database ops --output ./my-skill.zip
ntn-skills apply 'PINNED_MAIN_REF_FROM_READ' --input ./changed-files --dry-run
```

`create` 要求名称尚不存在。更新已有页面时，`apply` 针对一个 pinned 主文件 ref 或 snapshot，一次合并变更文件、可重复的 `--remove PATH` 和显式属性参数。`./changed-files` 只放本次新增或修改的文件，其余文件保留；去掉 `--dry-run` 执行已审阅的变更。基线过期会在发布前失败。单独修改文件或属性仍可使用 `write`、`update`。[输入格式、冲突与部分成功的处理](docs/usage.md#creating-importing-exporting-and-updating-skills)。

用 `replace ./my-skill --target 'CURRENT_PAGE_ID_OR_PINNED_MAIN_REF' --database ops --dry-run` 明确替换已有页面。即使导入的名称、描述变化，`--target` 仍保留选定页面身份；目标缺失、不可访问或版本过期时失败，不按导入名称回退或创建新页。

普通导入在目标和替换行为已获授权后，执行一次即可；退出码 0、`ok: true`、`verified: true` 且没有 `dry_run: true` 就是完成标准。CLI 自动读回核对正文、参考页和完整文件身份；有 Files 时同时保留并校验原始字节。日常无需再逐项 read/files/export 验收。这验证的是存储结果，不代表已执行或验证 Skill 工作流本身。

目标是 upstream → Notion，以及当前 Notion → Markdown/缓存 → Agent 两条链路不丢指令、代码、链接和资源，不要求任意 Markdown 与 Notion 无限双向逐字节可逆。原生 Markdown 允许约定的格式归一化，但拒绝指令变化。纯文本 Skill 可显式用 `--storage markdown_files` 存成 Notion 中可编辑的文件代码块；消费读取当前代码正文，不用源 ZIP 掩盖后续编辑。[存储、归一化与恢复契约](docs/protocol.md#mutation-contract)。

### 同步本地分发目录

将 `PAGE_ID` 替换为实际选中的页面 ID。绑定标签是本地配置，与 Skill 调用别名分开。

```bash
ntn-skills sync local connect PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync local run release-review-global
ntn-skills sync local status release-review-global
```

目录尚不存在时从 Notion 初始化；已有目录内容不同时，必须用 `--from local|notion` 明确选择来源。后续运行按已确认的共同基线比较两侧，保留冲突。重复相同连接会复用绑定。原有回执只有在观察确认收敛时才会结清；仍未决的结果保留原 operation ID 和下一步指引。

需要分别审阅计划时，可用高级 `bind`、`plan`、`apply --plan`。执行前重新检查绑定、版本、内容及逻辑路径和真实目标。`status` 默认报告已有观察，`--refresh` 才在线验证；`unbind` 保留内容、基线、计划和回执。符号链接保持原链接，移除或替换的旧字节通过系统废纸篓保留。详见[同步使用说明](docs/usage.md#synchronizing-local-skills)。

### 在 Notion 中维护参考页面

在富文本 `References` 属性中添加页面提及或链接。链接文字写成 `references/guide.md` 时固定本地路径，否则按页面标题生成文件名。正文照常使用 Notion 页面链接；CLI 读取和导出时转换为 `./references/guide.md` 等相对路径。参考文档互相引用时按所在文件目录解析，CLI 写回时恢复 Notion URL。其他网站链接和代码示例保持原样。

`create`、`replace` 将 `references/**/*.md` 创建为可编辑的子页面；`write` 更新对应参考页。导入时移除某个参考文件，会让它退出新快照，原 Notion 页面保留。纯页面库可以不设 `Files`；需要保留原始字节、额外 frontmatter 或非 Markdown 资源时继续保留它。详见 [References 契约](docs/protocol.md#references-pages)。


## 接入 Agent

随包提供三个职责明确的 Skill。让入口 Skill 默认可发现，正文只在任务需要时加载。“官方”指本项目维护。

| Builtin ID | 职责 |
| --- | --- |
| `notion/ntn-skills` | [发现、读取工作流和任务路由](skills/ntn-skills/SKILL.md) |
| `notion/ntn-skills-maintain` | [维护 Notion 内容、References 与可移植副本](skills/notion/ntn-skills-maintain/SKILL.md) |
| `notion/ntn-skills-sync` | [连接来源和本地目录、持续同步并恢复原操作](skills/notion/ntn-skills-sync/SKILL.md) |

启用 Context Broker 后，在 Pi/OMP/Tern 的普通 `$` 发现中选择 `$ntn-skills@builtin`、`$ntn-skills-maintain@builtin` 或 `$ntn-skills-sync@builtin`。随包正文与引用不依赖 Notion 来源或额外本地安装。`/context-broker` 负责会话、View 和刷新；内容任务由选中的 Skill 调用公共 CLI 完成。[随包 Skill 的宿主入口](docs/host-integration.md#bundled-skills-in-hosts)。

CLI 同样可离线检查包内指令。需要为其他消费者保留独立管理的本地副本时，再显式安装：

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills-maintain
ntn-skills ctl builtin install notion/ntn-skills-sync
ntn-skills ctl builtin status
ntn-skills ctl builtin update notion/ntn-skills
```

`install`、`status`、`update` 无需认证，可离线运行。受管文件统一位于 `${XDG_DATA_HOME:-~/.local/share}/ntn-skills/skills/<name>`，默认在 `~/.agents/skills/<name>` 建立软链。可重复传入 `--agent-dir DIR` 增加其他 Agent 根目录，各自的 `DIR/skills/<name>` 都指向同一份安装；已登记目标会保留供后续更新使用。完整文件回执保护本地修改与无归属目录，替换的旧字节进入系统废纸篓。旧版 profile 安装需要独立迁移工件；普通命令保留其内容并明确报冲突。安装后重载或重启宿主以刷新原生发现；升级 npm 包不会自动更新已安装 Skill。Broker 选择的是自己的随包副本；这里的显式本地安装独立更新。[宿主入口](docs/host-integration.md#bundled-skills-in-hosts)。

`ctl builtin export` 仍用于导出可移植副本。发布到 Notion 是独立的在线操作：可选用 `ctl config set builtin_database ops` 配置发布目标，再以 `ctl builtin publish notion/ntn-skills-maintain --dry-run` 预览。首次发布遇到任何同名页都报冲突；明确更新必须用 `--target` 指定页面身份或固定版本基线。远端页面不能靠同名或 publisher 文字获得官方身份。[命令、回执与重名规则](docs/usage.md#optional-official-skills)。

启用 OMP/Pi Context Broker 后，`<ntn-skills-guidance>` 提供实际 CLI 和来源范围。所选 Notion View 决定默认 Skill/Router 的名称和描述，不预载正文。来源配置 `default_view_id` 优先；未配置时使用 API 返回的第一个 View。`Default Context` 只是普通属性，只有 View 的筛选使用它时才影响成员集合。启动可准备目录和快照，但不发起模型请求；用户首次发送时，当前目录在 provider 调用前加入提示词。切换 View 影响下一轮目录，不撤回已读正文。完整 `$` 和未限定 View 的 CLI 发现仍可使用。仅安装入口 Skill 不会安装 Broker。[宿主接入契约](docs/host-integration.md)。

检查或维护 Skill 不会激活其中的指令。宿主仅激活当前任务选择的工作流并保留其新鲜度信息；下载的内容、脚本不会自动执行。

`pi-context-broker` 在独立仓库提供单向 Notion 来源适配器，使用元数据 `list`、页面 ID `read` 和固定快照目录 `export`。所选 View 成员在发现后准备，其他项在选择时准备；消费前不激活其中的指令。消费者保留 scope、coverage 与快照身份，核对导出 `main_path` 与 manifest `main`，再加载真实入口与附件。broker 负责宿主接入，本仓库不安装它或注册宿主钩子。详见 [broker 消费契约](docs/host-integration.md#broker-source-consumption)。源码 checkout 的 verification Skill 提供验收地图；安装包消费者使用公开契约与 CLI。

## 使用边界与本地数据

- 历史本地验证覆盖 macOS arm64 的 Node.js 24.20.0 和 Linux arm64 的 Node.js 22.19.0 上的 npm 安装与预置快照离线行为；后者现已不受支持。真实 Notion 读取使用 macOS 和 `ntn` 0.22.12 验证。CI 配置为 Ubuntu、macOS 15 上的 Node.js 22.22.3 和 24.20.0；工作流配置不代表新变更已运行成功。Windows 未验证。
- 内容写入、`ctl builtin publish` 和同步的 `connect/run/apply` 可能修改内容。发布支持 `--progress` 输出 stderr 阶段与耗时，并保留冻结输入和回执；中断后用 `operation resume OPERATION_ID` 在原发布上继续，无法确认的写入仍明确报错。本地同步检查原有回执，未确认收敛时返回原 operation 和下一步指引。客户端版本检查不等于原子提交。[发布恢复](docs/usage.md#creating-importing-exporting-and-updating-skills)。
- 配置默认位于 `~/.config/ntn-skills/config.json`；快照、上传暂存和同步恢复状态位于 `~/.local/state/ntn-skills`；可丢弃观察缓存位于 `~/.cache/ntn-skills`。受管 builtin 位于 `~/.local/share/ntn-skills`，可用 `NTN_SKILLS_DATA_HOME` 或 XDG 数据根覆盖。正文默认五分钟、目录元数据默认 60 秒；[缓存策略与清理](docs/usage.md#cache-policy-and-cleanup)说明配置及系统废纸篓保留。
- 在线操作通过 `ntn` 和 Notion 的签名下载 URL 完成。未固定版本的离线查找必须能安全确定本地身份范围；官方登录身份可能仍需在线检查。缓存观察不能证明当前权限。CLI 自身不发送遥测请求；`ntn` 有自己的政策。导入的脚本不会自动执行。

详见[配置与存储](docs/protocol.md#environment-and-local-storage)、[错误恢复](docs/protocol.md#errors) 和[安全与隐私](SECURITY.md)。

## 升级与卸载

tarball 安装可获取新版已构建安装包，再执行 npm 安装命令。跨 0.x 次版本升级前，请阅读[变更记录](CHANGELOG.md)。源码构建按[贡献指南](CONTRIBUTING.md#development-setup) 操作。

全局安装用 `npm uninstall --global ntn-skills` 卸载。配置、缓存、保留状态、已安装 builtin 数据与分发软链仍在；保留所需固定版本、同步基线、计划与未完成回执。需要移除已保存的 token 时，在卸载前执行 `ntn-skills ctl config clear-token`。升级保留状态与配置，在独立缓存根重建可丢弃观察；原先假定每次未固定读取都在线的调用者应加 `--refresh`。[卸载与可选保留说明](docs/usage.md#upgrade-and-uninstall)说明应保留哪些数据。

## 文档与贡献

| 下一步 | 文档 |
| --- | --- |
| 安装变体与日常 CLI 操作 | [使用指南](docs/usage.md) |
| 选择器、JSON 输出、存储与错误 | [CLI 与引用契约](docs/protocol.md) |
| 启动时的元数据注入与 Read/Write 适配器 | [宿主接入](docs/host-integration.md) |
| 开发环境与兼容政策 | [贡献指南](CONTRIBUTING.md) |
| 发版与发布结果验证 | [发布流程](docs/releasing.md) |

问题报告和使用咨询请在 [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) 提交脱敏信息；漏洞通过[私下报告渠道](SECURITY.md#reporting-a-vulnerability) 提交。开发或构建 CLI 请从[贡献指南](CONTRIBUTING.md) 开始。

[文档目录](docs/README.md) · [变更记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
