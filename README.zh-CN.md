# ntn-skills

让 Agent 和终端读取 Notion 中当前的 Skill 内容。

[English](README.md) · [当前合同](docs/current-contract.md) · [文档入口](docs/README.md)

`next` 正在将 Notion、CLI、SDK 和 Pi 收敛到一个当前合同。Notion 管理当前身份、规则和作者内容；git-only、混合和 Notion-native 共用一个 reader。分支代码可运行，不代表生产库、npm 发布版本或本机 Pi 已完成迁移。

## 当前可用能力

| 诉求 | 当前入口 |
| --- | --- |
| 先发现名称、描述和身份 | `list` |
| 查看精确文件 | `read` |
| 使用选中的工作流及其 Requires | `use` |
| 查看完整文件目录 | `files` |
| 导出完整当前选择到本地 | `export` |
| 检查当前文件权威、归属和在途状态 | `ctl library files` |
| 导入或替换一个完整本地文件树 | `ctl library import`，支持 `--dry-run` 和原意图 `--resume` |
| 应用或刷新明确的 Git 贡献 | `ctl library source apply`、`ctl library source refresh` |
| 创建或检查当前四表结构 | `ctl library init`、`ctl library inspect` |
| 管理共享当前 Profile | `ctl library profile` |

普通 list/read/use/资源读取/export 对 Notion 的语义写入为零。直接修改 native 作者正文后，读取会取得当前内容，不创建 adoption event，也不保留远端内容版本。Source/resource 的生成阅读页即使被编辑，也不会自动取得作者权威。

当前导入默认写入精确 resource 原件；重复 `--native PATH` 可将所选文本交给可编辑的 Notion 正文。完整文件目录和原件先保证可消费，生成阅读投影可以后置。Portable Members/Requires 支持导出再导入，核完整目标与依赖关系；库查询、写入和清理共用一次有界 HTTP 预算。Source apply/refresh 自动发现完整选中成员，接入新增、更新原文件并清退上游已移除的纯 Source 成员。既有映射保留稳定身份，新成员获得确定身份。保存声明文件后，即使 Notion Source 被删，也可用 `source apply` 重建。GitHub 和实际私有 HTTP(S) Git 共用该路径及本机认证。

`source takeover` 和 `source restore-follow` 保留 File ID、Notion 页面及路径，同时调整当前贡献的精确排除规则。它们使用 Source 已选定的原件，不顺便刷新 Git。`source enable/disable` 控制消费资格；`source remove` 只有在文件与 Origin 引用都已解除后才清退 Source 及其资源。未完成写入可重传原输入 resume，也可在原 writer 停止后用 `--operation NEW --supersede OLD` 明确提交完整新意图。完成后不保留前意图或内容历史。

旧 create/apply/write/replace/adopt、sync、snapshot/archive 和 repair 命令已退出当前 CLI。真实库的数据转换、全文覆盖、旧对象清理和 Pi 安装仍需分别完成。

## 安装

使用 Node.js 22.22.3+ 的 22.x，或 24.20.0+。已发布包的安装命令：

