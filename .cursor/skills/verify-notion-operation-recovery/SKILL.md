---
name: verify-notion-operation-recovery
description: "验证当前管理意图在响应丢失、partial、预算暂停、取消和重启后的有限对账。修改当前 writer、稳定身份、去重、owner 状态或完成清理时使用。"
---

# 当前操作恢复验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 4 组。本入口不负责请求层模型，也不负责真实宿主投递。意图只保留当前输入、owner、在途动作；Source 父意图另有有限目标游标，全部完成后回收。

## Launch

复用 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 和现有 HTTP fixture。区分受控故障、真实 Notion、安装产物和 Pi 日用。不要新增恢复台账或模型平台。

原 ACK/review/completion 模型、coverage、专属回放脚本和旧图册已经退役。当前有限意图通过实际 writer/HTTP 反例验证，不继承旧模型通过。

## Doctor

~~~sh
bun test packages/core/test/shared-current-operation.test.ts packages/core/test/shared-current-write.test.ts packages/core/test/shared-current-source-write.test.ts packages/core/test/shared-current-source-file.test.ts packages/core/test/shared-current-source-lifecycle.test.ts packages/core/test/shared-current-upload.test.ts --timeout 60000
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-current-invocation.test.ts --timeout 60000
~~~

需要验证本地持久化时，沿现有 Node runner 运行 `shared-current-operation.node.test.ts`，确认真正 SQLite 中 pending 原位更新和完成删除。

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

Projection 的修改复用 `shared-current-projection-write.test.ts`：未知 append 后
沿同一 `projection PAGE_ID --entry DB --operation ID --resume` 对账，不自动
重放或改 native。Daily 顺序运行每个 Skill，失败即停并返回已成/未成范围；
先恢复失败单项再重跑 daily，相等正文零写。Projection 不提供 supersede。

## Evidence

报告原请求已知结果、当前观察、剩余动作、下一条实际可执行命令及成本。缺实现写 blocked，没执行写 not_run；partial append 的 fail-closed 通过不能说成自动恢复成功。AH-507 的真实业务验收仍独立。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 回收自有对象。完成后只留当前内容；未完成意图需要原始输入时如实说明，不承诺从空 cache 恢复尚未上传的字节。
