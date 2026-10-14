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

Notion Name is 1-64 characters and matches `^[A-Za-z]+(?: [A-Za-z]+)*$`: ASCII English letters with single spaces between words. Lowercasing and replacing each space with `-` yields the invocation name. Each listed `name` holds the Notion display title; `alias` holds the invocation name. For `Release Review`, that name is `release-review`. References mode generates matching `SKILL.md` frontmatter from page properties. Native Skills activation requires the export's frontmatter `name` and root directory to equal the invocation name, including cached exports. Descriptions and file contents have no English-only restriction.

All target commands (`read`, `files`, `open`, `write`, `export`) accept exact display Name, invocation alias, page ID, Notion page URL, `skill://` ref or snapshot ID. Distinct pages sharing an invocation alias are ambiguous; returned pinned refs use page IDs. Historical snapshots preserve their original identity. Unpinned reads/files/open/exports reuse complete eligible observations within the configured age limit; an expired or explicitly refreshed request validates current access and the complete page/file version online. Pinned refs and snapshot IDs load immutable cached content offline, verify identity and honor an explicit --database constraint. Writes always check online access; pinned mutation targets provide the expected version baseline.

All --database flags accept exactly one ID, Notion URL or case-sensitive exact registered alias. IDs/URLs take priority; titles never implicitly select databases. Unknown aliases return DATABASE_NOT_FOUND with registrations as candidates; conflicting mappings return DATABASE_AMBIGUOUS. Online selection validates the selected database and never falls back. Repeated --database values (including identical values and --database=value syntax) return INVALID_ARGUMENT/exit 2 before the handler; explicit help still takes precedence. source add accepts the same selector when registering/renaming a source. config set-default resolves it online and stores a canonical ID. Omitted read selectors discover broadly; the creation default affects create/import only. Pinned read/files/open/export constraints resolve aliases locally and check the cached database_id, so no authentication/network request is introduced.

`read <target> [--path <file>]` defaults to SKILL.md. `files <target> [--path <file-or-directory>]` lists all files when neither the target nor --path supplies a path; a file ref filters its own path. Use `files <snapshot_id>` to list the complete fixed version after a read. A pathless `skill://<selector>` target may use --path; a ref already containing a path rejects --path. `read relative-path --from containing-file-ref` resolves from that file's directory, preserves its snapshot and rejects --path or a non-relative target. `resolve` is an optional offline helper. Query strings accept only one snapshot; malformed encoding, unsupported parameters, absolute paths, backslashes, NUL bytes and traversal escaping the Skill root fail. There is no --snapshot mode or second positional file path.

## References pages

A database is discoverable when it is a native Skills database or its data source has rich-text `Description` and `References` properties. References mode takes precedence whenever the Skill page has References; otherwise native Skills use the export endpoint. Page mode needs Read content access and does not require the Skills export API. `doctor` reports `skill_read.storage` as `references` or `native_skills` after reading one available Skill.

`References` is the complete inclusion list of Notion page mentions or page links, with optional whitespace separators. Property items are fully paginated. Link text ending in `.md` specifies a path under `references/`; other labels use the referenced page title, normalized to a lowercase filename. Chinese titles and nested paths are supported. Repeated page IDs are included once. Duplicate paths, unsafe paths, unavailable pages and incomplete Markdown fail rather than silently dropping content. Pages linked only from the body are not automatically included.

Reads materialize the main page as canonical `SKILL.md` and each reference page as UTF-8 Markdown. Links to included pages become relative to the containing file, including links back to SKILL.md; anchors are retained. Markdown links, reference definitions, page mentions and bare URLs are supported. Fenced and inline code, unrelated URLs and links to pages outside the inclusion list remain unchanged. Main-page child-page blocks are excluded from the local body and preserved during replacement.

The version digest covers Name, Description, References property items, every included page's ID/path/Markdown and attachment content hashes. Editing a reference page alone invalidates a pinned write. The resulting complete snapshot is immutable and supports offline reads and exports.

Create/import convert `references/**/*.md` to editable child pages, allocating all page IDs before rewriting forward or cyclic links. References stores labeled paths. Write replaces one reference page or adds a new page; import replaces the complete inclusion list. Omitted pages remain in Notion and are excluded from new snapshots and portable exports, including preserved source bundles. At most 100 reference pages may be submitted per Skill.

