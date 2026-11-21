# 当前形式化验证维护

当前产品合同在 [current-contract](current-contract.md)。形式模型只证明明确映射的有限状态；真实 HTTP、完整内容、Notion 清理、安装包与 Pi 投递各自验收。

## 保留的模型

仓库保留 `verification/models/request-engine` 中的 SharedProducer 和 RequestAdmission。前者检查只读 producer 的所有权、隔离、取消与有限共享容量；后者检查一个逻辑请求的排队、有限重试、attempt deadline 和未知写入禁止重试。两者仍使用原来的 21 个配置及完整规则清单。

原 resource-lifecycle、operation-recovery 模型、专属突变脚本、旧图册和旧维护配方已经退役。它们依赖已取消的 event、永久 pin、ACK/review/completion 和独立接受协议。Git 中的历史足以追溯，不保留可误运行的兼容入口，也不把旧模型通过算作当前实现通过。

当前资源与有限意图由 [资源状态 Skill](../.cursor/skills/verify-notion-resource-lifecycle/SKILL.md) 维护 [current-lifecycle](../verification/models/current-lifecycle/README.md) 的一组模型和七个配置。内容 owner Operation 与 projection/restore 的有限意图分开；覆盖当前读取与 writer 交错、未知写不重放、完成资格，以及声明假设下的进展。[操作恢复 Skill](../.cursor/skills/verify-notion-operation-recovery/SKILL.md) 仍拥有实际 writer/HTTP/SQLite 回放。两组复用同一 runner，不增加总验证平台。

## 运行入口

先安装仓库锁定依赖，按 [request-engine README](../verification/models/request-engine/README.md) 配置与 `tool-lock.json` 相同的 statechart 工具及 TLC jar。

```sh
node --test scripts/formal-result-contract.test.mjs
node scripts/verify-formal.mjs --suite request-engine --out /absolute/new-model-run
node scripts/verify-formal.mjs --suite current-lifecycle --out /absolute/new-lifecycle-run
node --test scripts/formal-runner-contract.test.mjs
```

`--model SharedProducer` 或 `--model RequestAdmission` 选择该模型的全部正负配置。只接受 request-engine/current-lifecycle 两个现役 suite，不兼容已退役模型。输出使用本次新的外部空绝对目录；失败保留原结果，下一次使用新目录。

运行器检查源码对应、工具字节、完整规则清单和每个配置。正例的 broken 集合必须为空；负例必须精确等于声明的集合。未执行的规则、缺失 NoDeadlock、cut、超时、解析失败、额外失败和工具异常都不能算通过。不能从已经删减的配置反向生成较弱规则清单。

## 源码对应与实际守卫

| 变更 | 最小必要验证 |
| --- | --- |
| 展示文字或 view | 检查没有隐藏性质相关状态和坏路径，运行受影响模型全部配置 |
| 模型、配置或性质 | 审阅有限域、原子步骤、环境假设和完整规则，运行其全部正负配置 |
| 对应实现或测试 | 读实际调用路径和差异，运行相应实现回归，确认受影响真实 guard 的破坏与恢复 |

coverage hash 用于阻止未经审阅的漂移。先核当前行为，再更新准确映射；不批量刷新 hash 来制造通过。删除产品协议时，连同不再适用的模型和调用入口退役，保留仍适用的权限、完整性、预算和取消守卫。

`scripts/check-formal-mutations.py --suite request-engine` 在独立副本中回放 19 个实际 guard。每个必须原件通过、突变导致行为断言失败、恢复后通过。导入失败或语法错误不算捕获。当前 immutable runtime case 修改 `shared-current-resource.ts`，并通过公开 SDK 取消 creator，确认另一个 runtime 的读取仍可完成。

同一入口的 `--suite current-lifecycle` 回放四个实际 guard：current 最后读回 fence、projection 分类、never-replay 的未知 action、非内容完成时的 owner 资格。只改外层 activation 条件会被下一层写入边界拒绝；这种未触发行为断言的异常不是该性质已被杀死。每个保留负例都需与模型的真实路径一致。

RequestAdmission 不建模多步骤 import、字节流、multipart 或有限 Operation。默认总预算、嵌套共用预算、耗尽后停止派发、partial writer 与显式 resume 由 `shared-current-invocation.test.ts` 和已有当前操作测试验证。不要把请求模型通过扩大成整个 writer 的证明。

## CI 与结束条件

`.github/workflows/formal.yml` 按现役 suite 运行模型、严格结果测试、实际 guard mutation 和对应实现回归，包含 next 的相关变更。CI 是否通过以该提交的实际日志为准，本地通过不替代它。当前必需回执及原始失败保存到本轮已有证据归档；不能只依赖会过期的 CI artifact 链接，也不建立内容版本库或新证明平台。

请求模型仍只证明 safety/NoDeadlock；CurrentLifecycle 的条件进展要求外部调用返回、准确显式 resume 及所列弱公平性。blocked 是保留未知意图的明确结果，不是业务完成；这些假设必须随回执保留。

发现当前未建模的具体风险，优先给实际行为加必要的反例；只有状态分析确实需要时才扩展对应模型。达到本次行为和边界的验证目标后停止。
