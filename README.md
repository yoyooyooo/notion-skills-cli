# ntn-skills

Read the current Notion Skill library from an Agent or terminal.

[简体中文](README.zh-CN.md) · [Current contract](docs/current-contract.md) · [Documentation](docs/README.md)

The `next` line is implementing one current contract across Notion, CLI, SDK and
Pi. Notion owns current management and Notion-authored content. Git-only, mixed
and Notion-native content use the same reader. This branch does not establish
that the production library, published npm package or installed Pi has migrated.

## Current capability

| Task | Current entry |
| --- | --- |
| Discover metadata without workflow bodies | `list` |
| Inspect one file | `read` |
| Apply a selected workflow and its Requires | `use` |
| List the complete selected directory | `files` |
| Export a complete selection locally | `export` |
| Inspect current file ownership and operation state | `ctl library files` |
| Inspect an unfinished intent without replaying it | `ctl library operation`, with an exact owner ID and kind |
| Import or replace one complete local tree | `ctl library import`, with `--dry-run` and same-intent `--resume` |
| Apply or refresh declared Git contributions | `ctl library source apply`, `ctl library source refresh` |
| Generate complete Notion text for one Skill or the daily set | `ctl library projection PAGE_ID`, or `ctl library projection --daily` |
| Take over a file or restore its current Source binding | `ctl library source takeover`, `ctl library source restore-follow` |
| Enable, disable or remove an unreferenced Source | `ctl library source enable`, `disable`, `remove` |
| Create or inspect a current four-table layout | `ctl library init`, `ctl library inspect` |
| Manage shared current Profile rules | `ctl library profile` |

Ordinary list/read/use/resource-read/export performs zero semantic Notion writes.
A native Notion edit is read as current content; reading it does not create an
adoption event or retain a remote version. A generated Source/resource reading
page does not become author content merely because someone edited its display.

Current import writes exact resource originals; repeat `--native PATH` for text
files whose current Notion body should be editable. Complete file metadata and
original bytes establish consumption readiness. Use `ctl library projection`
after import or Source refresh to generate complete readable text. Every daily
Skill main and text supporting file must be readable in Notion; non-text files
are reported as skipped. Projection does not block consumption readiness. Portable Members/Requires
round-trip through export and complete import, with complete target validation
and dependency checks. One invocation budget covers lookup, writes and cleanup.
Source apply/refresh discovers the complete selected Git member set, adds members,
updates exact upstream files, and retires removed pure Source members. Existing
assignments retain stable identities; new members receive deterministic identities.
Save the declaration outside Notion to rebuild a deleted Source with `source apply`.
GitHub and private HTTP(S) Git origins share this path and local authentication.
Source takeover and restore-follow keep the same File and Notion page identities,
update the exact contribution exclusion, and use the Source's selected original.
Source enablement controls consumption; removal refuses remaining file or Origin
references. An interrupted content writer can resume its original input or accept an
explicit complete successor with `--operation NEW --supersede OLD` after the old
writer stops. Completed operations keep no predecessor or content history.
Old create/apply/write/replace/adopt, sync, snapshot/archive and repair commands
are retired from the active CLI. Current data conversion, actual library coverage,
obsolete object cleanup and Pi installation remain separate delivery gates.

## Installation

Use Node.js 22.22.3+ within 22.x, or 24.20.0+. The published package is installed with:

```sh
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills --help
```

