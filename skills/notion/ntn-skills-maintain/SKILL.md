---
name: ntn-skills-maintain
description: Create, edit, register and delete Notion-native Skills and files. Import complete trees, generate reading pages, restore Trash and resume management.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-maintain
---

# Maintain the current library

Use the task's executable and library. Reads need Read; writes need Insert/Update.
Select an exact page ID/URL or stable Skill ID, never a fuzzy title.

Read inspects. To apply, use this source's exact ref via `notion_use(ref)`
or CLI `use REF` with Requires unless already prepared. Report unavailable adoption.
Inspect edited targets; local/package workflows stay native.

## Choose the route

A supplied Notion library or successful discovery selects an existing library.
For a basic how-to, explain create/register below from this main; no reference
read is needed.
The CLI handles Notion REST; load an API Skill only for direct API work.
Open [setup](references/setup.md) only to create/connect a library or resolve a
reported connection/schema problem. Adding a Skill is not library setup.
Report progress before writes and during verification.

## Prepare local input

Use physical paths, including parents:

```sh
skill_dir=$(mktemp -d)
skill_dir=$(cd "$skill_dir" && pwd -P)
printf '%s\n' "$skill_dir"
```

Reject input and parent symlinks.

## Create or edit a native Skill

Supply content and metadata; do not construct those Notion fields
owned by the CLI: identity, authority, relationships and finite state.

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
normalize. Resources stay byte-exact. Native bodies stay editable;
no projection is needed. See [native management](references/operations.md#manage-native-skills).

## Register or remove

Register a page in the current Skills table without replacing its body:

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

`ready`, `removed` with `cleanup_verified: true`, or complete projection
with `scope:skill/status:complete` includes complete CLI verification. A restore
reports restoration.status restored or unchanged. Continue only for requested review or
consumption, using read-only paths. Repeat completed work only for a new user
request or an explicit idempotence test.

For requested Pi inspection, refresh the source directory
with `notion_list({query: SKILL_ID, source: SOURCE_ID, refresh: true})`, then use
ordinary `read` on its returned exact ref. This refreshes discovery, not adopted
versions. Inspect the edited target; do not activate it. Repeating an unchanged
empty query or running CLI list does not refresh the host directory.

For CLI readback:

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

Complete import replaces the tree, removing omitted Notion-owned files:

```sh
ntn-skills ctl library import INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
```

First import infers Members only from exact refs; existing sets and `[]` win.
Requires stays explicit. Follow [import and Members planning](references/operations.md#import-a-complete-current-tree)
or [projection/recovery](references/operations.md#generate-notion-text).
Source operations and Profile/View rules use ntn-skills-sync.
Read references with `ntn-skills read RELATIVE_PATH --from CONTAINING_FILE_REF`.
For package-selected instructions, use `ctl builtin read notion/ntn-skills-maintain
--path RELATIVE_PATH`.
