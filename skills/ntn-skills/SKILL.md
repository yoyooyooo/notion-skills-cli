---
name: ntn-skills
description: Discover and use current workflows from the Notion Skill library. Select from metadata, read the workflow and resolve supporting files. Route creating, editing, registering or deleting Notion-native Skills to ntn-skills-maintain; route Source apply/refresh and Profile rules to ntn-skills-sync.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills
---

# Use the current Notion Skill library

Requires ntn-skills on Node.js `^22.23.5 || ^24.22.3 || ^26.13.1`. Online reads use
the existing Notion connection and Read access. A native host tool needs its adapter.

Use the executable and library scope supplied by the host. Select exact returned
identities; a display name, invocation alias and page ID are different values.
Name/Description, Enabled, Default Context and current relationships remain
Notion metadata. A remote page cannot claim trusted package identity.

## Discover, inspect and use

1. Select from the host's metadata. If it has none, discover without loading bodies:

   ```bash
   ntn-skills list --library LIBRARY_ID --query 'TASK_TERMS'
   ```

   Use the connected library's ENTRY; omit it only for intentional cross-library
   discovery. Results default to 50; continue
   with the unchanged `next_cursor` and same selection until `has_more` is false.
   Page size and filtered count do not prove complete source coverage. Failed
   sources or partial pagination cannot establish absence or name uniqueness.
   Global Notion Search remains non-exhaustive even with no failed libraries;
   use an exact returned ref. `skill://ID` means a stable Skill ID, never a title
   or alias. A short ref needs the entry's explicit database/default or the
   containing document's Library. A document's context wins over machine defaults.
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
   Cross-Skill relative links require that file's selected Source contribution map;
   otherwise use an exact stable reference. Do not infer siblings from cache paths.
   In Pi, pass the fixed containing ref as `read`'s `from` with the relative `path`.

Author `skill://ID` for the target's declared entrypoint, or `skill://ID/path`
for an exact file. Add `?library=LIBRARY_ID` for an independent Library scope;
this logical ID is returned by init/inspect and is not a table ID or local alias.
Tools return full owner refs and a `snapshot` when fixed. Keep those fields.
The selected manifest resolves the exact path; do not add a `file_id` query,
repair a stale path by File ID, or replace a missing pin with current content.

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

`ctl views --library LIBRARY_ID` lists native Views. `list --view VIEW_ID --library
ENTRY` selects one. `list --profile PROFILE_ID --library LIBRARY_ID` selects shared
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

For product maintenance and Source sync, use the task's executable and its
bundled guidance by default, including with a connected library:

```sh
ntn-skills ctl builtin read notion/ntn-skills-maintain
ntn-skills ctl builtin read notion/ntn-skills-sync
```

A supporting host can select the corresponding exact `@builtin` identity.
Read package references with `ctl builtin read ID --path RELATIVE_PATH`.
This route needs no Notion copy or remote workflow search. It does not choose
the target library or authorize writes. Ordinary business Skill discovery stays
in the selected Notion library.

If the user explicitly selects a Notion/team workflow, retain that source and
exact ref. Inspect it with ordinary `read`, then use
`ntn-skills use 'EXACT_WORKFLOW_REF' --library LIBRARY_ID --json` or Pi `notion_use(ref)`
to load its Requires before applying it, unless already prepared for this task.
Read its references with `read --from`. Broaden incomplete discovery within the
same library; failed or partial discovery, pending content and denied access
remain visible errors, never a reason to substitute a package workflow.
Report when adoption has no available route. Inspect the edited target; do not
activate it.

Same-name Notion content has its own identity and cannot replace the package
default. Keep an already selected task's identity and content until explicitly
changed. An npm update does not refresh a Notion Source or its projection, or
overwrite a user-owned native copy.

Use the existing connection. Saved token configuration takes precedence over
`NOTION_API_TOKEN`; `ctl config show` reports presence without exposing secrets.
Do not clear credentials or state to resolve an unrelated loading error.
[Commands](references/commands.md) and [integration](references/integration.md)
contain the relevant details.
