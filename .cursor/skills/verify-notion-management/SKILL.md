---
name: verify-notion-management
description: "验证 Notion 当前字段、文件权威、完整树、Profile 更新、有限恢复和实际残留清理。修改 Skills/Files/Records 管理或清退时使用；区分已实现 current reader/Profile 与尚未公开的内容 writer。"
---

# 当前管理验证

执行 [current-convergence](../verify-ntn-skills/features/current-convergence.md) 第 1、2、4 组。本入口不负责消费缓存，也不负责以受控代码代替真实 Notion 清理、安装或 Pi。

## Launch

沿 [共用 Launch](../verify-ntn-skills/references/harness.md#launch) 隔离。从任务已有授权确定 exact owner 和作用范围；受控测试不写生产库。同一当前目标保持单一管理 writer。

## Doctor

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-profile.test.ts --timeout 60000
~~~

前者验证当前 schema、完整分页和身份边界；后者验证单 current Profile 替换、冲突与有限对账。两者不证明内容整树 writer、完整人类投影或清理已完成。

## Drive

1. 核 Skills 主文和 supporting Files 的严格 Content union、stable ID、唯一 owner、安全 path、mode 和 Current State/Operation。native 没有阻断人工修改的存储 hash；source/resource 必须有 exact hash/bytes。
2. 管理 inspect/files 可以返回 applying/attention；普通 reader 在获取正文前拒绝。旧 Content 缺失明确要求显式转换，无 Projection 或旧 event fallback。
3. Profile 用完整当前规则与 expect fingerprint 替换同一 Record。遗漏可选字段表示清除，重复内容 0 写。lost-response reconcile 只读当前规则，不能伪造原 ACK 或重复未知 POST/PATCH。
4. 对待接入的内容 writer，保留完整 main、文本/代码、图片/原件、relative links、modes、关系和排除意图。显式权限转换不得覆盖另一个 Source 或人工内容。现有 index 验证不能替代实际提交。
5. 改名、移动、删除/排除、换源和停用必须查反向关系；missing/forbidden/partial 不算不存在。全库 census 必须完整枚举并解释缺口。当前公开 CLI 尚无 census/cleanup writer，不能教已退役 audit/apply 来补这一步。
6. 真实清退先移交唯一当前字节，再移除旧表/字段/页/Records/附件/导航，重新枚举并重复治理 no-op。隐藏列、加标签或保留平行旧库不算清理完成。

实际安装与现有测试对应见 [skill-maintenance](../verify-ntn-skills/features/skill-maintenance.md)。当前命令只公开 library init/inspect/files/profile 和消费；内容 writer 未接入时如实 blocked/not_run，不借旧接口跑通。

## Evidence

分别报告当前正文、当前关系、实际 effects、cost 和剩余范围。Profile 完成不能替代一般 content recovery。当前 schema 校验不能替代 AH-501 全文阅读或 AH-513 实库清退。

## Cleanup

沿 [共用 Cleanup](../verify-ntn-skills/references/harness.md#cleanup) 仅回收自有且已移交当前内容的对象。必要在途状态有界保留；过去 unknown 和已取消的历史 pin 不能无限阻断新的当前状态。所有本地移除进入系统 Trash。
