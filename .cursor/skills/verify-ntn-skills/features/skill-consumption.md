# Skill 消费链

归属 AH-617；本页维护 CLI 的验证入口，不记录功能已通过。SC01–SC26 的任务、用户入口、驱动、证据和状态，以及缓存 × 会话 × 入口 × intent 的完整组合，统一维护在 [Broker 消费链主地图](../../../../../pi-context-broker/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)。这里的跨仓链接假设两个 checkout 相邻；其他布局先定位真实 Broker 根目录，再读取同一仓内路径，不创建替代地图。

## SC25：日常命令与目录 SDK

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

既有 `control.ts consumption/prepare/import/reuse` 现在沿全部 list cursor 收集目录，首批 refresh、后续 offline 复用同次观察，并核对 scope、fetched_at、总数与重复 ID；不能把默认 50 条当全库。所有当前 read 的 adoption/retention/Records 写入仍进入 request_metrics。Cleanup 只移动本次 owned fixture/安装目录，保留归档、hash、失败原件和证据。

导航：[Sub-features](#sub-features) · [用户入口](#how-to-get-to-it-user-pov) · [驱动与清理](#driving-it-with-control-ntn-skills) · [Gotchas](#gotchas)。

## Sub-features

| Feature ID | 可观察结果 | CLI 证明范围 |
| --- | --- | --- |
| SC-VERIFY-01 | 从入口和功能地图找到本次场景、前置、驱动、证据及失败状态 | 本页连接现有 `control.ts`、[Broker 消费](broker-consumption.md)、[共享 SSOT](shared-ssot.md) 与 Broker 主地图；不把某个方便入口当成全矩阵 |
| SC-VERIFY-02 | 证据判据拒绝假成功 | 沿用 [图合同](skill-dependency-graph.md) 的 oracle、scope、hash 和完整正文反例；消费链扩展由 Broker `scripts/skill-consumption-contract.mjs` 驱动，按主地图的实际命令执行 |
| SC-VERIFY-03 | 下一位 Agent 独立完成 Launch → Doctor → Drive → Evidence → Cleanup，清理后证据不变 | 本页给出实际 CLI 消费路径；真实 Pi 路径、独立新会话和最终模型验收各保留自己的结果 |
| SC-TOOLS-04 | 同一固定 owner/pin 的资源集合一次获取，源字节与投递证明分开 | [资源合同](../../../../docs/resource-read-contract.md)、Core 定向测试、现有独立 SDK smoke；实际 Pi 从 Broker 主地图 `resource-batch` 进入 |
| SC-TOOLS-13 | 固定主文与有效当前缓存仅校验所选对象；current 先判定完整来源归属，再获取必需字节 | [按需快照合同](../../../../docs/selected-snapshot-consumption.md)、既有 SDK smoke 的 partial-cache 与 cold ownership case；实际 Pi 从 Broker 主地图 `partial-entrypoint` 进入 |
| SC-METADATA-01 | 单次 scalar current 读取内，逻辑选择与原生引用编译复用完整六属性目录 | [目录复用合同](../../../../docs/shared-metadata-consumption.md)、下方 scalar inventory 回归和独立 SDK/CLI smoke；完整 SC11 投影/批次矩阵仍单列 |
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

用户在 CLI 选择一个可访问的 Skill，查看主文与文件，读取固定版本并导出；Pi 用户通过 `$`、`/skill:` 或模型工具选择同一能力。本 CLI 的公开入口是现有 `list`、`read`、`files`、`export` 和 `prepare`，没有新的验收专用产品命令。

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

审阅 `scalar-inventory-evidence.json`、`scalar-inventory-notion-requests.jsonl`、三次 read result 和实际 snapshot export：

- SDK 冷 logical ref、同 scope 显式 refresh、另一个空 Store 的 installed CLI `read RESOURCE --from LOGICAL_REF` 分别计量。每次只完成一轮 100 + 1 行的 Skills 查询；每页恰好六个已注册 property ID，无行过滤，没有第二轮 cursor 序列。
- 完整当前根页仍单独 GET；目录中没有 Source/Files 等字段时不能将其当完整页面。Available / disabled 外部引用均保留准确身份和元数据，目标页与正文不得被获取。
- refresh 必须重新观察变更后的根与 disabled 目标元数据。公开输出和持久 catalog 不包含 raw inventory；名称/描述变化使用当前根，逻辑 Skill ID 漂移在正文读取前失败。
- 完整正文、目录及离线 snapshot export 的每个 path/length/SHA，与独立 page-ID/full-inventory oracle 匹配。检查每条真实 HTTP trace 完整、失败/取消/未知字节与该阶段的实际结果一致；没有台账的量不得写零。

该回归与 smoke 使用受控 Notion 服务和真实安装包，不是生产延迟证明。真实成本另用 Broker 的 `scripts/skill-consumption-source-baseline.mjs`：保留先前授权的 database/root/resource、单次 resource-only cold 场景与预算，只替换 installed CLI 和新的 evidenceRoot；按 Doctor → Plan → Run → Evidence → Trash Cleanup → Evidence 执行。比较实际 metadata/current-body/retained-body、请求字节、解码响应字节、耗时和内容 hash，完整 trace 缺失时不能宣称移除了请求。单样本耗时仅报告该样本，不外推稳定收益。

本次复用不扩至 graph 全属性观察、Members/Requires 或跨请求缓存。权限、完整分页、禁用目标、身份冲突、当前正文和固定 pin 仍按原边界验证；尚未执行的 SC11 字段投影/批次范围继续保留。

## Gotchas

- `passed`、`failed`、`blocked`、`not_run`、`skipped` 分开记录；机器矩阵的合法不适用项使用 `not_applicable` 并保留理由。缺前置是 blocked，方便路径通过不能覆盖未跑组合。未独立执行的规程是 draft。
- source/投影字节和机器证明分开。摘要、hash、loaded 标记、成功编译或模型自述都不能替代当前实际必要正文；原全文合同保持到新投影合同正式冻结。
- A/B 根选择继续遵守原 [依赖图合同](skill-dependency-graph.md)：oracle 与 consumer 隔离，不预热消费缓存，不泄漏叶子、答案或强制工具参数，不隐藏本地插件副本，不把目标改成 Requires。新投影尚未冻结时不以缩短正文后的检查重写旧 Gate 结论。
- 不删除失败样本、不事后换 prompt/model、放宽 TTL 或把后台成本移出总账。单次快速结果不能代替同条件样本与完整网络边界。
- 只检查 Skill 的 intent 不启用工作流；完整模型目录、UI 补全与正文读取分别证明。未选择 Member 的正文零读取须有实际 I/O 账本，不能由目录外观推断。
- 本页执行完成仍只证明 CLI 层。SC01 的独立新会话需只依赖实际 Skill/地图完成主地图指定的同一路径；真实模型、独立安装、pro/mini 恢复和正常日用切换保留各自门禁。
