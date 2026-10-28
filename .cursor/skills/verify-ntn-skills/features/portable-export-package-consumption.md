# Portable export and package consumption

Users export a complete Skill, Router or Prompt as a deterministic ZIP or directory, preserve its portable manifest for reimport and consume the built `ntn-skills` package through Node.js.

The [command map](README.md#accepted-design-coverage), [matrix](sync-cache-verification-plan.md) and [protocol](../../../../docs/protocol.md#portable-export-contract) route export policy/XDG/installed-consumer acceptance. Consumer smoke isolates config/state/cache and XDG bases. These recipes and smoke descriptions do not claim a passing result; main verifier records actual installed entry points, runtime and evidence.

## Sub-features

- `export-current`: bounded current-target selection and explicit fresh remote export without mutation.
- `export-pinned`: complete offline export of an existing local version.
- `export-format`: suffix selection and explicit ZIP/directory overrides.
- `export-reuse`: identical-output reuse and differing-output protection.
- `export-roundtrip`: portable manifest and source preservation on reimport.
- `package-consumer`: public tarball identity, installed executable and offline consumer behavior.
- `builtin-catalog`, `builtin-consumer`: offline exact-ID catalog for discovery (`notion/ntn-skills`), content maintenance (`notion/ntn-skills-maintain`) and synchronization (`notion/ntn-skills-sync`), complete supporting-file reads and portable export with package provenance and output protection.
- `sqlite-upgrade-consumer`: install the normal CLI and independent migration archive separately, seed the complete historical environment before any normal command creates a new database, run the explicit importer once, then consume pinned/read/export and retained operation identities with fresh Node processes. Do not seed internal SQLite rows to manufacture a success.
- `sqlite-backup-consumer`: create a standalone database backup through the official driver, copy referenced immutable files, restore into independent roots and verify real exported bytes; corruption must fail without old JSON fallback. Record exact Node/SQLite versions, package hash, entrypoint, WAL/synchronous settings and busy behavior for every exercised support-matrix row.
- `portable-v2-kind`: normal manifest version 2 kind/name/description/main and full inventory match read/export record; normal v1 directory/ZIP/source reads fail `PORTABLE_UPGRADE_REQUIRED`. Only the separately built portable converter reads v1. Exercise offline original-byte/hash preservation and malformed-manifest rejection, then old remote source ZIP → read-only plan → approved hash/explicit apply → formal replace → strict reader. Remote proof v1 must first follow the separate proof-converter gate; never bypass proof verification.
- `source-provenance-consumer`: package builtin IDs/bytes remain trusted through the installed catalog; editable remote Source Type/Builtin ID never grant local identity. Prove public ContentRecord JSON and CLI flags unchanged. Raw schema/property readback, metadata-only publication and mutation-free repeat belong to the [publication recipe](import-create-recovery-dry-run.md), not an offline export pass.
- `router-portable`: export contains authored Router instructions, deterministic member metadata and Router-owned resources, without member full bodies. Every relative resource exists; every member reference resolves to the intended stable Skill locator.


## How to get to it (user POV)

Each entry point requires its own proof:

- `export` with a current Name/alias/page ID/page URL/unpinned ref, then a returned pinned ref and snapshot ID. Prove every selector form actually claimed.
- `export --output` with `.zip` suffix and directory output, plus `--format zip` and `--format directory` overrides.
- Repeated export to an identical destination and export of different content to that destination.
- `replace --target PAGE_ID` of the exported folder and ZIP with the manifest intact; use `create` only for an approved absent-name fixture.
- Installed package help/version, resolve, ctl config show, snapshot reads, file listing, relative ranged read, export reuse, alias constraints, parse failure and corrupted-object rejection through the consuming project's Node executable/bin.
- Global npm registry installation, global tarball installation and registry project installation are separate documented distribution entry points. The package helper proves local-tarball project consumption only; each additional installation route needs its own real install/bin proof.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md). Obtain `TARGET`, `REF` and `SNAPSHOT` from a selected real online Skill; save their metadata and complete file list. Choose `DIFFERENT_SNAPSHOT` only from an actual cached version with different portable content.
- Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+ and npm are available for package consumption; repository dependencies/build prerequisites follow the repo's package-check workflow. Package validation is invoked deliberately by the main verifier, not automatically by importing a Skill.
- Outputs and evidence are under `$RUN/evidence`; approved roundtrip imports use the selected database and sole writer.

