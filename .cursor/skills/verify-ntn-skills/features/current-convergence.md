# current-convergence：最新态收敛旅程

主要入口：[verify-ntn-skills](../SKILL.md)。执行 [AH-500](https://linear.app/yoyooyooo/issue/AH-500) 的六组检查，产品边界以 [AH-498](https://linear.app/yoyooyooo/issue/AH-498) 和 [AH-499](https://linear.app/yoyooyooo/issue/AH-499) 为准。

这是一条复用现有命令、fixture 和领域 Skill 的有限旅程。没有新的 runner、台账、证明链或宿主矩阵。先按本次改动选择必要组，不递归运行所有旧 recipe。命令存在、路由通过或旧测试通过均不能证明最新态目标已经实现。

## 入口与范围

| 组 | 当前交付 | 功能 owner | 本轮结果边界 |
| --- | --- | --- | --- |
| 1 | 当前内容、权威、完整树与全文阅读 | AH-499/1140/1141/1142/501 | 必要样本加实际覆盖，不能用样本替代全库 |
| 2 | Notion 旧对象与关系清理 | AH-505/513 | 完整授权库 census、实际清退、二次 no-op |
| 3 | 无历史依赖、无消费写、唯一当前协议 | AH-1140/1142/517/617 | 实现、公开入口及安装包都检查 |
| 4 | 当前管理操作有限恢复 | AH-504/507 | 一项管理意图的代表中断切点 |
| 5 | HTTP、字节、分页与取消有界 | AH-503 | 同内容/scope/freshness 的真实计数 |
| 6 | 配对安装与真实 Pro Pi | AH-1063 | 一次必要试点旅程，复用其实际结果 |

AH-516 负责 Pro 全本地内容及曝光/更新入口的逐项对账，最终由 AH-498 汇总。不把全量迁移变成 AH-1063 首次日用的前置；也不把首次日用成功当成全量迁移完成。386 仅历史 AK 子集。OMP/Tern 的宿主适配延期，其目录中本地 Skill 内容仍属于 Pro 盘点范围。迁入 Notion 不等于全部加入 Default Context。

## 开始前

1. 明确当前库/目标、候选代码或安装包、必要权限和本次覆盖。沿任务已有授权执行，不因验证扩大写入范围；缺条件只报告具体缺项。
2. 阅读对应领域 Skill。当前 schema/reader/writer/模型尚未切换时如实标 failed 或 blocked，不把旧合同的 PASS 带入本次。
3. 先在受控 fixture 确认普通读取远端 0 写。若 reader 仍自动留存或 adopt，停止真实库普通消费验证，由 AH-1140 修正；不能让只读验收实际产生历史对象。
4. 从仓库根运行，共用隔离设施。以下只准备自有目录，不创建 Notion 对象：

~~~sh
CURRENT_RUN="$(mktemp -d /tmp/ntn-current-convergence.XXXXXX)"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$CURRENT_RUN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$CURRENT_RUN"
bun test packages/cli/test/verification-skill-map.test.ts packages/cli/test/maintenance-ci.test.ts
~~~

Doctor 仅证明离线入口可启动；它不证明 schema、正文、安装或线上清理。harness 的旧 package/history 配方不是本旅程的前置，不扩 control.ts 或 nxt-journey.ts。

## 1. 当前内容与阅读

按 [消费](../../verify-notion-consumption/SKILL.md)、[管理](../../verify-notion-management/SKILL.md) 和 [来源](../../verify-notion-source-onboarding/SKILL.md) 的当前切片执行。

用必要的 git-only、mixed、Notion-native 样本覆盖主文、Markdown、代码/字面文本、图片/二进制。核对 Skill/Router/Prompt、Members/Requires、当前排除与权限，覆盖样本可复用，不做全部维度的笛卡尔积。

确认当前入口和精确选择来自实际 CLI 结果。下面是现有公开命令；CURRENT_TARGET、CURRENT_FILE_REF 均绑定该次实际返回的身份，不能猜 ID：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_TARGET" --refresh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- files "$CURRENT_TARGET"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_FILE_REF"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- export "$CURRENT_TARGET" --output "$CURRENT_RUN/scratch/current-export"
~~~

命令语法随当前实现变更时，同步帮助和本页；不要新增旧参数兼容分支来让配方运行。

通过必须同时满足：

- 导出内容与当前选定来源/Notion 作者内容的完整 bytes/path/mode 一致，主文与所有子文件齐全。局部导出另核明确选中路径，缺文件和 unsafe path 不假成功。
- 从 Skills 到 Files 能直接读到每个文本子文件全文；长文本完整分块，图片有预览/原件，二进制有有效原件。外部链接或 SHA/Bytes/Mode 占位不能代替文本正文。
- Skills 主文只有一个可编辑权威入口；generated 与 Notion-authoritative 明确。来源刷新不得覆盖作者内容，补阅读字段不得改变有效内容身份或强制重取正文。
- 缺页/错 owner/path 冲突/不可达来源/权限/分页未完有明确错误或 partial，不静默回旧 reader、旧字节或同名 local。
- current Profile 不依赖父修订；普通读取不依赖旧 import/review/completion/file-event 链。有效当前资源不能因删历史被误清。

to-prd、hyperframes-registry、falling-leaves 可作为已知阅读试点，不能替代 AH-501 的全库覆盖或 AH-516 的 Pro 清单。

## 2. Notion 清理与关系闭包

先用 AH-499 最终字段合同和 AH-513 实际清单，分类为保留当前、先迁当前字节后退役、直接退役。当前 Records 精确资源、选中来源和必要在途状态不是按 kind 名称删除的垃圾。

通过现有 audit 入口观察，先核该候选的帮助与返回字段：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library audit --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library inspect "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library files "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
~~~

目标检查只证明该目标闭包。全库检查必须实际枚举 Skills/Files/Sources/当前 Records、反向关系、导航和分页；仅 metadata 不证明正文。使用候选现有 audit run 的明确全库范围和预算，不另写第二个 census/清理内核。

由 AH-513 在既有授权范围执行实际清退后，独立重新枚举。旧表/字段/页/记录/附件/导航必须退出当前管理和消费，当前引用没有指向退役对象；再次相同治理 no-op。归档或 Trash 是实际退役，只加 superseded 标签、隐藏列或留平行旧库不算完成。

未读、权限未知、分页未完、关系无法解释均保留缺口，不报 clean。核当前内容完整与旧对象缺席两面，不能只搜索旧名称是否消失。

## 3. 唯一当前路径与消费只读

复用当前语义只读底座：

~~~sh
bun test packages/core/test/notion-readonly.test.ts --timeout 60000
~~~

它证明能力边界拒绝语义写，不证明普通 reader 已接入。另驱动实际 list/read/use/resources/export 并核独立请求计数，远端业务写必须全部为 0。查询 POST 是读；创建 Record、observation/adopted、补阅读和修复都是写。

按 AH-517 的具名退役集合检查源码、公开 exports/schema/help、内置 Skill、安装 bundle 和默认入口。使用现有文本搜索及公开旧输入拒绝反例，不另建通用静态扫描平台。源码零命中不能替代包内检查。

以下已知旧行为不是本轮通过证据：

| 起点 | 当前判定 |
| --- | --- |
| consumer-effects.test.ts 中 current consume 允许 retention 写 | 新普通消费必须 0 写，未改时 failed |
| shared-git-only-consumer.test.ts 的读时 adoption、旧 marker 兼容 | 当前读取不留存、不兼容旧模型，未改时 failed |
| 旧来源配方要求 git-only 不建 supporting Files | 当前人类阅读必须完整，由 AH-501/513 完成 |
| fixed snapshot 缺字节后远端历史恢复 | 旧选择失效或重新选择，不能冒充最新或混入新旧内容 |
| 多代 acquisition/Profile/event reader、旧 operator 仍在包中 | AH-1140/1142/517 未完成，不能报单轨 |

旧 schema/session/cache/协议明确升级或重选。只验证拒绝这一边界，不建跨代兼容矩阵。保留当前固定 revision、完整性、权限、真实 ABI/manifest 和安全 runtime 校验；这些不是内容版本产品。

## 4. 有限当前恢复

沿 [operation recovery](../../verify-notion-operation-recovery/SKILL.md)，用一个管理意图覆盖响应丢失、部分文件成功、进程重启或预算暂停的代表切点。

CREATE 结果未知先核当前稳定身份，不盲目重发；当前对账不能伪造原请求 ACK。已确认当前效果可继续未完成范围，不为补旧 proof 重演历史。partial、unknown、paused、cancelled 与 complete 分清，新的恢复 invocation 使用自己的总预算。

重复执行收敛到同一当前结果；完成后再次执行 no-op。停旧 writer、显式放弃旧意图后可重建，不让过去 unknown 永久阻断当前内容。

复用现有 HTTP fixture 与对应管理测试，不增加恢复发行物。请求层先跑以下边界，业务恢复仍须独立验证：

~~~sh
bun test packages/core/test/request-engine-contract.test.ts packages/core/test/request-budget.test.ts --timeout 60000
~~~

原模型 HumanEditPreserved 仅保护 Notion 作者内容；旧 ColdRecoveryNeedsCompleteProof、永久 pin 和 graph history 性质按改变后的合同重做或退役。没有模型/实现的新对应关系就不报当前性质通过，不能只放宽断言或更新 coverage hash。

## 5. 有界成本与完整分页

复用已有预算和共享请求测试：

~~~sh
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-read-coalescing.test.ts --timeout 60000
~~~

继续核实际用户路径，保持相同 scope、内容与 freshness：

- 有效 TTL 内重复暖读 0 HTTP；过期后允许必要元数据核验，不能延长 TTL 来制造下降。
- 目录 0 正文；无变化写 0；只改 k 个文件时只获取/写入必要内容及分页/分块，不全库逐文件子进程。
- 101+ 条目及超一页关系完整，无 limit 截断假完成。用户 limit、API page_size、实际 attempts、bytes 与 deadline 分开。
- 重试、排队和子任务都受同 invocation 总预算；取消后无迟到写入或派发，另一个 scope 不借用共享请求。
- 选一个有区分力的现有 N+1 或漏分页反例，确认真实断言会失败。只在独立 fixture/candidate 中做反例，不能修改共享产品树、提高预算或删文件使其绿。

未知 wire bytes 不写 0；请求账本截断不报 0 请求。已有计数足够，不建立新的观测服务。

## 6. 同一次真实 Pro 日用

由 AH-1063 配对安装实施后 CLI/SDK/Broker，复用 Broker 既有 integration 和真实 Pi 新会话。离开开发 checkout，默认命令与插件加载当前配对包，无开发 override 或旧包 fallback。

在独立空 Store 完成必要试点的自然查找→使用→子文档 read，再做一项当前管理/阅读/局部导出并继续消费。核实际模型输入的必要全文/引用、去重和请求计数，不以 mock、准备稿、enqueue 或输入框有字代替投递。

AH-500 不提前重复这次 Pi 运行。AH-517 只依赖与删旧有关的前五组；AH-1063 的日用完成不等待全 Pro 迁移。AH-516 后续按项核内容/阅读/消费与旧正本、曝光/更新边退场，不为每个 Skill 重跑真实模型矩阵。

OMP/Tern、Mini 与 imile-win 独立故障不计入本次通过，也不以它们延期为理由保留旧 adapter。

## 结果与停止

沿现有结果习惯保留一份表，包含组、实际范围、passed / failed / blocked / not_run、覆盖缺口和下一 owner。已观测违约是 failed；缺授权/工具/必要输入是 blocked；没执行就是 not_run。partial 覆盖不能标 passed。

- AH-500 交付入口、六组断言和前五组检查，不等待 AH-1063 提前完成第六组。
- AH-1063 交付当次实际安装与 Pi 结果。AH-516 交付全 Pro 内容及入口对账。AH-498 在六组相应范围、全量迁移和无残留全部成立后关闭整轮。
- 失败回对应功能 owner 修根因，不在验证层增加兼容 adapter、特殊 fixture 或新的验证平台。
- 过时的一次性迁移/识别材料完成后退出产品，仅保留必要当前防回流检查。足够证明当前正确后停止扩展；不恢复旧历史矩阵。

结束时复用 [harness Cleanup](../references/harness.md#cleanup) 的自有范围与系统 Trash。当前未完成操作的必要状态暂留，其他临时派生物有界回收；不为证明清理干净再创建永久版本或证据库。
