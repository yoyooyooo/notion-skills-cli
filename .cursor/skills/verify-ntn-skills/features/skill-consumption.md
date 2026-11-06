# Skill 消费链

归属 AH-617；本页维护 CLI 的验证入口，不记录功能已通过。SC01–SC26 的任务、用户入口、驱动、证据和状态，以及缓存 × 会话 × 入口 × intent 的完整组合，统一维护在 [Broker 消费链主地图](../../../../../pi-context-broker/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)。这里的跨仓链接假设两个 checkout 相邻；其他布局先定位真实 Broker 根目录，再读取同一仓内路径，不创建替代地图。

## SC25：日常命令与目录 SDK

C3/SC23 的全部 16 个原顶层路径与子树去向维护在 [消费合同的命令 disposition](../../../../docs/consumer-contract.md#cli-command-disposition-and-compatibility)。默认 help/schema 只展示日常消费和 ctl 入口，作者命令按任务发现；`schema ctl ...` 完整展开所选管理树。旧五个 root 管理路径精确调用仍与 ctl 使用同一 parser/handler，不能从默认目录不可见推断能力被删除。

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

Default View 正例只增加完整 View metadata observation；原 consumer fixture 的正文状态单独标记。`--catalog --default-view-cache missing|incomplete` 各生成新 owned fixture，实际 SDK/正常 Pi 默认目录必须拒绝缺失或不完整观察。不能只验证预期错误就把正例算通过。跨仓 driver 使用 fixture 的 `default_view.records` 和 `catalog_records` 独立核对，真实 Notion 和真实模型仍各自取证。

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

报告必须标记 `selection=scalar-inventory`；默认 `all` 仍运行原 22 项与本 case 的全部相位。先冻结 fixture 与原 C7 独立包，保留重复目录计数的红例，再由候选的默认安装矩阵验证；各轮分别绑定生成器、fixture 和包身份，不能将新生成的 fixture 冒称同一份原始输入。每轮 logical/physical 对照使用同一冻结来源。原 C7 Pro/Mini 公开 read 账本各观察到 Members 与 Requires 额外两轮、6 attempts / 1,431,764 decoded response B；这是本次同调用复用的原成本和可移除上界，不是新候选的实测生产延迟收益。原件位于 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc14-fact-read-audit-346gjnf6`。

2026-11-06 的安装 fail-before 使用原 C7 `f854faf5...`，其独立安装 68 文件与 tar 全等。原 scalar 三次读取各 2 页；新增关系 logical/physical 两次读取的完整结果、SQLite snapshot、关系、全文和导出先全部匹配，随后仅 logical 的 `6 !== 2` 计数断言失败。`verification-run/evidence/installed-c7-before/report.json` SHA `10283531c21450b30b523ebb73eb230ea70be807fdf1f7f40d431858868014e5` 保留该失败。五相位合计 63 次 loopback HTTP / 872,712 decoded response B，未选目标 page/body 为 0；原缓存和动态 View 链因失败未运行，不从此前结果补算。`implementation/installed-c7-before-ledger.json` 绑定完整请求、五次归零的 in-flight 和 10 个自然关闭的 CLI/npm 子进程；外层 Node 自然 exit 1。原 control cleanup 与系统 Trash 后，6,540 个保留文件、实际日用三哨兵和原 staged index 均未变。Core 原 5 个重复页红例、76 项定向通过、类型修正后的 28 项和 typecheck 单列；C8 默认安装矩阵与新生产成本仍待执行，不能将这份 C7 失败改写为通过。

该回归与 smoke 使用受控 Notion 服务和真实安装包，不是生产延迟证明。真实成本另用 Broker 的 `scripts/skill-consumption-source-baseline.mjs`：保留先前授权的 database/root/resource、单次 resource-only cold 场景与预算，只替换 installed CLI 和新的 evidenceRoot；按 Doctor → Plan → Run → Evidence → Trash Cleanup → Evidence 执行。比较实际 metadata/current-body/retained-body、请求字节、解码响应字节、耗时和内容 hash，完整 trace 缺失时不能宣称移除了请求。单样本耗时仅报告该样本，不外推稳定收益。

scalar 复用不改变 Members/Requires 语义，也不建立跨请求缓存。实际关系仍来自当前选中页并按原规则完整分页；只有同 scope、完整 library descriptor 和穷尽性已核验的本次目录观察可传给目标元数据解析。权限、缺失／禁用目标、身份冲突、当前正文和固定 pin 仍按原边界验证。后续 refresh 必须重新观察，旧 pin 的正文与关系元数据仍冻结；Records headers/Payload 分层保持不变。

### C8 安装与真实双机公共 CLI 后续证据

2026-11-06，纯 `b5564ee9` 的 C8 归档 `2c65d54aee20f0fbb30af30bd1d67b32ad00e7285f0c9a50bc9f477962aeee9f` 通过原完整安装入口：公共 CLI 44 项、SDK 22 项，scalar 5、cache 32 和 View 动态 13 阶段均通过。同一轮 fixture 内，logical 关系读取使用 2 页，physical 对照仍为 6 页；完整结果、snapshot、关系与正文相等。`c8-cli-final-jugpaxrt/handoff.json` SHA `9fc19aa5a1ce112dc896ba32199f105dcbbbe0b2713d49d1bd75bf9bbe6e9aaf` 保留一次 build/pack/原 gate 与 E→Trash→E，不把本地通过替代远端 CI。b556 的 macOS/Node22 check 仍有原 scheduler 时间 oracle 失败，另外三个平台组合通过；原失败单列在 `remote-ci-b556-final/`。

实际生产来源沿原 SC22 公共六命令 driver：`list` → current `read` → 系统返回 fixed ref 的 `use` → `files` → 系统返回 resource ref 的 `read` → offline `export`。Pro/Mini 各 n=1、原 300 秒/命令、零重试，使用各机自身认证与空 owned state；独立安装 68 文件均等于归档，不复制正文或缓存。下表对照原 C7 的**同六命令**样本，不能混入更早七命令账本。

| 物理机 | C7 → C8 HTTP attempts | C7 → C8 decoded response B | 实际减少 B |
| --- | ---: | ---: | ---: |
| Pro | 38 → 32 | 4,882,566 → 3,450,800 | 1,431,766 |
| Mini | 38 → 32 | 4,882,554 → 3,450,780 | 1,431,774 |

两机 current read 均由 21 降至 15 attempts；list 5、fixed use 12 保持，后续 files/resource/export 为 0。根与完整 Requires 合计 47,475 B，46 个业务文件/364,634 B、1,135 B 固定资源、scope/version/pin 和全部文件 hash 与原冻结输入相同。每机实际正文 attempts 仍为 6，54 个未选 Member 正文为 0，inspect 不读 Requires 正文；新 observer HTTP 与来源写入均为 0。这里的字节是解码响应，单次 21.027/33.702 秒只作观察，不推导稳定延迟或模型任务收益。

完整回执为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc22-final-c8-3a02z8s9/cli-physical-handoff.json`，SHA `c04515f1ef4e156063f803d0e26fb6793de0ddb0cbaa659ced03fc2b93bc323a`。两机均仅将 owned run 与 guard 移入系统 Trash；原 C7 永久删除偏差不改写。Pro 外层预建 cleanup stdout 被旧 helper 暂列为零字节原件，结束打印后仅该 observer 输出变化，`ece-outer-reconciliation.json`（SHA `3618031e0b31a22c7b21c943ffcca6022af333aa9bcd5b4d9ec9078f0b38b5bf`）明确保留原回执并核对其余 89 原件不变；Mini 输出置清单外，90 原件全部保持。两机包与日用哨兵未变，没有重跑消费者或清理。Pi 正常 SDK 交付、真实模型与日用切换继续分别验收。

### SC14：固定文件集的历史量与解码账本

沿原安装 smoke 的 `--case records-history` 驱动，不构建产品或新增总验证器。旧入口不接受该选择器，原报告也没有独立 decoder/history 维度；这是 coverage fail-before，不能冒称产品错误。

```bash
node scripts/sdk-package-smoke.mjs --archive "$CLI_ARCHIVE" --fixture "$FROZEN_FIXTURE/fixture.json" --outdir "$RUN/scratch/records-consumer" --case records-history
```

同一次独立安装先用原 scalar loopback 做一次小冷读，绑定安装 SDK 的 SHA/URL/函数范围，验证 Node precise coverage 的 `recordFromEnvelope`、`boundedEnvelope`、`decodeHeader`、`resolveFileState` 有实际非零调用，并用下一次无消费采样证明清零。计数器不可用或探针失败时保留原错误并停止，不能用缺项补0、增加产品 hook 或换平台追绿。原始函数 ranges 与阶段计数保存在 `records-history/*-coverage.json`。

探针通过后，原 `sdk-fixture.ts --records-history` 在60秒内通过既有 `nativeGraphFixture`/`prepareGraph` producer 生成 H=1/H=101 的合法父事件与 retained facts。四个业务主文件、owner/File ID/最终内容及关系不变；只共享 Requires d 的历史量变化，未选 optional 不提供正文响应。两种历史的 heads 可能使 pin 不同，各自对完整 producer oracle 验证，不强行抹平版本。producer 请求、写入及 frozen source 与空 consumer config 分账，绝不把生成的对象/SQLite 缓存复制给消费者。

每个 H 串行执行多根 cold/warm/expired-unchanged，再以独立冷状态执行单根 a；单根 a 的完整 Requires 已包含同四节点，因此能直接观察增加根 c 是否重复取数/解码。共八次SDK调用、每次30秒、总240秒、n=1/0重试，外层仍用原15分钟预算。对账完整HTTP journal/trace/响应字节、未选正文0、零常规写回、全文/manifest/关系/本地旧pin对象hash，并保存实际失败位置；失败后不启动后续相位。总函数次数不能冒充逐fact归属或内部Schema/DFS循环次数，带coverage耗时不能作为稳定性能收益；CPU/RSS/压缩wire bytes保持unknown。

默认 `all` 保留原22个case及其反例，并在原scalar case末尾追加同一测量；`view-dynamics`/`scalar-inventory` 的定向含义保持。常规 `package:check`/CI 继续沿同一原driver执行。Evidence先保留完整相位、生成器与安装身份、所有原失败；所有进程/服务终局后通过本Skill原cleanup将明确owned scratch移入系统Trash，再核原件保持。该测量不新增SC22/SC20前置。

2026-11-06 使用原 C8 archive `2c65d54aee20f0fbb30af30bd1d67b32ad00e7285f0c9a50bc9f477962aeee9f` 完成一次独立安装，68文件逐项等于归档，SDK SHA `5f7ae1e9a94fcde67a8b95c011f0164b5c1a7f7b22d7228c12ab39c5feaf76b7`。证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc14-history-measure-e7s0yzfz`。首个入口155.158ms因归档fixture仍指向已Trash的旧绝对路径而退出；当时安装、probe及SDK调用均0。`input-rebinding.json`仅将9个路径指向保留的同一输入，反向深等通过，其余数据未改；该失败原件不覆盖。

更正输入后的原driver自然exit0、47,818.411ms；npm安装5,742.609ms，合法H1/H101 producer 2,280.473ms。probe实际 envelope/bounded/header/replay 次数为3/3/6/6，紧接的无消费采样四项均0，函数范围绑定精确安装SDK。八个消费者相位全部通过完整内容/身份/关系/manifest/旧pin对象hash断言；两臂cold的单根与多根具有相同事实集合及以下相同计数。表中envelope与bounded两函数次数相等，header/replay为各自实际函数入口次数。

| H | 状态 | HTTP attempts | decoded response B | envelope / header / replay | elapsed ms |
|---|---|---:|---:|---:|---:|
| 1 | cold，多根 | 15 | 24,475 | 4 / 12 / 8 | 5,085.530 |
| 1 | warm，多根 | 1 | 61 | 0 / 0 / 0 | 258.988 |
| 1 | expired-unchanged，多根 | 10 | 19,571 | 4 / 4 / 4 | 3,551.441 |
| 1 | cold，单根 | 15 | 24,475 | 4 / 12 / 8 | 5,369.820 |
| 101 | cold，多根 | 18 | 374,591 | 104 / 312 / 8 | 8,468.580 |
| 101 | warm，多根 | 1 | 61 | 0 / 0 / 0 | 187.164 |
| 101 | expired-unchanged，多根 | 12 | 211,715 | 104 / 104 / 4 | 4,320.646 |
| 101 | cold，单根 | 18 | 374,591 | 104 / 312 / 8 | 8,161.035 |

八相位合计90HTTP、1,029,540 decoded response B；probe另计11HTTP、102,804B，producer的受控服务调用另列。每个cold相位读取4个必要正文，warm/expired正文0；所有消费者未选正文0、write0。cold的完整payload行数和唯一record IDs分别为4/4、104/104；expired未再次传输payload，但实际重新解码本地4或104个envelope。逐fact decoder归属、内部Schema/DFS迭代、CPU/RSS、wire bytes仍unknown；n=1且开启precise coverage的elapsed不用于宣称稳定延迟收益或采用检查点。

定向原报告 `verification-run/evidence/installed-records-history/report.json`（SHA `2578f8a5219be7aa42c45a5a7374a2e70cd22495fa6559b7d515eadddd1f67f5`）为selection=`records-history`的1/1，不冒充重跑完整SDK22。内层八相位原账本SHA `66e0fb569d8f42d3f231b1c1cb3e3ba34a3a05b47477292fa479cffda0d9cd45`；原完整H1/H101输入SHA `684329e1e1a2619bbe34ab9e597522e9a58830a498129d410ce0d6c087af050d`。`cleanup-result.json`（SHA `45922dbc394f5988dd697f7b96283c40e5f3c9a71d08590ddf9eb89246a53f9f`）确认原helper把owned scratch移入系统Trash，launcher cache同用系统Trash，331份原件逐字节不变；日用三哨兵及原1615暂存项保持，活动消费者0。此次未运行生产Notion或真实模型，也未重建产品。

### CI 保留计数比较与原 coverage 文件

原 `package-check.ts` 已把完整 SDK report 内嵌到 CI 上传的 `ntn-package-check.json`。history ledger 同时保留 `root_comparisons` 与 `coverage_files`：每份原 `*-coverage.json` 的文件名、UTF-8 原文、bytes 和 SHA-256 随报告归档，包含 probe/reset 与八相位各自的 before/after；从 `content` 还原文件后，逐字节核对长度/hash。独立相位文件继续保留，不改变 Profiler 配置、SDK 调用、计数、预算或失败位置。

`root_comparisons` 保存各函数的真实差值及 `necessary_decode_reuse`，false 或非零必须原样进入 artifact。ledger 的 `status: passed` 表示八相位测量与内容/请求门槛完成，不证明所有 decoder 差值为零。comparison 仍是观察结果，不通过增加消费者样本或放宽断言将差值消除。

旧 `bb09afb` CI run `42186327179` 的四平台均实际 SDK22/22 与 history8/8，但原 ZIP 只有 package JSON，未上传 standalone comparison/coverage。归档在 `sc14-history-measure-e7s0yzfz/remote-ci-bb09/`：macOS24 H101 single-cold 的 `decodeHeader` 为109、多根312；其他三平台对应两臂均312，原因保持unknown。两臂 envelope/bounded、HTTP/响应字节及相同四文件闭包仍各自保留；不能把这个窄事实写成逐fact全部验证一次。CI SDK `91ca58f9…` 与原 C8 SDK `5f7ae1e9…` 身份不同，不声明字节等价。本次仅修复归档接线，旧 cohort 不重跑；新接线的远端结果按它自己的提交与原 artifact 验收。

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

2026-11-06 定向实驱使用已冻结 C7 包 `f854faf5d2e938761eaa2e57c42ffbd08f5ac695ac2ce83421d82ff89b1467ac`，没有产品修改。证据根 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc11-view-dynamics-ozgctn0b` 保留旧报告缺动态阶段的红例，以及首轮误把薄 files 条目当完整 manifest 的真实 oracle 失败；该轮旧 pin 的逐文件读为 `not_run`，不能沿用后轮结果。修正后 `verification-run/evidence/installed-view-dynamics-02/report.json` 为定向 1/1、13 相位通过；`installed-02-ledger.json` 记录 46 HTTP / 561,367 decoded response B，其中 43 metadata、3 次最初正文读取，0 write。旧 pin 三文件均沿实际返回 ref 读回并核 hash；目录变化未增加正文源请求。`core-regression-02.json` 是完整 Views 17/17，`typecheck-02.json` 为 exit 0；这些结果不替代完整 SDK 22 项或生产 View filter 验收。原 helper 将自有 scratch 移入系统 Trash，`cleanup-result.json` 核对 12,973 份保留文件字节未变。

同根 `ci-wiring/` 随后通过原 `control.ts init/package/cleanup` 完成一次完整本地安装门禁：自然 exit 0、389,945.870 ms，SDK 默认 22/22，原 3 个 scalar / 32 个 cache 阶段和新增 13 个动态阶段均通过。`gate-result.json` 绑定原 report SHA `96f0a55622b4215bdeab95a04fcdf184eaa2fb2359ee5035eb48c789aa1b7a4f`；原 package JSON 的 `sdk` 与它完整相等。此轮使用纯 `1d88e02c` 导出加五个验证改动，产品来自 C7 发布文件；现有 Bun pack 只将 `package.json` 的开发依赖 `workspace:*` 规范成 `0.1.0`，其余 67 文件（含 CLI/SDK）逐字相同，不能称整个 tar 等于 f854。`packed-c7-identity.json` 保留该差异，类型检查首次缺导出环境依赖及补齐后的通过也分别保留。原系统 Trash 清理后 378 份证据字节不变，完整 phase 原件在 `verification-run/evidence/package-scratch-original/`；这是一轮本地门禁，远端四平台结果另按新提交验收。

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

测试打印保留 ledger 的目录，不永久删除失败原件。安装 smoke 的默认选择和命令合同保持；定向 scalar／View／history 的原有意义也保持。Broker 冻结 helper 时记录文件 SHA-256、fixture SHA-256、C9／CLI 包身份；未变化的运行时不因此重新 build/pack。其目录、恢复、取消三个场景各自取证，固定包与控制服务的通过不能算正式 SC20 生产成本或 SC21 模型验收。

每个 HTTP attempt 的账本区分已观察前缀和完整响应。`observed_response_bytes` 是服务端实际调用 write/end 的未压缩前缀；只有响应 `finish` 才填 `decoded_response_bytes`、`response_sha256` 和 `response_bytes_complete=true`，并保留明确的 server-write `response_boundary`。中途断流／abort 保持完整字节与 hash 为 `null`，不能把计划发送的 JSON 长度当成完整响应。客户端解码、SDK 全文结果及 provider 真正收到正文仍由各自账本证明。请求前缀、单调时钟 start/end/close、真实 status 和每次重试均保留；汇总失败尝试时不能补零或丢弃它们。

本轮 fail-before 使用原 main handler：不完整 POST 被客户端取消、实际没有 HTTP response，旧账本却记录完整 109 B。新 helper 的同边界完整响应字节为 `null`，另留已观察前缀。原失败、控制回归与安装结果保存在 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc20-sdk-http-shared-r7m4k2vd`。先将 owned scratch 中所有原始 ledger／结果及身份存入 `RUN/evidence`，再由原 `control.ts cleanup` 移到系统 Trash，最后核对证据 hash、进程终局和日用哨兵；不清理其他会话的目录。

后续实际 Pi 权限场景暴露了仅拒绝 page route 的 fixture 缺口。`cli-http-denied-body-ubd70ukm` 保留同一根 markdown 在 deny 状态返回 200 的 RED，以及修复后的原 6 项 HTTP 回归。此前 22 项安装 SDK 结果仍绑定原 helper `5f27b4bb`，不改写为新 helper 的重复验收；新的真实 Pi 403／固定资源／恢复证据由 Broker 原场景独立记录。

### 单 current inspect 投影实验未采用

2026-11-05 的候选只对单 current `inspect` 使用完整六字段身份目录和一次选中完整页 GET。原有 scalar read 复用不变。候选通过受控 N=1/10/100/101/300、权限、分页、身份、取消、混合根边界和独立安装 SDK/CLI 检查，但真实首读延迟未达到预先冻结的采用门槛。运行时代码、候选专用 core 断言及 `inspect_phases` smoke 断言已撤回；当前 graph prepare 仍使用原完整 inventory，当前 smoke 不承诺该投影。

证据根为 `/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc11-single-inspect-iyw1oxit`。保留 `controlled-comparison.json`、`installed-comparison.json`、两份独立包、原 fail-before，以及 `withdrawal/candidate-all-nine.patch`。旧候选的 `SC11_INSPECT_COST` 和安装 `inspect_phases` 只能从这些冻结原件复查，不能把它们当作当前 main 的成功断言。

真实配对沿 Broker 原 `skill-consumption-source-baseline.mjs` 的 `inspect-current` 入口，每次只执行一个公开 `ctl prepare ROOT --purpose inspect --database DATABASE --metrics`。六个 consumer 均从自己的空 state 开始，不复制 oracle 正文或缓存。完整正文、46 文件逐项 bytes/hash、scope/version/pin、Requires/Members 目录均与独立原件一致。每次四个 body 请求的目标和 395,627 响应字节相同；既有离线 source proof 证明未读取 Requires 或未选 Members 正文。原 `unclassified_body` 分类保留，归属证明单列。

| 配对顺序 | C6 elapsed / rootReady ms | 候选 elapsed / rootReady ms | 候选减 C6 ms |
| --- | ---: | ---: | ---: |
| C6 → 候选 | 9875.752 / 9572 | 9007.326 / 8626 | -868.425 / -946 |
| 候选 → C6 | 8302.505 / 7993 | 8683.400 / 8384 | +380.895 / +391 |
| C6 → 候选 | 8588.354 / 8280 | 10698.151 / 10401 | +2109.797 / +2121 |

每次来源请求从 15 增至 16，唯一新增项为选中根 metadata GET。总 decoded response 从 1,971,679 B 降至 1,182,292–1,182,316 B，约减少 40.035%。各臂 elapsed 中位数为 8588.354 / 9007.326 ms，rootReady 为 8280 / 8626 ms；paired delta 中位数分别为 +380.895 / +391 ms。`functional_acceptance=true`，`adoption_gate_passed=false`。两条延迟预算均回退，不能以目录或总字节改善覆盖它们。

`live-pair-plan/real-pair-result.json` SHA-256 为 `515544b7210df7847f77bbaf05454f50309af5c5936b651dbc435a26008d7700`。六次共 93 HTTP、9,461,957 decoded response B，实际 write/provider 均为零，无缺失 metrics、未知来源或补跑。这个窗口的零写入不改变 current 消费可能 retention/adoption 的合同。六份原 E→C→E 全部通过，`cleanup-result.json` SHA-256 为 `407a69beb93eec0ba7a4288e5cc000748a8465d488461d7498d81afbb164c6ad`；只移走各自 owned working，原证据和日用配置保持原字节。

受控 N=1 的 +864 B 回退继续保留。余代价仍包括全库身份分页、选中页、首次 current 正文和 retained source。只有新的具体机制能改变上述取舍，或任务成本预算被明确调整时，才提出新的冻结比较；不增加规模阈值、不延长 TTL、不补同输入样本追绿。三个 pair 不外推 p95、全 Agent 任务或其他库规模的收益。

## Gotchas

- `passed`、`failed`、`blocked`、`not_run`、`skipped` 分开记录；机器矩阵的合法不适用项使用 `not_applicable` 并保留理由。缺前置是 blocked，方便路径通过不能覆盖未跑组合。未独立执行的规程是 draft。
- source/投影字节和机器证明分开。摘要、hash、loaded 标记、成功编译或模型自述都不能替代当前实际必要正文；原全文合同保持到新投影合同正式冻结。
- A/B 根选择继续遵守原 [依赖图合同](skill-dependency-graph.md)：oracle 与 consumer 隔离，不预热消费缓存，不泄漏叶子、答案或强制工具参数，不隐藏本地插件副本，不把目标改成 Requires。新投影尚未冻结时不以缩短正文后的检查重写旧 Gate 结论。
- 不删除失败样本、不事后换 prompt/model、放宽 TTL 或把后台成本移出总账。单次快速结果不能代替同条件样本与完整网络边界。
- 只检查 Skill 的 intent 不启用工作流；完整模型目录、UI 补全与正文读取分别证明。未选择 Member 的正文零读取须有实际 I/O 账本，不能由目录外观推断。
- 本页执行完成仍只证明 CLI 层。SC01 的独立新会话需只依赖实际 Skill/地图完成主地图指定的同一路径；真实模型、独立安装、pro/mini 恢复和正常日用切换保留各自门禁。