```sh
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

发布包可能早于本分支的当前合同。验证本轮改动时，按 [Contributing](CONTRIBUTING.md#development-setup) 构建、安装指定的 `next` 候选；CLI、SDK 来自同一完整包，再配对对应 Broker。安装旧版不会转换 Notion 数据。

CLI 直接通过请求引擎访问 Notion。沿用 `NOTION_API_TOKEN`，或让可信凭据来源将 token 通过 stdin 传给 `ntn-skills ctl config set-token --stdin`。不在聊天中粘贴凭据。`ctl config show` 只报告是否配置；已保存配置优先于环境变量。

## 首次读取

选择已有当前内容的注册库，保留实际返回的入口和 ref。名称、别名用于发现，不是唯一身份。

```sh
ntn-skills ctl library inspect ENTRY_DATABASE_ID
ntn-skills list --database ENTRY_DATABASE_ID --json
ntn-skills read REF_FROM_LIST --database ENTRY_DATABASE_ID --json
ntn-skills files SNAPSHOT_ID_FROM_READ
ntn-skills read RELATIVE_PATH --from PINNED_CONTAINING_FILE_REF
```

需要执行该工作流时，使用 `ntn-skills use REF_FROM_LIST` 或宿主的 Notion use 工具。查看、总结正文不等于激活工作流。

完整目录查询要跟完实际 cursor。Search 或过滤 View 不能证明其他对象不存在；重名时选择实际返回的精确 ref。Skill、Router、Prompt 分别使用 `SKILL.md`、`ROUTER.md`、`PROMPT.md`。Requires 加载必要依赖，Members 提供候选，不读取所有成员正文。

Markdown 链接可以指向完整所选文件树中的文件或真实目录；目录不必包含 README。图片必须指向文件。指向另一个 Skill 时使用明确的稳定 ref；相对路径必须留在当前 owner 内。使用 `files` 查看目录，使用 `read` 读取单个文件。

任务选择在本地保留完整目录及已取得的字节，不是远端历史登记。选中 Source/resource 的字节缺失时，仅在当前 owner、locator、revision 仍吻合时继续按需获取。本地选择已丢失或当前绑定改变时要重新选择，不能复活远端旧 snapshot，也不能把后来的 native 正文塞回旧选择。

对当前 target 使用 `--refresh` 做线上核验。有效 TTL 可以复用已有观察；元数据续期不延长独立的 native 正文完整核验期限。固定 ref 不会自动选择新版，`--offline` 必须具备所选本地字节。

```sh
ntn-skills read CURRENT_REF --database ENTRY_DATABASE_ID --refresh --metrics
ntn-skills read EXACT_FILE_REF --output ./selected-file.bin
ntn-skills export SNAPSHOT_ID_FROM_READ --output ./selected-skill
```

导出保留完整字节和可执行 mode，已有不同输出会被拒绝。读取或导出脚本不会执行它。任意多路径局部导出尚未有公共参数；单文件使用精确 `read --output`。

## 四张表各管什么

| 表 | 当前职责 |
| --- | --- |
| Skills | 身份、发现元数据、启停、Members/Requires、主文 Content、当前操作状态 |
| Files | 每个子文件的一行，精确 owner、稳定 File ID、路径和 Content |
| Sources | 稳定 Source 定义、完整当前选定计划、目标贡献和在途操作 |
| Records | 当前精确资源、唯一当前 Profile、未完成管理意图 |

`Content` 明确选择 native 作者 Markdown、Notion 管理的精确资源，或当前 Source 文件。主文在 Skills，其他文件在 Files。原生正文保持作者权威，Source/resource 通过所声明的精确原件消费；生成页面投影单独推进。投影完成时必须提供全文或可用原件。真实库的覆盖、迁移和剩余能力见[当前合同](docs/current-contract.md)。

只检查当前目录和权威，不读取正文：

```sh
ntn-skills ctl library files SKILL_PAGE_ID --entry ENTRY_DATABASE_ID
```

缺当前 descriptor 返回 `CURRENT_SCHEMA_REQUIRED`。applying/attention 指向一个未完成当前操作。普通读取不会迁移 schema，也不会替管理操作对账。

## 建库和 Profile

在已经授权的新父页面下：

```sh
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

这个命令创建当前结构，不导入本地 Skill，也不证明 Pi 已投递。具体边界见[设置说明](skills/notion/ntn-skills-maintain/references/setup.md)。

把完整本地树导入这个当前库：

```sh
ntn-skills ctl library import INPUT --entry ENTRY_DATABASE_ID --skill-id STABLE_SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY_DATABASE_ID --skill-id STABLE_SKILL_ID
```

导入保留精确 resource 原件；生成阅读页可后续补齐，不阻塞消费。要在 Notion 编辑正文，可加 `--native SKILL.md --native references/guide.md`，所选正文须为 UTF-8/LF。相同稳定身份对应完整文件树替换。先检查 dry-run 中的移除范围；相同输入再次执行为零写入。未完成时用原输入、原 native 选择加 `--operation OPERATION_ID --resume`。具体步骤见[当前管理](docs/shared-authoring.md)。

Profile 将当前 View 和 freshness 规则保存在一个稳定 Record：

```sh
ntn-skills ctl library profile list --entry ENTRY_DATABASE_ID
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY_DATABASE_ID
ntn-skills list --profile PROFILE_ID --database ENTRY_DATABASE_ID
```

明确替换规则时按 `profile set --help` 提交完整输入，需要 `--name`、`--enabled` 和当前 `--expect` fingerprint。省略的可选规则会被清除。fingerprint 检测已观察到的冲突，不提供分布式 CAS；Profile/View 不授予权限。

## Agent 接入

通过 builtin catalog 读取 `notion/ntn-skills` 获取消费指引。`notion/ntn-skills-maintain` 负责设置、完整当前导入与有限恢复；`notion/ntn-skills-sync` 负责当前 Profile、Git Source apply/refresh、文件接管与恢复跟随、Source 启停清退和混合树保留规则。

Pi 是首个日用宿主，Notion discovery/use/资源读取使用配对 SDK。OMP/Tern 适配延期，但它们目录中的本地 Skill 内容仍属于 Pro 迁移盘点。

语法不清楚时查看 `ntn-skills schema` 或精确子命令帮助。旧文档中的命令不是恢复兼容分支的理由。

## 开发与验证

开发方式见 [Contributing](CONTRIBUTING.md)。既有 [current-convergence](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md) 保持六组有限检查。受控源码测试、真实 Notion 清理、独立安装包、真实 Pi 投递分别声明实际结果。reader 测试通过不等于迁移或安装完成。
