# Create, replace, dry-run and recovery

Users submit a local Skill folder, ZIP or Markdown file to a selected database. `create` refuses an existing invocation name; `replace --target` requires an exact existing page identity and reuses identical content or replaces that page's complete file set.

For daily changes to an existing page, use one pinned `apply` with sparse files/removals and explicit properties; [the pinned-change recipe](reference-write-version-conflict.md) maps it to the existing conflict and recovery cases. This document retains complete create/replace and publication regressions.

The product has no same-name `import` command. Helper `import` selects `create` or an exact-ID `replace` from the refreshed catalog. P5/C12–C13 in the [matrix](sync-cache-verification-plan.md#command-acceptance), [command map](README.md#accepted-design-coverage) and [protocol](../../../../docs/protocol.md#mutation-contract) own wider coverage. Helper IMPORT_PLAN remains distinct from product SYNC_PLAN_ID/FILE. Every fresh readback below refreshes a current page, never a pinned baseline. Recipes are unrun until evidence is recorded.

## Sub-features

- `import-inputs`: folder, ZIP and single Markdown selection with metadata overrides.
- `import-selection`: explicit database, configured default and sole-discovery creation scope.
- `import-dry-run`: preflight decision with unchanged remote contents.
- `import-actions`: create, identical reuse, update and create conflict.
- `import-verification`: live main/reference Markdown and inclusion paths must match submitted instructions independently of the preserved source ZIP; check initial publication and identical reuse with Files, page-only normalization and binary source preservation.
- `import-recovery`: retained frozen input, guarded resume, completed-result reuse and explicit unresolved outcomes.
- `import-plan`: real selected-plan import, file/hash acceptance and repeat reuse.
- `import-target`: existing current/pinned main target, rename preservation, no creation fallback and stale/reference rejection.
- `builtin-publish`: first publication rejects any same-name page; intentional updates require an exact page/main/pinned identity and preserve ordinary version/recovery protections.
- `publication-progress`: opt-in JSONL stderr stage/timing events while stdout remains one final JSON.
- `publication-pacing`: shared 350ms request-start spacing, concurrent cancellation and read retries under a controlled Effect Clock.

When historical state migration changes, its separate recovery acceptance starts from a real old-layout environment imported with the independent migration executable. Ordinary current-state publication recovery does not require migration. Preserve publication `operation_id`, ordered intent bodies/status/response identities, frozen object hashes, guards and pending/unknown creation. Inspect through `operation show ID`; `receipt_path=sqlite:publications/ID` is a database locator. A killed process or released SQL/local lock must not erase the operation or authorize replay. Unknown creation without a proved response remains unresolved. Exercise recovery with a fresh installed Node process and report controlled-provider evidence separately from real Notion.

These recipes are developer regression/audit procedures. Ordinary imports finish on the non-dry command's exit 0, `ok: true` and `verified: true`; callers do not repeat the read/files/export matrix.

## How to get to it (user POV)

Select the affected entry points and retain their outcomes separately:

- `create` and `replace --target` for each accepted folder/ZIP/Markdown input shape being claimed, including `--name`/`--description` overrides.
- Each command's `--dry-run` path.
- Explicit `--database`, configured creation default, and sole fresh discovery when actually available.
- Create-new and `CREATE_CONFLICT`; exact-target replace-reuse and replace-update.
- `operation resume OPERATION_ID` after a naturally observed partial/uncertain live outcome; record controlled fault scenarios separately from live evidence.
- `replace --target` with current and pinned main baselines; metadata rename retaining page ID, missing/inaccessible/stale target and reference-file rejection.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md). The selected plan identifies the database and entries approved by the task/user authorization; the JSON itself grants no authority. Only one writer uses that database; never invent new names or change a retained Skill merely to obtain another action.
- Create-new needs an approved input name absent from the selected database. Replacement needs an approved exact existing PAGE_ID and approved input. Bind `CHANGED_INPUT` to the approved differing input. Bind `ZIP_INPUT` and `MARKDOWN_INPUT` to authorized alternate inputs; `TITLE`/`DESCRIPTION` come from approved source metadata.
- Record fresh online snapshots, catalog/page identities, remote body/properties/reference membership and files before every dry-run or mutation. Save bytes and comparisons in `$RUN/evidence`.

