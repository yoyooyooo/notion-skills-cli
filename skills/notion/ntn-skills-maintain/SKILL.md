---
name: ntn-skills-maintain
description: Import or replace complete Notion Skill trees, inspect ownership, resume an unfinished import, or create the four-table layout. Use for local Skill migration and current content management.
compatibility: Requires the installed ntn-skills CLI and exact library access. Import needs Notion Insert and Update permissions; inspection needs Read.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the task's executable and exact library. Stable Skill IDs select content;
names are display labels. Import replaces a complete local tree. Source refresh
and whole-library governance remain separate work.

## Inspect and prepare

For existing content, inspect the current owner and directory first:

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

The first command is metadata-only. Use file refs or export for bytes; preserve
paths, encoding and executable modes. Directory/ZIP input needs root SKILL.md; a
portable Router or Prompt uses its canonical entrypoint. An explicitly selected
single Markdown file becomes SKILL.md. Symlinks and changing files are rejected.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

This CLI writes resource authority. Any current Source main or supporting file
makes dry-run and apply return CURRENT_SOURCE_MANAGEMENT_REQUIRED, even for an
unchanged export. Preserve File IDs, paths and Source bindings; do not omit or
reidentify files. Coordinated Source management is still required.

Review File additions/removals and authority changes under the task's existing
authorization. Omit a Notion-owned file only to remove it. Preview is not a completed
content edit. Local Markdown links must resolve inside the complete input; update
or remove inbound links before omitting their target.

## Apply and verify

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills export PAGE_ID --database ENTRY --output NEW_DIRECTORY
```

Use the returned PAGE_ID. Import preserves the physical Skill and retained File
IDs, checks every reading page, then removes omitted Notion-owned supporting rows
and unreferenced owned Resource rows. Repeating an admitted complete input
performs zero semantic Notion writes.

Default import uses resource authority and preserves exact original bytes.
Readable text appears in full. Opaque files expose a usable original; unsupported
upload formats use a ZIP containing only that original. Read/export restores the
original path, bytes and mode. Display name and description do not rewrite content.

An existing Skill keeps unspecified Enabled and Default Context. Portable
Members/Requires use same-library stable Skill refs: omitted preserves, [] clears,
and an array replaces the complete field. Export includes both current sets.
Prompt inputs cannot carry relations. Changed sets allow at most 100 targets; a
larger unchanged set is verified and retained. Changed Requires must be acyclic.
Old projection/materialization fields are rejected; never strip them to force import.

All remote import work shares one budget: 1000 HTTP attempts, 512 MiB payload
bytes and 600000 ms by default. Set --max-requests, --max-bytes and --timeout in
ms when needed. Inspect the returned budget. Exhaustion stops new requests and
keeps unfinished intent; an explicit resume starts a fresh invocation budget.

## Authority and unfinished work

Skills contains one main document; each supporting file has one Files row.

- native owns its page body plus explicit frontmatter and mode.
- resource owns its current exact original in Records.
- source owns its declared current Source/revision/path.

Generated bodies are reading projections. Editing one does not change authority.
Missing current metadata returns CURRENT_SCHEMA_REQUIRED and needs explicit
conversion. CURRENT_OPERATION_PENDING means ordinary consumption cannot proceed.

Resume the same complete input using the returned operation identity:

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --operation OPERATION_ID --resume
```

Do not change input under an unfinished intent. Unknown CREATE or append is
observed before continuing and is never repeated because a query returned empty.
A partially applied append may remain unresolved. Keep its current state and
specific error; do not mark it ready manually. Completion clears the finite
operation instead of retaining content versions or permanent ACK records.

## Other routes

| Task | Read |
| --- | --- |
| Create or connect a current layout | [Setup](references/setup.md) |
| Complete input, recovery and cleanup boundaries | [Operations](references/operations.md) |
| Profile/View/freshness and current Source ownership | notion/ntn-skills-sync |

Use `ctl builtin read notion/ntn-skills-maintain --path RELATIVE_PATH` for package
references. Do not search private cache directories for bundled instructions.
