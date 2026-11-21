# Use the current Skill library

This guide covers the CLI in the `next` checkout. Use the matching built package.
The live Notion tables and Pro Pi installation still require their own cutover.
The [current library contract](current-contract.md) defines the data model and remaining work.

## Install the package

Use Node.js 22.22.3 or later within 22.x, or Node.js 24.20.0 or later.
The product uses Node's SQLite runtime. Bun is a repository build and test tool.

For a published build:

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --version
ntn-skills schema
```

For an unpublished candidate, install its built tarball:

```bash
npm install --global /absolute/path/ntn-skills-VERSION.tgz
```

A project-local install uses `npm install ntn-skills`. Invoke that copy with
`npx --no-install ntn-skills`. Source builds follow [Contributing](../CONTRIBUTING.md#development-setup).

## Select the credential and library

Use an existing `NOTION_API_TOKEN`, or pipe a token from your secret source into
`ntn-skills ctl config set-token --stdin`. A saved `config.token` takes precedence.
The saved value is plaintext in a private local configuration file.

Inspect configuration and access:

```bash
ntn-skills ctl config show
ntn-skills ctl doctor --database LIBRARY_ENTRY
ntn-skills ctl library inspect LIBRARY_ENTRY
```

Replace `LIBRARY_ENTRY` with the exact Skills database ID.
`config show` omits the token. `doctor` without `--database` checks authentication only.
With a database, it also checks the current library descriptor, complete catalog
metadata and relation schema. It does not choose or read a Skill body;
`skill_read.checked` is false. Use an explicit `read` or `use` to verify the content
you intend to consume. Enabled metadata alone does not prove content readiness.

To return to environment-token selection:

```bash
ntn-skills ctl config clear-token
```

Share the library's Skills, Files, Sources, and Records with the selected Notion integration.
Reading requires content access. Import and Profile changes also require the relevant write access.

## Find and read a Skill

Start with a bounded metadata page:

```bash
ntn-skills list --database LIBRARY_ENTRY --limit 50
ntn-skills list --database LIBRARY_ENTRY --query review --limit 50
```

Use `next_cursor` with the same directory and query to continue a paginated result.
The limit bounds returned metadata. It does not set a total HTTP request budget.
Check coverage and failures before treating a discovery result as complete.

Copy the exact returned identity or ref:

```bash
ntn-skills read 'REF_FROM_LIST' --database LIBRARY_ENTRY
ntn-skills use 'REF_FROM_LIST' --database LIBRARY_ENTRY --json
ntn-skills files 'REF_FROM_LIST' --database LIBRARY_ENTRY
```

`read` returns one file. `use` prepares the selected instructions and their Requires graph.
`files` returns the complete directory of the selected Skill, including files whose bytes
have not yet been downloaded. Keep returned refs for subsequent reads.

Read one supporting file or resolve a relative link from its containing file:

```bash
ntn-skills read 'RETURNED_FILE_REF'
ntn-skills read references/checklist.md --from 'RETURNED_MAIN_REF'
ntn-skills read 'RETURNED_FILE_REF' --lines 1-80
```

For current content, choose at most one of `--refresh`, `--offline`, or `--max-age 5m`.
A returned fixed ref identifies a local selection. It does not accept refresh or max-age.
If the selected bytes are no longer available, read the current Skill again.

## Inspect the Notion file directory

Use the management index when you need current owners, paths, descriptors, and operation state:

```bash
ntn-skills ctl library files SKILL_PAGE_ID --entry LIBRARY_ENTRY
```

This command finishes pagination for the selected owner and does not read file bodies.
It does not inspect unrelated owners or certify that the whole library has no residue.
A Skill in `applying` or `attention` remains unavailable for ordinary consumption.

## Generate readable Notion text

Use explicit management after import or Source refresh:

```bash
ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library projection SKILL_PAGE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library projection --daily --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library projection --daily --entry LIBRARY_ENTRY
```

The main stays on Skills. Source reading rows include Markdown by default and
exclude test, fixture, dependency and generated directories. Repeated `--include`
or `--exclude` globs replace that default list. The command creates selected
missing Files, updates descriptors and archives excluded or removed Source rows.
Full Git consumption still uses the complete manifest and Contributions; scripts
and tests remain consumable. Native/resource rows remain Notion authority. Native
bodies are checked without replacement; non-text originals need no body. Dry-run
reports selected/excluded paths and row/body changes; an equal result makes zero writes.

Daily combines current members of Sources marked 日用, Skills marked 日用 and
Default Context. Enabled and 期望删除 are reported and preserved. A missing current
binding or inaccessible original is a failure, not an omitted daily target.
The daily run stops at the first failure and reports completed and remaining
targets. Follow its exact single-Skill `--operation ID --resume` command, then
rerun `--daily`. To stop that exact intent before changing policy, use
`--operation ID --cancel`; only its pending action is reconciled. Daily does not
accept `--operation`, `--resume` or `--cancel`; projection has no supersede mode. Projection failure leaves already-ready consumption available.

All selected targets share the invocation's `--max-requests`, `--max-bytes` and
`--timeout` limits. Defaults are 1000 HTTP attempts, 512 MiB and 600000 ms. Ordinary
read/use/list/export never trigger this management action.

## Export the selected files

Export a complete file tree before making a local change:

```bash
ntn-skills export 'REF_FROM_LIST' --database LIBRARY_ENTRY --output ./my-skill.zip
ntn-skills export 'REF_FROM_LIST' --database LIBRARY_ENTRY --output ./my-skill
```

Use a new destination. An identical existing export is reused, while differing output is refused.
Source and resource files preserve exact bytes and executable mode.
A native file uses its current body and explicit file metadata.

To save one file:

```bash
ntn-skills read 'RETURNED_FILE_REF' --output ./checklist.md
```

Export writes locally and includes the selected Skill's complete current
Members/Requires in its portable manifest. It does not create a remote content
version or copy Profiles and Source management configuration.

## Import a complete Skill

Prepare a directory whose root contains `SKILL.md`, then inspect the proposed replacement:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --dry-run
```

