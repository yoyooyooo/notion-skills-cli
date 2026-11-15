# 已有合同与历史验证路径

本页保留拆分前总入口的合同细节和历史路径。领域选择以当前 SKILL.md 和 verification/skill-domains.json 为准；历史通过不转移到新候选。

# Verify ntn-skills

For a new-user journey, start with [EMPTY: fresh library and progressive maintenance](../features/empty-library.md), AH-1040–AH-1047. Its initializer must create the real remote schema from an empty authorized parent; clearing local caches around a prebuilt fixture does not prove that starting condition. Reuse this Skill's isolated launcher and record every action's table delta independently.

AH-1024 渐进维护先读 [完整 Skill 维护矩阵](../features/skill-maintenance.md)。草稿、半注册、目录资格、audit 覆盖与原操作状态分别核对。MNT01 反例同时经过目录分类和完整审计，不能靠忽略空字段获得通过。每个子票维护自身回归和公开入口，再由原 Broker integration 验证管理到实际消费。

## 有限模型维护路由

AH-1006 使用 [维护合同](../../../../docs/formal-verification-maintenance.md)。资源生命周期继续走 `verify-notion-resource-lifecycle`；原 ACK/Records 前缀、独立接受与业务反馈走 [verify-notion-operation-recovery](../../verify-notion-operation-recovery/SKILL.md)；FV07 / AH-1013 请求引擎走 [request-engine-formal](../features/request-engine-formal.md)。三组复用 `scripts/verify-resource-lifecycle.mjs --suite lifecycle|operation-recovery|request-engine`，`--model` 选择完整模型组。默认生命周期入口不变，模型通过与真实 CLI/安装/Notion 验收分别记账。


AH-681 阶段一先读 [资源状态与页面保护](../features/resource-phase1.md)，按 NR01-state、NR02-protection、NR03-readonly 分别核对公开状态、真实并发能力和严格只读调用链。先维护当前票的观察点与反例，再实施；工具验收和真实库存落地分别记录。

AH-617 消费链重构先读 [Skill 消费链](../features/skill-consumption.md)。SC-VERIFY-01～03 将本 CLI 的真实消费、成本证据与清理边界接到 Broker 的 SC01–SC26 统一地图；SC25 通过 list/read/use 和 SDK 目录入口取证，SC26 负责真实 Pi 与常规 check/CI 接线。新架构、模型投影和日用安装分别取证。未执行的规程仍为 draft，不沿用 AH-561 的历史 pass。

SC25 名称选择沿同页 C2 驱动：完整 enabled 普通目录经共享 pure resolver 产生 canonical 身份，consumer/decoder 仍核对 exact targets；View、搜索或分页投影不能充当唯一性证明。固定 name/alias 由原 snapshot manifest 和已知权限门槛校验，SDK `listSkill` 不为固定资源准备主文。保留不完整零/单匹配的 fail-before、安装包 export 与无主文对象读取反例，实际 Pi 另走原跨仓 SDK-Pi driver。