- **Folder preflight.** Run dry-run commands against the appropriate approved absent-name and existing-page fixtures. Create reports its prospective create decision or existing-name conflict; replace reports reuse/update with `dry_run=true`. Read the current target/database again afterward and compare remote state to the baseline. These commands may use network and populate caches but must not upload or change remote contents.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$INPUT" --target "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --refresh
  ```

  For an existing preflight target, bind PAGE_ID to that canonical page and run current `read "$PAGE_ID" --database "$DATABASE" --refresh` through cli mode after each dry-run. When no page exists, compare fresh catalog identities instead; pinned reads cannot establish an unchanged live target.

- **Alternate input entries.** Drive create and exact-target replace separately for each authorized input shape. The commands below preview ZIP and single Markdown with real metadata overrides; repeat without `--dry-run` only for authorized mutations, then obtain fresh readback. A successful folder run does not prove ZIP/Markdown parsing. A manifest-selected main file or single Markdown filename must remain the actual entrypoint.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$ZIP_INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$ZIP_INPUT" --target "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$MARKDOWN_INPUT" --database "$DATABASE" --name "$TITLE" --description "$DESCRIPTION" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$MARKDOWN_INPUT" --target "$PAGE_ID" --database "$DATABASE" --name "$TITLE" --description "$DESCRIPTION" --dry-run
  ```

- **Create/new and conflict.** For an approved absent name, create once, retain the returned page ID and pinned snapshot, then read the returned current page ID online. Repeating create with the same input returns `CREATE_CONFLICT` before mutation; compare remote state afterward.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE"
  ```

- **Replacement actions.** Replace the approved exact page and read its returned current page ID; repeat identical input to prove `action=reuse`, `reused=true`, unchanged identity/content/version and no upload/mutation. Approved differing input reports `action=update`; fresh read/files/export must show the replaced body/metadata/whole file set and the same page ID. Omitted reference pages remain in Notion but leave the current logical file set. An absent name requires a separate `create` command; replacement never creates.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$INPUT" --target "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$INPUT" --target "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$CHANGED_INPUT" --target "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Explicit target and rename.** Use a dedicated approved fixture, not retained user content. Bind PINNED_MAIN_REF from a fresh baseline and RENAMED_INPUT to an authorized complete Skill with differing valid metadata. Preview/apply against that exact target, then refresh the canonical page ID and export its new pinned snapshot. Prove page/reference identity, Name/Description, complete files and hashes. Repeat against a current page selector to cover that branch. `--database` constrains ownership and imported metadata cannot redirect selection. In separate authorized cases, exercise missing/inaccessible targets, an older baseline after an independent approved edit, and a pinned reference-file target; verify no new page/content writes and WRITE_CONFLICT for stale baseline.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RENAMED_INPUT" --target "$PINNED_MAIN_REF" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RENAMED_INPUT" --target "$PINNED_MAIN_REF" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Creation selection.** Explicit selection is already driven above. To prove configured-default selection, set the approved database default and omit `--database` in create dry-runs; compare the selected database with the explicit result. Unset the default and prove omission only if fresh discovery really contains one accessible database and no failed sources. Replacement remains bound to its exact target regardless of creation defaults. Otherwise record the ambiguity/unmet condition; never infer sole discovery from the selected plan alone.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config set default_database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$INPUT" --target "$PAGE_ID" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl config unset default_database
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl database list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$INPUT" --target "$PAGE_ID" --dry-run
  ```

