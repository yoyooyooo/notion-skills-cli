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

Available on [npm](https://www.npmjs.com/package/ntn-skills). The GitHub repository is currently private; [building from source](CONTRIBUTING.md#development-setup) requires repository access.

## Why use it?

You maintain reusable instructions in Notion, but an Agent only needs a few of them for its current task. `ntn-skills list` exposes names and descriptions so the Agent can choose a relevant workflow before loading its instructions. `read` loads the selected file and saves the complete Skill export locally.

A task can outlive an edit in Notion. Reading instructions before that edit and an attachment afterward can mix two versions. The first successful read returns a **snapshot**: a local, fixed version of the workflow and its files. Keep the returned refs for the task; a later online read can adopt a newer version for the next task.

| When you want to… | Use |
| --- | --- |
| Find a workflow without loading the whole library | `list` |
| Read instructions and supporting files from one version | `read`, then `files` |
| Move a complete Skill between local files and Notion | `import`, `export` |
| Add a new Skill or replace one file deliberately | `create`, `write` |

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

Configure `ntn` through [its authentication guide](https://developers.notion.com/cli/get-started/authentication). Your connection needs Read content access, the Skills API enabled, and an accessible database with `database_type: "skills"`. A normal database named “Skills” is insufficient.

That database needs at least one valid Skill. For example, the Notion Name `Release Review` maps to `name: release-review` in its exported `SKILL.md`. Names use English letters separated by single spaces, up to 64 characters; descriptions and instructions can use any language. [Naming and database requirements](docs/protocol.md#identity-and-references).

Authentication priority is saved `config.token` → non-empty `NOTION_API_TOKEN` → existing `ntn login`. A saved token is plaintext in the private config file; `config show` reports only whether it is configured. [Token setup and removal](docs/usage.md#authentication).

### 2. Check access and choose a workflow

```bash
ntn-skills doctor
ntn-skills list
```

With a valid Skill available, `doctor` should report `ok: true`, `authentication: "available"`, a positive `skill_count`, and `skills_api.available: true`. Resolve reported errors before continuing. `list` returns `skills`, `databases`, `count`, and `coverage` without loading workflow bodies.

Notion Search may miss databases. Read `coverage`; if you know the database, use `ntn-skills list --database 'DATABASE_ID_OR_URL'`, replacing that value with your database ID or URL.

### 3. Read the selected Skill

Copy an entry's `ref` from `skills` into this command, replacing the placeholder:

```bash
ntn-skills read 'REF_FROM_LIST'
```

A successful response contains `ok: true`, the instructions in `content`, `source: "notion"`, a `snapshot_id` starting with `s_`, and a pinned `ref` containing `?snapshot=...`. Keep that ref and snapshot ID with your task. [Response fields](docs/protocol.md#success).

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

## Agent integration

Copy the [bootstrap Skill](skills/ntn-skills/SKILL.md) directory into your Agent host's supported local skill directory. It teaches the Agent to discover metadata, read a selected workflow, and follow pinned attachment refs through shell commands.

For startup awareness of every available workflow, the host needs a startup hook that runs `ntn-skills list` and injects the returned metadata. A bootstrap Skill by itself does not expose the remote catalog at startup. Direct use of `Read skill://...` requires a host adapter; shell integration works wherever shell tools are available. [Host integration contract](docs/host-integration.md).

## Boundaries and local data

- Local verification covers npm installation, offline behavior and real Notion reads on macOS arm64 with Node.js 24.20.0 and `ntn` 0.22.12. CI is configured for Node.js 22.19.0 and 24 on Linux and macOS; configured jobs do not establish successful runs. The minimum version has not been exercised locally because runtime downloads failed. Windows is unverified.
- Explicit `create`, `import`, and `write` commands change Notion. Version checks are client preflight checks; body, properties, and files are separate requests. On `WRITE_PARTIAL` or `WRITE_OUTCOME_UNKNOWN`, inspect the target before retrying.
- Configuration defaults to `~/.config/ntn-skills/config.json`; snapshots and upload staging default to `~/.local/state/ntn-skills`. The 60-second metadata cache lifetime controls freshness. Local data has no automatic garbage collection.
- Online operations use `ntn` and Notion's signed download URLs. The CLI sends no telemetry requests of its own; `ntn` has its own policies. Imported scripts are never executed automatically.

See [configuration and storage](docs/protocol.md#environment-and-local-storage), [error recovery](docs/protocol.md#errors), and [security and privacy](SECURITY.md).

## Upgrade and uninstall

For a tarball installation, obtain the newer built package and repeat the npm installation command. Read [the changelog](CHANGELOG.md) before a 0.x minor upgrade. Source builds follow [the contributor instructions](CONTRIBUTING.md#development-setup).

Remove a global installation with `npm uninstall --global ntn-skills`. Configuration and snapshots remain afterward. To remove a saved token, run `ntn-skills config clear-token` before uninstalling. [Project-local removal and optional data cleanup](docs/usage.md#upgrade-and-uninstall) explain what to retain and what pinned refs lose when state is discarded.

## Documentation and contributing

| Next step | Guide |
| --- | --- |
| Installation variants and everyday CLI usage | [Usage guide](docs/usage.md) |
| Selectors, JSON output, storage and errors | [CLI and ref contract](docs/protocol.md) |
| Startup metadata and Read/Write adapters | [Host integration](docs/host-integration.md) |
| Development setup and compatibility policy | [Contributing](CONTRIBUTING.md) |
| Publishing and release verification | [Releasing](docs/releasing.md) |

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for sanitized bug reports and usage questions; vulnerabilities use [private reporting](SECURITY.md#reporting-a-vulnerability). Repository channels currently require access to the private repository. To develop or build the CLI, start with [Contributing](CONTRIBUTING.md).

[Documentation index](docs/README.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
