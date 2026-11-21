# 当前 Skill 消费链

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。本页连接 CLI/SDK 的当前消费、独立安装与 Broker 交接；必要用例由领域 Skill 和 [current-convergence](current-convergence.md) 选择，不维护历史 case 矩阵。

## Launch

复用 [harness](../references/harness.md#launch) 的隔离目录和实际 CLI。消费不能复制作者 Store、预填旧 snapshot 或调用旧写入路径。scope、endpoint、权限和 freshness 必须与本次任务一致。

## Doctor

执行领域 Skill 中受本次变更影响的当前索引、快照、相对引用、获取和请求测试。缺 Content、非 ready、错 owner/path、未完分页、截断正文和缺失 exact bytes 都必须拒绝完整结果。声明、类型检查或 fixture 生成成功不能替代实际读取。

## Drive

按用户路径检查必要边界：

| 路径 | 当前义务 |
| --- | --- |
| list / 目录 | 元数据发现不读正文，分页完整；query/limit/cursor 不能伪装完整唯一性 |
| read / files | 正文和 supporting 目录属于同一 owner，严格 Content 和当前权限有效 |
| use / Requires | 交付完整选定闭包，正文不重复，未选择的 Member 不加载正文 |
| 单文件读取 / export | 使用返回的精确引用，保留 path、bytes、hash 和 mode；检查真实产物 |
| cache / freshness | 期限内直接命中与 metadata 复核分开，命中不更新原验证时间 |
| 取消 / 预算 | attempts、bytes、deadline 和 limit 各自有界，取消后无迟到派发 |

同任务保持完整选定目录。补取 Source/resource bytes 时，当前 owner 和 descriptor 仍须相符；native 旧选择字节缺失或当前声明改变时要求重选，不查询远端历史。Name/Description 可以更新当前 metadata，但不改 authored bytes，原任务已选 metadata 不被暗中重写。

相对路径从实际返回的父文件引用解析，不能越过所选 owner；文本行切片与 raw 输出不改变所选原件，二进制使用精确输出路径。相关现有回归在 `packages/core/test/snapshot.test.ts`、`packages/core/test/cache.test.ts` 与 `packages/core/test/shared-current-relative.test.ts`，只选择本次受影响部分。

目录完整与全文投影分别检查。当前 Source/resource exact bytes 不等于 Notion 上每个子文档已有可读正文；Skills→Files 的人类阅读沿 current-convergence 第 1 组验证。

普通消费的远端语义写必须为零。Notion query POST 是读；Record 创建、投影、adoption、归档和清理都是写。权限失败、非 ready、owner 变化、缺文件与损坏字节不能回落到旧 cache 或旧 reader。

Profile freshness 沿当前 Profile 规则解析；单次请求、逐 Skill、Profile default 和产品 default 的优先级由对应当前测试负责。较长策略不延长资格或完整正文的独立约束。fingerprint 是已观察基线检查，不是 Notion CAS。

## 安装与 Pi

~~~bash
bun run package:check
~~~

沿 [安装包消费](portable-export-package-consumption.md) 检查实际 Node CLI 与同 archive 的 SDK，默认执行全部当前用例。采用实际报告的合同、选择和失败数，不把退役 fixture 或历史用例数作为 gate。

Broker 使用当前 SDK 交接；[Broker 消费](broker-consumption.md) 规定本层边界。真实 Pro/Mini Pi 沿 AH-1197/AH-637/AH-1198 的当前旅程，检查实际模型输入与使用；受控 provider、安装包或源码通过不代替它。OMP/Tern 宿主适配延期。

## Evidence

比较成本时固定相同内容、scope、权限和 freshness。分别记录冷读、metadata 复核、有效 TTL 命中、单文件变化和必要重取。沿既有实际 ledger 记录 HTTP attempts、完整响应 bytes、语义写和取消终局；缺项或截断为 unknown，不补零。

不把减少本地解码称为减少 HTTP，也不通过延 TTL、提预算或减少正文制造收益。若响应中断，只报告实际观察前缀，完整响应 bytes/hash 保持未知。性能、目录、实际全文、独立安装和模型使用各报自己的范围。

## Cleanup

沿 [harness Cleanup](../references/harness.md#cleanup) 回收自有派生目录。未完成操作和当前任务必要字节暂留，当前唯一内容先移交。一次结果足够，不保留内容历史、旧 pin 或多层签收链作为长期合同。
