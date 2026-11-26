# Empty current library

主要入口：[verify-notion-management](../../verify-notion-management/SKILL.md)。本页只验证当前四表空库初始化与明确注册。

## Launch

复用现有 [current-convergence](current-convergence.md) 的隔离运行目录和明确授权的测试容器。由 `ntn-skills ctl library init --parent PAGE_ID` 创建并注册当前表；不得通过验证脚本预填注册描述符或业务行来冒充初始化成功。

## Drive

1. 用当前安装包执行 `ctl library init --parent PAGE_ID`，保存 `library.library_id` 为唯一 LIBRARY_ID，并核 `root_url` 指向该根页面；结果字段和只读 list 的 `next.argv` 保持。
2. 用 `ctl library init --library LIBRARY_ID` 验证四表结构，再用 `ctl library inspect --library LIBRARY_ID` 核对 Skills、Files、Records、Sources 的绑定。空业务表应明确为空；缺表或初始化中断不得标为 ready。
3. 对同一根通过 `init --library` 重复验证/检查；另一次新 `init --parent` 必须分配独立根，确认不会另建一组表。
4. 在明确的独立 client config/state/cache 中执行当前 `list`，确认完整分页、空结果和远端零语义写。
5. 核未创建业务 Skill／Source、未改 default_library 或 host 配置。
   未配置消费默认库也能通过显式 LIBRARY_ID 完成后续流程；已有 default_library 不提供管理写目标。

结构就绪仅证明上述初始化。首次业务使用另沿
[原生管理与实际 Pi](skill-maintenance.md#原生日常管理与实际-pi)：Agent 默认读取执行包的
随包指引，创建一个真实业务 Skill，发现并完整读取、按其方法完成任务，再以保存的
LIBRARY_ID 在新会话重连。产品指引通过 `skills get` 读取，各阶段分别记录结果。

## 有限初始化续建

源码入口为 `packages/core/test/shared-library.test.ts`；本地持久化沿
`packages/core/test/shared-library-initialization.node.test.ts` 使用 Node 和真实 SQLite。
初始化只有一个当前 pending，绑定凭据范围、授权父页、原 operation、已知根/表/属性身份和在途动作；完成后清理，不保留历史。

在自有空父页验证一次有界中断。保留原命令输出、operation ID 和原 `NTN_SKILLS_HOME`，
先执行 `ctl library init --parent PARENT --operation OPERATION`，核远端零写对账。
再加 `--resume`，核已建表不变、未开始步骤补齐、四表关系和 descriptor 可由正式
`init --library` 验证。用新客户端按实际 Library 根 创建并完整读取一个测试 Skill，最后同操作重跑核零重复写入。

针对性反例覆盖部分表、缺 Members/Requires 或 Origin、缺 descriptor、响应丢失、
缺原本地状态及人工修改。已发出的未知 CREATE 或关系创建只读对账，未出现不能重发；
已登记但响应丢失直接复用。精确 descriptor 替换在明确 resume 和身份检查下可幂等重试。
保留首次失败，CLI 退出与业务结果分开；不要向生产库或其他会话 fixture 注入故障。

表字段和状态以 [current contract](../../../../docs/current-contract.md) 为准。首次内容使用已公开的 [完整当前导入](import-create-recovery-dry-run.md)；Source refresh、跨对象治理与全库清理仍单独实现和验收，缺少的部分报告 blocked/not_run。

## Verify and stop

当前安装态验证复用 `bun run package:check`：新鲜 tarball、SDK v3、当前服务事实、精确正文和文件目录、预算与取消。该受控服务并不证明真实空库初始化，也不证明 Pi 已日用。后者使用 AH-1197/AH-637/AH-1198 的当前两机旅程。

记录本次实际 Library 根、执行命令、结果和未完成边界。清理只限本次自有对象与临时目录，遵循现有系统 Trash 规则；不建立历史证据、版本或新的验证平台。