- **Fresh current versus pinned export.** Current export below uses --refresh to validate online; pinned ref/snapshot export remains offline. Require the correct source/freshness policy and complete files plus .ntn-skills.json. Compare operation/format/content_id/main_path/bytes to its snapshot and selected input. Repeat fresh current export for every claimed selector form; capture current-page --refresh readbacks before/after to prove no mutation. A normal warm current export is separate bounded-cache evidence.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$TARGET" --database "$DATABASE" --refresh --output "$RUN/evidence/current.zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$REF" --output "$RUN/evidence/pinned.zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$SNAPSHOT" --output "$RUN/evidence/portable-directory"
  ```

  Drive current export without policy, with --offline and --max-age 30s to cover cache selection separately; use distinct output paths because input freshness never authorizes overwrite. Reject --refresh/--max-age on pinned targets and mutually exclusive policies. Content default is 5m, catalog default 60s; official-login scope may require online identity checks and unsafe offline lookup fails.

- **Format overrides.** Deliberately use destinations whose names would otherwise choose the opposite format. Inspect the real ZIP entries/directory files, not just the reported format. Both preserve the manifest and the complete file set.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$SNAPSHOT" --format zip --output "$RUN/evidence/explicit-zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$SNAPSHOT" --format directory --output "$RUN/evidence/explicit-directory.zip"
  ```

