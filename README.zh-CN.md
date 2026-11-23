<h1 align="center">Notion Skills</h1>

<p align="center">用 <code>ntn-skills</code> 在 Notion 创建、编辑和使用可复用的 Agent 工作流。</p>

<p align="center">
	<a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a><br>
	<a href="#快速开始">快速开始</a> · <a href="#agent-接入">Agent 接入</a> · <a href="docs/README.md">文档</a>
</p>

把工作流指令和支持文件保存在 Notion 库中。你可以在 Notion 编辑原生 Skill，
从终端或 Agent 发现它们，再加载当前任务需要的工作流。CLI 负责表结构、
文件身份和关联关系。

下面的快速开始会创建四张关联表和一个 `decision-review` Skill。
完成后，你可以打开 Notion 页面编辑指令，也可以通过 CLI 读取同一份内容。
[pi-context-broker](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.zh-CN.md)
提供可选的 Pi 接入。

## 安装

使用 Node.js 22.x 中的 22.23.5+、24.x 中的 24.22.3+，或 26.x 中的 26.13.1+。

```sh
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

本 README 描述 `next` 的实现，已发布包可能早于本分支。
试用当前候选时，按[源码安装说明](CONTRIBUTING.md#development-setup)操作。
使用该源码 checkout 时，将后续示例中的 `ntn-skills` 替换为
`bun run /absolute/notion-skills-cli/scripts/dev.ts`，并填入实际路径。
实际语法以所安装命令的 `--help` 或 `schema COMMAND...` 为准。

## 快速开始

### 1. 授予 CLI 访问 Notion 的权限

创建一个 [Notion 内部连接](https://developers.notion.com/guides/authorization/overview#internal-connection-auth-flow-set-up)，
启用 Read content、Insert content、Update content 权限。
在 Notion 新建一个空页面，通过页面的 **Add connections** 菜单添加这个连接。
保留页面 ID 或 URL，下一步会用到。

CLI 从进程环境读取 `NOTION_API_TOKEN`。如果密码管理器已经提供这个变量，
直接运行 `ntn-skills ctl doctor`。首次在终端设置时，在 Bash 或 Zsh
运行下面这一行，粘贴 token 后按 Enter。输入不会回显：

```sh
read -r -s NOTION_API_TOKEN
```

然后导出变量并检查认证：

```sh
printf '\n'
export NOTION_API_TOKEN
ntn-skills ctl doctor
```

这里的 doctor 只检查认证，还没有检查父页面访问权限。
已保存的 `config.token` 优先于环境变量。如果希望保存 token，
把可信凭据来源的输出通过管道传给 `ctl config set-token --stdin`。
详见[凭据设置](skills/notion/ntn-skills-maintain/references/setup.md#credentials)。

### 2. 创建四表库并保存入口

将占位符替换为刚才空页面的实际 ID 或 URL：

```sh
parent_page='PASTE_AUTHORIZED_PARENT_PAGE_ID_OR_URL'
ntn-skills ctl library init --parent "$parent_page"
```

命令在父页面下创建 Skills、Files、Records 和 Sources。
从 JSON 结果复制 `library.skills.database_id`，保存到 `library_entry`：

```sh
library_entry='PASTE_LIBRARY_SKILLS_DATABASE_ID'
ntn-skills ctl library init --entry "$library_entry"
```

第二条命令验证已登记的表结构。后续管理使用 `--entry`，读取使用 `--database`，
都传这一个 Skills 入口；不需要另外配置其他三张表的 ID。
已有当前库可以直接从 `init --entry` 开始，跳过创建。

初始化成功表示库结构就绪。返回的 `next.argv` 是只读 `list`；
还没有添加第一个 Skill 时，空结果是正常状态。Init 不会复制包内工作流、
创建业务内容、保存本地默认库或配置 Pi。

下一次终端或 Agent 会话中，把 `library_entry` 设为这次保存的同一个 ID，
再传给下面的命令。可选的 `default_database` 配置只提供消费默认库，
管理命令仍要求显式传入 `--entry`。

如果初始化中断，保留原父页、错误、operation ID 和本地状态。
先只读对账；加 `--resume` 才继续原初始化中可确认的未完成步骤。
[初始化恢复说明](skills/notion/ntn-skills-maintain/references/setup.md#interrupted-initialization)
列出了两条命令，以及仍需对账的未知结果边界。

### 3. 创建第一个 Skill

准备一个新目录。`pwd -P` 会解析临时目录别名，让这个输入在 macOS 上也可用：

```sh
skill_dir=$(mktemp -d "${TMPDIR:-/tmp}/ntn-skill.XXXXXX")
skill_dir=$(cd "$skill_dir" && pwd -P)

