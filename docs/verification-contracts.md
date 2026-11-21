# 当前验证合同与证据

当前主线是 [AH-1188](https://linear.app/yoyooyooo/issue/AH-1188)，本入口由 [AH-1189](https://linear.app/yoyooyooo/issue/AH-1189) 维护。
[skill-domains.json](../verification/skill-domains.json) 是合同、领域 owner 和场景的唯一索引；它不是运行成绩册。
先按改动读取对应合同及场景，再沿既有 Skill 执行最小完整范围。当前目标行为与实际实现结果分开，尚未运行的边界保持 not_run。

## 责任

| 合同 | 主要状态/验证 owner | 必须独立观察 |
| --- | --- | --- |
| C01–C04 | Broker consumer-state；AH-1191/1192 | 固定选择、准备、有效正文、provider 接受与后续 turn |
| C05 | Broker consumer-state；AH-1193 | View 成员、精确资格、旧完整任务、显式 current |
| C06 | CLI management；AH-1194 | 内容 authority/readiness、完整树与独立阅读投影 |
| C07a | CLI consumption；AH-1190 | Store generation、clear、迟到发布及新 deny |
| C07b | CLI operation-recovery；AH-1194 | unknown/partial、原意图恢复及有限退役 |
| C07c | Broker consumer-state；AH-1191 | scope/epoch、fork、取消与迟到交付 |
| C08 | Broker context-broker；AH-1196 | 自然任务结果、实际正文、工具必要性 |
| C09 | CLI consumption；AH-503 | 共享获取、预算、取消、实际等待与完整性 |
| C10 | Broker integration；AH-1197、AH-637 | 每机源码→产物→实际加载→新 Pi；后续同步 |
| C11 | CLI verify-ntn-skills；AH-1189 | 合同→场景→运行→候选/加载→原件 |

C07 的总索引由 consumption 维护，三个状态子合同各有唯一 owner。
resource-lifecycle 拥有 CLI 当前生命周期模型；operation-recovery 拥有实际管理恢复回放，两者互相引用，不重复 writer。
请求引擎模型只拥有请求准入和 producer/waiter；Broker 模型只证明其明确假设下的消费者状态。形式化验证者不成为第二个产品状态 owner。

## 场景选择

索引保留审计 T01–T15 的危险时序，并增加 T16 主动采用、T17 查看不采用、T18 连续三轮恢复故障、
T19 开关四组合、T20 多根共享 Requires、T21 两机持续同步、T22 本地充分负例及 T23 结果失败传播。
每行含前置状态、事件顺序、oracle、owner、入口、最低执行层及是否仍需 live 抽查。

每个入口同时列 command 和 required_inputs。命令里的 `/absolute/owned/` 是待替换的自有路径，
只有补齐配置、目标身份与环境后才可执行；列表本身不表示运行完成。
C10/T21 使用 daily-installation 的 plan/run/candidate-plan/candidate-run 公开动作。
plan 及 candidate-plan 只准备输入，帮助输出也不是场景成绩。
candidate 是项目级检查，不能替代 Pro/Mini 的普通日用入口；候选实现模块不能直接作为 CLI 调用。

不要遍历全部笛卡尔积。精确 TTL、24 小时 body 期限、publication/取消等使用受控时钟和 barrier；
真实 Pi 执行代表性时序并核实际 payload。增加失败缩减后，更新原场景和所属实现回归，不按 bug 新建 Skill。
已有命令是入口，不表示该场景已通过；新增合同的生产反例及当前修复需取得新结果。

- 固定 A 与 current B 分开。目录刷新和 TTL 不偷偷升级任务；明确采用 B 才提交新完整选择。
- Default Context 随实际选定 View 决定默认候选，不自动注入正文、授予权限或 release。
  新 current 按 Enabled/授权判断；已完整旧任务、精确缺字节补取和授权拒绝各有不同边界。
  metadata 缺行不能推导精确 deny，重新启用需可信 fresh use 或新 metadata 观察。
- 缓存层分别记录 observations、objects、manifest、短引用和有效 context。cache clear 不等于空 Store。
  不能恢复的 mandatory closure 应降级该能力；后续普通聊天和刷新请求必须可达模型。
- 当前 Source 声明与稀疏阅读投影分开；脚本、测试、二进制和 mode 仍属于完整消费树。
- 内容 Operation 与独立 projection intent 是两条状态轴。projection pending 不将内容 owner 改为 applying，
  也不能在结束时把另一个 writer 的 unready owner 改回 ready。

## 结果回执

复用现有 controller 的 commands、安装结果、模型 summary、SDK/host 日志及 Pi trace。
用一个薄回执引用它们；不要复制正文、建立永久结果数据库或新调度器。
[run-receipt.mjs](../verification/run-receipt.mjs) 只检查字段及证明层级，不执行或认证底层行为。

```sh
node --test verification/run-receipt.test.mjs
node verification/run-receipt.mjs /absolute/owned/run/receipt.json
```

回执 version 为 1，包含：

| 字段 | 必要事实 |
| --- | --- |
| run_id、contract_ids、scenario_id | 唯一实际运行、对应索引；多票引用同一 run 不重复计数 |
| status、reason、retest_of | passed/failed/blocked/not_run；非通过有原因；复验保留原失败关联 |
| command、started_at、finished_at | 实际 argv/cwd 与起止；not_run 不伪造执行时间 |
| source_tuple | repository、完整 commit、dirty、实际输入树 sha256 |
| loaded_artifacts | role、实际 path、sha256；分支名或版本字符串不能代替 |
| environment | 物理 machine、runtime、scope_fingerprint；不得包含凭据 |
| initial_state | cache/session、oracle 是否独立、初态原件 uri/hash；cold 不能由同一 Store 预读期望值 |
| evidence | layer、Notion/host/provider 来源与 prompt_kind |
| raw_evidence | 原件 uri/sha256；完整正文、provider payload 和网络日志按原件保存，不内嵌此回执 |

source_tuple 和 loaded_artifacts 记录实际输入与加载；脏树的 tree_sha256 必须覆盖所执行的受影响文件，
不能只写 HEAD。host/installed/live/natural 层要求完整 CLI/Broker 配对。
原件哈希必须从文件计算；校验器不凭格式检查证明文件存在或内容正确。

layer 分 static/model/unit/store/sdk/host/installed/live/natural。
live 要真实 Notion、Pi 和 provider；natural 还要求自然用户提示与真实模型，不能来自受控 provider 或预先指定工具/flag 的提示。
纯本地自然控制组可标 Notion not_used，但不能作为真实 Notion 通过。
模型配置突变、真实 guard mutation、生产代码+fixture、真实 SQLite 进程、安装态 HTTP 与自然模型各按实际范围记录。

passed 必须有真实命令、输入/加载身份、起止和原件。
blocked 是所需环境/权限/输入不可用；not_run 是未执行；观测到违约为 failed。
`summarizeRunReceipts` 对本次必需运行集合保留失败，空集合也不会通过。
原首次失败独立保留；复验不得覆盖它，选择新的最终候选结果时写清 retest_of 和影响面。
receipt-valid 只表示结构有效，不等于底层通过；缺字段、fixture 充 live 和机器不符须拒绝。

## 当前与历史

AH-500/560/639/871/1063 是各自版本的历史证据，不能成为当前两机默认通过。
后续 AH-501/AH-1141 的真实 Pro 目录、冷读、SDK 与公开 cancel 结果按准确配对和范围复用；
不把已收敛的两个旧 pending 继续报为现场阻塞，也不由它们推导长会话已通过。
最终真实运行由 AH-1198 汇总，Mini 独立验收沿 AH-637；OMP/Tern 仍在 AH-272。

当前已退役的 ACK/review/completion、永久历史 pin、旧工具和旧 reader 不恢复。
有限清退完成后删一次性运行入口，静态失败证据保留。当前精确恢复、有界重试和能力降级沿唯一实现继续验证。
形式工具版本、覆盖输入、实际 guard 和 CI 由对应领域维护；hash 变更先审代码，不自动刷新放行。
