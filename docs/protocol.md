# CLI and ref contract

The npm package and executable are `ntn-skills`; the source repository is `notion-skills-cli`. Normal operation outputs one JSON value on stdout. Help and version use Effect CLI's text rendering. `--raw` opts into successful plain text. Failures always return JSON, including parse errors, and nonzero status.

The distributed CLI requires Node.js 22.19.0 or newer, matching the Node platform dependency's minimum. npm installs the built tarball and its runtime dependencies; Bun is used only for repository development, building, packing and tests. Online operations additionally require the official `ntn` CLI. See [installation](../README.md#installation) and [contributor setup](../CONTRIBUTING.md#development-setup).

For installation and a first successful read, use [the README Quick start](../README.md#quick-start). [Host integration](host-integration.md) describes adapter behavior, [the bootstrap integration reference](../skills/ntn-skills/references/integration.md) covers Agent use, and [the release procedure](releasing.md) describes distribution.

Consumers should accept additional JSON fields and treat unfamiliar error codes as structured failures. Existing fields and successful operations keep their documented meaning within patch releases. A 0.x minor release may make breaking changes, with migration guidance in this reference and [CHANGELOG](../CHANGELOG.md). See [the compatibility policy](../CONTRIBUTING.md#compatibility-and-deprecation).

`--help` is an offline command-discovery interface. Root help includes workflow, output/exit conventions, authentication, storage and recovery guidance. Command help includes parameter meanings, online/offline behavior, incompatible flags and usage examples. Replace `SNAPSHOT_ID`, `PINNED_REF` and `DATABASE_ID` placeholders before invoking examples. An explicit `--help` takes precedence over validation of other arguments and never executes a command handler. Normal parse failures without `--help` remain one JSON error on stdout.

## Identity and references

```text
skill://<encoded-selector>/<encoded-relative-path>?snapshot=s_<64-hex>
```

Notion Name is 1-64 characters and matches `^[A-Za-z]+(?: [A-Za-z]+)*$`: ASCII English letters with single spaces between words. Lowercasing and replacing each space with `-` yields the invocation name. Each listed `name` holds the Notion display title; `alias` holds the invocation name. For `Release Review`, that name is `release-review`. New online activations require the export's `SKILL.md` frontmatter `name` and root directory to equal the invocation name, including when reusing a cached export. Descriptions and file contents have no English-only restriction.

All target commands (`read`, `files`, `open`, `write`, `export`) accept exact display Name, invocation alias, page ID, Notion page URL, `skill://` ref or snapshot ID. Distinct pages sharing an invocation alias are ambiguous; returned pinned refs use page IDs. Historical snapshots preserve their original identity. Unpinned reads/files/open/exports check current access and export version; pinned refs and snapshot IDs load cached content offline, verify identity and honor an explicit --database constraint. Writes always check current online access; pinned targets provide the immutable version baseline.

All --database flags accept exactly one ID, Notion URL or case-sensitive exact registered alias. IDs/URLs take priority; titles never implicitly select databases. Unknown aliases return DATABASE_NOT_FOUND with registrations as candidates; conflicting mappings return DATABASE_AMBIGUOUS. Online selection validates the selected database and never falls back. Repeated --database values (including identical values and --database=value syntax) return INVALID_ARGUMENT/exit 2 before the handler; explicit help still takes precedence. source add accepts the same selector when registering/renaming a source. config set-default resolves it online and stores a canonical ID. Omitted read selectors discover broadly; the creation default affects create/import only. Pinned read/files/open/export constraints resolve aliases locally and check the cached database_id, so no authentication/network request is introduced.

`read <target> [--path <file>]` defaults to SKILL.md. `files <target> [--path <file-or-directory>]` lists all files when neither the target nor --path supplies a path; a file ref filters its own path. Use `files <snapshot_id>` to list the complete fixed version after a read. A pathless `skill://<selector>` target may use --path; a ref already containing a path rejects --path. `read relative-path --from containing-file-ref` resolves from that file's directory, preserves its snapshot and rejects --path or a non-relative target. `resolve` is an optional offline helper. Query strings accept only one snapshot; malformed encoding, unsupported parameters, absolute paths, backslashes, NUL bytes and traversal escaping the Skill root fail. There is no --snapshot mode or second positional file path.

## Success

```json
{
  "ok": true,
  "skill": {"id": "page-id", "name": "Display Name", "alias": "display-name", "description": "When to use", "database_id": "db-id", "data_source_id": "ds-id", "ref": "skill://page-id/SKILL.md"},
  "snapshot_id": "s_<64-hex>",
  "version_id": "opaque-notion-version",
  "path": "SKILL.md",
  "ref": "skill://page-id/SKILL.md?snapshot=s_<64-hex>",
  "source": "notion",
  "content": "...",
  "range": {"start": 1, "end": 20, "total_lines": 20},
  "has_more": false
}
```

`source=notion` identifies an online read; `source=local_snapshot` identifies a pinned cached read. `list` returns scope, fetched_at, databases, skills, count and coverage without bodies or file manifests. Each databases entry contains database_id, title, alias and data_source_ids; alias is the registered database alias or database ID for unregistered sources. Each Skill retains database_id/data_source_id; its alias is the Skill invocation name. Join database_id to the map. --query filters Skill Name/alias/Description after all pagination and leaves the complete queried database map intact, including empty/no-match databases. coverage.failed_sources identifies id/code plus database_id/alias/title, and data_source_id for row-query failures; registered retrieval failures use the last registered title. Search discovery is not exhaustive; an explicit database can be exhaustive only for its successfully queried sources. --refresh applies to list metadata only. database list returns database maps and discovery coverage without querying Skill rows.

`open` returns snapshot metadata without bodies and is optional. `files` emits file paths, sizes and pinned refs. `read --output` returns output, bytes and reused: exact existing bytes return reused=true, differing output returns OUTPUT_CONFLICT; output is never overwritten. --lines uses inclusive 1-based ranges and is incompatible with output; --raw also rejects output.

Source registrations are stored in `~/.config/ntn-skills/config.json`, with directory precedence `NTN_SKILLS_CONFIG_HOME` > `$XDG_CONFIG_HOME/ntn-skills` > `~/.config/ntn-skills`. `NTN_SKILLS_HOME` controls cached state only. When the new config is absent, reading sources migrates the old state-directory config and retains a `.migrated` backup; existing new configuration wins. Invalid legacy JSON/schema returns `STATE_CORRUPT` without migrating it.

Authentication selects non-empty config.token > non-empty NOTION_API_TOKEN > existing ntn login. `config set-token --stdin` requires piped standard input, trims surrounding whitespace and rejects empty or multiple whitespace-separated values. It saves plaintext in the private configuration file offline without remote validation; use doctor to check access. `config clear-token` removes only config.token offline and restores environment/login fallback. `config show` and configuration-change output omit token and add token_configured, which reports configuration presence only, not validity or environment/login availability. Configuration changes preserve the other fields. Tokens reach ntn through the child environment, never command arguments. Help/version and explicit pinned reads/exports do not require credentials.

Authentication scope hashes user identity, workspace, API endpoint and the selected credential digest (or an ntn-login marker). Different selected tokens separate online metadata/snapshot caches, even for the same user; the same token from config/environment yields the same scope. Older credential-scope formats remain valid for offline pinned reads; obtain a fresh online ref before writing against a snapshot created with an older scope.

## Environment and local storage

| Variable | Contract |
| --- | --- |
| `NTN_SKILLS_NTN_BIN` | Child-process executable, default `ntn`; select a trusted executable |
| `NOTION_API_TOKEN` | Non-empty authentication fallback after configuration token |
| `NTN_SKILLS_CONFIG_HOME` | Full application configuration directory |
| `XDG_CONFIG_HOME` | Base for the `ntn-skills` configuration directory |
| `NTN_SKILLS_HOME` | Full application state directory |
| `XDG_STATE_HOME` | Base for the `ntn-skills` state directory |
| `NOTION_WORKSPACE_ID` | Hashed into authentication scope, default empty, and inherited by `ntn` for workspace selection under its authentication rules |
| `NOTION_API_BASE_URL` | Hashed into authentication scope, default `https://api.notion.com`, and inherited by `ntn api` as its API base URL override |

Both variables isolate cache scopes and reach the `ntn` child process through its inherited environment. Workspace selection follows [official CLI authentication](https://developers.notion.com/cli/get-started/authentication); API routing follows `ntn api --help`. Only use a trusted API endpoint, since `ntn` may send its authentication credential to it. Archive downloads follow signed URLs returned by the service and do not rewrite them using this override.

State defaults to `~/.local/state/ntn-skills`, with `NTN_SKILLS_HOME` taking precedence over `$XDG_STATE_HOME/ntn-skills`. It holds `catalogs`, immutable `snapshots`, content-addressed `objects` and private `uploads` staging. List metadata has a 60-second freshness TTL and `list --refresh` bypasses it. No automatic garbage collection deletes metadata cache files, snapshots, objects or staging when that TTL elapses or an upload completes. Configuration remains separate from state.

The CLI sends no analytics or telemetry requests of its own. Online operations call the selected `ntn` process for Notion authentication/API calls and uploads, and download archives from Notion's signed URLs. This does not attest to `ntn`'s own policies. Local access covers configuration/state, explicitly supplied input paths and requested output destinations. Explicit mutations may upload local inputs; imported scripts are never executed. See [SECURITY](../SECURITY.md) for trust and retention boundaries, and [uninstall guidance](usage.md#upgrade-and-uninstall) for optional cleanup.

## Mutation contract

`config.json` accepts optional sources, default_database and token. `config set-default <ID-or-URL-or-alias>` validates the database online and stores its canonical ID; `config clear-default` works offline; both preserve registrations and token and emit sanitized configuration. `create` and `import` choose --database > configured default > sole freshly discovered Skills Database. Name conflict/reuse/update decisions are scoped to the selected database; the same name in another database does not conflict. Failed configured defaults never fall back. Failed registered sources prevent automatic selection; multiple data sources are rejected.

Create/import share inputs and preservation rules: one ZIP, folder or .md/.markdown file. A portable manifest selects metadata/entrypoint; otherwise choose SKILL.md or a unique top-level Markdown after removing one enclosing directory. Any single Markdown filename is the entrypoint. --name/--description override metadata; missing names derive from English filenames and missing descriptions require --description. Ordinary frontmatter stays in the body; extra Skill frontmatter and all source bytes/names/nested paths are retained in ntn-skills-source.zip. Imported page IDs never select a target. ZIP input max 32 MiB compressed; expanded/folder max 128 MiB and 10,000 entries. The generated source ZIP fits 20 MiB compressed, 128 MiB and 10,000 entries including its manifest. Unsafe/duplicate/reserved paths, links, special files, unsupported ZIP forms and checksum failures fail before mutation.

Both commands freshly query the selected database by invocation alias. Multiple matches return SKILL_AMBIGUOUS. Create rejects any existing name with CREATE_CONFLICT. Import creates an absent name, reuses identical portable content, or overwrites different content on the existing page. Overwrite replaces the body, metadata and complete file set while retaining page identity; obsolete logical files disappear from the current version. The digest hashes display Name, Description, main path and sorted path/SHA-256 pairs. Import captures a fresh baseline and checks it before the first mutation and again before committing uploaded files. Name/version checks are client preflight checks without a server-side uniqueness or atomic commit guarantee.

`write <target> [--path <file>] --input <local-file>` replaces one logical file, default SKILL.md, and preserves the other files. A pinned ref or snapshot ID is a baseline, never a mutable snapshot destination; stale remote versions return WRITE_CONFLICT. SKILL.md requires name/description and checks system-owned notion_page_id against the target. Extra frontmatter is preserved. Nested paths and binary bytes are stored in the source ZIP. Reserved portability files cannot be written directly. Identical original source or current SKILL.md bytes return action=unchanged, unchanged=true and the existing pinned ref without mutation/upload. Upload staging remains private under uploads/<sha256>/<filename>.

Successful create/import/write returns snapshot metadata, operation, action, verified=true, content_id and pinned refs. Create/import add input_type, main_path and reused; actions are create, reuse or update. Writes add path, previous_version_id and unchanged. --dry-run performs the same preflight reads and reports the decision with dry_run=true but never uploads or mutates. Reuse/unchanged results retain the current snapshot. Historical snapshots remain immutable.

New pages create properties first, then non-empty Markdown to preserve initial H1 headings; updated pages replace the old Markdown and retain their ID. Source ZIPs record the normalized body/name/description projection before attachment. Verification compares properties, page readback, exported body, uploaded bundle hashes and complete portable content identity. Endpoint paragraph spacing and equivalent plain-text code labels are normalized; fenced-code blank lines remain literal. Insert/Update and Read content are required for mutation/uploads/verification. Dry runs cannot prove service acceptance. ntn 0.22.12 sometimes emits an API failure only on stderr; such mutation outcomes remain WRITE_OUTCOME_UNKNOWN.

Version checks are client preflight checks, not an atomic compare-and-swap. Body and property requests are separate operations. There is no automatic rollback or retry of mutation requests. `WRITE_PARTIAL` reports page/database, stage, completed operations and cause; `WRITE_OUTCOME_UNKNOWN` requires readback before retrying because the request may have succeeded. Creation without a returned ID after an uncertain response requires inspecting the target database before creating again.


## Portable export contract

`export <name-or-page-or-ref-or-snapshot> --output <path> [--format zip|directory]` exports every file plus `.ntn-skills.json`. The suffix `.zip` selects ZIP by default; other paths select a directory. Cached snapshot IDs and pinned refs are offline. Unpinned selectors obtain the current Skill through normal access checks. Export never mutates Notion.

The manifest contains format="ntn-skills", version=1, display name, description and main path. It adds no page/version IDs, snapshot IDs or timestamps. `.ntn-skills.json` and `ntn-skills-source.zip` are reserved paths. Source ZIPs additionally record the normalized remote body/name/description projection; that internal projection is omitted from portable exports. Original source bytes are retained while the current projection matches. A changed body or metadata regenerates only the main file with canonical frontmatter, preserving extra fields and excluding notion_page_id. Other current snapshot files override preserved supporting files. Native Skills use canonical SKILL.md plus their exported attachments. Import expands the retained source ZIP for nested reads without replacing the server SKILL.md.

ZIP entries sort by path and use fixed timestamps/compression. Identical content yields identical ZIP bytes across different page identities. ZIP output uses the 20 MiB direct-upload bound; portable content is limited to 128 MiB and 10,000 entries including the manifest. Preserve the manifest when reimporting to retain arbitrary main filenames and display-title casing. An identical existing ZIP/directory returns reused=true; any differing files/content return OUTPUT_CONFLICT without overwrite. A successful export returns operation=export, format, output, reused, content_id, main_path and files with byte counts, alongside snapshot metadata. Verification hashes every cached object before output.

## Errors

```json
{"ok":false,"error":{"code":"SKILL_AMBIGUOUS","message":"Multiple skills match; use a page ID or --database.","details":{"selector":"Display Name","candidates":[],"databases":[]}}}
```

| Code | Consumer action |
| --- | --- |
| `SKILL_NOT_FOUND` | Read coverage; broaden metadata search or specify a known database/page ID |
| `SKILL_AMBIGUOUS` | Use candidate database_id and details.databases to select a database alias, or choose a returned page ID |
| `INVALID_SKILL_NAME` | Correct the Notion Name on the page identified in details; use English letters and single spaces, at most 64 characters |
| `CATALOG_INCOMPLETE` | Resolve failed sources; do not infer uniqueness from partial results |
| `AUTH_REQUIRED`, `ACCESS_DENIED` | Check the selected credential: config.token > NOTION_API_TOKEN > existing ntn login. Clear a stale config token to restore fallback; the CLI never starts login |
| `NTN_UNAVAILABLE`, `NOTION_REQUEST_FAILED`, `RATE_LIMITED` | Check ntn/runtime/API availability; errors do not activate skill content |
| `SNAPSHOT_MISSING` | Obtain the current snapshot online; arbitrary historical versions cannot be downloaded |
| `SNAPSHOT_CONFLICT` | Use a ref and snapshot for the same skill/version |
| `DATABASE_NOT_FOUND`, `DATABASE_AMBIGUOUS` | Use an exact registered alias or database ID/URL; inspect candidates. With no creation selector, configure a default or select one database |
| `IMPORT_AMBIGUOUS` | Provide SKILL.md, a portable manifest or only one top-level Markdown entrypoint |
| `CREATE_CONFLICT` | Use import to replace an existing Skill, or select a new name |
| `OUTPUT_CONFLICT` | Select a new destination; existing export output differs |
| `WRITE_CONFLICT` | Read the current Skill and rebuild the edit against its new pinned ref |
| `WRITE_PARTIAL`, `WRITE_OUTCOME_UNKNOWN` | Inspect completed stages and read back the target before retrying |
| `MARKDOWN_INCOMPLETE` | Resolve truncated/unsupported page content before writing |
| `INPUT_FAILED`, `INVALID_INPUT`, `FILE_TOO_LARGE` | Correct the local file/directory or upload size |
| `FILE_NOT_FOUND` | Inspect the snapshot's file list |
| `BINARY_FILE` | Use `--output` and an appropriate host viewer |
| `INVALID_REF`, `INVALID_PATH`, `INVALID_RANGE`, `INVALID_ARGUMENT` | Correct the request |
| `INVALID_ARCHIVE`, `INVALID_SKILL`, `ARCHIVE_TOO_LARGE` | Fix the export/import input or metadata and size limits; provide missing import metadata with --name/--description |
| `STATE_CORRUPT`, `STORAGE_ERROR`, `OUTPUT_FAILED` | Inspect local storage or select a new output filename |
| `INTERNAL_ERROR` | Report a reproducible implementation failure with sanitized context |

Exit codes: 0 success, 1 operational failure, 2 CLI argument failure. There is no TTY-dependent choice of output protocol. No signed URLs or credentials appear in the protocol.

The ntn transport spaces requests by at least 350 ms. Read/query requests retry `rate_limited` up to three times, waiting 1, 2 and 4 seconds; mutation requests are not retried. The current ntn JSON interface does not expose Retry-After. Each child process is scoped and has a 60-second timeout; timeouts for writes produce an unknown outcome rather than proof of failure.
