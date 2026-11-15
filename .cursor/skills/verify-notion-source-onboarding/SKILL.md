---
name: verify-notion-source-onboarding
description: "验证Source追加后的完整成员对账、冻结接纳、原页面关联、Git获取、CLI/SDK接手和原操作核对。新增或修改Sources及其成员链路时使用；不负责一般正文编辑、消费缓存或以部分来源成功代替全库覆盖。"
---

# 来源接手验证

不负责把Source ready解释为成员齐全，或把registered解释为正文健康。现有 [Sources规程](../verify-ntn-skills/features/resource-sources.md) 是本领域具体合同；[管理](../verify-notion-management/SKILL.md)负责原生导入/作者操作，[消费](../verify-notion-consumption/SKILL.md)负责当前与固定读取。

## Launch

从仓库根运行，使用 [共用隔离设施](../verify-ntn-skills/references/harness.md#launch)。记录精确候选commit、安装CLI/SDK hash与既有冻结计划。不要复制作者Store、修改上游或手工补Skills/Files/Records来通过。

## Doctor

```sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
bun test packages/cli/test/verification-skill-map.test.ts
```

实库必须明确entry和Source；--all是独立授权范围。Provider不可用、缺原输入、无完整cursor或认证不明分别报告，不作为空库。

## Drive

实现切片（受控数据，不写真实库）：

```sh
bun test packages/core/test/shared-source-onboarding.test.ts packages/core/test/shared-source-definitions.test.ts packages/core/test/upstream-source-batch.test.ts packages/core/test/shared-source-projection-retained.test.ts packages/core/test/shared-import-markdown.test.ts --timeout 60000
```

安装代表沿 [resource-sources](../verify-ntn-skills/features/resource-sources.md) 已有入口：

```sh
# INSTALLED_BIN来自本轮独立安装的package.json bin；EVIDENCE为新私有目录。
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_MEMBERS_EVIDENCE_DIR="$EVIDENCE"   bun test packages/cli/test/library-source-members-http.test.ts --timeout 300000
```

未设精确安装bin时不得报告安装证明。该测试使用真实Git HTTP、实际Node/SQLite及同包SDK，但服务为受控Notion；不证明实际Notion导入。

扩展后的同一旅程包含清单前失败、终局审阅、SDK恢复、冷读及重复核对，受控总时限为
300秒并写入receipt；原100毫秒请求调度和产品预算保持。旧短时限超时原件不能改判为通过，
调整时限后的独立运行须保存新证据，不能用总时限变化掩盖未知写入或省略冷读阶段。

| 子模块 | 正例 | 关键反例 |
| --- | --- | --- |
| 配置/发现 | Selection原字段/v1封装、commit/branch/tag完整固定树 | 未知版本/字段、逃逸/缺资源、超时、半分页 |
| 身份/范围 | disabled已接纳、原页绑定、Router单列、精确--member | 同名≠原身份；多个Source冲突；伪造member/目标；不可把Router补成Skill |
| 冻结/执行 | 一个plan由CLI→SDK→CLI交接、零写预览、默认disabled | 来源/目标漂移、失ACK、未知POST、重复建页 |
| 完整资源 | 大清单、100 KiB文本、脚本/binary/mode、冷重建 | 缺块/篡改、丢supporting文件、语义变化不能当格式 |

实库沿review → onboard → dry-run → 同plan apply → 原reconcile → 独立read。--member只限本次动作；--bind是新的明确关联决定，不能冒充历史证明。跨Skill引用应保留待审查，不删链接或放开路径逃逸。

错误返回、已分配主页面、原ACK、manifest和不可变终局是不同事实。清单前读回被拒绝，
但原主ACK和journal完整时，已有apply可复用原页并继续未派发后缀；不需要重建或新恢复器。
`onboard-reconcile` 对精确绑定的缺manifest/outcome结果会指向同plan的只读preview，
而非无限重复reconcile；unknown、终局拒绝、其他owner或无法关联的错误不因此获得续写权限。
核对 [原生导入分支表](../verify-notion-management/references/native-import.md)，并运行
`packages/cli/test/source-onboarding-navigation.test.ts` 与原安装HTTP旅程。
已持久化的保留型语义失败另运行 `packages/core/test/shared-create-retained-recovery.test.ts`：
原父计划精确选子、明确review、零写preview、同producer后缀、独立冷读；不以普通apply跳过终局。
原主页面table-plus修复由 `packages/core/test/shared-source-projection-repair.test.ts` 和
`packages/core/test/shared-import-table-literals.test.ts` 验证。原安装旅程增加公开CLI审阅、
同包SDK一次原页修复、原create继续及冷读取；修复未知时改走original apply也必须拒绝。
这不授权重放400拒绝文件或省略不支持资源，具体分支见管理native-import子模块。

## Evidence

### 外部直取优先与旧库存储对齐

```sh
bun test packages/core/test/shared-source-storage.test.ts packages/core/test/shared-source-member-url.test.ts packages/core/test/shared-source-batch.test.ts packages/core/test/shared-source-run.test.ts --timeout 60000
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_STORAGE_EVIDENCE="$EVIDENCE" bun test packages/cli/test/library-source-storage-http.test.ts --timeout 180000
```

新的storage review只读完整元数据，不把retained选择当作完成；prepare冻结原commit和
完整path/hash/bytes/mode一致的选择，apply复用原v4metadata journal。正例须保留disabled、
custom、原页、原正文和旧包；负例须覆盖变更原文件/Enabled、丢选择响应的两种可见性、
明确retention、无历史commit及未完成原创建。已证明可Git直取不等于可删除旧历史。

新auto不得因非GitHub、补丁或物化失败静默上传完整包。旧GitLab/转换型的保留路径测试
明确选择retained，继续覆盖原守卫而不偷换它们的目的。安装验收必须实际走CLI审阅/
preview、同包SDKapply、CLIreconcile和独立冷SDK原资源校验；实际Notion另记，不手填
成功记录。Git通道与字节/执行安全交给消费入口，不在此复制新的下载或缓存平台。

已审阅恢复的后缀被明确拒绝也不能自动重派发；`shared-create-retained-recovery.test.ts`
保留该反例及未完成审计。恢复错误应只带原operation/file/path与只读精确next.argv，
不能把整份source包或大计划重复返回给Agent。review通过不证明后续每份Markdown均被提供方接纳。

每个来源保存配置指纹、范围、revision、观察区间、成员分母、registered/admit/bind/blocked、原操作及原页。一次全库观察可能跨越其他写入；记录时间区间，最终再对账，不把旧pending覆盖成当前事实。

新成员默认disabled，因此分别核对主表存在与普通目录曝光。父结果partial、失败页存在、原操作确认、完整文件和当前可消费必须逐项判定。失败只回传定位信息与私有原计划路径，不向Agent灌入正文/签名URL/整份原计划。重复已完成动作必须零新增页和业务版本。

## Cleanup

复用 [harness cleanup](../verify-ntn-skills/references/harness.md#cleanup)。保留旧失败、原输入、ACK和已分配页面；原unknown未结清不能清理Store或换计划。导入脚本只做字节校验，不运行。独立冷Agent仅按该Skill的执行评估尚未完成时明确not_run。

### 支持文件物理代码修复交接

shared-source-file-repair.test.ts与shared-import-code-padding.test.ts覆盖原已ACK文件的
局部代码修复。原安装旅程须实际走repair-file→SDK→original recovery→冷读取；
未知row响应不能凭当前正文或另一入口放行。API拒绝的有限诊断仅服务定位，不提供
新的原生请求权限；长正文保留复用现有chunk codec，不扩大普通事实限额。

```sh
bun test packages/core/test/shared-source-file-repair.test.ts packages/core/test/shared-import-code-padding.test.ts packages/core/test/notion-http.test.ts --timeout 60000
```
