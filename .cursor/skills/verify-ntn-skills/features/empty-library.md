# Empty current library

主要入口：[verify-notion-management](../../verify-notion-management/SKILL.md)。本页仅验证当前空库初始化；旧 create/adoption、Source member、retained pin、audit/recovery 与 Pi maintenance 配方已随其产品入口退役。

## Launch

复用现有 [current-convergence](current-convergence.md) 的隔离运行目录和明确授权的测试容器。由 `ntn-skills ctl library init --parent PAGE_ID` 创建并注册当前表；不得通过验证脚本预填注册描述符或业务行来冒充初始化成功。

## Drive

1. 用当前安装包执行 `ctl library init`，读取结果中的精确 library entry。
2. 用 `ctl library inspect ENTRY` 核对当前 Skills、Files、Records、Sources 的绑定、字段和关系目标。空业务表应明确为空；缺表或初始化中断不得标为 ready。
3. 对同一对象重复初始化/检查，确认不会另建一组表。
4. 在明确的独立 client config/state/cache 中执行当前 `list`，确认完整分页、空结果和远端零语义写。

表字段和状态以 [current contract](../../../../docs/current-contract.md) 为准。首次内容导入、逐文件治理、Source refresh 和全库清理依赖尚未完成的当前 writer，必须报告 blocked/not_run，不能换回旧 authoring recipe。

## Verify and stop

当前安装态验证复用 `bun run package:check`：新鲜 tarball、SDK v2、当前服务事实、精确正文和文件目录、预算与取消。该受控服务并不证明真实空库初始化，也不证明 Pi 已日用。后者使用 AH-1063 的一次实际旅程。

记录本次实际 entry、执行命令、结果和未完成边界。清理只限本次自有对象与临时目录，遵循现有系统 Trash 规则；不建立历史证据、版本或新的验证平台。
