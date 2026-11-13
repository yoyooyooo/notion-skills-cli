# 完整 Skill 的渐进维护

AH-1024 管理此批，AH-1025 至 AH-1033 持有下表交付。先更新受影响的合同和失败用例，再改实现。未运行的场景不能记为通过。

## 责任与可失败场景

| 场景 | 实现责任 | 验证入口 | 关键反例 |
| --- | --- | --- | --- |
| MNT01 草稿和注册状态 | 目录分类、inventory、目标 inspector | shared-audit-draft、shared-audit、native-adoption | 合法草稿误报；清空身份藏历史；错字段被当空值 |
| MNT02 目标诊断和全库范围 | 原 audit scheduler、检查点和覆盖 | resource-audit、安装 smoke | 无关行拖慢目标；关系丢失的孤儿被漏报为全库完整。`--target` 只读可达页和关系过滤头；`--all`/`--census` 才是完整反向表 |
| MNT03 原页修复和接管 | adoption、identity、operation | authoring、operation-recovery | 无ACK重建、复制身份、部分schema、并发手改 |
| MNT04 整树计划 | apply planner、文件与引用解析 | apply、resource-lifecycle | 省略当删除、同名猜移动、误改样例、丢未改文件 |
| MNT05 执行和删除恢复 | 原父子操作与文件状态 | operation-recovery、实际HTTP | unknown重放、半树当完整、恢复新身份、覆盖人类编辑 |
| MNT06 Agent命令与维护Skill | canonical parser、原操作路由、builtin | help/schema、安装CLI、冷Agent | next.argv猜引用、跨族恢复、说明代替可执行入口 |
| MNT07 保留原因与增长 | audit/history、同事实复用 | resource-audit、表行和请求 | 无链接当孤儿、同header当同payload、历史pin当垃圾。同主同 Record 头只记 possible_equivalent；`next.argv` 只指向 help 或 resume |
| MNT08 跨系统组合 | 现有Pi Mock和integration | 实际CLI、Pi、serializer、Session | 测试插件补正文、半新图、晚回调、效果丢失 |
| MNT09 安装与日用候选 | 分发产物与owned真实目标 | package smoke、真实Notion、Pi两臂 | 源码代替安装、私有缓存兜底、暖纠错改记冷成功 |

`verify-notion-resource-lifecycle` 负责身份、归属、删除和审计范围的有限合同。`verify-notion-operation-recovery` 负责原请求、ACK、部分完成和未知结果。Broker 的 consumer-state 与 integration 负责管理结果进入固定图、实际请求及回执的交接。

默认维护这些入口，不新建总验证 Skill 或 Mock 专属 Skill。新 guardian 只有在独立状态归属、独立不变量和独立可执行反例均成立时才准入。它须说明复用及替代关系、源码对应、工具锁、精确正负性质、真实 guard 反例、结束及清理方式，并由冷 Agent 独立运行。仅有文档时保持 draft。

## MNT01 执行入口

从当前 checkout 执行，不连接生产 Notion：

```sh
bun test packages/core/test/shared-audit-draft.test.ts packages/core/test/shared-audit.test.ts packages/core/test/shared-audit-inventory.test.ts packages/core/test/shared-native-adoption.test.ts --timeout 30000
```

先在未修改源码上保留 `shared-audit-draft` 的失败日志。用同一物理页驱动目录分类和完整 audit run，再检查 report。不要只验证纯分类器。

合法禁用草稿允许名称、描述和 Kind 尚未完成。它不进入消费者目录，不因此获得可接管资格。主文件身份、来源、关系、Files 和 Records 残留仍须显式检查。字段类型错误、分页不全、反向表未观察不能被归为干净草稿。

metadata 审计可完成草稿的注册检查。未注册正文和历史未验证时保持 unobserved，不能把 metadata 成功扩大成 content/history 通过。审计不调用 adopt、修复、正文写入或消费保留。

共享规则变化须升级 audit 规则版本。旧 checkpoint 可以离线查看原事实，但不得跨新规则恢复或用旧结果制造增量通过。

## 组合与成本合同

主场景覆盖草稿、接管、消费、拆分、引用移动、删除、恢复、并发编辑、原操作续接及新旧会话消费。每个前置票先验证自己的切片；MNT08 不负责把前置空规程变成通过。

Mock 只替换模型决策或外部服务。参数来自真实可见内容和返回的精确 next.argv。CLI、SDK、工具循环和 serializer 使用真实实现。独立 oracle 保留原文、身份、引用、原生 Session 和实际 HTTP，不调用产品实现制造预期答案。

来源请求、作者写入、保留写入、实际响应字节和表行增量分别记录。no-op、重复原操作与真实变更分别测量。私人会话 pins 无法全局枚举时不能建议全局清理。保留原错误、部分覆盖、未运行和未知终局。

## 文档与模型维护

每个切片更新本地图、相关公开协议及 builtin。通过 Pro 的正式 `ntn` 更新受影响的 Notion 长期页并完整读回，保留历史结论和子页链接。

AuditRun 目前只抽象只读、反向覆盖和续跑，不含具体草稿字段。MNT01 由实现与安装回归证明，不能仅刷新 coverage hash 获得形式化证明。状态协议真正变化时补最小模型和精确反例，Statechart 从同一模型生成。


## Joined installed acceptance

The package smoke now calls `checkProgressiveMaintenance` through the existing installed authoring fixture. It must retain one original main and two new references, verify actual raw bodies and stable identities, preserve an old pin, perform explicit move/delete/undelete, and show zero source-row growth for identical current input. `checkMaintenanceRepairHttp` alone remains a source-fixture check; it cannot stand in for the actual installed/live repair evidence.

The primary Linux/Node24 CI lane builds a Broker from its frozen source with this exact CLI candidate, installs both artifacts and Pi 1.5.0, and sets `MNT_VERIFY_PI_REQUIRED=1`. The existing package runner then drives actual Pi, tools, Node CLI, SQLite, source HTTP and normal model serializer. `maintenance-ci.test.ts` fails if that path, pinned version, mandatory flag or original artifact retention is removed. Other lanes report the Pi scope as not_run and still run all installed CLI checks.

`maintenance-pi.test.ts` validates the independent oracle: exact read-only next.argv, original call IDs, full source and effects, complete directory objects and native Session. Paths repeated in authoring output do not count as duplicate generated directories. Mock cannot choose a missing ref from the source oracle or replace an unsupported split with a simpler write. Model usage is not a real-model cost measurement.

Formal source correspondence is recorded in `docs/maintenance-verification-review.md`. AuditScope adds 7 exact positive/negative configurations to lifecycle; MaintenanceApply adds 6 to operation recovery. Full suite totals are 40 and 34 respectively. A new run must preserve its original failure artifacts and complete property inventory.
