<h1 align="center">Notion Skills</h1>

<p align="center">Create, edit, and use reusable Agent workflows in Notion with <code>ntn-skills</code>.</p>

<p align="center">
	<a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a><br>
	<a href="#quick-start">Quick start</a> · <a href="#agent-setup">Agent setup</a> · <a href="docs/README.md">Documentation</a>
</p>

Keep instructions and their supporting files in a Notion library. Edit native
Skills in Notion, discover them from a terminal or Agent, and load the workflow
you need. The CLI manages the tables, file identities, and relationships.

The quick start creates four linked tables and a `decision-review` Skill.
You can then open its page in Notion and read the same instructions through the
CLI. [pi-context-broker](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.md)
adds optional Pi integration.

## Install

Use Node.js 22.22.3 or newer in 22.x, or 24.20.0 or newer.

```sh
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

This README describes `next`. The published package may precede this branch.
To try the current candidate, follow [the source setup](CONTRIBUTING.md#development-setup).
For that source checkout, replace `ntn-skills` in the examples below with
`bun run /absolute/notion-skills-cli/scripts/dev.ts`, using its actual path.
Use your installed command's `--help` or `schema COMMAND...` for its actual syntax.

## Quick start

### 1. Give the CLI access to Notion

Create an [internal Notion connection](https://developers.notion.com/guides/authorization/overview#internal-connection-auth-flow-set-up)
with Read content, Insert content, and Update content capabilities.
Create a new empty Notion page and add that connection through the page's
**Add connections** menu. Keep the page ID or URL for the next step.

The CLI reads `NOTION_API_TOKEN` from its process environment. If your secret
manager already supplies it, run `ntn-skills ctl doctor`. For a first terminal
session, run this line in Bash or Zsh, paste the token, and press Enter.
Input stays hidden:

```sh
read -r -s NOTION_API_TOKEN
```

Then export the token and check authentication:

```sh
printf '\n'
export NOTION_API_TOKEN
ntn-skills ctl doctor
```

Doctor checks authentication here; it does not yet check access to the parent
page. A saved `config.token` takes precedence over the environment.
To save a token instead, pipe it from a trusted secret source into
`ctl config set-token --stdin`. See [credential setup](skills/notion/ntn-skills-maintain/references/setup.md#credentials).

### 2. Create the library and keep its entry

Replace the placeholder with that empty page's actual ID or URL:

```sh
parent_page='PASTE_AUTHORIZED_PARENT_PAGE_ID_OR_URL'
ntn-skills ctl library init --parent "$parent_page"
```

The command creates Skills, Files, Records, and Sources under the parent page.
Copy `library.skills.database_id` from its JSON result into `library_entry`:

```sh
library_entry='PASTE_LIBRARY_SKILLS_DATABASE_ID'
ntn-skills ctl library init --entry "$library_entry"
```

This second command validates the registered tables. Keep using this one Skills
entry with `--entry` for management and `--database` for reading. You do not need
to configure the other three table IDs. An existing library can start with
`init --entry` and skip creation.

`init --entry` does not save a local default. In a new terminal or Agent session,
set `library_entry` to this same saved ID and pass it to the commands below.

If initialization stops, keep its parent, error, operation ID, and local state.
First reconcile without remote writes; add `--resume` only to continue that
original initialization's confirmed unfinished steps. The
[initialization recovery guide](skills/notion/ntn-skills-maintain/references/setup.md#interrupted-initialization)
explains both commands and the unknown results that still need reconciliation.

### 3. Create your first Skill

Prepare a fresh directory. `pwd -P` resolves temporary-directory aliases so the
input also works on macOS:

```sh
skill_dir=$(mktemp -d "${TMPDIR:-/tmp}/ntn-skill.XXXXXX")
skill_dir=$(cd "$skill_dir" && pwd -P)

cat > "$skill_dir/SKILL.md" <<'SKILL'
---
name: decision-review
description: Review a proposed decision before implementation.
---

When reviewing a decision:
1. State the goal and constraints.
2. Compare the proposed choice with one viable alternative.
3. Identify the biggest risk and a concrete next step.
SKILL

ntn-skills ctl library skill create "$skill_dir" \
	--entry "$library_entry" --skill-id decision-review
```

Successful creation reports `status: "created"` and `state: "ready"`.
Open the new `decision-review` page in the Skills table to see its editable
instructions. Markdown becomes native Notion content; supporting non-text files
retain their exact resource originals. The CLI supplies the internal fields.

### 4. Find and read it

```sh
ntn-skills list --database "$library_entry" \
	--query decision-review --refresh --json
