# Commands and recovery

Run `ntn-skills --help` for installed capabilities and `ntn-skills COMMAND --help` for exact parameters. Help/version work offline and return text. Other commands return one JSON value; exit 0 succeeds, exit 1 is an operational failure and exit 2 is invalid input. Use `schema [command path...]` for machine-readable types, defaults, cardinality and constraints from the installed parser. Parse errors include `next.argv` for the relevant offline help. Bare collections such as `sync upstream list` return an `items` array; named arrays such as catalog `records` retain their fields. Replace example placeholders with actual returned identities.

## Discovery and reads

```bash
ntn-skills list [--query TASK_TERMS] [--database DATABASE_ID_OR_ALIAS]
ntn-skills ctl database list
ntn-skills read 'CURRENT_REF_FROM_LIST'
ntn-skills read 'CURRENT_PAGE_ID' --refresh
ntn-skills files 'SNAPSHOT_ID_FROM_READ'
ntn-skills read 'RELATIVE_PATH' --from 'PINNED_CONTAINING_FILE_REF'
ntn-skills read 'PINNED_FILE_REF' --lines 10-30
ntn-skills read 'PINNED_BINARY_REF' --output NEW_LOCAL_PATH
```

`list` paginates metadata without bodies or file manifests and retains coverage, database identity and freshness. `--query` filters Name/alias/Description. Database selectors accept one ID, URL or exact case-sensitive registered alias; titles are labels. Unknown/ambiguous selectors fail without fallback. Different databases may contain same-name Skills; preserve page identities and select a database or exact returned record ref. `ctl config show` inspects local aliases; `ctl database register ALIAS --database SELECTOR` validates and registers one, and `ctl database unregister ALIAS` removes only the exact local alias offline. `ctl config set default_database SELECTOR` affects create only and does not constrain discovery. `ctl config unset default_database` clears the preference offline.

Each `list` row also carries boolean `default_context` (missing or unchecked is false); this field never filters `list` or explicit reads.

