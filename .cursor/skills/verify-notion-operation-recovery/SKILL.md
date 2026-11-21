---
name: verify-notion-operation-recovery
description: "验证当前管理意图在响应丢失、partial、预算暂停、取消和重启后的有限对账。修改当前 writer、稳定身份、去重、owner 状态或完成清理时使用。"
---

# 当前操作恢复验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 4 组。本入口不负责请求层模型，也不负责真实宿主投递；当前状态模型由 [resource lifecycle](../verify-notion-resource-lifecycle/SKILL.md) 维护，本入口拥有实际 writer/HTTP/SQLite 恢复回放。意图只保留当前输入、owner、在途动作；Source 父意图另有有限目标游标，全部完成后回收。

## Launch

复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 和现有 HTTP fixture。区分受控故障、真实 Notion、安装产物和 Pi 日用。不要新增恢复台账或模型平台。

原 ACK/review/completion 模型、coverage、专属回放脚本和旧图册已经退役。当前有限意图通过实际 writer/HTTP 反例验证，不继承旧模型通过。

## Doctor

~~~sh
bun test packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-write.test.ts packages/core/test/shared-current-source-write.test.ts packages/core/test/shared-current-source-file.test.ts packages/core/test/shared-current-source-lifecycle.test.ts packages/core/test/shared-current-upload.test.ts --timeout 60000
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-current-invocation.test.ts --timeout 60000
~~~

需要验证本地持久化时，使用受支持的 Node 沿现有 runner 运行，确认真正 SQLite 中 pending 原位更新和完成删除：

~~~sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/shared-current-operation.node.test.ts
bun test packages/core/test/shared-current-projection-write.test.ts --timeout 60000
~~~

## Drive

1. 完整相等的输入只读观察，确认没有 Operation、owner 状态或正文写入。首个必要 mutation 才创建当前意图。
2. CREATE/append 已发出但响应丢失时，用 `ctl library import INPUT --entry DB --skill-id ID --operation ID --resume` 重传相同完整输入。实际当前结果满足同一动作才继续，不能因一次查询没有结果重发非幂等请求。
3. 幂等属性替换或归档，只在同一冻结意图、显式 resume 和当前 owner 校验下重试。若 append 只落了一部分，保留 pending 并拒绝盲目重放；明确报告未自动收敛。
4. Files 或 Resource 已归档却丢 ACK，完整目录查询中已没有该行。通过在途动作的 exact page 核对归档状态，再收敛，不能丢掉这个动作或新建替代行。
5. 当前内容写入的 applying/attention 阻止普通消费在正文前继续。最后核完整目录和当前字节，发布 ready 并清 Operation，然后退役远端意图、删除本地 pending。Projection 意图保持真实 Skill ready，正文渲染失败不应阻断原有消费。不要先删恢复指针。
6. 本地只剩 retiring 且下一个输入不同，只有当前 owner ready、逻辑 Operation 完整查询为空、已知物理 Record 明确在 Trash 时才能清这个本地残留。404、权限失败或半页不是完成依据。
7. 预算耗尽和取消停止派发；同 invocation 的重试、排队、上传、下载共用预算。不得开另一个 runtime 写 attention。新一次明确 resume 才有新预算。
8. 附件上传用当前 owner、operation、path 和 wire hash 定位，未知分配不重复 CREATE；multipart 按已观察的完整前缀继续。最终从实际附件下载并核原件，缓存旧 bytes 不能证明新附件正确。
9. Source 父意图冻结 declaration/commit/affected IDs；实际 Source 属性、ready 或 child append 已接受却丢响应时，对外恢复必须指回原父 operation。第一个子任务中断后用原 apply input --resume，核已完成子只读验证、未开始子继续、人工 native 改动保留、父子 pending 全清。父游标自身响应丢失也按当前 payload 对账；不新增历史或另一套恢复 runner。
10. 原 writer 停止后，用同一管理命令的 `--operation NEW --supersede OLD` 和完整新目标接续 partial 或放弃的旧输入。核同一个 owner/Record、一个有限前意图、SQLite expected-old 原子交接；Record 和 owner Operation 的响应丢失都能核当前结果继续。旧 writer/旧输入不能重新进入，新意图完成后无历史副本。Source 只能替代同类动作，文件动作还必须是同一文件；普通 import 不能接走 Source 子意图。
11. Source remove 在完整元数据反查无 Content/Origin 引用后退役资源和 exact Source 页。owner Trash 已落与未落但响应丢失分别验证；恢复后清 Operation/pending，整个路径没有 ready 发布。新引用、孤儿 Files 和不完整枚举阻止清退。

