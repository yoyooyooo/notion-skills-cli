# Skill 引用、跨库作用域与导入关系

主要 owner：[verify-notion-resource-lifecycle](../../verify-notion-resource-lifecycle/SKILL.md)。
消费读取由 consumption 回放，导入和人工关系保持由 management 回放。
复用 [有限模型](../../../../verification/models/skill-reference/README.md) 与现有 runner；
不创建另一套环境启动器、凭据存储或验证平台。

## 准备

先读 [引用合同](../../../../docs/skill-reference-redesign.md)。
沿现有双仓隔离环境选择明确 build，记录 CLI、SDK、Broker 的实际源码与包字节。
受控检查使用本地 fixture，不需要个人 Notion 凭据。
真实导入只写本次已授权测试 Library；用显式 --library root UUID 选择，不改变日用配置。

## 模型与守卫

    node scripts/verify-formal.mjs --suite skill-reference --out /absolute/new-reference-model-run
    python3 scripts/check-formal-mutations.py --suite skill-reference --out /absolute/new-reference-guard-run

按模型 README 配置锁定工具，用 pstack /statechart 阅读全部结果和最短反例。
ReferenceSelection 与 ImportRelations 的正例、全部预期负例、完整规则清单
必须一起通过。执行前检查 coverage 的基线和对应源码；先审差异，再更新 hash。
实际 guard 必须 baseline 通过、mutant 行为断言失败、恢复通过。
解析错误、缺 fixture、未跑测试和超时不能冒充 mutant 被抓到。

## 消费路径

    bun test packages/core/test/skill-ref.test.ts packages/core/test/skill-reference-guards.test.ts packages/core/test/ref-archive.test.ts packages/core/test/shared-current-relative.test.ts packages/core/test/shared-source-references.test.ts packages/core/test/resource-read.test.ts --timeout 60000
    node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sqlite-state.node.test.ts packages/core/test/shared-sqlite.node.test.ts packages/core/test/cache-retention.node.test.ts packages/core/test/config.node.test.ts

建立两个 Library，它们拥有相同 Skill ID、显示名、文件路径和可相同的内容 hash。
从测试库正文读取短 ref，并把环境默认库设成正式库。核返回的完整 Library 身份、
物理 owner 与实际字节，不能只核标题或路径。入口缺 Library、稳定 ID 缺失却有同名对象、
重复身份、显式外库与错误 manifest owner 分别留断言。

完整 ref 与 ambient default 不同时按完整 ref 选择；完整 ref 与独立显式
--library/call scope 冲突则在任何正文读取或管理写入前拒绝。默认值切换不改变已绑定调用。
根页面与原 pending 的独立世界事实沿 current-lifecycle/LibraryLifecycle，
不能只构造自洽 descriptor 作为真实 DB parent 的替身。

固定引用只有 snapshot 与 manifest 中的精确 path。省 path 使用 manifest 的
entrypoint；改变实时 entrypoint 后仍须如此。缺 manifest、缺 path 或旧字节
无法按原权威验证时失败，不从 current 补查。旧 file_id query 以及 File ID 校正
失效路径的旧语义不再接受。Source 完整文件可没有 Notion File 行。

跨 Skill 相对路径从真实 containing file 的原始 Source 路径与冻结 revision 计算，
再映射到目标完整身份。覆盖 mount/rename、嵌套文件、排除、歧义与缺失目标。
放置碰巧同路径的 owner-local 或缓存文件，确认不能掩盖失效 Source 证据。
跨 Skill 后取得目标自己的 selection；解析过程中语义写必须为零。

持久化用例让同一连接 scope 中的两套 Library 具有相同 Skill ID、显示名和版本值。
新进程重读后核完整原身份，再清理其中一库并拒绝旧发布；另一库仍可更新和读取。
缓存地址的编码只是存储格式，不能成为短引用的 Library 上下文。

## 导入路径

    bun test packages/core/test/shared-current-member-discovery.test.ts packages/core/test/shared-current-import-plan.test.ts packages/cli/test/current-import.test.ts packages/cli/test/current-import-batch.test.ts packages/cli/test/current-members.test.ts --timeout 60000

用明确的本地批次输入和一个目标 Library，先冻结完整 file-to-owner 映射，
再写任何对象。不扫描未列出的相邻目录，不按文件名或 Skill 显示名拼关系。
在派生副本中只改已确认链接，原输入的未选字节、BOM、CRLF、二进制和 mode 保持。

至少包含 A 引用 B、B 引用 A 的循环 Members。观察全部对象完成后才应用最终关系。
显式外库关系写前拒绝；明确外库文档 ref 保留原作用域，不能偷偷改到目标库同名 Skill。
portable 的原库标记同样约束短 ref：single、batch 和 members-plan 都先保留原库，
再做 Members 推断。放置目标库同 ID 对象，检查派生正文、关系、目标查询和原件。
只在 --rebind-from 授权且目标身份／路径都属于本次批次时改绑 current；fixed、
外部目标和缺路径仍留原库。没有原库标记的普通本地输入继续使用目标库上下文。
这由第 16 个实际守卫与 CLI 回归覆盖；portable 转换不在有限模型的变量中。
重复运行和接受后丢响应必须恢复原输入、原目标库和原关系计划。
unknown CREATE 当前未观察到结果时不可重发。

首次导入 omitted Members 可以推断已确认的 active links；显式空集合、显式集合优先。
更新 omitted 保留现值。成功后人工删一个 Member，再原输入重复导入，确认没有补回。
Requires 只显式维护。普通名称、代码、图片、模板、注释和未确认路径均不产生关系。
可发现成员关系不代表执行授权，也不证明任意自然语言意图。

## 真实 Notion 回放

沿 [Skill reference live check](../references/harness.md#skill-reference-live-check)
选择独立测试 Library，执行同一打包产物的公开 CLI 导入、跨库读取与原操作恢复。
该入口记录具体输入、操作 ID 和保留的回执；模型与受控 fixture 通过不能代填其结果。

## 安装与交接

沿 [独立包消费](portable-export-package-consumption.md) 检查同一个 archive 的 CLI、
SDK 与 ntn-skills/ref。纯模块的协议版本和 hash 必须与 Broker 实际加载的副本一致，
不得借全局包或另一个 parser 通过。Broker 的 containing-file、session binding、
权限及最终投递仍沿其既有 integration 与 consumer-state Skill。

## 回执

分别记录 model、actual guard、公开 CLI/SDK、packed/Broker、live Notion 与实际模型层。
保存准确 Library、Skill ID、文件/原件 hash、关系完整集合、请求及语义写计数。
模型不替代真实字节，HTTP fixture 不替代真实 Notion，源码通过不替代安装。
未跑部分记 not_run 或 blocked，不以历史运行代填。
