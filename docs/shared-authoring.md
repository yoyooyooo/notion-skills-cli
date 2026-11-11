# Maintain a shared Notion library

Use a shared library's **Skills database entry** with `--database` on ordinary content commands and `--entry` on `ctl library` commands. Obtain that entry from the library you intend to maintain. Names and aliases help discovery; keep the exact record, page ID and pinned refs returned by the CLI for writes.

This guide covers the shared Skills / Files / Sources / Records model. Existing libraries that still use the earlier publication or synchronization model retain their own recovery workflow until migration is complete.

## Contents

- [Connect and read](#connect-and-read)
- [Use the remote Skill in Pi](#use-the-remote-skill-in-pi)
- [Create a native Skill](#create-a-native-skill)
- [Adopt a draft created in Notion](#adopt-a-draft-created-in-notion)
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

`list` reads discovery metadata. `read` returns the selected instructions and a fixed snapshot with a complete file inventory. Supporting Markdown loads with the selected instructions; non-document bytes are fetched when requested from that exact snapshot. A current read may reuse a validated cache; `read SKILL_PAGE_ID --database LIBRARY_ENTRY --refresh` requests fresh current-state validation. A pinned ref stays fixed and does not accept `--refresh`. Use `export` or an authoring read when you need every file's bytes.

Create a new library only when the task includes creating its tables under an owned parent:

```bash
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

Use the returned `library.skills.database_id` as the entry. Initialization creates the shared tables and descriptor; it does not migrate another library or change machine defaults. `ctl library init --entry LIBRARY_ENTRY` validates an existing entry.

New databases are full-page, not inline, and are named **Skills**, **Files**, **Sources** and **Records**. No `[library-...]` suffix is required. Display names may change without changing identity: attachment and completed-operation readback use the registered descriptor's exact database, data-source and property IDs. During initialization, each initial table POST carries its operation ID, parent and role in an internal `ntn-skills-table:v1` description; the completed Skills descriptor replaces its temporary marker. Keep these internal descriptions intact. Unregistered databases under a chosen parent block a new initialization rather than being adopted by title, so choose a dedicated parent or attach the exact established entry.

Direct edits to a bound Notion body are detected by normal current reads. After the complete edited body has been retained and verified, that whole file becomes customized. Other files retain their own ownership. Name, Description, Default Context and Router Members remain native Notion properties; a body edit does not change them.

`Enabled` controls ordinary current consumption. `Default Context` remains an optional author-managed organization and View-filter attribute, not another enablement or full-body injection switch. A host uses the selected View result without applying the checkbox twice. Keep existing schema IDs, values and explicit authoring options; this contract does not rename, remove or automatically hide a user column. An unfiltered View remains unaffected by this checkbox, while a View that explicitly filters it follows ordinary metadata freshness.

## Use the remote Skill in Pi

Use a shared-capable `pi-context-broker` installation. Add the selected library to Pi's existing `~/.pi/agent/context-broker/config.yml`, preserving any unrelated sources and preferences:

```yaml
sources:
  - type: notion
    id: shared
    namespace: shared
    database: LIBRARY_ENTRY
```

Replace `LIBRARY_ENTRY` with the exact Skills database entry. The Broker uses its packaged CLI unless this source explicitly supplies a `command` argv array. Existing Notion authentication remains in place; do not copy credentials or another machine's SQLite state. A standalone CLI upgrade does not upgrade the Broker's bundled CLI, so use matching candidate or released artifacts when changing shared contracts.

Start a new Pi session after changing the installed extension. The selected/default native View supplies the metadata directory; full `$` discovery also includes accessible Skills outside that View. Submit `$ALIAS@shared` with the actual alias from `list`, or use Pi's advertised `/skill:` entry. Selection loads the complete main instructions and fixes a snapshot; relative resources resolve from that same snapshot. Descriptions and Router member indexes alone do not count as loaded Skill instructions.

Direct Notion edits are observed by later current reads under the declared cache policy. Existing active sessions and explicit pinned refs retain their selected version. To inspect the latest version explicitly, use `read REF --database LIBRARY_ENTRY --refresh`; do not expect a historical pin to change. Disabling the native Skill removes it from current discovery and blocks a new current activation, without rewriting its retained history.

Pi does not require OMP or Tern. For cross-repository development and independent installed-host proof, use the [Broker consumption verification map](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/broker-consumption.md#pi-only-mainline). That recipe separates CLI, real Pi with a controlled provider, and an authorized real model. It does not change daily host configuration or publish packages automatically.

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

## Adopt a draft created in Notion

A manually created page can remain disabled and unregistered while you draft it. It stays outside the consumer directory and does not prevent other valid Skills from being listed. To register that existing page, complete its native Name and Description, set Kind to `skill`, and keep Enabled unchecked:

```bash
ntn-skills adopt SKILL_PAGE_ID --database LIBRARY_ENTRY --dry-run
ntn-skills adopt SKILL_PAGE_ID --database LIBRARY_ENTRY
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring
```

Adoption preserves the original page, complete body, metadata and `Enabled=false`. It derives stable Skill and main File IDs from the library and original page, retains the body and initial adopted event in Records, and patches only Skill ID and Main File ID. The original Skills page remains `SKILL.md`; no replacement Skill, separate main File page or body PATCH is created.

This entry is for an initial native Skill: Skill ID, Main File ID, Source, Projection, References and managed relations must be empty, with no existing Files or Records lifecycle. A disabled empty-ID directory entry alone does not establish those conditions. Conflicting existing bindings are preserved for their existing workflow. Name/Description/Kind must be valid before the CLI reads its files or body.

Success returns `adoption_operation_id` and the next authoring-read command. Keep that original operation if interrupted. `adopt SKILL_PAGE_ID --database LIBRARY_ENTRY --reconcile` verifies the original retained outcome without repeating writes; `verification: "original_adoption_outcome"` and `enabled_at_adoption` describe that history. Take a fresh authoring read to establish current content. Do not manually fill identity fields or create a duplicate page to bypass an unresolved operation.

## Change existing files and metadata

First read the current exact Skill and retain its pinned main ref:

```bash
ntn-skills read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring
```

`--authoring` accepts an exact current page ID or URL, including a disabled registered draft, and always verifies its complete tree online. It returns a fixed snapshot without publishing disabled content as a current consumer observation. Offline/max-age/from and pinned targets are incompatible with this mode. Existing write/update/apply/replace and file add/move/delete commands enter the same exact author scope automatically. Ordinary current `read` and `use` continue to reject disabled content; historical pins remain immutable.

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

Native authoring plans freeze the original input, the request Markdown and the expected native readback separately. Policies 1–13 retain their exact-readback contract for existing authoring and recovery operations. New [inventory imports](inventory-import.md) use policy 14 for native Skills, fixed Git, mixed local Git overrides and supported retained-source members. They accept presentation differences and record the complete first Notion readback as the page baseline. Native and custom consumers use that Notion content; following files still come from their fixed source. Mixed imports preserve their source ancestors and pre-deletion content. This import policy does not authorize overwriting an existing body or reinterpret an older operation.

The existing authoring projection preserves authored H1 headings by sending native heading tags during create and file add; body writes keep ordinary heading syntax. It predicts common inline code, bold, italic and strikethrough. Fenced code keeps literal content. CRLF becomes LF and terminal line feeds are removed before projection. An exact-readback mismatch keeps the original operation for review. These older rules are not a byte-roundtrip requirement for policy-14 imports.

### Continue an original create after an exact body correction

Keep the failed create's complete `error.details.recovery.plan`, original operation ID and acknowledged main page. A known `SHARED_CREATE_BODY_MISMATCH` can remain unresolved even after an explicit edit restores that same page to the exact frozen candidate. Repeating `create` does not erase the original failure. Review that precise case through the public original-create commands:

```bash
ntn-skills ctl library create recovery review ./original-create-plan.json \
  --entry LIBRARY_ENTRY --target ORIGINAL_MAIN_PAGE --output ./restoration-review.json

ntn-skills ctl library create recovery apply ./original-create-plan.json \
  --entry LIBRARY_ENTRY --review ./restoration-review.json --review-id RETURNED_REVIEW_ID --dry-run

ntn-skills ctl library create recovery apply ./original-create-plan.json \
  --entry LIBRARY_ENTRY --review ./restoration-review.json --review-id RETURNED_REVIEW_ID

ntn-skills ctl library create recovery reconcile ./original-create-plan.json \
  --entry LIBRARY_ENTRY --target ORIGINAL_MAIN_PAGE
```

This bounded route accepts an ordinary native Markdown create whose only allocated native page is the original main. It checks the same library, original full input, failed outcome, complete original request/ACK set, unchanged metadata and relations, and complete current Markdown. The body must equal the original candidate exactly; an automatic hyperlink is not normalized away. Review and dry-run do not write. Apply preserves the main page and old `needs_review` fact, resumes only the original never-dispatched file suffix, verifies the full tree and original initial events, and retains a separate restoration completion. It does not patch an existing body or replay an unknown request. An acknowledged suffix whose readback was interrupted is observed by its exact original ACK before any further dispatch.

Use the original credential scope and Store for review/apply because they contain the original durable request receipts. An independent Store can later reconcile the shared completion without those local receipts; that historical verification still needs a fresh `read` for current content. Inventory and fixed-source recoveries retain their own commands. `ctl operation show skill-create-…` identifies this native-create family and directs the caller to the original-plan route; it does not treat the identifier as a legacy resumable operation.

### Update native properties

```bash
ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.' --dry-run

ntn-skills update 'PINNED_MAIN_REF' --database LIBRARY_ENTRY \
  --name 'Release Readiness' --description 'Check the release and rollback procedure.'
```

Only nominated fields change. Omitted properties and file bodies remain intact. `--default-context` controls the native checkbox. For a Router, repeat `--member SKILL_PAGE_ID` with exact accessible members in the same shared library, or use `--clear-members`; omit both to preserve the relation. Metadata writes use Notion's native last-writer behavior and do not provide compare-and-swap.

To make a reviewed Skill available, or disable it again:

```bash
ntn-skills update SKILL_PAGE_ID --database LIBRARY_ENTRY --enabled true
ntn-skills update SKILL_PAGE_ID --database LIBRARY_ENTRY --enabled false
```

The CLI verifies the complete current tree and unresolved original-operation barriers before updating the nominated property. A normal edit to a disabled draft preserves its disabled state. Enabled governs current availability, not permission to inspect an accessible page.

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

### Link the new reference from the original Skill

Keep the add result's actual path and `page_id`. Take a new `read SKILL_PAGE_ID --database LIBRARY_ENTRY --authoring` because adding the file changed the complete tree. Append a descriptive link to the new logical path while preserving existing main content and metadata:

```markdown
Read [the new checklist](references/new-checklist.md).
```

Submit the complete edited main file with `write PINNED_MAIN_REF --input ./SKILL.md`. The writer resolves same-owner relative paths through the fresh snapshot's exact native bindings before sending the body. Existing references and the new checklist therefore remain clickable in Notion; CLI reads render those native URLs as the same resource paths, and the returned pin fixes both bodies. Explicit native Notion URLs also work. External URLs, source-only resources, foreign Skill refs and code literals are not guessed into native pages. An unchanged complete read result returns unchanged without a body PATCH or new Records publication just to canonicalize URLs. The reference is a Files-table page related to its Skill, not a physical child page to be recursively traversed. File add alone does not edit the main body.

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

To submit a request for later processing, initialize the request fields once, then submit the exact current file:

```bash
ntn-skills ctl library file request-schema --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library file request-schema --entry LIBRARY_ENTRY
ntn-skills ctl library file request SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY --submit --dry-run
ntn-skills ctl library file request SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY --submit
ntn-skills ctl library file request SKILL_PAGE_ID references/checklist.md \
  --entry LIBRARY_ENTRY --process
```

`--submit` retains the complete body identity, ownership frontier, File ID and Source definition in Management Receipt. The Notion Management Request dropdown expresses intent; changing it alone does not authorize a body replacement. Processing permits a selection advance within the same submitted Source definition and member. Later body edits, cancellation or rebinding require a new explicit submission. Choose the Source definition before submitting if the request should follow a subsequent selection from that definition. Reprocessing a verified completed request adds no writes. `--reconcile` verifies the original operation and may publish result metadata, but never repeats its body write. Schema initialization does not install a Notion button or automation.

Advanced HTTP and local mounts use `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. These commands consume an existing fixed composition plan; there is no interactive composition builder. Every file identity remains fixed by hash and size. Machine-only resource configuration uses `ctl library source resource --help`; local roots and signed HTTP retrieval addresses are not stored in shared Records. Local access requires an explicit machine/workspace binding. Restoring a local file into shared Notion records requires the additional `--allow-local-archive` flag.

## Choose a Profile and View

```bash
ntn-skills ctl views --database LIBRARY_ENTRY
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

On a machine without the original local journal, add `--target EXACT_NEW_PAGE_ID` from an existing receipt. Reconciliation reads the retained original intent/outcome only: it makes no Notion POST/PATCH, resumes no partial tree and never adopts today's body. A successful result says `verification: "original_create_outcome"`, `current_snapshot_verified: false` and `requires_fresh_read: true`; it does not supply a current pin. A later explicit current read is a separate action and follows ordinary whole-file adoption rules. Missing original facts or an invisible first create remain unresolved. Preserve them and do not use the legacy `ctl operation resume` command for this migration family.

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

### Recover an acknowledged Source admission

A fixed Git Source admission has its own recovery commands. Preserve the complete original plan, target page and original runtime. `ctl library sources recovery review ORIGINAL_PLAN --entry ENTRY --target ORIGINAL_PAGE --output REVIEW_JSON` prepares a versioned correction for a supported original admission. Inspect its digest and run `ctl library sources recovery apply ORIGINAL_PLAN --entry ENTRY --review REVIEW_JSON --review-id REVIEW_ID --dry-run` before the single actual apply. Existing pages and bodies remain intact; only a proven undispatched suffix may create pages.

When a v10 recovery has already acknowledged every native page and stopped before metadata or initial ownership writes, use the `sources recovery continuation review` and `sources recovery continuation apply` subcommands with the same arguments. The review independently checks complete v11 bodies and every original request/ACK. Its dry-run includes separate immutable full ACK proofs and corrected body facts, as well as the initial events and permitted metadata writes. It creates no native page and replaces no body. Missing original evidence or a changed current body remains blocked.

Both workflows use `ctl library sources recovery reconcile ORIGINAL_PLAN --entry ENTRY --target ORIGINAL_PAGE` after an uncertain result. Reconciliation verifies the original historical completion without writes; a separate fresh consumer read verifies current content. The [protocol](protocol.md#acknowledged-source-admission-recovery) lists supported versions and exact boundaries.

## Manage an active origin

Use `ctl library sources list --entry ENTRY`, `show SOURCE --entry ENTRY`, and `members SOURCE --entry ENTRY` for complete metadata/configuration and the forward relation inventory. Sources is independent from the `Selected Version` field: editing its ref, roots or options does not mutate a running Skill snapshot. `check` and `fetch` are provider reads only; `ctl library sources prepare SOURCE --target SKILL_PAGE --entry ENTRY --output PLAN` freezes one exact member and validates its current ownership. `ctl library sources apply PLAN --entry ENTRY --dry-run` rechecks the original plan. Explicit apply retains the selected manifest and required Notion facts before selecting its fixed version. Public fixed Git resources can remain at that exact commit; retained sources preserve the complete archive. Old custom files and old snapshots remain intact.

`put --input DEFINITION_JSON --expect FINGERPRINT` uses the last `show` fingerprint; use `absent` only for a new stable Source ID. `bind SOURCE --target SKILL_PAGE --member MEMBER --expect-origin PAGE_OR_NONE` changes only Origin/member, not content. Sources may represent generic Git/GitLab or exact Linear content without a GitHub-specific database schema. Read the [source management guide](sources-management.md) before choosing providers, creating native content from fetched files, or proceeding after an unknown operation. `sources reconcile PLAN --entry ENTRY` observes the exact original selection without retrying its write.

## Complete directories and raw resources

The active library uses Skills, Files, Sources and Records. Sources owns mutable provider configuration and the Origin/member relationship; Records continues to own the exact selected content version. Skills pages remain the main editing surface; editable supporting pages stay in Files with a stable Skill relation and logical path. Existing scripts, binary assets and source-only resources may be preserved in a complete immutable Notion-resident bundle in Records. They need not acquire invented native Markdown pages. Ordinary `list`, `read`, pinned resource reads and directory `export` use the same public interface for these bundles.

A retained Source reconstructs its content from checksum-bound Records chunks without the original machine or upstream provider. A fixed Git Source retains the exact commit, paths, hashes and modes; a cold ordinary read verifies the complete directory and Markdown references while fetching other resources when requested. Already retained pinned bytes work offline. A missing pinned resource can be acquired only through that pin's frozen source identity, and `--offline` fails if those bytes are absent. Authoring and full export verify all files. Current reads still verify editable pages and preserve whole-file customizations; changing a Source definition does not move an active pin.

Use the [reviewed inventory import](inventory-import.md) for complete native, unchanged upstream or locally modified upstream input. It freezes the explicit local manifest and reuses the original create journal. Subsequent raw resource changes use `ctl library resource`; their stable Files pages hold management metadata and notes while immutable Records hold exact bytes and executable modes. Management-page Markdown is not the resource payload. Resource operations never execute a script or delete the local input.

Library history, original source configurations and original page responses are preserved as archive records and attachments. Original incomplete operations retain their old outcomes. The archive is useful for audit and explicit restoration; it is not an alternative current content source. After complete new-library verification, obsolete database containers can be moved to Notion Trash without permanently deleting their recovery trail. Only the new Skills database should remain registered in the daily CLI/Broker configuration.

For renamed or relocated pages, copy the actual returned shared ref and stable IDs. Database display names, old page links, cached aliases and the first 25 entries of an inline relation do not substitute for a complete file/member inventory. Default-context and source-specific Views retain their filtering in the new library; large Router relations require complete pagination. Disabled retired content stays outside normal discovery.

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

These shared IDs are distinct from older Publication IDs. Do not pass them to the legacy `ctl operation resume` workflow. An empty independent machine may be unable to distinguish an invisible first request from one never sent; preserve the original machine's pending operation instead of recreating it elsewhere.

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

New review plans use version 2 and retain the original write candidate's complete native mode and frontmatter, including additional YAML fields and license text. The accepted body has its own observed hash and byte count; review does not replace file metadata with a body-only object. Metadata absent from the original candidate remains absent.

If review is interrupted, retain its original receipt and repeat the exact review with `--reconcile`. Reconciliation only verifies the original review facts and never fills missing facts by repeating unknown writes. Existing version 1 plans, events and receipts retain their original identities and contents, including their historical metadata omission. The review identity remains unique to the original body write; a missing original plan or conflicting versions cannot authorize a replacement review. `--dry-run` and `--reconcile` are mutually exclusive.

## Accepting the current version after an unknown write

An original body write can have no retained outcome even when its exact adoption event is later visible. The explicit `accept-current` command records an independent decision to accept the current version. It requires that existing exact event, a complete fresh body equal to the original candidate, and unchanged file identity, Source and parent frontier. It preserves the original outcome as `unknown`.

Use the `body_write_operation_id` returned by the actual failed dispatch. A preceding dry-run may have a different observation identity. Hash the exact current `response.markdown` UTF-8 bytes, and preview the decision with the containing Skill page, including when the changed file is a resource:

```bash
ntn-skills ctl library file accept-current SKILL_PAGE_ID ORIGINAL_OPERATION_ID \
  --entry LIBRARY_ENTRY --accept-observed-sha256 EXACT_RAW_SHA256 --dry-run
```

After reviewing that exact candidate and event, execute the same command without `--dry-run`. A successful result is `reviewed` with `decision: accepted_current` and `original_write_outcome: unknown`. This creates only the independent immutable decision. It does not replay the body PATCH, invent an adoption event or manufacture an `applied` outcome for the original operation.

An uncertain decision write retains its dispatch. Use the same command with `--reconcile` for read-only verification. After verified acceptance, a fresh `read` may return `SHARED_BODY_WRITE_RECONCILED` with `read_again: true`; read again to obtain the current snapshot. Original failures, preimages, candidates and historical pins remain available.

## Current limits

Automatic source projection updates that would change an existing editable Markdown body still stop with `BODY_REPLACEMENT_UNSAFE`: the current Notion API boundary supplies no proven page-revision precondition. An explicit restore can replace a different body through one complete, nonempty old-string match, after retaining the exact preimage and candidate. It requires the complete returned body and an independent full readback to match before recording following. A concurrent append or other mismatch remains `needs_review`; string matching does not provide page-revision CAS. Explicit author writes retain their own pinned-baseline, preflight and original-operation protocol. Original unknown operations remain barriers to new writes.

Ordinary `create` and mixed `apply` retain their existing input limits. Complete reviewed inventory imports and Source admissions preserve all supported Markdown, raw resources, modes and main frontmatter through the same original create kernel. Mixed or multiple layout changes in one `apply` and arbitrary lossless Markdown rendering remain unsupported. New native plans reject Setext headings before writes. Supporting Markdown may include a complete YAML header: native creation and file-add retain that exact header separately from the editable body, and complete snapshots and exports reconstruct it. Source ancestry and known file modes remain attached to the retained state. An explicit edit may submit the complete unchanged header or body-only text; it cannot change extra metadata through a body write. Excessive resource or operation-envelope size also fails before dispatch. HTTP/local composition requires a reviewed fixed plan. No unsupported file may be omitted to make an import appear complete.

New authoring and native-create plans use Markdown projection policy 13. It preserves the earlier rules and adds the observed native-create serialization of a supported loose ordered list with continuation paragraphs. Literal underscore escaping and the observed canonicalization of bare `https://www.notion.so/COMPACT_PAGE_ID` links to `https://app.notion.com/p/COMPACT_PAGE_ID` remain versioned rules. Code literals, external links and URL forms outside that exact rule remain unchanged. The original input, wire request and expected readback stay separately frozen; normalization of observed bodies remains CRLF-to-LF only. Existing policies 1–12 keep their original bytes and meaning. Unverified table alignment, unaccounted spans or unsupported nested link styling are rejected or fail exact readback rather than being silently normalized away.

Inline code containing a literal backtick remains rejected because the observed native conversion can merge adjacent paragraphs. This applies to both Markdown code spans and native `<code>` content, including visible nested text. Fenced code may contain literal backticks. The CLI leaves the input unchanged; it does not silently convert inline code into a fence. Retained policy 1–7 plans continue to validate against their original renderer, expected bytes and operation identity. Migration reconstruction carries the exact policy recorded by every saved file; a new policy requires a new candidate and review digest. A policy 4 operation that stopped for a body mismatch remains bound to policy 4; installing the new renderer does not authorize replay or mark that operation successful.
