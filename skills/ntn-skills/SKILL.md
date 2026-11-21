---
name: ntn-skills
description: Discover and use current workflows from the Notion Skill library. Select from metadata, read the workflow and resolve supporting files. Route creating, editing, registering or deleting Notion-native Skills to ntn-skills-maintain; route Source apply/refresh and Profile rules to ntn-skills-sync.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills
---

# Use the current Notion Skill library

Requires ntn-skills on Node.js 22.22.3+ within 22.x or 24.20.0+. Online reads use
the existing Notion connection and Read access. A native host tool needs its adapter.

Use the executable and library scope supplied by the host. Select exact returned
identities; a display name, invocation alias and page ID are different values.
Name/Description, Enabled, Default Context and current relationships remain
Notion metadata. A remote page cannot claim trusted package identity.

## Discover, inspect and use

1. Select from the host's metadata. If it has none, discover without loading bodies:

   ```bash
   ntn-skills list --database ENTRY --query 'TASK_TERMS'
   ```

   Use the connected library's ENTRY; omit it only for intentional cross-library
   discovery. Results default to 50; continue
   with the unchanged `next_cursor` and same selection until `has_more` is false.
   Page size and filtered count do not prove complete source coverage. Failed
   sources or partial pagination cannot establish absence or name uniqueness.
   Global Notion Search remains non-exhaustive even with no failed libraries;
   resolve a bare name within an explicit database or use an exact returned ref.
2. Inspect or summarize with `ntn-skills read 'EXACT_REF' --json`. Apply a workflow
   only when selected for the current task:

   ```bash
   ntn-skills use 'EXACT_REF'
   ```

   Require success. `use` loads the selected root and its Requires closure;
   unselected Members remain lazy. Inspection, editing and downloading do not
   activate instructions or authorize script execution.
3. Keep the returned canonical `ref`, `snapshot_id`, scope and freshness. Read
   supporting files from that selection:

   ```bash
   ntn-skills files SNAPSHOT_ID
   ntn-skills read RELATIVE_PATH --from 'CONTAINING_FILE_REF'
   ```

   Resolve from the containing file, which may itself be a reference. `files`
   enumerates the complete directory; it does not download every resource.
   Preserve exact bytes, paths and executable modes when a resource is needed.

A selection is local task state. Already materialized bytes can be used offline.
Missing Source/resource bytes may be acquired only when the current declared
owner and location still match the selection. Missing native selected bytes or
a changed descriptor requires selecting current content again. There is no
remote archive of previous content to restore. Do not silently substitute a
newer file within an active selection.

## Current content and freshness

Ordinary `list/read/use/files/export` make zero semantic Notion writes. Native
pages are read directly; an edit never creates an adoption or history record.
A generated Source/resource reading page does not become authoritative because
someone edited its body. Each current Content descriptor declares its authority.

Current metadata queries fix the complete file directory before bodies are
reused. Native body reuse has an independent 24-hour deadline. `--refresh`
checks native bodies again; `--max-age` selects a freshness bound; `--offline`
requires locally available selected bytes. These policies are mutually exclusive.
A current content cache hit may make zero HTTP requests. Metadata revalidation
still makes necessary queries and must not be described as a zero-request hit.

Use `--json` when identity or freshness matters. `read --raw` returns text only.
For a binary or an exact single file, use `read --path PATH --output NEW_FILE`.
`export --output NEW_DIRECTORY_OR_ZIP` writes the complete selected tree.
Arbitrary multiple-path export is not a current CLI option.

Within a Broker session, a complete main body already visible is sufficient for
an introduction. Use the inspection tool for reading and the use tool only for
activation. Preserve the host's owner/selection and batching boundaries. A
prepared, truncated or failed payload does not prove complete model delivery.

## Select discovery rules

`ctl views --database ENTRY` lists native Views. `list --view VIEW_ID --database
ENTRY` selects one. `list --profile PROFILE_ID --database ENTRY` selects shared
rules; `list --default-view` consults the machine binding. An explicit View wins.
Bare `list` remains explicit discovery, including Prompts. Views and Profiles
do not grant access or activate workflows.

## Route other tasks

| Task | Route |
| --- | --- |
| Inspect or create a library layout | `ntn-skills-maintain`, then its setup reference |
| Inspect current ownership, missing content or an incomplete operation | `ntn-skills-maintain` |
| Create, edit, register or delete a Notion-native Skill or supporting file | `ntn-skills-maintain`; use `ctl library skill` without manually filling internal fields |
| Import or replace a complete local Skill tree | `ntn-skills-maintain`; use its current import and resume procedure |
| Change name, description, enablement, Members or Requires | `ntn-skills-maintain`; update only the requested metadata or relationship set |
| Git Source apply/refresh or contribution mapping/exclusion | `ntn-skills-sync` |
| Source takeover, restore-follow or removal | `ntn-skills-sync` |
| Complete installed/App tree replacement or native recovery | `ntn-skills-maintain` |
| Shared Profile/View/freshness rules | `ntn-skills-sync` |
| Package-supplied Skills | `ctl builtin list/read/status/install/update`; see [commands](references/commands.md#local-builtins) |
| Discovery, authentication or resource failure | [Integration and diagnosis](references/integration.md#diagnose-discovery-and-loading) |

In a connected library, discover these workflow names through the host's Notion
directory or `list --database ENTRY --query ntn-skills-maintain`. Read the returned
exact ref with ordinary `read`, then its references with `read --from` as above.
Reading only inspects the workflow. To apply the maintenance workflow, use the
same source's exact ref with Pi `notion_use(ref)` or CLI
`ntn-skills use 'EXACT_WORKFLOW_REF' --database ENTRY --json` to load its Requires,
unless that closure is already prepared for this task. Use an available route; otherwise
report that adoption is unavailable. Inspect the edited target; do not activate it.
The default View may omit a workflow; broaden discovery within the same library.
Failed or partial discovery does not authorize switching to a same-name package.

Without a connected library, or for explicit offline/package inspection, select
the host's exact `$ntn-skills-maintain@builtin` or use `ctl builtin read
notion/ntn-skills-maintain`. Package references use `--path RELATIVE_PATH`.
Package and Notion identities remain distinct; never switch an active selection
silently. An npm update does not refresh a Notion Source or its projection.

Use the existing connection. Saved token configuration takes precedence over
`NOTION_API_TOKEN`; `ctl config show` reports presence without exposing secrets.
Do not clear credentials or state to resolve an unrelated loading error.
[Commands](references/commands.md) and [integration](references/integration.md)
contain the relevant details.
