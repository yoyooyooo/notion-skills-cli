# Use the current Skill library

This guide covers the CLI in the `next` checkout. Use the matching built package.
Verify access to the intended library and any host connection separately.
The [current library contract](current-contract.md) defines the data model and boundaries.

## Install the package

Use Node.js 22.23.5+ within 22.x, 24.22.3+ within 24.x, or 26.13.1+ within 26.x.
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
ntn-skills ctl doctor --library LIBRARY_ID
ntn-skills ctl library inspect --library LIBRARY_ID
```

Replace `LIBRARY_ID` with the canonical UUID of the Library root page.
`config show` omits the token. `doctor` without `--library` checks authentication only.
With a Library, it also checks the current root, four direct child databases,
descriptor, complete catalog
metadata and relation schema. It does not choose or read a Skill body;
`skill_read.checked` is false. Use an explicit `read` or `use` to verify the content
you intend to consume. Enabled metadata alone does not prove content readiness.

To return to environment-token selection:

```bash
ntn-skills ctl config clear-token
```

Grant the selected Notion integration access to the Library root and its Skills,
Files, Sources, and Records databases. Root selection does not narrow the token's
permissions.
Reading requires content access. Import and Profile changes also require the relevant write access.

## Initialize or reconnect a library

For guided setup, read from the same executable you will use for management:

```bash
ntn-skills ctl builtin read notion/ntn-skills-maintain --path references/setup.md
ntn-skills ctl library init --parent AUTHORIZED_PARENT_PAGE
```

Use an authorized parent page. Init creates a dedicated Library root below it
and makes all four databases direct children of that root. Save
`library.library_id` as `LIBRARY_ID`; it is the root page UUID. Future sessions
need this root and their credential environment:

```bash
ntn-skills ctl library init --library LIBRARY_ID
```

Successful init means the structure is ready. Its `next.argv` is a read-only
`list`; an empty result before your first Skill is normal. Init does not copy
Builtins, create business content, save defaults, install Skills, register a
Source, or configure Pi. Create or import your first business Skill, read its
full body, and apply its method to a real task to verify first use. Interrupted
initialization uses the original operation and retained state; follow the setup
guide's reconciliation and explicit `--resume` steps.

If requested, `ctl config set default_library LIBRARY_ID` saves a consumption
default. It does not supply a management write target; keep explicit `--library`.

## Product guidance and team workflows

Routine maintenance and Source sync default to the task executable's Builtins,
including with a connected library:

```bash
ntn-skills ctl builtin read notion/ntn-skills-maintain
ntn-skills ctl builtin read notion/ntn-skills-sync
```

These reads need no Notion copy or remote workflow search and do not authorize
writes or select their target. Ordinary business discovery uses your library.
An explicitly selected Notion/team workflow keeps its exact source/ref: inspect
with `read`, apply with `use` and complete Requires. Failed or incomplete
discovery, pending content and denied access remain errors; do not substitute
the package. Keep an active task's selected identity and content.

The setup guide also covers optional export/create into Notion for team
customization. These are user-owned native Skills with independent identities,
not automatically updated package copies or Source reading projections.

## Find and read a Skill

For remote title and body matching, configure the separate MCP connection and use
`list --library LIBRARY_ID --search-in content --query "keywords"`.
See [Remote content search](notion-mcp.md) for token/OAuth setup, Pi authorization,
eligibility rules and the limits of remote matching.

Start with a bounded metadata page:

```bash
ntn-skills list --library LIBRARY_ID --limit 50
ntn-skills list --library LIBRARY_ID --query review --limit 50
```

Use `next_cursor` with the same directory and query to continue a paginated result.
The limit bounds returned metadata. It does not set a total HTTP request budget.
Check coverage and failures before treating a discovery result as complete.

Copy the exact returned identity or ref:

```bash
ntn-skills read 'REF_FROM_LIST' --library LIBRARY_ID
ntn-skills use 'REF_FROM_LIST' --library LIBRARY_ID --json
ntn-skills files 'REF_FROM_LIST' --library LIBRARY_ID
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

Use the ref of the file that contains the link, including a nested supporting file.
A cross-Skill relative link such as `../review/SKILL.md` works only when that file
has a reliable current Source route and an exact contribution mapping. Otherwise
use an explicit stable Skill ref; neighboring cache directories are not a lookup
mechanism. Reading the target still inspects it without loading Requires.

