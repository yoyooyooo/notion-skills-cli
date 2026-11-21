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
| 新建、编辑、登记或删除 Notion 原生 Skill | `ctl library skill create`、`update`、`register`、`remove` |
| 导入或替换一个完整本地文件树 | `ctl library import`，支持 `--dry-run` 和原意图 `--resume` |
| 应用或刷新明确的 Git 贡献 | `ctl library source apply`、`ctl library source refresh` |
| 为单个 Skill 或日用集合生成 Notion 全文 | `ctl library projection PAGE_ID` 或 `ctl library projection --daily` |
| 从 Trash 恢复原 Skill 并完成阅读投影 | `ctl library projection PAGE_ID --restore` |
| 创建或检查当前四表结构 | `ctl library init`、`ctl library inspect` |
| 管理共享当前 Profile | `ctl library profile` |

普通 list/read/use/资源读取/export 对 Notion 的语义写入为零。直接修改 native 作者正文后，读取会取得当前内容，不创建 adoption event，也不保留远端内容版本。Source/resource 的生成阅读页即使被编辑，也不会自动取得作者权威。

日常原生管理使用 `ctl library skill`，CLI 负责登记、文件身份、受管关系和有限操作清理。完整导入默认写入精确 resource 原件；重复 `--native PATH` 可将所选文本交给可编辑的 Notion 正文。完整文件目录和原件先保证可消费；导入或 Source 刷新后，用 `ctl library projection` 生成阅读正文。日用主文与选中的阅读文档须在 Notion 中完整可读。Source 默认仅投影 Markdown，并排除测试、fixture、依赖和生成目录；缺页重建，多余 Source 行归档。完整 Git 消费目录由 manifest 与 Contributions 决定，脚本和测试仍可消费。Native/resource 行保持 Notion 权威，非文本无需正文；投影失败不阻断已就绪的消费。Portable Members/Requires 支持导出再导入，核完整目标与依赖关系；库查询、写入和清理共用一次有界 HTTP 预算。Source apply/refresh 自动发现完整选中成员，接入新增、更新原文件并清退上游已移除的纯 Source 成员。既有映射保留稳定身份，新成员获得确定身份。保存声明文件后，即使 Notion Source 被删，也可用 `source apply` 重建。GitHub 和实际私有 HTTP(S) Git 共用该路径及本机认证。

`source takeover` 和 `source restore-follow` 保留 File ID、Notion 页面及路径，同时调整当前贡献的精确排除规则。它们使用 Source 已选定的原件，不顺便刷新 Git。`source enable/disable` 控制消费资格；`source remove` 只有在文件与 Origin 引用都已解除后才清退 Source 及其资源。未完成写入可重传原输入 resume，也可在原 writer 停止后用 `--operation NEW --supersede OLD` 明确提交完整新意图。完成后不保留前意图或内容历史。

旧顶层 create/apply/write/replace/adopt、sync、snapshot/archive 和 repair 命令已退出当前 CLI。真实库的数据转换、全文覆盖、旧对象清理和 Pi 安装仍需分别完成。

## 安装

使用 Node.js 22.22.3+ 的 22.x，或 24.20.0+。

Git 来源获取还要求当前进程选中的 Git 支持 `--no-lazy-fetch`。本轮已验证 Git 2.50.1，
不据此声明精确最低版本。CLI 在远端获取前检查该能力，不支持时返回
`UPSTREAM_GIT_RUNTIME_UNSUPPORTED`。请在调用进程的 `PATH` 中选择受支持 Git；
CLI 不修改全局 Git 配置。

已发布包的安装命令：

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

## 新建和管理原生 Skill

日常管理统一使用 `ctl library skill`。新建默认将 Markdown 作为可编辑原生正文，其他文件保留精确 resource 原件：

```sh
ntn-skills ctl library skill create ./my-skill --entry ENTRY_DATABASE_ID --skill-id my-skill
ntn-skills ctl library skill update my-skill --entry ENTRY_DATABASE_ID --input ./SKILL.md
ntn-skills ctl library skill update my-skill --entry ENTRY_DATABASE_ID --file references/guide.md=./guide.md
```

