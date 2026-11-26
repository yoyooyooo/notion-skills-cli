# 当前合同与验证边界

[current-convergence](../features/current-convergence.md) 定义本轮六组顺序，[current-contract](../../../../docs/current-contract.md) 定义产品，[功能入口](../features/README.md) 选择必要的领域 Skill。旧 case ID 和通过记录不能替代当前候选的结果。

## 当前管理

`ctl library import` 接受完整本地文件树。先 dry-run，再执行同一输入；需要恢复时沿同一入口提交原 operation 和完整输入。每个文件只有当前权威，正文阅读投影不自动转移权威。Operation 只保留未完成意图，完成后清理。

同步后用 `ctl library projection PAGE_ID --library LIBRARY_ID` 或授权日用范围的 `--daily`
生成完整主文和文本子文件正文。Native 只读验证，非文本明确跳过；投影意图不改
真实 Skill ready，同版本正文零写。Daily 失败可重跑同一普通 daily 命令；只在
目标、policy 和完整输入一致时续原意图。非日用投影与额外二进制呈现不作为
日用文本完成的前置。

已完成 Skill 被移入 Trash 后，用原 exact page 的 `projection PAGE_ID --restore
--library LIBRARY_ID` 恢复同页并完成原 automatic projection。恢复与投影各用有限意图、
共享一次预算，保留身份、四开关、native/resource，不重新发现 Source HEAD。
自身阶段中断重跑同命令；旧 projection pending 又被外部 trash 的情况零写
拒绝。真实验收先清生成正文再 trash，完整对照并重跑零写；额外 Agent 修补
不能作为成功证据。步骤见 [current-convergence](../features/current-convergence.md#单条命令恢复已完成的投影)。

从 Skills 关联 Files，应能读到每个文本的完整内容，二进制有可用原件。export 和单文件 read 核原始 bytes、mode 和路径。导出携带当前 Members/Requires，显式关系替换遵守同库、唯一身份、完整分页与依赖安全边界。参考 [管理](../../verify-notion-management/SKILL.md) 和 [导入旅程](../features/import-create-recovery-dry-run.md)。

## 普通消费与成本

list/read/use/files/resource/export 的语义远端写入为零。query POST 是读；创建 Record、修补投影、接管或恢复都是写。外层 TTL 命中、metadata 复核、必要 body 读取分别报告成本。任何 partial、权限缺口或未观察范围都不能变成完整结果。

请求隔离、取消、共享和重试沿 [请求模型](../features/request-engine-formal.md) 及 [维护合同](../../../../docs/formal-verification-maintenance.md) 验证。保留的 `verify-formal.mjs --suite request-engine` 只运行两项请求模型；`--suite current-lifecycle` 由资源状态 Skill 独立维护。当前资源状态和恢复由各自 Skill 选择实现测试，已取消的 ACK、历史恢复和独立接受模型不再有执行入口。

## 实际系统结果

源码回归、受控 HTTP、独立安装包、真实 Notion 与 Pi 日用分别报告。管理成功后 Broker 只让对应目录失效；已经接受的任务内容不能被静默替换。单次试点不能证明全 Pro 迁移、全库清理或任意规模安全。

旧对象清退、实现退役与 Pro 内容迁移分别保留 AH-513/AH-517/AH-516 的原范围。当前配对安装、两机日用与持续同步沿 AH-1197/AH-637/AH-1198，AH-1063 仅为其版本的历史结果。OMP/Tern 宿主适配延期，其 Skill 内容仍在迁移范围。

只执行任务已经授权的对象范围。未知写入不能盲目重发，未完成意图保留必要输入；完成后仅保留最新内容。验证选择受影响边界，不扩大成全矩阵或新增永久证据平台。
