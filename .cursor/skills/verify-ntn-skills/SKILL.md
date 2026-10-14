---
name: verify-ntn-skills
description: "Drive the ntn-skills source and installed Node.js CLI for import, References, snapshots, export, recovery and package verification; maintain accepted sync/cache acceptance coverage while distinguishing implemented behavior from design."
---

# Verify ntn-skills

The primary surface is the JSON CLI. Use the repository's TypeScript dev entrypoint for live Notion operations and its existing npm consumer smoke for the built Node.js package. Read [the feature map](features/README.md) first; a passing convenient path does not prove the other mapped entrypoints.

## Accepted design and readiness

The [sync/cache CLI design](../../../docs/sync-cache-cli-design.md) is implemented. The [command coverage map](features/README.md#accepted-design-coverage) connects implemented entries to their acceptance cases; [protocol](../../../docs/protocol.md) owns executable semantics. Consult actual command help before driving an entry point and record each exercised result separately.

The [sync/cache verification plan](features/sync-cache-verification-plan.md) separates deterministic regressions, real Notion readback and installed Node.js proof. It covers bindings/common bases, checked plans, real symlink targets, TTL/identity scopes and unknown outcomes. Core tests provide controlled clocks and real-link fixtures; the helper isolates product config/state/cache for live command evidence.

Select cases affected by the change and record each outcome/evidence path outside the checkout. A routine offline read does not require a live migration or the whole matrix. Full feature acceptance requires its negative/recovery cases and installed-consumer path, not just one successful push. Instruction changes also need a separate fresh-session evaluation of agent use before claiming the Skill improved agent behavior.

## Launch

Run from the checkout root. Development requires Bun 1.4.3, installed dependencies, Node.js >=22.19.0, and the official `ntn` executable for online operations. An existing inherited `NOTION_API_TOKEN` or official `ntn` login supplies live authentication. Do not print credentials or copy personal configuration into a run.

```bash
bun install --frozen-lockfile
bun run build
RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-verification-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
```

There is no persistent server, browser, port, or PTY. `init` returning `ready:true` establishes an owned run with private `scratch/config`, `scratch/state`, `scratch/cache`, and a separate `evidence` directory. The helper overrides all application roots plus XDG config/state/cache bases under scratch; HOME is unchanged. Each drive launches a short-lived CLI with argument arrays and waits for its exit. The helper derives this checkout from its own location, removes `NTN_SKILLS_NTN_BIN` overrides, and inherits the host's ordinary network settings. Local runs can coexist; ordinary live runs targeting the same Notion Skill require a single writer. Controlled multi-process cases use designated fixtures. Finish with Cleanup, including after failures.

The overrides isolate driven product processes. Bun can create its own transpiler cache before this helper starts, using the launcher's inherited XDG cache. For strict host-sentinel checks, give the parent Bun process a separate owned temporary `XDG_CACHE_HOME` outside the empty run root and record it for system-trash cleanup. Do not create that launcher cache inside the run before `init`; `init` requires an empty owned root. Distinguish launcher writes from product writes in evidence.

## Doctor

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
```

Require `authentication:available`, the expected `ntn_version`, no `coverage.failed_sources`, and an available `skill_read` when the workspace contains Skills. A workspace without a readable Skill can prove authentication and discovery only. Doctor reads Notion and caches a probe; it does not mutate remote pages or start login. Discovery has no database flag and is search-limited; subsequent explicit `list --database` proves the selected target's exhaustive coverage.

If only offline package behavior is under investigation, run `cli -- --version` instead and explicitly mark live doctor/authentication as unexercised. Never infer online health from offline fixtures.

## Drive

For a complete package-consumption path using the existing harness:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts package --run "$RUN"
```

This packs the existing distribution, installs it with npm in a fresh project, then drives the installed binary with Node.js. It checks offline snapshot consumption, relative/ranged reads, file listing, export reuse, configuration sanitization and corruption rejection. The seeded snapshots are fixtures for the offline contract, not proof of a live import.

CI runs `init/package` on Ubuntu and macOS 15 with Node.js 22.19.0 and 24, after the full deterministic suite. Package mode retains `installed-consumer.json` and the checked tarball under evidence before scratch retirement. macOS CI exercises system Trash and cleanup; Linux verifies the explicit unavailable-retention error and unchanged cache bytes, then retains scratch on the disposable runner. CI uploads per-matrix evidence for seven days. See [Contributing](../../../CONTRIBUTING.md#development-setup).

To drive any actual source CLI command and capture its response:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config show
```

The wrapper returns the CLI's `exit` and an evidence path. Inspect `exit`; expected failure paths are not wrapper failures. It never reads stdin and rejects `config set-token`; authentication precedence through `set-token --stdin` must be exercised directly in an isolated CLI environment, without recording credential input.

For the authorized live migration, bind `DATABASE` and `SKILL_DIR` to the database and source directory selected for that task. The helper requires concrete values and does not select a target or grant authorization. Generate an import plan with frozen source hashes, then drive the same plan through import, consumer verification and reuse:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts prepare --run "$RUN" --database "$DATABASE" --input "$SKILL_DIR"
IMPORT_PLAN="$RUN/evidence/plan.json"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts import --run "$RUN" --plan "$IMPORT_PLAN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts verify --run "$RUN" --plan "$IMPORT_PLAN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts reuse --run "$RUN" --plan "$IMPORT_PLAN"
```

Repeat `--input` in `prepare` for several Skill directories. An existing frozen plan may instead be passed directly; its exact shape is `{database,entries:[{name,input,files,file_hashes:[{path,bytes,sha256}]}]}`. `input` is absolute; paths are relative. Plans contain no credentials or machine defaults in the committed Skill.

`IMPORT_PLAN` is this helper's frozen migration input, not a product sync plan. Product `SYNC_PLAN_ID`/`SYNC_PLAN_FILE` belongs to `ntn-skills sync apply` and is passed through helper `cli -- ...`; outer helper `--plan` still accepts only the migration schema. Live import/verify/reuse readbacks explicitly refresh current targets before claiming fresh remote state; pinned reads retain their fixed versions.

`import` records the catalog and existing version before/after dry-run, then performs the explicitly authorized mutation. It checks that dry-run leaves remote state unchanged; dry-run still reads the network and creates local caches. `verify` freshly opens every page through the CLI, enumerates child pages through official `ntn`, checks References paths/IDs, reads pinned main/reference files, reads a supporting asset where present, and exports every source file with SHA-256 equality. The automated live recipe requires a References library with optional Files enabled to preserve arbitrary assets and exact source bytes. Page-only, ZIP/single-Markdown, individual write and conflict paths use their mapped CLI recipes.

`reuse` requires `action:reuse`, `reused:true`, identical page and snapshot IDs, then checks exhaustive catalog coverage and one row per invocation. It writes `evidence/summary.json`. Completed entries within a healthy run are checkpointed. An uncertain mutation response is never retried automatically: inspect the recorded stage/page, read back the remote target, clean up the failed run, and resume explicitly in a new run after reconciling.

## Evidence

Proof survives at `$RUN/evidence/`:

- `commands/*.json`: exact argument array, timestamps, cwd, exit, timeout and CLI output. Raw child stderr is excluded; its size and SHA-256 are recorded instead.
- `doctor.json`, `package.json`, frozen `plan.json` and dry-run observations.
- `installed-consumer.json` and `package/*.tgz`: original seeded consumer outputs and the integrity-checked tarball, copied before package scratch cleanup.
- `imports.json`, `verification.json`, `reimports.json`, child-page ID inventories and `final-catalog.json`.
- `exported/`, `read-assets/`, `summary.json`, failure and cleanup receipts.
- For sync/cache acceptance: case ledger, imported fixture manifest, before/after baseline generations, plan/receipt copies, logical/resolved path and link proof, freshness observations and measured performance samples. Preserve these before scratch cleanup; do not claim missing artifacts or inject private state to manufacture a live result.

Capture both action and resulting state. A successful write response alone is insufficient: reopen through the user-facing CLI, verify page identity/content and file side effects. Do not call internal setters, mutate cache objects for live proof, introduce REST transport substitutes, or execute imported scripts. Test fixtures remain explicitly scoped to offline package proof. Evidence may contain private Skill contents and page IDs; keep it outside the checkout and do not commit it. CLI JSON excludes credentials and signed URLs. Never record raw `ntn -v` output.

## Cleanup

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
test -f "$RUN/evidence/cleanup.json"
```

On macOS the helper moves its owned local scratch and recorded package scratch to `/usr/bin/trash`; it never permanently removes files. On other hosts it stops with an explicit recycle-bin prerequisite and retains scratch until a system recycle path is verified. Cleanup preserves the evidence directory and retained Notion Skills. It never archives/deletes remote pages automatically. A disposable remote fixture requires task authorization and a recorded page ID before explicit trashing. Never kill by process name; the helper terminates only children it spawned on its own timeout, with no background service to stop.

Run cleanup after failures too. Verify the evidence remains after cleanup before calling the Skill proven. Fix the failed recipe and use a fresh run rather than reusing a cleaned state directory.

## Helpers

The executable helper is [scripts/control.ts](scripts/control.ts). All invocations above use Bun, which is the repository's development runtime; consumers remain on Node.js. It reuses `scripts/package-check.ts` and `scripts/package-smoke.ts`, and drives `bun run dev` for the live user path. Modes are `init`, `doctor`, `cli`, `package`, `prepare`, `import`, `verify`, `reuse`, and `cleanup`.

Keep feature recipes, command-to-case coverage and the accepted design current together when observable behavior changes. Use `/maintain-verification-skill` for the maintenance loop; report exact exercised cases and leave unavailable branches/instruction evaluations explicitly unrun.
