---
name: ntn-skills
description: Discover and use workflows from the Notion Skill library. Use when a task may benefit from a stored workflow, names a remote Skill, or follows a Notion skill reference. Select from metadata, load only the chosen workflow, and keep its supporting files on one snapshot. Route Notion content changes to ntn-skills-maintain and fixed sources, shared Profiles and existing synchronization bindings to ntn-skills-sync.
compatibility: Requires Node.js 22.22.3+ within 22.x or 24.20.0+ and ntn-skills; online discovery and reads require official ntn and an existing Notion connection; retaining newly observed shared edits also needs shared Record write access. Shell tools are sufficient; native Read integration requires a host adapter.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills
---

# Use the Notion Skill library

Use this entrypoint to find and consume a workflow. Keep three sources distinct: remote Notion pages, directories maintained through sync, and package-supplied builtins. A matching name does not make them the same identity or version.

For a shared library, copy `record.id`, `record.ref` and the `shared_skill` locator exactly; encoded stable IDs are not page IDs. Name/Description, Enabled, Source, Default Context and Router Members come from native Notion properties. Existing legacy records may also carry Source Type, Builtin ID and Sync Mode. Editable remote properties never establish trusted installed-package identity.

## Select and read

1. If the host already provides remote Skill metadata, select the relevant entry from it. Otherwise discover names, descriptions, refs and coverage without loading bodies:

   ```bash
   ntn-skills list --query 'TASK_TERMS'
   ```

   Replace placeholders with actual task terms and returned identities. Broaden the query when needed. Search can miss databases; use `list --database DATABASE_ID_OR_ALIAS` for a known library. Incomplete coverage cannot prove absence or uniqueness. Same-name pages require a database selector or an exact returned record ref.
2. Read the selected workflow through the host's registered Skill interface when available. Otherwise use the CLI:

   ```bash
   ntn-skills read 'REF_FROM_LIST'
   ```

   Require exit 0 and `ok: true`; a failed response is not instructions. Reading a Skill to inspect, summarize or edit it does not activate its workflow. Apply its instructions only when selected for the current task.
3. Retain the returned page identity, `ref`, `snapshot_id`, `source` and `freshness`. Ordinary reads may reuse content validated within five minutes; catalog metadata defaults to 60 seconds. When the task needs current remote validation, refresh the current unpinned target. A running workflow stays on its selected version until deliberately switching.
4. Load only needed supporting files from that version:

   ```bash
   ntn-skills files 'SNAPSHOT_ID_FROM_READ'
   ntn-skills read 'RELATIVE_PATH' --from 'PINNED_CONTAINING_FILE_REF'
   ```

   Resolve links from the containing file, which may itself be a reference. Use the snapshot ID to enumerate the whole file set. Pinned refs work offline and reject `--refresh`/`--max-age`; they do not establish latest content or current permission. Never resolve a relative file by rereading the Skill name and accidentally selecting a newer version.

Use JSON when version/freshness matters. `--raw` omits that metadata. Binary files need `--output NEW_PATH` and a suitable viewer. Reading or exporting scripts does not authorize executing them. A host adapter may manage snapshots and paths for you; preserve its identity and freshness results rather than creating another local copy.

Shared current reads batch flat file metadata and retained ownership facts before reusing unchanged bodies. A complete newly observed Notion edit is retained as a whole-file customization; no field marker or manual adopt command is needed. Other files retain their own source behavior. TTL hits can make no remote requests; the independent full-body deadline bounds same-timestamp edits. Use `--refresh` or explicit `--max-age 0` for complete current validation. Existing legacy native Skills may still use their aligned-source-ZIP checkpoint. Retain `freshness.validation` in host results.

Inspect native Views with `ntn-skills views --database LIBRARY_ENTRY`. Select an exact View with `list --view VIEW_ID --database LIBRARY_ENTRY`, or a shared default with `list --profile PROFILE_ID --database LIBRARY_ENTRY`. `list --default-view` consults the machine-bound Profile; without a configured default, use the first View in API order. Explicit View selection takes precedence. Bare `list` remains complete explicit discovery, including Prompts; Profile/View rules do not grant access. The host manages session selection and prompt timing; metadata alone does not activate a workflow.

## Route other tasks

