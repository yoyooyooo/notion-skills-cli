# Discovery and integration

The CLI supplies current metadata and locally selected file trees. Host adapters
supply startup discovery, activation and native tools. Installing a builtin
alone does not configure an adapter or inject remote instructions.

## Host consumption

Use the host's exact executable argv and library scope. Startup metadata gives
names, descriptions, stable refs, coverage and freshness without loading bodies.
If none is supplied, use the entrypoint's metadata discovery.

A complete main body already visible is sufficient for an introduction.
Read a requested reference from its containing-file ref and selected directory.
Use `files SNAPSHOT_ID` when the path is unknown. Preserve the successful
result's owner, snapshot, scope and freshness.

Inspection does not activate a Skill. Use selects a root and complete Requires
closure. Members remain lazy. A prepared response or enqueued payload does not
prove actual model delivery; truncated or failed content is not complete.

For maintenance in a connected library, discover `ntn-skills-maintain` through
the host's Notion directory or scoped CLI `list`, then read the returned ref.
Reading only inspects the workflow. To apply it, use that source's exact ref via
Pi `notion_use(ref)` or CLI `use REF --database ENTRY --json`, loading its Requires
unless already prepared for this task. If neither route is available, report
unavailable adoption. Inspect the edited target without activating it.
Use `ntn-skills-sync` the same way for Source management. If the startup directory
is pending or its View omits the target, query the connected library explicitly.
Incomplete discovery is an error, not permission to substitute a package copy.

Without a connected library, or for explicit offline/package inspection, Context
Broker can expose `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and
`$ntn-skills-sync@builtin`. Package identity is distinct from remote content.
Builtin reads need no Notion copy. Keep references with the selected owner:
ordinary `read --from` for Notion, `ctl builtin read --path` for package content.
A native `Read skill://...` route exists only when the host registers it;
otherwise the shell CLI remains available.

This current integration target is the paired CLI/SDK/Broker in Pi. OMP/Tern
host acceptance is deferred; their local Skill content can still be inventoried
for the user's Notion library. Do not infer host support from CLI URI support.

## Current selection and cache

A task keeps one selected tree until explicitly selecting current content again.
Already materialized bytes remain usable locally. A missing Source/resource byte
may be acquired only through its unchanged current declared owner and location.
A missing native selected byte cannot be reconstructed as an older body.

Current observations may reuse unchanged native bodies after complete metadata
checks. Native bodies also have an independent 24-hour recheck deadline.
`--refresh` reads those bodies again without fetching every unrequested raw
resource. Source files retain exact revision/hash/size/mode; reads never advance
a branch. Full Source manifests and Contributions define every Git path, including
scripts/tests absent from Files. Source reading-row deletion or reconstruction
does not change a selected source file identity. Source refs use paths; physical
file bindings remain authoritative for native/resource files. A Source/resource
reading projection does not control its bytes. A whole-file native/resource
takeover removes that path from the Source contribution, so missing old Source
bytes require reselection rather than fetching an obsolete authority.

All ordinary consumption is remotely read-only. No Record creation, body
projection, adoption or cleanup occurs during a read. Query POSTs are reads.
Current Name/Description changes can appear without changing file bytes or
content identity; an active immutable local selection retains its own metadata.

## Connection and local state

Authentication uses a nonempty saved token before `NOTION_API_TOKEN`.
`ctl config show` exposes presence only. Configure a token through trusted
stdin when requested, never command arguments or chat. A token's presence does
not establish validity or access to the selected library.

Use `NTN_SKILLS_CONFIG_HOME`, `NTN_SKILLS_HOME` and
`NTN_SKILLS_CACHE_HOME` for isolated tests. Do not copy personal configuration
or author caches into an independent consumer. A different local root does not
change remote permissions.

`NOTION_API_BASE_URL` is a trusted API origin and part of credential scope.
Do not change it to bypass an access error. Avoid logging credentials or signed
resource URLs. Cached local content is not evidence of current remote permission.

`ctl cache status` inspects local cache state. Cache configuration and reclamation
are explicit local actions; consult their current schema only when needed.
Clearing state is not the default fix for an active selection or stale host
metadata.

## Diagnose discovery and loading

| Symptom | Check and action |
| --- | --- |
| Expected workflow absent | Inspect coverage and failed sources; broaden query or select the exact known database. Search absence is not workspace absence. |
| Bare-name read reports CATALOG_INCOMPLETE with no failed sources | Global Notion Search is still non-exhaustive. Use an explicit database or exact returned ref; a machine binding does not make global name lookup unique. |
| Same name matches several pages | Select the intended database or exact returned ref; preserve each identity. |
| Current schema required | Keep the precise error and affected entry. Current descriptor conversion is a management task; another reader must not mask it. |
| Current operation pending | Inspect its current state and operation ID with library files; do not mark ready by hand. |
| Content appears old | Distinguish host metadata, a bounded observation, an active selection and the Source's selected revision. Ordinary `read --refresh` validates the current descriptor; it does not advance a Git Source or install a newer package. |
| Projected maintenance guidance differs from the installed package | Compare main and supporting bytes plus discovery Description. Refresh the authorized Source and its reading projection explicitly; preserve existing task selections and human metadata. |
| Selected file is missing | Inspect the selection's directory and current exact descriptor. Re-select when the old local bytes are unavailable; do not substitute a newer file silently. |
| Native tool rejects skill URI | Check the host adapter; use the supplied CLI until its native route exists. |
| Builtin missing | Check the paired Broker/package identity and exact @builtin token; no remote publication is required. |
| Authentication or access fails | Check existing token precedence, intended workspace and sanitized doctor output. Do not expose or silently replace credentials. |
| Reading page looks complete but bytes differ | Inspect its Content authority. Generated reading pages do not replace the exact Source/resource bytes. |

Follow the current installed parser and supplied host interface. Report actual
configuration, current read and model delivery separately. Loading succeeded
only when the necessary complete content was actually returned.