For current content, choose at most one of `--refresh`, `--offline`, or `--max-age 5m`.
A returned fixed ref identifies a local selection. It does not accept refresh or max-age.
If the selected bytes are no longer available, read the current Skill again.

## Write and retain references

| Reference | Meaning |
| --- | --- |
| `skill://architect` | The stable ID `architect` in the containing Library; select its declared entrypoint |
| `skill://architect/references/design.md` | That owner's exact file path |
| `skill://architect?library=44444444-4444-4444-8444-444444444444` | The explicitly selected root Library and stable Skill ID |
| `skill://architect/SKILL.md?library=44444444-4444-4444-8444-444444444444&snapshot=s_<64-hex-digits>` | A tool-returned fixed manifest and exact path |

The snapshot row illustrates the format; keep the real value returned by a tool.
Percent-encode each path segment and each query value separately. Do not encode
a slash inside a segment to change directory boundaries. Display titles, aliases,
Skill page IDs and table IDs do not replace stable Skill IDs or Library root IDs.

At a CLI entry, bind short refs with `--library LIBRARY_ID`, or configure
`ntn-skills ctl config set default_library LIBRARY_ID`. Management always requires
its explicit `--library`. In a document, `skill://architect` inherits that document's
Library, not the current default. Use a `library` parameter for an external owner.
Read the descriptor's `library_id` from `ctl library inspect --library LIBRARY_ID`.
See [the reference contract](skill-reference-redesign.md) for fixed and relative behavior.

## Create, edit, register or remove a native Skill

Use the current Library root and an exact Skill page ID/URL or stable Skill ID:

```bash
ntn-skills ctl library skill create ./my-skill --library LIBRARY_ID --skill-id my-skill
ntn-skills ctl library skill update my-skill --library LIBRARY_ID --input ./SKILL.md
ntn-skills ctl library skill update my-skill --library LIBRARY_ID --file references/guide.md=./guide.md
ntn-skills ctl library skill register SKILL_PAGE_ID --library LIBRARY_ID
ntn-skills ctl library skill remove my-skill --library LIBRARY_ID --dry-run
ntn-skills ctl library skill remove my-skill --library LIBRARY_ID
```

