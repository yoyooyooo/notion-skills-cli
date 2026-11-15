# First use: an empty page to a working Skill library

Use this procedure when the user authorizes creation of a new library or
connection to an exact existing one. Reading this package reference requires no
Notion library and does not install an Agent extension.

## Inputs

Use the executable supplied by the host, or the installed `ntn-skills` CLI.
Confirm its version/help before assuming an interface. Obtain one authorized
parent-page URL for a new library, or one existing Skills database entry.

The user must share the parent page with their Notion integration. The
integration needs Read, Insert and Update content for initialization and
authoring. A token alone does not select a page or establish its permissions.
Do not ask for the token in chat. Inherit `NOTION_API_TOKEN`, or have a trusted
secret source pipe it to `ctl config set-token --stdin`. `ctl config show`
reports token presence without revealing it. A saved token takes priority over
the environment; do not clear or replace it silently.

## Create or connect

For a new library, the user chooses a dedicated empty parent. Do not make them
create database fields or enter four separate database IDs.

```sh
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE
```

Keep the returned `entry` or `library.skills.database_id` as `ENTRY`. The command creates
Skills, Files, Records and Sources, including their stable field identities and
relationships. Their description markers own the mapping; do not edit those
markers or copy them to another database. Display titles can change.

Require `source_management_ready: true`. A core library without Sources is a
partial setup, not a fully ready result. Follow its returned `next.argv` to
complete the existing library. Do not initialize a replacement parent to hide a
failed attempt. Preserve original operation IDs after interruption. An unknown
creation is not permission to send another POST.

The result reports separate observations. `onboarding.remote.status` is
`ready_empty` for a newly created four-table library, `ready` for a verified
existing library, or `core_ready_source_pending` when Sources is missing.
`onboarding.local` reports existing aliases without registering one.
`onboarding.pi.status: not_observed` and `body_read: not_observed` mean the CLI
has not verified a Pi connection or a delivered body. Follow `next.argv` for
the exact entry; a successful initialization alone is not completed onboarding.

For an existing registered library, validate its real schema and relationships:

```sh
ntn-skills ctl library init --entry ENTRY
ntn-skills list --database ENTRY --refresh --json
ntn-skills ctl library sources list --entry ENTRY
```

An empty result is normal for a new library. `library inspect` reads the
descriptor; `init --entry` additionally validates the actual registered tables.
Arbitrary hand-created tables are not adopted by matching their titles. Report
the conflicting object and use an empty dedicated parent or an established
registered entry instead of rewriting unknown schema.

Register a local alias only when the user wants that preference:

```sh
ntn-skills ctl database register skills --database ENTRY
# Optional, with authorization. This preference affects create, not every command.
ntn-skills ctl config set default_database ENTRY
```

Keep explicit `--database ENTRY` on content commands and `--entry ENTRY` on
management commands. A local alias names the one entry; the four-table mapping
stays in Notion. Do not change existing Pi sources, unrelated aliases or another
default as a side effect of setup.

## First upload and read

Use an approved directory containing normal `SKILL.md` frontmatter with name
and description. Keep supporting Markdown, JSON, scripts and resources in their
relative layout. Do not execute them or resolve embedded credential commands.

```sh
ntn-skills create ./approved-skill --database ENTRY --dry-run
ntn-skills create ./approved-skill --database ENTRY
ntn-skills list --database ENTRY --query SKILL_NAME --json
ntn-skills read EXACT_REF_FROM_RESULT --database ENTRY --json
ntn-skills files SNAPSHOT_FROM_READ
ntn-skills read RELATIVE_REFERENCE --from PINNED_MAIN_REF
```

Inspect a read instead of activating the uploaded workflow merely to test it.
Require the complete verified creation result and actual current main/reference
read before declaring onboarding complete. A Source is not required for a
native local Skill. Adding the first upstream member is a separate explicit
`sources check` / `admit` task owned by `ntn-skills-sync`; a registered Source
with no members is not proof that content has been imported.

## Connect the selected Pi source

In a Pi session with Context Broker installed, preview one named source and the
same `ENTRY` in an explicitly chosen configuration file:

```text
/context-broker connect SOURCE ENTRY --config /absolute/config.json
```

Use a source name chosen for this library. The preview returns a fingerprint
and the exact command containing `--apply PREVIEW_SHA256`. Execute that returned
command only when the user has authorized this configuration change. It adds
the selected source while preserving other settings; it refuses a conflicting
source or a duplicate library identity. A matching existing source is a no-op.
When `CONTEXT_BROKER_CONFIG` already selects that file, `--config` may be omitted.

Start Pi with the same `CONTEXT_BROKER_CONFIG=/absolute/config.json`, or reload
the session already using it, then inspect Broker doctor and discover the
library through `notion_list`. Read the exact selected Skill and one needed
reference, or use it when the task calls for executing its workflow. Confirm
the returned owner/snapshot and the actual delivered body. Saving configuration
reports `configuration_saved` and `reload_required`; it does not establish
connection, activation or model delivery. Do not load unselected scripts or
binary resources to prove that discovery works.

## Test without using the daily library

Use a new authorized test parent and empty `NTN_SKILLS_CONFIG_HOME`,
`NTN_SKILLS_HOME` and `NTN_SKILLS_CACHE_HOME` directories. Isolate HOME and the
data root as well when testing local Skill installation or host settings.
Do not copy another client's config, SQLite, objects, snapshots or operation
receipts. Credentials stay in the process environment.

Use every exact `ENTRY` and object reference returned by that test run.
Changing `default_database` is not a global test-scope switch, and a different
local directory does not reduce a token's remote permissions. Keep production
settings unchanged. Do not clean a run while an original operation still needs
its private recovery records.

A fixed ref keeps its original library even when a different `--database` is
supplied. Do not copy production pins into a test journey. Use only the exact
refs returned by that test's own operations.

## Moving an old version to another client

A private snapshot ID is not a shared-history registration. A new client without
that snapshot must report it missing. To preserve one old version for another
client, explicitly use `ctl library snapshot save SNAPSHOT --entry ENTRY` on its
owning client, then `ctl library snapshot restore SHARED_PIN --entry ENTRY
--target SKILL_PAGE` on the other client. The source snapshot's raw local resources
may require `--allow-local-archive` after reviewing those exact paths. Do not copy
private caches or accept current content as the missing old version. This
optional action does not change the library's current selection.
