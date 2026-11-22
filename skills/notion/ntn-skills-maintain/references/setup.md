# Create or connect a current library

Use the installed executable or the exact command supplied by the host.
For an existing library, start with `ntn-skills ctl library inspect ENTRY`.
For a new library, use a dedicated empty parent page authorized by the task.
Keep the actual IDs and command results for the steps below.

## Credentials

Use an internal Notion connection with Read content for consumption and
Insert/Update content for setup and authoring. Add that connection to the
selected parent page. Notion's
[authorization guide](https://developers.notion.com/guides/authorization/overview#internal-connection-auth-flow-set-up)
covers connection creation and page access.

Inherit `NOTION_API_TOKEN` from the terminal or Agent environment.
If saving credentials is requested, pipe one token from a trusted secret source
into `ntn-skills ctl config set-token --stdin`. This command requires piped input;
it does not prompt for a token. A saved `config.token` takes precedence over the
environment.

```sh
ntn-skills ctl doctor
```

Without `--database`, doctor checks authentication only. The parent page must
also be shared with the connection. `ctl config show` reports the presence of
a saved token, not whether an environment token is available or valid.
Keep credentials out of chat, command arguments, and committed files.

## Create a current layout

Replace `AUTHORIZED_PARENT_PAGE` with the exact empty parent-page ID or URL:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE
```

Copy `library.skills.database_id` from the returned JSON and keep it as ENTRY.
The command creates Skills, Files, Records, and Sources with stable property
identities and relationships. All four bindings live in the Skills entry.
You do not need to register the other three IDs with each client.

Use `--entry ENTRY` for management and `--database ENTRY` for consumption.
Initialization does not set a local default library, import content, or connect
Pi. Display titles may change; the descriptor maintains the table mappings.

For an existing current library, validate its registered tables:

```sh
ntn-skills ctl library init --entry ENTRY
```

`init --entry` reads and validates the existing layout. It does not register
local configuration. `inspect ENTRY` reads the descriptor without inspecting
all table schemas. Neither command fills missing Content descriptors or
converts an older library schema.

## Interrupted initialization

Keep the original parent, error details, and operation ID. To inspect that
initialization, use its exact returned ID:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE --operation ORIGINAL_OPERATION_ID
```

This is read-only reconciliation. It can confirm a completed registration whose
response was lost. It does not create missing tables, add missing relationships,
or write an absent library descriptor. `LIBRARY_INIT_INCOMPLETE` can therefore
remain unresolved after this command. Do not describe it as a general resume.

Preserve unresolved objects and the original operation. An unknown write or a
missing result is not permission to repeat a POST, edit internal fields by hand,
or create a replacement library. Follow the actual error within the original
scope.

## Create a native Skill

Prepare the task's content in a physical local directory containing `SKILL.md`.
Resolve temporary-directory aliases before writing the input:

```sh
skill_dir=$(mktemp -d "${TMPDIR:-/tmp}/ntn-skill.XXXXXX")
skill_dir=$(cd "$skill_dir" && pwd -P)
```

The main file needs a description. Supply both name and description in
frontmatter, for example:

```markdown
---
name: decision-review
description: Review a proposed decision before implementation.
---

When reviewing a decision:
1. State the goal and constraints.
2. Compare the proposed choice with one viable alternative.
3. Identify the biggest risk and a concrete next step.
```

Replace INPUT with the actual directory and SKILL_ID with a stable identity:

```sh
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
```

Add `--dry-run` when a preview is requested. Successful creation reports
`status: "created"` and `state: "ready"`. An equal repeat reports
`status: "unchanged"`. Markdown becomes editable native content; other files
use exact resources. No artificial Source or manually authored descriptor is
needed. Native content needs no projection step.

Use `skill update` for later partial changes and
`skill register PAGE_ID --entry ENTRY` for a page already authored in the current
Skills table. Complete-tree replacement uses `ctl library import`, which defaults
to exact resources. See [native management](operations.md#manage-native-skills)
and [complete import](operations.md#import-a-complete-current-tree).

## Read current content

```sh
ntn-skills list --database ENTRY --query SKILL_NAME --refresh --json
ntn-skills read EXACT_REF --database ENTRY --refresh --json
```

Select the actual record from `records` and use its `ref` in the second command.
Check the returned `path` and `content`. A new empty library contains no workflows
until you create or import them. An authentication or metadata check does not
establish that a body was read.

For a selected Skill with supporting files:

```sh
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills files SNAPSHOT_ID_FROM_READ
ntn-skills read RELATIVE_REFERENCE --from PINNED_CONTAINING_FILE_REF
```

Use actual page IDs, snapshot IDs, paths, and refs from that selection.
The management file index is metadata-only. Use `export` for the complete selected
tree. Read inspects a workflow; apply it with the same source's `use` route to
load Requires. Inspect an edited target without activating it.

## Copy packaged workflows into Notion

This optional route creates editable native copies of the three packaged
workflows. It does not establish a Git Source or follow future package updates.
The copies have their own Notion identities. Use a new library or choose stable
IDs that are not already owned by different content.

Set `library_entry` to the actual Skills entry. Create only the parent export
directory; each export creates its own new child directory:

```sh
library_entry='PASTE_LIBRARY_SKILLS_DATABASE_ID'
bootstrap_dir=$(mktemp -d "${TMPDIR:-/tmp}/ntn-bootstrap.XXXXXX")
bootstrap_dir=$(cd "$bootstrap_dir" && pwd -P)

ntn-skills ctl builtin export notion/ntn-skills \
	--output "$bootstrap_dir/ntn-skills"
ntn-skills ctl library skill create "$bootstrap_dir/ntn-skills" \
	--entry "$library_entry" --skill-id ntn-skills

ntn-skills ctl builtin export notion/ntn-skills-maintain \
	--output "$bootstrap_dir/ntn-skills-maintain"
ntn-skills ctl library skill create "$bootstrap_dir/ntn-skills-maintain" \
	--entry "$library_entry" --skill-id ntn-skills-maintain

ntn-skills ctl builtin export notion/ntn-skills-sync \
	--output "$bootstrap_dir/ntn-skills-sync"
ntn-skills ctl library skill create "$bootstrap_dir/ntn-skills-sync" \
	--entry "$library_entry" --skill-id ntn-skills-sync
```

All Markdown main files and references become native. Verify the actual results
with scoped `list --refresh`, read each returned ref, and inspect its file
directory. Read supporting references from the same selection. No projection
is needed for these native copies.

For byte-exact package originals instead, use the separate
[complete import](operations.md#import-a-complete-current-tree) resource route
and generate its reading projection. Choose that authority before writing.

## Connect Pi

Pi integration is optional. The
[Broker](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.md)
owns connection configuration. In a paired Pi installation, preview one named
source and exact entry in the chosen config:

```text
/context-broker connect SOURCE ENTRY --config /absolute/config.json
```

When that configuration change is already authorized, use the exact apply
command returned by the preview. Reload Pi with the same selected config.
Configuration saved, remote library access, and body delivery are separate
observations.

Discover the library through the host, read a selected workflow and a needed
reference, and use the workflow only when the task calls for activation.
OMP/Tern host acceptance is outside this current Pi route.

## Isolated checks

Use the shared
[isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md)
for development or onboarding checks. It owns the environment commands.
Choose an absolute task-owned `--root` and an explicit `--build` for each run,
then select the exact test library with `--entry` or test parent with `--parent`.

The launcher supplies separate configuration, state, cache, data, temporary,
and Pi directories while keeping HOME unchanged. Use those explicit application
roots; do not copy personal configuration, another client's cache, or daily
installation state. Credentials enter only through the selected environment
inputs.

Local isolation does not narrow remote token permissions. Use only the test's
own authorized objects and returned refs. Preserve unfinished work until
reconciled or explicitly abandoned. Current export can make a local backup;
the library has no remote restore interface for previous selections.
