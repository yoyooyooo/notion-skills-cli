# current-convergence：最新态收敛旅程

主要入口：[verify-ntn-skills](../SKILL.md)。执行 [AH-500](https://linear.app/yoyooyooo/issue/AH-500) 的六组检查；[当前合同](../../../../docs/current-contract.md) 定义唯一当前协议。六组复用既有 fixture、命令和领域 Skill，不新建 runner、永久台账或证明链。

## 范围与顺序

| 组 | 要证明的当前结果 | owner | 不能混同 |
| --- | --- | --- | --- |
| 1 | 日用内容、完整目录、消费及文本正文 | AH-499/504/516/501/1141 | exact bytes、Notion 全文、全库覆盖 |
| 2 | 旧对象与关系实际清退 | AH-505/513 | 目标 inspect、完整 census、真实清理 |
| 3 | 唯一当前路径与普通消费 0 写 | AH-499/504/617 | 源码、公开命令、安装产物 |
| 4 | 当前管理意图有限恢复 | AH-504/507 | 受控整树恢复、partial 拒绝和真实业务恢复 |
| 5 | HTTP、字节、分页与取消有界 | AH-503 | TTL 命中、metadata 复核、body 读取 |
| 6 | 配对安装与真实 Pro Pi | AH-1063 | 准备、投递、模型实际使用 |

AH-516 先对账日用集合：Source 日用的真实上游成员、Skill 日用与 Default Context 的并集。日用 Skill 主文与选中的阅读文档正文由 AH-501/AH-1141 验收；Source 默认仅 Markdown，排除测试、fixture、依赖和生成目录，完整 Git 消费树不受投影过滤影响。非日用内容与额外二进制呈现后置；不删除 agent-kit 主路径的 Skill。日用不等于全部进入 Default Context，OMP/Tern 宿主适配仍延期。

## 开始前

1. 确定已有授权的 exact entry、target、候选代码/包与实际范围。沿原授权推进；验证不扩大远端作用范围。
2. 当前 reader、完整 import、Git Source apply/refresh 和同版本零写复用一条路径。同步后显式运行 projection，验证日用全文和重复零写；投影失败保持已就绪消费，不扩大为跨对象治理或非日用全库覆盖。源码功能、受控整合、实际安装与真实库分别报告。
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

修改日用投影入口时，复用 `shared-current-daily.test.ts`、
`shared-current-projection-write.test.ts` 和 CLI 对应测试。核日用并集的完整
分页、无 Origin 仍选到真实成员、Source include/exclude 与缺页重建、native 不覆盖、非文本跳过、同版零写和
投影未完成仍可消费，不增加新的 runner 或矩阵。

对实际已是 current schema 的授权对象，使用实际返回的身份：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library files "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library projection "$CURRENT_TARGET" --entry "$CURRENT_ENTRY" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library projection "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_TARGET" --database "$CURRENT_ENTRY" --refresh --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- files "$CURRENT_TARGET" --database "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- read "$CURRENT_FILE_REF"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- export "$CURRENT_TARGET" --database "$CURRENT_ENTRY" --output "$CURRENT_RUN/scratch/current-export"
~~~

必须分别确认：

- main 唯一，Source manifest+Contributions 的完整消费目录与 Notion-owned Files 合并后无重复或路径冲突；Notion 自有 binding 完整，Source 阅读行可稀疏。
- 当前 source/resource bytes 与 hash/size/mode 相同；native 使用明确 frontmatter 与当前规范化正文。Name/Description 不改 authored bytes。
- Native 正文和 resource 原件必须完整。日用 main 与选中的 Source 阅读文档须有完整 Notion 正文；默认 Markdown 且排除测试/fixture/依赖/生成目录。missing selected pages 重建，excluded Source 行归档，Notion authority 不裁剪。metadata、外链和 SHA/Bytes 占位不算 selected 全文。Excluded 与非文本 skipped 分开报告，仍核完整原件消费。
- generated body 编辑不自动接管；native 直接编辑不生成远端 object/adoption。多 Source 的逐文件声明不混 revision。
- 权限、partial pagination、missing/truncated body、非 ready、当前 descriptor 变化均阻止完整结果。末尾再次确认 owner，不能在获取期间停用后仍交付。
- 完整 export 与单文件 read --output 各按实际需求核对；任意多路径 export 尚未公开，不伪造该能力。

获得整个日用范围授权后，用公开 `ctl library projection --daily --entry DB`
执行同一路径，记录 full tree、selected、excluded、row changes、正文读回和非文本跳过，再重复确认零语义写。Disabled
和期望删除只报告，不隐式排除或改策略。失败批次保留 completed/remaining 与
单项恢复命令。重跑普通单项/daily 命令时核同目标、policy 和完整输入 hash 才沿
原 operation 自动恢复；冲突不接管，未知写不盲重放。显式恢复携带原 policy 和
请求预算，省略筛选时用 intent 的冻结策略。日用批次不接受
--operation/--resume/--cancel。不以单例或本地 exact directory 代称全日用 selected 正文完成。

### 单条命令恢复已完成的投影

只在整批完成、目标无旧 pending 后，对已授权的精确 Skill 做一次真实旅程。
完整步骤见 [验收说明](../../../../docs/maintenance-verification-review.md#single-command-trash-recovery)。

1. 保留原 page/Skill/Main File/支持 File 身份、四开关、当前 Source revision、
   selected/excluded、完整正文和消费 bytes/mode 的实际基线。
2. 只清生成的 Source 阅读正文，保留 native 和原件，再把整个 Skill 页移入
   Trash；不得永久删除。这样能证明正文重新生成，而非只证明 untrash。
3. 只用一条公开产品命令恢复：

   ~~~sh
   ntn-skills ctl library projection SKILL_PAGE_ID --restore --entry LIBRARY_ENTRY
   ~~~

   有自定义 filters 或预算时加在同一条命令中。期间及事后禁止 Agent 另写页面、
   补正文、修关系或清 pending 来拼成功。产品失败就保留失败事实，修产品路径。
4. 核 scope:skill/status:complete、restoration.status、完整正文/链接与原件，
   比较同页与保留 File 身份、四开关和 native/resource 内容，核有限意图清空。
5. 重跑完全相同的命令，核 restoration unchanged、projection unchanged、
   row/body changes 与 semantic Notion writes 全 0，pending 为 0。保留实际
   request metrics/budget；读取请求非零不影响零写结论。

--restore 只接受 exact Skill 和 automatic 模式，支持 filters/预算；拒绝
daily、dry-run、operation、resume、cancel。自身 restore 与后续 projection
中断可重跑同命令；外部把尚有旧 projection pending 的页 trash 则零写拒绝，
不替换 marker。永久不可用、foreign/duplicate owner、content pending 与 Source
非 ready 的边界沿现有 fixtures 验证，不新增 runner。当前 Source 固定，不重新
发现 HEAD。实库未执行时记 not_run，不能拿实现或受控通过填充真实结果。

## 2. Notion 清理与关系

先把对象分成保留当前、先移交唯一字节后退役、可直接退役。现有 Selected Version 的真实 property ID 不等于 display name；退字段前确认实际当前绑定，禁止按名称批删。

目标观察沿现有入口：

~~~sh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library inspect "$CURRENT_ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$CURRENT_RUN" -- ctl library files "$CURRENT_TARGET" --entry "$CURRENT_ENTRY"
~~~

Source remove 自带库内完整 Skills/Files 元数据反查，能找到缺 Origin 的语义 Content 引用；有引用先显式 takeover，再清退无引用 Source。它不等于已清完整个旧库。旧 audit/census/cleanup route 已退出；通用旧对象治理未接通的范围报告未完成，不另写临时清理内核或让旧接口补位。

实库通过必须完整枚举 Skills/Files/Sources/必要 Records、反向关系、页/附件/导航及分页，解释权限缺口。移交唯一字节后真实清退，再独立枚举并重复治理 no-op。Trash/归档是退役；隐藏列、superseded 标签或平行旧库不是完成。

旧数据首次接入需要冻结确切物理页、完整属性、Markdown v2 正文与真实原件，并在写入前复核。只有显式授权的这一批可以使用有限接入入口；正常 reader 和 refresh 只接当前协议，不猜版本或回退旧字段。未知写入先读回，未确认意图保留，不能靠清 Operation 或补 ready 掩盖。

当前批次迁入后，用公开 import 或 Source apply/refresh 更新与重建。Source 声明保存在 Notion 之外；纯上游成员的增删与删空按完整上游发现收敛，网络故障或不完整发现不能当删除。原生独有内容继续以原生正文为准，安装目录以完整导入输入为准。

本批完成的临时接入代码、专属测试、CLI flag 和 bootstrap seam 必须同波删除；不能因其他长尾旧数据还未迁移而留在日常运行时，也不能推给 AH-517。输入快照和运行结果可保留在独立证据目录；AH-513 只接非日用旧数据，AH-517 只清理静态材料。

## 3. 单轨与普通消费 0 写

当前 snapshot tests 直接计数正常 reader 的语义写，并混入无关旧本地历史，确认读取不查询它。另核实际 list/read/use/files/export。query POST 是读；创建 Record、投影、adoption、恢复和清理都是写。

检查源码、exports/schema/help、内置 Skills 和实际安装 bundle 的同一退役集合。旧输入应明确拒绝；不扩跨代兼容矩阵。固定 revision、权限、hash/mode 和真实 runtime/manifest 校验继续保留。

| 已退出的旧要求 | 当前义务 |
| --- | --- |
| Git-only 独立 reader、自动 adoption、首次主文 takeover | 同一 current Content reader；权威显式 |
| Files 行决定 Git 消费目录、每个脚本/测试都建行 | 完整 manifest+Contributions 决定消费；Files 只投影选中的 Source 阅读文档，缺页由 projection 重建 |
| event/ACK/review/completion 决定当前可读 | 以 current descriptor、ready 和当前内容判断 |
| 缺 cache 通过远端历史恢复 | exact 当前声明仍相符才补 Source/resource；否则重选 |
| 单 Source acquisition 与多代 decoder | 单一 v5 逐文件位置，支持多 Source |
| 旧 operator 或包内旧指南继续可用 | 公开 route 拒绝、包内指导和产物同步退出 |

旧专用测试不再是当前验收依据，不能为其通过恢复行为。安装包路径尚未完成时，第 3 组不能仅凭源码通过收口。

## 4. 有限当前恢复

沿 [operation recovery](../../verify-notion-operation-recovery/SKILL.md)。完整 import、Source 声明/转权/启停移除与正文 projection 共用 operation 内核。Projection 使用独立类型的有限意图，真实 Skill 保持 ready；同项恢复无 supersede。需更换阅读策略时，用原 operation --cancel 仅核对在途动作并退役旧意图，不能执行剩余正文或宣称全部完成。Source 父 intent 只保留冻结输入和有限目标游标；子任务完成后清理，全部核对后 Source ready，明确移除则核 exact Trash 后清意图。用现有 writer/source-write/source-file/source-lifecycle/projection-write/operation/upload tests 覆盖实际变更，不用旧 ACK/review 模型替代。

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

AH-500 不重复提前跑 Pi。AH-516 批量核日用完整树及其真实更新来源；用必要样本验证实际 Pi 消费，不逐 Skill 重跑自然模型矩阵，也不以删除 agent-kit 主路径为门槛。

## 结果与停止

每组标实际范围、passed / failed / blocked / not_run、缺口和 owner。观测违约为 failed；缺实现/输入/访问为 blocked；没执行为 not_run。partial 不报完整通过。

AH-500 的前五组、AH-1063 的同次 Pi、AH-516 的日用批次对账分别交付，AH-498 汇总。失败回功能 owner 修根因；不补兼容 adapter、特殊 fixture 或永久证据层。足够证明后停止。

沿 [harness Cleanup](../references/harness.md#cleanup) 回收自有派生物；当前未完成意图必要状态暂留，唯一内容先移交，本地移除进入系统 Trash。
