---
name: ntn-skills-maintain
description: Manage complete resource/native Skill imports, readable Notion text, exact Skill Trash restoration, finite import recovery and library setup. Use for local Skill migration, a trashed Skill or missing daily Notion bodies.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Requires ntn-skills and library Read access; import and restoration also need Insert and Update.

Use the task's executable and exact library. Stable IDs select Skills. Import
replaces a complete local tree; Source management belongs to notion/ntn-skills-sync.

## Inspect and prepare

For existing content, inspect the current owner and directory first:

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

The first command is metadata-only. Use returned refs or export for bytes;
preserve paths, encoding and executable modes. Directory/ZIP input needs root
SKILL.md; a portable Router or Prompt uses its canonical entrypoint. Only an
explicit single Markdown input is renamed to SKILL.md. Symlinks are rejected.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

Any current Source file makes dry-run and apply return
CURRENT_SOURCE_MANAGEMENT_REQUIRED, even for an unchanged export. Use explicit
Source takeover before a complete local replacement; use Source apply/refresh
for contribution changes. Omitting or reidentifying a file cannot transfer it.

Review removals and authority under the task's existing authorization. Omit a
Notion-owned file only to remove it. Preview is not a completed content edit.
Local Markdown links must resolve in the complete input. Fix inbound links before
removing a target. Links may point to real directories; images need files.
Directories need no README. Use stable refs across Skills.

## Apply and verify

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills export PAGE_ID --database ENTRY --output NEW_DIRECTORY
```

Use the returned PAGE_ID. Import preserves Skill and retained File identities,
checks complete current metadata and authoritative content, then retires omitted
Notion-owned supporting rows and unreferenced owned resources. Equal complete input makes zero semantic Notion writes.

Import preserves exact originals. Repeat installed-tree imports under the same
Skill ID; keep Notion originals native. Generate readable main/supporting text:

```sh
ntn-skills ctl library projection PAGE_ID --entry ENTRY
```

Source filters preserve Git consumption and Notion authority. See
[reading and recovery](references/operations.md#generate-notion-text) for filters,
page rebuild, resume/cancel and zero-write reruns. Consumption stays ready.

For a completed Skill later moved to Trash, use its original exact page:

```sh
ntn-skills ctl library projection PAGE_ID --restore --entry ENTRY
```

Repeat the same command after its own restore or projection interruption. Keep
the original filters and budgets. Preserve identity, four policy checkboxes and
native/resource authority; verify complete text before declaring recovery.
Use the [Trash recovery boundary](references/operations.md#restore-a-trashed-skill).

Repeat --native PATH for editable text, such as --native SKILL.md --native
references/guide.md. Select exact paths after any entrypoint rename. Native
bodies require UTF-8/LF and an actual round-trip; frontmatter/mode stay exact.
Reimport replaces later edits; export them first if needed. Failed native
conversion never falls back to resource.

Existing Enabled and Default Context stay unchanged. Portable Members/Requires
use same-library stable refs: omitted preserves, [] clears, a list replaces.
Export carries both sets. Prompt relations are invalid; changed sets allow 100
targets and Requires must be acyclic. Old projection/materialization is rejected.

Remote work shares 1000 HTTP attempts, 512 MiB payload bytes and 600000 ms by
default. Set --max-requests, --max-bytes and --timeout in ms. Exhaustion stops
new requests and retains pending; explicit resume gets a fresh invocation budget.

## Authority and unfinished work

The main lives on Skills; each supporting file has one Files row. Native owns
the author body plus stored frontmatter/mode; resource owns an exact Records
original; source owns its current Source/revision/path. Generated body edits
do not transfer authority. Missing Content returns CURRENT_SCHEMA_REQUIRED;
CURRENT_OPERATION_PENDING blocks ordinary consumption.

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --operation OPERATION_ID --resume
```

Resupply the same input and --native paths. Keep the original local state and
credential scope. Unknown CREATE/append is observed, never repeated from absence;
a partial append can remain unresolved. Do not manually clear pending or ready.

To change an unfinished intent, use --supersede OLD --operation NEW with distinct
identities. The same kernel reconciles the exact predecessor first; this does
not bypass unknown writes or authority checks. It is incompatible with resume
and dry-run. See [Operations](references/operations.md#incomplete-current-work).
Completion clears finite operation state without retaining content versions.

## Other routes

| Task | Read |
| --- | --- |
| Create or connect a current layout | [Setup](references/setup.md) |
| Complete input, recovery and cleanup | [Operations](references/operations.md) |
| Source file authority, lifecycle, Profile/View | notion/ntn-skills-sync |

Use `ctl builtin read notion/ntn-skills-maintain --path RELATIVE_PATH` for package
references. Do not search private cache directories for bundled instructions.
