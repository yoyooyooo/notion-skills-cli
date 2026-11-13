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
| MNT07 保留原因与增长 | audit/history、同事实复用 | resource-audit、表行和请求 | 无链接当孤儿、同header当同payload、历史pin当垃圾。同主同 Record 头只记 possible_equivalent；`next.argv` 为只读 help/resume/report，完整反向 census 单列为可选 alternative |
| MNT08 跨系统组合 | 现有Pi Mock和integration | 实际CLI、Pi、serializer、Session | 测试插件补正文、半新图、晚回调、效果丢失 |
| MNT09 安装与日用候选 | 分发产物与owned真实目标 | package smoke、真实Notion、Pi两臂 | 源码代替安装、私有缓存兜底、暖纠错改记冷成功 |

`verify-notion-resource-lifecycle` 负责身份、归属、删除和审计范围的有限合同。`verify-notion-operation-recovery` 负责原请求、ACK、部分完成和未知结果。Broker 的 consumer-state 与 integration 负责管理结果进入固定图、实际请求及回执的交接。

默认维护这些入口，不新建总验证 Skill 或 Mock 专属 Skill。新 guardian 只有在独立状态归属、独立不变量和独立可执行反例均成立时才准入。它须说明复用及替代关系、源码对应、工具锁、精确正负性质、真实 guard 反例、结束及清理方式，并由冷 Agent 独立运行。仅有文档时保持 draft。

## 按切片选择现有入口

