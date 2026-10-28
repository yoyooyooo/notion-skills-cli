# Usage guide

Start with [English](../README.md#quick-start) or [简体中文](../README.zh-CN.md#快速开始) for the first successful read. This guide covers installation variants and everyday operations. The [protocol](protocol.md) owns exact command, response and storage semantics; the [documentation index](README.md) routes to host integration and publishing.

## Daily workflows

Choose the task, then retain the returned identities for subsequent commands:

| Task | Entry point |
| --- | --- |
| Use a stored workflow | `list`, then `read` and pinned supporting-file reads |
| Create content | `create INPUT --database LIBRARY` |
| Change files and properties together | `read CURRENT --refresh`, then `apply PINNED_MAIN_REF --input CHANGED_FILES` |
| Bring Git Skills into Notion | `sync upstream connect SOURCE --database LIBRARY`, then `sync upstream run --target SUBSCRIPTION_ID` |
| Keep a Notion page and local directory synchronized | `sync local connect PAGE_ID --path DIRECTORY`, then `sync local run BINDING` |
| Inspect an interrupted operation | `operation show OPERATION_ID`, then its returned `next.argv` |

In Context Broker, select `$ntn-skills-maintain@builtin` for content changes or `$ntn-skills-sync@builtin` for subscriptions and local synchronization. These package Skills are available through ordinary `$` discovery with their supporting files, without publishing a copy to Notion. The host supplies the executable argv and source/database scope; use those values when there are multiple configured sources.

## Initialize content and subscription tables

Use an owned parent page and an integration with schema write permission:

```bash
ntn-skills ctl database init --parent PARENT_PAGE_ID
```

The response retains exact content/upstream database IDs, data-source IDs and property IDs with a durable operation ID. Repeating the same target resumes that operation. To attach existing tables, supply both `--content-database CONTENT_ID --upstream-database UPSTREAM_ID`. Existing wrong field types or relation targets fail before changes. A pending create with an unknown response is reconciled by the parent operation marker; do not create replacements by matching a title.

Content origin is `Source Type` select (`builtin`, `upstream`, `manual`) plus exact rich-text `Builtin ID`, independently of Kind and Sync Mode.

To add these fields, repeat the original `ntn-skills ctl database init` inputs. Keep the original `--parent` or exact content/upstream table IDs. Optional `--operation OPERATION_ID` pins that same journal, including an already-published attach. Changing its parent or table inputs returns `OPERATION_CONFLICT`.

Initialization adds missing fields after validation without backfilling rows. Ordinary create assigns manual when both compatible fields exist, supports legacy tables missing them, and rejects incompatible present fields. Ordinary replace/write preserve provenance, including unset. Empty Upstream never implies manual. Public record JSON and CLI source flags remain unchanged.

The content table owns Kind, Description, Default Context, References, Files, Members and provenance fields. Members is a relation to multiple Skill pages; it has no reverse property and never means a single-member limit. Upstream/Skills is a native dual relation; each content record has at most one upstream owner. The subscription table owns source configuration and an independently published active-member document. `upstream_database` stays separate from the ordinary `default_database`; use `--set-default` only when deliberately choosing the new content table for writes.

The subscription table's native URL property `Source URL` is a clickable display projection of `Source`, not a second editable source configuration. Add/update derives it automatically: Git/marketplace HTTP URLs retain their host/path (without a trailing `.git`); GitHub SSH remotes become HTTPS; registry sources link to `BASE_URL/OWNER/skills/SLUG`; local Git paths leave it empty. Repeat database initialization to add the column to an existing table. Existing rows need one backfill or a normal subscription update. `Source`, `Mapping` and `Published Members` may be hidden in everyday Notion views; synchronization still uses their complete machine-readable configuration.

## Connect an upstream source

Connect a Git repository and synchronize its selected Skills in one command:

```bash
ntn-skills sync upstream connect GIT_SOURCE_URL --database LIBRARY --name 'Team Skills'
ntn-skills sync upstream list
ntn-skills sync upstream run --target SUBSCRIPTION_ID_FROM_CONNECT
```

Omit `--name` and `--description` to derive them from the source. The default Git ref is `HEAD`, the default root is `.`, and discovery finds member directories containing `SKILL.md`. A GitHub tree URL selects its ref and directory; use explicit `--ref` when the branch name contains slashes. Repeat `--root`, `--include` or `--exclude` to narrow discovery. Include/exclude patterns match member directory paths, such as `skills/alpha` or `skills/**`.

The target database follows ordinary creation selection: explicit `--database`, configured default, then a sole discovered library. A matching connection reuses the existing subscription and its original creation identity without replacing its saved configuration. The result contains `subscription`, `reused` and the run outcome. Retain its exact subscription ID. `sync upstream list` returns entries in `items`.

Use `status SUBSCRIPTION_ID` for local observations and `check SUBSCRIPTION_ID` for current remote metadata. When a separate review is needed, `plan SUBSCRIPTION_ID` and `apply PLAN_ID` retain the exact reviewed candidate. Recurring work uses `run`, with repeatable `--target SUBSCRIPTION_ID` or `--all`, exclusively.

The subscription `name` (the upstream row's Notion `Name`) also configures its members' completion namespace through the existing name-to-alias rules. `Pstack` displays members as `pstack/correct`; `Matt` displays them as `matt/retro`. Repository names and source subdirectories do not control these labels. No additional Notion property is required. Member aliases and exact references remain unchanged; refresh the catalog after editing the subscription name.

An automatic subscription Router is listed and readable only with at least two verified published active Skills. With zero or one published member, no automatic Router is offered; the individual Skill pages and their upstream display namespace remain available independently. Exact current subscription Router refs fail with `UPSTREAM_ROUTER_UNAVAILABLE` below this threshold. Previously pinned snapshots remain readable as immutable history. This threshold does not apply to manually authored content-table Routers or change subscription synchronization status.

Router and Prompt share the content table. Router instructions and their member index form one fixed snapshot; member refs can be read separately without eagerly loading bodies. Prompt is explicitly selected per user submission and is added again on later turns, while its prepared bytes may be reused. Prompt never enters default/native Skill discovery. Exported portable v2 declares kind and its real entrypoint. Use returned fixed refs for follow-up reads and relative resources.

For Router `create`, `apply`, `replace` and `update`, repeat `--member EXACT_SKILL_ID_OR_REF` to set the complete Members relation, or use `--clear-members` to empty it. Members must resolve to accessible current Skill pages in the same content database and data source; Router, Prompt and subscription identities are rejected. IDs are deduplicated and sorted. Omit both flags to preserve Members on apply/replace/update; create starts with no Members. Authored instructions and supporting resources remain separate from the generated index: `export EXACT --output PATH` defaults to `--projection source` for a portable source copy, while `--projection snapshot` exports the fixed materialized read view with the index. Export receipts identify projection/entrypoint and every file's path, byte count, hash and role.

Member selectors accept current page IDs/URLs, `notion_page:<UUID>` or `skill://<UUID>` with no path or `/SKILL.md`. Names, aliases, pinned snapshots and resource paths are rejected. Resolution checks current permission and metadata without fetching member instructions.

### Recurring upstream synchronization

Use `sync upstream run` as the command invoked by your scheduler. It first continues any retained publication against its original frozen plan, then fetches the source and applies a fresh plan for each selected subscription. Unknown original effects stop that subscription without creating a new intent. Choose explicit subscriptions or all enabled subscriptions:

```bash
ntn-skills sync upstream run --target SUBSCRIPTION_ID
ntn-skills sync upstream run --target FIRST_SUBSCRIPTION_ID --target SECOND_SUBSCRIPTION_ID
# Alternatively, select every enabled, non-removed subscription:
ntn-skills sync upstream run --all
```

The Upstream table records `Sync Status`, `Last Sync Attempt`, `Last Synced` and `Sync Summary`. Status moves from `running` to `succeeded`, `partial` or `failed`. Every successful run refreshes `Last Synced`, including a run with no source changes; failed or partial runs retain the previous successful time. Notion dates use its native minute precision. The existing `Status` field continues to describe published membership.

For existing tables, add the required fields through the same initialization command with a new operation ID:

```bash
ntn-skills ctl database init --content-database CONTENT_DATABASE_ID --upstream-database UPSTREAM_DATABASE_ID --operation sync-status-fields
```

The command validates existing schemas and adds missing fields. Historical rows remain blank until their first run. Use the existing authentication, config, state and cache roots in the scheduler; overlapping runs of the same subscription sharing one state root return `SYNC_LOCKED` for the overlapping target. A failed subscription does not stop later targets. Exit 0 means every selected subscription succeeded; partial or failed batches exit 1 with `UPSTREAM_SYNC_INCOMPLETE` and per-subscription results in `error.details`. See [workflow result fields](protocol.md#upstream-synchronization-workflow-results).

A run restores a mapped tracked member when its exact owned page is readable and confirmed in Notion Trash. It publishes a distinct page from the still-selected current source and updates that member mapping. Missing permission, an unreadable page or an unknown response never counts as deletion; source-removed/excluded members and fork-owned pages are retained. A repeated run continues the original restoration operation. The result reports restored members and per-member outcome counts.

When a run stops, inspect `status`/`check` or its returned operation identity and follow `next.argv`. Historical one-off replacement and conversion commands are documented separately in the [operator reference](historical-operations.md).

### Advanced subscription configuration

For a registry/marketplace source or complete explicit source configuration, create a subscription with `sync upstream add --input CONFIG.json --operation OPERATION_ID`; replace its complete configuration with `sync upstream update SUBSCRIPTION_ID --input CONFIG.json --if-version OBSERVED_VERSION`. Both require strict JSON with every field below; unknown fields are rejected and update is not a partial patch.

| Required field | JSON type |
| --- | --- |
| `target_database_id`, `name`, `description` | string |
| `default_context`, `enabled` | boolean |
| `source` | object with required `provider` and optional fields below |
| `roots`, `include`, `exclude` | arrays of strings |
| `mapping` | object mapping strings to strings |

`source.provider` is one of `{ "type": "git", "url": "...", "ref": "..." }`, `{ "type": "registry", "base_url": "...", "owner": "...", "slug": "..." }` (optional string `version`), or `{ "type": "github-market", "url": "..." }` (optional string `ref`). Optional `source` fields are string `shared_target_set`, `publisher_subscription_id`, `accepted_ref`, `strip_prefix`, `target_prefix`, `target_mode`; boolean `require_all_included`; and `patch` shaped as `{ "version": 1, "files": [{ "path": "...", "replacements": [{ "from": "...", "to": "..." }] }] }`.

## Installation options

Install [Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+](https://nodejs.org), including npm. Online use also needs the [official Notion CLI](https://developers.notion.com/cli). [Source builds](../CONTRIBUTING.md#development-setup) use Bun 1.4.3.

### Install from npm globally

Install from the official registry:

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --help
```

On Unix, npm installs global executables under `$(npm prefix --global)/bin`; ensure that directory is on PATH. If it is missing, add it to your shell configuration:

```bash
export PATH="$(npm prefix --global)/bin:$PATH"
```

### Install a local tarball globally

For an offline or unpublished build, replace the archive path with the file supplied by a maintainer:

```bash
npm install --global /absolute/path/ntn-skills-VERSION.tgz
ntn-skills --help
```

The filename follows the package version. Global PATH setup is the same as for registry installation.

### Install in a consuming project

From the consuming project's root:

```bash
npm install ntn-skills --registry https://registry.npmjs.org
export PATH="$PWD/node_modules/.bin:$PATH"
ntn-skills --help
```

This consumes the built package with Node.js. Global and project-local installs use the same package boundary. Build and pack steps belong to [Contributing](../CONTRIBUTING.md#development-setup).

To pin a published version, use `ntn-skills@VERSION`. To consume a local tarball instead, replace the package name with its absolute archive path.

## Authentication

Authentication priority is non-empty `config.token` → non-empty `NOTION_API_TOKEN` → existing `ntn login`. Configure `ntn` through [its authentication guide](https://developers.notion.com/cli/get-started/authentication), or pipe one token from a trusted secret source into `ntn-skills ctl config set-token --stdin`. Never place a token in a command argument or a report.

The saved token is plaintext in the private configuration file. `set-token` works offline and validates input shape, not remote access. `ctl config show` exposes `token_configured` and omits the token. Check access with `ctl doctor`. Remove a saved token with `ctl config clear-token` to restore environment/login fallback. Both commands preserve sources and the default database. The CLI never starts login or reads `ntn`'s private credential files.

Read content and an accessible database with rich-text Description/References are sufficient for page-based reads. Existing native Skills databases use the Skills export API when References is absent. Mutations require Insert/Update content; uploads additionally require a Files property. `ctl doctor` reads and caches one available Skill and reports skill_read.storage.

Eligible cached reads require a locally distinguishable credential/workspace/endpoint scope. With existing official `ntn login`, the CLI may need online identity validation even for an otherwise warm read; unpinned `--offline` lookup fails when scope cannot be determined safely. Explicit pinned snapshots remain offline and can outlive remote permission. Never infer current authorization from cached bytes.

## Discovery and identity

Default discovery paginates Notion Search and accepts native Skills databases or data sources with rich-text Description and References. Registered sources supplement Search. Search is eventually consistent and [does not guarantee exhaustive enumeration](https://developers.notion.com/reference/search-optimizations-and-limitations). A missing result means absent from the discovered scope, not necessarily from the workspace.

`Default Context` is an optional ordinary checkbox. `list` includes its boolean value, with missing/unchecked reported as false; mistyped properties fail. A saved Notion View may filter on it. Hosts use the selected View's result directly, without applying the checkbox again. Unfiltered discovery and explicit reads keep every accessible record. CLI content mutations do not automatically set this checkbox.

Replace database placeholders before running:

```bash
ntn-skills ctl database register frontend --database 'FRONTEND_DATABASE_ID_OR_URL'
ntn-skills ctl database register ops --database 'OPS_DATABASE_ID_OR_URL'
ntn-skills ctl database list
ntn-skills list --database frontend
ntn-skills read 'Release Review' --database ops
ntn-skills ctl config show
ntn-skills list --refresh
```

Every `--database` accepts one ID, Notion URL or exact registered alias. Aliases are case-sensitive; database titles are display labels. Repeated selectors fail even when identical, and an inaccessible selection never falls back. `ctl config set default_database 'frontend'` stores the canonical ID and affects creation only. Omitting a selector for reads still discovers all visible and registered sources. Pinned reads with alias constraints resolve registrations locally and check the cached database ownership. Inspect local registrations offline with `ctl config show`; remove an exact alias offline with `ctl database unregister frontend`. Unregister preserves remote content and saved canonical preferences. Use `ctl database init` to create or attach the content/upstream tables as described above.

`list --query` filters Name, invocation alias and Description after pagination. It returns metadata plus the full queried `databases` map and `coverage`; bodies and file manifests are excluded. Join each record's `locator.database_id` to that map. A record's invocation alias and its database's registered alias have different meanings. `database list` discovers content databases without querying rows. Catalog observations default to 60 seconds; `list --refresh` validates online, and `--offline` deliberately uses an eligible stored catalog without upgrading its coverage.

The full catalog map also includes queried subscription sources with `role:"upstream"`; ordinary content sources use `role:"content"`. Join `record.locator.database_id` and `data_source_id` to that map and successful-query coverage. A subscription Router's locator identifies its upstream source, while its `target_database_id` identifies the selected content destination. This source metadata does not make the subscription table an ordinary content library.

Notion Name and authored frontmatter `name` preserve exact human-readable spelling; they must be nonempty and contain no control characters. Unicode, digits, spaces and hyphens are allowed: `Tty7`, `n8n-workflow`, `React19` and `中文` stay unchanged. Their callable aliases are `tty7`, `n8n-workflow`, `react19` and `中文`. Aliases normalize to NFC and lowercase, trim surrounding whitespace, replace whitespace runs with `-`, and percent-encode characters outside Unicode letters, marks, numbers, `_` and `-`; `Review/2026` becomes `review%2F2026`. References mode generates frontmatter from the exact title; authored frontmatter and export directories need not equal the alias. Name lookup accepts exact display titles or aliases, but neither is identity. Collisions return `SKILL_AMBIGUOUS` and require an exact page ID/URL or returned identity ref; failed discovery prevents proving uniqueness and returns `CATALOG_INCOMPLETE`. Title changes preserve page IDs and stable member keys. [Identity and selector contract](protocol.md#identity-and-references).

## Optional official Skills

The CLI distributes three project-maintained Skills, each independently available through the exact-ID `ctl builtin` catalog. “Official” denotes this project's distribution, not Notion, Inc. endorsement.

| Builtin ID | Task | Packaged source |
| --- | --- | --- |
| `notion/ntn-skills` | Discover and consume workflows; route maintenance, sync and diagnosis | [Entrypoint](../skills/ntn-skills/SKILL.md) |
| `notion/ntn-skills-maintain` | Create/update selected Notion content, References and portable copies; verify/recover writes | [Content maintenance](../skills/notion/ntn-skills-maintain/SKILL.md) |
| `notion/ntn-skills-sync` | Connect Git subscriptions or local directories, run synchronization and resolve retained outcomes | [Synchronization](../skills/notion/ntn-skills-sync/SKILL.md) |

Context Broker exposes all three package Skills through ordinary `$` with an explicit `@builtin` suffix; their complete instructions and references are available offline without a local installation or Notion publication. Load bodies only when selected. When enabled, OMP/Pi Context Broker independently supplies a short default CLI XML instruction with executable argv, source/database scope, discovery/read/resource commands and help. It deduplicates the effective context and restores the instruction after compaction removes it. Maintenance and sync can be installed independently or read from the package when requested. Installing Skills does not register host hooks or populate the remote catalog automatically. See the [host guidance contract](host-integration.md#portable-shell-integration).

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin read notion/ntn-skills --path references/integration.md
ntn-skills ctl builtin install notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills-sync
ntn-skills ctl builtin install notion/ntn-skills-maintain
ntn-skills ctl builtin status notion/ntn-skills-maintain
ntn-skills ctl builtin update notion/ntn-skills-maintain
ntn-skills ctl builtin install notion/ntn-skills --agent-dir ~/.claude --agent-dir ~/.pi/agent
ntn-skills ctl builtin export notion/ntn-skills-maintain --output ./ntn-skills-maintain
```

These commands work offline without `ntn` or credentials. `list` returns package metadata and local installation state without loading instruction bodies; `status [ID]` inspects one or all builtins. Files install once under `${XDG_DATA_HOME:-~/.local/share}/ntn-skills/skills/<builtin-name>`, or `NTN_SKILLS_DATA_HOME/skills/<builtin-name>` when set. Every install includes a default link at `~/.agents/skills/<builtin-name>`. Repeat optional `--agent-dir DIR` to add `DIR/skills/<builtin-name>` links for other Agents; these are distribution destinations, not separate installation stores. Registered destinations persist and share later updates. Export produces a complete portable folder, or ZIP when output ends in `.zip`, reuses identical output and rejects differing bytes; it does not register an installation.

Install publishes the complete central Skill tree and a version-2 `.ntn-builtin-install.json` receipt together. The receipt identifies the exact builtin, canonical data directory/path, package version, content ID and every exported file's path, byte count and SHA-256, excluding the receipt itself. Distribution ownership is recorded separately outside the Skill tree. Keep both records: they establish a local baseline and managed links, not trusted remote origin. Repeated install of identical registered content reuses the tree and can add distribution targets. Update compares content IDs, replaces a clean central tree as a whole, and retains prior bytes through system Trash; all valid distribution links then read the new tree.

Status reports central `not_installed`, `current`, `update_available`, `modified`, `unmanaged` or `interrupted`, separately from each distribution's status. Added, removed or changed files, including hidden files, protect local edits with `BUILTIN_MODIFIED`; an existing central directory without a matching receipt returns `BUILTIN_UNMANAGED`. Foreign or changed distribution entries return `BUILTIN_DISTRIBUTION_CONFLICT`; a registry error appears as `distribution_error` without changing the central content state. Missing updates return `BUILTIN_NOT_INSTALLED`; install of clean older registered content returns `BUILTIN_UPDATE_AVAILABLE`, requiring explicit update. Preserve bytes rather than removing receipts to force replacement. Status is read-only. After interruption, the next install/update performs locked journal readback and still returns `BUILTIN_INTERRUPTED` with recovery/outcome: a proven published tree may finish retention, a missing target may restore a proven prior tree, or an untouched transaction may be `not_applied`. Inspect status before explicitly repeating; unproven outcomes remain fenced. Preserve evidence outside `skills`. [Receipt, state and response contract](protocol.md#official-built-in-skills).

A bootstrap copied by hand has no installation receipt and remains unmanaged. Foreign symlinks and another tool's managed directories also remain protected. Do not fabricate a receipt or overwrite them: deliberately retain the old entry through verified system Trash before using its name. Receipt-v1 profile installations require the independent migration artifact described under configuration and storage. Normal install/update commands reject legacy destinations without changing their bytes.

After an explicit local installation or update, reload or restart consuming hosts to refresh their native Skill catalogs. Updating the CLI package changes its available bundled content; `ctl builtin update` adopts that content centrally and never publishes to Notion. Broker users select package builtins through ordinary `$`; the former `/ntn-skills` and dedicated management palettes are removed. [Host contract](host-integration.md#bundled-skills-in-hosts).

`ctl builtin list` supplies exact IDs such as `notion/ntn-skills-maintain`, `origin: builtin`, `publisher: ntn-skills`, package version and content ID. The ID is separate from invocation name and Notion page identity. Only exact IDs select built-ins; ordinary `list/read` retain their remote scope and never fall back to package content. A remote same-name page, copied metadata or registered database alias cannot establish official origin. Copies become ordinary editable remote Skills; upgrades are explicit.

Optionally select a publication database using the same ID/URL/exact-alias selectors as other configuration:

```bash
ntn-skills ctl config set builtin_database ops
ntn-skills ctl config show
ntn-skills ctl builtin publish notion/ntn-skills-maintain --dry-run
ntn-skills ctl builtin publish notion/ntn-skills-maintain
ntn-skills ctl config unset builtin_database
```

Set validates online and saves a canonical `builtin_database` ID; clear works offline and preserves other settings. First publication selects `--database` → `builtin_database` → `default_database` → sole fresh discovered database. Invalid/inaccessible selections never fall back. It uses create semantics: any existing same-name Skill, including an earlier package copy, fails with `CREATE_CONFLICT` without replacement. `--database` can override the publication default for one invocation.

For a deliberate update, freshly read the chosen page, compare it with the package version, and use `ctl builtin publish notion/ntn-skills-maintain --target 'PINNED_MAIN_REF' --dry-run`, then the same command without dry-run within authorization. Targets must be page IDs/URLs, page-ID main refs or snapshot IDs; display/invocation names cannot select updates. The target owns its destination; neither publication nor ordinary creation defaults redirect it. An explicit `--database` constrains it. Existing import version/scope checks, full-file replacement and partial/unknown readback rules apply; customizations are not merged automatically. The response's `builtin` metadata identifies the submitted package content, not remote ownership. See [the exact contract](protocol.md#official-built-in-skills).

Builtin publication requires compatible source fields before any remote mutation and records builtin plus its trusted exact ID, such as `notion/ntn-skills-maintain`. Upstream publication records upstream and clears Builtin ID; tracked/fork mode does not change origin. Remote metadata grants no local official identity. Equal content with differing requested provenance performs a journaled metadata-only update (`reused: false`) without content/resource upload; complete equality reuses without remote mutation. Resume uses frozen original source intent and property IDs, including absence in old receipts, rather than accepting new source choices.

Publication commands accept `--progress` to emit JSONL stage events on stderr, including `operation_id`, `stage`, `status`, `elapsed_ms` and `stage_ms`. Omit it to disable progress events; stdout remains one final JSON value. Node.js runtime warnings remain visible on stderr, so consumers must not assume stderr is empty or contains only JSONL. This applies to `ctl builtin publish`, `create`, `replace`, `write` and the recovery command below.

## Reading a fixed version

An unpinned read selects a complete snapshot from a recent eligible observation or validates online and saves it locally, while emitting only the requested file. The default content age limit is five minutes. Retain `read.ref`, `read.snapshot_id` and `freshness` for the task. Use `files` with the snapshot ID to list every file; a file ref filters only that file.

Replace these placeholders with values returned by `list`, `read` and `files`:

```bash
ntn-skills read 'REF_FROM_LIST'
ntn-skills files 'SNAPSHOT_ID_FROM_READ'
ntn-skills read 'ATTACHMENT_REF_FROM_FILES'
```

For a relative file, resolve from the containing file's pinned ref:

```bash
ntn-skills read reference.md --from 'PINNED_CONTAINING_FILE_REF'
```

That relative file must exist in the snapshot. `read --lines 10-30` uses inclusive, 1-based lines and reports `range` and `has_more`. `--raw` emits successful UTF-8 text; failures remain JSON. Binary files require `--output ./attachment.bin`. Identical output is reused with `reused=true`; different existing output returns `OUTPUT_CONFLICT` without overwrite. Scripts are never executed.

`read`, `files`, `export` and `list` accept one of `--refresh`, `--offline` or `--max-age DURATION`; the flags are mutually exclusive. `--refresh` validates online regardless of age, `--offline` uses only eligible local observations even when expired, and `--max-age 30s` overrides the invocation's age limit (`0` requires validation). Expired ordinary reads wait for validation and fail on validation error; there is no automatic stale fallback. A hit never moves `validated_at`.

After a generated-content upgrade, current reads refresh online even when an older observation is within its age limit. An unpinned offline read of that observation returns `CACHE_REFRESH_REQUIRED`; run an online read or `--refresh` first. Existing pinned snapshots remain readable with their exact original bytes. Keep the existing state root when upgrading.

For a native rendered Skill with a committed, aligned source ZIP, the first full read records a local metadata checkpoint. Later ordinary online validation can compare root/reference revisions, complete References membership and immutable attachment identity, then reuse the complete local files without rereading Markdown or downloading the same ZIP. The response reports `freshness.validation: "metadata"`. Metadata checks can miss edits that do not change the reported versions; use `--refresh` or explicit `--max-age 0` for full body/resource validation. No checkpoint, incomplete versions or changed metadata selects the full reader; a failed permission check remains an error. A fresh TTL hit still does no remote request and does not renew its observation. This optimization does not change write/sync verification or require republishing every manual edit; existing managed-edit acceptance rules still apply.


```bash
ntn-skills read 'REF_FROM_LIST' --refresh
ntn-skills files 'CURRENT_PAGE_ID' --max-age 30s
ntn-skills files 'CURRENT_PAGE_ID' --offline
```

JSON reports `source=notion` for online validation, `local_cache` for an unpinned observation, and `local_snapshot` for an explicitly pinned version. Preserve `freshness` (policy, validation time, age, effective limit and stale status) when deciding whether the observation is suitable. Pinned reads, including relative reads with pinned `--from`, work offline; `--offline` is redundant, while `--refresh` and `--max-age` are invalid. A pinned version makes no latest-remote freshness claim. Historical snapshots must already exist on this machine. `--raw` omits JSON freshness fields. [Response contract](protocol.md#success).

## References pages

This section describes native rendered Markdown. Explicit editable-file storage instead consumes the complete path-labeled live code tree described under [creation and updates](#creating-importing-exporting-and-updating-skills); it does not use the References inclusion list or require a source ZIP for text resources.

Create a rich-text `References` property alongside `Description`. Add page mentions or links; whitespace separators are allowed. An explicit `.md` path label retains the original source path, including root `mocking.md`, nested `guides/testing.md` and the common `references/subdirectory/guide.md`. When no explicit Markdown path label exists, the historical page-title fallback still materializes under `references/`. Chinese titles are supported. Duplicate paths fail with REFERENCE_PATH_CONFLICT; inaccessible or incomplete pages fail the read rather than producing a partial skill.

Every listed page is materialized at its resolved Markdown path. The property is the complete inclusion list: additional pages linked in the body stay online links until added to References. Markdown links, Notion page mentions and bare Notion URLs to included pages become relative paths; code examples and unrelated external links remain unchanged. Reference-page changes participate in version checks even if the main page is untouched. Pinned reads and exports remain offline.

Create/replace render every supporting Markdown document as a child page, preserving its original relative path, including root and nested files outside the common `references/**` directory. All page IDs are allocated before rewriting links, and References includes their paths. Write updates an existing Markdown reference page or adds a new one. Replace replaces the inclusion list; omitted pages remain in Notion but disappear from the current skill file set. Child-page blocks are retained during body updates. Scripts, non-Markdown assets and exact source bytes use the optional Files source bundle. Without Files, the main Markdown and all supporting Markdown documents are accepted with normalized source formatting/frontmatter. Keep Files for reversible arbitrary-file imports.


## Creating, importing, exporting and updating skills

Select a database explicitly, save a creation default, or let the CLI use the sole discovered skill database. The order is `--database` → `config.default_database` → sole fresh discovery. Multiple databases, failed registered sources or an inaccessible configured default require a valid selection. `ctl config unset default_database` removes the preference offline; it does not change read scope.

After registering `ops`, replace the pinned-ref placeholder with a ref returned by `read`:

```bash
ntn-skills ctl config set default_database ops
ntn-skills ctl config show
ntn-skills create ./my-skill --dry-run
ntn-skills create ./my-skill
ntn-skills create ./my-skill.zip --dry-run
ntn-skills create ./my-skill.zip
ntn-skills create ./workflow.md --name 'My Workflow' --description 'When to use this workflow'
ntn-skills export 'My Workflow' --output ./my-workflow.zip
ntn-skills export 'PINNED_REF_FROM_READ' --output ./my-workflow
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md --dry-run
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md
```

`create` and `replace` accept one ZIP, folder or `.md`/`.markdown` file. A portable `.ntn-skills.json` manifest selects metadata and entrypoint. Other folder/ZIP inputs use `SKILL.md` or a unique top-level Markdown after wrapper removal; ambiguous inputs fail. A single Markdown input supplies the body regardless of filename. `--name` explicitly overrides the human title without changing page identity or rewriting authored frontmatter to an alias; `--description` overrides Description. Optional Files preserves extra frontmatter, original bytes, filenames and nested supporting files in a source ZIP; without it main/reference Markdown follows [the page normalization rules](#references-pages). Imported page IDs do not select a target.

Descriptions must be nonblank strings of at most 2000 Unicode code points. Imports, portable archives, source plans and property updates share this bound, matching the [Notion rich-text content limit](https://developers.notion.com/reference/request-limits#limits-for-property-values). Values are retained in full without trimming, truncation or summarization; supplementary Unicode characters count as one code point. Invalid property updates fail before remote access or journal writes.

### Creating a Prompt or Router from portable v2

Stage a folder (or ZIP with these files at its root). For `./review-prompt`, write `.ntn-skills.json` with the complete manifest:

```json
{
  "format": "ntn-skills",
  "version": 2,
  "kind": "prompt",
  "name": "Review Prompt",
  "description": "Requirements for a review",
  "main": "PROMPT.md"
}
```

Write `./review-prompt/PROMPT.md` as UTF-8 Markdown:

```markdown
Review the change and explain its risks.
```

For `./review-router`, write this root `.ntn-skills.json`:

```json
{
  "format": "ntn-skills",
  "version": 2,
  "kind": "router",
  "name": "Review Router",
  "description": "Select a review Skill",
  "main": "ROUTER.md"
}
```

Write `./review-router/ROUTER.md` as UTF-8 Markdown:

```markdown
Select the relevant member Skill for this review.
```

Replace database and Skill page placeholders with actual IDs. Each `--member` selects an existing accessible current Skill in the Router's exact database **and data source**, using its page ID or unpinned entrypoint ref. Members are a Notion relation, not copied instructions or a manifest `members` field. Nested Routers, Prompts, resource refs and pinned refs are unsupported. The generated member index exposes metadata and stable refs; member bodies load only when selected.

```bash
ntn-skills create ./review-prompt --database DATABASE_ID --dry-run
ntn-skills create ./review-prompt --database DATABASE_ID
ntn-skills create ./review-router --database DATABASE_ID --member SKILL_PAGE_ID --member 'skill://OTHER_SKILL_PAGE_ID/SKILL.md' --dry-run
ntn-skills create ./review-router --database DATABASE_ID --member SKILL_PAGE_ID --member 'skill://OTHER_SKILL_PAGE_ID/SKILL.md'
```

`kind` explicitly selects `skill`, `router` or `prompt`; neither filenames nor frontmatter select kind. Without the manifest, even a lone `PROMPT.md` or `ROUTER.md` creates an ordinary Skill. Portable v1 is unsupported. `main` names an existing normalized relative source file and may use another filename; the published entrypoint is always `SKILL.md`, `ROUTER.md` or `PROMPT.md` for the selected kind. Keep supporting files at their referenced relative paths; the existing References/Files rules still apply.

All six manifest fields above are required. `name` must be nonblank with no control characters; `description` must be nonblank and at most 2000 Unicode code points. Manifest metadata must be valid even with CLI overrides. For each field, `--name`/`--description` wins over manifest metadata, which wins over body frontmatter. Ordinary Skill input without a manifest uses frontmatter name or the filename stem and needs a description from frontmatter or `--description`. `--dry-run` authenticates and performs online database, name and member preflight without uploads or mutation; it is not an offline parser check and does not prove publication acceptance. [Portable input contract](protocol.md#portable-input-contract).


For one change to an existing page, read its current state and use the returned pinned main ref. Put only added or changed files in a sparse folder; omitted files remain unchanged. Explicit removals use their original relative paths:

```bash
ntn-skills read CURRENT_PAGE_ID --refresh
ntn-skills apply 'PINNED_MAIN_REF_FROM_READ' --input ./changed-files --remove references/obsolete.md --description 'Updated purpose' --dry-run
ntn-skills apply 'PINNED_MAIN_REF_FROM_READ' --input ./changed-files --remove references/obsolete.md --description 'Updated purpose'
```

This merges file and metadata changes into one guarded publication and returns one operation ID. The main entrypoint cannot be deleted. A stale baseline stops before publication; reread and review the intended changes before retrying. Success returns `changes.files` and `changes.removed` with the verified snapshot. After interruption, resume the original operation. Use `replace` when the prepared input deliberately represents the complete source.

`create` rejects an existing invocation name with `CREATE_CONFLICT`. `replace INPUT --target EXACT` requires an exact existing page identity and preserves its page ID. Names cannot select a replacement and absence never creates a page. `--dry-run` performs online preflight and reports create/reuse/update without uploading or mutating.

`replace INPUT --target TARGET` replaces a selected existing page instead of selecting by imported name. Use an exact page ID/URL, page-ID main ref or snapshot ID as the expected-version baseline; a reference-file target is invalid. Name/description overrides can rename that page without changing its ID. `--database` constrains the target rather than redirecting it through a creation default. Missing/inaccessible targets fail with no create or same-name fallback; stale pinned targets return `WRITE_CONFLICT`. Preview with `--dry-run`, then reuse the exact target within authorization.

```bash
ntn-skills replace ./renamed-skill --target 'PINNED_MAIN_REF_FROM_READ' --database ops --dry-run
ntn-skills replace ./renamed-skill --target 'PINNED_MAIN_REF_FROM_READ' --database ops
```

`write` replaces one logical file and retains the others. A target ref with a file path cannot combine with `--path`. Pinned refs and snapshot IDs provide an online version baseline; stale versions return `WRITE_CONFLICT`. Identical input returns `unchanged=true` without uploading or mutating. `SKILL.md` frontmatter name/description remain file content and never change Notion page properties; use `update` to change those properties or `replace` to publish a complete Skill. If `notion_page_id` is present, it must match the target.

`export` writes every file plus the portable manifest. `.zip` selects ZIP; other paths select a directory; `--format zip|directory` overrides that choice. Pinned exports work offline. Preserve the manifest for reimport. ZIP bytes are deterministic; differing existing output fails rather than overwriting. [Portable format and source preservation](protocol.md#portable-export-contract).

ZIP input is limited to 32 MiB compressed, 128 MiB expanded and 10,000 entries; folders use the expanded/entry limits. Generated source ZIPs and portable ZIP output must fit 20 MiB compressed. Unsafe paths, links, special files, duplicates and checksum failures are rejected. Notion read-export archives use gzip/tar and are separate from local import inputs.

Successful changes return a verified snapshot and pinned refs. Publications retain a private receipt and frozen input objects before the first remote mutation; responses and failures include `operation_id` and `receipt_path` once bound. The receipt path is relative to the state root reported by `ctl cache status`. Local source edits or a later CLI/builtin upgrade do not change the retained input. Dry runs do not create a publication receipt or prove service acceptance.

For an ordinary authorized import into a known database, run `create INPUT --database SELECTOR` for a new page or `apply PINNED_MAIN_REF --input CHANGED_FILES` for a change to an existing page. Use `replace INPUT --target EXACT` when replacing its whole source. Exit 0 with `ok: true`, `verified: true` and no `dry_run: true` is the completion criterion: the CLI has read back metadata, main/reference instructions, inclusion paths and the complete portable file identity. Files mode checks source bytes separately from live-page Markdown; page-only mode uses normalized Markdown. Retain the returned page ID, action and pinned ref. Additional read/files/export/hash checks are for discrepancies, development regression or an explicit audit. This verifies storage rather than executing or assessing the workflow.

The goal is complete consumption from upstream to Notion and from current Notion to Markdown/cache/Agent. Daily maintenance and upstream publication use a rendered main page with all supporting Markdown documents rendered as child pages included through `References`, retaining original paths for root and nested files as well as the common `references/**` directory; scripts and non-Markdown resources remain in `Files`/the source bundle. Only whitespace and equivalent local formatting differences are acceptable. Do not drop chapters, lists, tables, code, links or resources, or substitute a whole-document source-code block for a normally rendered page. Not requiring arbitrary Markdown↔Notion byte-identical round trips does not relax these requirements. Use a one-time portable export/import when ownership is moving; bind only for an ongoing relationship. Deliberate exact-target replacement remains within the selected source's authorization.

`markdown_files` is an explicit choice for a particular source-file maintenance workflow, never the default bulk migration or a fallback after conversion/verification failure. For a Skill consisting entirely of UTF-8 text, `create INPUT --database SELECTOR --storage markdown_files` stores each original file as editable literal code inside a path-labeled Notion toggle. `replace INPUT --target EXACT --storage markdown_files` selects it on an existing page; later writes retain it. Current code text drives read/files/export, including nested scripts/resources and relative links; no saved ZIP masks later edits. Binary resources require native Files storage. Omission uses rendered storage for new/native pages; an existing literal page retains its mode. To return that page to rendered main/reference pages, explicitly run `replace INPUT --target EXACT --storage notion_blocks` with the complete source and resources. Prompt/Router remain native. See [the storage and recovery contract](protocol.md#mutation-contract).

Editable files require LF line endings: Notion normalizes CR/CRLF inside code blocks. The CLI rejects such input before mutation; normalize the chosen text deliberately or keep native Files storage for exact original bytes.

Large editable files use ordered code blocks with at most 30000 UTF-16 code units each, preserving surrogate pairs. Publication batches those blocks within a 350000-byte encoded-content budget and 99 code blocks per request; allocation includes the owning toggle under the API's 100-block limit. These request bounds do not change source bytes, read/export identity or unknown-write recovery.

The CLI writes CommonMark/GFM through Notion's v2 parser and restores v1 readback boundaries and split emphasis for local consumption. It repairs changed table literals and code-block languages through the block API, then compares saved instructions; it does not equate a changed operator, command, language or link destination with the input. Parser warnings are failures. Preserve the operation receipt on partial/unknown outcomes and use the recovery path below.

After an interruption, use the returned operation ID:

```bash
ntn-skills operation resume OPERATION_ID --progress
```

For a retained editable-file publication whose only unresolved effect is its original ownership or commit-property assignment, explicit `operation resume OPERATION_ID --retry-metadata` revalidates the whole live source and retained guards before a separately journalled identical property PATCH. The old unknown request remains recorded. This opt-in cannot resend page creation, file appends, uploads, arbitrary properties or another page, and cannot combine with `--new-artifact`. Ordinary resume does not repeat an absent unknown write.

Recovery checks authentication, database/data-source membership and recorded remote observations, then continues frozen content on the same page IDs. `operation list/show/reconcile/resume` uses one envelope with `domain`, `operation_id`, `state`, `verified`, a safe domain-specific `result`, `next: { argv, reason }` and `resume_supported`. A completed publication returns its summary inside this envelope. Reconcile reads remote state without committing a publication marker or advancing a local sync baseline. A matching property update with an unfinished marker returns `result.outcome: "needs_safe_commit"`; explicit resume rechecks the guards and commits that marker without replaying the property change. External changes return `WRITE_CONFLICT`; unresolved creation without a proven response or an unverifiable pending mutation returns `PUBLICATION_UNRESOLVED` without replay. Preserve the receipt and inspect the exact target before choosing a new change. Duplicate child paths fail with `REFERENCE_PATH_CONFLICT`. Body, properties and uploads remain separate requests; client checks cannot guarantee a remote transaction or name uniqueness. For transport failures, inspect `details.reason` or nested `cause_details.reason`; raw `ntn` stderr is excluded. [Mutation contract](protocol.md#mutation-contract) and [error recovery](protocol.md#errors).

For an upload interruption, inspect `operation show OPERATION_ID` and `result.upload_recovery`, then follow `next.argv`. A known uploaded artifact resumes with its original upload ID. An allocation with no response ID, or an uncertain send still observed as pending, returns `PUBLICATION_UPLOAD_RECOVERY_REQUIRED`: `ntn-skills operation resume OPERATION_ID --new-artifact` explicitly authorizes a distinct artifact from the frozen bytes within that original operation. Recovery requires unchanged original pages and proof that the abandoned artifact was not attached; the original unknown request stays recorded as a remote orphan. It never recreates pages, guesses an upload by filename, repeats the uncertain send or deletes the abandoned upload. A lost attachment response is checked against the exact frozen bytes before continuation.

If the CLI exits during version checks or final readback, recovery still compares against its last accepted observations. An edit read during an unfinished check does not become permission to overwrite it. A completed `write` resume returns the operation summary; read the exact target again to obtain its current pinned file ref before continuing work on a reference or attachment.

## Synchronizing local Skills

Connect one existing Notion page to one logical local directory, then run the saved binding. Labels are local configuration; the binding follows the canonical page ID after rename. Repeating the same connection reuses the binding. A missing local directory initializes from Notion. Existing differing content requires an explicit `--from local|notion`; equal content can establish a confirmed baseline without copying it. `--dry-run` checks registration without saving a binding or copying content.

Replace placeholders with the exact page and returned binding ID or label:

```bash
ntn-skills sync local connect PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync local run release-review-global
ntn-skills sync local status release-review-global
ntn-skills sync local check release-review-global
ntn-skills sync local run --all
```

`run` checks retained receipts before a fresh plan. Confirmed convergence may settle locally; unknown effects or differing content stop the affected target with its original operation ID. It does not replay an uncertain content write. Successful runs return `verified: true`; failures retain per-target outcomes.

Use an explicit source to resolve a reviewed conflict, or retain a separate plan when a review artifact is needed:

```bash
ntn-skills sync local run release-review-global --from notion
ntn-skills sync local plan release-review-global --output ./reviewed-sync-plan.json
ntn-skills sync local apply --plan ./reviewed-sync-plan.json
ntn-skills sync local unbind release-review-global
```

Status without refresh inspects local content, common baseline and last remote observation only; its comparison is provisional. Refresh updates the observation without advancing a baseline. Plan always reads strongly, persists a state artifact and changes no Skill content/baseline. Exactly one binding or `--all` is required; `--from local|notion` is single-binding only. One-sided changes choose direction from the confirmed baseline; differing two-sided changes stop until an explicit source-selection plan is reviewed. Batch plans reject competing contents for one page and can fan out one accepted update to independent unchanged copies with separate baselines.

Apply accepts the returned plan ID or an identical reviewable JSON copy. It rechecks schema/digest, current registered bindings, scope, baseline generation, remote expected version, local hashes, logical/resolved path and link proof before effects. Editing a copied plan or moving it to another machine does not authorize execution. Only readback-confirmed convergence advances a baseline. There is no global transaction: a later failure can leave earlier verified bindings complete, recorded independently in the receipt. Retain unfinished receipts; they fence affected resources. Public operation reconcile observes actual local/remote results without replaying writes or advancing a baseline. Its safe observations support a newly reviewed sync plan; a pending receipt remains unverified. Inspect unfinished operations before changing a binding; deleting a receipt or rebinding never authorizes recovery. [Recovery contract](protocol.md#synchronization).

Saved-plan apply checks retained receipt fences before requesting remote content: a pending operation returns `SYNC_PENDING`, and inconsistent receipt participants return `STATE_CORRUPT`. Neither authorizes another write. A push interrupted after its Publication marker becomes `writing` returns `PUBLICATION_INCOMPLETE` when sync tries to read that page; the error's `operation_id` identifies the originating publication (also retained under the apply error's `cause_details`). Inspect it with `operation reconcile PUBLICATION_ID`, then explicitly `operation resume PUBLICATION_ID` under the returned guards before retrying synchronization. Sync never accepts an uncommitted publication merely because local and remote bytes appear equal.

A stable edit made directly in Notion after a committed publication is available through `read CURRENT_PAGE_ID --refresh`, including updated instructions and supporting files. It creates a current snapshot without changing earlier pinned snapshots or accepting that edit as an interrupted publication's intended result. Local and upstream synchronization still check their own baseline and ownership; conflicting changes require an explicit choice. An incomplete publication still returns its original operation for recovery.

Logical directory, parent and per-file symlinks are supported and preserved through writes to their final destinations. Changed chains/targets invalidate saved plans, including byte-identical retargets. A missing ordinary leaf under a resolvable parent can initialize from Notion; dangling links/cycles and a missing established root are errors, never deletion intent. Commit-boundary checks cannot promise an atomic filesystem transaction across an external process's link retargeting. Removed/replaced tracked bytes are retained through system Trash; unrelated files survive. Unbind deactivates configuration and retains local/remote content, common bases, plans and recovery receipts. [Authoritative command/output contract](protocol.md).

## Cache policy and cleanup

Content observations default to five minutes (`300000` ms), catalogs to 60 seconds (`60000` ms). `ctl config set KEY VALUE` and `unset KEY` accept only `default_database`, `builtin_database`, `cache_policy.read_max_age_ms` and `cache_policy.catalog_max_age_ms`. Cache values are nonnegative safe integer milliseconds; unset restores that field's built-in default while preserving the other field. Database set validates online; unset works offline. Credentials use only dedicated `set-token --stdin` and `clear-token`. Per-read `--max-age` accepts duration syntax (`0`, `Ns`, `Nm`, `Nh`, `Nd`).

```bash
ntn-skills ctl config set cache_policy.read_max_age_ms 300000
ntn-skills ctl config set cache_policy.catalog_max_age_ms 60000
ntn-skills ctl config show
ntn-skills ctl config unset cache_policy.read_max_age_ms
ntn-skills ctl config unset cache_policy.catalog_max_age_ms
ntn-skills ctl cache identity
ntn-skills ctl cache status
ntn-skills ctl cache status PAGE_ID --database ops
ntn-skills ctl cache clear PAGE_ID --database ops --dry-run
ntn-skills ctl cache clear PAGE_ID --database ops
ntn-skills ctl cache clear --all --dry-run
ntn-skills ctl cache clear --all
ntn-skills ctl cache gc --dry-run
ntn-skills ctl cache gc
ntn-skills ctl cache gc --online --database ops
```

`status` inspects observations offline. `clear` retires SQL observations and generation fences; it deletes no files and does not use Trash. `gc` moves only unreachable historical snapshot manifests and objects to system Trash. Offline GC preserves every referenced snapshot. Online GC requires one complete refreshed catalog before treating a missing record as absent, and a dry run changes nothing. Broker export directories remain outside this command. [Storage contract](protocol.md#environment-and-local-storage).

## Commands and output

Run `ntn-skills --help` or `ntn-skills <command> --help` for flags and examples. Help is offline and an explicit `--help` takes precedence without running the command. Normal output is JSON, including errors; help/version are text. Exit status is 0 for success, 1 for operation failure and 2 for invalid arguments. `read --raw` affects successful content only. `schema [command path...]` returns the installed parser's parameter types, cardinality, defaults and constraints. Parse errors include a runnable `next.argv` for offline help. Bare collection results such as `sync upstream list` use `items`; named arrays such as catalog `records` keep their existing fields.

The [bootstrap command reference](../skills/ntn-skills/references/commands.md) lists commands and errors. The [protocol](protocol.md) defines exact selectors and result semantics.

## Configuration and storage

Configuration defaults to `~/.config/ntn-skills/config.json`; retained state to `~/.local/state/ntn-skills`; disposable observations to `~/.cache/ntn-skills`. `NTN_SKILLS_CONFIG_HOME`, `NTN_SKILLS_HOME` and `NTN_SKILLS_CACHE_HOME` each name a complete application directory and take priority over `$XDG_CONFIG_HOME/ntn-skills`, `$XDG_STATE_HOME/ntn-skills` and `$XDG_CACHE_HOME/ntn-skills` respectively. Isolate all three for separate credential identities. Builtin data is independent: `NTN_SKILLS_DATA_HOME` > `$XDG_DATA_HOME/ntn-skills` > `~/.local/share/ntn-skills`. It is shared across local Agents by default; verification runs must isolate the data root and HOME as well. [Environment contract](protocol.md#environment-and-local-storage).

Normal commands do not migrate legacy state or configuration. Stop every old CLI writer, including jobs and host prefetch, then run the independent tool with the actual application directories and a backup directory outside them:

```bash
ntn-skills-migrate STATE --config-directory CONFIG --cache-directory CACHE --backup-directory EXTERNAL --old-writers-stopped
```

Preserve the backup and migration journal; finish an interrupted migration before using the normal CLI. Snapshots do not move. Legacy receipt-v1 builtin installations require the independent `ah257/builtin-v1-install-migration.ts` artifact; normal builtin commands reject them and never migrate them implicitly.

State retains private immutable manifests/content objects, upload staging, sync baselines, plans and receipts, with no automatic garbage collection. Latest/catalog/selector observations belong in cache. On upgrade preserve existing state/config, snapshots/objects and recovery data; rebuild disposable indexes under the cache root. Historical state catalogs cannot establish a fresh current observation or initialize a sync baseline. An empty cache causes online validation rather than state deletion. Older pinned scope formats remain readable offline; obtain a fresh online ref before writing from an older format. Online calls use `ntn` and signed export URLs; the CLI sends no analytics requests of its own. [Security policy](../SECURITY.md).

## Upgrade and uninstall

For a registry installation, repeat the global or project-local npm install command with the desired published version. For a tarball installation, obtain the newer built archive and repeat its install command. Read [the changelog](../CHANGELOG.md) before upgrading across a 0.x minor version. Source updates, builds and packaging follow [Contributing](../CONTRIBUTING.md#development-setup).

Remove a global installation with:

```bash
npm uninstall --global ntn-skills
```

Remove a project dependency in each consuming project with:

```bash
npm uninstall ntn-skills
```

Uninstalling retains configuration, state, cache, builtin data and distribution links. Preserve required pinned versions, sync bindings/baselines/plans, installation receipts and unfinished transactions. Before uninstalling, run `ntn-skills ctl config clear-token` to remove a saved token if desired; environment credentials and `ntn` login belong to their tools. Record effective paths with `ctl cache status`, `ctl config show` and `ctl builtin status`, then stop consuming hosts before optional reclamation. `ctl cache clear --all` retires only disposable observations to system Trash. Retire builtin distribution links and their central data together when deliberately removing them, so consumers are not left with dangling links. Move application directories and legacy backups only through system Trash/approved retention: removing state loses pinned versions and sync recovery, and removing builtin data loses installed instructions and installation recovery. Uninstall never performs this reclamation automatically.

## Discover through a Notion View

```bash
ntn-skills views --database library
ntn-skills list --default-view --database library
ntn-skills list --view 'VIEW_ID_OR_NOTION_URL' --database library
```

Replace selectors with returned identities. `views` preserves the Notion API order, not an alphabetical sort or a promise about UI tab order. `--default-view` selects its first entry; an explicit `--view` does not fall back when missing or inaccessible. Omit both to discover the full configured library. `--query` filters returned metadata and never reads bodies. A selected View includes native quick filters. Empty results and no Views are successful empty directories; failed or incomplete queries are not. View membership is discovery policy, not permission.

View observations use the catalog freshness policy, isolated by credential, database and selector. `--refresh` starts a new native query. Continuation pages retain its query ID and expiry; expiry never extends the observation TTL. Incomplete, missing or repeating pagination fails. Known member metadata errors remain explicit in `coverage.failed_sources`; valid rows are returned, but a partial result cannot establish unique-name resolution.
