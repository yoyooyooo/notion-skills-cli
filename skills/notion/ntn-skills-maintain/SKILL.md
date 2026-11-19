---
name: ntn-skills-maintain
description: Import or replace complete resource/native Notion Skill trees, inspect ownership, resume an unfinished import, or create the four-table layout. Use for local Skill migration and current content management.
compatibility: Requires the installed ntn-skills CLI and exact library access. Import needs Notion Insert and Update permissions; inspection needs Read.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the task's executable and exact library. Stable Skill IDs select content;
names are display labels. Import replaces a complete local tree. Source
apply/refresh belongs to notion/ntn-skills-sync; whole-library governance is separate.

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

Import selects resource or explicit native authority. Any current Source file
makes dry-run and apply return CURRENT_SOURCE_MANAGEMENT_REQUIRED, even for an
unchanged export. Use Source apply/refresh; do not omit or reidentify its files.

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

Use the returned PAGE_ID. Import preserves Skill and retained File identities,
checks reading pages, then removes omitted Notion-owned supporting rows and
unreferenced owned resources. Equal complete input makes zero semantic Notion writes.

Default import uses resource authority and preserves exact original bytes.
Readable text appears in full. Opaque files expose a usable original; unsupported
upload formats use a single-original ZIP. Read/export restores path, bytes and
mode. Display metadata does not rewrite original content.

Repeat --native PATH for editable text, for example --native SKILL.md --native
references/guide.md. Paths select the canonical input after any entrypoint rename.
Native bodies require UTF-8/LF; frontmatter and mode remain exact. Actual round-trip
verification precedes ready. Reimport replaces later human edits too: export them
first when they belong in the intended input. Resume requires the same selection.

Existing Enabled and Default Context are preserved. Portable Members/Requires use
same-library stable refs: omitted preserves, [] clears, a list replaces. Export
includes both current sets. Prompt relations are invalid. Changed sets allow 100
targets; larger unchanged sets are retained. Changed Requires must be acyclic.
Old projection/materialization is rejected; never strip it to force import.

Remote import work shares 1000 HTTP attempts, 512 MiB payload bytes and 600000 ms
by default. Set --max-requests, --max-bytes and --timeout in ms. Exhaustion stops
new requests and retains pending; explicit resume gets a fresh invocation budget.

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

Resupply the same input and --native paths. Unknown CREATE or append is
observed before continuing and is never repeated because a query returned empty.
A partially applied append may remain unresolved. Keep its current state and
specific error; do not mark it ready manually. Completion clears the finite
operation instead of retaining content versions or permanent ACK records.

## Other routes

| Task | Read |
| --- | --- |
| Create or connect a current layout | [Setup](references/setup.md) |
| Complete input, recovery and cleanup boundaries | [Operations](references/operations.md) |
| Profile/View/freshness and Source apply/refresh | notion/ntn-skills-sync |

Use `ctl builtin read notion/ntn-skills-maintain --path RELATIVE_PATH` for package
references. Do not search private cache directories for bundled instructions.
