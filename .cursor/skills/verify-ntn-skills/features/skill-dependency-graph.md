# 当前关系与消费依赖图

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。Members 是候选目录，Requires 是使用时必需的闭包；每个节点使用本次选择的完整当前目录。关系管理通过 [完整当前导入](import-create-recovery-dry-run.md) 验，不恢复独立历史图或远端版本。

## 当前公开路径

~~~sh
ntn-skills schema use
ntn-skills schema ctl prepare
ntn-skills use "$PAGE_ID" --database "$ENTRY" --json --metrics
ntn-skills ctl prepare "$PAGE_ID" --database "$ENTRY" --purpose inspect --metrics
ntn-skills files "$RETURNED_REF"
~~~

`use` 准备全部 Requires；`inspect` 只准备根正文和已知目录。Members 与普通相对链接不能自动变成必需正文。必须读取实际结果中的 ready/failed/cancelled、节点、目录、范围和 metrics，不从命令退出成功推断每个节点都已投递到宿主。

## 消费与批量

~~~sh
bun test packages/core/test/graph-prepare.test.ts packages/core/test/shared-graph-batching.test.ts packages/cli/test/prepare.test.ts packages/cli/test/prepare-batching.test.ts --timeout 60000
~~~

按本次改动选必要文件，保留这些现有守卫：

- 多根菱形对同一身份只准备一次；Requires 环给出闭合路径。缺失、禁用、非 ready、权限拒绝、非法依赖类型与身份冲突不能产出成功图。
- 已有 session binding 固定同任务选择，不能为满足新请求偷换 owner、scope、main hash 或选定 bytes。当前声明变化或所需本地内容消失时要求重选，不恢复远端历史。
- 全库 metadata、Files 批查询和关系 property 分页各自完整。超过单页的关系或 supporting 目录不能被内联前缀截断；partial 不进入完整派生缓存。
- node、depth、instruction、context bytes、HTTP attempts 和 deadline 约束实际工作；达到预算就明确拒绝，不能裁掉必需正文后报 ready。
- 只请求选中节点的 main，未选择 Member 的 body 保持未读。metadata 变化只失效受影响节点；派生缓存损坏不得复用为完整结果。
- 取消当前 owner 不取消仍有 waiter 的共享读取；最后 waiter 退出后不发布迟到结果。普通消费的语义远端写为零。

只有性能改动需要使用现有 `scripts/measure-graph-prepare.ts` 比较相同拓扑、内容、scope、缓存状态与预算；其受控 HTTP 数量和本地耗时不等于真实 Notion 延迟。不要为每次关系改动增加完整性能旅程。

## 当前关系写入

`ctl library import` 的 portable Members/Requires 是同库 stable-ref 完整集合：省略保持、空数组清空、数组替换。现有 `packages/core/test/shared-current-relations.test.ts` 检查完整分页、唯一 enabled/ready 目标、changed-set 100 条上限、Requires 环、unknown PATCH 对账和 ready 前漂移。更大的未变集合保持原样；Prompt 不能带这两类关系。

跨对象反向关系修复、Source 成员发布/刷新和全库治理尚需当前管理能力，不能把一次当前关系导入称为这些工作已完成。

## 文件与宿主边界

相对读取、精确单文件与整包 export 沿 [当前消费](skill-consumption.md)；全文阅读页沿 [current-convergence](current-convergence.md) 第一组。准备成功只证明当前选择完整，实际 SDK 安装沿 [package check](portable-export-package-consumption.md)，真实 Pi 使用由 [Broker 交接](broker-consumption.md) 与 AH-1197/AH-637/AH-1198 验证。OMP/Tern 延期，不保留其旧默认验收入口。
