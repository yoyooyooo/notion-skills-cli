# current-convergence：最新态收敛旅程

主要入口：[verify-ntn-skills](../SKILL.md)。执行 [AH-500](https://linear.app/yoyooyooo/issue/AH-500) 的六组检查；[当前合同](../../../../docs/current-contract.md) 定义唯一当前协议。六组复用既有 fixture、命令和领域 Skill，不新建 runner、永久台账或证明链。

## 范围与顺序

| 组 | 要证明的当前结果 | owner | 不能混同 |
| --- | --- | --- | --- |
| 1 | 内容、权威、完整目录与全文阅读 | AH-499/1140/1141/1142/501 | exact bytes、Notion 投影、全库覆盖 |
| 2 | 旧对象与关系实际清退 | AH-505/513 | 目标 inspect、完整 census、真实清理 |
| 3 | 唯一当前路径与普通消费 0 写 | AH-1140/1142/517/617 | 源码、公开命令、安装产物 |
| 4 | 当前管理意图有限恢复 | AH-504/507 | 受控整树恢复、partial 拒绝和真实业务恢复 |
| 5 | HTTP、字节、分页与取消有界 | AH-503 | TTL 命中、metadata 复核、body 读取 |
| 6 | 配对安装与真实 Pro Pi | AH-1063 | 准备、投递、模型实际使用 |

AH-516 对账 Pro 所有本地内容及曝光/更新边，AH-498 汇总完成。首次日用不等待全量迁移，也不能代替全量迁移。OMP/Tern 宿主适配延期，其目录里的 Skill 内容仍在 Pro 盘点内。迁入 Notion 不等于全进 Default Context。

## 开始前

1. 确定已有授权的 exact entry、target、候选代码/包与实际范围。沿原授权推进；验证不扩大远端作用范围。
2. 当前 reader、Profile、resource/native 完整 import、Git Source apply/refresh、文件转权和 Source 启停移除已接通。跨对象治理、一次性实库转换及全量投影仍分开验收。源码功能、受控整合、实际安装与真实库分别报告。
3. 先用受控 current tests 核普通读语义 0 写，再读真实 current 库。缺 Content 或 state 非 ready 不是让旧 reader 顶上的理由。
4. 从仓库根复用隔离设施：

~~~sh
CURRENT_RUN="$(mktemp -d /tmp/ntn-current-convergence.XXXXXX)"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$CURRENT_RUN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$CURRENT_RUN"
bun test packages/cli/test/verification-skill-map.test.ts packages/cli/test/builtin-guidance.test.ts packages/cli/test/installed-package-ci.test.ts
~~~

Doctor 只证明入口可启动和当前接线，不证明内容、安装或线上清理。controller 只提供隔离、当前命令、精确测试库和清理；安装沿现有 package:check。

## 1. 当前内容与阅读

沿 [消费](../../verify-notion-consumption/SKILL.md)、[管理](../../verify-notion-management/SKILL.md) 和 [来源](../../verify-notion-source-onboarding/SKILL.md) 选择必要切片。git-only/mixed/native 样本覆盖 main、Markdown、代码、图片和二进制；不排列所有维度。

受控当前入口：

~~~sh
bun test packages/core/test/shared-current-index.test.ts packages/core/test/shared-current-snapshot.test.ts packages/core/test/shared-current-source.test.ts packages/core/test/shared-current-resource.test.ts packages/core/test/shared-current-projection.test.ts packages/core/test/shared-acquisition-contract.test.ts --timeout 60000
~~~

对实际已是 current schema 的授权对象，使用实际返回的身份：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library files "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_TARGET" --database "$CURRENT_ENTRY" --refresh --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- files "$CURRENT_TARGET" --database "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_FILE_REF"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- export "$CURRENT_TARGET" --database "$CURRENT_ENTRY" --output "$CURRENT_RUN/scratch/current-export"
~~~

必须分别确认：

- main 唯一，全部 supporting Files 身份/owner/path/mode 和 binding 完整；无重复或路径冲突。
- 当前 source/resource bytes 与 hash/size/mode 相同；native 使用明确 frontmatter 与当前规范化正文。Name/Description 不改 authored bytes。
- Skills→Files 每个文本可读全文，图片/二进制有可用原件。metadata、外链或 SHA/Bytes 占位不算全文。
- generated body 编辑不自动接管；native 直接编辑不生成远端 object/adoption。多 Source 的逐文件声明不混 revision。
- 权限、partial pagination、missing/truncated body、非 ready、当前 descriptor 变化均阻止完整结果。末尾再次确认 owner，不能在获取期间停用后仍交付。
- 完整 export 与单文件 read --output 各按实际需求核对；任意多路径 export 尚未公开，不伪造该能力。

本地 exact directory 通过不等于 AH-501 全量 Files/阅读投影已落库。已知试点只证明自己的范围。

## 2. Notion 清理与关系

先把对象分成保留当前、先移交唯一字节后退役、可直接退役。现有 Selected Version 的真实 property ID 不等于 display name；退字段前确认实际当前绑定，禁止按名称批删。

目标观察沿现有入口：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library inspect "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library files "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
~~~

Source remove 自带库内完整 Skills/Files 元数据反查，能找到缺 Origin 的语义 Content 引用；有引用先显式 takeover，再清退无引用 Source。它不等于已清完整个旧库。旧 audit/census/cleanup route 已退出；通用旧对象治理未接通的范围报告未完成，不另写临时清理内核或让旧接口补位。

实库通过必须完整枚举 Skills/Files/Sources/必要 Records、反向关系、页/附件/导航及分页，解释权限缺口。移交唯一字节后真实清退，再独立枚举并重复治理 no-op。Trash/归档是退役；隐藏列、superseded 标签或平行旧库不是完成。

AH-513 的 [既有 native 转换入口](../../../../scripts/cutover-bootstrap-current.ts) 接纳完整冻结输入、已验证的四表字段、既有物理页及空 Members/Requires。首次纳管要求 Content/Current State/Operation 同时为空；先登记 current intent，再进入 applying。默认保留正文并要求空 Origin。显式 changes 输入可声明准确旧 Origin 到空关系的转换，以及已绑定目标 page/File/path 的逐项链接修订。输入绑定旧正文与目标正文指纹、精确替换次数和稳定引用；Notion 中写入可直接打开的目标页面链接，现有 reader 将其编译为同一 typed reference。依赖先转换，再处理引用它的正文，不因 prepare 通过推断远端目标已 ready。

已 ready 的 native 指导内容沿 [有限修订入口](../../../../scripts/cutover-edit-current-native.ts)，不进入 bootstrap 的三空初态。完整现有文件树、准确旧 Content/正文和目标输入共同绑定一个逐 owner 意图；仅修改声明的正文、Description 和主文件 header。两个入口共用现有 operation kernel 和正文三态观察：目标准确相同才完成，仍是批准的旧正文才允许写入，其他正文立即冲突；替换前核嵌套子内容保护。未知写入先读回，未确认的 in-flight 保留，不能以清 Operation 或补 ready 掩盖。

最终重新核完整索引、关系、正文和目标引用后才可 ready。保持相同输入、operation 和独立 Store，以 completed resume 验证零写。显式 additive descriptor 尚未发布时，正常库入口仍拒绝旧登记；局部结构转换和指导修订都不证明整库日用。资源、Source、非空 Members/Requires 和缺失 Files 另接现有当前原语。上述临时入口、专属测试与 bootstrap seam 在 AH-513 完成后由 AH-517 删除，不进入正常 reader、公开命令或发布包。

## 3. 单轨与普通消费 0 写

当前 snapshot tests 直接计数正常 reader 的语义写，并混入无关旧本地历史，确认读取不查询它。另核实际 list/read/use/files/export。query POST 是读；创建 Record、投影、adoption、恢复和清理都是写。

检查源码、exports/schema/help、内置 Skills 和实际安装 bundle 的同一退役集合。旧输入应明确拒绝；不扩跨代兼容矩阵。固定 revision、权限、hash/mode 和真实 runtime/manifest 校验继续保留。

| 已退出的旧要求 | 当前义务 |
| --- | --- |
| Git-only 独立 reader、自动 adoption、首次主文 takeover | 同一 current Content reader；权威显式 |
| Git-only supporting Files 可为零 | 全部 supporting 有 Files 身份与阅读投影 |
| event/ACK/review/completion 决定当前可读 | 以 current descriptor、ready 和当前内容判断 |
| 缺 cache 通过远端历史恢复 | exact 当前声明仍相符才补 Source/resource；否则重选 |
| 单 Source acquisition 与多代 decoder | 单一 v5 逐文件位置，支持多 Source |
| 旧 operator 或包内旧指南继续可用 | 公开 route 拒绝、包内指导和产物同步退出 |

旧专用测试不再是当前验收依据，不能为其通过恢复行为。安装包路径尚未完成时，第 3 组不能仅凭源码通过收口。

## 4. 有限当前恢复

沿 [operation recovery](../../verify-notion-operation-recovery/SKILL.md)。完整 import 与 Source 声明、转权、启停移除共用 operation 内核。Source 父 intent 只保留冻结输入和有限目标游标；子任务完成后清理，全部核对后 Source ready，明确移除则核 exact Trash 后清意图。用现有 writer/source-write/source-file/source-lifecycle/operation/upload tests 覆盖实际变更，不用旧 ACK/review 模型替代。

用一个管理意图覆盖 CREATE/完整 append/归档响应丢失、部分文件已成、进程重启或预算暂停。重传同一完整输入，只继续能按当前事实确认的动作。部分 append 未收敛时保持 pending，不盲目重放；这个拒绝结果不能说成自动恢复通过。ready 不依赖历史证明，半树也不能靠改状态通过。

需要改变目标时，停止原 writer 后显式 supersede 为完整新输入，验证有限交接的未知响应和最终清空；不新增确认台账或内容副本。Source 单文件动作不能把旧多目标动作抹掉。未知远端请求可能迟到，本地锁不提供跨机 fencing；只声明实际观察到的完成结果。

旧 operation-recovery/resource-lifecycle 模型、coverage、专属脚本和旧图册已经退役。当前有限恢复使用实际 writer/HTTP 反例，保留的请求模型只证明其有限范围。无需新增模型平台。

## 5. 成本与完整性

~~~sh
bun test packages/core/test/request-budget.test.ts packages/core/test/request-engine-contract.test.ts packages/core/test/shared-read-coalescing.test.ts packages/core/test/shared-current-invocation.test.ts --timeout 60000
~~~

保持相同 scope、内容与 freshness：

- 外层有效 TTL 命中为 0 HTTP。三 native fixture 冷读 6 请求，metadata 复核 3 请求/0 body；末尾 owner GET 保留。单 body 改动只追加必要 body，不能混成暖读 0 HTTP。
- 目录读取 0 body；选中 one resource 只读它的当前 Record/原件，其他 lazy 文件不下载；每个目录仍完整。
- 超 100 行完整分页，81 owners 分批查询；limit、page_size、attempts、bytes 与 deadline 分开，不截断假完成。
- 子任务、重试与排队共享 invocation 预算；取消后无迟到派发。不同权限/scope 不借用共享请求。
- 无变化写 0。未知或截断的 wire ledger 不填 0；不延 TTL、提预算或删文件来变绿。

## 6. 同一次 Pro 日用

AH-1063 配对安装当前 CLI/SDK/Broker，复用现有 integration。离开开发 checkout，空 Store、新 Pi 会话、无 override 或旧包 fallback。

完成自然查找→选用→子文档读取，再按当前已具备的管理/单文件导出能力继续消费。检查实际模型输入、必要全文、去重和成本；mock、准备稿或 enqueue 不是投递。未接通的内容管理不能由 Profile 改动代称。

AH-500 不重复提前跑 Pi。AH-516 按项确认全部 Pro 内容、阅读、消费和旧正本/曝光/更新边退出，不逐 Skill 重跑自然模型矩阵。

## 结果与停止

每组标实际范围、passed / failed / blocked / not_run、缺口和 owner。观测违约为 failed；缺实现/输入/访问为 blocked；没执行为 not_run。partial 不报完整通过。

AH-500 的前五组、AH-1063 的同次 Pi、AH-516 的全 Pro 对账分别交付，AH-498 汇总。失败回功能 owner 修根因；不补兼容 adapter、特殊 fixture 或永久证据层。足够证明后停止。

沿 [harness Cleanup](../references/harness.md#cleanup) 回收自有派生物；当前未完成意图必要状态暂留，唯一内容先移交，本地移除进入系统 Trash。
