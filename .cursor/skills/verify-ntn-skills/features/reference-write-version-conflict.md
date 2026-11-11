# Pinned changes, reference pages and version conflicts

Users read editable Notion content as Markdown and apply one change against a pinned main ref or snapshot. `apply PINNED --input CHANGED_DIRECTORY` merges only the supplied files; repeated `--remove PATH` and explicit metadata flags join the same publication. Untouched files and page identity remain, main deletion is refused, and stale pins fail before effects. Use the existing dry-run, property-preservation and stale-conflict cases below for this public entry. `write` remains available when only one logical file should change.

Stable manual edits to a committed Notion page are visible through `read PAGE_ID --refresh` without an inspect/accept operation. The old pinned read stays immutable; a write against that old pin still fails. Reading current content does not accept it as the outcome of an unfinished original publication or change a tracked/local baseline.

Single-file write, exact-target whole-Skill replacement and sync all use strong mutation preconditions independent of read TTL. `write` changes file content only; `update` changes page properties. [Command map](README.md#accepted-design-coverage), [recovery matrix](sync-cache-verification-plan.md#interruption-and-unknown-outcomes) and [protocol](../../../../docs/protocol.md#mutation-contract) own detailed contracts. Refresh current-page live readbacks; keep pinned reads immutable. This recipe is not proof until exercised by the main verifier.

The [independent installed author lifecycle](import-create-recovery-dry-run.md#independent-installed-author-lifecycle) connects these shared-native entries to the existing package gate. It proves exact canonical readback, body/metadata separation, sparse apply versus one-layout-change replace, immutable old pins and original-outcome recovery with a real installed Node CLI and an owned controlled service. Native main frontmatter that conflicts with Name/Description is rejected before writing; it is not an implicit metadata update. Native canonical Markdown and submitted source bytes remain separate expectations.

## Sub-features

- `reference-read`: complete inclusion, nested paths and relative links in snapshots.
- `write-file`: main, reference and Files-backed asset replacement.
- `write-selectors`: returned file ref or pathless target plus a separate path.
- `write-unchanged`: identical input without upload or mutation.
- `write-dry-run`: preflight with remote state unchanged.
- `write-conflict`: reference/main edits invalidate older pinned baselines.
- `write-properties`: main frontmatter edits preserve Name, Description and Default Context; explicit property updates use `update` with the same version guards.
- `native-heading-literals-v11`: predict literal text escaping inside supported native heading bodies while preserving retained v1–v10 projections, original wire bytes and strict complete-body comparison.
- `native-body-spacing-v12`: predict the observed top-level heading-to-paragraph and paragraph-to-fence separators for explicit body writes; preserve v1–v11 policies, original wire and exact readback checks.
- `native-create-heading-spacing-v12`: predict the independently observed creation separators from a top-level ATX heading to a list or fenced code, without changing the body-write rules or retained v1–v11 policies.
- `body-review-native-metadata-v2`: preserve the original operation's frozen native mode and complete frontmatter when explicitly accepting its complete observation, while reconciling existing v1 review identities without writes.

## How to get to it (user POV)

Select the affected entry points and retain their outcomes separately:

- `apply` of one pinned main ref/snapshot with sparse changed files, explicit removals and properties; dry-run, unchanged files, stale rejection and original-operation recovery.
- `read` and `files` of a current References-backed Skill; relative read of an included reference.
- `write` of a returned main-file ref, a returned reference-file ref, and a pathless target with `--path`.
- `write` with a name, invocation alias, page ID/URL, unpinned ref, pinned ref or snapshot ID: prove each selector form actually claimed.
- Main-file default path, an existing reference path, an approved new reference path and a non-reference asset when the selected database has Files.
- `write --dry-run`, identical-input unchanged, successful update and stale-baseline `WRITE_CONFLICT`.

## Native heading literal projection

For AH-681, the complete original `scripts/test/corpus/UserNoDeadlock/report.md` and its independent, untruncated Markdown v2 response differ at one heading: `CHECK_DEADLOCK` is returned as `CHECK\_DEADLOCK`. Retain the original 267-byte v10 prediction and the complete 268-byte observation. A new v11 policy must match that observation without changing the submitted wire, the original plan or the response normalizer; saved v1–v10 policies keep their declared behavior.

Before implementation, record a failing pure projection test against the full captured body. Cover H1–H4 literal characters with parsed heading spans, existing escapes, inline/native code, link destinations, tag attributes and structural heading markers. H5/H6 remain explicitly unsupported by the original native serializer. Fenced code and unrelated paragraph/list text must not be reinterpreted as headings. Re-run all 35 original statechart Markdown inputs with explicit v10 and compare every projection field to a separately saved pre-change baseline; v11 must preserve every wire and change only the observed heading file in that tree. Keep the actual input/response hashes and complete replay receipt outside the checkout.

These pure checks establish deterministic forward projection only. Original-operation recovery, any new dispatch, installed CLI and fresh remote verification retain their separate mapped gates; a new projection must not authorize rewriting an already acknowledged body or normalize an unknown response into success.

## Native body-write document spacing

The AH-703 four-source Skill's original public write froze an 8,195-byte v11 body-write candidate. Its independent complete Markdown v2 response is 8,214 bytes: fourteen top-level heading-to-paragraph separators and five paragraph-to-fenced-code separators each contain one additional LF. All nineteen separators already exist in the complete retained native preimage. The observed result preserves that entire preimage and appends the reviewed owned note. Keep the original `needs_review` operation and its exact v11 candidate; this observation does not authorize replaying its body request.

Before implementing v12, retain failing tests for the two real boundary shapes. Verify existing blank separators are idempotent, fenced contents and nested blocks keep their bytes, leading-LF behavior is unchanged for body writes, and every retained v1–v11 policy validates its original input and wire. Do not relabel a body write as creation: creation has a separate H1 wire rule. Replay the complete frozen input against the independent 8,214-byte response outside the checkout, and compare all historical projection fields with the pre-change baseline.

ProjectionRace and UpdateCommit do not prove Markdown syntax or serialization. This change adds no write authority, retry, ownership transition or relaxed body comparator. Existing original-operation review may accept a separately reviewed complete observation; a new projection version applies only to newly prepared plans.

The original native inventory item 143 provides a separate creation observation: its complete 2,816-byte v11 candidate differs from the complete 2,822-byte native response at six LF separators only. Five are heading-to-list boundaries (four unordered and one ordered); one is heading-to-fenced-code. The original page POST is acknowledged and the page remains disabled; no manifest or later write was sent. Preserve that original operation and page. The older fixed-Git prefix-recovery validator excludes this native plan, so a matching v12 prediction alone cannot claim recovery or authorize another page create.

Policy 12 has not been committed, packaged or dispatched. Its creation-only extension covers those two observed token boundaries, while its existing body-write results remain byte-for-byte fixed. Freeze all prior v12 body examples and both complete real inputs before the extension, retain failing creation tests, verify existing blank separators and fenced/nested content, then replay the entire 2,822-byte observation and both inputs under every old policy. Do not broaden unsupported list grammar or use a smaller substitute input to claim an import succeeded.

## Original body review and retained native metadata

The four-source main review preview exposed a second boundary: its original write candidate retained mode `100644` and the full authored YAML, including the license, but v1 review rebuilt only the observed body object ID, hash and byte count. An adopted event replaces retained content, so omitting those fields loses file metadata. A new v2 review must copy only the original candidate's frozen native metadata; it must not infer fields from the current page, later events or another source. Exact observed body bytes, normalization and immutable original outcome remain independently bound.

Keep one review operation ID per original body write. Before choosing a plan version, inspect the existing local dispatch barrier and shared review plan. Existing v1 plans, events and receipts retain their exact identities and historical metadata-free content; completed and partially dispatched v1 reviews only reconcile. A missing original review plan behind a visible receipt, or disagreement between local and shared plans, is not permission to create a v2 replacement. A preview with no dispatched/local/shared review intent can prepare v2 under the same original-operation identity.

Credential rotation in the same Store must not hide an original review dispatch. Check only the existing opaque file/operation journal address across credential scopes, without reading another scope's payload. A matching address selects read-only reconciliation; it is not completion evidence. Retain the independent counterexample where an invisible v1 review request under the previous scope otherwise caused four new v2 Records to be dispatched. An empty independent Store cannot infer another host's unknown request from absent remote facts; this boundary does not establish distributed mutual exclusion or provider CAS.

Before implementation, retain red tests for a main header with additional YAML and license fields and a supporting native file with executable mode `100755`. Prove v2 plan/event metadata equals the original candidate, including known absence, while body writes remain zero. Seed independent historical v1 facts and verify cold completed replay, partial/unknown barriers and original-write reconciliation without changing their bytes or sending Records/body writes. Retain the existing four-stage unknown-result matrix. Finite lifecycle models do not prove this metadata codec or historical review-version selection; report these concrete compatibility checks separately.

## Driving it with control-ntn-skills

Preconditions:

- Follow the [index](./README.md); one writer owns the selected database. Reference proof requires a selected Skill with rich-text References. Files-backed arbitrary asset proof requires Files.
- Bind `PAGE_ID`/`SNAPSHOT`/`REF` to actual read results. Choose `REFERENCE_PATH`/`REFERENCE_REF` from `files`; `RELATIVE_PATH` is a real included link. `INPUT_FILE` is its approved full replacement. Bind `MAIN_INPUT`, `CHANGED_FILE` and `NEW_REFERENCE_INPUT` to approved real local inputs, and `NEW_REFERENCE_PATH` to their approved safe `references/**/*.md` path. Do not change retained user content just to force a conflict.
- Save the complete baseline manifest, hashes, metadata, page/reference identities and fresh remote contents under `$RUN/evidence`.

- **Reference materialization.** Obtain a current snapshot and list all files. Read the selected reference and follow a real relative link from its containing pinned ref. The listed inclusion set must match References; nested filenames and links to included pages become relative paths, while external links/code remain intact. Read of every included page must succeed; partial/inaccessible inclusion is an error rather than a shortened successful Skill.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$SNAPSHOT"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$REFERENCE_REF"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$RELATIVE_PATH" --from "$REFERENCE_REF"
  ```

- **Typed-link split and source-byte proof.** Exercise a reference with one link whose label crosses code/plain rich-text spans. Fresh read and publication-stability verification must agree after Notion emits adjacent Markdown links, while changed text, separated links and different destinations fail. For a reference with nested quote/list children and an included-page destination, compare source export against every frozen source file, not only the live-page verifier; change an instruction in the owned fixture and confirm the preserved ZIP cannot hide it.

- **Write preflight.** Preview the selected approved file replacement against the pinned file ref. Fresh unpinned read/files afterward must show unchanged bodies, properties, reference membership and file bytes; network reads and cache population are allowed. Preserve the decision/error and before/after proof.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$REFERENCE_REF" --input "$INPUT_FILE" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Existing reference and separate-path entry.** Write the approved reference replacement, then read current state and compare all files. Only that logical file changes; its page ID is retained and other files are preserved. Rebind `CURRENT_SNAPSHOT` to the fresh read result before the second entry. Writing identical replacement through pathless snapshot plus `--path` returns `action=unchanged`, `unchanged=true` without upload/mutation; capture version and hash stability.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$REFERENCE_REF" --input "$INPUT_FILE" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$CURRENT_SNAPSHOT" --path "$REFERENCE_PATH" --input "$INPUT_FILE" --database "$DATABASE"
  ```

- **Main and new reference entries.** Run each only with approved inputs. Main replacement changes only file content; frontmatter name/description never update Name/Description properties, and Default Context remains unchanged. Capture those properties before/after. Shared native main input that disagrees with current metadata must fail with `SHARED_METADATA_CONFLICT` and zero writes; keep that boundary separate from legacy body-only frontmatter handling. Property-only changes use `update EXACT --name TITLE --description DESCRIPTION --default-context true|false` with only the requested flags and a fresh pinned baseline; retain separate readback and stale-baseline rejection evidence. The legacy new-reference route allocates a child page, adds its labeled path to References and restores page links; read/files must show it while retaining other files. Shared layout changes use their isolated native file-management boundary. For a Files-backed asset, use an actual selected asset path/input with the same separate-path invocation and prove exact bytes.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$PAGE_ID" --input "$MAIN_INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$PAGE_ID" --path "$NEW_REFERENCE_PATH" --input "$NEW_REFERENCE_INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$PAGE_ID" --database "$DATABASE" --refresh
  ```

  To cover other shared selector entries, use each actual CLI-returned identity with an identical approved input or dry-run, recording its selected page/path and result separately. An unchanged write of the default main path does not prove a reference update.

- **Stale baseline.** Save `OLD_REF` before an independently approved differing main/reference update. Perform that update through the current target and read back, then attempt the approved edit against `OLD_REF`. Expect `WRITE_CONFLICT`; a reference-only change must also invalidate the old main-file baseline. Read current state again and prove the rejected write did not change it. Retain the actual stale/current version IDs and attempted command.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$PAGE_ID" --path "$REFERENCE_PATH" --input "$CHANGED_FILE" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- write "$OLD_REF" --input "$MAIN_INPUT" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  ```

- **Warm-cache conflict.** Retain OLD_REF and warm its current observation, then independently edit only the approved owned Notion reference through the native Notion editor. Attempt the pinned write before a refresh; it must reject the actual newer version rather than trusting TTL. Refresh PAGE_ID afterward and prove the independent edit survived. Keep this editor branch distinct from a CLI write followed by its own observation publication.

- **Advanced saved-plan local synchronization.** Use a dedicated authorized Skill and logical scratch directory, including actual relative/multi-hop parent/root and per-file links for link claims. Record links, real destinations, complete hashes, baseline/plan/receipt evidence and an unrelated sentinel through product outputs/backup. Mutable bindings, bases and operations belong to the SQL product boundary; inspect operations with `ctl operation show`. Bind never copies content; equal contents can initialize, otherwise explicitly select the initialization source. Set BINDING to a unique scratch label for --as, then retain the returned binding ID/label. Bind SYNC_PLAN_ID/FILE to product results, not helper IMPORT_PLAN, and SYNC_OPERATION_ID to the actual apply operation ID.

  ```bash
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local bind "$PAGE_ID" --path "$LOCAL_DIR" --as "$BINDING" --database "$DATABASE" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local bind "$PAGE_ID" --path "$LOCAL_DIR" --as "$BINDING" --database "$DATABASE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local plan "$BINDING" --from notion
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local apply --plan "$SYNC_PLAN_ID"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local status "$BINDING"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local status "$BINDING" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local plan "$BINDING" --output "$SYNC_PLAN_FILE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local apply --plan "$SYNC_PLAN_FILE"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local plan --all
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$PAGE_ID" --database "$DATABASE" --refresh
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl operation reconcile "$SYNC_OPERATION_ID"
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local unbind "$BINDING" --dry-run
  bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl sync local unbind "$BINDING"
  ```

  Initialization uses --from notion only when that authorized source is intended. Subsequently edit an approved local reference for push, independently edit a Notion reference for pull, and inspect fresh complete readback/local hashes after each apply. Two-sided differing edits conflict; choose --from local or notion only under authorization for a reviewed resolution plan. Batch proof needs actual independent copies/candidates. Plans and status cannot move bases; only verified convergence can. Copied plans retain resource/scope/version/base/hash/link checks; retarget a link only in a disposable fixture and verify stale rejection. Capture system Trash paths for removed/replaced bytes and prove links/unrelated content survive. Filesystem commit guards do not establish atomic protection from external retargeting. Naturally interrupted sync retains receipts and fences affected resources; reconcile reads outcomes without replay before new apply. Deterministic R/L cases need their own recorded evidence. Unbind retains contents/bases/plans/receipts and invalidates old plans.

## Gotchas

- The References property is the complete inclusion list. Pages linked only in the body remain online links; duplicate paths fail with `REFERENCE_PATH_CONFLICT`.
- A file-path ref cannot combine with `--path`. Snapshots are immutable baselines, never destinations. Old credential-scope snapshots require a fresh online baseline before writing.
- Without Files only main/reference Markdown is accepted and normalization applies. Main frontmatter must have a valid name/description; any `notion_page_id` must match the target. Reserved portability paths cannot be written directly.
- Client preflight is not atomic compare-and-swap. Partial/unknown writes require fresh current readback without automatic retry; unfinished sync uses retained receipts and reconcile. Neither current read refresh nor cache clear can initialize/advance the common baseline.
- These are recipes, not existing proofs. No script is auto-executed. Cleanup removes scratch only and preserves `$RUN/evidence` plus retained user Notion skills.