Create makes Markdown native and other files exact resources. Update changes the
main by default; use --path for another file, repeated --file PATH=LOCAL for
supporting writes or --remove-file PATH for removal. Unmentioned files and current
Notion edits remain intact. Name, description, enablement, default context and
Members/Requires have explicit author options; see [daily authoring](shared-authoring.md#manage-native-skills).

Register preserves a page already authored in this Skills table and fills missing
machine registration. Supply --name/--description when valid business metadata
is missing. Remove includes supporting Files, unused owned resources and incoming
same-library Members/Requires cleanup; other Skills and relationships remain.
No internal field editing or successful-operation cleanup is left to an Agent.

All four actions support --dry-run and invocation budgets. Repeat the same intent
after interruption. Native writes verify full Notion content and report supported
format normalization; native read/export uses the current Notion body. Native
edits do not need projection. Read with --refresh for immediate verification.

## Inspect the Notion file directory

Use the management index when you need current owners, paths, descriptors, and operation state:

```bash
ntn-skills ctl library files SKILL_PAGE_ID --library LIBRARY_ID
```

This command finishes pagination for the selected owner and does not read file bodies.
It does not inspect unrelated owners or certify that the whole library has no residue.
A Skill in `applying` or `attention` remains unavailable for ordinary consumption.

## Generate readable Notion text

Use explicit management after import or Source refresh:

```bash
ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID --dry-run
ntn-skills ctl library projection SKILL_PAGE_ID --library LIBRARY_ID
ntn-skills ctl library projection --daily --library LIBRARY_ID --dry-run
ntn-skills ctl library projection --daily --library LIBRARY_ID
```

The main stays on Skills. Source reading rows include Markdown by default and
exclude test, fixture, dependency and generated directories. Repeated `--include`
or `--exclude` globs replace that default list. The command creates selected
missing Files, updates descriptors and archives excluded or removed Source rows.
Full Git consumption still uses the complete manifest and Contributions; scripts
and tests remain consumable. Native/resource rows remain Notion authority. Native
bodies are checked without replacement; non-text originals need no body. Dry-run
reports selected/excluded paths and row/body changes; an equal result makes zero writes.
Pass `--include ''` to keep only the mandatory main and all Notion-owned files;
pass `--exclude ''` to apply no exclusion patterns. Empty and nonempty patterns
cannot be mixed for one flag. Omitted flags retain defaults.

Daily combines current members of Sources marked 日用, Skills marked 日用 and
Default Context. Enabled and 期望删除 are reported and preserved. A missing current
binding or inaccessible original is a failure, not an omitted daily target.
The daily run stops at the first failure and reports completed and remaining
targets. Repeat the same single-Skill or daily command without `--operation` to
continue a matching unfinished projection. The current target, reading policy
and complete input fingerprint must match; other content operations and
unconfirmed CREATE/append outcomes remain blocked. The reported explicit
`--operation ID --resume` command carries the original policy and requested
budgets; omitted filters in explicit resume use the frozen policy. To stop that exact intent before changing policy, use
`--operation ID --cancel`; only its pending action is reconciled. Daily does not
accept `--operation`, `--resume` or `--cancel`; projection has no supersede mode. Projection failure leaves already-ready consumption available.

All selected targets share the invocation's `--max-requests`, `--max-bytes` and
`--timeout` limits. Defaults are 1000 HTTP attempts, 512 MiB and 600000 ms. Ordinary
read/use/list/export never trigger this management action.

## Restore a trashed Skill and its reading pages

Use the original exact page ID after a completed Skill was moved to Trash:

```bash
ntn-skills ctl library projection SKILL_PAGE_ID --restore --library LIBRARY_ID
```

The command restores that page, preserving its identity, four policy checkboxes
and native/resource content, then runs and verifies the normal projection.
Its two stages share the request, byte and deadline budget. Keep the same reading
filters and repeat this command after interruption. An already live and complete
result makes zero semantic writes. `results[0].restoration.status` reports
`restored` or `unchanged`; `complete` requires the projection to finish too.

`--restore` accepts `--include`, `--exclude` and the budget limits. It requires a
single exact Skill and rejects `--daily`, `--dry-run`, `--operation`, `--resume`
and `--cancel`. It uses current Source originals without refreshing their HEAD.
Foreign or permanently unavailable pages, duplicate live identities and unfinished
content work are refused. A page trashed while an older projection is still
pending is also refused without overwriting that pending action. See
[the authoring guide](shared-authoring.md#restore-a-trashed-skill) for the boundary.

## Export the selected files

Export a complete file tree before making a local change:

```bash
ntn-skills export 'REF_FROM_LIST' --library LIBRARY_ID --output ./my-skill.zip
ntn-skills export 'REF_FROM_LIST' --library LIBRARY_ID --output ./my-skill
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
ntn-skills ctl library import ./my-skill --library LIBRARY_ID --skill-id my-skill --dry-run
```

Review every input path and the returned `remove` list. Import replaces the complete tree;
existing supporting files omitted from the input are removed.

Apply and resume use the same command and stable operation ID:

```bash
ntn-skills ctl library import ./my-skill --library LIBRARY_ID --skill-id my-skill --operation import-my-skill
ntn-skills ctl library import ./my-skill --library LIBRARY_ID --skill-id my-skill --operation import-my-skill --resume
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
ntn-skills ctl library profile list --library LIBRARY_ID
ntn-skills ctl library profile show daily --library LIBRARY_ID
ntn-skills ctl library profile bind daily --library LIBRARY_ID
ntn-skills list --library LIBRARY_ID --default-view
```

Without a Profile or View option, `list` discovers content within the selected
Library. The Library comes from `--library` or the local `default_library`.
Use `--profile daily`, `--default-view`, or an explicit `--view VIEW_ID` to select
the intended subset within that Library.
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

## Synchronize upstream Git

Use `ntn-skills ctl library source check --library LIBRARY_ID --source SOURCE_ID`
to inspect an explicit current Source without publishing. Use the corresponding
`source sync` command or `ntn-skills/management` to publish exact newer content
and resume compatible unfinished work. Scheduling stays with Dagu, cron or the
calling application. See [Source synchronization](source-sync.md) for identities,
budgets, projection and exit codes.

## Upgrade or uninstall

Install the desired package version or matching candidate tarball.
Use `npm uninstall --global ntn-skills` for a global installation,
or `npm uninstall ntn-skills` in a consuming project.

Uninstalling leaves configuration, local state, cache, and builtin data in place.
Use `ctl config clear-token` before uninstalling if you want to remove a saved token.
See [local storage](protocol.md#environment-and-local-storage) for the effective roots.
