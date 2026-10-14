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
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js%20%3E%3D%2022.19.0-green" alt="运行时：Node.js >= 22.19.0"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="许可证：MIT"></a>
</p>

```bash
ntn-skills list
ntn-skills read 'Release Review'
```

`Release Review` 是示例名称，请选择你自己的 `list` 返回的 Skill。npm 安装包、命令和引导 Skill 都叫 **`ntn-skills`**。

已发布到 [npm](https://www.npmjs.com/package/ntn-skills)。从源码构建见[贡献指南](CONTRIBUTING.md#development-setup)。

## 它解决什么问题？

你在 Notion 中维护了一组可复用的操作指令，但 Agent 在当前任务里只需要其中几项。`ntn-skills list` 先提供名称和描述，让 Agent 选出适用的工作流，再用 `read` 读取需要的文件，同时把该 Skill 的完整导出保存到本地。

任务执行期间，Notion 内容可能被修改。第一次成功读取会返回一个**快照**，把工作流和附件固定为一个本地版本。任务中持续使用返回的引用。普通未固定版本的读取可复用五分钟内验证过的内容；新任务需要确认远端最新内容时，在当前目标上加 `--refresh`。

| 你想做什么 | 使用的命令 |
| --- | --- |
| 找到工作流，避免一次加载整座库的正文 | `list` |
| 从同一版本读取指令和附件 | `read`，再用 `files` |
| 在本地文件和 Notion 之间迁移完整 Skill | `import`、`export` |
| 明确新增一个 Skill 或替换一个文件 | `create`、`write` |
| 同步已有 Notion 页面与本地 Skill 目录 | `sync bind`、`sync plan`、`sync apply` |

## 安装

安装 [Node.js](https://nodejs.org) **22.19.0 或更新版本**，其中包含 npm。在线操作还需要支持 `api --notion-version` 的[官方 Notion CLI](https://developers.notion.com/cli) **`ntn`**；本项目已使用 `ntn` 0.22.12 验证。

从官方 npm registry 安装已发布版本：

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

版本命令输出已安装版本；帮助列出可用命令。使用者需要 Node.js 和 npm。[项目内安装](docs/usage.md#install-in-a-consuming-project)、[PATH 配置](docs/usage.md#install-from-npm-globally)与[本地 tarball 安装](docs/usage.md#install-a-local-tarball-globally)见使用指南。

需要自行生成安装包时，按[贡献指南中的开发与构建步骤](CONTRIBUTING.md#development-setup) 操作。Bun 用于开发和构建。

## 快速开始

### 1. 连接 Notion

按[官方认证指南](https://developers.notion.com/cli/get-started/authentication) 配置 `ntn`。连接需要 Read content 权限，并能访问具备 `Description` 和 `References` 两个富文本属性的数据库。`References` 保存 Notion 页面提及或页面链接，CLI 将这些页面转成 `references/` 下的 Markdown。已有原生 Skills 数据库及其导出模式也可继续使用。

数据库中至少需要一个有效 Skill。比如，Notion 中的 Name 为 `Release Review`，其导出的 `SKILL.md` 必须包含 `name: release-review`。名称只能用英文字母，单词之间用一个空格，最多 64 个字符；描述和正文可以使用任何语言。[命名与数据库要求](docs/protocol.md#identity-and-references)。

认证优先级为：已保存的 `config.token` → 非空 `NOTION_API_TOKEN` → 已有 `ntn login` 登录态。保存的 token 以明文存入私有配置文件；`config show` 只显示是否已配置。[设置与移除 token](docs/usage.md#authentication)。

### 2. 检查访问权限，选择工作流

```bash
ntn-skills doctor
ntn-skills list
```

有效 Skill 可访问时，`doctor` 应返回 `ok: true`、`authentication: "available"`、大于零的 `skill_count`，以及 `skill_read.available: true`。它实际读取并缓存一个 Skill，验证当前存储模式。`list` 返回元数据和覆盖范围，不加载工作流正文。

Notion Search 可能漏掉数据库。请查看 `coverage`；如果已知数据库，可使用 `ntn-skills list --database 'DATABASE_ID_OR_URL'`，将其中的值替换成实际数据库 ID 或 URL。

### 3. 读取选中的 Skill

从 `skills` 中复制一个条目的 `ref`，替换下面的占位值：

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
ntn-skills source add ops --database 'DATABASE_ID_OR_URL'
ntn-skills list --database ops
ntn-skills read 'Release Review' --database ops
```

数据库别名精确匹配，区分大小写。两个数据库存在同名 Skill 时，选择数据库，或使用 `list` 返回的包含页面 ID 的引用。已注册的来源会补充自动发现的范围。[发现、别名与覆盖范围](docs/usage.md#discovery-and-identity)。

### 导入、导出或更新 Skill

Skill 可以来自文件夹、ZIP 或 Markdown 文件。先预览远端变更，再执行：

```bash
ntn-skills import ./my-skill --database ops --dry-run
ntn-skills import ./my-skill --database ops
ntn-skills export 'My Skill' --database ops --output ./my-skill.zip
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md --dry-run
```

`create` 要求名称尚不存在。`import` 会创建缺失的名称、复用相同内容，或替换已有同名 Skill 的正文、元数据和完整文件集。`write` 只替换一个文件，保留其他文件；确认预览后，去掉 `--dry-run` 执行。固定版本写入会在线核对当前版本，版本已变化就失败。[输入格式、冲突与部分成功的处理](docs/usage.md#creating-importing-exporting-and-updating-skills)。

用 `import ./my-skill --target 'CURRENT_PAGE_ID_OR_PINNED_MAIN_REF' --database ops --dry-run` 明确替换已有页面。即使导入的名称、描述变化，`--target` 仍保留选定页面身份；目标缺失、不可访问或版本过期时失败，不按导入名称回退或创建新页。

### 同步本地分发目录

将 `PAGE_ID`、`PLAN_ID` 替换为实际返回值。绑定标签是本地配置，与 Skill 调用别名分开。

```bash
ntn-skills sync bind PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync plan release-review-global --from notion
ntn-skills sync apply --plan PLAN_ID
ntn-skills sync status release-review-global
ntn-skills sync plan --all --output ./skills-plan.json
ntn-skills sync apply --plan ./skills-plan.json
ntn-skills sync reconcile release-review-global
ntn-skills sync unbind release-review-global --dry-run
```

首次绑定两侧相同时可初始化共同基线；不同或本地普通目录末级尚不存在时，必须用 `--from local|notion` 明确选择初始化来源。后续计划按各绑定已确认的基线判断方向或报告冲突。执行前重新检查绑定、版本、内容、逻辑路径与真实目标；复制计划不能授权在另一台机器或另一绑定执行。`status` 默认只报告本地与已有远端观察，`--refresh` 才在线验证。`reconcile` 检查未完成回执，不重放写入。`unbind` 停用绑定并保留内容、基线、计划和回执。符号链接保留逻辑路径与链接；移除、替换的旧字节通过系统废纸篓保留。详见[同步使用说明](docs/usage.md#synchronizing-local-skills)。

### 在 Notion 中维护参考页面

在富文本 `References` 属性中添加页面提及或链接。链接文字写成 `references/guide.md` 时固定本地路径，否则按页面标题生成文件名。正文照常使用 Notion 页面链接；CLI 读取和导出时转换为 `./references/guide.md` 等相对路径。参考文档互相引用时按所在文件目录解析，CLI 写回时恢复 Notion URL。其他网站链接和代码示例保持原样。

`create`、`import` 将 `references/**/*.md` 创建为可编辑的子页面；`write` 更新对应参考页。导入时移除某个参考文件，会让它退出新快照，原 Notion 页面保留。纯页面库可以不设 `Files`；需要保留原始字节、额外 frontmatter 或非 Markdown 资源时继续保留它。详见 [References 契约](docs/protocol.md#references-pages)。


## 接入 Agent

把[引导 Skill](skills/ntn-skills/SKILL.md) 所在目录复制到 Agent 宿主支持的本地 Skill 目录。它让 Agent 通过终端命令发现元数据、读取选中的工作流，并沿固定版本引用读取附件。

如果希望宿主启动时就知道所有可用工作流，需要启动钩子执行 `ntn-skills list` 并注入返回的元数据。仅安装引导 Skill，并不会在启动时自动暴露远端目录。直接使用 `Read skill://...` 需要宿主适配器；宿主提供终端工具时，即可通过 CLI 接入。[宿主接入契约](docs/host-integration.md)。

检查或维护 Skill 不会激活其中的指令。宿主仅激活当前任务选择的工作流并保留其新鲜度信息；下载的内容、脚本不会自动执行。

## 使用边界与本地数据

- 本地已在 macOS arm64 的 Node.js 24.20.0 和 Linux arm64 的最低 Node.js 22.19.0 验证 npm 安装与预置快照的离线行为；真实 Notion 读取用 macOS 和 `ntn` 0.22.12 验证。CI 已配置 Ubuntu、macOS 15 上的 Node.js 22.19.0 和 24；工作流配置不代表新变更的运行已成功。Windows 未验证。
- 明确执行 `create`、`import`、`write` 或 `sync apply` 会修改内容。版本检查属于客户端预检查；正文、属性和文件由不同请求更新。遇到部分成功或结果未知，先检查目标；未完成同步应先执行 `sync reconcile`，再生成新的执行计划。
- 配置默认位于 `~/.config/ntn-skills/config.json`；快照、上传暂存和同步恢复状态位于 `~/.local/state/ntn-skills`；可丢弃观察缓存位于 `~/.cache/ntn-skills`。正文默认五分钟、目录元数据默认 60 秒；[缓存策略与清理](docs/usage.md#cache-policy-and-cleanup)说明配置及系统废纸篓保留。
- 在线操作通过 `ntn` 和 Notion 的签名下载 URL 完成。未固定版本的离线查找必须能安全确定本地身份范围；官方登录身份可能仍需在线检查。缓存观察不能证明当前权限。CLI 自身不发送遥测请求；`ntn` 有自己的政策。导入的脚本不会自动执行。

详见[配置与存储](docs/protocol.md#environment-and-local-storage)、[错误恢复](docs/protocol.md#errors) 和[安全与隐私](SECURITY.md)。

## 升级与卸载

tarball 安装可获取新版已构建安装包，再执行 npm 安装命令。跨 0.x 次版本升级前，请阅读[变更记录](CHANGELOG.md)。源码构建按[贡献指南](CONTRIBUTING.md#development-setup) 操作。

全局安装用 `npm uninstall --global ntn-skills` 卸载。配置、缓存和保留状态仍在，包括固定版本、同步基线、计划与未完成回执。需要移除已保存的 token 时，在卸载前执行 `ntn-skills config clear-token`。升级保留状态与配置，在独立缓存根重建可丢弃观察；原先假定每次未固定读取都在线的调用者应加 `--refresh`。[卸载与可选保留说明](docs/usage.md#upgrade-and-uninstall)说明应保留哪些数据。

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
