# Import, create, dry-run and recovery

Users submit a local Skill folder, ZIP or Markdown file to a selected database. Create refuses an existing invocation name; import creates, reuses identical content or replaces an existing Skill while retaining its page identity.

Same-name import and explicit `import --target` share the complete replacement/recovery contract. P5/C12–C13 in the [matrix](sync-cache-verification-plan.md#command-acceptance), [command map](README.md#accepted-design-coverage) and [protocol](../../../../docs/protocol.md#mutation-contract) own wider coverage. Helper IMPORT_PLAN remains distinct from product SYNC_PLAN_ID/FILE. Every fresh readback below refreshes a current page, never a pinned baseline. Recipes are unrun until evidence is recorded.

## Sub-features

- `import-inputs`: folder, ZIP and single Markdown selection with metadata overrides.
- `import-selection`: explicit database, configured default and sole-discovery creation scope.
- `import-dry-run`: preflight decision with unchanged remote contents.
- `import-actions`: create, identical reuse, update and create conflict.
- `import-recovery`: inspect partial/unknown outcomes and explicitly resume reference imports after readback.
- `import-plan`: real selected-plan import, file/hash acceptance and repeat reuse.
- `import-target`: existing current/pinned main target, rename preservation, no creation fallback and stale/reference rejection.

## How to get to it (user POV)

Each entry point requires its own proof:

- `create` and `import` for each accepted folder/ZIP/Markdown input shape being claimed, including `--name`/`--description` overrides.
- Each command's `--dry-run` path.
- Explicit `--database`, configured creation default, and sole fresh discovery when actually available.
- Create-new and `CREATE_CONFLICT`; import-create, import-reuse and import-update.
- User inspection and explicit repeat import after a naturally observed partial/uncertain outcome. Do not fabricate or inject a transport failure to claim live recovery.
- `import --target` with current and pinned main baselines; metadata rename retaining page ID, missing/inaccessible/stale target and reference-file rejection.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md). The selected plan identifies the database and entries approved by the task/user authorization; the JSON itself grants no authority. Only one writer uses that database; never invent new names or change a retained Skill merely to obtain another action.
- Create-new needs an approved input name absent from the selected database. Import-update needs an approved differing input for an existing same-name Skill. Bind `CHANGED_INPUT` to that actual approved input. Bind `ZIP_INPUT` and `MARKDOWN_INPUT` to actual authorized alternate inputs; `TITLE`/`DESCRIPTION` come from approved source metadata.
- Record fresh online snapshots, catalog/page identities, remote body/properties/reference membership and files before every dry-run or mutation. Save bytes and comparisons in `$RUN/evidence`.

- **Folder preflight.** Run both dry-run commands against a selected folder. Create reports its prospective create decision or existing-name conflict; import reports create/reuse/update with `dry_run=true`. Read the current target/database again afterward and compare remote state to the baseline. These commands may use network and populate caches but must not upload or change remote contents.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$DATABASE" --refresh
  ```

  For an existing preflight target, bind PAGE_ID to that canonical page and run current `read "$PAGE_ID" --database "$DATABASE" --refresh` through cli mode after each dry-run. When no page exists, compare fresh catalog identities instead; pinned reads cannot establish an unchanged live target.

- **Alternate input entries.** Drive create and import separately for each authorized input shape. The commands below preview ZIP and single Markdown with real metadata overrides; repeat without `--dry-run` only for authorized mutations, then obtain fresh readback. A successful folder run does not prove ZIP/Markdown parsing. A manifest-selected main file or single Markdown filename must remain the actual entrypoint.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$ZIP_INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$ZIP_INPUT" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$MARKDOWN_INPUT" --database "$DATABASE" --name "$TITLE" --description "$DESCRIPTION" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$MARKDOWN_INPUT" --database "$DATABASE" --name "$TITLE" --description "$DESCRIPTION" --dry-run
  ```

