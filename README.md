<h1 align="center">ntn-skills</h1>

<p align="center">Bring your Notion workflow library into an Agent or terminal.<br>Discover the right Skill, read its instructions, and keep one version for the whole task.</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#installation">Install</a> · <a href="#quick-start">Quick start</a> · <a href="#common-workflows">Workflows</a> · <a href="#agent-integration">Agent integration</a> · <a href="./docs/README.md">Docs</a>
</p>

<p align="center">
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js%2022.22.3%2B%20(22.x)%20or%2024.20.0%2B-green" alt="Runtime: Node.js 22.22.3+ (22.x) or 24.20.0+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

```bash
ntn-skills list
ntn-skills read 'Release Review'
```

`Release Review` is an example title; choose a Skill returned by your own `list`. The npm package, executable and entrypoint Skill are all **`ntn-skills`**. The entrypoint, content-maintenance and synchronization Skills are independently managed through the `ctl builtin` catalog; see [Agent integration](#agent-integration).

Available on [npm](https://www.npmjs.com/package/ntn-skills). For source builds, see [Contributing](CONTRIBUTING.md#development-setup).

## Why use it?

You maintain reusable instructions in Notion, but an Agent only needs a few of them for its current task. `ntn-skills list` exposes names and descriptions so the Agent can choose a relevant workflow before loading its instructions. `read` loads the selected file and saves the complete Skill export locally.

A task can outlive an edit in Notion. The first successful read returns a **snapshot**: a local, fixed version of the workflow and its files. Keep the returned refs for the task. Ordinary current-target reads may reuse content validated within five minutes; use `--refresh` to adopt a freshly validated remote version for a new task. Stable manual edits to committed Notion content are readable through that same current-page path; old pinned snapshots stay unchanged, and unfinished publications retain their original recovery guards.

After a complete read proves a committed native Skill and its source ZIP aligned, ordinary reads can revalidate root/reference metadata, complete inclusion and immutable attachment identity, then reuse all local files without repeated body reads or bundle downloads. `freshness.validation="metadata"` identifies this check; edits with unchanged reported versions can be missed. `--refresh` or explicit `--max-age 0` always validates complete bodies/resources. New machines and missing checkpoints use the full reader. See [read policy](docs/protocol.md#read-policy-and-cache-management).

| When you want to… | Use |
| --- | --- |
| Find a workflow without loading the whole library | `list` |
| Read instructions and supporting files from one version | `read`, then `files` |
| Move a complete Skill between local files and Notion | `create`, `replace`, `export` |
| Apply file and metadata changes to one pinned page | `apply` |
| Subscribe Git Skills into Notion and keep them current | `sync upstream connect`, `sync upstream run` |
| Keep an existing page and local Skill directory in sync | `sync local connect`, `sync local run` |

## Installation

Install [Node.js](https://nodejs.org) **22.22.3+ within 22.x, or 24.20.0+**, which includes npm. Online operations also need the [official Notion CLI](https://developers.notion.com/cli) **`ntn`** with `api --notion-version` support; `ntn` 0.22.12 has been exercised with this project.

Install the published release from the official npm registry:

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

The version command prints the installed version; help lists the available commands. A consumer needs Node.js and npm. [Project-local installation](docs/usage.md#install-in-a-consuming-project), [PATH setup](docs/usage.md#install-from-npm-globally) and [local tarball installation](docs/usage.md#install-a-local-tarball-globally) are covered in the usage guide.

To produce a package yourself, follow [the contributor setup and build instructions](CONTRIBUTING.md#development-setup). Bun installs dependencies and builds the package; development and real SQLite consumers execute on Node.js.

## Quick start

### 1. Connect Notion

Configure `ntn` through [its authentication guide](https://developers.notion.com/cli/get-started/authentication). Your connection needs Read content access to a database with rich-text `Description` and `References` properties. `References` lists Notion page mentions or page links; each linked page becomes a Markdown file under `references/`. The native Skills database/export mode is also supported for existing libraries.

That database needs at least one valid Skill. Notion Name and authored frontmatter `name` are human-readable names preserved exactly: Unicode, digits, spaces and hyphens are allowed; names must be nonempty and contain no control characters. For example, `Tty7` stays `Tty7`, while its callable alias is `tty7`. Aliases normalize to NFC and lowercase, trim surrounding whitespace, replace whitespace runs with `-`, and percent-encode characters outside Unicode letters, marks, numbers, `_` and `-`. Aliases are selection values, never identity; collisions require an exact page ID or ref. `--name` explicitly overrides the human title without changing page identity. [Naming and database requirements](docs/protocol.md#identity-and-references).

`ctl database init --parent PAGE_ID` creates a content table and a separate upstream subscription table under an owned page; attach exact existing tables with `--content-database ID --upstream-database ID`. It validates field types and native relation targets before publishing configuration. Repeat the same target to resume safely. The default write database stays independent unless `--set-default` is supplied.

Content origin uses `Source Type` (`builtin`, `upstream`, `manual`) and exact rich-text `Builtin ID`, independently of Kind and Sync Mode. Explicit init upgrades existing tables, including repeated published attaches, without backfilling legacy rows. Ordinary create supports tables missing these fields; replace/write preserve provenance. Deliberate builtin/upstream publication requires the upgraded schema. Equal content with changed provenance is a metadata-only update; complete equality is mutation-free reuse. [Origin and frozen recovery](docs/protocol.md).

Use `ntn-skills sync upstream connect SOURCE --database DATABASE` to register a Git source and synchronize its Skills. Repeating the same connection reuses its subscription. Later, `sync upstream run` takes either repeatable `--target SUBSCRIPTION_ID` or `--all`. Each run records status, attempt/success times and a summary; failed or partial batches continue other targets and exit nonzero. Advanced registration and plan/apply remain available under `sync upstream`. [Recurring synchronization and table setup](docs/usage.md#recurring-upstream-synchronization).

Ordinary `run` checks retained work before planning new changes and restores an owned tracked member whose original page is confirmed readable in Notion Trash. The old page stays in Trash; a verified replacement updates that member's mapping. Missing or inaccessible pages are explicit failures. Historical rebuild, adoption and targeted repair commands belong to the separate [operator artifact](docs/historical-operations.md).

The content table supports `Kind=skill|router|prompt`. Skill uses `SKILL.md`; Router uses `ROUTER.md` with member metadata and stable refs, and loads members only when the Agent selects them; Prompt uses `PROMPT.md` as an explicit user requirement on each submission. `list` returns `records` with kind, stable identity, locator and entrypoint. Reads and exports return the same `record` and fixed snapshot. Missing historical Kind means Skill.

To create a Prompt or Router, stage a portable v2 manifest and body file, then use `create` with the existing flags: [complete Prompt/Router staging and commands](docs/usage.md#creating-a-prompt-or-router-from-portable-v2). Filename/frontmatter alone does not select kind; [portable input contract](docs/protocol.md#portable-input-contract).

Automatic upstream subscription Routers require at least two verified published active Skills. Zero or one member produces no Router catalog entry; use the individual Skill ref for a single member. Current exact Router reads reject insufficient membership. Manually authored content-table Routers keep their explicit Members behavior. See [subscription and Router usage](docs/usage.md#initialize-content-and-subscription-tables).

`Default Context` is an independent checkbox for each Skill or Router. Missing or unchecked means false. Prompt is always excluded from default discovery, background prefetch and native Skill installation; explicitly selecting it again adds its requirements to the new turn. Initialization creates the checkbox but never checks it automatically.

Authentication priority is saved `config.token` → non-empty `NOTION_API_TOKEN` → existing `ntn login`. A saved token is plaintext in the private config file; `ctl config show` reports only whether it is configured. [Token setup and removal](docs/usage.md#authentication).

### 2. Check access and choose a workflow

```bash
ntn-skills ctl doctor
ntn-skills list
```

With a valid Skill available, `ctl doctor` should report `ok: true`, `authentication: "available"`, a positive `skill_count`, and `skill_read.available: true`. It reads and caches one Skill to verify the selected storage mode. `list` returns metadata and coverage without loading workflow bodies.

Notion Search may miss databases. Read `coverage`; if you know the database, use `ntn-skills list --database 'DATABASE_ID_OR_URL'`, replacing that value with your database ID or URL.

### 3. Read the selected Skill

Copy an entry's `ref` from `records` into this command, replacing the placeholder:

```bash
ntn-skills read 'REF_FROM_LIST'
```

A successful response contains `ok: true`, instructions in `content`, a `snapshot_id` starting with `s_`, and a pinned `ref` containing `?snapshot=...`. `source: "notion"` means online validation; `source: "local_cache"` means a bounded cached observation. Retain `freshness`, the ref and snapshot ID with your task. Add `--refresh` to the current ref when current remote access/content must be checked. [Response fields](docs/protocol.md#success).

### 4. Read supporting files from the same version

Replace each placeholder with the value returned by the preceding command:

```bash
ntn-skills files 'SNAPSHOT_ID_FROM_READ'
ntn-skills read 'ATTACHMENT_REF_FROM_FILES'
```

Use the snapshot ID to list **all** files; passing a file ref lists only that file. Read an attachment actually returned by `files`. Its pinned ref uses the same snapshot and returns `source: "local_snapshot"`, even without authentication or network access. Historical versions are available only if already saved on this machine.

For a binary attachment, add `--output ./attachment.bin` and use an appropriate viewer. For text, use `--lines 10-30` for an inclusive line range or `--raw` for plain UTF-8 output. Scripts are never executed automatically.

## Common workflows

### Keep workflow libraries separate

Register a known database as a domain, then select it explicitly. Replace the database placeholder before running:

```bash
ntn-skills ctl database register ops --database 'DATABASE_ID_OR_URL'
ntn-skills list --database ops
ntn-skills read 'Release Review' --database ops
```

Database aliases are exact and case-sensitive. If two databases have the same Skill name, select a database or use a page-ID ref from `list`. Registered sources supplement automatic discovery. [Discovery, aliases and coverage](docs/usage.md#discovery-and-identity).

### Import, export or update a Skill

A Skill can be a folder, ZIP, or Markdown file. Preview remote changes before applying them:

```bash
ntn-skills create ./my-skill --database ops --dry-run
ntn-skills create ./my-skill --database ops
ntn-skills export 'My Skill' --database ops --output ./my-skill.zip
ntn-skills apply 'PINNED_MAIN_REF_FROM_READ' --input ./changed-files --dry-run
```

`create` requires a new name. For an existing page, `apply` combines sparse changed files, optional repeated `--remove PATH` and explicit metadata flags against one pinned main ref or snapshot. Put only the files being added or changed in `./changed-files`; all other files remain. Remove `--dry-run` to execute the reviewed change. A stale baseline fails before publication. `write` and `update` remain available for individual file/property operations. [Inputs, conflicts and partial outcomes](docs/usage.md#creating-importing-exporting-and-updating-skills).

Use `replace ./my-skill --target 'CURRENT_PAGE_ID_OR_PINNED_MAIN_REF' --database ops --dry-run` to replace a selected existing page deliberately. `--target` preserves that page identity even when imported name/description changes; a missing, inaccessible or stale target fails without creating a page or falling back to its imported name.

For an authorized ordinary import, the command's exit 0, `ok: true` and `verified: true` (without `dry_run: true`) are the completion check. The CLI reads back main/reference content and the complete file identity; Files mode also preserves and verifies exact source bytes. No routine read/files/export audit is needed. This checks storage, not execution of the imported workflow.

The goal is complete instructions, code, links and resources across upstream → Notion and current Notion → Markdown/cache → Agent, not arbitrary byte-identical bidirectional round trips. Native Markdown permits documented formatting normalization and rejects changed instructions. For text-only Skills, explicit `--storage markdown_files` stores editable literal files in Notion and consumes those live code bytes without a source-ZIP fallback. [Storage, normalization and recovery](docs/protocol.md#mutation-contract).

### Synchronize a local distribution directory

Replace `PAGE_ID` with an actual selected page ID. The binding label is local configuration, separate from the Skill's invocation alias.

```bash
ntn-skills sync local connect PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync local run release-review-global
ntn-skills sync local status release-review-global
```

A missing directory initializes from Notion. Existing differing contents require an explicit `--from local|notion`; later runs compare both sides with the confirmed common baseline and preserve conflicts. Repeating the same connection reuses its binding. Retained receipts settle only when observations confirm convergence; unresolved outcomes keep their original operation IDs and next action.

Advanced `bind`, `plan` and `apply --plan` support separately reviewed plans. Apply rechecks the saved binding, versions, content and logical/resolved path. Status is provisional unless `--refresh` is used; `unbind` retains content, baselines, plans and receipts. Symlink paths retain their links, and removed/replaced bytes go through system Trash retention. See [sync usage](docs/usage.md#synchronizing-local-skills).

### Maintain reference pages in Notion

Add page mentions or links to the rich-text `References` property. A link labeled `references/guide.md` fixes the local path; otherwise the page title determines its filename. Write normal Notion page links in the instructions: reads and exports turn links to included pages into relative paths such as `./references/guide.md`. Links between reference files resolve from the containing file, and CLI writes restore the Notion URLs. Other websites and code examples remain unchanged.

`create` and `replace` turn `references/**/*.md` into editable child pages. `write` updates the page behind a reference path. Removing a reference from an imported file set excludes it from new snapshots but retains the Notion page. `Files` is optional for page-only libraries; keep it when preserving original source bytes, extra frontmatter or non-Markdown assets. See [the References contract](docs/protocol.md#references-pages).


## Agent integration

The package provides three Skills with separate responsibilities. Make the entrypoint discoverable by default; load a Skill's body only when its task is relevant. “Official” means maintained by this project.

| Builtin ID | Responsibility |
| --- | --- |
| `notion/ntn-skills` | [Discover/read workflows and route tasks](skills/ntn-skills/SKILL.md) |
| `notion/ntn-skills-maintain` | [Maintain Notion content, References and portable copies](skills/notion/ntn-skills-maintain/SKILL.md) |
| `notion/ntn-skills-sync` | [Connect sources and local directories, run synchronization and recover original operations](skills/notion/ntn-skills-sync/SKILL.md) |

With Context Broker, select `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` or `$ntn-skills-sync@builtin` through ordinary `$` discovery on Pi/OMP/Tern. Their packaged bodies and references work without a Notion source or separate local installation. `/context-broker` owns session/View/refresh controls; content tasks use the selected Skill and public CLI. [Bundled Skills in hosts](docs/host-integration.md#bundled-skills-in-hosts).

The CLI can also inspect package instructions offline. To keep independently managed local copies for other consumers, use explicit installation:

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills-maintain
ntn-skills ctl builtin install notion/ntn-skills-sync
ntn-skills ctl builtin status
ntn-skills ctl builtin update notion/ntn-skills
```

`install`, `status` and `update` work offline without credentials. Managed files live in `${XDG_DATA_HOME:-~/.local/share}/ntn-skills/skills/<name>`, with a default symlink at `~/.agents/skills/<name>`. Repeat `--agent-dir DIR` to add other Agent roots; each receives `DIR/skills/<name>` pointing to the same installation. Targets persist for later updates. Complete file receipts protect local edits and unowned directories; replaced bytes go to system Trash. Receipt-v1 profiles require the independent migration artifact; normal commands preserve them and report a conflict. Reload/restart native discovery after installation; upgrading the npm package does not update installed Skills. Broker selections use their bundled package copies; these explicit local installations have their own update lifecycle. [Host entrypoints](docs/host-integration.md#bundled-skills-in-hosts).

`ctl builtin export` remains portable output. Publishing to Notion is a separate online operation: optionally configure `ctl config set builtin_database ops`, then preview `ctl builtin publish notion/ntn-skills-maintain --dry-run`. First publication rejects any same-name page; deliberate updates require `--target` with an exact page identity or pinned baseline. Remote pages never become official by name or publisher text. [Commands, receipts and collision rules](docs/usage.md#optional-official-skills).

With the OMP/Pi Context Broker enabled, a short `<ntn-skills-guidance>` block explains the actual CLI and source scope. The selected Notion View supplies Skill/Router names and descriptions, not bodies. A source's `default_view_id` wins; when absent, the first View in API order is used. `Default Context` is an ordinary checkbox used only when the View filters on it. Startup may prepare metadata and snapshots without a model request. The first user submission receives the selected directory before the provider call; changing the View replaces this directory on the next submission without withdrawing loaded bodies. Full `$` selection and unfiltered CLI discovery remain available. Installing the bootstrap Skill alone does not install the Broker. [Host integration contract](docs/host-integration.md).

Inspecting or maintaining a Skill does not activate its instructions. Hosts activate only a workflow selected for the current task and retain its freshness metadata; no downloaded content or script executes automatically.

`pi-context-broker` provides a one-way Notion source adapter in its own repository using metadata-only `list`, page-ID `read` and pinned directory `export`. It prepares selected-View records after discovery and other records on selection, without activating instructions until consumed. Consumers retain scope, coverage and snapshot identities, match export `main_path` to manifest `main`, and load that entry with its supporting files. The broker owns host integration; this repository does not install it or register host hooks. See [the broker consumption contract](docs/host-integration.md#broker-source-consumption). Source acceptance recipes live in this checkout's verification Skill; package consumers use the public contract and installed CLI.

## Boundaries and local data

- Historical local verification covered npm installation and seeded offline behavior on macOS arm64 with Node.js 24.20.0 and Linux arm64 with Node.js 22.19.0; the latter is now unsupported. Real Notion reads were verified on macOS with `ntn` 0.22.12. CI is configured for Node.js 22.22.3 and 24.20.0 on Ubuntu and macOS 15; configured jobs do not establish successful runs for a new change. Windows is unverified.
- Content mutations, `ctl builtin publish` and sync `connect/run/apply` can change content. Publications support `--progress` on stderr and retain frozen input/receipts; use `operation resume OPERATION_ID` for guarded publication continuation. Unresolved writes remain explicit. Local sync checks retained receipts and reports the original operation and next action when convergence remains unresolved. Client version checks are not atomic commits. [Publication recovery](docs/usage.md#creating-importing-exporting-and-updating-skills).
- Configuration defaults to `~/.config/ntn-skills/config.json`; retained snapshots, uploads and sync recovery state to `~/.local/state/ntn-skills`; disposable observations to `~/.cache/ntn-skills`. Managed builtins use `~/.local/share/ntn-skills`, overridden by `NTN_SKILLS_DATA_HOME` or the XDG data base. Freshness defaults are five minutes for content and 60 seconds for catalogs. [Cache policy and cleanup](docs/usage.md#cache-policy-and-cleanup) explain overrides and system Trash retention.
- Online operations use `ntn` and Notion's signed download URLs. Safe local identity is required for unpinned offline lookup; official-login identity may still require online checks. A cached observation does not prove present access. The CLI sends no telemetry requests of its own; `ntn` has its own policies. Imported scripts are never executed automatically.

See [configuration and storage](docs/protocol.md#environment-and-local-storage), [error recovery](docs/protocol.md#errors), and [security and privacy](SECURITY.md).

## Upgrade and uninstall

For a tarball installation, obtain the newer built package and repeat the npm installation command. Read [the changelog](CHANGELOG.md) before a 0.x minor upgrade. Source builds follow [the contributor instructions](CONTRIBUTING.md#development-setup).

Remove a global installation with `npm uninstall --global ntn-skills`. Configuration, cache, retained state, installed builtin data and its distribution links remain afterward. Preserve pinned versions, sync baselines/plans and unfinished receipts. To remove a saved token, run `ntn-skills ctl config clear-token` before uninstalling. Upgrade retains state/config and rebuilds disposable observations in the cache root; use `--refresh` in callers that previously assumed every unpinned read was fresh. [Removal and optional retention](docs/usage.md#upgrade-and-uninstall) explain what to preserve.

## Documentation and contributing

| Next step | Guide |
| --- | --- |
| Installation variants and everyday CLI usage | [Usage guide](docs/usage.md) |
| Selectors, JSON output, storage and errors | [CLI and ref contract](docs/protocol.md) |
| Startup metadata and Read/Write adapters | [Host integration](docs/host-integration.md) |
| Development setup and compatibility policy | [Contributing](CONTRIBUTING.md) |
| Publishing and release verification | [Releasing](docs/releasing.md) |

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for sanitized bug reports and usage questions; vulnerabilities use [private reporting](SECURITY.md#reporting-a-vulnerability). To develop or build the CLI, start with [Contributing](CONTRIBUTING.md).

[Documentation index](docs/README.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