Notion 属性和本地 mutex 不提供跨机器 CAS。显式 supersede 不能撤回已经发出的请求；未知 CREATE 以后仍可能出现，观察到重复身份就拒绝。当前结果满足意图并不恢复原请求的网络 ACK，也不需要永久证据链或长期墓碑。

用 `ctl library operation OWNER_ID --kind skill|source --entry ENTRY` 只读查看当前意图及物理定位。没有可见意图不等于 owner ready。Source 连续 supersede 时，若当前父尚未接走祖父的 child，下一轮必须在父首次写前拒绝并指回现父 resume；已接走则可用新的完整目标继续，不保留历史链。

Projection 的修改复用 `shared-current-projection-write.test.ts` 和 CLI 对应测试。
普通单项/daily 命令重跑时，只在同目标、有效 policy 和完整输入 hash 一致时
自动沿原 operation 恢复，不接管内容意图或盲重放未知 CREATE/append。核自定义
policy 与预算进入准确恢复命令；显式 `--operation ID --resume` 省略筛选时用
原 intent 的 policy，冲突新策略不能覆盖它。Daily 顺序运行，失败返回已成/未成
范围；相等正文零写。Projection 不提供 supersede。
显式空 policy 用单独 --include '' / --exclude ''；同一 flag 不混其他 pattern。
核 next.argv 的 flag+空串能经真实 CLI parser 还原 []，省略仍是默认值。
Include 空仍保主文与全部 Notion-owned 文件，Exclude 空不排目录。

### 同页 Trash 恢复

复用现有 projection-write、operation/Node 和 CLI projection tests，验证
`projection PAGE_ID --restore --entry DB` 的两个有限阶段：只恢复同一 ready
owner 的 in_trash=false，清 restore intent，再进入原 automatic projection。
两阶段共用预算；不放开普通 projection 对 owner 属性的写权限。

覆盖 restore PATCH 已接受但丢 ACK、owner 绑定或退役前中断、后续 projection
append 中断。同一 --restore 命令应按当前事实恢复各阶段；准确 next 保留原 policy
和预算，不拼手工 --operation/--resume。live 且完整时必须零语义写。

外库、重复 live stable ID、404/永久不可用页、未完成 content intent 均零写
拒绝。旧 projection pending 的页又被外部 trash 时，同样保护性拒绝并保留
原 marker；不要为这个外部破坏增加第二 in-flight lane。Source 非 ready 不能
返回 complete，不刷新 Source/HEAD 来制造通过。受控故障通过与
[真实单命令验收](../verify-ntn-skills/features/current-convergence.md#单条命令恢复已完成的投影)
分别报告。

## Evidence

按 [当前合同与回执](../../../docs/verification-contracts.md) 记录 C07b 与所属场景、准确候选、真实运行层和原件 hash；历史 Done 不填作当前通过。

报告原请求已知结果、当前观察、剩余动作、下一条实际可执行命令及成本。缺实现写 blocked，没执行写 not_run；partial append 的 fail-closed 通过不能说成自动恢复成功。AH-507 的真实业务验收仍独立。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有对象。完成后只留当前内容；未完成意图需要原始输入时如实说明，不承诺从空 cache 恢复尚未上传的字节。