Review every input path and the returned `remove` list. Import replaces the complete tree;
existing supporting files omitted from the input are removed.

Apply and resume use the same command and stable operation ID:

```bash
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --operation import-my-skill
ntn-skills ctl library import ./my-skill --entry LIBRARY_ENTRY --skill-id my-skill --operation import-my-skill --resume
```

Keep the same complete input and operation ID for a resumed import.
Portable relationship fields preserve when omitted, clear with [], and replace
with a full array of same-library stable Skill refs. Review `relations` in dry run.
All remote work shares 1000 HTTP attempts, 512 MiB payload bytes and 600000 ms by
default. Use --max-requests, --max-bytes and --timeout in ms for explicit limits.
The [current authoring guide](shared-authoring.md) covers accepted inputs, reading projections,
Profile changes, and interrupted operations.

## Choose a Profile or View

Inspect current Profiles before selecting one:

```bash
ntn-skills ctl library profile list --entry LIBRARY_ENTRY
ntn-skills ctl library profile show daily --entry LIBRARY_ENTRY
ntn-skills ctl library profile bind daily --entry LIBRARY_ENTRY
ntn-skills list --database LIBRARY_ENTRY --default-view
```

Bare `list` remains explicit discovery. Use `--profile daily`, `--default-view`,
or an explicit `--view VIEW_ID` for the intended selection.
Profiles and Views select content; they do not grant access.

## Inspect cache behavior

Check the local observations before clearing them:

```bash
ntn-skills ctl cache status
ntn-skills ctl config show
NTN_SKILLS_REQUEST_TRACE_LIMIT=10000 ntn-skills read 'REF_FROM_LIST' --metrics --json
```

Content observations default to five minutes and catalog observations to 60 seconds.
Profile rules or explicit read options can change the effective age.
The [protocol](protocol.md#requests-and-limits) separates cache age, pagination, and HTTP limits.

To retire disposable observations deliberately:

```bash
ntn-skills ctl cache clear --all --dry-run
ntn-skills ctl cache clear --all
```

Cache clearing does not resolve an unfinished import or clean remote Notion tables.

## Upgrade or uninstall

Install the desired package version or matching candidate tarball.
Use `npm uninstall --global ntn-skills` for a global installation,
or `npm uninstall ntn-skills` in a consuming project.

Uninstalling leaves configuration, local state, cache, and builtin data in place.
Use `ctl config clear-token` before uninstalling if you want to remove a saved token.
See [local storage](protocol.md#environment-and-local-storage) for the effective roots.
