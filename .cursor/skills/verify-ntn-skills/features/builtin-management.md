# Built-in Skill installation and updates

This recipe covers explicit local copies. Broker exposes the three bundled Skills through ordinary `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin` selection on Pi/OMP/Tern without central installation or a Notion source. The Broker artifact verifier consumes the packaged bodies and references offline; the installation lifecycle below is relevant when changing explicit install/update behavior.

## Sub-features

- Offline `ctl builtin list/read/status/install/update` use exact package IDs `notion/ntn-skills`, `notion/ntn-skills-maintain` and `notion/ntn-skills-sync`. Each Skill installs once under the XDG data root and links into the default shared directory.
- A central version-2 `.ntn-builtin-install.json` records the complete exported baseline; separate distribution records own each link. Foreign same-name directories and incidental links are never adopted.
- Changed, added or removed files, including hidden files, block replacement. A clean old tree can update in place so every registered link reads the same body/resource additions and removals.
- Central locks and journals fence concurrent writes and expose interruptions. Receipt-v1 destinations remain conflicts in ordinary install/update; old migration registry fields require the separate migration artifact.
- The npm consumer path uses the installed Node.js CLI without `ntn` or authentication. Ordinary host `$` discovery/loading uses separate broker verification recipes.

## How to get to it (user POV)

Use an isolated HOME and `NTN_SKILLS_DATA_HOME`/`XDG_DATA_HOME` owned by this run. Additional roots are optional destinations, not canonical storage locations. Replace `PROFILE` and `OTHER_PROFILE` with run-owned paths.

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin status
ntn-skills ctl builtin install notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills-sync
ntn-skills ctl builtin install notion/ntn-skills-maintain --agent-dir PROFILE --agent-dir OTHER_PROFILE
ntn-skills ctl builtin read notion/ntn-skills-maintain --path references/operations.md
ntn-skills ctl builtin update notion/ntn-skills-maintain
```

Local installation ownership is independent of remote `Source Type`/`Builtin ID`; editable properties cannot authorize install/update or establish trusted package identity. Remote classification follows the [publication recipe](import-create-recovery-dry-run.md): explicit schema upgrade, exact trusted package ID/target, raw property readback, metadata-only update and mutation-free complete repeat. Local management success proves no remote acceptance result.

`update` changes the installed Skill to this CLI package's content. Upgrading the CLI itself and publishing a copy to Notion remain separate actions. Installation refreshes filesystem bytes; a running host must reload its native Skill catalog. OMP uses `/restart`.

## Driving it with control-ntn-skills

Follow the parent [Skill](../SKILL.md) to initialize an isolated run and build the CLI. Offline package proof uses `cli -- --version` as doctor, then `package`; it does not require live Notion doctor.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- --version
bun .cursor/skills/verify-ntn-skills/scripts/control.ts package --run "$RUN"
```