cat > "$skill_dir/SKILL.md" <<'SKILL'
---
name: decision-review
description: Review a proposed decision before implementation.
---

When reviewing a decision:
1. State the goal and constraints.
2. Compare the proposed choice with one viable alternative.
3. Identify the biggest risk and a concrete next step.
SKILL

ntn-skills ctl library skill create "$skill_dir" \
	--entry "$library_entry" --skill-id decision-review
```

创建成功会报告 `status: "created"` 和 `state: "ready"`。
打开 Skills 表里的 `decision-review` 页面，就能看到可编辑的指令。
Markdown 会成为 Notion 原生正文，非文本支持文件保留精确资源原件。
内部字段由 CLI 填写。

### 4. 发现并读取它

```sh
ntn-skills list --database "$library_entry" \
	--query decision-review --refresh --json
```

从 `records` 找到这条记录，复制实际返回的 `ref`：

```sh
skill_ref='PASTE_REF_FROM_LIST'
ntn-skills read "$skill_ref" --database "$library_entry" --refresh --json
```

检查 `path` 为 `SKILL.md`，`content` 包含完整指令。
之后可以直接在 Notion 编辑原生页面，再用 `--refresh` 读取。
原生编辑无需额外生成阅读投影。

`read` 用于查看。需要 Agent 执行工作流时，使用
`ntn-skills use "$skill_ref" --database "$library_entry" --json`，
同时加载它依赖的工作流。普通发现、读取、use 和 export 都不会对 Notion
产生语义写入。

验证首次业务使用时，再给 Agent 一个真实决策，确认它按所选 Skill 的方法完成评审。
建好表、发现记录、读到正文，分别只能证明这条链路中的一部分。

## 四张表各管什么

| 表 | 内容 |
| --- | --- |
| Skills | 工作流名称、描述、启停、主文，以及 Members/Requires 关系 |
| Files | Notion 自有支持文件和选中的 Source 阅读页 |
| Sources | Git 来源定义、选定的上游内容及其对 Skills 的贡献 |
| Records | 精确资源、共享 Profile 规则和未完成管理操作 |

作者通常操作 Skills 和 Files，CLI 管理其余关联和内部元数据。
原生 Skill 不需要额外创建 Source。字段与归属见[库合同](docs/current-contract.md)。

## 关系与相对引用

`Members` 列出 Agent 可以按需选择的相关 Skill；`Requires` 列出执行 `use` 时
必须加载的依赖。`Requires` 由作者明确维护，正文提及某个工作流或写了“必须”
都不会自动变成依赖。

首次本地导入且未明确提供 `Members` 时，可以从已确认的精确 Skill 引用建立关系。
已有关系和显式填写的集合都会保留，包括 `[]`。自动发现宁可漏掉，也不根据名称、
相似文件名、代码示例或模板占位符猜身份。本地跨 Skill 相对链接可通过
[`members-plan`](docs/shared-authoring.md#discover-members-before-a-local-import)
加上明确的路径到 Skill 身份绑定，生成可导入的 portable 副本。
检查未解析引用，并补齐自动发现遗漏的预期关系。
导入及其 dry run 都会在 `members_discovery` 中报告自动发现的决策和结果。

Skill 内的相对引用以实际包含链接的文件为基准。跨 Skill 相对引用需要该文件可靠的
当前 Source 贡献映射，或改成明确的稳定引用。缓存目录的位置不能提供身份依据，
导入也不会自动保留本地仓库的相邻目录结构。

## 继续使用

| 目标 | 指南 |
| --- | --- |
| 局部修改文件或属性、登记已有页面、删除 Skill | [原生管理](docs/shared-authoring.md#manage-native-skills) |
| 读取支持文件、查看完整目录、导出当前选择 | [日常命令](docs/usage.md) |
| 替换完整本地树、选择 native 文件、继续原导入 | [完整导入](docs/shared-authoring.md#prepare-the-entire-replacement-tree) |
| 应用或刷新 Git 贡献、管理来源、接管文件 | [Source 管理](skills/notion/ntn-skills-sync/references/synchronization.md#current-source-boundaries) |
| 为导入内容或 Source 生成 Notion 阅读页 | [阅读投影](docs/shared-authoring.md#generate-readable-text-in-notion) |
| 从 Trash 恢复原 Skill | [恢复说明](docs/shared-authoring.md#restore-a-trashed-skill) |
| 选择 View、共享 Profile 和 freshness 规则 | [Profile 与 View](docs/usage.md#choose-a-profile-or-view) |
| 检查未完成操作 | [操作恢复](skills/notion/ntn-skills-maintain/references/operations.md#incomplete-current-work) |

完整导入会替换所选 Skill 的整个文件树，覆盖已有内容前先检查 `--dry-run`。
Git 来源获取还要求当前 Git 支持 `--no-lazy-fetch`，
见 [Git 要求](docs/usage.md#install-the-package)。

完整发现需要跟完返回的 cursor；重名时保留精确 ref。
固定选择在本地保留选中的内容，不是远端历史记录。
`--offline` 需要所选字节已在本地。详见[读取与缓存](skills/ntn-skills/references/integration.md#current-selection-and-cache)。

## Agent 接入

有 shell 的 Agent 可以直接使用 CLI。库还没有创建时，先离线读取包内设置指引：

```sh
ntn-skills ctl builtin read notion/ntn-skills-maintain --path references/setup.md
```

把目标父页面或库入口交给 Agent，并让它继承同一凭据环境。
日常管理和 Source 同步默认使用同一执行包的指引，连接库后也一样：

```sh
ntn-skills ctl builtin read notion/ntn-skills-maintain
ntn-skills ctl builtin read notion/ntn-skills-sync
```

读取这些指引无需 Notion 副本或远端工作流搜索，也不会决定写入目标或授予写权限。
普通业务 Skill 仍在你的库里发现。明确选择 Notion／团队工作流时，Agent 保留其
精确 source/ref，应用前通过 `use` 加载 Requires。搜索不完整、内容 pending 或
访问错误都不能让它自动改选包内指引。被编辑目标只做检查，不激活；
当前任务已选内容保留到明确重新选择为止。

[把包内工作流复制到 Notion](skills/notion/ntn-skills-maintain/references/setup.md#copy-packaged-workflows-into-notion)
是团队定制的可选操作。副本是用户拥有、可编辑的原生 Skill，有独立身份，
不会随包升级自动更新。

Pi 接入见 [Broker 指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.zh-CN.md)。
Broker 通过配对 SDK 消费同一个库，并负责 Pi 连接配置。
保存连接与在 Pi 会话中实际读取正文是两个步骤。
`next` 的 OMP/Tern 适配仍延期。

## 文档与开发

[文档入口](docs/README.md)包含命令、内容管理、输出合同和当前实现边界。
[Contributing](CONTRIBUTING.md)说明 `next` 开发方式，并连接唯一的
[隔离开发指南](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)。

初始化创建当前结构，不转换旧库。
源码测试、独立安装包、真实 Notion 行为和实际 Agent 使用
分别有自己的[验证范围](docs/maintenance-verification-review.md)。

[MIT 许可证](LICENSE) · [安全说明](SECURITY.md) · [问题与反馈](https://github.com/yoyooyooo/notion-skills-cli/issues)
