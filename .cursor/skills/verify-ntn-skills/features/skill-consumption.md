# Skill 消费链

## AH-953：当前消费效果与严格只读

先保留 `consumer-effects.test.ts` 的原行为失败，再验证同一公开 `consume/readSkill` 路径。当前读取的历史留存与作者正文修改分别报告；根和 Requires 的留存绑定原 Skill page、File ID、operation。固定/暖读取的确实零写、部分完成后失败、响应丢失与取消不能混成同一结果。语义 POST query 属于读，不能按 HTTP 方法粗算写入。

`shared-metadata-consumption.test.ts` 的 3/101 行场景仍完整比较逻辑引用与物理页面读取的正文、snapshot、Members/Requires、固定文件及目录观察。两次调用的 freshness 和 effects 分别验证：首次当前读取必须报告该 main 的 confirmed retention，随后同内容 refresh 必须报告 none，不能把前次留存回执当成快照的永久属性。完整集成检查发现旧的整体对象等式误将这两种本次效果视为相同；两项原红例与修订后 28 项通过日志分别保存。这里只同步既有测试合同，没有改变产品源码、请求数或生命周期模型。

`readOnly`/`--read-only` 必须经现有 Notion 只读 capability 覆盖全部后代调用，必要留存在首次写前明确拒绝；固定历史仍可读取。正常当前读取继续保留原 retention，不能删除它凑零写。回执复用已有请求和原 operation，不增加远端查询或把完整账本送给模型。源测试、独立 Node SDK/CLI 与真实 Pi 两臂分别留证；本页不声明已完成真实服务或模型验收。

CLI 既有 `resource-lifecycle/AuditRun.tla` 的 `AuditReadOnly == writes = 0` 只覆盖粗粒度 audit；请求层语义只读 capability 的源回归另行覆盖后代调用。该有限模型没有 consumer effects、部分留存或取消状态，不能当作这些新语义的证明。AH-953 没有修改生命周期转移；Broker 的原 `RetentionDisclosure` 模型承接 normal/read-only/unknown 与效果投影。

归属 AH-617；本页维护 CLI 的验证入口，不记录功能已通过。SC01–SC26 的任务、用户入口、驱动、证据和状态，以及缓存 × 会话 × 入口 × intent 的完整组合，统一维护在 [Broker 消费链主地图](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)。本地开发时在实际 Broker checkout 读取同一路径，不要求两个仓库相邻，也不复制另一份地图。

## AH-631：阶段归因与同次解码

沿原 `request_metrics.trace` 记录实际 producer 的显式阶段、已知 Skill owner 与原 operation；缺少调用上下文为 null，共享 waiter 不能由单个 producer 标签推断独占归属。queue/retry 沿原传输循环记账，不按 attempt 排序猜写前写后。普通消费、retention、作者 preflight/apply/verify 与 reconcile 分开，追踪不开启时不添加远端请求。

先用原 `sdk-package-smoke.mjs --case records-history` 的 V8 正控制冻结解码次数，再复用同一 query row 已验证的 header；不缓存整次 consume，不跨响应或写入边界复用事实。固定同一历史、四文件闭包、Store 初态与结果 oracle，逐字段核身份/版本/归属/关系/manifest，HTTP/bytes 不因减少本地解码而声称下降。保留旧行为反例、未知 ACK、同 ID 冲突、错 scope、权限收缩与缺损对象回归。

旧/新包顺序使用同一 `NTN_SKILLS_RECORDS_HISTORY_FIXTURE=/absolute/history.json` 和 `NTN_SKILLS_SOURCE_FIXTURE_PORT`，固定 source origin 与 credential scope；端口冲突明确失败，不能自动换端口继续当作同条件对照。每臂仍从相同空 Store seed 独立复制。完整原 oracle 和所有阶段先保留到报告，再断言 cold header 次数等于完整 metadata pass 加同一 payload row 的次数；旧包的重复解码仍必须失败。原脚本默认仍可独立生成 fixture，不新增生产配置项。

## AH-506：有界历史与局部缓存成本

复用原 history producer、独立安装 smoke 和缓存场景，冻结 H=1/101/301、相同四文件闭包/最终内容、scope、空 Store seed、cache age 与操作顺序；旧两档 fixture 必须先被三档判据拒绝。沿既有预算：producer 60s、每次消费 30s、全部历史消费 240s、零重试。必要完整历史校验与重复本地解码分账，不能因 metadata 变少就推断 CPU 下降。

分别采样 SQLite 各表逻辑行、cache/dispatch active/retired 项、DB/WAL/SHM 物理字节、objects/manifest/cache/显式导出目录，以及 V8 解码次数和实际 HTTP/响应 bytes。进程 CPU 包含同进程受控服务及覆盖率开销，不称作 replay CPU。暖/过期未变必须保持原固定 pin 和已声明单槽；访问不续期。单 reference 变化、部分对象缺失、refresh/offline/旧 pin、删除/权限与 clear 沿原 scalar/cache 场景另列。

精确覆盖率若缺少冷 Store 必须经过的 `recordFromEnvelope` 条目而已观察到 `boundedEnvelope`，前者显式记 null，不能补零；跨根完整计数比较也保持 unknown。cold header 复用另由实际 `boundedEnvelope` 次数约束，旧重复 header 的原报告仍须触发同一失败判据。保留覆盖率原件及缺失函数说明，不根据函数消失猜优化收益。

多文件控制复用 `shared-snapshot-costs` 的 N=1/10/100/101/300、k=1/3 与实际 N+1 反例，所需正文随 k 获取；按需读取用 101 文件含缺失/损坏未选项的控制，显式选择损坏对象仍须拒绝。冷完整观察不当作已有完整证明后的按需获取；未选 Member 正控制仍沿原 history diamond。

只有上述冻结预算实际失败才比较本地可重建 checkpoint；不采用时记录实测范围、线性项与触发预算，不声称无限历史恒定成本。清理复用现有 cache clear/GC 及生命周期，只退役派生观察并保护活动 pin/未决操作，不把逻辑删除写成 SQLite 立即缩盘。本切片若未改生命周期规则则不改有限模型；既有模型不证明真实长期时间或任意规模趋势。

## SC25：日常命令与目录 SDK

