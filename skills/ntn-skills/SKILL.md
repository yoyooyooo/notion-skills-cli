---
name: ntn-skills
description: Discover and use workflows from the Notion Skill library. Use when a task may benefit from a stored workflow, names a remote Skill, or follows a Notion skill reference. Select from metadata, load only the chosen workflow, and keep its supporting files on one snapshot. Route Notion content changes to ntn-skills-maintain and fixed sources and Profile/View settings to ntn-skills-sync.
compatibility: Requires Node.js 22.22.3+ within 22.x or 24.20.0+ and ntn-skills; online discovery and reads use the project's direct HTTP engine and existing Notion token; retaining newly observed shared edits also needs shared Record write access. Shell tools are sufficient; native Read integration requires a host adapter.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills
---

# Use the Notion Skill library

Use this entrypoint to find and consume a workflow maintained in Notion. Package-supplied builtins provide the installed CLI instructions; use their exact package identities. A matching name does not establish identity or version.

Copy `record.id`, `record.ref` and the `shared_skill` locator exactly; encoded stable IDs are not page IDs. Name/Description, Enabled, Source, Default Context and Router Members come from native Notion properties. Editable remote properties never establish trusted installed-package identity.

## Discover, inspect and use

1. If the host already provides remote Skill metadata, select the relevant entry from it. Otherwise discover names, descriptions, refs and coverage without loading bodies:

   ```bash
   ntn-skills list --query 'TASK_TERMS'
   ```

   Replace placeholders with actual task terms and returned identities. Results default to 50 records. If `has_more` is true, copy `next_cursor` into `--cursor` with the same query and source selection. `count` is the page size; `total_count` is the filtered count within this observation. Neither proves complete source coverage. Broaden the query when needed. Search can miss databases; use `list --database DATABASE_ID_OR_ALIAS` for a known library. Incomplete coverage cannot prove absence or uniqueness. Same-name pages require a database selector or an exact returned record ref.
2. To inspect or summarize original text, use `ntn-skills read 'REF_FROM_LIST' --json`. To apply a selected workflow, use the host's Notion Skill consumption tool or the CLI:

   ```bash
   ntn-skills use 'REF_FROM_LIST'
   ```

   Require exit 0. `use` loads the root and its complete Requires once; unselected Member bodies stay lazy. Compact text is the default; `--json` returns the complete structured result and machine evidence. Prepared content does not attest model delivery or activation. Reading a Skill to inspect, summarize or edit it does not activate its workflow. Apply instructions only when selected for the current task.
3. Retain returned canonical refs and, with JSON, the selected page, snapshot, source and freshness. Ordinary reads may reuse content validated within five minutes; catalog metadata defaults to 60 seconds. When the task needs current remote validation, refresh the current unpinned target. A running workflow stays on its selected version until deliberately switching.
4. Load only needed supporting files from that version:

   ```bash
   ntn-skills files 'SNAPSHOT_ID_FROM_READ'
   ntn-skills read 'RELATIVE_PATH' --from 'PINNED_CONTAINING_FILE_REF'
   ```

   Resolve links from the containing file, which may itself be a reference. Use the snapshot ID to enumerate the whole file set. Pinned refs work offline and reject `--refresh`/`--max-age`; they do not establish latest content or current permission. Never resolve a relative file by rereading the Skill name and accidentally selecting a newer version.

Use `--json` when version/freshness matters. `list` and `read` return JSON by default. `read --raw` omits that metadata. Binary files need `--output NEW_PATH` and a suitable viewer. Reading or exporting scripts does not authorize executing them. A host adapter may manage snapshots and paths for you; preserve its identity and freshness results rather than creating another local copy.

Shared current reads batch flat file metadata and retained ownership facts before reusing unchanged bodies. A complete newly observed Notion edit is retained as a whole-file customization. Other files retain their own source behavior. TTL hits can make no remote requests; the independent full-body deadline bounds same-timestamp edits. Use `--refresh` or explicit `--max-age 0` for complete current validation. Retain `freshness.validation` in host results.

Inspect native Views with `ntn-skills ctl views --database LIBRARY_ENTRY`. Select an exact View with `list --view VIEW_ID --database LIBRARY_ENTRY`, or a shared default with `list --profile PROFILE_ID --database LIBRARY_ENTRY`. `list --default-view` consults the machine-bound Profile; without a configured default, use the first View in API order. Explicit View selection takes precedence. Bare `list` discovers the accessible source scope, including Prompts; follow every cursor for a complete local observation; Profile/View rules do not grant access. The host manages session selection and prompt timing; metadata alone does not activate a workflow.

## Route other tasks

| Task | Workflow |
| --- | --- |
| Execute an existing remote workflow | Select/read as above; use the selected source and version |
| Create a Notion Skill, apply a change to a pinned page, or transfer a portable copy | Select `$ntn-skills-maintain@builtin`; otherwise load `ntn-skills ctl builtin read notion/ntn-skills-maintain` |
| Manage Sources, fixed revisions and Profiles, or reconcile an interrupted source operation | Select `$ntn-skills-sync@builtin`; otherwise load `ntn-skills ctl builtin read notion/ntn-skills-sync` |
| Inspect, install or update package-supplied Skills | Use `ctl builtin list/read/status/install/update`; installation is central with shared links by default, and optional Agent roots add links. See [local management](references/commands.md#local-builtins) |
| Missing workflow, failed load or old content | Follow [diagnosis](references/integration.md#diagnose-discovery-and-loading) before changing configuration or clearing caches |

Context Broker exposes package builtins through ordinary `$`, including `$ntn-skills@builtin`. The exact `@builtin` suffix preserves package identity when names collide. Read package instructions directly; no publication or installation is needed. When using a builtin through CLI reads, read its `files` inventory and supporting files with `ctl builtin read EXACT_ID --path PATH`. Do not assume sibling Skills are installed. `ctl builtin read` returns package content; ordinary `list/read` continue to select remote Notion pages.

## Host and connection boundaries

Use the existing connection. Authentication priority is saved `config.token` > nonempty `NOTION_API_TOKEN`; missing credentials return `AUTH_REQUIRED`. `ctl config show` exposes presence only; do not print credentials or initiate authentication implicitly. [Connection and host details](references/integration.md) are loaded only when needed.

Installing this entrypoint makes its name and description discoverable in a supporting host. It does not automatically load its body, inject every remote Skill, register `Read skill://` or configure a broker. Startup awareness of remote workflows requires the host's metadata integration; without it, invoke discovery through this Skill. [Commands, selectors and recovery](references/commands.md) provide exact CLI details.
