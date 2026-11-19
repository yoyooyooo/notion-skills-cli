# Broker 的当前消费边界

主要入口：[verify-notion-consumption](../../verify-notion-consumption/SKILL.md)。CLI 仓库负责当前目录、正文、文件、导出和 SDK 公共合同；Pi 的选择、投递、会话状态及模型实际使用由 Broker 仓库的 verify-notion-skills-integration 负责。

## Launch

先沿 [harness](../references/harness.md#launch) 确认当前入口和隔离范围。安装交接使用实际 CLI/SDK archive，离开 checkout、空 Store、无开发 override。受控 HTTP 来源证明安装包行为，真实 Notion 与 Pi 各自报告。

## CLI / SDK 义务

- 元数据发现保留真实 scope、identity、coverage 和 freshness，不提前读正文。
- 通过完整当前目录解析精确名称或 canonical ref；partial catalog、View 子集、query 和单页不能证明全目录唯一。
- read 查看选定文件，use 准备根及完整 Requires；未选 Member 只保留目录。正文去重不能丢失必要文件。
- files、read 和 export 使用同一完整选定目录；当前声明改变或 native 旧字节缺失时要求重选，不由当前名称暗中重绑定旧选择。
- export 实际输出完整 bytes/path/mode，已存在但不同的目标保持冲突。已知权限失败、未知 source 或完整性失败不能回退为成功。
- 普通消费远端语义写为零；请求预算和取消传入实际 SDK transport，不派生另一份身份缓存或 CLI 子进程协议。

本仓库通过 [当前消费](skill-consumption.md) 和 [安装包检查](portable-export-package-consumption.md) 验证这些边界。使用已有 package:check，不再加一层消费 wrapper。

## 同一次真实 Pro Pi

AH-1063 在 Broker 仓库配对安装同一候选 CLI/SDK/Broker，再用实际启用的 Notion 来源执行自然查找、选用与必要子文档读取。保留实际 provider 输入和模型使用结果；enqueue、候选目录、摘要、hash 或成功 HTTP 都不能代替正文投递。

只验证本次必要场景：目录先于正文、显式选择、完整必要正文、重复使用去重、取消后无迟到投递，以及正常的下一轮输入。普通原文中的未匹配名称与真正的权限/网络/完整性错误，由 Broker 的当前类型化错误边界区分；CLI 不吞错或自动换源。

管理后的阅读使用当前完整导入与实际返回身份。native 正文直接编辑后重新获取最新内容；generated 阅读投影的编辑不自动接管权威。Notion 无 CAS，读回和 hash 不保证与人类编辑之间的原子写入；受控 race 或 API 修改也不称作人工 UI 验证。

这条旅程不重复扩展为每 Skill 的模型矩阵。OMP/Tern 宿主适配延期；其本地 Skill 内容仍属 AH-516 的 Pro 盘点。CLI 安装通过不能代称真实 Notion 全库清理、Pi 日用或全量迁移完成。

## Evidence

源码、受控独立安装、真实 Notion、真实 Pi 分开标 passed/failed/blocked/not_run。核对实际当前 SDK 路径、返回正文、资源 bytes、HTTP/语义写及会话终局。缺原始观测不推断零成本或交付完成。

## Cleanup

沿各自已授权的 fixture owner 清理；不建立另一套跨仓生命周期。CLI 的自有运行目录使用 [harness Cleanup](../references/harness.md#cleanup)。真实页面和当前唯一 bytes 只按任务授权处理，未知操作所需状态暂留。