全部 16 个原顶层路径与子树去向维护在 [消费合同的命令 disposition](../../../../docs/consumer-contract.md#cli-command-disposition-and-compatibility)。默认 help/schema 只展示日常消费和 ctl 入口，作者命令按任务发现；`schema ctl ...` 完整展开所选管理树。旧五个 root 管理路径精确调用仍与 ctl 使用同一 parser/handler，不能从默认目录不可见推断能力被删除。

沿原 `cli.test.ts` 的 SC25 C3 场景保留 fail-before/pass-after，覆盖离线默认树、显式作者发现、canonical/历史 schema 相等与 ctl help；`prepare.test.ts` 比较真实 canonical/历史入口的完整 graph lock。原 package command-contract smoke 逐项重复安装后的检查。publication/upstream 恢复断言必须期望新的 ctl next.argv；旧 capture 与 canonical capture 都保留原 bytes/hash，preflight/map-checkpoint 原有 Node tests 验证这一点。不得执行真实未结操作来证明改名。

默认上下文比较使用同一 Node、不可访问的应用根和带正控制的受控 HTTP origin，保存旧/新安装包的 help/schema 原始 stdout、UTF-8 字节、完整入口 hash 和实际请求。输出字节不换算为 provider tokens。日常 builtin 的历史迁移正文按需转到已有 maintain reference；原 package builtin lifecycle 继续验证整套主文、参考文件、安装和导出字节，迁移段原文必须完整保留。最终候选的包内文档逐项对照源码；若只更新文档而复用此前二进制验证，必须证明安装后的 CLI/SDK hash 完全相同并重新运行受影响的 builtin gate。

紧凑 use 也必须保留原生引用的 canonical ref、来源文件和 availability，不能把 disabled/metadata-only 引用显示为可消费正文。既有 SDK smoke 的 scalar fixture 同时验证 JSON 与紧凑入口，并断言固定 use 不新增远端引用正文请求；旧安装包的缺失输出应先失败，再对新归档通过。

合同 `agent-cli-ref-20261105`：`list --query/--limit/--cursor` 发现有界元数据，`read REF --json` 查看单文件，`use REF` 一次加载根和完整 Requires；`use --json` 保留机器证据，紧凑默认正文只出现一次。`list/read` 的旧 JSON 默认在 SC23 调用者迁移前保留。完整默认目录用 SDK `listCatalog`，有界发现用 `listSkills`；两者共享 core catalog 和凭据 scope，不派生 CLI 子进程或第二份身份缓存。

沿既有入口保留 fail-before/pass-after：

```bash
NTN_SKILLS_PREPARE_EVIDENCE_DIR="$RUN/evidence/sc25" bun test packages/cli/test/prepare.test.ts packages/cli/test/sdk.test.ts --timeout 30000
node scripts/sdk-fixture.ts --outdir "$RUN/scratch/sdk-fixture" --catalog
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$RUN/scratch/sdk-fixture/fixture.json" --outdir "$RUN/evidence/sdk-installed"
```

`prepare.test.ts` 驱动真实 built Node CLI，断言 read 只查看、use 完整闭包、未选 Member 无正文、正文不重复、missing Requires 失败、固定 ref freshness 冲突和 schema/help；SDK boundary 覆盖取消与非法分页在 runtime 获取前失败。独立安装 smoke 读取同一 fixture，验证完整 catalog、分页去重/续读、跨 query 的 stale cursor、Default View 子集、Name 唯一性和 partial coverage 拒绝，以及真实 Node object-read 与 HTTP 账本。目录的 `has_more` 与 source `coverage.exhaustive` 分别断言，不能互相替代。

Default View 正例提供完整 View metadata observation；consumer fixture 的正文状态与下述候选目录单独标记。`--catalog --default-view-cache missing|incomplete` 各生成新 owned fixture，实际 SDK/正常 Pi 默认目录必须拒绝缺失或不完整观察。不能只验证预期错误就把正例算通过。跨仓 driver 使用 fixture 的 `default_view.records` 和 `catalog_records` 独立核对，真实 Notion 和真实模型仍各自取证。

普通 `--catalog` fixture 的 a 保留 Requires base，同时包含 canonical Member b 与正文中的完整 b 目录行；该行在原正文 bytes/hash/version 生成前加入，Members 不使用固定 snapshot ref。它供原 Pi dollar 场景验证实际省去重复候选正文，未选 b 仍不得加载正文。非 catalog 与 `--catalog-size` 分支保持独立，不从 fixture 生成成功推断 provider 投影有效。

### SC11：同次 SDK 目录观察

用户入口仍是完整普通发现和默认/Profile/会话 View。宿主需要两者时调用原 SDK `listCatalog({database,directory:{}})`；显式 View/Profile 放在 `directory.view` 或 `directory.profile`。先检查 `CATALOG_DIRECTORY_CONTRACT_VERSION === 1`。结果的 `catalog` 与 `directory` 各自保留 `{ok:true,value}` 或 `{ok:false,error:{code,message,details?}}`，失败时透传已有可选 `SkillsError.details`；full 的无关冲突不能毒化合法 View，View 错误也不抹掉 full。取消和两成功结果的 scope/descriptor 冲突仍整次拒绝。

选中受管页仍要求有效 `Skill ID`；启用但空 ID、任意非法格式或过长的非空 ID 按原正则拒绝，错误码和 message 保持。定位 details 只含已验证的 page/data-source ID、登记的属性 ID/规范名称、reason 与 UTF-16 value_length，不包含原值或任意行 metadata。沿原 shared-catalog 反例验证精确定位、合法边界、101 行末页拒绝与请求数；原 shared-views 验证 combined 保留 details、full 失败和合法 View 成功独立成立。

完整六字段元数据中，ID 精确为空且 `Enabled=false` 的页被明确分类为未登记，不进入 full 或 View 消费目录；它仍留在原始完整库存，不补造身份，也不新增正文/Files/Records/逐行 GET。新建页允许 title/description 暂空及 Kind 原生 null，字段结构和 parent 仍须完整。新增回归核对 full+View 只取一份库存、选中未登记页被排除、非空非法 ID 和有效身份冲突仍失败。该分类不证明原页可安全初次接纳：作者预检另核 Main File ID、Source、Files/Records 和原操作。原 create 库存必须保留未登记页的同名/alias 冲突；无关未登记页不阻塞创建且原样保留。

```bash
bun test packages/core/test/shared-catalog.test.ts packages/core/test/shared-views.test.ts packages/core/test/views.test.ts packages/core/test/catalog-consumption.test.ts packages/cli/test/sdk.test.ts --timeout 30000
node scripts/sdk-fixture.ts --outdir "$RUN/scratch/sdk-directory" --catalog
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$RUN/scratch/sdk-directory/fixture.json" --outdir "$RUN/evidence/sdk-directory" --case view-dynamics
```

原 `shared-views` 多页 fixture 保留两个独立 list 的每次新观察正控制，组合模式仅取一份完整六字段库存。覆盖只有一个投影 warm、两者 warm、disabled 身份冲突、未选冲突与合法 View、选中缺失、完整分页、scope/descriptor 改变、maxAge=0、观察过期和取消。View 的 `fetched_at` 必须使用 membership 与库存中较早的时间；不能用较晚的 View 查询重新计龄。完整原始行只在现有 Effect operation context 中存活，不写入新持久缓存，不跨 use/inspect 或 SDK 调用共享。

原 `sdk-source-fixture.mjs` 的 `verifyCatalogDirectorySdk` 复用 scalar HTTP fixture，安装 smoke 在原 scalar/View case 内调用它。各臂使用独立 cold seed：separate 沿原两次 SDK list，combined 使用新增重载；逐项比较 full 与 View ID、完整 coverage、原六字段投影、实际 attempts 与 decoded response bytes，随后同候选 warm 必须零 HTTP。保留 `catalog-directory/report.json`、`requests.jsonl` 与请求终局 events；缺失/截断 metrics 不能记零。源构建调用同一 helper 仅证明 built SDK，不冒充独立安装、真实 Pi、生产 Notion 或模型结果。收益只使用本次同条件账本，不与其他切片相加。

Cleanup 沿原 helper，仅处理明确 owned 的 fixture/consumer scratch并保留失败、账本和归档；不修改用户配置、正文、旧 pin 或未结操作。

### SC06：实际 Pi 目录规模输入

沿同一个 fixture 入口显式生成完整普通目录与 Default View 等大的受控输入：

```bash
node scripts/sdk-fixture.ts --outdir "$RUN/scratch/catalog-101" --catalog --catalog-size 101
```

`--catalog-size` 只接受 `10|100|101|300`，必须与 `--catalog` 一起使用，且与 `--default-view-cache`、`--distinct-names`、`--ambiguous-names`、`--records-history` 互斥；拒绝发生在创建输出目录之前。原默认 fixture、名称负例与历史 producer 入口保持原合同，不把新规模默默并入原 all14 或 SDK22。

新模式仍输出 `fixture.json` 的 version=1、cwd/env/scope/database/catalog；新增 `catalog_size=N`，`catalog_records`、`default_view.records` 与 `snapshots` 恰为同一 N 个 owner。每个 owner 有独立主文、资源、File ID 与内容 hash，经原 Store 和完整 current observation 发布，再写入原 ordinary/View metadata 缓存；不能手改生成后的签名 receipt。名称和描述包含中文、emoji、引号及字面实体，描述、主文与资源保留末尾 LF，100/101/200/201 边界同样可逐字复核。

这是完整 warm source seed，不是冷正文获取：对象可供父 observer 核对，但实际 Pi 默认目录场景必须对全部 N 个 owner 的主文和资源断言零 object reads／零正文交付。Broker 原 SDK-Pi driver 的显式 `default-view` 场景负责实际 Pi 1.5 provider 目录、完整集合、分页与字节账本；fixture 生成成功不证明 Pi 已见目录，也不代表生产 Notion 分页或实模成本。保留旧参数拒绝的 coverage fail-before、各尺度输入/文件 hash、默认输出兼容对照，以及独立安装和实际宿主的各自结果。清理复用原 control helper，仅将 owned scratch 移入系统 Trash，归档与原件继续保留。

### SC25 C2：名称选择与固定 manifest

CLI `read/use` 与 SDK `resolveCatalogReference` 共享完整普通目录的精确名称/alias 选择。普通目录仍是 enabled 可消费集合，不改 catalog/cache 格式；disabled 的稳定 ID 冲突和精确目标拒绝仍由原 Core 层守住。View、Profile、query、分页片、source failure 和 incomplete 的零/单匹配均不能证明唯一性。两条正常 snapshot 名称路径必须同样拒绝；失败后的 best-effort cache 失效定位保留其原职责，不被当成新的消费授权。

原 `consumer` 的 exact-target 输入、`root.target` 与 decoder 的 expected targets 不放宽。SDK 调用者先 `listCatalog({database})`，再同步 `resolveCatalogReference`，最后把返回 canonical ref 原样传给 `consume/read`；canonical 和会话短引用不额外走名称目录。固定名称走 SDK `listSkill` / CLI `files` 的原 manifest 校验，不通过 current 目录重新绑定。复制返回的 canonical resource ref，再按需读取；不为固定资源准备主文。

```bash
bun test packages/core/test/catalog-consumption.test.ts packages/core/test/snapshot.test.ts packages/core/test/consumer.test.ts packages/cli/test/sdk.test.ts --timeout 30000
node scripts/sdk-fixture.ts --outdir "$RUN/scratch/sdk-names" --catalog --distinct-names
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$RUN/scratch/sdk-names/fixture.json" --outdir "$RUN/evidence/sdk-names-installed"
```

`--distinct-names` 只在新 owned fixture 生成前把 a 的 display name 设为 `A`，alias 按原 `aliasFor` 得到 `a`，随后统一生成 manifest、current receipts 和 catalog；不能手改已生成 receipt。该 fixture 供名称场景使用，原 Pi all14 的默认 fixture 和既有名字断言保持不变。

保留旧版 incomplete 零匹配 `SKILL_NOT_FOUND` / 单匹配错误成功的原红例，以及同入口新 `CATALOG_INCOMPLETE` 的无正文/无源请求证明。安装 smoke 同时验证真实 SDK export、生成声明、公共 CLI 名称 read/use 与完整 canonical consume/decoder 一致。固定资源场景先将 owned copy 的全部 objects 移出，实际 `listSkill` 仍成功且零 object reads；wrong historical name 和 absent pin 保留原错误。归还原对象后只读返回 resource，主文零读，HTTP/trace 账本完整。以上不能代替真实 Pi 名称工具调用和下一次 provider 正文证明；后者复用 Broker 原 SDK-Pi 场景。

既有 `control.ts consumption/prepare/import/reuse` 现在沿全部 list cursor 收集目录，首批 refresh、后续 offline 复用同次观察，并核对 scope、fetched_at、总数与重复 ID；不能把默认 50 条当全库。所有当前 read 的 adoption/retention/Records 写入仍进入 request_metrics。Cleanup 只移动本次 owned fixture/安装目录，保留归档、hash、失败原件和证据。

导航：[Sub-features](#sub-features) · [用户入口](#how-to-get-to-it-user-pov) · [驱动与清理](#driving-it-with-control-ntn-skills) · [Gotchas](#gotchas)。

## Sub-features

| Feature ID | 可观察结果 | CLI 证明范围 |
| --- | --- | --- |
| SC-VERIFY-01 | 从入口和功能地图找到本次场景、前置、驱动、证据及失败状态 | 本页连接现有 `control.ts`、[Broker 消费](broker-consumption.md)、[共享 SSOT](shared-ssot.md) 与 Broker 主地图；不把某个方便入口当成全矩阵 |
| SC-VERIFY-02 | 证据判据拒绝假成功 | 沿用 [图合同](skill-dependency-graph.md) 的 oracle、scope、hash 和完整正文反例；消费链扩展由 Broker `scripts/skill-consumption-contract.mjs` 驱动，按主地图的实际命令执行 |
| SC-VERIFY-03 | 下一位 Agent 独立完成 Launch → Doctor → Drive → Evidence → Cleanup，清理后证据不变 | 本页给出实际 CLI 消费路径；真实 Pi 路径、独立新会话和最终模型验收各保留自己的结果 |
| SC-TOOLS-04 | 同一固定 owner/pin 的资源集合一次获取，源字节与投递证明分开 | [资源合同](../../../../docs/resource-read-contract.md)、Core 定向测试、现有独立 SDK smoke；实际 Pi 从 Broker 主地图 `resource-batch` 进入 |
| SC-CACHE-12 | 权限否定后不能借旧 TTL 成功；已知 401 scope / 403 target 拒绝默认 fixed 读取，清理和旧 publisher 不解封；explicit offline 保留旧事实并标 stale；404/disabled 不撤销历史 pin 权威；跨进程暖读取零 HTTP | [缓存验证计划](sync-cache-verification-plan.md#sc12-consumption-qualification-and-installed-proof)、`cache.test.ts`、真实 SQLite 及既有 SDK smoke 的 `cache-*` 阶段；Pi resume/fork/rewind 仍走 Broker 主地图 |
| SC-REQUEST-15 | 不同队列预算不合并；相同有效预算继续共享；取消与 unknown write 不被隐藏 | [请求引擎](request-engine.md#sc15-消费请求共享与预算)、既有 Notion/coalescer/Node scheduler 及 SDK AbortSignal 驱动；真实 Pi Stop 独立验收 |
| SC-TOOLS-13 | 固定主文与有效当前缓存仅校验所选对象；current 先判定完整来源归属，再获取必需字节 | [按需快照合同](../../../../docs/selected-snapshot-consumption.md)、既有 SDK smoke 的 partial-cache 与 cold ownership case；实际 Pi 从 Broker 主地图 `partial-entrypoint` 进入 |
| SC-METADATA-01 | 单次 scalar current 读取内，逻辑选择、原生引用编译及 Members/Requires 目标元数据复用完整六属性目录 | [目录复用合同](../../../../docs/shared-metadata-consumption.md)、下方 scalar inventory 回归和独立 SDK/CLI smoke；完整 SC11 投影/批次矩阵仍单列 |
| SC-TOOLS-14 | 固定单资源 output 直接返回文件与 owner 主文承诺，不获取主文对象 | [消费合同](../../../../docs/consumer-contract.md)、fixed-snapshot-files 的 output 回归与独立 SDK/CLI smoke；实际 Pi 从 Broker 主地图 `resource-scalar` / `resource-scalar-short-refs` 进入 |

### 证明对象

| 对象 | 所需直接证据 | 不能据此声称 |
| --- | --- | --- |
| source bytes | 固定 scope、Skill/File 身份、版本、完整字节数和 SHA-256，实际读回字节匹配 | 已进入模型，或当前权限仍有效 |
| model projection bytes | 确定性编译器版本、精确源输入绑定、投影字节/hash，以及实际 provider messages 中对应内容 | 投影与源文件逐字相同；SC03/SC05 合同未冻结时沿用旧全文判据，不能先降低判据 |
| selected | 本次选择的身份、版本/图和 intent | 正文已缓存、已物化或已投递 |
| cached | 对应身份的缓存内容及完整性、独立的观察/过期时间 | 最新权限、续期，或当前会话已有必要正文 |
| materialized | 固定清单与实际输出文件、路径、bytes/hash 一致 | provider 已收到内容 |
| delivered | 当前实际 provider 输入含完整必要内容，同身份/版本/投影最多一份 | `loaded` 日志、短引用、hash 或摘要能代替正文 |
| active | 会话/分支内有效指令绑定；压缩、续接或回退后检查当前可见正文，缺失时从固定版本恢复 | 旧回执出现过就永远有效，或一次检查目标已启用其工作流 |

## How to get to it (user POV)

用户在 CLI 选择一个可访问的 Skill，查看主文与文件，读取固定版本并导出；Pi 用户通过 `$`、`/skill:` 或模型工具选择同一能力。本 CLI 的日常入口是 `list`、`read`、`use`；`files`、`export` 按需辅助，`ctl prepare` 保留完整图、预算与会话控制，没有新的验收专用产品命令。

本页的 `consumption` 先刷新指定目录，再对已选记录完成主文、固定文件清单、完整导出、重复导出、输出冲突保护和旧 pin 离线重读。它包含验证所需额外请求，不能拿整条验收流程的成本充当单次普通消费。SC02 的正式请求、字节、模型轮次和延迟基线在 Broker 主地图单独冻结。

`DATABASE` 取本次授权库的实际 selector，`PAGE_ID` 取该库的目录/fixture 回执。缺少目标时记录 `blocked`，不能随便取另一个库或叶子完成验收。`consumption` driver 不另建 fixture 或主动编辑远端页；产品 current read 可能保留完整观察、adoption 和 Records 写入，必须计入 request_metrics。只对稳定未变化路径断言零常规写回；未知原操作仍由原恢复流程负责。

## Driving it with control-ntn-skills

### Launch

从 CLI checkout 根执行。依赖和当前构建已就绪时不重复安装或构建；版本要求见入口 Skill。先保存源码/安装包版本、缓存初态、scope 指纹、数据规模和本次场景，证据留在 checkout 外。不要清空用户缓存或复制个人配置。严格文件哨兵场景另隔离父 Bun 进程的 XDG cache，见入口 Skill。

先检查共同合同。下面从相邻 checkout 定位 `BROKER_ROOT`；非相邻布局改为已核对的真实绝对路径。这些命令离线只读，不创建 run、不调用远端或模型：

```bash
BROKER_ROOT="$(cd ../pi-context-broker && pwd)"
node "$BROKER_ROOT/scripts/skill-consumption-contract.mjs" --help
node "$BROKER_ROOT/scripts/skill-consumption-contract.mjs" self-test
node "$BROKER_ROOT/scripts/skill-consumption-contract.mjs" check-map
node "$BROKER_ROOT/scripts/skill-consumption-contract.mjs" coverage
```

`scripts/skill-consumption-scenarios.json` 是统一机器矩阵。`map-valid` / `evidence-contract-valid` 与 `productAcceptance: not-inferred` 只证明合同检查，未执行组合仍为 `not_run`；不适用组合必须保留理由。需要审阅单条证据时使用 `node "$BROKER_ROOT/scripts/skill-consumption-contract.mjs" evaluate "$SC_EVIDENCE_FILE"`，其中 `SC_EVIDENCE_FILE` 必须是本次实际证据的绝对路径。新投影尚未冻结时只接受 `source-identity/v1`，不要另造宽松模型判据。

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-sc01-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
```

`init` 必须返回 `ready: true`，scratch 与 evidence 分开。Help 不创建 run、不启动子进程。

### Doctor

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
```

默认只执行真实 CLI version/help 并保存入口 hash；不访问生产 Notion、不调用模型。它可能构建当前 CLI 并写自有诊断文件，离线就绪不证明认证。显式在线诊断使用 `doctor --run "$RUN" --live --database "$DATABASE"`，其 HTTP 与缓存成本另记，不能预暖消费侧后声称冷消费。

### Drive

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts consumption --run "$RUN" --database "$DATABASE" --target "$PAGE_ID"
```

真实网络消费需要已有目标库授权；它不调用模型。检查 `consumption-source.json` 与实际命令回执，核对 scope、完整覆盖、动态主入口、固定 snapshot、每个导出文件 bytes/hash、输出复用和冲突后原文件未变。安装包验证另按 [Broker 消费地图](broker-consumption.md) 用实际 `--installed-bin`；checkout 结果不能替代安装包。

Pi 的同一用户路径从 Broker 主地图进入 `verify-notion-integration.mjs --host pi`；它有独立 Launch/Doctor/Evidence/Cleanup。`deterministic` 使用真实宿主和受控 source/provider，`live` 另证明真实 Notion，`model` 另证明实际模型。模型许可和真实网络范围分别声明，不互相推断。

### Evidence

CLI helper 没有 `evidence` mode。审阅 `$RUN/evidence/commands/*.json` 中的实际 argv、时间、退出/信号、timeout 和产品 output；审阅 `doctor.json`、`consumption-source.json` 及完整导出文件。失败命令必须保留。进程启动/关闭不全、observer 错误、缺失或截断的 `request_metrics.trace` 不能证明零请求；CLI 启动次数也不能证明实际 HTTP 次数。

分别记录 metadata、current-body、retained-body、write、附件和其他 provider 请求、重试/排队/预取，以及解码 bytes 与真实可观察 wire bytes。缺少的量标为 `unavailable`，不得填零；受控 fixture 的次数不能换名为真实远端成本。实际 provider token 和工具轮次由 Broker 观察，CLI 不推算为已测值。

清理前保存实际文件 hash 清单；此命令只读取 evidence，不读取凭据：

```bash
python3 - "$RUN" <<'PY'
import hashlib, json, pathlib, sys
run = pathlib.Path(sys.argv[1]).resolve()
files = sorted(p for p in (run / 'evidence').rglob('*') if p.is_file())
assert files, 'No evidence to preserve'
hashes = {str(p.relative_to(run)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
with (run / 'evidence-before-cleanup.json').open('x') as out:
    json.dump(hashes, out, indent=2)
print(json.dumps({'retained_files': len(hashes), 'functional_status': 'review-separately'}))
PY
```

### Cleanup

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
python3 - "$RUN" <<'PY'
import hashlib, json, pathlib, sys
run = pathlib.Path(sys.argv[1]).resolve()
hashes = json.loads((run / 'evidence-before-cleanup.json').read_text())
assert hashes and (run / 'evidence/cleanup.json').is_file()
for name, expected in hashes.items():
    path = run / name
    assert path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected, name
print(json.dumps({'evidence_preserved': True, 'files_verified': len(hashes), 'functional_status': 'review-separately'}))
PY
```

Cleanup 只回收本 run 的 scratch 和可确认归属的 package scratch，走系统 Trash，保留 evidence。未知原操作依赖 scratch 时先保留并解决原操作，不为收尾销毁恢复状态。成功回收和 hash 未变只证明证据保留，不能把功能 `failed` 改成 `passed`。未找到系统回收能力时保留 scratch 并记录清理阻塞。

### 独立 SDK 固定资源批读

`readResources` 是独立 `RESOURCE_READ_CONTRACT_VERSION = 1` 能力；consumer v1 的非空 `requestedFiles` 仍拒绝。不要用逐个 `readSkill` 或重新 prepare 主文模拟批读。完整合同与默认/硬预算见 `docs/resource-read-contract.md`。

从 CLI 根目录选择新的仓外绝对目录，先执行安全的定向回归，不运行包含永久删除的聚合 `test/check`：

```bash
bun test packages/core/test/resource-read.test.ts packages/core/test/consumer.test.ts packages/core/test/shared-snapshot-history.test.ts packages/core/test/shared-native-reference-consumption.test.ts packages/cli/test/sdk.test.ts --timeout 30000
bun packages/cli/build.ts --outdir "$RESOURCE_CLI_PACKAGE"
node scripts/sdk-fixture.ts --outdir "$RESOURCE_FIXTURE_ROOT" --catalog
```

在 `RESOURCE_CLI_PACKAGE` 内运行 `npm pack --ignore-scripts --pack-destination "$RESOURCE_PACK_ROOT"`，保存本次实际 tarball 路径为 `RESOURCE_ARCHIVE`。随后执行：

```bash
node scripts/sdk-package-smoke.mjs --archive "$RESOURCE_ARCHIVE" --fixture "$RESOURCE_FIXTURE_ROOT/fixture.json" --outdir "$RESOURCE_CONSUMER"
```

这些既有入口生成独立安装包、实际 Node SDK 导出与声明校验、CLI/SDK 字节等价、纯 decoder 反例、整体预算和 headers/body abort 证据。输入错误在 runtime 前失败；byte 预算在 metadata/owner 判定之后、对象下载前失败；全部 ready/failed/cancelled，不接受部分成功。BOM、CRLF、空文本按原始 bytes/hash 复核，binary base64只属于机器层；File ID 旧 path hint按固定绑定纠正。

fixture 必须使用符合 CLI runtime 要求的实际 Node 运行；它会经过 SQLite Store 和完整 current 发布检查，Bun 不可代替。fixture 明确为全 warm，`resources` 是独立新增 Skill，不能把它的零请求称作冷下载。Core tests 用实际请求集合证明只拉所选对象、共享 chunk一次、未选主文/文件零读取，并覆盖81 chunks跨查询分批。原 `a` 单资源 fixture保留。所有失败日志、包hash、source metrics和取消连接close保存到本次证据目录；SDK产物不冒充Pi/provider已投递。

SDK 初始化取消沿同一个 `sdk-package-smoke.mjs` 验证：分别对 list/catalog、consume、readSkill、readResources 在 pre-abort 和 owned config.json 读取回调尚未交付给 Store 的切点取消，保留原返回状态、实际 fetch/HTTP 观察及一次完整 metrics 回调。Notion 尚未取得时所有可执行 HTTP Effect 都在获取门之后，故应为 0 attempts / 0 unknown bytes；取得服务后缺账本仍为 null，不能一概补零。既有 headers/body 中途取消继续要求实际 1 attempt、连接关闭、in_flight=0，未知响应字节不得抹去。先保留旧包 null 账本失败，再用新独立安装包复跑同入口；真实 Pi 会话切换验收由跨仓原 driver 接续。

把**本次独立安装**的 `RESOURCE_CONSUMER/node_modules/ntn-skills/dist/ntn-skills.js` 交给 Broker `NTN_SKILLS_BUILD_ENTRY`，沿 Broker 主地图的 Launch → Doctor → resource-batch → Evidence → Cleanup 完成真实宿主验证。SDK smoke不创建生产远端数据，包与证据保留；只在确认进程全部结束后回收本次自有临时目录，走系统 Trash。Skill规程的可用性仍需独立新会话实际完成路径，不能由文档新增推断通过。

### 固定主文与当前缓存的按需读取

固定资源的 `readSkill(ref, { output })` 通过 `READ_OUTPUT_PROOF_VERSION = 1` 暴露所选文件 `sha256` 与独立 manifest 的 `entrypoint_sha256`。普通 text/lines 输出不携带这两个机器字段。`fixed-snapshot-files.test.ts` 在主文对象缺失时验证完整输出、空文件、binary 与超过 batch 16 MiB 上限的 scalar 对象；`sdk-package-smoke.mjs` 验证实际声明导出、安装包 SDK/CLI output 等价和 owner hash。不要用资源 batch 的预算替换原 scalar 能力，也不要将短引用自身的 owner hash 当作 SDK 的独立证明。Pi 主文对象、物化、会话 loaded 与 provider 投递各由 Broker 的两个 scalar 场景取证。

固定单文件 acquisition 的已验目标 bytes 只在本次 `readSkill` 内传到输出，最终 bytes/hash 校验仍保留；公共 `targetSnapshot`、text/lines/output 形状不增加字节缓存。定向测试核对暖目标每次调用只读一个对象、第二次调用仍重新读取、坏对象拒绝，以及 main/resource、relative/File ID 的选择。当前观察分支不据此宣称更少读取或更长 freshness；缺失恢复的失败尝试与持久化读回另计。实际 Pi 对照须按每个 SDK read 的 start/end 区间核目标对象正控制，不能以总数平均值或进程缓存冒充单次复用。

SC13 继续使用上面的 `sdk-fixture.ts --catalog` 与 `sdk-package-smoke.mjs`，不增加验收专用产品入口。新增的独立 `entrypoint` Skill 保留完整主文、小资源和两份约 2 MiB 的未选对象；原 `a` 与 `resources` 场景不变。先跑安全的相关回归：

```bash
bun test packages/core/test/fixed-snapshot-files.test.ts packages/core/test/shared-current-observation.test.ts packages/core/test/shared-target-snapshot.test.ts packages/core/test/cache.test.ts packages/core/test/shared-graph-release.test.ts --timeout 30000
```

SDK smoke 在本次自有 clone 中先通过公开 current consume 真正完成整树验证，再把一个大对象移出缓存、损坏另一个。核对 `entrypoint-object-reads.jsonl` 与 `entrypoint-partial-evidence.json`：实际主文读取必须有 bytes/hash 正控制；固定主文、有效 current 主文和独立小资源读取时，未选大对象的读取数为零；完整文件目录仍在。缺失大文件、坏 hash 大文件被选中时分别失败，partial export 不能留下成功结果；另一个完整 clone 的 export 须逐文件匹配原始 bytes/hash。

完整引用验证记录只能来自真实整树字节/hash 和共享引用检查，且绑定完整清单。legacy 或不匹配记录须重验；不得延长原观察时间、正文期限或绕过 pending/失效状态。固定历史读取与 current 的引用检查各保留原语义。文件目录成功不等于每个对象在本地；`materialized_paths` 只表示本次实际验证的选择。

这是明确的受控 warm/partial-cache 场景，不称作真实冷源下载。Core 的 retained-object 请求集合另证明同 pin 缺失文件恢复与未选对象零获取；当前可变远端树的首次完整观察与旧 ZIP 成本仍单列。把本次已安装 CLI 交给 Broker 构建后，按主地图 `partial-entrypoint` 的 Doctor → Drive → Evidence → Cleanup 完成真实 Pi 路径，并由独立新会话再实际执行。

### Current 来源先判归属再取字节

继续使用上面的 Node `sdk-fixture.ts --catalog` 与 `sdk-package-smoke.mjs`。`ownership` 场景保存由完整真实来源字节生成的有效目录 oracle；安装包消费使用独立空 Store，只初始化自有配置和 HTTP origin policy，不复制 oracle 的 snapshot、对象或 current validation receipt。

安装包通过 page ID 的 current consume + refresh 进入所有权路径。受控 Notion 服务保留实际 shared membership、retained ownership facts 和正文；HTTP source transport 只响应声明的精确 HTTPS fixture URL，其他远端请求拒绝。检查 `ownership-current-evidence.json`、`ownership-source-requests.jsonl`、`ownership-notion-requests.jsonl` 和 `ownership-object-reads.jsonl`：

- cold 与 metadata-refresh 两个阶段分别保留真实请求和 Node Store 对象读取。已有 custom 与 tombstone 对应的两份约 2 MiB 来源文件均不得读取或下载；source main 的 YAML 与仍生效的小文件必须有实际获取正控制。
- 使用 SDK 返回的 fixed ref，通过同一安装包 CLI 做 offline snapshot export；完整 path/length/SHA 必须逐项等于 full-byte oracle。Name/Description 更新后，主文元数据准确变化，非主文内容保持。
- current 的完整引用检查、pending/孤儿事件屏障、provider 失败前零新 adoption、following move 的原始 source path、source main 额外 YAML 与本地内容限制由对应 Core 用例复验。Git custom 的 SHA 隐私分类回退成本明确保留。

Core 的 `shared-retained-source.test.ts` 还检查空 selection、selected corrupt 不修复、未选对象零读取及缺失 selected 的完整 ZIP 验证。旧 bundle 必须记录 `whole_archive_cost: true`、全部 chunk 请求和完整 archive bytes/hash；只发布所选对象不等于只下载所选文件。

这是受控 cold current 来源获取与真实安装包/Node Store/export 证据，不能称真实远端 wire 成本或模型投递。首次 current 完整正文观察、本次新发生的 following→custom 转换、Git 隐私回退与旧 ZIP 仍可能需要额外字节。Pi 的 partial-cache 回归单独按上节执行，不把其 warm fixture当成cold ownership验证。

### 单次 current 读取复用完整目录

先运行对应公开入口和既有目录/引用回归。设置 `NTN_SKILLS_SC11_EVIDENCE=1` 时，五档 N case 在断言通过后输出 `SC11_METADATA_COST` JSON；保留日志中的实际字段、cursor、行数和解码 JSON 字节，不从请求数推算响应量：

```bash
NTN_SKILLS_SC11_EVIDENCE=1 bun test packages/core/test/shared-metadata-consumption.test.ts packages/core/test/shared-catalog.test.ts packages/core/test/shared-native-references.test.ts packages/core/test/shared-native-reference-consumption.test.ts --timeout 30000
```

沿本页已有的 Node fixture → 独立 build/pack → `sdk-package-smoke.mjs` 路线，给每次安装新的自有目录。`sdk-fixture.ts --catalog` 的 `scalarInventory` 是独立 101 行 fixture，包含最后一页的 disabled 外部目标；它不替换原有 `ownership` case。可将一次冻结 fixture 分别交给旧包和候选包，保留两次实际结果及包身份。

审阅 `scalar-inventory-evidence.json`、`scalar-inventory-notion-requests.jsonl`、五次 read result 和实际 snapshot export：

- SDK 冷 logical ref、同 scope 显式 refresh、另一个空 Store 的 installed CLI `read RESOURCE --from LOGICAL_REF` 分别计量。每次只完成一轮 100 + 1 行的 Skills 查询；每页恰好六个已注册 property ID，无行过滤，没有第二轮 cursor 序列。
- 完整当前根页仍单独 GET；目录中没有 Source/Files 等字段时不能将其当完整页面。Available / disabled 外部引用均保留准确身份和元数据，目标页与正文不得被获取。
- refresh 必须重新观察变更后的根与 disabled 目标元数据。公开输出和持久 catalog 不包含 raw inventory；名称/描述变化使用当前根，逻辑 Skill ID 漂移在正文读取前失败。
- 完整正文、目录及离线 snapshot export 的每个 path/length/SHA，与独立 page-ID/full-inventory oracle 匹配。检查每条真实 HTTP trace 完整、失败/取消/未知字节与该阶段的实际结果一致；没有台账的量不得写零。
- SC14 的 `scalar-relations` 与 `scalar-relations-physical` 使用第三个空 consumer，保持原缓存、权限和动态 View 相位的初态。原生成器只在 scalar 专属 library 声明 Members/Requires；原观察为空关系，另生成完整关系观察及 physical-page oracle，不手改已生成的 manifest 或缓存。新相位只 read，不展开 Requires 正文，也不调用 use。
- logical ref 与 physical Page ID 两次读取除 freshness 外完整结果相等，两个实际 SQLite snapshot manifest 逐项相等；Members/Requires、完整正文和所有导出文件另与独立 oracle 对照。所有未选目标的 page/body 请求必须为零。最后才断言 logical 仅 2 页，physical 保留独立路径的 3 轮、6 页；不能把此优化泛化到所有 read。

沿原选择参数可只驱动完整 scalar case，包括既有缓存/权限和动态 View 链：

```bash
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$RUN/scratch/view-fixture/fixture.json" --outdir "$RUN/evidence/installed-scalar-inventory" --case scalar-inventory
```

报告必须标记 `selection=scalar-inventory`；默认 `all` 仍运行原 22 项与本 case 的全部相位。先冻结 fixture 与修改前的独立基线包，保留重复目录计数的红例，再由候选的默认安装矩阵验证；各轮分别绑定生成器、fixture 和包身份，不能将新生成的 fixture 冒称同一份原始输入。每轮 logical/physical 对照使用同一冻结来源。

该回归与 smoke 使用受控 Notion 服务和真实安装包，不是生产延迟证明。真实成本另用 Broker 的 `scripts/skill-consumption-source-baseline.mjs`：保留先前授权的 database/root/resource、单次 resource-only cold 场景与预算，只替换 installed CLI 和新的 evidenceRoot；按 Doctor → Plan → Run → Evidence → Trash Cleanup → Evidence 执行。比较实际 metadata/current-body/retained-body、请求字节、解码响应字节、耗时和内容 hash，完整 trace 缺失时不能宣称移除了请求。单样本耗时仅报告该样本，不外推稳定收益。

scalar 复用不改变 Members/Requires 语义，也不建立跨请求缓存。实际关系仍来自当前选中页并按原规则完整分页；只有同 scope、完整 library descriptor 和穷尽性已核验的本次目录观察可传给目标元数据解析。权限、缺失／禁用目标、身份冲突、当前正文和固定 pin 仍按原边界验证。后续 refresh 必须重新观察，旧 pin 的正文与关系元数据仍冻结；Records headers/Payload 分层保持不变。

### SC14：固定文件集的历史量与解码账本

沿原安装 smoke 的 `--case records-history` 驱动，不构建产品或新增总验证器。旧入口不接受该选择器，原报告也没有独立 decoder/history 维度；这是 coverage fail-before，不能冒称产品错误。

```bash
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$FROZEN_FIXTURE/fixture.json" --outdir "$RUN/scratch/records-consumer" --case records-history
```

同一次独立安装先用原 scalar loopback 做一次小冷读，绑定安装 SDK 的 SHA/URL/函数范围，验证 Node precise coverage 的 `recordFromEnvelope`、`boundedEnvelope`、`decodeHeader`、`resolveFileState` 有实际非零调用，并用下一次无消费采样证明清零。计数器不可用或探针失败时保留原错误并停止，不能用缺项补0、增加产品 hook 或换平台追绿。原始函数 ranges 与阶段计数保存在 `records-history/*-coverage.json`。

探针通过后，原 `sdk-fixture.ts --records-history` 在60秒内通过既有 `nativeGraphFixture`/`prepareGraph` producer 生成 H=1/H=101 的合法父事件与 retained facts。四个业务主文件、owner/File ID/最终内容及关系不变；只共享 Requires d 的历史量变化，未选 optional 不提供正文响应。两种历史的 heads 可能使 pin 不同，各自对完整 producer oracle 验证，不强行抹平版本。producer 请求、写入及 frozen source 与空 consumer config 分账，绝不把生成的对象/SQLite 缓存复制给消费者。

每个 H 串行执行多根 cold/warm/expired-unchanged，再以独立冷状态执行单根 a；单根 a 的完整 Requires 已包含同四节点，因此能直接观察增加根 c 是否重复取数/解码。共八次SDK调用、每次30秒、总240秒、n=1/0重试，外层仍用原15分钟预算。对账完整HTTP journal/trace/响应字节、未选正文0、零常规写回、全文/manifest/关系/本地旧pin对象hash，并保存实际失败位置；失败后不启动后续相位。总函数次数不能冒充逐fact归属或内部Schema/DFS循环次数，带coverage耗时不能作为稳定性能收益；CPU/RSS/压缩wire bytes保持unknown。

默认 `all` 保留原22个case及其反例，并在原scalar case末尾追加同一测量；`view-dynamics`/`scalar-inventory` 的定向含义保持。常规 `package:check`/CI 继续沿同一原driver执行。Evidence先保留完整相位、生成器与安装身份、所有原失败；所有进程/服务终局后通过本Skill原cleanup将明确owned scratch移入系统Trash，再核原件保持。该测量不新增SC22/SC20前置。

### SC14：作者历史查询的单相位复用（AH-631）

同一次 fresh snapshot pending 检查可合并 body outcome 与 metadata 两个完整 Records family；metadata writer 首次完整 operation index 同时判断 exact 原 operation 与 pending intent。显式 reconcile、prepare/execute 之间、写后校验及下一次 fresh snapshot 不继承该结果。完整分页、scope/owner/hash、同 ID 冲突及原 plan/outcome/header 校验保持。

运行 `shared-authoring-record-costs.test.ts` 的 H=0/1/50/101 合法历史和缺失、冲突、foreign owner、incomplete response、重复 cursor 反例，并保留 `shared-metadata-write.test.ts` 的原 operation reconcile 与零重复写入要求。一次 SDK 查询可能有多页 HTTP；完整历史 Payload 仍随历史增长，不宣称常数读取。

安装态复用 `scripts/package-smoke/authoring.ts` 的 `checkAuthoring`，冻结相同初始内容和命令序列，对比每条实际请求及写入。保留故意丢失响应的未知字节、原 operation 恢复、旧 pin 和完整正文断言；受控结果不替代真实 Notion 或模型验收。

### SC11：完整 graph inventory 的必要属性投影

graph inventory 返回 Name、Description、Kind、Enabled、Default Context、Skill ID、Main File ID、Projection、References、Source，以及 descriptor 已登记的 Members／Requires。选中目标仍用该行校验 Source、正文绑定与关系；Tags 等此链未使用的字段不进入该请求，其他入口的 Tags 语义不变。fresh preparation、完整分页、parent、身份冲突、属性完整性、cursor、scope/descriptor 仍按原边界检查。

运行 `shared-graph-batching.test.ts` 的关系登记组合、102 行分页、必要属性缺失、Source 不完整、稳定 ID 冲突与多根 diamond 反例，以及 prepare、Router、release、selected-source 和 consumer-composition 回归。用相同输入核对实际序列化属性与解码字节；只改变未使用的字段，不增加逐目标 GET。安装态使用原 SDK smoke，真实来源成本独立报告。

### CI 保留计数比较与原 coverage 文件

原 `package-check.ts` 已把完整 SDK report 内嵌到 CI 上传的 `ntn-package-check.json`。history ledger 同时保留 `root_comparisons` 与 `coverage_files`：每份原 `*-coverage.json` 的文件名、UTF-8 原文、bytes 和 SHA-256 随报告归档，包含 probe/reset 与八相位各自的 before/after；从 `content` 还原文件后，逐字节核对长度/hash。独立相位文件继续保留，不改变 Profiler 配置、SDK 调用、计数、预算或失败位置。

`root_comparisons` 保存各函数的真实差值及 `necessary_decode_reuse`，false 或非零必须原样进入 artifact。ledger 的 `status: passed` 表示八相位测量与内容/请求门槛完成，不证明所有 decoder 差值为零。comparison 仍是观察结果，不通过增加消费者样本或放宽断言将差值消除。

### Tags / View 动态观察与正文隔离

SC-METADATA-04 复用原 `shared-views.test.ts` 及 `scalarInventory` 的安装 HTTP fixture。Tags、View filter 和完整成员列表分别封存在 fixture 的 `view_dynamics`；返回成员是受控 Notion API 观察，不声称该 fixture 执行了生产 Notion 的 filter 引擎，也不修改真实 View/schema。

```bash
bun test packages/core/test/shared-views.test.ts --test-name-pattern "Tags and View membership refresh" --timeout 30000
node scripts/sdk-fixture.ts --outdir "$RUN/scratch/view-fixture" --catalog
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$RUN/scratch/view-fixture/fixture.json" --outdir "$RUN/evidence/installed-view-dynamics" --case view-dynamics
```

`--case view-dynamics` 只运行原 scalar smoke 内这一条动态链，报告 `selection=view-dynamics`；不能将其一项通过算成完整安装矩阵通过。省略该选择时，原完整 smoke 仍运行全部原 case，并在 scalar case 内追加本链。每次使用新的 owned 目录和冻结安装包；不复制正文、snapshot 或验证 receipt 预热新 consumer。

常规安装门禁沿 `package:check` → `scripts/package-check.ts` → 原 `sdk-fixture.ts --catalog` 与默认 `sdk-package-smoke.mjs` 执行，复用同一次生成的 CLI archive，不另打包。四平台 CI 的 `Pack and test a fresh consumer` 和原 Skill 的 `package` mode 均走这个入口；原 22 项与动态链一起失败即阻断。完整 SDK report 内嵌在原 package JSON 的 `sdk` 字段，`sdk_report` 指向自有 scratch 原件；失败仍先输出原报告再返回非零。需要独立查看 HTTP/子进程原件时，在原 cleanup 前保留 `sdk-consumer` 的相位文件；不要只留下临时路径。Core 动态用例同时进入原 `check` 的单元测试集合。远端 CI 是否实际通过以对应提交的原 job 为准。

先通过 SDK current read 合法取得根全文、完整资源及固定 pin；随后分别驱动 SDK 默认 View 冷读、Tags 变化后的暖读、公开 CLI `list --default-view --refresh`、View 外 exact current read、filter/成员变化后的 SDK `maxAge:0`、普通全目录及不完整刷新。暖读保留原观察时间，显式刷新和到期观察返回各自准确成员；View 不能影响完整普通目录或授予／撤销正文权限。不完整的 inventory 必须报 `VIEW_INCOMPLETE`，不能成为空成功；显式 offline 仍能读取上一个完整 View 事实。

审阅新 `view-dynamics/` 下每相位的 installed SDK 导出函数或 CLI argv、完整成员 IDs、实际字段/cursor、错误、全部 HTTP calls 与 metrics 对账。目录相位不能读取 Files/Records、发逐页 GET 或获取正文、写入；旧 current 对象库存保持原 SHA。薄 `listSkill` 的文件条目只提供 path/bytes/ref，不把不存在的 hash 当协议要求；沿其返回 canonical refs 实际读取旧 pin 的每个文件，计算 bytes/hash 与独立 oracle 对照。源请求与本机对象读取分开，不能用零 HTTP 推断未读取本机正文。保留原报告未包含动态链的 coverage fail-before，不把它写成产品缺陷；只有实际产品行为失败才启动产品修复。证据和清理继续使用本 Skill 原入口与系统回收站，原始失败和安装包保留。

### 共用受控 HTTP 来源与终局字节账本

SC12／SC15／SC20 的 loopback 来源共用 `scripts/sdk-source-fixture.mjs`。它从原 `sdk-package-smoke.mjs` 的 scalar HTTP handler 抽出，继续读取 `sdk-fixture.ts --catalog` 生成的原 `scalarInventory`，没有新增产品入口、替代 SDK 或独立总验收平台。CLI `list/read/use` 和 Broker 的 Notion 工具仍经过实际已安装的消费内核；fixture 不向 consumer 写入 snapshot、对象或权限 receipt。

入口 `startSdkSourceFixture(sample, ledgerPath)` 只启动一个本机 origin。沿 `setPhase` 选择已声明的 initial/refreshed current、View 观察、401 scope、403 target 和完整性状态；原 scalar/history smoke 仍拥有其来源事实。`holdNext`、`rejectNext`、`interruptNext` 只控制一个确切 route 的下一次真实 HTTP：headers 前后暂停、一次 429 或一次不完整响应断流。它们不增加 SDK 重试次数、不重跑上层调用，也不把失败变成缓存命中。切换阶段前全部原请求必须关闭；未使用的控制在切换／关闭时结清。

403 target 同时拒绝所选根的 `GET /v1/pages/<root>` 与 `GET /v1/pages/<root>/markdown`。刷新可以经目录取得元数据后直接读取 markdown，不能只给未被实际调用的 page route 配置拒绝，再宣称测试了权限失败。原控制回归逐项检查两条 route 的 403／错误码，以及恢复后相同根的元数据和完整正文；其他 owner、未知 route 和未选正文的边界不变。

验证链复用原入口：

| 用户入口／驱动 | 正例与反例 | 直接证据边界 |
| --- | --- | --- |
| 原安装 SDK smoke，默认 `all` | 保留原 22 cases、scalar/relations、32 cache 相位及 View 动态链；旧包身份固定 | 真正独立安装 Node SDK／CLI、真实 loopback attempts、完整结果与 pin；不代替真实 Notion |
| 原 Node test lane 中 `sdk-source-fixture.node.test.ts` | hold 必须先到达 HTTP 再 release；401/403、一次 429、断流、headers 后客户端 abort、不完整请求 abort、未知 route/未选正文拒绝 | 原 TCP 请求、终局 ledger 和 start/headers/end/close 事件；单独通过不证明 SDK 重试或 Pi Stop |
| Broker 原 `notion-sdk-pi.mjs` 的 `http-directory`、`http-cache-recovery`、`http-interruption` | 目录 pending 不阻塞普通提示；新会话暖缓存／显式 maxAge=0／权限恢复／原会话恢复；真实 SDK 重试与 RPC abort | 由 Broker 原验证 Skill/feature map 记录实际 Pi、provider 输入及清理，不从 CLI 层推断通过 |

原 `test:node` 已按 `*.node.test.ts` 收录控制回归。定向复跑时先沿本页 `control.ts init` 创建 `RUN`，将测试临时目录放在它的 owned scratch：

```bash
mkdir "$RUN/scratch/http-tests"
TMPDIR="$RUN/scratch/http-tests" node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/sdk-source-fixture.node.test.ts
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$FIXTURE" --outdir "$RUN/scratch/installed-sdk"
```

测试打印保留 ledger 的目录，不永久删除失败原件。安装 smoke 的默认选择和命令合同保持；定向 scalar／View／history 的原有意义也保持。Broker 冻结 helper 时记录文件 SHA-256、fixture SHA-256、Broker／CLI 包身份；未变化的运行时不因此重新 build/pack。其目录、恢复、取消三个场景各自取证，固定包与控制服务的通过不能算正式 SC20 生产成本或 SC21 模型验收。

每个 HTTP attempt 的账本区分已观察前缀和完整响应。`observed_response_bytes` 是服务端实际调用 write/end 的未压缩前缀；只有响应 `finish` 才填 `decoded_response_bytes`、`response_sha256` 和 `response_bytes_complete=true`，并保留明确的 server-write `response_boundary`。中途断流／abort 保持完整字节与 hash 为 `null`，不能把计划发送的 JSON 长度当成完整响应。客户端解码、SDK 全文结果及 provider 真正收到正文仍由各自账本证明。请求前缀、单调时钟 start/end/close、真实 status 和每次重试均保留；汇总失败尝试时不能补零或丢弃它们。

不完整响应被取消时，完整响应字节保持 `null`，已观察前缀另列；不能把不完整前缀记作完整 HTTP 响应。清理前将原始 ledger、结果与身份存入运行证据，由原 `control.ts cleanup` 回收 owned scratch，再核对原件 hash 和进程终局。

### 单 current inspect 投影实验未采用

当前 graph preparation 保留完整必要 inventory；六字段目录加单页 GET 的实验未通过预先冻结的延迟采用门槛。继续沿[元数据合同](../../../../docs/shared-metadata-consumption.md#optimization-decisions)核对权限、完整性和成本取舍，不把较少响应字节自动等同更优全任务成本。新方案先冻结机制、输入、预算与样本数，保留历史失败，不以重复采样改判。

## Gotchas

- `passed`、`failed`、`blocked`、`not_run`、`skipped` 分开记录；机器矩阵的合法不适用项使用 `not_applicable` 并保留理由。缺前置是 blocked，方便路径通过不能覆盖未跑组合。未独立执行的规程是 draft。
- source/投影字节和机器证明分开。摘要、hash、loaded 标记、成功编译或模型自述都不能替代当前实际必要正文；原全文合同保持到新投影合同正式冻结。
- A/B 根选择继续遵守原 [依赖图合同](skill-dependency-graph.md)：oracle 与 consumer 隔离，不预热消费缓存，不泄漏叶子、答案或强制工具参数，不隐藏本地插件副本，不把目标改成 Requires。新投影尚未冻结时不以缩短正文后的检查重写旧 Gate 结论。
- 不删除失败样本、不事后换 prompt/model、放宽 TTL 或把后台成本移出总账。单次快速结果不能代替同条件样本与完整网络边界。
- 只检查 Skill 的 intent 不启用工作流；完整模型目录、UI 补全与正文读取分别证明。未选择 Member 的正文零读取须有实际 I/O 账本，不能由目录外观推断。
- 本页执行完成仍只证明 CLI 层。SC01 的独立新会话需只依赖实际 Skill/地图完成主地图指定的同一路径；真实模型、独立安装、pro/mini 恢复和正常日用切换保留各自门禁。
