# Skill 消费链

归属 AH-617；本页维护 CLI 的验证入口，不记录功能已通过。SC01–SC24 的任务、用户入口、驱动、证据和状态，以及缓存 × 会话 × 入口 × intent 的完整组合，统一维护在 [Broker 消费链主地图](../../../../../pi-context-broker/.agents/skills/verify-notion-skills-integration/features/skill-consumption.md)。这里的跨仓链接假设两个 checkout 相邻；其他布局先定位真实 Broker 根目录，再读取同一仓内路径，不创建替代地图。

导航：[Sub-features](#sub-features) · [用户入口](#how-to-get-to-it-user-pov) · [驱动与清理](#driving-it-with-control-ntn-skills) · [Gotchas](#gotchas)。

## Sub-features

| Feature ID | 可观察结果 | CLI 证明范围 |
| --- | --- | --- |
| SC-VERIFY-01 | 从入口和功能地图找到本次场景、前置、驱动、证据及失败状态 | 本页连接现有 `control.ts`、[Broker 消费](broker-consumption.md)、[共享 SSOT](shared-ssot.md) 与 Broker 主地图；不把某个方便入口当成全矩阵 |
| SC-VERIFY-02 | 证据判据拒绝假成功 | 沿用 [图合同](skill-dependency-graph.md) 的 oracle、scope、hash 和完整正文反例；消费链扩展由 Broker `scripts/skill-consumption-contract.mjs` 驱动，按主地图的实际命令执行 |
| SC-VERIFY-03 | 下一位 Agent 独立完成 Launch → Doctor → Drive → Evidence → Cleanup，清理后证据不变 | 本页给出实际 CLI 消费路径；真实 Pi 路径、独立新会话和最终模型验收各保留自己的结果 |

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

`DATABASE` 取本次授权库的实际 selector，`PAGE_ID` 取该库的目录/fixture 回执。缺少目标时记录 `blocked`，不能随便取另一个库或叶子完成验收。`consumption` 不创建或修改远端页；未知原操作仍由原恢复流程负责。

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

真实网络只读消费需要已有目标库授权；它不调用模型。检查 `consumption-source.json` 与实际命令回执，核对 scope、完整覆盖、动态主入口、固定 snapshot、每个导出文件 bytes/hash、输出复用和冲突后原文件未变。安装包验证另按 [Broker 消费地图](broker-consumption.md) 用实际 `--installed-bin`；checkout 结果不能替代安装包。

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

## Gotchas

- `passed`、`failed`、`blocked`、`not_run`、`skipped` 分开记录；机器矩阵的合法不适用项使用 `not_applicable` 并保留理由。缺前置是 blocked，方便路径通过不能覆盖未跑组合。未独立执行的规程是 draft。
- source/投影字节和机器证明分开。摘要、hash、loaded 标记、成功编译或模型自述都不能替代当前实际必要正文；原全文合同保持到新投影合同正式冻结。
- A/B 根选择继续遵守原 [依赖图合同](skill-dependency-graph.md)：oracle 与 consumer 隔离，不预热消费缓存，不泄漏叶子、答案或强制工具参数，不隐藏本地插件副本，不把目标改成 Requires。新投影尚未冻结时不以缩短正文后的检查重写旧 Gate 结论。
- 不删除失败样本、不事后换 prompt/model、放宽 TTL 或把后台成本移出总账。单次快速结果不能代替同条件样本与完整网络边界。
- 只检查 Skill 的 intent 不启用工作流；完整模型目录、UI 补全与正文读取分别证明。未选择 Member 的正文零读取须有实际 I/O 账本，不能由目录外观推断。
- 本页执行完成仍只证明 CLI 层。SC01 的独立新会话需只依赖实际 Skill/地图完成主地图指定的同一路径；真实模型、独立安装、pro/mini 恢复和正常日用切换保留各自门禁。
