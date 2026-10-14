# ntn-skills verification map

These recipes describe current executable entry points and are not records of completed acceptance. Sync/cache commands, read policies and explicit-target import are implemented. Read the matching recipe before driving a feature; preserve command/result evidence and distinguish deterministic, live and installed-consumer proof.

## Sub-features

- [Discovery, configuration, authentication and doctor](./discovery-config-auth-doctor.md): help, database/catalog discovery, local preferences and connection diagnostics.
- [Snapshots, reading, opening, files and relative resolution](./snapshot-read-open-files-resolve.md): current online content, immutable local versions and exact file output.
- [Import, create, dry-run and recovery](./import-create-recovery-dry-run.md): selected local inputs, create/reuse/update decisions and uncertain outcomes.
- [Reference pages, single-file writes and version conflicts](./reference-write-version-conflict.md): editable references, replacement of one file and stale-baseline rejection.
- [Portable export and package consumption](./portable-export-package-consumption.md): reversible exports and the built npm package boundary.
- [Bidirectional sync and read-cache verification plan](./sync-cache-verification-plan.md): acceptance cases for the [implemented CLI design](../../../../docs/sync-cache-cli-design.md), including common bases, real targets, TTL, batch plans, conflicts and recovery. Case execution is recorded in the external run ledger.

## Accepted design coverage

Command/parameter semantics belong to the [protocol](../../../../docs/protocol.md); the [CLI design](../../../../docs/sync-cache-cli-design.md) records rationale, and the [verification matrix](./sync-cache-verification-plan.md) owns case definitions and evidence requirements. Case IDs are stable lookup keys, not test counts or pass results.

| Entry or boundary | Cases | Required proof |
| --- | --- | --- |
| `sync bind`, initial source choice and duplicate labels | S1–S2, S14, P2, P10 | Dry-run/config comparison; equal/different/missing-leaf initialization; fresh content/page identity readback |
| `sync status`, `status --refresh` | C17, S9 | Local-only observation stays provisional; online refresh does not advance any common base |
| `sync plan`, explicit `--from`, `--output` | S3–S8, P3–P4, P9 | Checked identities/directions, immutable plan copy, rejected conflicts and stale-plan state preservation |
| `sync plan --all`, shared page/real destination | S9–S10, S15, R7 | Distinct-candidate rejection, one accepted remote update, independently verified local fan-out/bases |
| `sync apply --plan` by ID/file | S3–S7, S11–S13, L1–L7, P4 | Exact portable result plus commit-time target checks; rejected plan/content/link drift cannot overwrite either side |
| `sync reconcile`, `sync unbind` | R1–R7, P6, P8, P10 | Restart/readback before replay decision; truthful partial outcomes; content/baseline/receipt retention |
| `import --target` and existing write preconditions | P5, C12–C13, S8 | Page ID remains fixed on rename; stale/missing/non-main targets fail; TTL cannot authorize a write |
| `read/open/files/export`, common cache flags | C1–C15, P1, P11 | Controlled TTL/identity failures, complete fixed refs, actual CLI surface and Node.js consumer; export output protection remains covered by its existing recipe |
| `list`, cache scope and discovery coverage | C8–C9, C18, P1 | Offline/refresh behavior retains ambiguity/incomplete coverage and independent catalog age limit |
| `cache status/clear`, XDG and old-state upgrade | C10–C11, C16–C19, P6 | Effective isolated roots and cache-only retirement; failed retention invalidates the entire observation batch while retaining bytes, pinned state, common bases and pending plans |
| `config set/clear-cache-policy` | P1, P7 | Offline persisted precedence/durations, sanitized config and next-process effective policy |
| Public help/JSON/raw/exit contract | P1, P3, P11 | Actual subcommand help, invalid flags before effects, safe JSON/error and noninteractive decisions |

