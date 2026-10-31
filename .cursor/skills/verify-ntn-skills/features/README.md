# ntn-skills verification map

These recipes describe current executable entry points and are not records of completed acceptance. Sync/cache commands, read policies and exact-target replacement are implemented. Read the matching recipe before driving a feature; preserve command/result evidence and distinguish deterministic, live and installed-consumer proof.

AH-498 shared-library work has its own partial checkpoint. Shared layout, ownership, fixed manifests, exact history restoration, View metadata and Router member indexes have implemented paths, while migration review is read-only. They do not establish production migration, Profile supply, installed host/model behavior or release acceptance. Use the shared recipe and [architecture evidence table](../../../../docs/shared-ssot-architecture.md) instead of carrying forward a legacy pass.

## Sub-features

- [Discovery, configuration, authentication and doctor](./discovery-config-auth-doctor.md): help, database/catalog discovery, local preferences and connection diagnostics.
- [Snapshots, reading, files and relative resolution](./snapshot-read-open-files-resolve.md): current online content, immutable local versions and exact file output.
- [Shared Notion SSOT](./shared-ssot.md): `ctl library`, flat Files metadata, whole-file adoption, fixed Git/manifest registration, shared archive/restore, read-only migration review, Router member indexes, original unknown operations and request budgets. Source-built CLI, installed package, independent machines and UI/model evidence remain separate.
- [Create, replace, dry-run and recovery](./import-create-recovery-dry-run.md): selected local inputs, explicit create/replace decisions and uncertain outcomes; [pinned changes](./reference-write-version-conflict.md) cover daily `apply`.
- [Pinned changes, reference pages and version conflicts](./reference-write-version-conflict.md): one `apply` for sparse file/property changes, lower-level file writes and stale-baseline rejection.
- [Portable export and package consumption](./portable-export-package-consumption.md): reversible exports and the built npm package boundary.
- [Broker consumption](./broker-consumption.md): metadata-only scope/coverage discovery, selected-page activation, fixed directory materialization, actual manifest entrypoint, output protection and installed/offline credential isolation. Routes to independent Pi/OMP real-model consumption, Pi terminal selection and daily Tern/OMP installation/menu verification in the broker repository.
- [Bidirectional sync and read-cache verification plan](./sync-cache-verification-plan.md): acceptance cases for the [implemented CLI design](../../../../docs/sync-cache-cli-design.md), including common bases, real targets, TTL, batch plans, conflicts and recovery. Case execution is recorded in the external run ledger.
- [Built-in Skill management](./builtin-management.md): offline bundled instructions and optional explicit central installations, shared/Agent links and local-update protection; ordinary host selection belongs to the linked broker runners.
- [Upstream subscriptions](./upstream-subscriptions.md): `sync upstream connect` and recurring `run`, with advanced registration/check/plan/apply and original-operation recovery.
- AH-255 baseline: installed CLI `consumption --installed-bin` → real selected database read/pinned export; broker integration `--mode live-fixture --command-json '["node","ABSOLUTE_INSTALLED_CLI"]' --extension ABSOLUTE_INSTALLED_BROKER` → independent Pi/OMP consumption of the owned fixture and its resource. Real Pi terminal uses broker `scripts/verify-pi-pty.mjs`; Tern/OMP input uses `verify-native-ui.mjs --notion`. These are executable routes, not completed acceptance; this historical AH-255 baseline does not replace the current Router/Prompt/upstream recipes.

## Accepted design coverage

Command/parameter semantics belong to the [protocol](../../../../docs/protocol.md); the [CLI design](../../../../docs/sync-cache-cli-design.md) records rationale, and the [verification matrix](./sync-cache-verification-plan.md) owns case definitions and evidence requirements. Case IDs are stable lookup keys, not test counts or pass results.

