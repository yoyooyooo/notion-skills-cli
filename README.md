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
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js%20%3E%3D%2022.19.0-green" alt="Runtime: Node.js >= 22.19.0"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

```bash
ntn-skills list
ntn-skills read 'Release Review'
```

`Release Review` is an example title; choose a Skill returned by your own `list`. The npm package, executable and bootstrap Skill are all **`ntn-skills`**.

Available on [npm](https://www.npmjs.com/package/ntn-skills). For source builds, see [Contributing](CONTRIBUTING.md#development-setup).

## Why use it?

You maintain reusable instructions in Notion, but an Agent only needs a few of them for its current task. `ntn-skills list` exposes names and descriptions so the Agent can choose a relevant workflow before loading its instructions. `read` loads the selected file and saves the complete Skill export locally.

A task can outlive an edit in Notion. The first successful read returns a **snapshot**: a local, fixed version of the workflow and its files. Keep the returned refs for the task. Ordinary current-target reads may reuse content validated within five minutes; use `--refresh` to adopt a freshly validated remote version for a new task.

| When you want to… | Use |
| --- | --- |
| Find a workflow without loading the whole library | `list` |
| Read instructions and supporting files from one version | `read`, then `files` |
| Move a complete Skill between local files and Notion | `import`, `export` |
| Add a new Skill or replace one file deliberately | `create`, `write` |
| Keep an existing page and local Skill directory in sync | `sync bind`, `sync plan`, `sync apply` |

## Installation

Install [Node.js](https://nodejs.org) **22.19.0 or newer**, which includes npm. Online operations also need the [official Notion CLI](https://developers.notion.com/cli) **`ntn`** with `api --notion-version` support; `ntn` 0.22.12 has been exercised with this project.

Install the published release from the official npm registry:

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

The version command prints the installed version; help lists the available commands. A consumer needs Node.js and npm. [Project-local installation](docs/usage.md#install-in-a-consuming-project), [PATH setup](docs/usage.md#install-from-npm-globally) and [local tarball installation](docs/usage.md#install-a-local-tarball-globally) are covered in the usage guide.

To produce a package yourself, follow [the contributor setup and build instructions](CONTRIBUTING.md#development-setup). Bun is the development/build tool.

## Quick start

### 1. Connect Notion

Configure `ntn` through [its authentication guide](https://developers.notion.com/cli/get-started/authentication). Your connection needs Read content access to a database with rich-text `Description` and `References` properties. `References` lists Notion page mentions or page links; each linked page becomes a Markdown file under `references/`. The native Skills database/export mode is also supported for existing libraries.

That database needs at least one valid Skill. For example, the Notion Name `Release Review` maps to `name: release-review` in its exported `SKILL.md`. Names use English letters separated by single spaces, up to 64 characters; descriptions and instructions can use any language. [Naming and database requirements](docs/protocol.md#identity-and-references).

Authentication priority is saved `config.token` → non-empty `NOTION_API_TOKEN` → existing `ntn login`. A saved token is plaintext in the private config file; `config show` reports only whether it is configured. [Token setup and removal](docs/usage.md#authentication).

### 2. Check access and choose a workflow

```bash
ntn-skills doctor
ntn-skills list
```

With a valid Skill available, `doctor` should report `ok: true`, `authentication: "available"`, a positive `skill_count`, and `skill_read.available: true`. It reads and caches one Skill to verify the selected storage mode. `list` returns metadata and coverage without loading workflow bodies.

Notion Search may miss databases. Read `coverage`; if you know the database, use `ntn-skills list --database 'DATABASE_ID_OR_URL'`, replacing that value with your database ID or URL.

### 3. Read the selected Skill

Copy an entry's `ref` from `skills` into this command, replacing the placeholder:

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
ntn-skills source add ops --database 'DATABASE_ID_OR_URL'
ntn-skills list --database ops
ntn-skills read 'Release Review' --database ops
```

Database aliases are exact and case-sensitive. If two databases have the same Skill name, select a database or use a page-ID ref from `list`. Registered sources supplement automatic discovery. [Discovery, aliases and coverage](docs/usage.md#discovery-and-identity).

### Import, export or update a Skill

A Skill can be a folder, ZIP, or Markdown file. Preview remote changes before applying them:

```bash
ntn-skills import ./my-skill --database ops --dry-run
ntn-skills import ./my-skill --database ops
ntn-skills export 'My Skill' --database ops --output ./my-skill.zip
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md --dry-run
```

`create` requires a new name. `import` creates an absent name, reuses identical content, or replaces the existing same-name Skill's body, metadata and complete file set. `write` replaces one file while retaining the others; run it without `--dry-run` to apply the reviewed change. Pinned writes check the current online version and fail if it changed. [Inputs, conflicts and partial outcomes](docs/usage.md#creating-importing-exporting-and-updating-skills).

Use `import ./my-skill --target 'CURRENT_PAGE_ID_OR_PINNED_MAIN_REF' --database ops --dry-run` to replace a selected existing page deliberately. `--target` preserves that page identity even when imported name/description changes; a missing, inaccessible or stale target fails without creating a page or falling back to its imported name.

### Synchronize a local distribution directory

Replace `PAGE_ID` and `PLAN_ID` with actual returned identities. The binding label is local configuration, separate from a Skill's invocation alias.

```bash
ntn-skills sync bind PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync plan release-review-global --from notion
ntn-skills sync apply --plan PLAN_ID
ntn-skills sync status release-review-global
ntn-skills sync plan --all --output ./skills-plan.json
ntn-skills sync apply --plan ./skills-plan.json
ntn-skills sync reconcile release-review-global
ntn-skills sync unbind release-review-global --dry-run
```

Equal initial contents can initialize a common baseline at bind; differing or absent local contents require an explicit `--from local|notion` initialization plan. Later plans use each binding's confirmed baseline to select direction or report a conflict. Apply rechecks the saved binding, versions, content and logical/resolved path before effects; a copied plan cannot authorize a different machine or binding. Status is local/provisional unless `--refresh` is used. Reconcile inspects unfinished receipts without replaying writes. Unbind deactivates configuration and retains content, baselines, plans and receipts. Symlink paths retain their logical links; removed/replaced bytes go through system Trash retention. See [sync usage](docs/usage.md#synchronizing-local-skills).

### Maintain reference pages in Notion

Add page mentions or links to the rich-text `References` property. A link labeled `references/guide.md` fixes the local path; otherwise the page title determines its filename. Write normal Notion page links in the instructions: reads and exports turn links to included pages into relative paths such as `./references/guide.md`. Links between reference files resolve from the containing file, and CLI writes restore the Notion URLs. Other websites and code examples remain unchanged.

`create` and `import` turn `references/**/*.md` into editable child pages. `write` updates the page behind a reference path. Removing a reference from an imported file set excludes it from new snapshots but retains the Notion page. `Files` is optional for page-only libraries; keep it when preserving original source bytes, extra frontmatter or non-Markdown assets. See [the References contract](docs/protocol.md#references-pages).


## Agent integration

Copy the [bootstrap Skill](skills/ntn-skills/SKILL.md) directory into your Agent host's supported local skill directory. It teaches the Agent to discover metadata, read a selected workflow, and follow pinned attachment refs through shell commands.

For startup awareness of every available workflow, the host needs a startup hook that runs `ntn-skills list` and injects the returned metadata. A bootstrap Skill by itself does not expose the remote catalog at startup. Direct use of `Read skill://...` requires a host adapter; shell integration works wherever shell tools are available. [Host integration contract](docs/host-integration.md).

Inspecting or maintaining a Skill does not activate its instructions. Hosts activate only a workflow selected for the current task and retain its freshness metadata; no downloaded content or script executes automatically.

## Boundaries and local data

- Local verification covers npm installation and seeded offline behavior on macOS arm64 with Node.js 24.20.0 and Linux arm64 with the minimum Node.js 22.19.0. Real Notion reads were verified on macOS with `ntn` 0.22.12. CI is configured for Node.js 22.19.0 and 24 on Ubuntu and macOS 15; configured jobs do not establish successful runs for a new change. Windows is unverified.
- Explicit `create`, `import`, `write` and `sync apply` commands change content. Version checks are client preflight checks; body, properties, and files are separate requests. On partial/unknown outcomes, inspect the target; use `sync reconcile` for an unfinished sync receipt before another apply.
- Configuration defaults to `~/.config/ntn-skills/config.json`; retained snapshots, uploads and sync recovery state to `~/.local/state/ntn-skills`; disposable observations to `~/.cache/ntn-skills`. Freshness defaults are five minutes for content and 60 seconds for catalogs. [Cache policy and cleanup](docs/usage.md#cache-policy-and-cleanup) explain overrides and system Trash retention.
- Online operations use `ntn` and Notion's signed download URLs. Safe local identity is required for unpinned offline lookup; official-login identity may still require online checks. A cached observation does not prove present access. The CLI sends no telemetry requests of its own; `ntn` has its own policies. Imported scripts are never executed automatically.

See [configuration and storage](docs/protocol.md#environment-and-local-storage), [error recovery](docs/protocol.md#errors), and [security and privacy](SECURITY.md).

## Upgrade and uninstall

For a tarball installation, obtain the newer built package and repeat the npm installation command. Read [the changelog](CHANGELOG.md) before a 0.x minor upgrade. Source builds follow [the contributor instructions](CONTRIBUTING.md#development-setup).

Remove a global installation with `npm uninstall --global ntn-skills`. Configuration, cache and retained state remain afterward, including pinned versions, sync baselines/plans and unfinished receipts. To remove a saved token, run `ntn-skills config clear-token` before uninstalling. Upgrade retains state/config and rebuilds disposable observations in the cache root; use `--refresh` in callers that previously assumed every unpinned read was fresh. [Removal and optional retention](docs/usage.md#upgrade-and-uninstall) explain what to preserve.

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