- **Create/new and conflict.** For an approved absent name, create once, retain the returned page ID and pinned snapshot, then read the returned current page ID online. Repeating create with the same input returns `CREATE_CONFLICT` before mutation; compare remote state afterward.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --database "$DATABASE"
  ```

- **Import actions.** Import the approved input and read its returned current page ID; repeat identical input to prove `action=reuse`, `reused=true`, unchanged identity/content/version and no upload/mutation. An approved differing same-name input reports `action=update`; fresh read/files/export must show the replaced body/metadata/whole file set and the same page ID. Omitted reference pages remain in Notion but leave the current logical file set. If the name was absent, the first import must instead report `action=create`.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$CHANGED_INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Explicit target and rename.** Use a dedicated approved fixture, not retained user content. Bind PINNED_MAIN_REF from a fresh baseline and RENAMED_INPUT to an authorized complete Skill with differing valid metadata. Preview/apply against that exact target, then refresh the canonical page ID and export its new pinned snapshot. Prove page/reference identity, Name/Description, complete files and hashes. Repeat against a current page selector to cover that branch. `--database` constrains ownership and imported metadata cannot redirect selection. In separate authorized cases, exercise missing/inaccessible targets, an older baseline after an independent approved edit, and a pinned reference-file target; verify no new page/content writes and WRITE_CONFLICT for stale baseline.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$RENAMED_INPUT" --target "$PINNED_MAIN_REF" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$RENAMED_INPUT" --target "$PINNED_MAIN_REF" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Creation selection.** Explicit selection is already driven above. To prove configured-default selection, set the approved database default and omit `--database` in create/import dry-runs; compare their selected database with the explicit result. Clear the default and prove omission only if fresh discovery really contains one accessible database and no failed sources. Otherwise record the ambiguity/unmet condition; never infer sole discovery from the selected plan alone.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config set-default "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$INPUT" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- config clear-default
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- database list
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$INPUT" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- import "$INPUT" --dry-run
  ```

- **Prepare the plan and drive acceptance.** Bind `SKILL_DIR` to an authorized absolute source directory. Prepare performs dry-run and freezes names, paths, SHA-256 hashes and byte counts at `$RUN/evidence/plan.json`; repeat `--input` once for each actual authorized directory, including all six in the current scenario. Capture fresh remote before/after state to prove preparation did not mutate it. Use the resulting plan without renaming entries, and drive modes sequentially. Import is the sole authorized writer; verify reads real remote state and compares expected files; reuse repeats identical inputs to prove stable identities and decisions. Keep each mode's evidence and individual CLI results. If selecting an existing authorized plan instead, use its absolute `PLAN` path with the same modes.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts prepare --run "$RUN" --database "$DATABASE" --input "$SKILL_DIR"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts import --run "$RUN" --plan "$RUN/evidence/plan.json"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts verify --run "$RUN" --plan "$RUN/evidence/plan.json"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts reuse --run "$RUN" --plan "$RUN/evidence/plan.json"
  ```

- **Recovery.** Retain stage, completed operations, page/expected-version identities and any receipts on WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN. Read returned current PAGE_ID with --refresh (not the pinned target), or refresh the selected catalog if creation returned no ID. Inspect all main/reference contents before an explicit authorized retry with the same input/database/target; matching child paths should reuse IDs. A stale explicit pinned target still fails and must not be replaced implicitly. Capture fresh readback; never replay uncertain mutations automatically. Sync receipts instead require sync reconcile before a new apply.

## Gotchas

- Dry-run proves preflight only, not Notion service acceptance. Cache changes do not violate it; remote mutation does.
- Creation/same-name import priority is explicit database, configured default, then sole fresh discovery. Failed defaults never fall back. Imported page IDs are metadata; only explicit --target selects an existing page and missing/inaccessible targets never create by name.
- Page-only databases normalize main/reference Markdown. Exact source hashes and arbitrary supporting files require Files; distinguish normalized proof from byte preservation rather than inventing a match.
- Strong mutation checks never accept a warm old cache as authority. Body/properties/references/uploads are separate requests, not atomic transactions. Fresh readback uses current --refresh; pinned export/read remains immutable.
- Input ZIP/folder safety and size limits still apply. No imported script is auto-executed. Cleanup retains evidence and user Notion skills; do not archive remote pages as harness teardown.