`Files` is optional. With Files, the source bundle preserves source bytes, filenames, extra Skill frontmatter and non-reference assets. Without Files, only a main Markdown file and reference Markdown are accepted; export normalizes the main filename to `SKILL.md`, Skill frontmatter and Markdown formatting. Reimport compares normalized page content to allow reuse. `content_id` on successful mutations/reuse identifies the saved portable content, matching export. Keep Files when byte-for-byte source preservation or arbitrary assets are required.

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

`source=notion` identifies online validation, `source=local_cache` an unpinned cached observation, and `source=local_snapshot` an explicitly pinned version. Read/open/files/export/list responses carry `freshness` with policy, `validated_at` (ISO timestamp), `age_ms`, `max_age_ms` and `stale`. Cached hits do not move validation time. Pinned freshness uses policy `pinned` and omits latest-validation fields; snapshot creation is not proof of remote freshness. `list` retains scope, fetched_at, databases, skills, count and coverage without bodies/file manifests. Each database has database_id/title/alias/data_source_ids; Skill aliases remain invocation names. --query filters after pagination and retains the queried database map. Cache freshness never upgrades discovery coverage or suppresses failed_sources.

`open` returns snapshot metadata without bodies and is optional. `files` emits file paths, sizes and pinned refs. `read --output` returns output, bytes and reused: exact existing bytes return reused=true, differing output returns OUTPUT_CONFLICT; output is never overwritten. --lines uses inclusive 1-based ranges and is incompatible with output; --raw also rejects output.

Source registrations are stored in `~/.config/ntn-skills/config.json`, with directory precedence `NTN_SKILLS_CONFIG_HOME` > `$XDG_CONFIG_HOME/ntn-skills` > `~/.config/ntn-skills`. `NTN_SKILLS_HOME` controls cached state only. When the new config is absent, reading sources migrates the old state-directory config and retains a `.migrated` backup; existing new configuration wins. Invalid legacy JSON/schema returns `STATE_CORRUPT` without migrating it.

Authentication selects non-empty config.token > non-empty NOTION_API_TOKEN > existing ntn login. `config set-token --stdin` requires piped standard input, trims surrounding whitespace and rejects empty or multiple whitespace-separated values. It saves plaintext in the private configuration file offline without remote validation; use doctor to check access. `config clear-token` removes only config.token offline and restores environment/login fallback. `config show` and configuration-change output omit token and add token_configured, which reports configuration presence only, not validity or environment/login availability. Configuration changes preserve the other fields. Tokens reach ntn through the child environment, never command arguments. Help/version and explicit pinned reads/exports do not require credentials.

Authentication scope hashes user identity, workspace, API endpoint and the selected credential digest (or an ntn-login marker). Different selected tokens separate online metadata/snapshot caches, even for the same user; the same token from config/environment yields the same scope. Older credential-scope formats remain valid for offline pinned reads; obtain a fresh online ref before writing against a snapshot created with an older scope.

## Read policy and cache management

`read`, `open`, `files`, `export` and `list` accept mutually exclusive `--refresh`, `--offline` and `--max-age DURATION`. Content defaults to 300,000 ms, catalogs to 60,000 ms. Omitted flags reuse an eligible complete observation; otherwise validate online. `--refresh` always validates online. `--offline` reads locally selected observations even when expired and reports their age; missing/unsafe scope fails explicitly. `--max-age 0` forces online validation. Expired online reads wait, and failure neither updates validation time nor returns stale content implicitly. Current caller code requiring fresh readback must pass `--refresh`.

Pinned snapshot IDs/refs, including relative reads from a pinned `--from`, always select one immutable local version. `--offline` is redundant but allowed; `--refresh` and `--max-age` are invalid arguments. Mutation/import/sync plan/apply/reconcile and doctor always validate online and do not accept read-policy shortcuts. `--raw` returns text only, so freshness consumers must use JSON.

Durations accept finite nonnegative integer `0`, `Ns`, `Nm`, `Nh` or `Nd`; nonzero bare numbers, fractions, negatives and overflow return INVALID_ARGUMENT before online work. `config set-cache-policy --read-max-age DURATION --catalog-max-age DURATION` saves at least one supplied default offline, preserving other configuration. `config clear-cache-policy` restores built-in defaults without removing content/state. `config show` includes `effective_cache_policy` in milliseconds and sanitized settings.

Local token identity, workspace and endpoint select a previously verified account scope without network. A different token never reuses another scope, even for the same user. Official-login identity cannot be safely distinguished locally; normal reads still validate it online, and unpinned offline selection returns CACHE_SCOPE_UNAVAILABLE. Name selection requires a complete compatible scoped catalog; ambiguity/failed-source discovery cannot be resolved from arbitrary latest entries. Explicit pinned reads retain their offline behavior.

