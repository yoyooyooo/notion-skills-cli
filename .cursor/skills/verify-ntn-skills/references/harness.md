# 共用运行设施

按领域 Skill 选择必要检查。这里仅提供隔离运行目录、真实 CLI 调用、测试库范围和系统 Trash；当前产品行为由各领域及现有安装包检查验证。

## Launch

从仓库根执行，先满足 [开发环境](../../../../CONTRIBUTING.md#development-setup)。依赖和构建只补实际缺少的部分。沿项目凭据 provider 继承已授权的 token，不打印凭据或复制个人配置。

~~~bash
RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-verification-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
~~~

init 要求空的自有目录，建立独立 config/state/cache/data、builtin-home 和 evidence。产品子进程使用这些应用根和 XDG 根；本地 builtin 命令另用自有 HOME。source CLI 沿现有 scripts/dev.ts 运行实际 Node.js 入口，清除继承的开发 checkout override。它不证明 npm 安装态。

Bun 启动器可能在 helper 启动前使用继承的 XDG cache。需要核对宿主写入范围时，为父 Bun 进程单独提供自有临时 XDG_CACHE_HOME，并纳入系统 Trash；不要在 init 前向空 run 中写入启动器 cache。

真实写入只针对任务已授权的对象。同一 Skill 保持单 writer；并发故障只在自有 fixture 中验证。Notion 没有跨对象事务或 CAS，读回成功也不提供原子覆盖保证。

## Doctor

~~~bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
~~~

离线 Doctor 检查实际 CLI 的 version/help 和入口，记录隔离范围。ready 只说明可启动，不证明线上内容、权限、投影或清理。需要实际认证检查时显式加 --live；--database 使用任务选定的入口。检查实际结果，不把缺前置记成通过。

## Drive

controller 只保留五个模式：

| 模式 | 用途 |
| --- | --- |
| init | 建立空的自有隔离目录 |
| doctor | 离线可启动性；显式 live 检查 |
| cli | 运行当前公开命令并记录实际退出与输出 |
| empty | 对精确授权的测试库初始化、执行范围检查或 census |
| cleanup | 将本 run 的本地 scratch 移入系统 Trash |

通过 cli 运行当前产品命令：

~~~bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
~~~

wrapper 返回产品的 exit 和输出。预期错误也须检查实际 exit/code，不能因 wrapper 返回 JSON 就称成功。它不读取 stdin，并拒绝把 token 作为 argv 传入；需要 token stdin 的专门测试直接使用隔离的 CLI 环境，不记录输入。

消费沿 [当前消费](../../verify-notion-consumption/SKILL.md) 和 [current-convergence](../features/current-convergence.md) 的 read/files/export。完整导入沿 [管理](../../verify-notion-management/SKILL.md)：

~~~bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library import "$SKILL_DIR" --entry "$ENTRY" --skill-id "$SKILL_ID" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library import "$SKILL_DIR" --entry "$ENTRY" --skill-id "$SKILL_ID"
~~~

上述对象与完整输入由任务确定。dry-run 是当前观察，不授予写权限，也不冻结远端状态。unknown/partial 沿 [当前操作恢复](../../verify-notion-operation-recovery/SKILL.md) 核对原意图，保留仍需的 scratch，不重建旧 plan 或盲目重放。

安装直接使用现有入口：

~~~bash
NTN_SMOKE_EVIDENCE_ROOT="$RUN/scratch/installed-package" bun run package:check > "$RUN/evidence/package.json"
~~~

它构建实际 archive，并从空的独立安装目录运行同一包的 Node CLI 与 SDK。检查范围见 [安装包消费](../features/portable-export-package-consumption.md)。这是受控 HTTP 验证；真实 Notion、AH-1197/AH-637 的安装与 AH-1198 的 Pi 日用分别执行。OMP/Tern 不进入本轮宿主验收。

CI 直接运行 check 和 package-check，不调用 controller。它始终上传实际报告和请求日志，排除 node_modules，保留七天。静态接线由 installed-package-ci.test.ts 验证；实际安装结果来自 package:check。

[只读旧备份 inventory](../scripts/shared-migration-inventory.ts) 仍专门要求 Node 24，只读取显式 catalog、备份 SQLite 和 objects。它用来保全待转换的当前唯一字节，不运行当前导入、授予迁移权限或证明实库已清理。它的旧输出格式单独收敛，不接回正常消费。

## Skill reference live check

跨 Library 身份、相对路径导入和 Members/Requires 的真实 Notion 切片使用
[skill-reference-live.ts](../scripts/skill-reference-live.ts)。它复用现役
installed CLI driver、empty-library 初始化及逐文件证据工具；沿配对环境的
command run 执行，不建立另一套 launcher。用该 run 选定的 **Node** 运行脚本及产品，
不要用 Bun 执行需要真实 SQLite Store 的探针。

在隔离 command run 的 CLI source 目录内，替换下面的大写占位值：

~~~sh
SELECTED_NODE .cursor/skills/verify-ntn-skills/scripts/skill-reference-live.ts \
  --cli ABSOLUTE_SELECTED_CLI_ENTRY \
  --runtime ABSOLUTE_SELECTED_NODE \
  --output ABSOLUTE_NEW_RUN_OUTPUT \
  --corpus ABSOLUTE_FIXED_CORPUS_JSON \
  --parent AUTHORIZED_TEST_PARENT_UUID \
  --existing-entry EXISTING_TEST_SKILLS_DATABASE_UUID \
  --existing-library EXISTING_LOGICAL_LIBRARY_ID
~~~

选定 CLI 路径来自同一 paired build；应用根、XDG 根和输出都属于当前 run。
只按名称继承已授权的 NOTION_API_TOKEN，不打印或复制 token。existing-entry 是已授权
测试 Library A 的物理 Skills 表；existing-library 是该四表 Library 的逻辑身份。
脚本核对两者，再在精确 parent 下创建一个新测试子页，通过产品 init 建立 Library B。
初始化的重复调用、挂接和四张空表 census 必须在导入业务内容前完成。

corpus 使用现役 members-live 的固定 Git 输入清单，逐一核对 commit、文件路径、
Git blob、SHA-256 和可执行位。真实 poteto-mode 保留全部 41 个作者文件；它只有正文
提及而没有精确活跃外链时，自动 Members 应为空。另一个显式关系输入验证 Members 和
Requires。其余切片覆盖同批目录映射、循环 Members、省略与显式空值、手动删除后的
保留、Requires 环检测、未列入目录及编码路径反例、两库同 Skill ID、入口与 from 绑定、
固定选择以及精确 rebind。

每个对象都由独立页面 GET 验证实际关系，导出后核对完整作者文件，负例检查真实
notion_write 计数。report.json 保留逐阶段状态，commands 和 observations 保留已脱敏
原件及实际 CLI/runtime/hash。该切片不是 Pi、provider 或自然 Agent 使用证据；
unknown CREATE 和响应丢失注入仍由受控 HTTP、Store 及形式化守卫测试承担。

失败先保留原操作和输出，查清是否存在未完成写入。专门的
--completed-upstream ABSOLUTE_PREVIOUS_OUTPUT 只允许续验已经收到 applied ACK、
所有阶段 complete 且 retired 的首批上游对象。脚本要求原 run 没有活动 dispatch、
随后命令实测零远端写、相同 CLI/corpus/身份及完全一致的输入。它在新 run 只读挂接
原 Library B、重新 GET/export 原对象，再执行尚未执行的后续切片；不复制 Store、
不重放原批次，也不将旧空表 census 冒充新的空表观察。未知或部分完成的批次不能走
这个入口，仍按原操作恢复流程处理。

原生链接写后校验失败的实测切片，须先用原 Store 的一致备份和同一批次意图完成产品
resume。--completed-native-recovery ABSOLUTE_RECOVERY_RESULT 只接收该明确恢复回执：
核对原报告的固定失败阶段、原输入/Library/operation/page、修复候选 CLI hash、成功
ACK、两项正文与关系 complete/retired，以及恢复 Store 无活动 dispatch。它把先前通过的
上游与 poteto 切片标为 retained_passed，仍执行原循环对象的独立读回及后续全部断言。
它不重放已恢复批次，也不是任意跳过失败阶段的入口；原失败 Store 和回执始终保留。

## Evidence

按 [当前合同与回执](../../../../docs/verification-contracts.md#结果回执) 保留一份有界结果，列合同/场景/run、实际命令、源码与加载字节、原件 hash、passed/failed/blocked/not_run 和剩余缺口。commands 下记录实际 argv、退出、超时与输出；原始 stderr 不保留，只记长度与 hash。需要具体诊断时使用现有报告，不能从 hash 推断正文或成功。

读取实际文件和请求记录。没有计数不填零；截断响应的已观察前缀不算完整 bytes。源码、实际安装、真实 Notion 和真实 Pi 分开记录。内容、页面 ID 和凭据可能涉及私有数据，结果放在自有运行目录，不提交到仓库。

## Cleanup

~~~bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
test -f "$RUN/evidence/cleanup.json"
~~~

先检查实际结果，并保留仍需的报告或唯一字节。macOS 使用 /usr/bin/trash 回收本 run 的 scratch，保留 evidence；其他宿主缺已验证回收能力时保留目录并明确报告。直接 package:check 使用上述 evidence root 时，其自有安装目录也在 scratch 内。若另选输出根，按实际输出和授权范围单独清理。

helper 不自动删除远端页，也不按进程名结束进程。未知写入尚依赖本地状态时暂不 cleanup；完成或明确放弃后有界回收。清理结果不替代功能验证，不建立永久归档或内容版本库。