For changes to explicit installation/update behavior, run the existing two-artifact lifecycle separately:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/builtin-lifecycle.ts doctor
bun .cursor/skills/verify-ntn-skills/scripts/builtin-lifecycle.ts
```

The runner builds two real Node.js CLI artifacts from the production command entrypoint with controlled A/B package catalogs. They share a package version and differ in body and resources. It drives public CLI commands, checks content IDs and the complete installed/exported tree, preserves local changes and retains evidence outside its trashed scratch. It proves local upgrade semantics, not release-registry availability.

The consumer smoke drives the actual npm-installed CLI. Inspect its `builtins` catalog and `additional_skills` observations for all three IDs, complete main/reference/export/installed bytes, separate receipts and idempotent install/update. After a modified maintenance Skill refuses replacement, the entrypoint and sync installations must remain current. A manually copied entrypoint without a receipt must remain unmanaged with unchanged bytes. Core behavior regressions separately exercise two distinct built-in contents and interruption boundaries. A real A-to-B package upgrade requires two built CLI artifacts with different content IDs; changing a version label alone does not prove an update.

The lifecycle runner checks the owned old-tree inode and bytes in `~/.Trash` after the other local cases. macOS may deny that observation even when `/usr/bin/trash` succeeds. It then retains a blocked `trash-retention.json` and exits nonzero; report the earlier completed cases separately and do not claim complete production retention proof.

For a focused source drive, pass these commands through `control.ts cli --run "$RUN" -- ...` with isolated HOME/data roots. Record the central inventory/receipt, distribution registry and every link before and after. Assert `status` creates nothing; repeated install reuses central bytes; added roots persist; all links observe an update. Modify/add/remove owned central files in fresh cases and require rejection without byte loss. Foreign directories, foreign links, retargeted registered links and all receipt-v1 directories must refuse replacement. A registry containing `retained_path` or `legacy_proof` must expose `distribution_error.code=BUILTIN_MIGRATION_REQUIRED` and block both mutations without changing the registry, central receipt or links. Exercise interrupted v2 publication/readback and real fiber interruption, preserving expected failure output and retained trees.

Receipt-v1 conversion has a separate executable artifact supplied by the release or integration owner; the regular package never imports its frozen legacy writer. Bind `BUILTIN_MIGRATION` to that supplied artifact and every directory below to an owned fixture. Stop old writers before conversion. For a profile with an interrupted v1 journal, run guarded recovery first and retain its result; then run the conversion explicitly:

```bash
node "$BUILTIN_MIGRATION" notion/ntn-skills --agent-dir "$OLD_PROFILE" --data-dir "$CENTRAL_DATA" --home-dir "$OWNED_HOME" --old-writers-stopped --recover-only
node "$BUILTIN_MIGRATION" notion/ntn-skills --agent-dir "$OLD_PROFILE" --data-dir "$CENTRAL_DATA" --home-dir "$OWNED_HOME" --old-writers-stopped
```

Use the artifact's exact builtin ID for each fixture. The recovery-only invocation applies to interrupted legacy transactions; a clean fixture can proceed directly to conversion. Retain the complete old tree/receipt and journal before either command, then capture the resulting v2 receipt, registered links and retained prior bytes. Keep this artifact's evidence separate from ordinary install/update rejection evidence. An artifact unavailable to the run leaves conversion unproven.

The source map for builtin behavior is `packages/core/src/builtin-install.ts` for distribution ownership and public operations, `builtin-install-tree.ts` for Effect data-root resolution, complete-tree inspection and scoped no-follow handles, and `builtin-install-transaction.ts` for atomic journal records and guarded recovery. `packages/core/test/builtin-install.test.ts` owns boundary, alias-process lock, legacy preservation/fence and deterministic fiber interruption/handle-closure regressions. The lifecycle runner and installed-consumer smoke own actual Node.js CLI proof; the external migration artifact owns receipt-v1 conversion.

The broker repository's `.agents/skills/verify-notion-skills-integration/features/builtin-management.md` owns ordinary Pi/OMP/Tern builtin selection. Its existing `scripts/verify-artifacts.mjs` checks installed package discovery, full-body loading and offline main/reference reads through each bundled CLI with no central installation. Native UI recipes cover candidates and exact-token insertion. When explicitly installed local copies are changed, additionally check native reload, registered links and single physical-entry exposure for overlapping roots. Dedicated `/ntn-skills` save/management palettes are retired; they are not acceptance targets.

## Gotchas

- `builtin list` includes local installation state by default; catalog presence or package version alone does not prove an installed current tree or healthy distribution links.
- A receipt is a local baseline, not a signature or remote ownership claim. Modified registered Skills remain user-editable; update refuses to overwrite them.
- Staging, old directories and journals live outside `skills`, so native scans cannot discover backup copies.
- All retention uses the verified system Trash capability or reports retained paths. Never remove unknown files or reset a user profile to make a check pass.
- Preserve command output, hashes, journals and cleanup receipts under evidence before retiring scratch. Cleanup success does not establish feature success.