| Entry or boundary | Cases | Required proof |
| --- | --- | --- |
| `ctl library init/inspect/files/state` and shared catalog/View identity | SS01–SS03, SS10 | [Shared recipe](shared-ssot.md): exact descriptor/property IDs, default new-library Members self-relation, read-only original-init recovery, complete flat metadata and native View membership; no body/provider work for metadata commands |
| Shared current `read`, `files`, whole-file adoption and `--metrics` | SS03–SS06 | Complete snapshot, persistent custom ownership, unchanged-body zero writes, bounded full verification, original-plan reconciliation and explicit open first-write boundary |
| Notion in-flight reads, attempt concurrency and admission | SS05–SS06 | Service-local coalescing and cancellation, unset/empty default 4, integer cap 1–64, permit plus SQL wait under the original five-minute deadline, independent network timeout and no mutation coalescing/retry |
| `ctl library source inspect/register`, including `--manifest` | SS07 | Fixed commit/tree/root and scoped manifest; full inspect JSON or bare manifest registers with zero provider work and rejects URL/commit/root mixing; candidate registration does not imply source selection or projection |
| `ctl library snapshot save/restore` | SS08–SS09 | Frozen exact bytes, chunks before manifest, original archive identity, independent empty-state restore, missing/corrupt-history refusal and current access checks |
| Shared independent install, physical machines and host/model acceptance | SS11 | Separate candidate-package and two-machine evidence, native UI and actual model consumption; mini SSH/auth is available with older 0.3.0 installed, while candidate installation/verification remains unrun |
| `ctl library migration plan --input` | SS12 | Frozen approved scope, complete preservation evidence and deterministic reviewable/blocked plan; `apply_allowed:false`, no cleanup, no unresolved-operation replay or implied production authorization |
| Shared Router current and fixed snapshot reads | SS13 | Registered Members identity, full relation/batched metadata, same-library enabled Skills, stable-ID conflict rejection, frozen index with lazy member bodies and offline rejection of incomplete historical Router snapshots |
| `sync local connect`, advanced `bind`, initial source choice and duplicate labels | S1–S2, S14, P2, P10 | Repeated same-edge reuse; automatic pull for a missing directory; explicit source for existing differing contents; dry-run/config and page identity checks |
| `sync local status`, `status --refresh` | C17, S9 | Local-only observation stays provisional; online refresh does not advance any common base |
| `sync local plan`, explicit `--from`, `--output` | S3–S8, P3–P4, P9 | Checked identities/directions, immutable plan copy, rejected conflicts and stale-plan state preservation |
| `sync local plan --all`, shared page/real destination | S9–S10, S15, R7 | Distinct-candidate rejection, one accepted remote update, independently verified local fan-out/bases |
| `sync local run`, advanced `apply --plan` by ID/file | S3–S7, S11–S13, L1–L7, P4 | One checked plan and verified convergence; retained receipts settle only on confirmed observations; rejected content/link drift preserves both sides |
| `operation reconcile OPERATION_ID`, `sync local unbind` | R1–R7, P6, P8, P10 | Restart/readback before replay decision; truthful partial outcomes; content/baseline/receipt retention |
| Pinned `apply`, full-input `replace --target` and existing write preconditions | P5, C12–C13, S8, write-properties, write-conflict | One publication preserves page identity and untouched files while combining sparse files/removals/properties; stale pins, main deletion and missing/non-main targets fail before effects |
| File-only `write` and property-only `update` | write-properties, write-conflict | [Write recipe](reference-write-version-conflict.md); frontmatter edits preserve page properties, explicit property flags change only authorized attributes, stale pins reject |
| `read/files/export`, common cache flags | C1–C15, P1, P11 | Controlled TTL/identity failures, complete fixed refs, actual CLI surface and Node.js consumer; export output protection remains covered by its existing recipe |
| `list`, cache scope and discovery coverage | C8–C9, C18, P1, discover-default-context | Offline/refresh behavior retains ambiguity/incomplete coverage and independent catalog age limit; optional checkbox emits a boolean without filtering list or explicit reads, legacy caches default to false |
| `ctl cache status/clear`, XDG and old-state upgrade | C10–C11, C16–C19, P6 | Effective isolated roots and cache-only retirement; failed retention invalidates the entire observation batch while retaining bytes, pinned state, common bases and pending plans |
| `ctl cache identity [--database SELECTOR]`, shared consumer metadata | C20 | Credential/remote-catalog identity is independent of cwd, command spelling, roots and local preferences; equivalent selectors share identity, changed credentials/remote selection isolate it. Broker dual-host proof uses its separate shared-cache route. |
| `ctl config set/unset cache_policy.read_max_age_ms` and `cache_policy.catalog_max_age_ms` | P1, P7 | Offline persisted precedence/integer milliseconds, sanitized config and next-process effective policy |
| Public help/schema/JSON/raw/exit contract | P1, P3, P11 | Offline help and schema agree with the public parser, invalid flags fail before effects, arrays use `items`, progress stays on stderr and failures name a legal next action |
| Broker CLI consumption: `list` → page-ID `read` → fixed `files/export` | broker-list, broker-activate, broker-materialize, broker-output, broker-installed, broker-offline-scope | [Broker consumption map](./broker-consumption.md); actual main_path/manifest files/IDs, reuse/conflict bytes, installed Node and scope-isolation evidence |
| Official `ctl builtin list/read/export` | builtin-catalog, builtin-consumer | [Package recipe](portable-export-package-consumption.md); three exact IDs with independent responsibilities, offline provenance, complete source/reference/export bytes, identical reuse and customized-output protection |
| `ctl builtin publish`, `ctl config set/unset builtin_database` | builtin-publish, builtin-preference | [Publication recipe](import-create-recovery-dry-run.md); first-publication collision rejection, exact-target/pinned updates and fresh readback; [configuration recipe](discovery-config-auth-doctor.md) covers independent preference preservation |
| Publication `--progress`, durable receipts and `operation resume` | import-recovery, publication-progress, publication-pacing | [Publication recipe](import-create-recovery-dry-run.md); frozen input, fixed IDs, external-edit conflicts across process exits/checkpoints/preflight handoff/final readback, complete target-file result replay, unknown-create refusal, JSON stdout/separate stderr, controlled-clock request admission and actual Node CLI recovery |
| Editable UTF-8 file storage | editable-file-consumer, editable-file-recovery | [Publication recipe](import-create-recovery-dry-run.md); complete live files, independent resource consumption, exact-target changes and original-operation recovery |
| `sync upstream connect`, `list`, recurring `run` | upstream-subscriptions | [Upstream recipe](upstream-subscriptions.md); one matching subscription, complete members/resources, array envelope, nonzero partial result, original work continuation and confirmed-Trash recovery |
| `ctl builtin install/update/status`, installation-aware `ctl builtin list` | builtin-managed-install, builtin-managed-update, builtin-managed-conflict, builtin-managed-recovery | [Management recipe](builtin-management.md); central complete receipts and distribution records, shared/optional links, modified-sibling isolation, unmanaged preservation, A-to-B content/resource transition, v1 preservation/migration-required fences, separate external conversion, fiber interruption/handle closure, concurrency and separate host/UI proof |
| Content Source Type / Builtin ID | source-provenance, source-schema-upgrade, source-metadata-reuse, source-frozen-recovery | [Discovery/schema recipe](discovery-config-auth-doctor.md) covers repeated published attaches and legacy compatibility; [publication recipe](import-create-recovery-dry-run.md) covers raw properties, metadata-only update, complete reuse and frozen recovery; [package recipe](portable-export-package-consumption.md) separates remote metadata from trusted package identity |