Record `name` and authored frontmatter `name` retain their exact human-readable spelling; names must be nonempty without control characters. Unicode, digits, spaces and hyphens are allowed. A callable `alias` normalizes to NFC and lowercase, trims surrounding whitespace, replaces whitespace runs with `-`, and percent-encodes characters outside Unicode letters, marks, numbers, `_` and `-`. `Tty7`, `n8n-workflow`, `React19` and `中文` retain those names, with aliases `tty7`, `n8n-workflow`, `react19` and `中文`. `Review/2026` has alias `review%2F2026`. Aliases never establish identity; collisions require an exact page ID or ref. See the [public read-output example](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/protocol.md#success).

These illustrative JSON excerpts show the naming fields in successful `read` output and the corresponding authored frontmatter. The full response also supplies exact identity, scope, pinned ref, version, freshness and range; retain those fields when selecting or activating content.

```json
[
  {"record": {"name": "Tty7", "alias": "tty7"}, "content": "---\nname: Tty7\ndescription: Terminal workflow\n---\nUse the selected terminal workflow."},
  {"record": {"name": "n8n-workflow", "alias": "n8n-workflow"}, "content": "---\nname: n8n-workflow\ndescription: Automation workflow\n---\nUse the selected automation workflow."},
  {"record": {"name": "React19", "alias": "react19"}, "content": "---\nname: React19\ndescription: React workflow\n---\nUse the selected React workflow."},
  {"record": {"name": "中文", "alias": "中文"}, "content": "---\nname: 中文\ndescription: 中文工作流\n---\n按所选工作流执行。"}
]
```

Current `read/files/export/list` accept one of `--refresh`, `--offline`, `--max-age DURATION`. Defaults are 5m for content and 60s for metadata. Refresh validates online; offline intentionally selects eligible local observations and reports their age; max-age overrides the limit (`0` requires validation). Failed validation never falls back silently to stale bytes. Unpinned offline lookup requires the same locally identifiable credential and endpoint scope; explicit snapshot pins retain their own identity.

Shared current reads batch flat Files metadata and retained ownership before reusing unchanged bodies. Complete newly observed Notion edits become whole-file customizations after their shared facts verify; no manual adopt marker is required. An independent full-body deadline bounds same-timestamp edits. Preserve the exact `shared_skill` locator, encoded stable record ID and scope; a stable ID is not a page UUID.

An existing legacy native Skill read/files/export may renew an aligned source-bundle observation through root/reference metadata, complete inclusion and immutable attachment checks, returning `freshness.validation="metadata"`. This avoids repeated body/ZIP downloads but can miss edits with unchanged reported versions. `--refresh` or explicit `--max-age 0` always validates complete bodies/resources. A cold machine or missing version checkpoint uses the complete path. Mutation/sync validation is unchanged.

Host metadata consumers can use `ctl cache identity` to obtain an opaque local credential/configuration digest and effective catalog TTL without contacting Notion. It exposes no credential or account, does not establish current permission, and does not change read/offline scope validation. See the [cache contract](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/protocol.md#read-policy-and-cache-management).

Pinned refs and snapshots are immutable and offline; pinned relative `--from` preserves that version and rejects refresh/max-age. Use the snapshot ID to enumerate all files; a file ref filters its file. Resolve relative links from the containing file, including nested references. `--path` cannot be combined with a target that already has a path, and `--from` rejects `--path`. Inclusive line ranges are 1-based. `--raw` omits JSON identity/freshness, so use it only after retaining those fields. Binary files use `--output`; differing existing output fails with `OUTPUT_CONFLICT`. Reading a script does not authorize execution.

## Task routing

For Notion page creation, a combined file/metadata change through `apply` against a pinned baseline, or a one-time portable import/export, load `ntn-skills-maintain`. For fixed shared sources, Profile/View defaults, existing upstream subscriptions, local-directory synchronization, baseline conflicts or their interrupted operations, load `ntn-skills-sync`. If a sibling is unavailable, read its exact ID with `ctl builtin read`, then read the needed supporting files from the returned inventory using `--path`. No local install is required just to inspect package instructions.

## Local builtins

The three package IDs are `notion/ntn-skills`, `notion/ntn-skills-maintain` and `notion/ntn-skills-sync`. Context Broker exposes them as `$ntn-skills@builtin`, `$ntn-skills-maintain@builtin` and `$ntn-skills-sync@builtin` through ordinary Skill selection. These package reads need no local install or Notion source; the CLI commands below manage explicit local copies.

```bash
ntn-skills ctl builtin list
ntn-skills ctl builtin read notion/ntn-skills
ntn-skills ctl builtin read notion/ntn-skills --path references/integration.md
ntn-skills ctl builtin install notion/ntn-skills
ntn-skills ctl builtin status
ntn-skills ctl builtin update notion/ntn-skills
ntn-skills ctl builtin install notion/ntn-skills --agent-dir ~/.claude --agent-dir ~/.pi/agent
ntn-skills ctl builtin export notion/ntn-skills --output ./portable-entrypoint
```

These commands work offline without network access or credentials. `ctl builtin list` returns metadata and installation state without instruction bodies. Install/status/update default to the central XDG data store and `~/.agents/skills/<name>` links. Optional repeated `--agent-dir DIR` adds `DIR/skills/<name>` destinations pointing to that same tree; registered targets persist for updates. `NTN_SKILLS_DATA_HOME` overrides the full data directory, otherwise `$XDG_DATA_HOME/ntn-skills` or `~/.local/share/ntn-skills` applies. Export is portable output without installation ownership. Exact IDs select builtins; ordinary remote `list/read` never fall back to package content.

Keep the central version-2 `.ntn-builtin-install.json` and separate distribution records: they record exact ID/data-root/path/package/content identity, the complete file baseline and owned links. Repeated identical install reuses content and can add targets. Clean old content requires explicit update; all links share its replacement, with prior bytes retained through system Trash. Added/deleted/changed files, foreign links and unowned directories block replacement. Receipt-v1 profiles require independent migration; normal commands preserve them and report a conflict. Never fabricate a receipt or silently adopt another tool's target.

States are `not_installed`, `current`, `update_available`, `modified`, `unmanaged` and `interrupted`. Interrupted records remain outside `skills`; inspect status and recovery/outcome before an explicit retry. Reload/restart host discovery after install/update; OMP uses `/restart`. CLI upgrades, local builtin updates and remote `ctl builtin publish` are independent. Publishing a package copy is an authorized online content-maintenance task; use the maintenance workflow and exact selected destination.

## Read and management failures

| Failure | Next action |
| --- | --- |
| `SKILL_AMBIGUOUS` | Select from candidate database/page identities; do not take the first name match |
| `CATALOG_INCOMPLETE` | Inspect failed source identities; query a known database and do not claim global absence |
| `SKILL_NOT_FOUND` | Broaden metadata query or select a known database/current page |
| `INVALID_SKILL_NAME`, `INVALID_SKILL` | Route a selected content repair to maintain; do not activate malformed content |
| `SNAPSHOT_MISSING`, `SNAPSHOT_CONFLICT` | Preserve the requested identity; loading current content cannot recreate an arbitrary historical version |
| `FILE_NOT_FOUND` | Inspect the pinned file inventory and containing-file path |
| `BINARY_FILE` | Use output and an appropriate viewer |
| `BUILTIN_UPDATE_AVAILABLE` | Inspect status and explicitly update clean registered content |
| `BUILTIN_MODIFIED`, `BUILTIN_UNMANAGED` | Preserve local bytes; do not remove/fabricate receipts to force replacement |
| `BUILTIN_DISTRIBUTION_CONFLICT` | Inspect conflicting destinations or registry errors independently of central state; preserve foreign/changed links and ownership records |
| `BUILTIN_NOT_INSTALLED` | Explicitly install the central Skill before updating; legacy profiles require independent migration |
| `BUILTIN_INTERRUPTED` | Inspect journal readback/outcome; preserve an unresolved fence |
| `BUILTIN_PATH_CHANGED`, `BUILTIN_IO_ERROR` | Resolve path drift/I/O without discarding prior bytes or transaction records |
| `OUTPUT_CONFLICT` | Select a fresh output or review the existing bytes; no blind overwrite |
| `AUTH_REQUIRED`, `ACCESS_DENIED`, `NOTION_UNAVAILABLE`, `NOTION_QUEUE_FULL`, `NOTION_SCHEDULER_UNAVAILABLE` | Follow [diagnosis](integration.md#diagnose-discovery-and-loading) |

Unknown errors remain failures. Read sanitized transport `details.reason` or nested `cause_details.reason`; do not request raw stderr that may contain credentials/signed URLs. For a partial or unknown shared operation, retain its original ID/input and use the matching maintenance or source recovery path. A fresh exact current read reconciles shared body writes, metadata, apply and restore-follow; `read_again` requests another read after the original outcome has been verified. Add/delete/move use `ctl library file reconcile TARGET OPERATION_ID --entry ENTRY`. Shared IDs are not legacy Publication IDs. Use `operation show`/`reconcile`/`resume` only for an operation returned by that earlier workflow. Creating another operation never resolves an unknown request. A verified `not_applied` or `partial` recovery confirms the reported outcome, not a completed edit.

[Public CLI contract](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/protocol.md) owns exact response, identity, storage and recovery semantics.

## Discover through a Notion View

```bash
ntn-skills views --database library
ntn-skills list --default-view --database library
ntn-skills list --view 'VIEW_ID_OR_NOTION_URL' --database library
ntn-skills list --profile PROFILE_ID --database library
```

Replace selectors with returned identities. `views` preserves the Notion API order, not an alphabetical sort or a promise about UI tab order. `--default-view` consults the machine-bound shared Profile, falling back to the first API-order View when no default is configured. `--profile PROFILE_ID` selects a shared rule with an explicit `--database`. Explicit `--view` takes precedence over Profile defaults and does not fall back when missing or inaccessible. Omit these selections to discover the full configured library. Profile rules do not activate bodies or grant access; route rule changes to `ntn-skills-sync`. `--query` filters returned metadata and never reads bodies. A selected View includes native quick filters. Empty results and no Views are successful empty directories; failed or incomplete queries are not. View membership is discovery policy, not permission.

View observations use the catalog freshness policy, isolated by credential, database and selector. `--refresh` starts a new native query. Continuation pages retain its query ID and expiry; expiry never extends the observation TTL. Incomplete, missing or repeating pagination fails. Known member metadata errors remain explicit in `coverage.failed_sources`; valid rows are returned, but a partial result cannot establish unique-name resolution.

## Active provider-neutral Sources

For a registered four-table shared library, `ctl library sources list/show/members` inspects mutable origins. `check/fetch` explicitly acquires Git/GitLab or Linear content without remote writes. `prepare/apply` advances one bound member through an exact frozen plan while preserving custom files and older pins. Delegate these changes to `ntn-skills-sync`; ordinary `list/read/files/export` never follows a branch or re-fetches Linear implicitly. The full JSON input and recovery contract is in the [source guide](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sources-management.md).