The published version may precede this branch's current contract. Build and install
the selected `next` candidate through [Contributing](CONTRIBUTING.md#development-setup)
when validating this change. Pair the CLI and SDK from that complete package with
the matching Broker candidate; installing an older release does not convert the
Notion library.

The package talks directly to Notion through its request engine. Use the existing
`NOTION_API_TOKEN`, or pipe a token from a trusted secret source to
`ntn-skills ctl config set-token --stdin`. Do not paste credentials into chat.
`ctl config show` reports token presence. Saved configuration takes precedence
over the environment.

## Quick start

Use a current registered library with actual content. Keep the returned entry and
refs; names and aliases are discovery aids, not unique identities.

```sh
ntn-skills ctl library inspect ENTRY_DATABASE_ID
ntn-skills list --database ENTRY_DATABASE_ID --json
ntn-skills read REF_FROM_LIST --database ENTRY_DATABASE_ID --json
ntn-skills files SNAPSHOT_ID_FROM_READ
ntn-skills read RELATIVE_PATH --from PINNED_CONTAINING_FILE_REF
```

To execute the selected workflow, use `ntn-skills use REF_FROM_LIST` or the host's
Notion use tool. Reading for inspection does not activate a workflow.

Follow every returned cursor when a complete directory observation is needed.
Search and filtered Views cannot prove that another object is absent. Use an exact
returned ref when names collide. Skills use `SKILL.md`, Routers use `ROUTER.md`,
and explicit user Prompts use `PROMPT.md`. Requires loads mandatory dependencies;
Members lists candidates without loading every member body.

Markdown links can target files or directories present in the complete selected
tree; a directory link does not require a README. Images must target files.
Links to another Skill require an explicit stable ref; relative paths must stay
within their owner. Use `files` to inspect a directory; `read` selects one file.

A task selection keeps its complete file directory and selected bytes in local
cache. It is not a remote history entry. Missing selected source/resource bytes can
be acquired only while current owner, locator and source revision still match.
An absent local selection or changed current binding requires reselection; it never
revives an old remote snapshot or substitutes a later native body into an old selection.

Use `--refresh` on a current target for online validation. Eligible TTL reads may
reuse the existing observation; metadata revalidation does not extend the independent
native full-body deadline. A fixed ref does not select newer content. `--offline`
requires the selected local bytes.

```sh
ntn-skills read CURRENT_REF --database ENTRY_DATABASE_ID --refresh --metrics
ntn-skills read EXACT_FILE_REF --output ./selected-file.bin
ntn-skills export SNAPSHOT_ID_FROM_READ --output ./selected-skill
```

Export preserves complete selected bytes and executable modes. Existing differing
output is rejected. Reading or exporting a script does not execute it. An arbitrary
multi-path partial export is not yet exposed as a public command; use an exact
file read with `--output` for one file.

## The four tables

| Table | Current responsibility |
| --- | --- |
| Skills | Identity, discovery metadata, enablement, Members/Requires, main Content descriptor and current operation state |
| Files | One row for every supporting file, exact owner, stable File ID, path and Content descriptor |
| Sources | Stable source definition, current selected plan, target contributions and unfinished operation |
| Records | Necessary current exact resources, one current Profile and unfinished management intents |

The `Content` descriptor selects native author Markdown, a Notion-owned exact
resource, or a selected Source file. Main content lives on Skills; supporting files
live on Files. Native body edits remain authoritative. Source and resource files
are consumed from their exact declared originals. Explicit projection writes their
complete text to the existing Skills and Files pages without changing authority.
Native author bodies are verified without replacement. Non-text files retain
their original acquisition route and do not require generated bodies. See the
[current contract](docs/current-contract.md) for the daily coverage boundary.

Inspect the current directory without fetching bodies:

```sh
ntn-skills ctl library files SKILL_PAGE_ID --entry ENTRY_DATABASE_ID
```

A missing current descriptor returns `CURRENT_SCHEMA_REQUIRED`. An applying or
attention state identifies one unfinished current operation. Reads neither migrate
the schema nor reconcile that operation.

## Read daily content in Notion

After synchronizing current content, inspect and generate its text bodies:

```sh
ntn-skills ctl library projection --daily --entry ENTRY_DATABASE_ID --dry-run
ntn-skills ctl library projection --daily --entry ENTRY_DATABASE_ID
```

Daily means Source 日用 members, Skill 日用 and Default Context combined. Existing
Enabled and 期望删除 values are reported and preserved. To select one Skill, replace
`--daily` with its exact page ID. Equal complete bodies cause zero semantic writes.
An interrupted daily run reports completed targets and the exact single-Skill
resume command. Resume that intent, then run `--daily` again. Native bodies remain
authoritative, and projection failure leaves already-ready consumption available.
See [projection management](docs/shared-authoring.md#generate-readable-text-in-notion).

## Setup and Profiles

For a new authorized parent:

```sh
ntn-skills ctl library init --parent PARENT_PAGE_ID
```

This creates the current layout. It does not import local Skills or establish Pi
delivery. Follow the [setup reference](skills/notion/ntn-skills-maintain/references/setup.md)
for the exact boundary and current inspection path.

Import a complete local tree into that current library:

```sh
ntn-skills ctl library import INPUT --entry ENTRY_DATABASE_ID --skill-id STABLE_SKILL_ID --dry-run
ntn-skills ctl library import INPUT --entry ENTRY_DATABASE_ID --skill-id STABLE_SKILL_ID
```

Import preserves exact resource originals; run `ctl library projection` for reading pages. Use
`--native SKILL.md --native references/guide.md` to select editable UTF-8/LF bodies;
the same selection is required on resume. It replaces the
whole file tree for that stable identity; review removals in dry-run. Repeat equal
input for a zero-write no-op. Resume unfinished work with the same input and
`--operation OPERATION_ID --resume`. See [current authoring](docs/shared-authoring.md).

Profiles hold current View/freshness rules on one stable Record:

```sh
ntn-skills ctl library profile list --entry ENTRY_DATABASE_ID
ntn-skills ctl library profile show PROFILE_ID --entry ENTRY_DATABASE_ID
ntn-skills list --profile PROFILE_ID --database ENTRY_DATABASE_ID
```

Use `profile set --help` for a complete authorized replacement. It requires
`--name`, `--enabled` and the current `--expect` fingerprint. Omitted optional
rules are removed. A Profile fingerprint detects an observed conflict, not distributed
CAS. Profiles and Views never grant permission.

## Agent integration

Read `notion/ntn-skills` through the builtin catalog for consumption guidance.
`notion/ntn-skills-maintain` covers setup, complete current import and finite
recovery. `notion/ntn-skills-sync` covers current Profile rules and explicit Git
Source apply/refresh, file authority changes and Source lifecycle management,
including mixed-tree preservation.

Pi is the first daily host. Its Notion consumption uses the matching SDK for
discovery, use and resource reads. OMP/Tern adaptation is deferred. Their local
Skill content remains within the Pro migration inventory.

Use `ntn-skills schema` or an exact subcommand `--help` when syntax is unclear.
Old guide commands are not a reason to restore compatibility routes.

## Development and verification

Follow [Contributing](CONTRIBUTING.md). The existing
[current-convergence journey](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md)
keeps six bounded groups. Current source tests, live Notion cleanup, independent
package installation and actual Pi delivery establish different outcomes.
A passing controlled reader test does not complete migration or install a host.