Historical `ntn-skills-operator` adoption, repair, `publish-files`, rebuild and edit-acceptance recipes belong to the [independent operator artifact](../../../../docs/historical-operations.md). Exercise them when their retained implementation changes; they are not gates or manual preparation for ordinary reads, pinned apply, connect/run or bundled Skill selection.

Controlled-clock fixtures live in core cache tests; real link and commit-interruption fixtures live in sync-local/sync tests. The helper and consumer smoke isolate config/state/cache/data and XDG bases; builtin management also uses an owned HOME for default shared links. Ordinary live acceptance keeps one writer; L7/C14/R7 use controlled concurrency with designated fixtures. Track deterministic, live and installed-consumer results separately, including any unavailable native storage branch.


## How to get to it (user POV)

The user surface is `ntn-skills`, invoked from this checkout through the control helper's `cli` mode. The recipes use the real command names and flags from [main.ts](../../../../packages/cli/src/main.ts), [usage](../../../../docs/usage.md) and [protocol](../../../../docs/protocol.md). Each recipe lists its specific user entry points and observable results.

For the References import workflow, select the authorized database and absolute input directories, then use helper `prepare` to dry-run those inputs and freeze their file hashes into `$RUN/evidence/plan.json`, or select an existing authorized plan. Its `database` selects that Notion database; its entries contain `name`, absolute `input`, `files` and `file_hashes` with `path`, `sha256` and `bytes`. The current six-entry scenario uses the public invocation aliases `open-source-repo-readiness`, `semantic-decompression`, `write`, `hai-audit-docs-against-code`, `github-cicd-bootstrap` and `npm-publish`. Use the selected plan's actual inputs and CLI-returned identities rather than guessing page IDs or refs. Shared libraries use the separate SS01–SS13 recipe through helper `cli`; `prepare/import/verify/reuse` does not establish shared-library acceptance.