SC11 的 full catalog 与默认目录组合读取沿 [同次目录观察](../features/skill-consumption.md#sc11同次-sdk-目录观察) 驱动：原始完整库存只在一次 SDK operation 内复用，独立核对两个投影的 outcome、原观察年龄与实际 HTTP 账本，不把公开 enabled records 当成完整库存。

AH-561 直连请求与跨 Skill 图使用 [request-engine](../features/request-engine.md) 和 [skill-dependency-graph](../features/skill-dependency-graph.md)。先执行 NG-VC-01 离线契约与原生 CLI fail-before，保存两条根选择提示和独立 oracle 合同；后续按 NG-RE/NG-SG feature ID 逐项复验。当前 helper 使用项目 HTTP 引擎、项目凭据和 owned 归档入口。每轮交付需重新取得服务与安装证据；保留历史回执，不把旧单 Skill pass 用作图验收。

图专项由 Broker 仓库的 `scripts/verify-skill-graph-contract.mjs` 共用一个离线检查入口；不新增第三个总验收 Skill。它只驱动当前 Node CLI 的离线 version/schema，绝不读取业务正文、请求生产 API 或调用官方 ntn。`contract-valid` 只说明证据合同成立，不能代替真实 Notion、Pi、模型、UI 或安装包验收。

The primary surface is the JSON CLI. Use the repository's TypeScript dev entrypoint for live Notion operations and its existing npm consumer smoke for the built Node.js package. Read [the feature map](../features/README.md) first; a passing convenient path does not prove the other mapped entrypoints.

The same package smoke also drives the [shared author lifecycle](../features/import-create-recovery-dry-run.md#independent-installed-author-lifecycle) through an independently installed Node bin and an owned loopback service: create/readback, body-only write, sparse metadata update, apply/replace, old pins and an actually lost original-outcome response. Keep its command/HTTP ledger and strict negative cases separate from seeded offline snapshots and real Notion authorization. The fixture service reuses existing core fixtures; it never writes consumer state to manufacture a result.

Its [maintenance repair stage](../features/skill-maintenance.md#joined-installed-acceptance) drives public plan/apply/show/reconcile/repeat commands for an original historical main and a hand-created File. The installed bin must preserve each native page, body and untouched property, refuse the unsupported ordinary-child entry, and reuse the original operation without more writes. The existing authoring adapter's `repairOnly` option selects this same stage for focused verification; it is not a separate service or a real Notion claim.

For AH-498 shared-library work, follow [shared SSOT verification](../features/shared-ssot.md), cases SS01–SS13. Drive `ctl library` and root `list/read/files` through helper `cli`; the existing References import/consumption harness does not prove the shared layout. Include fixed `--manifest` registration, read-only migration review and Router Members when those paths change. Record current-body, retained-body, metadata, write and provider costs separately. Keep unfinished original-operation state until reconciliation; a recipe or selected test count is not epic completion.

For Broker missing-reference changes, follow [the consumption boundary recipe](../features/broker-consumption.md#missing-reference-boundary). Broker soft misses preserve ordinary user text; this does not change CLI error JSON or genuine selected-record access/integrity failures. Host/provider acceptance belongs to the separate Broker recipes, not a CLI-only pass.

This is a developer/regression workflow. Daily work uses current reads, one pinned `apply`, and the four-table `ctl library sources` commands for source definitions, checks and updates. Follow the returned original-operation route after interruption. A verified substep does not establish completion of its parent task; inspect the complete result and its per-item effects. Do not run the detailed matrix or repeat per-file/export checks for every imported Skill. Use them when developing the CLI, diagnosing a discrepancy or fulfilling an explicit audit request. Retained `ctl sync` procedures apply only to their explicitly identified older local/upstream bindings, never as the new-library route.

## Accepted design and readiness

The [sync/cache CLI design](../../../../docs/sync-cache-cli-design.md) is implemented. The [command coverage map](../features/README.md#accepted-design-coverage) connects implemented entries to their acceptance cases; [protocol](../../../../docs/protocol.md) owns executable semantics. Consult actual command help before driving an entry point and record each exercised result separately.

The [shared architecture](../../../../docs/shared-ssot-architecture.md) defines library ownership, fixed sources and recovery boundaries. First-plan unknown outcomes that are invisible to an independent client remain a limitation. Do not claim shared write safety from timestamps, page locks, stable IDs or read-after-write. Source-build passes do not establish a production migration, release, second physical machine, native UI or model behavior.

Shared command claims need their exact boundaries: manifest registration uses zero provider requests but still verifies Notion facts; migration output is always `apply_allowed:false`; Router snapshots freeze member metadata while member bodies remain lazy. New init registers native Members and Requires. Existing libraries upgrade through the explicit relations plan/apply/reconcile commands; old missing Members bindings still fail Router consumption explicitly. Ordinary Skills may expose member directories, and neither directory fetches target bodies. Transport checks exercise service-local coalescing, default-four permits and the original five-minute permit/SQL admission deadline independently of network timeouts. Keep controlled cancellation/timeout evidence separate from live elapsed samples.

The [sync/cache verification plan](../features/sync-cache-verification-plan.md) separates deterministic regressions, real Notion readback and installed Node.js proof. It covers bindings/common bases, checked plans, real symlink targets, TTL/identity scopes and unknown outcomes. Core tests provide controlled clocks and real-link fixtures; the helper isolates product config/state/cache for live command evidence.

SC12 covers current/directory qualification and known 401-scope / 403-target denial before fixed local/retained reads. Explicit offline preserves old facts, while clear and late publishers cannot grant access; 404/disabled do not revoke historical authority. SC15 uses the existing [request-engine map](../features/request-engine.md#sc15-消费请求共享与预算) for waiter budgets, cancellation and dispatch/arrival evidence. The installed SDK smoke records `cache-*` phases alongside its existing scalar-inventory case; synthetic clocks, loopback HTTP, live Notion and actual Pi remain separate proof layers.

The [shared HTTP fixture recipe](../features/skill-consumption.md#共用受控-http-来源与终局字节账本) reuses that scalar service in the installed SDK smoke and the Broker's actual Pi driver. Keep the original 22 SDK cases and 32 cache phases, retain incomplete response bytes as unknown, and bind each frozen helper and input before any controlled delay, denial, retry or abort. Fixture controls exercise transport behavior; they do not manufacture SDK or model results.

For origin changes, follow the feature map's source-provenance row and publication/discovery recipes. Retain raw Notion schema/property readback separately from unchanged public record JSON. A repeated already-published attach, metadata-only update and mutation-free complete reuse require distinct evidence. These recipes claim no new live pass.

Consumer metadata identity is covered by C20 in that plan. `ctl cache identity --database SELECTOR` identifies credentials and the remote catalog, excluding cwd, command spelling, local preferences, cache policy and sync bindings. Equivalent database selectors share identity. Use the [Broker consumption map](../features/broker-consumption.md) for actual Pi/OMP cross-project shared-catalog/export and active-session snapshot acceptance; CLI-only proof cannot establish those host behaviors.

Select cases affected by the change and record each outcome/evidence path outside the checkout. A routine offline read does not require a live migration or the whole matrix. Full feature acceptance requires its negative/recovery cases and installed-consumer path, not just one successful push. Instruction changes also need a separate fresh-session evaluation of agent use before claiming the Skill improved agent behavior.

The exact-ID `builtin` catalog contains three independently managed package Skills: `notion/ntn-skills` for discovery/consumption/routing, `notion/ntn-skills-maintain` for Notion content maintenance and `notion/ntn-skills-sync` for ongoing synchronization/recovery. The [package recipe](../features/portable-export-package-consumption.md) covers every main/reference/export byte and provenance; the [publication recipe](../features/import-create-recovery-dry-run.md) covers first-publish collisions, exact-target updates and readback; the [configuration recipe](../features/discovery-config-auth-doctor.md) covers the independent publication preference. Installed consumer evidence records `builtins`, including `additional_skills` for entrypoint and sync. Publishing a real remote copy still requires the task's selected database and write authorization.

The [built-in management recipe](../features/builtin-management.md) covers XDG central installation, default shared/optional Agent links, complete-file baselines, local modification and foreign-target protection, receipt-v1 preservation and migration-required fences, idempotency, interruption and installed Node.js consumption. Its source map separates native Effect distribution, tree/handle and transaction owners from the external receipt-v1 migration artifact. Broker links route ordinary `$...@builtin` discovery and loading on Pi/OMP/Tern separately; packaged bodies and references do not require central installation. Explicit local-copy management and historical migration cases apply only when those behaviors change. Source/package CLI success does not establish host reload or model consumption.