Controlled-clock fixtures live in core cache tests; real link and commit-interruption fixtures live in sync-local/sync tests. The helper and consumer smoke isolate config/state/cache and XDG bases. Ordinary live acceptance keeps one writer; L7/C14/R7 use controlled concurrency with designated fixtures. Track deterministic, live and installed-consumer results separately, including any unavailable native storage branch.


## How to get to it (user POV)

The user surface is `ntn-skills`, invoked from this checkout through the control helper's `cli` mode. The recipes use the real command names and flags from [main.ts](../../../../packages/cli/src/main.ts), [usage](../../../../docs/usage.md) and [protocol](../../../../docs/protocol.md). Each recipe lists its specific user entry points and observable results.

Select the authorized database and absolute input directories, then use helper `prepare` to dry-run those inputs and freeze their file hashes into `$RUN/evidence/plan.json`, or select an existing authorized plan. Its `database` selects the shared Notion database; its entries contain `name`, absolute `input`, `files` and `file_hashes` with `path`, `sha256` and `bytes`. The current six-entry scenario uses the public invocation aliases `open-source-repo-readiness`, `semantic-decompression`, `write`, `hai-audit-docs-against-code`, `github-cicd-bootstrap` and `npm-publish`. Use the selected plan's actual inputs and CLI-returned identities rather than guessing page IDs or refs.

## Driving it with control-ntn-skills

Preconditions:

- Run commands from the repository root. `RUN` is the absolute owned run directory; `IMPORT_PLAN` is the helper's frozen migration JSON. Product `SYNC_PLAN_ID`/`SYNC_PLAN_FILE` is a different state artifact accepted by CLI `sync apply`; pass product arguments after helper `cli --` rather than using the outer helper's `--plan`.
- Bind `DATABASE` to `plan.database`, `INPUT` to a selected entry's absolute input, and `FILE_PATH` to one of that entry's relative files. A local source file is the absolute input directory joined to its relative path. Bind `INPUT_FILE` to that actual file; `TITLE` and `DESCRIPTION` are approved source metadata, not guessed replacements.
- Bind `TARGET`, `REF`, `SNAPSHOT`, `FILE_REF`, `PAGE_ID`, `PAGE_URL` and `SKILL_ALIAS` only from selected CLI results. `REF` and `FILE_REF` are pinned; `TARGET` is the chosen current unpinned selector. Bind `RELATIVE_PATH` to an actual link relative to the containing file. Recipe-specific variables similarly name actual selected files or captured replies.
- Inherited `NOTION_API_TOKEN` or an existing official `ntn` login supplies authentication without copying personal configuration. The helper isolates config/state/cache under `$RUN/scratch` and overrides all XDG bases there; HOME remains unchanged. Online work uses `bun run dev` and official `ntn`, without transport or proxy overrides. Ordinary live acceptance uses one writer per shared page; controlled concurrency cases use designated fixtures.
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

Cleanup moves run scratch state and recorded successful package scratch to system Trash, never `$RUN/evidence` or retained user Notion skills. Confirm evidence remains available after cleanup before reporting a proof.

## Gotchas

- A recipe is not evidence. Record exactly which entry points were exercised and report skipped paths with their unmet prerequisite.
- Dry-run can read the network and populate caches. Compare fresh remote state before and after; remote bodies, properties, reference membership and files must remain unchanged. It does not prove service acceptance.
- `WRITE_PARTIAL` and `WRITE_OUTCOME_UNKNOWN` require readback before deciding on another write. Do not automatically retry mutations or infer failure from a timeout.
- Fixture snapshots used by package smoke prove offline package consumption only; they cannot prove a live Notion mutation.
- No imported or downloaded script is automatically executed. Reading or exporting a script proves its bytes, not runtime behavior.
- Doctor probes discovery broadly and may cache one Skill outside the selected database. It has no `--database` flag. Database-scoped acceptance still needs explicit selection and coverage inspection.
- Current-target reads use bounded cache policy. Use `--refresh` for fresh Notion readback; a fast or TTL-cached response records a prior observation. Pinned refs intentionally retain their fixed versions.
