---
name: verify-ntn-skills
description: "Verify ntn-skills source and installed Node.js CLI behavior: shared Notion libraries, whole-file ownership, fixed manifests, archived snapshots, Router members, read-only migration plans, request budgets, builtin management, References, recovery and broker consumption. Retain exact entrypoint evidence and distinguish live CLI, installed package, host and model acceptance."
---

# Verify ntn-skills

AH-617 消费链重构先读 [Skill 消费链](features/skill-consumption.md)。SC-VERIFY-01～03 将本 CLI 的真实消费、成本证据与清理边界接到 Broker 的 SC01–SC26 统一地图；SC25 通过 list/read/use 和 SDK 目录入口取证，SC26 负责真实 Pi 与常规 check/CI 接线。新架构、模型投影和日用安装分别取证。未执行的规程仍为 draft，不沿用 AH-561 的历史 pass。

AH-561 直连请求与跨 Skill 图使用 [request-engine](features/request-engine.md) 和 [skill-dependency-graph](features/skill-dependency-graph.md)。先执行 NG-VC-01 离线契约与原生 CLI fail-before，保存两条根选择提示和独立 oracle 合同；后续按 NG-RE/NG-SG feature ID 逐项复验。当前 helper 使用项目 HTTP 引擎、项目凭据和 owned 归档入口。每轮交付需重新取得服务与安装证据；保留历史回执，不把旧单 Skill pass 用作图验收。

图专项由 Broker 仓库的 `scripts/verify-skill-graph-contract.mjs` 共用一个离线检查入口；不新增第三个总验收 Skill。它只驱动当前 Node CLI 的离线 version/schema，绝不读取业务正文、请求生产 API 或调用官方 ntn。`contract-valid` 只说明证据合同成立，不能代替真实 Notion、Pi、模型、UI 或安装包验收。

The primary surface is the JSON CLI. Use the repository's TypeScript dev entrypoint for live Notion operations and its existing npm consumer smoke for the built Node.js package. Read [the feature map](features/README.md) first; a passing convenient path does not prove the other mapped entrypoints.