局部更新只改指定主文、子文件或属性，未触及的文件保留当前 Notion 编辑和身份。用 `--remove-file PATH` 明确删除子文件；用 `--name`、`--description`、`--enabled true|false`、`--default-context true|false` 修改作者属性。重复 `--members TARGET` 或 `--requires TARGET` 替换该关系集合，单独空字符串清空，省略则保留。TARGET 只能是精确 page ID、页面 URL 或稳定 Skill ID。

已经在当前 Skills 表里写好正文的页面，可以登记；删除则由同一个管理入口负责关联清理：

```sh
ntn-skills ctl library skill register SKILL_PAGE_ID --entry ENTRY_DATABASE_ID
ntn-skills ctl library skill remove my-skill --entry ENTRY_DATABASE_ID --dry-run
ntn-skills ctl library skill remove my-skill --entry ENTRY_DATABASE_ID
```

登记保留正文并补机器字段；缺少有效名称或业务描述时，作者通过 `--name`、`--description` 提供。删除把 Skill、子文件和自有无引用资源移入 Trash，同时解除同库 Members/Requires 对它的引用，保留引用方和其他关系。四个动作都支持 dry-run 与预算；中断后重跑同一意图。Agent 无需手填内部列或成功后扫尾。

Native 写入读取完整 Notion 结果，验证文本、代码、链接和结构等价，报告支持的格式规范化。当前 Notion 正文是权威；Source/resource 原件仍逐字节保真。原生正文后续直接在 Notion 编辑即可，无需投影；需要立即核验时使用 `read --refresh`。详见[原生管理](docs/shared-authoring.md#manage-native-skills)。

## 四张表各管什么

| 表 | 当前职责 |
| --- | --- |
| Skills | 身份、发现元数据、启停、Members/Requires、主文 Content、当前操作状态 |
| Files | Notion 自有子文件及选中的 Source 阅读文档，精确 owner、File ID、路径和 Content |
| Sources | 稳定 Source 定义、完整当前选定计划、目标贡献和在途操作 |
| Records | 当前精确资源、唯一当前 Profile、未完成管理意图 |

当前库注册四种表角色，不以某个 Notion 视图显示几张表为准。作者主要操作 Skills 和 Files，Sources 管外部来源，Records 由 CLI 管理；纯原生 Skill 无需人为补一个 Source。

`Content` 明确选择 native 作者 Markdown、Notion 管理的精确资源，或当前 Source 文件。主文在 Skills，Notion 自有子文件及选中的 Source 阅读文档在 Files。原生正文保持作者权威，只读验证而不覆盖。Source/resource 通过所声明的精确原件消费；显式投影筛选有人类阅读价值的文档并生成全文，不改变来源、完整消费目录或跟随关系。重复 --include/--exclude glob 可替换各自默认筛选；这些规则不能写入会影响消费的 Contributions.exclude。图片、字体等非文本保留原件消费方式，无需生成正文。日用覆盖边界见[当前合同](docs/current-contract.md)。

只检查当前目录和权威，不读取正文：

```sh
ntn-skills ctl library files SKILL_PAGE_ID --entry ENTRY_DATABASE_ID
```

缺当前 descriptor 返回 `CURRENT_SCHEMA_REQUIRED`。applying/attention 指向一个未完成当前操作。普通读取不会迁移 schema，也不会替管理操作对账。

## 在 Notion 阅读日用正文

同步当前内容后，预览并生成阅读正文：

```sh
ntn-skills ctl library projection --daily --entry ENTRY_DATABASE_ID --dry-run
ntn-skills ctl library projection --daily --entry ENTRY_DATABASE_ID
```

日用是 Source 日用的当前成员、Skill 日用与 Default Context 的并集；现有 Enabled、期望删除只报告，不修改。单项处理时，将 `--daily` 换成精确 Skill page ID。完整正文相同时零语义写。中断后重跑同一单项或日用命令；未指定 `--operation` 时，仅在目标、有效阅读策略与完整当前输入一致时自动沿原投影意图继续。冲突或未确认的 CREATE/append 仍停止，并返回已完成范围及携带原策略、请求预算的精确恢复命令。显式 `--operation ID --resume` 省略筛选时使用未完成意图的冻结策略。需变更阅读范围时，用原 `--operation ID --cancel` 仅核对在途动作并关闭旧意图，不继续其余投影；未确认动作仍保留。投影失败仍保留已就绪的消费。步骤见[正文生成](docs/shared-authoring.md#generate-readable-text-in-notion)。

阅读筛选支持显式空集合：`--include ''` 只保留强制主文和全部 Notion-owned 文件，`--exclude ''` 不排除目录；同一个参数的空值不能与其他 pattern 混用。省略参数仍使用默认规则，这些筛选不成为永久 Skill 配置。

已完成的 Skill 后来被移入 Trash 时，用原 page ID 一条命令恢复原页并完成投影：

```sh
ntn-skills ctl library projection SKILL_PAGE_ID --restore --entry ENTRY_DATABASE_ID
```

恢复保留原身份、人工属性和 native/resource 权威，两阶段共用一次预算。自身恢复或后续投影中断后重跑同一命令；已存活且完整一致时零语义写。`--restore` 支持阅读筛选与预算参数，只能指定单个精确页面，不能与 `--daily`、`--dry-run`、`--operation`、`--resume`、`--cancel` 混用。它使用当前 Source，不刷新上游 HEAD；永久删除、原件不可用或当前意图冲突会失败。如果旧投影尚未完成，页面又被外部移入 Trash，会零写拒绝并保留原意图。详见[恢复原 Skill](docs/shared-authoring.md#restore-a-trashed-skill)。

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

导入保留精确 resource 原件；阅读页由 `ctl library projection` 补齐，不阻塞消费。要在 Notion 编辑正文，可加 `--native SKILL.md --native references/guide.md`，所选正文采用与日常管理相同的结构化等价验证，允许支持的格式规范化并在回执中报告；原输入指纹、frontmatter 与 mode 保持。相同稳定身份对应完整文件树替换。先检查 dry-run 中的移除范围；相同输入再次执行为零写入。未完成时用原输入、原 native 选择加 `--operation OPERATION_ID --resume`。具体步骤见[当前管理](docs/shared-authoring.md)。

Profile 将当前 View 和 freshness 规则保存在一个稳定 Record：

```sh
ntn-skills ctl library profile list --entry ENTRY_DATABASE_ID
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY_DATABASE_ID
ntn-skills list --profile PROFILE_ID --database ENTRY_DATABASE_ID
```

明确替换规则时按 `profile set --help` 提交完整输入，需要 `--name`、`--enabled` 和当前 `--expect` fingerprint。省略的可选规则会被清除。fingerprint 检测已观察到的冲突，不提供分布式 CAS；Profile/View 不授予权限。

## Agent 接入

已连接 Notion 库时，从当前库的目录发现 `ntn-skills`、`ntn-skills-maintain`，通过普通 `read` 读取实际返回的精确 ref，附件沿同一选择用 `read --from` 读取。默认 View 没有该项时，在当前库内按名称查询；发现失败或不完整不能判定不存在。

没有连接库，或明确检查离线/随包内容时，再使用 `ctl builtin` 或宿主的精确 `@builtin` 身份。包内内容与 Notion 投影可能不同：安装新包不会刷新 Notion Source 或生成其阅读投影，也不会自动替换已有任务选择。

`ntn-skills-maintain` 负责原生新建、局部更新、页面登记、删除、设置、完整导入与有限恢复；`ntn-skills-sync` 负责当前 Profile、Git Source apply/refresh、文件接管与恢复跟随、Source 启停清退和混合树保留规则。

Pi 是首个日用宿主，Notion discovery/use/资源读取使用配对 SDK。OMP/Tern 适配延期，但它们目录中的本地 Skill 内容仍属于 Pro 迁移盘点。

语法不清楚时查看 `ntn-skills schema` 或精确子命令帮助。旧文档中的命令不是恢复兼容分支的理由。

## 开发与验证

开发方式见 [Contributing](CONTRIBUTING.md)。既有 [current-convergence](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md) 保持六组有限检查。受控源码测试、真实 Notion 清理、独立安装包、真实 Pi 投递分别声明实际结果。reader 测试通过不等于迁移或安装完成。