```

Find the record in `records` and copy its actual `ref`:

```sh
skill_ref='PASTE_REF_FROM_LIST'
ntn-skills read "$skill_ref" --database "$library_entry" --refresh --json
```

Check that `path` is `SKILL.md` and `content` contains the complete instructions.
You can edit the native page in Notion and read it again with `--refresh`.
Native edits need no projection step.

`read` inspects a workflow. When you want an Agent to apply it, use
`ntn-skills use "$skill_ref" --database "$library_entry" --json` to load its
required workflows too. Ordinary discovery, reading, use, and export make no
semantic writes to Notion.

## The four tables

| Table | What it holds |
| --- | --- |
| Skills | Workflow names, descriptions, enablement, main content, and Members/Requires relationships |
| Files | Notion-owned supporting files and selected Source reading pages |
| Sources | Git source definitions, selected upstream content, and contributions to Skills |
| Records | Exact resources, shared Profile rules, and unfinished management operations |

Authors usually work with Skills and Files. The CLI manages the remaining
relationships and internal metadata. A native Skill does not need a Source.
See [the library contract](docs/current-contract.md) for fields and ownership.

## Continue using the library

| Task | Guide |
| --- | --- |
| Edit selected files or metadata, register a page, or remove a Skill | [Native authoring](docs/shared-authoring.md#manage-native-skills) |
| Read supporting files, inspect a complete directory, or export a selection | [Everyday commands](docs/usage.md) |
| Replace a complete local tree, choose native files, or resume an import | [Complete import](docs/shared-authoring.md#prepare-the-entire-replacement-tree) |
| Apply or refresh Git contributions, manage Sources, or take over a file | [Source management](skills/notion/ntn-skills-sync/references/synchronization.md#current-source-boundaries) |
| Generate Notion reading pages for imported or Source content | [Reading projections](docs/shared-authoring.md#generate-readable-text-in-notion) |
| Restore an exact Skill from Trash | [Trash recovery](docs/shared-authoring.md#restore-a-trashed-skill) |
| Choose Views, shared Profile rules, or freshness settings | [Profiles and Views](docs/usage.md#choose-a-profile-or-view) |
| Inspect an unfinished operation | [Operation recovery](skills/notion/ntn-skills-maintain/references/operations.md#incomplete-current-work) |

Complete import replaces the selected Skill's whole file tree. Review its
`--dry-run` before replacing existing content. Source acquisition also requires
a Git executable that supports `--no-lazy-fetch`; see
[Git requirements](docs/usage.md#install-the-package).

Follow returned cursors for complete discovery and retain exact refs when names
collide. A fixed selection keeps its chosen content locally; it is not remote
history. `--offline` needs the selected local bytes. See [reading and cache
behavior](skills/ntn-skills/references/integration.md#current-selection-and-cache).

## Agent setup

An Agent with a shell can use this CLI directly. Before a library exists, read
the packaged setup guide offline:

```sh
ntn-skills ctl builtin read notion/ntn-skills-maintain --path references/setup.md
```

Give the Agent the intended parent page or library entry and the same credential
environment. The guide covers initialization, native creation, and
[optional copies of the three packaged workflows](skills/notion/ntn-skills-maintain/references/setup.md#copy-packaged-workflows-into-notion).
Those copies are editable native Skills and do not update automatically with
the package.

For routine work in a connected library, discover `ntn-skills-maintain` in that
library and read its exact returned ref. Use `use` when applying the workflow
and its Requires. Inspect the edited target without activating it.
A failed or partial search does not prove that a workflow is absent.
The packaged catalog remains available for explicit bootstrap or offline use.

For Pi, follow [the Broker setup](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.md).
The Broker consumes the same library through its paired SDK and owns Pi
connection configuration. Saving a connection is separate from reading content
in a Pi session. OMP/Tern adaptation is deferred on `next`.

## Documentation and development

[Documentation](docs/README.md) covers commands, authoring, output contracts,
and current implementation limits. [Contributing](CONTRIBUTING.md) covers
development on `next` and links to the shared
[isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md).

Initialization creates the current schema; it does not convert an older library.
Source tests, independent package installation, live Notion behavior, and actual
Agent use have separate [verification scopes](docs/maintenance-verification-review.md).

[MIT license](LICENSE) · [Security policy](SECURITY.md) · [Issues](https://github.com/yoyooyooo/notion-skills-cli/issues)
