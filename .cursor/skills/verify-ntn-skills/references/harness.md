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

它构建实际 archive，并从空的独立安装目录运行同一包的 Node CLI 与 SDK。检查范围见 [安装包消费](../features/portable-export-package-consumption.md)。这是受控 HTTP 验证；真实 Notion 和 AH-1063 的 Pi 日用分别执行。OMP/Tern 不进入本轮宿主验收。

CI 直接运行 check 和 package-check，不调用 controller。它始终上传实际报告和请求日志，排除 node_modules，保留七天。静态接线由 installed-package-ci.test.ts 验证；实际安装结果来自 package:check。

[只读旧备份 inventory](../scripts/shared-migration-inventory.ts) 仍专门要求 Node 24，只读取显式 catalog、备份 SQLite 和 objects。它用来保全待转换的当前唯一字节，不运行当前导入、授予迁移权限或证明实库已清理。它的旧输出格式单独收敛，不接回正常消费。

## Evidence

保留一份有界结果，列实际命令、范围、passed/failed/blocked/not_run 和剩余缺口。commands 下记录实际 argv、退出、超时与输出；原始 stderr 不保留，只记长度与 hash。需要具体诊断时使用现有报告，不能从 hash 推断正文或成功。

读取实际文件和请求记录。没有计数不填零；截断响应的已观察前缀不算完整 bytes。源码、实际安装、真实 Notion 和真实 Pi 分开记录。内容、页面 ID 和凭据可能涉及私有数据，结果放在自有运行目录，不提交到仓库。

## Cleanup

~~~bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
test -f "$RUN/evidence/cleanup.json"
~~~

先检查实际结果，并保留仍需的报告或唯一字节。macOS 使用 /usr/bin/trash 回收本 run 的 scratch，保留 evidence；其他宿主缺已验证回收能力时保留目录并明确报告。直接 package:check 使用上述 evidence root 时，其自有安装目录也在 scratch 内。若另选输出根，按实际输出和授权范围单独清理。

helper 不自动删除远端页，也不按进程名结束进程。未知写入尚依赖本地状态时暂不 cleanup；完成或明确放弃后有界回收。清理结果不替代功能验证，不建立永久归档或内容版本库。
