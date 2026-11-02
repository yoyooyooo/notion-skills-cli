# Maintain a shared Notion library

Use a shared library's **Skills database entry** with `--database` on ordinary content commands and `--entry` on `ctl library` commands. Obtain that entry from the library you intend to maintain. Names and aliases help discovery; keep the exact record, page ID and pinned refs returned by the CLI for writes.

This guide covers the shared Skills / Files / Records model. Existing libraries that still use the earlier publication or synchronization model retain their own recovery workflow until migration is complete.

## Contents

- [Connect and read](#connect-and-read)
- [Create a native Skill](#create-a-native-skill)
- [Change existing files and metadata](#change-existing-files-and-metadata)
- [Add, delete or move a file](#add-delete-or-move-a-file)
- [Select a fixed source and restore following](#select-a-fixed-source-and-restore-following)
- [Choose a Profile and View](#choose-a-profile-and-view)
- [Keep a version across machines](#keep-a-version-across-machines)
- [Review and migrate one legacy record](#review-and-migrate-one-legacy-record)
- [Handle an interrupted operation](#handle-an-interrupted-operation)
- [Current limits](#current-limits)

Replace uppercase placeholders with values returned by your own commands. Keep the original input files and command output until a write has been verified.

## Connect and read

Inspect an existing shared entry before using it:

```bash
ntn-skills ctl library inspect LIBRARY_ENTRY
ntn-skills list --database LIBRARY_ENTRY
ntn-skills read 'REF_FROM_LIST' --database LIBRARY_ENTRY
ntn-skills files SNAPSHOT_ID_FROM_READ
```

`list` reads discovery metadata. `read` returns the selected instructions and a complete fixed snapshot. Use its pinned refs for supporting files from the same version. A current read may reuse a validated cache; `read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh` requests complete fresh validation. A pinned ref stays fixed and does not accept `--refresh`.

Create a new library only when the task includes creating its tables under an owned parent:

```bash
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

Use the returned `library.skills.database_id` as the entry. Initialization creates the shared tables and descriptor; it does not migrate another library or change machine defaults. `ctl library init --entry LIBRARY_ENTRY` validates an existing entry.

Direct edits to a bound Notion body are detected by normal current reads. After the complete edited body has been retained and verified, that whole file becomes customized. Other files retain their own ownership. Name, Description, Default Context and Router Members remain native Notion properties; a body edit does not change them.

## Create a native Skill

Prepare an ordinary folder with `SKILL.md` and any supporting UTF-8 Markdown or text files. For example:

```markdown
---
name: Release Review
description: Review a release and its operational checklist.
---

# Release review

Read [the checklist](references/checklist.md) before recommending a release.
```

Place the linked file at `references/checklist.md` in the same folder. Then preview and create:

```bash
ntn-skills create ./release-review --database LIBRARY_ENTRY --dry-run
ntn-skills create ./release-review --database LIBRARY_ENTRY
```

The CLI creates the stable Skill and File identities and shared records. Ordinary Skill folders do not need a hand-authored portable manifest. A single Markdown file is also accepted; supply `--description` if its frontmatter has no Description. `--name` and `--description` explicitly override input metadata.

In a shared library, creation uses native Skills and Files pages. The new Skill stays disabled until its complete file set has passed verification. Binary or unsupported input fails before page creation; it is never silently omitted. Keep binaries in a fixed source when consuming a mixed file tree. Omit `--storage` for this shared path; the older `--storage markdown_files` mode is rejected for a shared library.

Success returns the exact record, a verified snapshot and `create_operation_id`. A matching existing name is never permission to overwrite another Skill. If the result is unknown, preserve the exact input and original operation; see [interrupted operations](#handle-an-interrupted-operation).

Prompt and Router input still uses the existing portable v2 kind declaration. Consult `create --help` and the [portable input contract](protocol.md#portable-input-contract) for those explicit kinds. Filenames alone do not select kind.

## Change existing files and metadata

First read the current exact Skill and retain its pinned main ref:

```bash
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh
```

### Apply one set of changes

Put changed **existing** files in a separate authoring directory, preserving their logical relative paths. For example, `./changes/SKILL.md` and `./changes/references/checklist.md` can update the main body and an existing resource together:

```bash
ntn-skills apply 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --input ./changes --description 'Review the release and its rollback checklist.' --dry-run

ntn-skills apply 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --input ./changes --description 'Review the release and its rollback checklist.'
```

Omitted files remain unchanged. The pinned version must still match a fresh current read. The CLI validates every requested input and the proposed complete tree before dispatch, then executes the frozen body and nominated metadata operations in order. This is a sequential batch: a later failure can leave earlier verified edits in place. The response or error retains the original batch and its child operations; it does not roll back a later user edit.

Success reports `status: "applied"`, `verified: true`, `apply_operation_id`, the changed paths and a new pinned snapshot. Identical input reports `status: "unchanged"`. Dry-run reports a plan and sends no Notion writes.

This batch supports existing bound native files and metadata. A single isolated add or delete is also supported, but mixed or multiple layout changes currently fail with `SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED` before any write. Use the explicit [file commands](#add-delete-or-move-a-file) for those individual changes. Replacing a complete Skill with `replace --target` uses the same shared authoring rules and limits.

### Write one complete file

```bash
ntn-skills write 'PINNED_FILE_REF' --database LIBRARY_ENTRY --input ./edited-file.md --dry-run
ntn-skills write 'PINNED_FILE_REF' --database LIBRARY_ENTRY --input ./edited-file.md
```

Submit the complete replacement file. A returned file ref already contains its logical path, so omit `--path`. If selecting a page or main ref without a resource path, use `--path references/checklist.md` for the supporting file.

Main frontmatter may restate the current Name and Description, or values explicitly supplied to the same `apply`. Changing those fields inside `write` alone is rejected; additional unsupported main frontmatter is also rejected rather than discarded. A supplied `notion_page_id` must identify the exact selected Skill. Router bodies retain their generated Members index; change membership through the native relation or `update --member`.

New native authoring plans freeze the original input, the request Markdown and the exact expected native readback separately. Projection version 2 preserves authored H1 headings by sending them as native heading tags during create and file add; body writes keep their ordinary heading syntax. It projects common inline code, bold, italic and strikethrough to the native readback form. Fenced code keeps its literal content; an omitted language is sent explicitly as plain text, whose native readback label is `txt`. CRLF becomes LF and terminal line feeds are removed before projection. Every complete response must still match the frozen candidate exactly. A mismatch keeps the original operation for review, and older version 1 plans retain their original policy and request bytes.

### Update native properties

```bash
ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.' --dry-run

ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.'
```

Only nominated fields change. Omitted properties and file bodies remain intact. `--default-context` controls the native checkbox. For a Router, repeat `--member SKILL_PAGE_ID` with exact accessible members in the same shared library, or use `--clear-members`; omit both to preserve the relation. Metadata writes use Notion's native last-writer behavior and do not provide compare-and-swap.

Keep generated snapshot directories as consumption output. Editing one does not silently submit it to Notion. Explicitly choose the intended files as `write` or `apply` input and read the verified result before distributing a new snapshot. Existing local sync bindings have a separate migration and recovery path; a generated directory is not an implicit replacement for them.

## Add, delete or move a file

These commands take an exact shared Skill page ID or Notion page URL, followed by the logical file path:

```bash
ntn-skills ctl library file add SKILL_PAGE_ID references/new-checklist.md \
  --entry LIBRARY_ENTRY --input ./new-checklist.md --dry-run
ntn-skills ctl library file add SKILL_PAGE_ID references/new-checklist.md \
  --entry LIBRARY_ENTRY --input ./new-checklist.md

ntn-skills ctl library file move SKILL_PAGE_ID references/old.md references/new.md \
  --entry LIBRARY_ENTRY --dry-run

ntn-skills ctl library file delete SKILL_PAGE_ID references/obsolete.md \
  --entry LIBRARY_ENTRY --dry-run
```

Review the dry-run, then omit `--dry-run` to execute the same intent. Each command checks the complete current tree and deterministic relative Markdown links and images. Move does not rewrite references. Remove or update obsolete references deliberately and take a new read before the next change.

Add creates one new File identity and native body page. Move preserves the File ID, page and body; a following file also preserves its original fixed-source path. Delete records an explicit tombstone while retaining the page and body. A later upstream reappearance does not revive the deleted path. The main entrypoint cannot be moved or deleted through these commands. Missing permissions or a failed read are never treated as deletion intent.

## Select a fixed source and restore following

Register the exact Git commit and repository-relative root chosen for this Skill:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY \
  --commit FULL_40_CHARACTER_COMMIT --root skills/example

ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --url https://github.com/OWNER/REPOSITORY \
  --commit FULL_40_CHARACTER_COMMIT --root skills/example
```

Registration retains the immutable source identity; it does not change the current Source property or overwrite a customized file. Select the returned source ID through a generated plan:

```bash
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --source SOURCE_ID_FROM_REGISTER --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

The CLI writes this plan; keep it unchanged for execution or reconciliation. Use `--native` instead of `--source` when intentionally clearing the Source selection. Source selection changes only the native property. Customized files keep their complete Notion content until explicitly restored to following:

```bash
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library file restore-follow SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY
```

Restore uses the exact source currently selected in Notion, retains the old complete custom body, and verifies the new result before changing ownership. Moved files use their retained source path. An absent source file remains a failure with the custom content preserved; the CLI does not guess a same-named replacement or select a newer commit. The main entrypoint can also be explicitly restored.

Advanced HTTP and local mounts use `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. These commands consume an existing fixed composition plan; there is no interactive composition builder. Every file identity remains fixed by hash and size. Machine-only resource configuration uses `ctl library source resource --help`; local roots and signed HTTP retrieval addresses are not stored in shared Records. Local access requires an explicit machine/workspace binding. Restoring a local file into shared Notion records requires the additional `--allow-local-archive` flag.

## Choose a Profile and View

```bash
ntn-skills views --database LIBRARY_ENTRY
ntn-skills ctl library profile list --entry LIBRARY_ENTRY
ntn-skills ctl library profile show daily --entry LIBRARY_ENTRY
ntn-skills list --profile daily --database LIBRARY_ENTRY
ntn-skills list --view VIEW_ID --database LIBRARY_ENTRY
```

An explicit View takes precedence over Profile defaults. A Profile with no default View uses the library's first View in API order. Bare `list` retains complete explicit discovery; binding a Profile does not hide other content or grant access.

Create a Profile only when it does not already exist:

```bash
ntn-skills ctl library profile set daily --entry LIBRARY_ENTRY \
  --name Daily --enabled true --base new --default-view VIEW_ID
ntn-skills ctl library profile bind daily --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

For an existing Profile, use the exact current revision returned by `profile show` as `--base`. `profile set` replaces the full rule: omitting `--default-view` removes the previous default. The machine binding stores only the library entry and Profile ID. `profile unbind` removes that machine selection without changing shared rules.

## Keep a version across machines

An ordinary `s_...` pin addresses local immutable snapshot bytes. To make an exact complete snapshot recoverable on another machine, archive and restore it explicitly:

```bash
ntn-skills ctl library snapshot save SNAPSHOT_ID_FROM_READ --entry LIBRARY_ENTRY
ntn-skills ctl library snapshot restore SHARED_PIN_ID_FROM_SAVE \
  --entry LIBRARY_ENTRY --target SKILL_PAGE_ID
ntn-skills export RESTORED_SNAPSHOT_ID --projection snapshot --format directory --output ./fixed-snapshot
```

The receiving machine uses its own Notion authentication. Restore validates access and reads the archived bytes; it does not substitute current bodies or fetch a newer provider version. A local resource binding grants read access on that machine and does not authorize shared archival. When the exact selected snapshot contains local-restricted bytes, a new archive requires `snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY --allow-local-archive`. That flag authorizes this one archive and does not remove durable local-content restrictions. The separate `restore-follow --allow-local-archive` flag applies only to its selected native body.

## Review and migrate one legacy record

Migration uses a separate, explicit workflow. It preserves the old pages, pins and original operations while preparing one new native Skill, Prompt or supported Router. Start with the complete frozen [migration evidence input](protocol.md#shared-migration-review), including its coverage, backup and preservation inventories. Retain the original input; put newly collected evidence in a new draft. Do not reduce that inventory or change ownership, Source options or completeness merely to obtain an executable proposal.

The full-inventory plan is offline and never authorizes execution:

```bash
ntn-skills ctl library migration plan --input ./migration-input.json
```

Prepare one concrete review before adding that identity to the approved scope:

```bash
ntn-skills ctl library migration review \
  --input ./migration-input.json --legacy-id LEGACY_ID --entry LIBRARY_ENTRY \
  --files ./retained-current-files --preimages ./retained-native-responses \
  --source-files ./fixed-source.zip > ./migration-review.json
```

`--files` supplies the complete declared managed paths as a directory or ZIP. `--preimages` supplies the exact retained Notion response files named `PAGE_UUID.default.json` or `PAGE_UUID.v2.json`; their page, API/Markdown versions, request path, body hash and original response hash/size must already be frozen in each input file's `raw.native_preimage` descriptor. A materialized snapshot or a source ZIP does not replace this original native response. `--source-files` supplies every actual byte in the selected fixed Source tree, including source-only assets; omit it only when the proposal selects no Source. Extra managed-input paths and valid portable container metadata are reported separately, not silently turned into native files.

Review may read target-library and exact Router member metadata. It does not fetch current bodies or providers, write Notion, create a dispatch journal or change `approved_legacy_ids`. Inspect the complete saved `review`, its `review_id`, file conversion and Source/ownership choices. Known legacy facts may use an explicit, verifiable migration policy; for absent `Enabled` on an ordinary legacy Skill or Prompt, see the [legacy active-page policy](shared-migration-activation.md). That policy retains the original field absence and complete row/schema evidence. It does not infer following/custom ownership or repair an incomplete Router.

New reviews explicitly bind `origin.candidate.execution_policy` into their digest. Ordinary reviews use `copy_to_new_native_v1`. This boundary copies the reviewed frozen target to new native pages; it performs no source cutover or legacy retirement. Review can defer entry/file gaps that belong to other independent records while retaining the complete input and every full-plan blocker. The target's own bytes, ownership and dependencies remain required; Source gaps and unknown operation impact remain blocking under v1. A concrete review can therefore coexist with a full-inventory plan whose status is still `blocked`.

One fully retained legacy publication can instead use `copy_to_new_native_v2`. The [offline derivation script](https://github.com/yoyooyooo/notion-skills-cli/blob/main/scripts/README-migration-publication.md) reconstructs its exact committed manifest, selected fixed member, authored export and complete original native responses. Use the derived `native/` directory for `--files`, with the retained raw responses and fixed Source tree. The public review chooses v2 only for a target with that explicit publication descriptor and revalidates the proof bytes. It retains the original operation inventory and catalog coverage in the review digest. Old unknown operations and incomplete global enumeration remain unchanged; the result is an exact historical copy on new pages, without a claim that the old system has finished writing or that callers have switched. The target's own incomplete content, unsupported Source interpretation and dependent aliases still block the copy.

After explicit approval of this exact proposal, retain a separate approved input whose `approved_legacy_ids` includes the reviewed identity. Only that approval set and its derived `readiness_evidence.basis_sha256` may differ from the reviewed input. Content, Source, original preimages, target library, exact member bindings, preservation and isolation receipts remain bound to the review digest. Do not hand-edit the saved review or reuse its digest after changing those facts; collect a new review instead. Keep the independently approved `review_id` and preview the exact execution:

```bash
ntn-skills ctl library migration apply \
  --input ./migration-approved.json --review ./migration-review.json \
  --review-id MIGRATION_REVIEW_ID --dry-run
```

For either explicit copy policy, `apply` and `--dry-run` require the target's approval and complete dependency evidence. Another independent, unapproved entry's own metadata/file gaps can remain deferred while the full plan stays `blocked`. Same-page aliases, Router members and unresolved selected Source facts remain blocking; an empty approval set permits no creation. V1 also keeps its original operation-impact gate. V2 rechecks the retained publication and preserves original history without relying on an isolation declaration. Saved candidates without `execution_policy` keep the original full-plan evidence-readiness gate. Do not add or change the field in a saved review or reuse its digest for a changed policy.

Unresolved dependencies return `SHARED_MIGRATION_CREATE_BLOCKED`. When an unmarked or v1 candidate relies on supplied impact/isolation receipts whose actual contents and hashes have not been verified, preparation returns `SHARED_MIGRATION_RECEIPT_UNVERIFIED` and identifies the original operation and exact receipt references. V2 requires its actual retained publication proof instead; changing or omitting retained history invalidates the review. Both preparation and direct create execution enforce the selected policy before a new dispatch journal or native write. Preserve the full input, original operations and their recovery paths; approval or a receipt boolean alone cannot resolve a refusal.

Once these gates pass, dry-run checks current target/member metadata and returns the frozen native plan. It creates no dispatch journal and performs no current-body read or Notion write. When that exact result matches the approval, execute the same command without `--dry-run`:

```bash
ntn-skills ctl library migration apply \
  --input ./migration-approved.json --review ./migration-review.json \
  --review-id MIGRATION_REVIEW_ID
```

Execution reuses native create and keeps the new Skill disabled until its complete native file set verifies. The final snapshot check is read-only: a concurrent user edit fails verification without being adopted by that check. Success reports `status: "created"`, `verified: true`, the original `operation_id`/`create_operation_id`, `review_id`, `migration_candidate_id` and a verified pinned snapshot. This is one target, not a transaction across a library, a source cutover or permission to retire legacy callers.

Preserve the original operation on either of these failures:

| Result | Meaning and next step |
| --- | --- |
| `WRITE_OUTCOME_UNKNOWN` | An original dispatch is unsettled. Keep the frozen input, review and operation; do not repeat apply, rename the input or generate another intent to bypass it. |
| `WRITE_VERIFICATION_FAILED` with `native_create_completed: true` | The native create completed, but its current snapshot could not be verified. `current_snapshot_verified: false` and `requires_fresh_read: true` keep that distinction explicit; the original verification error remains in the details. Do not report a successful current migration or assume no write occurred. |

For either case, use only the original migration operation:

```bash
ntn-skills ctl library migration reconcile \
  --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID
```

On a machine without the original local journal, add `--target EXACT_NEW_PAGE_ID` from an existing receipt. Reconciliation reads the retained original intent/outcome only: it makes no Notion POST/PATCH, resumes no partial tree and never adopts today's body. A successful result says `verification: "original_create_outcome"`, `current_snapshot_verified: false` and `requires_fresh_read: true`; it does not supply a current pin. A later explicit current read is a separate action and follows ordinary whole-file adoption rules. Missing original facts or an invisible first create remain unresolved. Preserve them and do not use the legacy `operation resume` command for this migration family.

### Recover a known partial migration create

A disabled migration that stopped with `SHARED_CREATE_BODY_MISMATCH` can use the bounded v4-to-v5 recovery when the new projection preserves the original submitted wire bytes. Retain the existing target and original operation. Review reads the existing pages and requires their complete current bodies to match v5; it also checks the original Source, file bindings and unpublished initial ownership history.

```bash
ntn-skills ctl library migration recovery review \
  --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID \
  --target EXACT_EXISTING_SKILL_PAGE_ID
```

Save the complete output and inspect its `review_id`, original/current body evidence, preserved pages and remaining file inventory. The review labels its current observations `post_failure_current_read`. Apply that exact decision with the original approved input:

```bash
ntn-skills ctl library migration recovery apply \
  --input APPROVED_JSON --review RECOVERY_REVIEW_JSON \
  --review-id RECOVERY_REVIEW_ID --dry-run
ntn-skills ctl library migration recovery apply \
  --input APPROVED_JSON --review RECOVERY_REVIEW_JSON \
  --review-id RECOVERY_REVIEW_ID
```

Recovery preserves existing bodies and IDs, adds missing pages, updates projection metadata and initial ownership facts, then enables the fully verified tree. Success is reported as `recovered` with a current pin; the original failed outcome remains unchanged. If the recovery is interrupted or its response is uncertain, retain both operation IDs and inspect its separate completion:

```bash
ntn-skills ctl library migration recovery reconcile \
  --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID \
  --target EXACT_EXISTING_SKILL_PAGE_ID
```

Reconciliation sends no writes and publishes no current pin. A missing completion remains unresolved; another apply does not restart this recovery. Unknown original creates, changed current bodies or Source, existing ownership events and unrelated operations require their own resolution. The [protocol](protocol.md#recovery-of-a-known-partial-migration-create) defines the full supported boundary.

### Continue after an unknown recovery create

If a recovery page POST returned unknown, retain its error and inspect the current allocation through a separate continuation review. This path requires the terminal recorded by that actual serial execution, the original successful responses and the complete original approved input. Older runs without this terminal remain blocked; current pages or a reconstructed summary cannot replace it.

```bash
ntn-skills ctl library migration recovery continuation review \
  --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID \
  --target EXACT_EXISTING_SKILL_PAGE_ID
```

Save the full result. Inspect its `review_id`, accepted page IDs, retained terminal, complete current observations and `remaining_file_ids`. The failed POST stays unknown; this decision accepts the page that is visible now. An absent or changed allocation requires further resolution and is never reposted.

```bash
ntn-skills ctl library migration recovery continuation apply \
  --input APPROVED_JSON --review CONTINUATION_REVIEW_JSON \
  --review-id CONTINUATION_ID --dry-run
ntn-skills ctl library migration recovery continuation apply \
  --input APPROVED_JSON --review CONTINUATION_REVIEW_JSON \
  --review-id CONTINUATION_ID
```

Apply creates only the proven unattempted remaining files. It preserves all accepted page IDs and bodies, validates the complete tree and records completion v2. Keep the original approved input and execution evidence after interruption. Repeating this command only reconciles; another unknown stops further creation. Use the same `recovery reconcile` command above for the separate historical outcome. A missing original input, missing terminal or incomplete completion cannot be resolved by regenerating a plan or assuming the original POST succeeded.

## Handle an interrupted operation

Keep the original input, exact target, operation ID and recovery details. A matching current body or property does not prove that an unknown original request completed. Do not change input or choose a new name to bypass a pending operation. A recovery result with `verified: true` confirms its reported outcome: `not_applied` or `partial` does not mean that the requested edit completed.

| Operation | Supported next step |
| --- | --- |
| Shared body write, apply or restore-follow | Read the exact current Skill. The reader checks retained original operations before adopting new bodies. If it reports `read_again`, read once more. Missing original facts remain unresolved. |
| Native create | Retain the complete original input and operation. Repeating the same create intent takes its original reconciliation path; it does not blindly repeat a page POST. A partially created Skill remains disabled until verified. |
| Reviewed migration | `ctl library migration reconcile --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID`; add `--target EXACT_NEW_PAGE_ID` only when needed to recover the retained origin on another machine. See the [migration workflow](#review-and-migrate-one-legacy-record). |
| Reviewed partial-create recovery | `ctl library migration recovery reconcile --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID --target EXACT_EXISTING_SKILL_PAGE_ID`; verifies the separate recovery completion while preserving the original failure. |
| File add, delete or move | `ctl library file reconcile SKILL_PAGE_ID OPERATION_ID --entry LIBRARY_ENTRY` |
| Source registration | `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID` |
| Source selection | `ctl library source select reconcile ./source-selection.json --entry LIBRARY_ENTRY` |
| Profile revision | Repeat the original complete `profile set` arguments with `--reconcile`. |
| Shared snapshot archive | Repeat `ctl library snapshot save ORIGINAL_SNAPSHOT_ID --entry LIBRARY_ENTRY --reconcile`. |

These shared IDs are distinct from older Publication IDs. Do not pass them to the legacy `operation resume` workflow. An empty independent machine may be unable to distinguish an invisible first request from one never sent; preserve the original machine's pending operation instead of recreating it elsewhere.

### Review a retained body mismatch

A `needs_review` body write can retain a complete native response that differs from its frozen candidate. Inspect that original response before deciding whether to accept it as the current customized body. An unknown write, an incomplete response, or missing original evidence is not eligible for this decision.

The accepted digest is the SHA-256 of the original `response.markdown` string encoded as UTF-8. Preserve its exact bytes, including CRLF and terminal newlines; do not hash normalized content or a JSON wrapper. Preview with the exact original operation and the containing Skill page:

```bash
ntn-skills ctl library file review SKILL_PAGE_ID ORIGINAL_OPERATION_ID \
  --entry LIBRARY_ENTRY --accept-observed-sha256 EXACT_RAW_SHA256 --dry-run
```

The preview verifies the retained plan, outcome, complete original observation, current body, file binding, source selection and original parent events. If those facts still match the decision you intend to make, execute the same command without `--dry-run`:

```bash
ntn-skills ctl library file review SKILL_PAGE_ID ORIGINAL_OPERATION_ID \
  --entry LIBRARY_ENTRY --accept-observed-sha256 EXACT_RAW_SHA256
```

Completion returns `reviewed` with `decision: accepted_observed`. The original operation remains `needs_review`, and its preimage, candidate and observed response remain unchanged. The independent review retains the accepted body and an adoption event; it does not rewrite the native body or report the original candidate as applied. To make a correction afterward, perform a fresh read and submit a new explicit write from that current version.

If review is interrupted, retain its original receipt and repeat the exact review with `--reconcile`. Reconciliation only verifies the original review facts and never fills missing facts by repeating unknown writes. `--dry-run` and `--reconcile` are mutually exclusive.

## Current limits

Shared authoring currently requires existing editable bindings for changed files. Native binary creation, mixed or multiple layout changes in one `apply`, and arbitrary lossless Markdown rendering are not implemented. New plans reject Setext headings and YAML frontmatter in supporting files before any Notion write because native readback does not preserve their original structure. Main-file frontmatter is limited to the supported name and description fields; unknown fields are rejected. Excessive operation-envelope size fails before dispatch. HTTP/local composition still requires a reviewed fixed plan. These limits do not change old pins or authorize omission of input files.

New authoring plans use Markdown projection policy 5. It predicts native rich text inside visible inline-link labels, spacing between simple single-paragraph list items, excess blank block separators, the blank separator between a paragraph and its following list, and the syntax padding of unaligned tables. The original input and wire request remain separately retained. Unverified table alignment, source rows whose complete spans cannot be accounted for, and styled outer links requiring an unproved transformation are rejected before dispatch.

Inline code containing a literal backtick remains rejected because the observed native conversion can merge adjacent paragraphs. This applies to both Markdown code spans and native `<code>` content, including visible nested text. Fenced code may contain literal backticks. The CLI leaves the input unchanged; it does not silently convert inline code into a fence. Retained policy 1, 2, 3 and 4 plans continue to validate against their original renderer, expected bytes and operation identity. Migration reconstruction carries the exact policy recorded by every saved file; a new policy requires a new candidate and review digest. A policy 4 operation that stopped for a body mismatch remains bound to policy 4; installing the new renderer does not authorize replay or mark that operation successful.
