---
name: ntn-skills-maintain
description: Import complete Skills, project Notion text, restore a trashed Skill, and manage setup and recovery. Use for local migration or missing reading bodies.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Requires ntn-skills and library Read; writes need Insert and Update.

Use the task's executable and library. Import replaces a complete local tree;
manage Sources through notion/ntn-skills-sync.

## Inspect and prepare

Inspect an existing owner and its directory:

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

Review authorized removals and authority. Omit a Notion-owned file only to
remove it. Preview is not a completed content edit.
Local Markdown links must resolve in the complete input. Fix inbound links before
removing a target. Links may point to real directories; images need files.
Directories need no README. Use stable refs across Skills.

## Apply and verify

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills export PAGE_ID --database ENTRY --output NEW_DIRECTORY
```

Use returned PAGE_ID. Import preserves Skill/retained File identities, verifies
complete metadata and authoritative content, and retires omitted Notion-owned
supporting rows and unreferenced owned resources. Equal complete input makes zero semantic Notion writes.

Repeat imports with the same Skill ID and retain native authority. Generate
complete main/supporting text:

```sh
ntn-skills ctl library projection PAGE_ID --entry ENTRY
```

Projection preserves full consumption, Notion authority and ready state. See
[filters and recovery](references/operations.md#generate-notion-text).

Restore a completed Skill from Trash using its original page:

```sh
ntn-skills ctl library projection PAGE_ID --restore --entry ENTRY
```

Use exact-page automatic mode; [restore rules](references/operations.md#restore-a-trashed-skill)
cover retries, identity and rejected combinations.

For editable text, repeat --native PATH: --native SKILL.md --native
references/guide.md. Use exact paths after entrypoint renaming. Native
bodies require UTF-8/LF without a terminal LF and an actual exact round-trip;
frontmatter/mode stay exact. Never trim input to make a failed intent pass. See
[native admission](references/operations.md#import-a-complete-current-tree).
Reimport replaces edits; export them first if needed. Failed native
conversion never falls back to resource.

Existing Enabled and Default Context stay unchanged. Portable Members/Requires
use same-library stable refs: omitted preserves, [] clears, a list replaces.
Export carries both sets. Prompt relations are invalid; changed sets allow 100
targets and Requires must be acyclic. Old projection/materialization is rejected.

Remote work shares one [invocation budget](references/operations.md).

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

Read package references with `ctl builtin read notion/ntn-skills-maintain --path RELATIVE_PATH`;
never search private caches for them.
