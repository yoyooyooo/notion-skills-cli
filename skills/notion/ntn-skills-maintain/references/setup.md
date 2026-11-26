# Create or connect a current library

Use the installed executable or the exact command supplied by the host.
For an existing library, start with `ntn-skills ctl library inspect --library LIBRARY_ID`.
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

Without `--library`, doctor checks authentication only. The parent page must
also be shared with the connection. `ctl config show` reports the presence of
a saved token, not whether an environment token is available or valid.
Keep credentials out of chat, command arguments, and committed files.

## Create a current layout

Replace `AUTHORIZED_PARENT_PAGE` with the exact empty parent-page ID or URL:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE
```

Init creates a dedicated root page under the authorized container, then all four
tables as its direct children. Keep `library.library_id` (the root page UUID) and
`root_url`. The sole descriptor stays in the Skills table description and carries
the other exact bindings. Use `--library LIBRARY_ID` for both management and reads.

```sh
ntn-skills ctl library init --library LIBRARY_ID
ntn-skills ctl library inspect --library LIBRARY_ID
```

Both commands verify the root and four-table ownership read-only. They do not
save a default or repair an older layout. Init success means the structure is
ready; its next list can be empty. A new `init --parent` creates a new root.
Read the same executable's product guides with `ntn-skills skills get NAME`.
They are available offline and update with the CLI package.
Legacy libraries require a separately reviewed cutover; the current runtime does not attach old descriptors. See the preserved [migration requirements](https://github.com/yoyooyooo/notion-skills-cli/blob/next/docs/library-root-migration.md). The one-time executor is retired.

If requested, `ctl config set default_library LIBRARY_ID` saves the consumption
default used by CLI and SDK. Writers still require an explicit target. A full ref
selects its own root, a conflicting explicit selector fails, and short references
inside a document retain that document's Library. Keep already accepted tasks
and fixed selections bound when changing the next-turn default.

The root may contain human/Agent documentation and helper content. Keep all four
system tables directly underneath it. Rename or move the whole root freely;
copies or independently moved tables must not reuse a stale descriptor.

## Interrupted initialization

Keep the original parent, error details, returned operation ID, and the same
`NTN_SKILLS_HOME`. First inspect that initialization without remote writes:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE --operation ORIGINAL_OPERATION_ID
```

This command is read-only reconciliation. It can confirm a completed
registration whose response was lost, but it does not finish missing work.
To continue the original initialization, add `--resume`:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE --operation ORIGINAL_OPERATION_ID --resume
```

Continuation preserves the known root, table, data-source and property IDs. It creates only
tables whose creation was not attempted or was definitively rejected, and
completes missing relationships and the descriptor. A lost response is
reconciled first. Unknown root, table or relation creation that remains invisible
stays unresolved; it is not blindly repeated. The exact descriptor replacement
is idempotent and can be retried after checking the original marker and
registered identities. Human edits or conflicting objects stop continuation.

Only unfinished initialization state is retained locally; success clears it.
Losing that state does not authorize recreating a missing table. An already
registered library can still be validated or attached from a fresh client using
its exact entry. Run one initializer per parent; local locks do not provide a
cross-machine Notion transaction. Preserve unresolved objects and the original
operation rather than creating a replacement library or editing internal fields.

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
ntn-skills ctl library skill create INPUT --library LIBRARY_ID --skill-id SKILL_ID
```

Add `--dry-run` when a preview is requested. Successful creation reports
`status: "created"` and `state: "ready"`. An equal repeat reports
`status: "unchanged"`. Markdown becomes editable native content; other files
use exact resources. No artificial Source or manually authored descriptor is
needed. Native content needs no projection step.

Use `skill update` for later partial changes and
`skill register PAGE_ID --library LIBRARY_ID` for a page already authored in the current
Skills table. Complete-tree replacement uses `ctl library import`, which defaults
to exact resources. See [native management](operations.md#manage-native-skills)
and [complete import](operations.md#import-a-complete-current-tree).

## Read current content

```sh
ntn-skills list --library LIBRARY_ID --query SKILL_NAME --refresh --json
ntn-skills read EXACT_REF --library LIBRARY_ID --refresh --json
```

Select the actual record from `records` and use its `ref` in the second command.
Check the returned `path` and `content`. A new empty library contains no workflows
until you create or import them. An authentication or metadata check does not
establish that a body was read.

For a selected Skill with supporting files:

```sh
ntn-skills ctl library files PAGE_ID --library LIBRARY_ID
ntn-skills files SNAPSHOT_ID_FROM_READ
ntn-skills read RELATIVE_REFERENCE --from PINNED_CONTAINING_FILE_REF
```

Use actual page IDs, snapshot IDs, paths, and refs from that selection.
The management file index is metadata-only. Use `export` for the complete selected
tree. Read inspects a workflow; apply it with the same source's `use` route to
load Requires. Inspect an edited target without activating it.

For first business use, apply the user's selected Skill to a real task and check
the result against its method. Table readiness, discovery, body delivery and
business use are separate observations. In a fresh session, reconnect with the
saved LIBRARY_ID and repeat the read.

## Connect Pi

Pi integration is optional. The
[Broker](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.md)
owns connection configuration. In a paired Pi installation, preview one named
source and exact Library root in the chosen config:

```text
/context-broker connect SOURCE LIBRARY_ID --config /absolute/config.json
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
then select the exact test library with `--library` or test parent with `--parent`.

The launcher supplies separate configuration, state, cache, data, temporary,
and Pi directories while keeping HOME unchanged. Use those explicit application
roots; do not copy personal configuration, another client's cache, or daily
installation state. Credentials enter only through the selected environment
inputs.

Local isolation does not narrow remote token permissions. Use only the test's
own authorized objects and returned refs. Preserve unfinished work until
reconciled or explicitly abandoned. Current export can make a local backup;
the library has no remote restore interface for previous selections.
