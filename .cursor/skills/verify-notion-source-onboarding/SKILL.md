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
NTN_SKILLS_TEST_EXECUTABLE="$INSTALLED_BIN" NTN_SOURCE_MEMBERS_EVIDENCE_DIR="$EVIDENCE"   bun test packages/cli/test/library-source-members-http.test.ts --timeout 180000
```

未设精确安装bin时不得报告安装证明。该测试使用真实Git HTTP、实际Node/SQLite及同包SDK，但服务为受控Notion；不证明实际Notion导入。

| 子模块 | 正例 | 关键反例 |
| --- | --- | --- |
| 配置/发现 | Selection原字段/v1封装、commit/branch/tag完整固定树 | 未知版本/字段、逃逸/缺资源、超时、半分页 |
| 身份/范围 | disabled已接纳、原页绑定、Router单列、精确--member | 同名≠原身份；多个Source冲突；伪造member/目标；不可把Router补成Skill |
| 冻结/执行 | 一个plan由CLI→SDK→CLI交接、零写预览、默认disabled | 来源/目标漂移、失ACK、未知POST、重复建页 |
| 完整资源 | 大清单、100 KiB文本、脚本/binary/mode、冷重建 | 缺块/篡改、丢supporting文件、语义变化不能当格式 |

实库沿review → onboard → dry-run → 同plan apply → 原reconcile → 独立read。--member只限本次动作；--bind是新的明确关联决定，不能冒充历史证明。跨Skill引用应保留待审查，不删链接或放开路径逃逸。

## Evidence

每个来源保存配置指纹、范围、revision、观察区间、成员分母、registered/admit/bind/blocked、原操作及原页。一次全库观察可能跨越其他写入；记录时间区间，最终再对账，不把旧pending覆盖成当前事实。

新成员默认disabled，因此分别核对主表存在与普通目录曝光。父结果partial、失败页存在、原操作确认、完整文件和当前可消费必须逐项判定。失败只回传定位信息与私有原计划路径，不向Agent灌入正文/签名URL/整份原计划。重复已完成动作必须零新增页和业务版本。

## Cleanup

复用 [harness cleanup](../verify-ntn-skills/references/harness.md#cleanup)。保留旧失败、原输入、ACK和已分配页面；原unknown未结清不能清理Store或换计划。导入脚本只做字节校验，不运行。独立冷Agent仅按该Skill的执行评估尚未完成时明确not_run。