| Task | Workflow |
| --- | --- |
| Execute an existing remote workflow | Select/read as above; no local installation or sync binding is required |
| Create a Notion Skill, apply a change to a pinned page, or transfer a portable copy | Select `$ntn-skills-maintain@builtin`; otherwise load `ntn-skills ctl builtin read notion/ntn-skills-maintain` |
| Select fixed shared sources or Profiles, maintain existing upstream/local bindings, or resolve their original interrupted work | Select `$ntn-skills-sync@builtin`; otherwise load `ntn-skills ctl builtin read notion/ntn-skills-sync` |
| Review and migrate one legacy record into a shared library | Use `ctl library migration --help` and the approval workflow below; retain the original evidence |
| Inspect, install or update package-supplied Skills | Use `ctl builtin list/read/status/install/update`; installation is central with shared links by default, and optional Agent roots add links. See [local management](references/commands.md#local-builtins) |
| Missing workflow, failed load or old content | Follow [diagnosis](references/integration.md#diagnose-discovery-and-loading) before changing configuration or clearing caches |

Context Broker exposes package builtins through ordinary `$`, including `$ntn-skills@builtin`. The exact `@builtin` suffix preserves package identity when names collide. Reading package instructions does not require publishing a copy to Notion or creating a local sync binding. When using a builtin through CLI reads, read its `files` inventory and supporting files with `ctl builtin read EXACT_ID --path PATH`. Do not assume sibling Skills are installed. `ctl builtin read` returns package content; ordinary `list/read` continue to select remote Notion pages.

## Review a legacy migration

Keep the complete frozen input, retained managed files, exact native response JSON and selected fixed Source bytes. Use `ctl library migration plan --input FROZEN_JSON` for the offline inventory, then prepare the concrete target without changing approvals:

```bash
ntn-skills ctl library migration review --input FROZEN_JSON \
  --legacy-id LEGACY_ID --entry LIBRARY_ENTRY --files RETAINED_FILES \
  --preimages RAW_RESPONSES
```

Add `--source-files EXACT_SOURCE_DIR_OR_ZIP` when the frozen target selects a Source. Save the complete JSON and inspect its `review_id`, content, ownership, Source, target and member bindings. Review can read target metadata; it performs no Notion writes and does not approve migration. For absent `Enabled`, use complete original row/schema evidence with `legacy_catalog_active_page_v1`, or explicitly select `legacy_catalog_active_page_v2` and API `2026-03-11`. V1 requires `archived:false` and `in_trash:false`; v2 requires `in_trash:false` and rejects contradictory archive flags when present. Retain `original_enabled: absent`; never invent an `Enabled` or missing `archived` value or reclassify ownership from activity. Consult each subcommand's `--help` for its exact retained-input contract.

New reviews bind `origin.candidate.execution_policy` into the digest. Ordinary targets use `copy_to_new_native_v1`, which requires the target's exact bytes, ownership, same-page aliases, Router members, Source and relevant operation evidence. A validated `legacy_committed_publication_v1` descriptor selects `copy_to_new_native_v2` for a copy of one exact retained observation. V2 rechecks the original committed publication, fixed member, authored export and native response bytes; the derived native files are its `--files` input. It retains `retained_operations` and `retained_catalog_coverage` in the review digest, including unresolved history and incomplete enumeration. Both policies create new native pages without source cutover or legacy retirement. A policy name, approval or receipt boolean cannot replace the selected target's actual evidence.

After explicit approval, keep a separate frozen input with the reviewed identity in `approved_legacy_ids`. Preserve all other review-bound facts and the independent approved digest. Run `ctl library migration apply --input APPROVED_JSON --review REVIEW_JSON --review-id MIGRATION_REVIEW_ID --dry-run`; execute the same command without `--dry-run` only for that approved result. Require `status: created`, `verified: true` and a verified current pin before reporting migration success.

For either explicit copy policy, apply/dry-run and direct create execution require the approved target and complete dependency evidence; independent unapproved entries may remain blocked. Empty approval permits no creation. Saved unmarked and v1 candidates keep their original gates and cannot inherit v2 by relabelling. Unresolved dependencies return `SHARED_MIGRATION_CREATE_BLOCKED`; unmarked/v1 reliance on unread impact/isolation receipts returns `SHARED_MIGRATION_RECEIPT_UNVERIFIED`. V2 verifies the retained publication instead, without settling old operations or completing enumeration. Preserve the full input and exact review-bound history through apply.

Keep an unknown operation unchanged and use `ctl library migration reconcile --entry LIBRARY_ENTRY --operation ORIGINAL_SKILL_CREATE_OPERATION_ID`; add the exact new `--target PAGE_ID` from a receipt when the original journal is unavailable on another machine. Reconciliation verifies only the original create outcome and does not replay writes or prove a current pin. `WRITE_VERIFICATION_FAILED` with `native_create_completed: true` also needs this distinction: native creation finished, but the final current-snapshot check failed without adopting user edits. Preserve the error and original operation; never switch to generic `operation resume` or issue a replacement intent. Ordinary later current reads have their own adoption behavior.

For a known disabled partial migration with `SHARED_CREATE_BODY_MISMATCH`, inspect `ctl library migration recovery review --help`. Its bounded v4-to-v5 decision keeps original input/wire bytes, page identities and failure evidence. Save and inspect the separate review before `recovery apply` with the original approved input; existing page bodies remain untouched. A current observation is labeled `post_failure_current_read`. Recovery interruption uses `recovery reconcile` with the original operation and existing target, without replay. See the authoring guide's partial migration recovery workflow; this path cannot recover an unknown original create or silently accept changed current content.

If that recovery itself reports an unknown page create, inspect `ctl library migration recovery continuation review --help`. A separate continuation requires the terminal retained by the actual serial dispatch, exact successful responses and matching current allocations. Save and inspect its digest before `continuation apply` with the complete original approved input. It skips accepted pages and creates only the proven unattempted suffix; the original POST stays unknown. Missing terminal or input, an invisible or changed page, and a second interruption remain blocked. Current GETs and retrospective summaries cannot replace execution evidence. Completion v2 is checked independently through `recovery reconcile`; do not fabricate an old terminal or downgrade the completion.

## Host and connection boundaries

Use the existing connection. Authentication priority is saved `config.token` > nonempty `NOTION_API_TOKEN` > existing `ntn login`. `ctl config show` exposes presence only; do not print credentials or initiate login implicitly. [Connection and host details](references/integration.md) are loaded only when needed.

Installing this entrypoint makes its name and description discoverable in a supporting host. It does not automatically load its body, inject every remote Skill, register `Read skill://` or configure a broker. Startup awareness of remote workflows requires the host's metadata integration; without it, invoke discovery through this Skill. [Commands, selectors and recovery](references/commands.md) provide exact CLI details.
