---
name: ntn-skills-maintain
description: Import or replace a complete current Notion Skill tree, inspect Skills and Files ownership, resume an unfinished current import, or create the four-table layout. Use for local Skill migration and current content-management requests.
compatibility: Requires the installed ntn-skills CLI and access to the exact library. Import needs Notion Insert and Update permission; ordinary inspection needs Read permission.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the exact executable and library supplied by the task. A stable Skill ID
selects content; a name is a display label. The public writer imports a complete
local tree. Source refresh and whole-library governance remain separate work.

## Inspect and prepare

For existing content, inspect the current owner and directory first:

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

The first command is metadata-only. Use returned file refs or export to obtain
every required byte. Preserve original paths, text encoding and executable modes.
The input directory or ZIP needs root SKILL.md; a portable Router or Prompt uses
its canonical entrypoint. An explicitly selected single Markdown file becomes
SKILL.md. Use a real physical path; symlink inputs and changing files are rejected.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

Inspect added and removed Files and authority changes. Import replaces the entire
file tree, so omit a file only when its removal is intended. Follow the task's
existing authorization. Preview is not a completed content edit.
Local Markdown links must resolve inside that complete input; remove or update
inbound links before omitting their target file.

## Apply and verify

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills export PAGE_ID --database ENTRY --output NEW_DIRECTORY
```

Use the returned PAGE_ID. Import preserves the physical Skill and retained File
IDs, writes every supporting File and checks complete reading pages. It removes
omitted supporting rows and unreferenced owned Resource rows after checking the
new content. Repeating the same complete input performs zero semantic Notion writes.

Default import uses resource authority and preserves exact original bytes.
Readable text appears in full. Opaque files expose a usable original; unsupported
upload formats use a ZIP containing only that original. Read/export restores the
original path, bytes and mode. Display name and description do not rewrite content.

An existing Skill keeps unspecified Enabled, Default Context, Members and
Requires values. Portable relationship/projection fields that this import cannot
apply are rejected explicitly. Do not strip them to force a successful import.

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