MNT02/07 见 [resource-audit](resource-audit.md)；MNT03 见 [maintenance-repair](maintenance-repair.md)；MNT04/05 运行 `bun test packages/core/test/shared-skill-apply-tree.test.ts packages/core/test/shared-skill-apply.test.ts packages/core/test/shared-maintenance-operations.test.ts --timeout 60000`；MNT06 使用公开 `ntn-skills schema ctl` 与 `packages/cli/test/maintenance-repair.test.ts` 的命令 schema 回归。MNT08/09 的安装路径见下方 [joined installed acceptance](#joined-installed-acceptance)，实际 Pi 使用 Broker 的 `verify-notion-skills-integration` 维护地图。每次只选择受影响入口，不要求全部切片重跑。

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

The package smoke calls `checkProgressiveMaintenance` and `checkInstalledMaintenanceRepair` through the existing installed authoring fixture. The first retains one original main and two new references with original modes `100644` and `100755`, verifies actual raw bodies and stable identities, preserves an old pin, performs explicit move/delete/revive, and shows zero source-row growth for identical current input. Revival uses one public `apply --changes` parent for the original file and its main-body reference, with a zero-write dry-run first; require unchanged native identity, bytes and mode, plus the original deleted pin remaining absent. Repair seeds only native service rows, then drives the installed Node bin through public plan/apply/show/reconcile/repeat commands. It verifies historical-main and managed-file repair, unchanged original pages, URLs, authors, body and extra properties, one identity PATCH per page, zero repeat writes/row growth, and an explicit ordinary-child refusal. Source-function tests remain a separate layer; neither controlled HTTP path claims real Notion acceptance.

For the installed progressive representative, use the existing package smoke entrypoint from the repository root:

```bash
NTN_SMOKE_EVIDENCE_ROOT=/absolute/owned/evidence \
  bun scripts/package-smoke.ts --stage maintenance \
  --archive /absolute/ntn-skills.tgz \
  --migration-archive /absolute/ntn-skills-state-migration.tgz \
  --runtime /absolute/node
```

Use the exact supplied candidate archives and a supported Node executable. This installs into an isolated consumer and runs the same progressive stage through public CLI subprocesses and the owned HTTP service; it does not run repair, Pi or the remaining package stages. Omit `--stage` for the complete package smoke. Preserve stdout/stderr/exit and the emitted `ntn-skills-consumer-*` directory. Read `controlled-authoring/progressive-maintenance.json`, `controlled-authoring/evidence.json` and `controlled-authoring/source-terminal.json` together: audit actual command inputs/outputs, HTTP request/response ledger, source bodies and identities, modes, no-write observations, and service shutdown. Do not replace missing originals with a returned summary or import internal handlers to manufacture evidence.

For a focused repair run, reuse `prepareConsumer` and `checkAuthoring(consumer, undefined, { repairOnly: true })` with an independently installed archive. This skips the unrelated author lifecycle while retaining the same command/HTTP ledger, isolated SQLite state, native source oracle and service shutdown. Preserve `maintenance-repair.json`, `evidence.json` and `source-terminal.json`; a missing original command, source response or shutdown record cannot be replaced by the returned summary.

The primary Linux/Node24 CI lane builds a Broker from its frozen source with this exact CLI candidate, installs both artifacts and Pi 1.5.0, and sets `MNT_VERIFY_PI_REQUIRED=1`. The existing package runner then drives actual Pi, tools, Node CLI, SQLite, source HTTP and normal model serializer. `maintenance-ci.test.ts` fails if that path, pinned version, mandatory flag or original artifact retention is removed. Other lanes report the Pi scope as not_run and still run all installed CLI checks.

Resolve the selected Node launcher's `process.execPath` before creating isolated consumer and Pi environments. Version-manager launchers can depend on the original HOME. Keep the isolated HOME and credentials boundary; do not copy the user's runtime configuration into it. The home-dependent launcher regression must fail for the launcher in the isolated home and run successfully through the resolved binary. An actual Session reporting a launcher error or `CLI_JSON_MISSING` is a failed installed run, even if Pi exits zero.

`maintenance-pi.test.ts` validates the independent oracle: exact read-only next.argv, original call IDs, full source and effects, complete directory objects and native Session. Paths repeated in authoring output do not count as duplicate generated directories. Mock cannot choose a missing ref from the source oracle or replace an unsupported split with a simpler write. Model usage is not a real-model cost measurement.

Formal source correspondence is recorded in `docs/maintenance-verification-review.md`. AuditScope adds 7 exact positive/negative configurations to lifecycle; MaintenanceApply adds 6 to operation recovery. Full suite totals are 40 and 34 respectively. A new run must preserve its original failure artifacts and complete property inventory.

## Independent-review regressions

`shared-skill-apply.test.ts` must exercise complete add/delete/revive parents with
regular, executable and historically unknown modes. Known original modes survive
revival; unknown modes stay absent. `shared-skill-apply-tree.test.ts` rejects a
submitted mode change even when bytes match. A version-2 dry-run must perform the
same complete-tree reconstruction as execution and reject unavailable retained
bytes before any pending receipt, original plan or semantic write.

`shared-native-repair.test.ts` must keep a same-owner local original repair pending
when the source query temporarily omits its plan. A completed-looking identity is
not an outcome, and another owner remains usable. The no-repair path must not add
a redundant authentication request; `shared-audit.test.ts` checks cancellation
and resumed request reuse.

`shared-audit-target.test.ts` checks a Files permission denial followed by a
request-budget pause in both initial and final observations. The online and
offline reports retain that finding. Resume keeps the original failed response,
even when a separate final observation later proves access. These are concrete
source/transport regressions, not newly claimed TLC properties.

`shared-file-management.test.ts` must exercise a real controlled HTTP response
for an event that the same execution acknowledged but an immediate full query
omits. That exact acknowledged event can join the fresh history; a conflicting
same-ID payload must stop completion. Independent reconciliation still requires
the original complete outcome: a matching current path or event alone never
settles an unknown original operation.

## Real native split regression

Use the existing `shared-body-write`, `shared-file-management`, `shared-skill-apply` and `shared-maintenance-operations` tests. Cover a ~23 KiB main shortened through the actual bounded operation record, compact/full plan round-trip and corruption, true unique-input overflow before dispatch, existing-target relative links over a service that rewrites bare relative URLs, and explicit observed-body acceptance with old failure preserved and cold retained-body proof. New-file mutual links must refuse before writes until the pages are staged; a permissive fixture must not claim native Notion supports them. The same real mobile-use page/file identities and prior pin are the live continuation, not a replacement fixture.