`cache status [TARGET] [--database SELECTOR]` is offline and returns effective `config_directory`, `state_directory`, `cache_directory`, effective cache policy, recorded scopes, observations and catalogs. Without a target it can inspect multiple scopes without identifying one as the current account. `cache clear TARGET [--database SELECTOR] [--dry-run]` or `cache clear --all [--dry-run]` retires only disposable observations through system Trash. Exactly one target or --all is required. Target clearing conservatively retires catalogs that contain the page or cannot prove appropriate complete coverage. Snapshots, objects, bindings, baselines, plans and receipts survive. Missing Trash capability fails explicitly; no permanent-deletion fallback exists.


## Environment and local storage

| Variable | Contract |
| --- | --- |
| `NTN_SKILLS_NTN_BIN` | Child-process executable, default `ntn`; select a trusted executable |
| `NOTION_API_TOKEN` | Non-empty authentication fallback after configuration token |
| `NTN_SKILLS_CONFIG_HOME` | Full application configuration directory |
| `XDG_CONFIG_HOME` | Base for the `ntn-skills` configuration directory |
| `NTN_SKILLS_HOME` | Full application state directory |
| `XDG_STATE_HOME` | Base for the `ntn-skills` state directory |
| `NTN_SKILLS_CACHE_HOME` | Full disposable application-cache directory |
| `XDG_CACHE_HOME` | Base for the `ntn-skills` cache directory |
| `NOTION_WORKSPACE_ID` | Hashed into authentication scope, default empty, and inherited by `ntn` for workspace selection under its authentication rules |
| `NOTION_API_BASE_URL` | Hashed into authentication scope, default `https://api.notion.com`, and inherited by `ntn api` as its API base URL override |