The same package smoke also drives the [shared author lifecycle](features/import-create-recovery-dry-run.md#independent-installed-author-lifecycle) through an independently installed Node bin and an owned loopback service: create/readback, body-only write, sparse metadata update, apply/replace, old pins and an actually lost original-outcome response. Keep its command/HTTP ledger and strict negative cases separate from seeded offline snapshots and real Notion authorization. The fixture service reuses existing core fixtures; it never writes consumer state to manufacture a result.

For AH-498 shared-library work, follow [shared SSOT verification](features/shared-ssot.md), cases SS01–SS13. Drive `ctl library` and root `list/read/files` through helper `cli`; the existing References import/consumption harness does not prove the shared layout. Include fixed `--manifest` registration, read-only migration review and Router Members when those paths change. Record current-body, retained-body, metadata, write and provider costs separately. Keep unfinished original-operation state until reconciliation; a recipe or selected test count is not epic completion.

For Broker missing-reference changes, follow [the consumption boundary recipe](features/broker-consumption.md#missing-reference-boundary). Broker soft misses preserve ordinary user text; this does not change CLI error JSON or genuine selected-record access/integrity failures. Host/provider acceptance belongs to the separate Broker recipes, not a CLI-only pass.

This is a developer/regression workflow. Daily work uses current reads, one pinned `apply`, and `ctl sync upstream/local connect` followed by `run`. For an authorized ordinary content change, exit 0 with `ok: true`, `verified: true` and no `dry_run: true` is sufficient; the CLI owns saved-content readback. Do not run the detailed matrix or repeat per-file/export checks for every imported Skill. Use them when developing the CLI, diagnosing a discrepancy or fulfilling an explicit audit request.

## Accepted design and readiness

The [sync/cache CLI design](../../../docs/sync-cache-cli-design.md) is implemented. The [command coverage map](features/README.md#accepted-design-coverage) connects implemented entries to their acceptance cases; [protocol](../../../docs/protocol.md) owns executable semantics. Consult actual command help before driving an entry point and record each exercised result separately.

The [shared architecture checkpoint](../../../docs/shared-ssot-architecture.md) records the new layout's partial implementation and evidence. First-plan unknown outcomes that are invisible to an empty independent client remain an open boundary. Do not claim shared write safety from timestamps, page locks, stable IDs or read-after-write. Source-build passes do not establish a production migration, release, second physical machine, native UI or model behavior.

Shared command claims need their exact boundaries: manifest registration uses zero provider requests but still verifies Notion facts; migration output is always `apply_allowed:false`; Router snapshots freeze member metadata while member bodies remain lazy. New init registers native Members and Requires. Existing libraries upgrade through the explicit relations plan/apply/reconcile commands; old missing Members bindings still fail Router consumption explicitly. Ordinary Skills may expose member directories, and neither directory fetches target bodies. Transport checks exercise service-local coalescing, default-four permits and the original five-minute permit/SQL admission deadline independently of network timeouts. Keep controlled cancellation/timeout evidence separate from live elapsed samples.

The [sync/cache verification plan](features/sync-cache-verification-plan.md) separates deterministic regressions, real Notion readback and installed Node.js proof. It covers bindings/common bases, checked plans, real symlink targets, TTL/identity scopes and unknown outcomes. Core tests provide controlled clocks and real-link fixtures; the helper isolates product config/state/cache for live command evidence.

SC12 covers current/directory qualification and known 401-scope / 403-target denial before fixed local/retained reads. Explicit offline preserves old facts, while clear and late publishers cannot grant access; 404/disabled do not revoke historical authority. SC15 uses the existing [request-engine map](features/request-engine.md#sc15-消费请求共享与预算) for waiter budgets, cancellation and dispatch/arrival evidence. The installed SDK smoke records `cache-*` phases alongside its existing scalar-inventory case; synthetic clocks, loopback HTTP, live Notion and actual Pi remain separate proof layers.

For origin changes, follow the feature map's source-provenance row and publication/discovery recipes. Retain raw Notion schema/property readback separately from unchanged public record JSON. A repeated already-published attach, metadata-only update and mutation-free complete reuse require distinct evidence. These recipes claim no new live pass.

Consumer metadata identity is covered by C20 in that plan. `ctl cache identity --database SELECTOR` identifies credentials and the remote catalog, excluding cwd, command spelling, local preferences, cache policy and sync bindings. Equivalent database selectors share identity. Use the [Broker consumption map](features/broker-consumption.md) for actual Pi/OMP cross-project shared-catalog/export and active-session snapshot acceptance; CLI-only proof cannot establish those host behaviors.

Select cases affected by the change and record each outcome/evidence path outside the checkout. A routine offline read does not require a live migration or the whole matrix. Full feature acceptance requires its negative/recovery cases and installed-consumer path, not just one successful push. Instruction changes also need a separate fresh-session evaluation of agent use before claiming the Skill improved agent behavior.

The exact-ID `builtin` catalog contains three independently managed package Skills: `notion/ntn-skills` for discovery/consumption/routing, `notion/ntn-skills-maintain` for Notion content maintenance and `notion/ntn-skills-sync` for ongoing synchronization/recovery. The [package recipe](features/portable-export-package-consumption.md) covers every main/reference/export byte and provenance; the [publication recipe](features/import-create-recovery-dry-run.md) covers first-publish collisions, exact-target updates and readback; the [configuration recipe](features/discovery-config-auth-doctor.md) covers the independent publication preference. Installed consumer evidence records `builtins`, including `additional_skills` for entrypoint and sync. Publishing a real remote copy still requires the task's selected database and write authorization.

The [built-in management recipe](features/builtin-management.md) covers XDG central installation, default shared/optional Agent links, complete-file baselines, local modification and foreign-target protection, receipt-v1 preservation and migration-required fences, idempotency, interruption and installed Node.js consumption. Its source map separates native Effect distribution, tree/handle and transaction owners from the external receipt-v1 migration artifact. Broker links route ordinary `$...@builtin` discovery and loading on Pi/OMP/Tern separately; packaged bodies and references do not require central installation. Explicit local-copy management and historical migration cases apply only when those behaviors change. Source/package CLI success does not establish host reload or model consumption.

## Launch

Run from the checkout root. Development requires Bun 1.4.3, installed dependencies and Node.js 22.22.3+ within 22.x or 24.20.0+. Live authentication uses the inherited `NOTION_API_TOKEN` through the project's credential provider. Confirm that its authorization identity matches the intended saved project token before isolating config; report only the match boolean. Do not print credentials or copy personal configuration into a run.

```bash
bun install --frozen-lockfile
bun run build
RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-verification-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
```

There is no persistent server, browser, port, or PTY. `init` returning `ready:true` establishes an owned run with private `scratch/config`, `scratch/state`, `scratch/cache`, `scratch/data`, `scratch/builtin-home` and a separate `evidence` directory. The helper overrides application roots plus XDG config/state/cache/data bases. Offline builtin commands use an owned HOME for default links. Credentials remain inherited in process; no secret is copied. Each source drive uses `scripts/dev.ts` to build the formal entry afresh and execute it with Node.js, then waits for its exit. Installed consumption uses the exact npm bin supplied with `--installed-bin`. The shared request scheduler stays independent of content roots. Live runs targeting the same Skill require one writer; controlled concurrency uses designated fixtures. Finish with Cleanup after preserving evidence and resolving original operations that still depend on scratch recovery state.

The overrides isolate driven product processes. Bun can create its own transpiler cache before this helper starts, using the launcher's inherited XDG cache. For strict host-sentinel checks, give the parent Bun process a separate owned temporary `XDG_CACHE_HOME` outside the empty run root and record it for system-trash cleanup. Do not create that launcher cache inside the run before `init`; `init` requires an empty owned root. Distinguish launcher writes from product writes in evidence.

## Doctor

Harness discovery is offline and does not initialize a run:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts --help
```


```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
```

The default helper Doctor checks the real source CLI version/help, hashes its entrypoint, and records the owned config/state/cache/data roots without contacting Notion. `ready:true` proves offline readiness only. To probe live authentication, run `bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN" --live`; add `--database ID` to inspect one catalog and read a Skill. Require `live.transport=direct_http`, `live.notion_api_version=2026-03-11` and `live.authentication=available`. With a database, inspect coverage and skill_read. Explicit scoped `consumption` separately proves exhaustive coverage and exact page or shared Library/Skill identities. Missing prerequisites remain blocked; offline fixtures never prove online health.

## Drive

For a complete package-consumption path using the existing harness:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts package --run "$RUN"
```

This delegates the existing package checker, which builds and packs the independent migration/operator artifact and passes its archive to consumer smoke with `--migration-archive`. Its operator entry retains historical actions outside daily help/schema; it is not a prerequisite for current reads, pinned apply or connect/run. Smoke installs the normal CLI and migration tool separately, imports the historical fixture through the migration executable, then drives the installed CLI with Node.js. It checks offline snapshot consumption, relative/ranged reads, file listing, export reuse, configuration sanitization and corruption rejection. The seeded snapshots are fixtures for the offline contract, not proof of a live import.

CI runs `init/package` on Ubuntu and macOS 15 with Node.js 22.22.3 and 24.20.0, after the full deterministic suite. Package mode retains `installed-consumer.json` and both integrity-checked tarballs under evidence before scratch retirement. macOS CI exercises system Trash and cleanup; Linux verifies the explicit unavailable-retention error and unchanged cache bytes, then retains scratch on the disposable runner. CI uploads per-matrix evidence for seven days. See [Contributing](../../../CONTRIBUTING.md#development-setup).

The historical read-only migration inventory collector specifically requires Node.js 24. Its successful input/backup contract runs there; other Node runtimes run the explicit `NODE_24_REQUIRED` rejection and pure argument tests. This collector boundary does not remove the CLI/SDK's supported Node.js 22 product gate.

For the CLI contract consumed by the broker source adapter provided in the separate pi-context-broker repository, read [broker consumption](features/broker-consumption.md). Run the existing public list/read/files/export path without remote writes:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts consumption --run "$RUN" --database "$DATABASE"
INSTALLED_BIN="$(jq -er '.smoke.executable' "$RUN/evidence/package.json")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts consumption --run "$RUN" --database "$DATABASE" --target "$PAGE_ID" --installed-bin "$INSTALLED_BIN"
```

Bind `DATABASE` to the actual selected database; obtain `PAGE_ID` from the source catalog or dedicated fixture receipt. Optional `--target` requires a real page ID in that catalog. Consumption requires complete explicit-database coverage, matches read scope to discovery, retains pinned IDs, inspects manifest `main` against export `main_path`, verifies actual files, output reuse/conflict protection and offline reread. Source and installed modes record separate evidence. Package smoke separately covers synthetic credential-scope isolation and a portable non-SKILL.md entry. Neither proves broker host registration/default-catalog/Read/native-command behavior. The separately authorized broker integration helper owns real fixture create/reference/resource/cleanup receipts and runs cleanup in `finally`; avoid creating a second lifecycle here.

The [broker consumption map](features/broker-consumption.md) routes independent Pi/OMP real-model discovery/read/resource consumption to `verify-notion-integration.mjs --mode model`, Pi terminal completion to its dedicated procedure, and daily Tern/OMP installation/menu acceptance to `verify-daily-notion-ui.mjs` in the broker repository. Keep live CLI, installed host, controlled provider and real model observations separate; a source checkout smoke does not establish a user's daily menu or actual model response.

To drive any actual source CLI command and capture its response:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config show
```

The wrapper returns the CLI's `exit` and an evidence path. Inspect `exit`; expected failure paths are not wrapper failures. It never reads stdin and rejects `ctl config set-token`; authentication precedence through `set-token --stdin` must be exercised directly in an isolated CLI environment, without recording credential input.

For the authorized live migration, bind `DATABASE` and `SKILL_DIR` to the database and source directory selected for that task. The helper requires concrete values and does not select a target or grant authorization. Generate an import plan with frozen source hashes, then drive the same plan through import, consumer verification and reuse:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts prepare --run "$RUN" --database "$DATABASE" --input "$SKILL_DIR"
IMPORT_PLAN="$RUN/evidence/plan.json"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts import --run "$RUN" --plan "$IMPORT_PLAN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts verify --run "$RUN" --plan "$IMPORT_PLAN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts reuse --run "$RUN" --plan "$IMPORT_PLAN"
```

Repeat `--input` in `prepare` for several Skill directories. An existing frozen plan may instead be passed directly; its exact shape is `{database,entries:[{name,input,files,file_hashes:[{path,bytes,sha256}]}]}`. `input` is absolute; paths are relative. Plans contain no credentials or machine defaults in the committed Skill.

`IMPORT_PLAN` is this helper's frozen References import input, not a product sync plan or shared migration evidence. Product `SYNC_PLAN_ID`/`SYNC_PLAN_FILE` belongs to `ntn-skills ctl sync local apply`; shared `MIGRATION_INPUT` belongs to `ctl library migration plan --input`. Pass those product arguments through helper `cli -- ...`; outer helper `--plan` still accepts only the References import schema. Live import/verify/reuse readbacks explicitly refresh current targets before claiming fresh remote state; pinned reads retain their fixed versions.

`prepare` uses the existing input/portable parsers to determine the invocation name, refreshes the selected catalog, then dry-runs `create` for an absent name or `replace --target PAGE_ID` for an existing exact identity. Helper `import` records the catalog and existing version before/after that dry-run, then performs the explicitly authorized command. It checks that dry-run leaves remote state unchanged; dry-run still reads the network and creates local caches. `verify` freshly enumerates every legacy References page through `files --refresh`, enumerates child pages through the same CLI's read-only `ctl api`, checks References paths/IDs from the immutable snapshot manifest, reads pinned main/reference files, reads a supporting asset where present, and exports every source file with SHA-256 equality. Mutable product state is accessed through the CLI and its SQL store. The automated live recipe requires a References library with optional Files enabled to preserve arbitrary assets and exact source bytes. Page-only, ZIP/single-Markdown, individual write and conflict paths use their mapped CLI recipes.

`reuse` runs `replace --target PAGE_ID` and requires `action:reuse`, `reused:true`, identical page and snapshot IDs, then checks exhaustive catalog coverage and one row per invocation. It writes `evidence/summary.json`. Completed entries within a healthy run are checkpointed. Interrupted publications retain `operation_id` and `receipt_path`; within the original authorization, `cli -- operation resume OPERATION_ID --progress` validates recorded state and continues frozen input on fixed IDs. `receipt_path=sqlite:publications/ID` is a database locator, not a JSON file. Preserve scratch recovery state until this is resolved. External edits conflict; unproven creation remains unresolved without replay. Record safe progress JSONL separately when needed because this helper retains stderr metadata only.

## Evidence

Proof survives at `$RUN/evidence/`:

- `commands/*.json`: exact argv, timestamps, cwd, held child PID, observed exit/signal, timeout and CLI output. Raw child stderr is excluded; its size and SHA-256 are recorded instead.
- `doctor.json`, `package.json`, frozen `plan.json` and dry-run observations.
- `installed-consumer.json` and `package/*.tgz`: original seeded consumer outputs, the integrity-checked public CLI tarball and independent migration tarball, copied before package scratch cleanup. `package.json` records both original archive/integrity pairs and retained archive paths.
- `consumption-source.json`, `consumption-installed.json`, their directory exports/portable manifests/hash inventories and recorded scope/freshness/page/version/snapshot identities. Dedicated live fixture create/cleanup receipts belong to the broker integration helper.
- `imports.json`, `verification.json`, `reimports.json`, child-page ID inventories and `final-catalog.json`.
- `exported/`, `read-assets/`, `summary.json`, failure and cleanup receipts.
- For sync/cache acceptance: case ledger, imported fixture manifest, before/after baseline generations, plan/receipt copies, logical/resolved path and link proof, freshness observations and measured performance samples. Preserve these before scratch cleanup; do not claim missing artifacts or inject private state to manufacture a live result.
- For shared-library acceptance: descriptor and stable identities, complete cursor coverage, original plan IDs, before/after body hashes, current and shared pin identities, fixed source manifests, frozen Router member metadata, read-only migration inputs/results, `request_metrics`, exact archive/restore inventories and source-build versus installed-runtime provenance. Keep failed and unrun cases in the same ledger; mark controlled fixtures separately from real Notion and physical-machine evidence. Mini connectivity and independent authentication are available, but its older installed 0.3.0 does not prove the candidate package; preserve the candidate's separate installation and verification status.

Capture both action and resulting state. A successful write response alone is insufficient: reopen through the user-facing CLI, verify page identity/content and file side effects. Do not call internal setters, mutate cache objects for live proof, introduce REST transport substitutes, or execute imported scripts. Test fixtures remain explicitly scoped to offline package proof. Evidence may contain private Skill contents and page IDs; keep it outside the checkout and do not commit it. CLI JSON excludes credentials and signed URLs. Request evidence uses the engine's bounded safe `request_metrics.trace`; absent or truncated metrics cannot prove zero calls.

## Cleanup

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
test -f "$RUN/evidence/cleanup.json"
```

On macOS the helper moves its owned local scratch and recorded package scratch to `/usr/bin/trash`; it never permanently removes files. On other hosts it stops with an explicit recycle-bin prerequisite and retains scratch until a system recycle path is verified. Cleanup preserves the evidence directory and retained Notion Skills. It never archives/deletes remote pages automatically. A disposable remote fixture requires task authorization and a recorded page ID before explicit trashing. Never kill by process name; the helper terminates only children it spawned on its own timeout, with no background service to stop.

Run cleanup after failures once no unresolved original operation depends on the run's scratch state. Preserve that state and its exact run path while a write is unknown; do not clear dispatch records, invent a new operation or treat cleanup as recovery. Verify the evidence remains after cleanup before calling the exercised cases proven. Fix the failed recipe and use a fresh run rather than reusing a cleaned state directory. A separate fresh-session instruction evaluation is still required to claim the Skill itself proven.

## Helpers

The executable helper is [scripts/control.ts](scripts/control.ts). All invocations above use Bun for the development harness. Every source and installed product subprocess uses Node.js. Package mode reuses `scripts/package-check.ts`, including its independent migration build/pack and required `--migration-archive` forwarding to `scripts/package-smoke.ts`. Modes are `init`, `doctor`, `cli`, `package`, `consumption`, `prepare`, `import`, `verify`, `reuse`, and `cleanup`. Helper `import` is orchestration over public `create`/`replace`; the product has no `import` or `open` command. `consumption --installed-bin` launches the actual npm package's declared JavaScript bin with Node.js.

Keep feature recipes, command-to-case coverage and the accepted design current together when observable behavior changes. Use `/maintain-verification-skill` for the maintenance loop; report exact exercised cases and leave unavailable branches/instruction evaluations explicitly unrun.
