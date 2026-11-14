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

你在 Notion 中维护了一组可复用的操作指令，但 Agent 在当前任务里只需要其中几项。`ntn-skills list` 先提供名称和描述，让 Agent 选出适用的工作流，再用 `read` 读取需要的文件，固定该 Skill 的完整目录和内容身份；脚本、图片等非文档资源可在需要时按同一版本取得。完整 `export` 会核对全部文件。

任务执行期间，Notion 内容可能被修改。第一次成功读取会返回一个**快照**，把工作流和附件固定为一个本地版本。任务中持续使用返回的引用。普通未固定版本的读取可复用五分钟内验证过的内容；新任务需要确认远端最新内容时，在当前目标上加 `--refresh`。 已提交内容在 Notion 中的稳定手改可沿同一 current read 路径读取，旧 pinned 快照保持不变；未完成发布仍保留原恢复约束。

共享库的普通读取会先核对完整 Files 元数据与归属，复用未变化的正文。TTL 到期与独立正文校验期限限制这种复用，避免只依赖页面时间戳。`--refresh` 或显式 `--max-age 0` 在线核对当前 Markdown，无须预取每个未请求的 binary；作者读取和完整导出仍校验所有文件。已保留的 pin 字节可离线读取，缺少的资源只允许按该 pin 的固定来源取得；`--offline` 缺少字节时明确失败。详见[读取策略](docs/protocol.md#read-policy-and-cache-management)。

| 你想做什么 | 使用的命令 |
| --- | --- |
| 找到工作流，避免一次加载整座库的正文 | `list` |
| 从同一版本读取指令和附件 | `read`，再用 `files` |
| 审阅并纳管完整本地 Skill | `ctl library inventory` 的盘点、对账和导入计划 |
| 新建、维护和导出选定 Skill | `create`、`replace`、`export` |
| 对固定页面一次应用文件和属性变更 | `apply` |
| 在共享库管理固定来源并显式更新 | `ctl library sources prepare`、`apply`、`reconcile`、`run` |
| 同步已有 Notion 页面与本地 Skill 目录 | `ctl sync local connect`、`ctl sync local run` |

## 共享库的四张表

当前共享库采用 **Skills / Files / Sources / Records**。Skills 管主文与元数据，Files 打平可编辑支持页，Sources 管可编辑来源配置及关联，Records 保存固定资源、归属和历史。日常 `list/read` 不发现新成员、不追分支 HEAD；缺少资源字节时只从已固定的来源取得。显式来源更新先 `prepare`，再 `apply`，保留自定义文件和旧 pin。GitHub、GitLab、自托管 Git 使用同一 Git 适配边界；Linear 使用显式 issue/document 到文件的映射。完整用法和安全边界见[来源管理](docs/sources-management.md)。

`ctl library init --parent PAGE_ID` 创建新的四表库；既有三表库用 `ctl library sources init --entry ENTRY` 显式升级。已有两表库继续使用其[订阅命令](docs/usage.md#recurring-upstream-synchronization)。

[源码吃狗粮：复用现有 shim 与 Pi 源码入口，无需先发布](CONTRIBUTING.md#direct-source-dogfooding).

## 安装

默认 `ntn-skills` 使用 npm 安装包。开发时可对一次命令设置 `NTN_SKILLS_DEV_ROOT=/绝对路径/源码仓库`，通过薄 Bun 入口直接运行 TypeScript 源码，不重新构建；取消变量就回到安装包。源码模式仍由支持的 Node 运行实际 CLI／SQLite，需要本机已安装 Bun，详见[开发入口](CONTRIBUTING.md#development-setup)。

安装 [Node.js](https://nodejs.org) **22.x 分支的 22.22.3+，或 24.20.0+**，其中包含 npm。安装包通过项目自己的 Effect HTTP 引擎直接连接 Notion API。

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

使用已有 Notion connection 的 `NOTION_API_TOKEN`，或通过可信秘密输入管道执行 `ntn-skills ctl config set-token --stdin`。连接需要所选库的 Read content 权限。References 数据库使用 `Description` 和 `References` 两个富文本属性；每个引用页会成为 `references/` 下的 Markdown。共享的 Skills / Files / Sources / Records 四表库及已有原生 Skills 库也可使用。

数据库中至少需要一个有效 Skill。Notion Name 和作者填写的 frontmatter `name` 是人类可读的名称，按原值保留；允许 Unicode、数字、空格和连字符，名称必须非空且不含控制字符。例如，`Tty7` 保持为 `Tty7`，调用别名为 `tty7`。别名按 NFC 规范化并转为小写，去掉首尾空白，将连续空白替换为 `-`，对 Unicode 字母、组合标记、数字、`_` 和 `-` 以外的字符做百分号编码。别名只用于选择，不是身份；冲突时须使用精确页面 ID 或引用。`--name` 显式覆盖人类标题，不改变页面身份。[命名与数据库要求](docs/protocol.md#identity-and-references)。

新建共享库时，在自有父页下执行 `ntn-skills ctl library init --parent PAGE_ID`。返回的 entry 标识同一套 Skills / Files / Sources / Records 表；消费命令用 `--database`，管理命令用 `--entry`，详见[共享 Notion 库](#共享-notion-库)。

通过 `ctl library sources` 注册和检查来源配置，先准备固定候选，再应用；部分完成或结果未知时沿原计划核对。明确接纳才新增已审阅成员，普通来源更新保留自定义文件与用户成员关系。完整配置和命令见[来源管理指南](docs/sources-management.md)。

已有两表库使用 `ctl database init` 和 `ctl sync upstream`，其适用范围见[两表配置与订阅指南](docs/usage.md#recurring-upstream-synchronization)。本地目录分发继续使用 `ctl sync local`。

内容表支持 `Kind=skill|router|prompt`：Skill 入口为 `SKILL.md`；Router 入口为 `ROUTER.md`，包含成员元数据与稳定引用，由 Agent 按需读取成员；Prompt 入口为 `PROMPT.md`，每次显式引用都成为本轮用户要求。`list` 返回带 kind、稳定身份、locator 和 entrypoint 的 `records`；读取与导出返回同一 `record` 与固定快照。历史缺少 Kind 的条目按 Skill 处理。

创建 Prompt 或 Router 时，先准备 portable v2 manifest 与正文文件，再使用现有 `create` 参数：[完整 Prompt/Router 文件与命令示例](docs/usage.md#creating-a-prompt-or-router-from-portable-v2)。文件名或 frontmatter 不会决定 kind；详见 [portable 输入契约](docs/protocol.md#portable-input-contract)。

Skill 与 Router 的 `Default Context` 复选框各自独立，缺失或未勾选均为 false。Prompt 始终排除默认发现、后台预取和原生 Skill 安装；下一轮再次选择会重新加入本轮要求。初始化会创建该复选框，但不会自动勾选。

认证优先级为：已保存的 `config.token` → 非空 `NOTION_API_TOKEN`；缺少凭据返回 `AUTH_REQUIRED`。保存的 token 以明文存入私有配置文件；`ctl config show` 只显示是否已配置。[设置与移除 token](docs/usage.md#authentication)。

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

## 共享 Notion 库

当前源码构建采用 Skills、Files、Sources、Records 四表模型。Skills 保存主文和原生属性，Files 管理独立文档及原始资源身份，Sources 保存可变的来源配置，Records 保留固定内容、归属与历史。固定 Git 可以按精确 commit 提供资源字节，Notion 仍持有管理事实。实际安装能力以该包的 `--version`、帮助和 schema 为准。

使用目标库实际返回的入口与身份：

```bash
ntn-skills ctl library inspect 'ENTRY_DATABASE_ID'
ntn-skills list --database 'ENTRY_DATABASE_ID'
ntn-skills read 'REF_FROM_LIST' --database 'ENTRY_DATABASE_ID'
ntn-skills create ./my-skill --database 'ENTRY_DATABASE_ID'
ntn-skills apply 'PINNED_MAIN_REF_FROM_READ' --database 'ENTRY_DATABASE_ID' --input ./changed-existing-files --description '更新后的用途'
```

新建库可用 `ctl library init --parent PARENT_PAGE_ID`；它不迁移旧内容或更改默认库。普通 Skill 文件夹不需要手写 manifest。普通 `create` 保持其 UTF-8 输入合同；包含脚本、JSON、图片或 binary 的完整纳管使用[已审阅清单导入](docs/inventory-import.md)，复用同一原始创建日志，默认创建为禁用状态，只有计划明确要求且完整验证通过才启用。共享 `apply` 可在同一原操作中提交原生文件的新增、修改、显式布局变更和指定属性，省略的文件保持不变。`--remove` 指定删除，版本 1 的 `--changes` 清单指定移动、删除和恢复。各子操作顺序执行，后项失败时保留前项已验证的结果。`replace` 对省略文件推导出的混合或多项删除仍会在写入前拒绝。文档生命周期使用 `ctl library file add/delete/move/restore-follow`；原始资源使用 `ctl library resource add/replace/move/delete/restore/undelete`，保留精确字节、稳定身份、已知可执行模式和旧 pin。

已经在 Notion 新建的草稿可保持禁用，补全 Name、Description 并将 Kind 设为 `skill` 后，用 `adopt SKILL_PAGE_ID --database ENTRY_DATABASE_ID` 在原页面登记稳定身份并保留完整正文。随后 `read SKILL_PAGE_ID --authoring` 返回新的编辑 pin；普通修改保留禁用状态，`update SKILL_PAGE_ID --enabled true` 才会在完整验证后启用。尚未登记的禁用草稿不进入消费目录，也不阻断其他 Skill。新增 reference 并在主文加入链接时，可将两份文件一次交给稀疏 `apply`；步骤见[整树维护合同](docs/maintenance-tree-contract.md)。若单独使用 `ctl library file add`，[reference 指南](docs/shared-authoring.md#link-the-new-reference-from-the-original-skill)说明后续如何取得 fresh pin 并修改主文。

共享库使用独立的 **Skills、Files、Records、Sources** 数据库。descriptor 与属性 ID 保存内部身份，显示名变化不影响定位。Notion 管理可编辑正文、元数据与保留历史，本地缓存由这些事实派生。日常用 `--database` 明确选库；裸 `list` 仍是工作区发现。身份、固定版本与恢复边界见[共享架构](docs/shared-ssot-architecture.md)。

正常 current read 完整确认 Notion 正文编辑并保留原操作事实后，将整个文件记为自定义；其他文件继续自己的来源行为。改回原文不恢复跟随，也不要求手工接管标记或旧的整 Skill fork。名称、Description、Default Context 与 Router Members 始终来自 Notion 原生属性。

固定来源先用 `source inspect/register` 登记精确 commit/root，再由 `ctl library source select prepare ... --output PLAN` 生成计划并用 `source select apply PLAN --entry ENTRY` 选择。共享 Profile 可通过 `ctl library profile list/show/set/bind/unbind` 管理；`list --profile PROFILE_ID --database ENTRY` 采用共享默认 View，显式 View 优先，普通 `list` 保持完整发现。

完整操作与恢复入口见[共享库创作指南](docs/shared-authoring.md)、[共享协议](docs/protocol.md#shared-notion-library)和[共享架构](docs/shared-ssot-architecture.md)。完整纳管保留原生资源和固定来源资源；首次未知请求在空客户端不可见等边界仍保留。自动更新若需要替换已有可编辑正文，仍停在 `BODY_REPLACEMENT_UNSAFE`。显式 `restore-follow` 保留完整旧文，以一次完整旧字符串匹配提交，并核对完整返回正文和独立读回后才确认 following；这不提供页面版本 CAS。`file request --submit` 可冻结一份稍后由 `--process` 处理的明确请求，普通 Notion 下拉框只表达意图。显式作者写入保留自己的基线与恢复合同。保留原始操作 ID，统一 `ctl operation` 按原操作类型路由。只有原 shared apply 可在原本地日志和当前保护条件下，通过显式 `resume` 续接已验证前缀之后确实未发送的后缀；其他共享操作与旧 Publication 各自保留原恢复协议。

Pi 使用 Broker 随包的 CLI/SDK，无需额外安装全局 CLI；终端或其他 Agent 需要命令行时再安装独立 CLI。配置见[在 Pi 使用远程 Skill](docs/shared-authoring.md#use-the-remote-skill-in-pi)。创作、检查、使用与资源读取分别有明确合同；读取成功不等于模型已应用指令。发行验证记录 Broker 内嵌 CLI/SDK 与本次测试的独立 CLI 组合、来源范围和观察结果。

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

`create` 要求名称尚不存在。更新已有页面时，`apply` 针对一个 pinned 主文件 ref 或 snapshot，接受原生文件的新增与修改、可重复的 `--remove PATH`、版本 1 的 `--changes` 清单和显式属性参数，省略的文件保留。共享目标可将这些变更合为一份经过完整文件树验证的计划；`replace` 对省略文件推导出的混合或多项删除仍会拒绝。旧 Publication 目标继续使用其完整稀疏替换流程。去掉 `--dry-run` 执行已审阅的变更；基线过期会在写入前失败。单独修改文件或属性仍可使用 `write`、`update`。[输入格式、冲突与部分成功的处理](docs/usage.md#creating-importing-exporting-and-updating-skills)。

用 `replace ./my-skill --target 'CURRENT_PAGE_ID_OR_PINNED_MAIN_REF' --database ops --dry-run` 明确替换已有页面。即使导入的名称、描述变化，`--target` 仍保留选定页面身份；目标缺失、不可访问或版本过期时失败，不按导入名称回退或创建新页。

普通导入在目标和替换行为已获授权后，执行一次即可；退出码 0、`ok: true`、`verified: true` 且没有 `dry_run: true` 就是完成标准。CLI 自动读回核对正文、参考页和完整文件身份；有 Files 时同时保留并校验原始字节。日常无需再逐项 read/files/export 验收。这验证的是存储结果，不代表已执行或验证 Skill 工作流本身。

目标是 upstream → Notion，以及当前 Notion → Markdown/缓存 → Agent 两条链路不丢指令、代码、链接和资源，不要求任意 Markdown 与 Notion 无限双向逐字节可逆。原生 Markdown 允许约定的格式归一化，但拒绝指令变化。旧 Publication 库中的纯文本 Skill 可显式用 `--storage markdown_files` 存成 Notion 中可编辑的文件代码块；消费读取当前代码正文，不用源 ZIP 掩盖后续编辑。[存储、归一化与恢复契约](docs/protocol.md#mutation-contract)。

### 同步本地分发目录

将 `PAGE_ID` 替换为实际选中的页面 ID。绑定标签是本地配置，与 Skill 调用别名分开。

```bash
ntn-skills ctl sync local connect PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills ctl sync local run release-review-global
ntn-skills ctl sync local status release-review-global
```

目录尚不存在时从 Notion 初始化；已有目录内容不同时，必须用 `--from local|notion` 明确选择来源。后续运行按已确认的共同基线比较两侧，保留冲突。重复相同连接会复用绑定。原有回执只有在观察确认收敛时才会结清；仍未决的结果保留原 operation ID 和下一步指引。

需要分别审阅计划时，可用高级 `bind`、`plan`、`apply --plan`。执行前重新检查绑定、版本、内容及逻辑路径和真实目标。`status` 默认报告已有观察，`--refresh` 才在线验证；`unbind` 保留内容、基线、计划和回执。符号链接保持原链接，移除或替换的旧字节通过系统废纸篓保留。详见[同步使用说明](docs/usage.md#synchronizing-local-skills)。

### 在 Notion 中维护参考页面

以下 References 流程适用于旧库；共享库通过原生 Files 关系和上述文件命令维护支持文件。

在富文本 `References` 属性中添加页面提及或链接。链接文字写成 `references/guide.md` 时固定本地路径，否则按页面标题生成文件名。正文照常使用 Notion 页面链接；CLI 读取和导出时转换为 `./references/guide.md` 等相对路径。参考文档互相引用时按所在文件目录解析，CLI 写回时恢复 Notion URL。其他网站链接和代码示例保持原样。

`create`、`replace` 将 `references/**/*.md` 创建为可编辑的子页面；`write` 更新对应参考页。导入时移除某个参考文件，会让它退出新快照，原 Notion 页面保留。纯页面库可以不设 `Files`；需要保留原始字节、额外 frontmatter 或非 Markdown 资源时继续保留它。详见 [References 契约](docs/protocol.md#references-pages)。

## 接入 Agent

随包提供三个职责明确的 Skill。让入口 Skill 默认可发现，正文只在任务需要时加载。“官方”指本项目维护。

| Builtin ID | 职责 |
| --- | --- |
| `notion/ntn-skills` | [发现、读取工作流和任务路由](skills/ntn-skills/SKILL.md) |
| `notion/ntn-skills-maintain` | [维护 Notion 内容、References 与可移植副本](skills/notion/ntn-skills-maintain/SKILL.md) |
| `notion/ntn-skills-sync` | [管理固定来源、Profile 默认与原操作恢复](skills/notion/ntn-skills-sync/SKILL.md) |

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
- 内容写入、`ctl builtin publish` 和同步的 `connect/run/apply` 可能修改内容。旧 Publication 流程支持 `--progress` 输出 stderr 阶段与耗时，并保留冻结输入和回执；中断后按返回指引用 `ctl operation resume OPERATION_ID` 在原发布上继续。共享库使用[各自的恢复入口](docs/shared-authoring.md#handle-an-interrupted-operation)，无法确认的写入仍明确报错。本地同步检查原有回执，未确认收敛时返回原 operation 和下一步指引。客户端版本检查不等于原子提交。[发布恢复](docs/usage.md#creating-importing-exporting-and-updating-skills)。
- 配置默认位于 `~/.config/ntn-skills/config.json`；快照、上传暂存和同步恢复状态位于 `~/.local/state/ntn-skills`；可丢弃观察缓存位于 `~/.cache/ntn-skills`。受管 builtin 位于 `~/.local/share/ntn-skills`，可用 `NTN_SKILLS_DATA_HOME` 或 XDG 数据根覆盖。正文默认五分钟、目录元数据默认 60 秒；[缓存策略与清理](docs/usage.md#cache-policy-and-cleanup)说明配置及系统废纸篓保留。
- 在线操作通过项目自己的 HTTP 引擎和 Notion 签名下载 URL 完成。未固定版本的离线查找必须能安全确定本地凭据范围；缓存观察不能证明当前权限。CLI 不发送遥测请求，导入的脚本不会自动执行。

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
