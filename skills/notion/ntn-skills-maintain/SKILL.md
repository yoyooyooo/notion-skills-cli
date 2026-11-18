---
name: ntn-skills-maintain
description: Inspect the current Notion Skill library, its complete file ownership and reading state, or create its four-table layout. Use for content-management requests, complete local inputs and incomplete current operations; determine which current management capability is available before changing content.
compatibility: Requires the installed ntn-skills CLI and Notion access for the requested operation. Ordinary inspection requires no Notion write permission.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the exact executable, library and target supplied by the task. Names are
display labels, not unique identities. The current CLI exposes library setup,
inspection and Profile management. Content import, apply, file mutation, Source
refresh and cleanup commands are not available while the current writer is
being completed.

For an existing Skill, inspect its current main descriptor and every supporting
Files row, then read the requested content:

```bash
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

The first command is metadata-only and includes current state, ownership, paths
and authority. It does not certify file bodies. The second uses the ordinary
read-only consumer. Follow exact returned refs for supporting files; export a
complete tree when the task requires every byte.

## Content ownership

Skills owns one main document. Each supporting file has one Files row with a
stable File ID, one Skill owner, a safe relative Path and a current Content
descriptor. The descriptor is one of:

- `native`: the page body is authoritative; stored frontmatter and mode complete
  the file. A native edit is read directly without an adoption record.
- `source`: one exact current Source ID/revision/path supplies bytes, hash, size
  and mode. A generated page is for reading; editing it does not transfer authority.
- `resource`: one exact current Records resource supplies bytes, hash, size and
  mode. The reading page does not replace the original.

Text Files should have complete human-readable bodies; images and binary files
should expose usable originals. Metadata, URLs or hash placeholders do not
prove that reading projection is complete. Current input validation and actual
Notion projection are separate checks.

## State and errors

`ready` requires an empty Operation field. `applying` and `attention` require
the current operation ID. Ordinary consumers refuse non-ready content before
reading bodies. This finite state identifies unfinished current work; it is not
a content-version history.

A missing or invalid Content descriptor returns `CURRENT_SCHEMA_REQUIRED`.
An unfinished current operation returns `CURRENT_OPERATION_PENDING`. Preserve
the exact error, affected owner and next action. Do not replace missing content
with Git, another Skill or cached older content, and do not mark state ready by
hand to bypass an incomplete tree.

## A content-change request

Use the already authorized scope. Inspect the exact current tree and prepare
the complete requested local input, preserving supporting paths, original
bytes, modes and intended relationships. Source-generated and native files need
an explicit authority decision. Missing or inaccessible data is not deletion
intent.

Check the installed command schema for the specific required operation. When
the current writer is unavailable, report that boundary and the prepared input;
do not invent an apply command, patch bookkeeping properties directly or use a
different operation family. Inspection is useful work, but is not a completed
content edit. No content versions or proof records are required.

## Other routes

| Task | Read |
| --- | --- |
| Connect an existing library or create a current layout | [Setup](references/setup.md) |
| Inspect complete input, authority or incomplete current work | [Operations](references/operations.md) |
| Shared Profile/View/freshness rules and current Source boundaries | `notion/ntn-skills-sync` |

For package references, use `ctl builtin read notion/ntn-skills-maintain --path
RELATIVE_PATH`. Do not search private cache or repository directories to find
bundled instructions.
