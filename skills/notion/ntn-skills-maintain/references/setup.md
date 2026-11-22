# Create or connect a current library

Use the installed executable or the exact command supplied by the host.
For an existing library, start with `ntn-skills ctl library inspect ENTRY`;
do not create another parent because the client is unconfigured. For a new
library, use the dedicated parent already authorized by the task.

## Inputs

Keep one exact Skills database entry, or one authorized parent-page URL.
The existing integration needs Read content for consumption and Insert/Update
content for setup. A token does not establish access to a particular page.
Inherit `NOTION_API_TOKEN`, or use a trusted secret source with
`ctl config set-token --stdin` when configuring credentials is requested.
`ctl config show` reports presence; a saved token takes precedence.

## Create a current layout

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE
```

Keep the returned Skills database ID as ENTRY. The command creates Skills,
Files, Records and Sources with stable property identities and relationships.
Display titles may change; descriptor markers are machine-owned mappings.

Initialization does not import content, produce every reading page or connect
Pi. Inspect the actual returned status and complete any explicitly returned
pending-table action in its original scope. An unknown create is not permission
to send another POST or create a replacement library.

### Continue an interrupted initialization

Keep the original parent, returned `operation_id`, and the same
`NTN_SKILLS_HOME`. First inspect the original operation without remote writes:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE --operation OPERATION_ID
```

To continue its known unfinished steps, add `--resume`:

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE --operation OPERATION_ID --resume
```

Continuation preserves known table, data-source and property IDs, creates only
tables whose creation was not attempted or was definitively rejected, and
completes the missing relationships and descriptor. A lost response is
reconciled first. Unknown table or relation
creation that remains invisible stays unresolved; it is not blindly repeated.
The exact descriptor replacement is idempotent and can be retried after checking
the original marker and registered table identities. Human edits or conflicting
objects stop continuation with the original operation and next commands intact.

Only unfinished initialization state is retained locally, and successful
continuation clears it. Losing that state cannot authorize recreating a missing
table. An already registered library can still be inspected or attached from a
fresh client using its exact entry. Run one initializer per parent; local locks
do not provide a cross-machine Notion transaction.

For an existing current library:

```sh
ntn-skills ctl library init --entry ENTRY
ntn-skills list --database ENTRY --refresh --json
```

`init --entry` validates registered tables. `inspect` reads the library
descriptor without changing schema. Neither fills missing Content descriptors.
If current schema is required, keep the exact error and returned next action;
do not rewrite unknown fields or revive an unavailable writer.

## Read current content

```sh
ntn-skills list --database ENTRY --query SKILL_NAME --json
ntn-skills ctl library files PAGE_ID --entry ENTRY
ntn-skills read EXACT_REF --database ENTRY --refresh --json
ntn-skills files SNAPSHOT_ID
ntn-skills read RELATIVE_REFERENCE --from 'CONTAINING_FILE_REF'
```

Copy IDs and refs from actual results. The file index is metadata-only; a main
read does not prove every supporting byte was downloaded. Use `export` for the
complete selected tree. An empty new library is a valid empty layout, not
completed content onboarding.

Create a Notion-native Skill with one stable identity:

```sh
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID --dry-run
ntn-skills ctl library skill create INPUT --entry ENTRY --skill-id SKILL_ID
```

Markdown becomes editable native content; other files use exact resources. No
artificial Source or manually authored descriptor is needed. Read the returned
Skill only for requested review or consumption. Use `skill register PAGE_ID --entry ENTRY` for a page already authored in
the current Skills table, and `skill update` for later changes. Complete-tree
replacement remains `ctl library import`; it defaults to exact resources and
requires explicit projection for generated reading text. None of these commands
converts an older library schema or proves that every local Skill has migrated.

## Connect Pi

The Broker owns connection configuration. In a paired Pi installation, preview
one named source and exact entry in the chosen config:

```text
/context-broker connect SOURCE ENTRY --config /absolute/config.json
```

When that configuration change is already authorized, use the exact apply
command returned by the preview. It must preserve unrelated settings. Reload
Pi with the same selected config. A saved configuration and an installed CLI do
not prove an active connection or model delivery.

Discover the library, read a selected workflow and a needed reference through
the actual host. Use the workflow only when the task calls for activation.
Record actual delivered content and owner/selection. OMP/Tern host acceptance is
outside this current Pi route.

## Isolated checks

Use an authorized test parent and empty `NTN_SKILLS_CONFIG_HOME`,
`NTN_SKILLS_HOME` and `NTN_SKILLS_CACHE_HOME`. Isolate HOME and the data root
when testing local installation or host settings. Credentials stay in the
process environment; do not copy personal config or another client's cache.

A local directory does not narrow remote token permissions. Use only exact refs
returned by that test's own current operations. Preserve unfinished current
work until it is reconciled or explicitly abandoned. Current content export is
available for a user-requested local backup; the library has no remote restore
interface for previous selections.