- **Prepare the plan and drive acceptance.** Bind `SKILL_DIR` to an authorized absolute source directory. Prepare performs dry-run and freezes names, paths, SHA-256 hashes and byte counts at `$RUN/evidence/plan.json`; repeat `--input` once for each actual authorized directory, including all six in the current scenario. Capture fresh remote before/after state to prove preparation did not mutate it. Use the resulting plan without renaming entries, and drive modes sequentially. Import is the sole authorized writer; verify reads real remote state and compares expected files; reuse repeats identical inputs to prove stable identities and decisions. Keep each mode's evidence and individual CLI results. If selecting an existing authorized plan instead, use its absolute `PLAN` path with the same modes.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts prepare --run "$RUN" --database "$DATABASE" --input "$SKILL_DIR"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts import --run "$RUN" --plan "$RUN/evidence/plan.json"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts verify --run "$RUN" --plan "$RUN/evidence/plan.json"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts reuse --run "$RUN" --plan "$RUN/evidence/plan.json"
  ```

- **Official package publication.** Use the exact ID from `ctl builtin list`, currently `notion/ntn-skills-maintain`, and an authorized database. Drive `ctl builtin publish ID --database "$DATABASE" --dry-run`, compare fresh catalog/page state, then publish once only when authorized. Freshly read the returned page ID, enumerate/read its references and compare export bytes (or normalized Markdown without Files). Repeating first publication must return `CREATE_CONFLICT`, including an identical earlier copy. For an authorized differing update, freshly read and review the chosen page, retain PINNED_MAIN_REF, preview/apply `ctl builtin publish ID --target "$PINNED_MAIN_REF"`, and confirm the same page ID and complete package file set. Names/unqualified built-in IDs/reference-file targets must fail before mutation; a stale pinned baseline must return `WRITE_CONFLICT`. Set a different built-in/ordinary default in scratch and prove it cannot redirect an explicit update; explicit --database constrains ownership. Controlled core regressions establish conflict/version cases, while live service acceptance requires these actual readbacks. The [package recipe](portable-export-package-consumption.md) separately owns offline bytes/provenance/output protection.

- **Source provenance and equal-content publication.** Retain authorized raw Notion schema/page-property readback; public record JSON is unchanged. Exact builtin IDs are `notion/ntn-skills`, `notion/ntn-skills-maintain`, `notion/ntn-skills-sync`. Deliberately publish each approved exact target and read back builtin plus its exact Builtin ID. Never create duplicates to avoid collisions or trust remote metadata as local identity. Missing/incompatible fields must reject builtin/upstream publication before mutation with initialization guidance. Equal bytes with differing requested provenance must update with `reused: false` using only journaled metadata assignment and no body/reference/resource/source upload; complete equality must reuse without remote mutation. Cover native and markdown_files plus dry-run. Upstream reads back upstream and empty Builtin ID; fork/tracked retains upstream. Ordinary replace/write preserve provenance, including unset. Retain request traces to prove mutation boundaries; this recipe claims no live pass.
- **Frozen source recovery.** Prove interruption/resume/reconcile/metadata retry retain original source intent, property IDs and exact combined ownership/source request despite local source/package changes. Historical supersede/preparation cases belong to `ntn-skills-operator` and apply only when those retained paths change. Property label renames retain frozen ID authority; delete/recreate cannot acquire an old ID. Ordinary legacy create freezes unavailable fields; old receipts without source intent never gain inferred provenance. Unknown arbitrary metadata remains unresolved. Completed/upstream fast paths cannot report reuse with unfinished or externally changed requested metadata. Record each exercised result separately.
- **Acknowledged metadata with failed readback.** Interrupt the first GET after a successful source PATCH through the transport. Exercise both direct resume and reconcile followed by resume after renaming the bound source labels, for native and markdown_files storage. Require exact source values, unchanged content/resources, one original source PATCH and the retained acknowledged response; do not manufacture this state by editing the receipt. For editable files, include complete equal content whose live file order differs from the frozen source, and require recovery without appending file blocks.
- **Recovery.** Retain `operation_id`, `receipt_path`, stage, completed operations and page/expected-version identities on WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN. Within the original authorization, drive `operation resume "$OPERATION_ID" --progress`, then refresh the current returned PAGE_ID and compare main/reference/file content and page IDs. Inspect database locators through `operation show`; do not open mutable JSON state. It must use frozen original input despite later local edits or builtin upgrades. Repeating a completed receipt must add no mutation. External edits must yield WRITE_CONFLICT and preserve remote content; unknown creation without a proven response must yield PUBLICATION_UNRESOLVED without repeating POST. Core publication-recovery tests cover deterministic failures, scope drift, pending writes and concurrent ownership; the built Node CLI must separately exercise a controlled provider scenario and report that boundary explicitly. Never present injected transport faults as real Notion evidence. Sync receipts use `operation reconcile OPERATION_ID`.

- **Interrupted validation and result replay.** In isolated controlled-provider runs, edit the remote root/reference during version validation, after recovery preflight and immediately before final readback. Kill the actual Node CLI after it reads the edit but before comparison; the next resume must reject the external state with no additional mutation. A failed final readback followed by resume must also preserve that edit. For a completed single-file write, compare the whole replayed JSON result and ensure `path`, target-file `ref` and original `previous_version_id` match; create/replace replay retains `input_type` and `main_path`. Keep actual process-kill evidence separate from deterministic Effect interruption fixtures.

- **Progress and pacing.** Run an authorized publish with and without `--progress`. Default stderr stays empty; opt-in stderr contains only parseable PublicationProgress events with matching operation IDs, ordered start/end status and nonnegative total/stage milliseconds. stdout remains one final JSON in success and failure. The live control helper intentionally retains only stderr hashes; use a separate owned direct CLI capture for these safe progress events. `packages/core/test/notion.test.ts` uses a controlled Effect Clock to prove request starts at least 350ms apart, no extra delay after a slow response, cancellation and retry admission. Record comparable request counts for repeated-refresh performance claims; do not infer wall-time speedup solely from tests.

- **Live property envelopes.** Repeated reads of an unchanged References property can carry different top-level `request_id` values. Preserve that response evidence and confirm dry-run/update/resume accepts unchanged property content while still rejecting changed membership, links or pagination. Do not copy the transport trace ID into a content baseline or remove a conflict fence from an older failed receipt.

- **Automatic revision properties.** Use a real library with a `last_edited_time` property, write a body and read the page back. Its automatic property and top-level edit time can advance together; this alone must not fail publication. Editable metadata, References and parent changes must still conflict. Keep the failed-before and passed-after page/receipt evidence without resetting conflict flags.

- **Markdown fidelity.** Include GFM tables containing inline-code spans separated by a literal `+`, labeled and unlabeled fenced code with an internal blank line, bold text spanning inline code, prose after a list, and inline/reference-style links. Import once and require `verified: true`; fresh main/reference readback must retain literal operators, code contents/languages, joined emphasis and list/prose boundaries, independently of source-ZIP byte preservation. Change a table operator, command argument, code-block language/blank line, link destination or list inclusion in controlled fixtures and require verification failure. Capture parser warnings as failures. Use a separate disposable page for format probes and confirm its move to Notion Trash; do not weaken equality to accept corrupted text.

- **Native default and literal-to-native correction.** For daily/upstream publication, require a rendered main body and all supporting Markdown documents as rendered child pages included through References, preserving original root/nested paths (commonly `references/**`). Include root `mocking.md`/`tests.md` and nested Markdown outside `references/`; their links must reach the corresponding pages, read/export must retain their paths, and the historical page-title fallback must remain compatible when no explicit Markdown path label exists. Scripts/non-Markdown assets remain complete in Files/the source bundle. Start from an explicitly selected literal Skill and drive exact-target `replace INPUT --target EXACT --storage notion_blocks` with complete source/resources; require the root page ID and upstream ownership to remain, existing resources to survive, and the current read to use rendered main/reference content. Retain chapter/list/table/code/link/resource evidence. Accept only whitespace/equivalent local formatting differences; whole-document source-code blocks cannot satisfy native rendering. A conversion/verification failure must remain a failure, without automatic `markdown_files` fallback. Exercise explicit source-file maintenance mode separately; do not use it as the default bulk migration. This recipe defines acceptance and claims no live conversion pass.

- **Editable file consumption.** Drive `create` and exact-target `replace --storage markdown_files` on an authorized LF text-only Skill with nested Markdown, scripts, relative links, literal fences, Unicode and an empty resource. CR/CRLF and binary/NUL-bearing input must fail before mutation; the service normalizes carriage returns. Fresh independent-state read/files/source export must contain the complete current Notion file bytes; edit an owned code block and prove the next read changes rather than restoring a ZIP. Verify file-only write preserves page metadata/other files and stale pins fail. For an interrupted multi-chunk file, resume only the missing suffix; absent/partial/edited unknown append trees must remain unresolved without another mutation. Historical distinct-page supersede through `ntn-skills-operator` retains the old unknown receipt/page and advances only a fully committed new pointer; it is not an ordinary publication prerequisite. Report native normalization separately from literal-file proof; neither requires unlimited arbitrary Markdown↔Notion reversibility.

For editable-file pages, an out-of-band code edit with unchanged publication ownership becomes the current read source after the recorded marker revision itself is validated; it must never restore old ZIP bytes. Tracked upstream planning still compares current content with the accepted Published Hash and rejects unaccepted edits. Ownership drift and an invalid marker continue to fail. Verify these as separate boundaries; a raw decoder fixture alone does not prove tracked edit handling.

## Gotchas

- Dry-run proves preflight only, not Notion service acceptance. Cache changes do not violate it; remote mutation does.
- Creation priority is explicit database, configured default, then sole fresh discovery. Failed defaults never fall back. Imported page IDs are metadata; only explicit --target selects an existing page and missing/inaccessible targets never create by name.
- Page-only databases normalize main/reference Markdown. Exact source hashes and arbitrary supporting files require Files; distinguish normalized proof from byte preservation rather than inventing a match.
- Strong mutation checks never accept a warm old cache as authority. Body/properties/references/uploads are separate requests, not atomic transactions. Fresh readback uses current --refresh; pinned export/read remains immutable.
- Input ZIP/folder safety and size limits still apply. No imported script is auto-executed. Cleanup retains evidence and user Notion skills; do not archive remote pages as harness teardown.