Both variables isolate cache scopes and reach the `ntn` child process through its inherited environment. Workspace selection follows [official CLI authentication](https://developers.notion.com/cli/get-started/authentication); API routing follows `ntn api --help`. Only use a trusted API endpoint, since `ntn` may send its authentication credential to it. Archive downloads follow signed URLs returned by the service and do not rewrite them using this override.

State defaults to `~/.local/state/ntn-skills`, selected by `NTN_SKILLS_HOME` > `$XDG_STATE_HOME/ntn-skills`. It retains immutable `snapshots`, content-addressed `objects`, upload staging and synchronization baselines/plans/receipts. Disposable observation indexes live in `NTN_SKILLS_CACHE_HOME` > `$XDG_CACHE_HOME/ntn-skills` > `~/.cache/ntn-skills`; configuration remains separate. Old state-directory catalogs remain historical data and do not manufacture a fresh current Skill observation. An empty new cache triggers validation; it never removes historical snapshots or initializes a sync baseline. Cache coordination records remain durable across observation retirement so delayed publishers cannot restore cleared data. No automatic garbage collection deletes retained content or staging.

Cache retirement holds the selected observation-generation locks, persists every content/catalog invalidation fence, then starts moving files to system Trash. If retention is unavailable or fails, the command returns an explicit error and preserves unmoved bytes; the fenced observations are still unavailable to current reads/status, and delayed publishers cannot restore them. Immutable pinned reads and sync recovery state remain available. This is not an all-or-nothing filesystem transaction.

The CLI sends no analytics or telemetry requests of its own. Online operations call the selected `ntn` process for authentication/API/uploads and download archives from signed service URLs; this does not attest to `ntn`'s own policies. Local access covers configuration/state/cache, supplied inputs, requested outputs and explicitly bound local Skill destinations. Mutations may upload local inputs; imported scripts are never executed. See [SECURITY](../SECURITY.md) for trust/retention boundaries and [uninstall guidance](usage.md#upgrade-and-uninstall) for cleanup.

## Mutation contract

`config.json` accepts optional sources, default_database, token, cache_policy and sync_bindings. Config operations preserve other settings and never expose token values. `config set-default <ID-or-URL-or-alias>` validates online and saves a canonical ID; `config clear-default` works offline. Create/import without a target choose --database > configured default > sole freshly discovered Skills Database. Name conflict/reuse/update decisions are scoped to that database; failed defaults/sources never fall back and ambiguous data sources require explicit selection.

Create/import share inputs: one ZIP, folder or .md/.markdown file. A portable manifest selects metadata/entrypoint; otherwise choose SKILL.md or a unique top-level Markdown after removing one enclosing directory. Any single Markdown filename is the entrypoint. --name/--description override metadata; missing names derive from English filenames and missing descriptions require --description. Ordinary frontmatter stays in the body. With Files, extra Skill frontmatter and all source bytes/names/nested paths are retained in ntn-skills-source.zip; page-only mode follows [the normalization rules](#references-pages). Imported page IDs never select a target. ZIP input max 32 MiB compressed; expanded/folder max 128 MiB and 10,000 entries. The generated source ZIP fits 20 MiB compressed, 128 MiB and 10,000 entries including its manifest. Unsafe/duplicate/reserved paths, links, special files, unsupported ZIP forms and checksum failures fail before mutation.

Create and import without --target freshly query the selected database by invocation alias. Multiple matches return SKILL_AMBIGUOUS; create rejects an existing invocation with CREATE_CONFLICT. Import creates an absent name, reuses identical portable content, or replaces differing whole-Skill content on the existing page. `import INPUT --target TARGET` resolves one existing page once and never falls back to creation or another name. Current targets capture an online baseline; pinned snapshot/main refs enforce expected version, scope and database ownership. Reference-file targets are rejected. --name/--description change source metadata only; a new imported name does not redirect the page. --database constrains a target rather than choosing a creation default. The same save/References path is used by synchronization. The portable digest hashes display Name, Description, main path and sorted file hashes; page-only reuse follows normalized Markdown equality. Version checks precede the first mutation and uploaded-file commit, without a server-side atomic guarantee.

`write <target> [--path <file>] --input <local-file>` replaces one logical file, default SKILL.md, and preserves the other files. A pinned ref or snapshot ID is a baseline, never a mutable snapshot destination; stale remote versions return WRITE_CONFLICT. SKILL.md requires name/description and checks system-owned notion_page_id against the target. With Files, extra frontmatter, nested paths and binary bytes are preserved in the source ZIP. References paths write their corresponding Notion pages. Reserved portability files cannot be written directly. Identical original source or current SKILL.md bytes return action=unchanged, unchanged=true and the existing pinned ref without mutation/upload. Upload staging remains private under uploads/<sha256>/<filename>.

Successful create/import/write returns snapshot metadata, operation, action, verified=true, content_id and pinned refs. Create/import add input_type, main_path and reused; actions are create, reuse or update. Writes add path, previous_version_id and unchanged. --dry-run performs the same preflight reads and reports the decision with dry_run=true but never uploads or mutates. Reuse/unchanged results retain the current snapshot. Historical snapshots remain immutable.

New pages create properties first, then non-empty Markdown to preserve initial H1 headings; updated pages replace the old Markdown and retain their ID. Source ZIPs record normalized body/name/description and reference-page projections before attachment. Verification compares the saved portable identity with the submitted content; page-only mode compares normalized Markdown. Endpoint paragraph spacing and equivalent plain-text code labels are normalized; fenced-code blank lines remain literal. Insert/Update and Read content are required for mutation/uploads/verification. Dry runs cannot prove service acceptance. ntn 0.22.12 sometimes emits an API failure only on stderr; such mutation outcomes remain WRITE_OUTCOME_UNKNOWN.

Version checks are client preflight checks, not an atomic compare-and-swap. Body and property requests are separate operations. There is no automatic rollback or retry of mutation requests. `WRITE_PARTIAL` reports page/database, stage, completed operations and cause; `WRITE_OUTCOME_UNKNOWN` requires readback before retrying because the request may have succeeded. Creation without a returned ID after an uncertain response requires inspecting the target database before creating again.

Reference imports register each allocated child page before writing its body. After readback, an explicit repeat import also discovers matching Markdown child pages left by an interrupted registration; it reuses their IDs and rejects duplicate paths with REFERENCE_PATH_CONFLICT. Completed bodies are not rewritten. Page-only identity treats equivalent local links such as `references/guide.md` and `./references/guide.md` consistently.



## Portable export contract

`export <name-or-page-or-ref-or-snapshot> --output <path> [--format zip|directory]` writes every portable file plus `.ntn-skills.json`. .zip selects ZIP, other paths directory. Current inputs follow the read policy; fixed refs/snapshot IDs are offline. --refresh/--offline/--max-age select input freshness only, never authorize replacing different output. Export never mutates Notion.

The manifest contains format="ntn-skills", version=1, display name, description and main path. It adds no page/version IDs, snapshot IDs or timestamps. `.ntn-skills.json` and `ntn-skills-source.zip` are reserved paths. Source ZIPs additionally record normalized remote body/name/description and reference-page projections; these internal projections are omitted from portable exports. Original source bytes are retained while their recorded projections match. Changed body/metadata regenerates the main file with canonical frontmatter, preserving extra fields and excluding notion_page_id. Changed reference pages replace their corresponding source files, and removed references are excluded. Native Skills use canonical SKILL.md plus exported attachments. Import expands the retained source ZIP for nested reads. Libraries without Files export normalized page Markdown as described in [References pages](#references-pages).

ZIP entries sort by path and use fixed timestamps/compression. Identical content yields identical ZIP bytes across different page identities. ZIP output uses the 20 MiB direct-upload bound; portable content is limited to 128 MiB and 10,000 entries including the manifest. Preserve the manifest when reimporting to retain arbitrary main filenames and display-title casing. An identical existing ZIP/directory returns reused=true; any differing files/content return OUTPUT_CONFLICT without overwrite. A successful export returns operation=export, format, output, reused, content_id, main_path and files with byte counts, alongside snapshot metadata. Verification hashes every cached object before output.

## Synchronization

`sync bind TARGET --path DIR [--as LABEL] [--database SELECTOR] [--dry-run]` registers one existing current page and an absolute logical local directory. It retains logical spelling and canonical page/database/data-source/scope identities; later operations use page ID. Multiple distributions have independent bindings/baselines. Historical or file targets fail. Label collision requires --as; exact edges reuse their registered label, and a differing supplied --as fails rather than silently relabeling. Different pages targeting one real directory fail before writes. A missing ordinary leaf under a resolvable existing parent permits initial pull; dangling/cyclic links fail. Equal checked contents initialize a baseline; differences require explicit initialization source. Dry-run saves no binding/baseline.

`sync status [BINDING] [--refresh]` returns local/common identities, baseline generation, logical/resolved paths, remote snapshot/version/observation age/staleness and pending receipts. Default uses local state/cache without network and marks comparison provisional. Omitted binding lists active registrations. Refresh validates remote state but never advances the common baseline.

`sync plan BINDING [--from local|notion] [--output JSON_FILE]` or `sync plan --all [--output JSON_FILE]` strongly reads both sides against their common baseline. One-sided changes choose push/pull; equal new content advances the baseline without content writes; differing two-sided changes return SYNC_CONFLICT with a retained non-executable plan. Differing first binds require --from. Explicit source selection is single-binding only and still enforces every saved precondition. No force or TTY conflict choice exists.

Plans persist under `sync/plans/p_<sha256>.json` in state. The digest covers format/version, exact binding configuration, baseline generation/content, expected remote snapshot/version, local hashes, logical/resolved link proofs, source/direction, intended file set and actions. Output contains plan_id/plan_path/applicable/conflicts and per-binding preconditions. --output reuses identical review-copy bytes and rejects differing output. Planning changes no content/common baseline. An exact copied plan must match its registered artifact/configuration; helper import-plan JSON cannot be applied.

`sync apply --plan PLAN_ID_OR_FILE` verifies the artifact and all participants' current binding, base, credential scope, remote version/content, local hashes and target/link proofs before its first content write. Actual preconditions determine validity, not plan age. A page group accepts one candidate; differing local candidates conflict before writes. One verified push can fan out to unchanged independent copies. The remote update reuses the whole-Skill writer, then reads back before local fan-out. Each independently verified convergence advances its own baseline; later runtime failures may leave earlier participants complete.

An operation receipt is durable before effects, with page-group/per-binding stages, baseline generations and retained-byte locations. Apply returns plan_id/operation_id/verified/receipt_path/receipt and binding actions. Partial/unknown outcomes preserve unfinished bases and receipts. Unresolved receipts fence overlapping page/real-target applies. Live process holders are locked out; proven-dead same-host holders can be retired for recovery without dropping receipts. Malformed state fails explicitly, never becomes overwrite permission.

`sync reconcile BINDING` freshly reads both sides without replaying content writes. Recorded intended content and target proofs must agree before closing a receipt and promoting a baseline. Classified divergence retains the old base, returns nonzero and permits deliberate replanning; unsafe/unresolved outcomes retain their fence. Retained inactive bindings remain recoverable. `sync unbind BINDING [--dry-run]` deactivates configuration, invalidates saved applies and retains content/bases/plans/receipts.

Reconcile permits the original binding configuration or one intervening unbind while that binding remains inactive. Reactivating, relabeling or otherwise changing its revision before recovery returns `SYNC_PLAN_STALE` and retains the fence. Reconcile unfinished operations before rebinding; deleting receipts or rebinding does not authorize recovery.

The local writer resolves root, parent, relative/multi-hop directory and per-file links, stages content and commits to final real files while preserving links during updates. Tracked removal retains old bytes through system Trash; unrelated root files survive. Every actual mkdir/rename/retirement boundary checks saved target proofs, including byte-identical link retargets. Node lacks a portable fd-relative path compare-and-swap: a noncooperating editor may retarget after the final guard and before its syscall. Cooperating sync processes are fenced; this is not atomic protection against every external filesystem race. Notion also uses preflight/readback rather than an atomic multi-request commit.


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
| `INVALID_REFERENCES`, `REFERENCE_PATH_CONFLICT`, `REFERENCE_NOT_FOUND` | Fix References page links, distinct safe Markdown paths and page access |
| `UNSUPPORTED_FILE` | Add a Files property to retain non-reference assets, or submit only main/reference Markdown |
| `INPUT_FAILED`, `INVALID_INPUT`, `FILE_TOO_LARGE` | Correct the local file/directory or upload size |
| `FILE_NOT_FOUND` | Inspect the snapshot's file list |
| `BINARY_FILE` | Use `--output` and an appropriate host viewer |
| `INVALID_REF`, `INVALID_PATH`, `INVALID_RANGE`, `INVALID_ARGUMENT` | Correct the request |
| `INVALID_ARCHIVE`, `INVALID_SKILL`, `ARCHIVE_TOO_LARGE` | Fix the export/import input or metadata and size limits; provide missing import metadata with --name/--description |
| `STATE_CORRUPT`, `STORAGE_ERROR`, `OUTPUT_FAILED` | Inspect local storage or select a new output filename |
| `CACHE_MISSING`, `CACHE_SCOPE_UNAVAILABLE` | Refresh an appropriate current target online or use an explicit pinned version; never guess another account |
| `SYNC_BINDING_MISSING`, `SYNC_BINDING_AMBIGUOUS`, `SYNC_BINDING_CONFLICT` | Choose a registered ID/label or use a distinct --as |
| `SYNC_INITIALIZATION_REQUIRED`, `SYNC_CONFLICT`, `SYNC_TARGET_CONFLICT` | Inspect the retained plan and choose a single-binding source or resolve incompatible candidates/targets |
| `SYNC_PLAN_MISSING`, `SYNC_PLAN_STALE`, `SYNC_TARGET_DRIFT` | Observe current identities and generate a new plan without bypassing preconditions |
| `SYNC_PENDING`, `SYNC_DIVERGED` | Run sync reconcile before new applies, retain evidence and replan after outcome classification |
| `SYNC_LOCAL_MISSING`, `LOCAL_MISSING`, `LOCAL_LINK_BROKEN`, `LOCAL_LINK_CYCLE`, `LOCAL_IO_ERROR` | Repair the concrete directory/link/permissions without treating missing data as deletion intent |
| `SYNC_LOCKED`, `RETENTION_UNAVAILABLE`, `RETENTION_FAILED`, `CACHE_RETIRE_UNAVAILABLE` | Resolve ownership or the verified system-Trash prerequisite; preserve retained bytes |
| `INTERNAL_ERROR` | Report a reproducible implementation failure with sanitized context |

Exit codes: 0 success, 1 operational failure, 2 CLI argument failure. There is no TTY-dependent choice of output protocol. No signed URLs or credentials appear in the protocol.

The ntn transport spaces requests by at least 350 ms. Read/query requests retry `rate_limited`, transient service errors and nonzero-exit network/DNS/transport-timeout failures up to three times, waiting 1, 2 and 4 seconds. Authentication, access, validation, TLS, malformed successful responses and mutation requests are not retried. The current ntn JSON interface does not expose Retry-After. Each child process is scoped and has a 60-second timeout; timeouts for writes produce an unknown outcome rather than proof of failure.

Transport failures report only a safe `reason` (`timeout`, `process`, `dns`, `tls`, `network` or `invalid_response`), plus the available exit code and request path. Raw child stderr is never included, since it may contain credentials or signed URLs. Nested mutation errors retain these fields in `cause_details`.

References attachment downloads retry transport/body-stream failures, timeouts and HTTP 429/500/502/503/504 up to three times with 1/2/4-second backoff. Each attempt owns a scoped request with a 60-second timeout. TLS, denied/missing resources and invalid archives are not retried; failures expose only the logical attachment path and safe status/reason, never its signed URL.
