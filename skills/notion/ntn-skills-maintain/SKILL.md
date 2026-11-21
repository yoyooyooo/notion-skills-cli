---
name: ntn-skills-maintain
description: Create, edit, register and delete Notion-native Skills and supporting files. Also import complete trees, generate reading pages, restore Trash and recover unfinished management work.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the task's executable and library, with Read and for writes Insert/Update access.
Select an exact page ID, URL or stable Skill ID, never a fuzzy title.

Read only inspects. To apply, use this source's exact ref via `notion_use(ref)`
or CLI `use REF` with Requires unless already prepared. Report unavailable adoption.
Inspect edited targets; local/package workflows stay native.

## Choose the route

A supplied Notion library or successful discovery selects an existing library.
For a basic how-to, explain create/register below from this main; no reference
read is needed.
The CLI handles Notion REST; load an API Skill only for direct API work.
Open [setup](references/setup.md) only to create/connect a library or resolve a
reported connection/schema problem. Adding a Skill is not library setup.
Report progress before writes and during long verification.

## Prepare local input

Writers require physical paths, including parents. Prepare temporary input before
writing files:

```sh
skill_dir=$(mktemp -d)
skill_dir=$(cd "$skill_dir" && pwd -P)
printf '%s\n' "$skill_dir"
```

Use that physical path; links inside it remain rejected.

## Create or edit a native Skill

Supply content and author metadata; do not construct those Notion fields
that the CLI owns: identity, authority, relationships and finite state.

```sh
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
ntn-skills ctl library skill update TARGET --entry ENTRY --input LOCAL_FILE
```

Create takes complete input: Markdown becomes native; other files stay exact
resources. Update without --path selects the main.
For supporting files, supply intended changes; the CLI preserves everything else.

Use --description for discovery text. Omitted metadata and relationships stay
unchanged. Fix links when removing their targets. Default Context is an author
property; actual default visibility follows the View. Source-owned changes use
ntn-skills-sync.

Native writes verify complete text, code, links and structure; formatting may
normalize. Resources stay byte-exact. Native bodies are editable in Notion;
no projection is needed. See [native management](references/operations.md#manage-native-skills).

## Register or remove an existing page

Register an authored page in the current Skills table without replacing its body:

```sh
ntn-skills ctl library skill register PAGE_ID --entry ENTRY
```

Supply missing --name or --description. Valid registration is unchanged;
foreign pages and conflicting ownership are refused.

```sh
ntn-skills ctl library skill remove TARGET --entry ENTRY --dry-run
ntn-skills ctl library skill remove TARGET --entry ENTRY
```

Removal moves the Skill, Files and unused owned resources to Trash and clears
typed incoming Members/Requires links in the library, preserving other links.
A preview is not a completed edit. See [removal boundaries](references/operations.md#remove-a-skill).

## Verify and continue

A successful `ready` result or `removed` with `cleanup_verified: true` includes
complete CLI verification. Continue only for requested review or
consumption; extra reads are not routine cleanup.

For a requested Pi consumption test after writing, refresh that source's directory
with `notion_list({query: SKILL_ID, source: SOURCE_ID, refresh: true})`, then use
ordinary `read` on its returned exact ref. This refreshes discovery, not adopted
versions. Inspect the edited target; do not activate it. Repeating an unchanged
empty query or running CLI list does not refresh the host directory.

For a CLI readback or metadata inspection:

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read PAGE_ID --database ENTRY --refresh --json
```

Use the returned PAGE_ID. Files reads metadata only. Native reads make
zero semantic Notion writes. Summarized readbacks retain page/ref, snapshot,
path, source, content bytes/hash, has_more and effects; check content itself.
CURRENT_SCHEMA_REQUIRED or CURRENT_OPERATION_PENDING never authorizes manual
field repair or bypassing unfinished management.

All four actions support --dry-run and budgets. After interruption, repeat the
same command and intent, preserving input, state and credentials. Conflicts and
unresolved writes follow [unfinished work](references/operations.md#incomplete-current-work).

## Other management

Complete import intentionally replaces the tree, removing omitted Notion-owned files:

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

See [complete import](references/operations.md#import-a-complete-current-tree) and
[projection and recovery](references/operations.md#generate-notion-text) for those tasks.
Source apply/refresh,
takeover, lifecycle and Profile/View rules use ntn-skills-sync.
Read references with `ntn-skills read RELATIVE_PATH --from CONTAINING_FILE_REF`.
For package-selected instructions, use `ctl builtin read notion/ntn-skills-maintain
--path RELATIVE_PATH`.