## Driving it with control-ntn-skills

Preconditions:

- Run commands from the repository root. `RUN` is the absolute owned run directory; `IMPORT_PLAN` is the helper's frozen References import JSON. Product `SYNC_PLAN_ID`/`SYNC_PLAN_FILE` belongs to `sync local apply`, and shared `MIGRATION_INPUT` to `ctl library migration plan --input`; pass those product arguments after helper `cli --` rather than using the outer helper's `--plan`.
- Bind `DATABASE` to `plan.database`, `INPUT` to a selected entry's absolute input, and `FILE_PATH` to one of that entry's relative files. A local source file is the absolute input directory joined to its relative path. Bind `INPUT_FILE` to that actual file; `TITLE` and `DESCRIPTION` are approved source metadata, not guessed replacements.
- Bind `TARGET`, `REF`, `SNAPSHOT`, `FILE_REF`, `PAGE_ID`, `PAGE_URL` and `SKILL_ALIAS` only from selected CLI results. `REF` and `FILE_REF` are pinned; `TARGET` is the chosen current unpinned selector. Bind `RELATIVE_PATH` to an actual link relative to the containing file. Recipe-specific variables similarly name actual selected files or captured replies.
- Inherited `NOTION_API_TOKEN` or an existing official `ntn` login supplies authentication without copying personal configuration. The helper isolates config/state/cache under `$RUN/scratch` and overrides all XDG bases there; HOME remains unchanged except for offline `ctl builtin` commands. Online work uses the canonical `scripts/dev.ts` fresh build and Node.js execution with official `ntn`, without transport or proxy overrides. Ordinary live acceptance uses one writer per shared page; controlled concurrency cases use designated fixtures.
- For strict filesystem-sentinel runs, isolate the parent Bun launcher's XDG cache in a separate owned temporary directory too. The helper cannot override a transpiler-cache write that happens before its code executes; preserve and clean this launcher directory separately.

Initialize and diagnose:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RUN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts doctor --run "$RUN"
```

Drive each CLI argument array with `bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ...`. Plan-wide acceptance uses the exact helper modes shown in the import recipe. All proof belongs under `$RUN/evidence`: retain command arguments, CLI stdout JSON/text, exit status and resulting state. The helper records stderr metadata only (`bytes`, `sha256`, `raw_retained:false`), never raw or sanitized stderr text. For live writes, include fresh online readback and the selected plan's file/hash comparison; CLI success alone is insufficient. Help/version are text, normal responses are JSON, and exits are 0 for success, 1 for operational failure and 2 for invalid arguments.

Finish with:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cleanup --run "$RUN"
```

Cleanup moves run scratch state and recorded successful package scratch to system Trash, never `$RUN/evidence` or retained user Notion skills. Defer cleanup while unresolved original writes still depend on that scratch state. Confirm evidence remains available after cleanup before reporting a proof.

## Gotchas

- A recipe is not evidence. Record exactly which entry points were exercised and report skipped paths with their unmet prerequisite.
- Dry-run can read the network and populate caches. Compare fresh remote state before and after; remote bodies, properties, reference membership and files must remain unchanged. It does not prove service acceptance.
- `WRITE_PARTIAL` and `WRITE_OUTCOME_UNKNOWN` require readback before deciding on another write. Do not automatically retry mutations or infer failure from a timeout.
- Fixture snapshots used by package smoke prove offline package consumption only; they cannot prove a live Notion mutation.
- No imported or downloaded script is automatically executed. Reading or exporting a script proves its bytes, not runtime behavior.
- Default helper Doctor is offline: real source version/help, entry hash and isolated roots. `doctor --run "$RUN" --live` explicitly probes official Notion discovery and may cache one Skill outside the selected database; it has no `--database` flag. Database-scoped acceptance still needs explicit selection and coverage inspection.
- Current-target reads use bounded cache policy. Use `--refresh` for fresh Notion readback; a fast or TTL-cached response records a prior observation. Pinned refs intentionally retain their fixed versions.