- **Determinism and output protection.** Repeat pinned ZIP and directory output to prove `reused=true`, unchanged content IDs and identical saved bytes. Export the same snapshot to a fresh ZIP and compare archive hashes. Export an actual different snapshot to each occupied destination; expect `OUTPUT_CONFLICT` and prove the original ZIP/directory remains byte-identical. If no different approved cached content exists, report conflict coverage unavailable.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$REF" --output "$RUN/evidence/pinned.zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$SNAPSHOT" --output "$RUN/evidence/portable-directory"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$SNAPSHOT" --output "$RUN/evidence/pinned-second.zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$DIFFERENT_SNAPSHOT" --output "$RUN/evidence/pinned.zip"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- export "$DIFFERENT_SNAPSHOT" --output "$RUN/evidence/portable-directory"
  ```

- **Roundtrip.** Preview then explicitly replace the approved exact page with each exported output. Identical portable content should reuse the same page ID/content ID; obtain fresh online read/files afterward. Compare main path, metadata, every file and hash against the exported content. Without Files, compare normalized main/reference Markdown rather than asserting original source bytes.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RUN/evidence/pinned.zip" --target "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RUN/evidence/pinned.zip" --target "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RUN/evidence/portable-directory" --target "$PAGE_ID" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- replace "$RUN/evidence/portable-directory" --target "$PAGE_ID" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Built package boundary.** Run the helper's package mode deliberately. It delegates `scripts/package-check.ts`, which packs the public CLI, checks package identity/runtime/dependencies/bin/public files, builds/packs the independent migration tool and passes both archives to `scripts/package-smoke.ts` through `--archive` and required `--migration-archive`. The helper checks both reported SHA-512 integrities and retains both tarballs plus installed-consumer evidence before cleanup. Require a successful recorded exit and inspect actual archive paths, integrities, version, public file list and smoke check names in `$RUN/evidence/package.json`.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts package --run "$RUN"
  ```

  Smoke installs into its own npm consumer and launches installed Node/bin. Preserve actual named check results for help/version, selectors/parse failures, policy configuration, isolated root reporting, pinned/warm offline reads, relative ranges, files/export reuse, alias constraints, retained cache/state and integrity rejection. Synthetic fixtures prove installed offline behavior, not live login/uploads/mutations. Confirm declared check names in actual output instead of inferring them from this recipe. Public package links must resolve within shipped docs; source-only acceptance matrix is repository evidence.

  On macOS, smoke still executes actual cache retirement through system Trash and proves disposable observations disappear while configuration, pinned content, baselines, plans and receipts survive. If the initial Trash directory inspection fails with `EPERM` or `EACCES`, evidence records `trash_contents_not_observed` with that safe reason and `trash_check=system_trash_command_succeeded_contents_unreadable`; this does not prove retained bytes. With readable Trash, smoke compares actual newly visible file bytes against every retired fixture and reports `system_trash_bytes_retained` only after those comparisons pass. Full Disk Access may be needed for this stronger byte proof; do not infer it from successful retirement commands.

  On Linux, smoke attempts cache retirement and requires `RETENTION_UNAVAILABLE`, verifies every cached fixture remains byte-identical, and records `trash_check=retention_unavailable_bytes_preserved`. Fresh CLI processes must report no active content/catalog observation from that batch and unknown remote freshness while preserving the baseline and pending receipt. This proves invalidation and safe failure without a recycle capability, not successful Linux retirement. The controller copies the original installed-consumer evidence before any cleanup; CI artifacts retain it alongside the checked tarball.

  For global registry/global tarball/registry project routes, follow the actual [usage installation instructions](../../../../docs/usage.md#installation-options) in an authorized disposable npm prefix/project, using the produced actual archive or selected published version. Capture install command/result, resolved installed bin, help/version and a separately driven real user command. These routes are not supplied by `control.ts package`; record them as uncovered until separately exercised.

- **Optional official Skills.** Run `ctl builtin list`, then `ctl builtin read` and `ctl builtin export` for each exact ID above. Enumerate each returned `files` inventory and read every supporting file using `--path`; compare package source, CLI read, export and installed bytes. Preserve portable manifests, central version-2 receipts and distribution records. Install all three into one owned data root with isolated HOME; assert default shared and optional Agent links resolve there. Repeat install/update to prove unchanged receipt bytes, add a target through repeated install, and verify a refused modified Skill cannot alter its neighbors. Copied unmanaged central trees and foreign distribution entries must reject adoption without byte changes. Repeat identical export for reuse, and export to a customized destination for `OUTPUT_CONFLICT` with preserved bytes. Unqualified IDs fail with `BUILTIN_NOT_FOUND`, root escapes fail and ordinary remote reads never select package content. Inspect `builtins` and `additional_skills` in installed-consumer evidence; these prove package/local management, not agent task routing or real Notion synchronization.

- **Upgrade and uninstall retention.** In an authorized disposable npm consumer, record installed path/version and effective config/state/cache roots, pin a real or explicit synthetic local snapshot, and retain owned sync baseline/plan/receipt evidence. Exercise `ctl cache clear --all` via verified system Trash before uninstall, launch a second process and prove pinned bytes/state survive. Uninstall the owned project/global prefix using the matching usage command; retain root manifests/hashes and show npm removal leaves state/config/cache. Removing state is a separate deliberate retention choice that makes pinned refs and recovery history unavailable; no permanent-delete cleanup. Upgrade with an empty new cache must rebuild disposable indexes while preserving pinned/config/state and never adopting a baseline from old catalogs. Each branch needs actual evidence, not npm exit alone.

## Gotchas

- Manifest format/version, display name, description and main path are portable; page/version/snapshot IDs and timestamps are excluded. Keep `.ntn-skills.json` for reimport.
- Original bytes survive only while their saved source projections match remote content; page-only exports normalize Markdown. Omitted references remain excluded even when their Notion pages still exist.
- Offline package smoke deliberately uses missing transport and synthetic local snapshots. Live recipes use official `ntn` without overrides; never substitute smoke fixtures for live acceptance.
- Retained Skill inspection/import/export is not activation. Hosts keep source/freshness on an explicitly selected workflow; no imported instructions or scripts execute automatically.
- Dry-run may read network/cache but must leave remote contents unchanged. A partial/unknown reimport requires fresh readback and no automatic mutation retry.
- No downloaded/imported Skill script is auto-executed. Cleanup moves run scratch and recorded successful package-check/smoke scratch to system Trash while preserving `$RUN/evidence` and retained user Notion skills. Package-check/smoke can report scratch outside the run; only recorded successful package scratch belongs to this helper cleanup.
