# Commands and recovery

```bash
ntn-skills list [--query text] [--database id-or-url-or-alias] [--refresh | --offline | --max-age duration]
ntn-skills read "Exact Display Name"
ntn-skills read skill://exact-display-name/SKILL.md
ntn-skills open <target>
ntn-skills files <target> [--path directory-or-file]
ntn-skills read <current-target> --refresh
ntn-skills open <current-target> --max-age 30s
ntn-skills files <current-target> --offline
ntn-skills read <snapshot-id> --path references/guide.md
ntn-skills read references/guide.md --from '<pinned-main-ref>'
ntn-skills resolve ../assets/template.md --from '<pinned-reference-ref>'
ntn-skills read '<pinned-ref>' --lines 10-30
ntn-skills read '<pinned-binary-ref>' --output <new-local-path>
ntn-skills config show
ntn-skills config set-default <id-or-url-or-alias>
ntn-skills config clear-default
ntn-skills config set-token --stdin
ntn-skills config clear-token
ntn-skills config set-cache-policy --read-max-age 5m --catalog-max-age 60s
ntn-skills config clear-cache-policy
ntn-skills cache status [target] [--database id-or-url-or-alias]
ntn-skills cache clear <current-target> [--database id-or-url-or-alias] [--dry-run]
ntn-skills cache clear --all [--dry-run]
ntn-skills create <zip-or-folder-or-markdown> [--database id-or-url-or-alias] [--name title] [--description text] [--dry-run]
ntn-skills import ./my-skill.zip [--database id-or-url-or-alias] [--name 'My Skill'] [--description text] [--dry-run]
ntn-skills import ./my-skill [--dry-run]
ntn-skills import ./workflow.md --name 'My Workflow' --description 'When to use this workflow'
ntn-skills import ./renamed-skill --target '<current-page-id-or-pinned-main-ref>' [--database id-or-url-or-alias] [--dry-run]
ntn-skills export 'My Workflow' --output ./my-workflow.zip
ntn-skills export '<pinned-main-ref>' --output ./my-workflow [--format directory]
ntn-skills export <snapshot-id> --output ./my-workflow.zip
ntn-skills write '<pinned-main-ref>' --input ./SKILL.md [--dry-run]
ntn-skills write 'skill://exact-display-name/vocabulary.md' --input ./vocabulary.md
ntn-skills write <snapshot-id> --path references/guide.md --input ./guide.md
ntn-skills database list [--database id-or-url-or-alias]
ntn-skills doctor
ntn-skills sync bind <current-target> --path <logical-directory> [--as label] [--database id-or-url-or-alias] [--dry-run]
ntn-skills sync status [binding] [--refresh]
ntn-skills sync plan <binding> [--from local|notion] [--output ./reviewed-plan.json]
ntn-skills sync plan --all [--output ./reviewed-plan.json]
ntn-skills sync apply --plan <plan-id-or-json-file>
ntn-skills sync reconcile <binding>
ntn-skills sync unbind <binding> [--dry-run]
```

list returns databases/skills/count/coverage and paginates automatically without bodies. Join each Skill database_id to the map (database_id/title/alias/data_source_ids); the Skill alias remains its invocation name. --query filters Skill Name/alias/Description and retains the full queried database map. --database selects one ID/URL/exact case-sensitive registered alias; database titles never select targets and repeated flags fail with INVALID_ARGUMENT/exit 2. Register a domain with source add frontend --database DATABASE_ID, then list --database frontend. Unknown/conflicting aliases return DATABASE_NOT_FOUND/DATABASE_AMBIGUOUS. --refresh bypasses metadata cache. Failed queries retain database_id/alias/title and data_source_id in coverage.failed_sources. database list discovers databases without Skill row queries. Shared read/files/open/write/export targets accept Name, invocation alias, page ID/URL, ref or snapshot ID. Pinned read/files/open/export targets are offline, including local alias constraints; pinned writes are online baselines. --path cannot combine with a target already containing a path; read --from rejects --path.

Use `ntn-skills --help` for workflow, output and authentication guidance, then `ntn-skills <command> --help` for argument meanings, offline modes, flag conflicts and examples. Help runs without credentials. Replace example placeholders with actual returned values; explicit `--help` shows help without running the requested operation.

Authentication: config.token > non-empty NOTION_API_TOKEN > existing ntn login. `config set-token --stdin` must receive one token through piped stdin from a trusted secret source; surrounding whitespace is trimmed and empty/multiple values fail. It saves plaintext in the private config file offline without remote validation, preserving sources/default_database. `clear-token` removes only config.token offline. Configuration output omits the token and adds token_configured for configuration presence only; use doctor to check access. Clear an invalid config token before expecting environment/login fallback. Never put a token in command arguments or logs.

The default successful read is JSON with `ok=true`, content, page identity, snapshot ID, version, pinned ref, and range metadata. `--raw` returns successful text only and should be used only when the caller already keeps version state. Help/version are text; every failure is JSON.

Current-target `read`, `open`, `files`, `export` and `list` accept at most one of `--refresh`, `--offline`, `--max-age DURATION`. Default content/catalog limits are 5m/60s. Refresh validates online, offline intentionally uses eligible local observations even if expired, and max-age overrides the invocation (`0` requires validation). Durations use finite nonnegative integers `0`, `Ns`, `Nm`, `Nh`, `Nd`. Pinned targets and pinned relative --from reject refresh/max-age; redundant offline is allowed. JSON source is notion/local_cache/local_snapshot with freshness metadata; a hit does not update validation time and failed validation does not fall back to stale. Existing official-login identity may require online checking; unpinned offline lookup must fail if scope cannot be selected safely. Writes, sync plans/applies/reconcile and doctor always validate online. [Protocol](../../../docs/protocol.md#success).

Errors have `ok=false`, `error.code`, `error.message`, and optional `error.details`. Exit 1 is an operation failure; exit 2 is invalid CLI input.

- SKILL_AMBIGUOUS: candidates and their owning databases map are under details; scope by database alias or choose a page-ID ref. Do not select the first row or collapse cross-database same-name entries.
- `INVALID_SKILL_NAME`: fix the identified Notion page's Name; allow only English letters with single spaces, no surrounding spaces, and at most 64 characters.
- `INVALID_SKILL`: verify that SKILL.md frontmatter `name` and its export directory equal the lowercase, hyphenated Notion Name.
- `SKILL_NOT_FOUND`: no match in discovered scope. Try a broader list query or --database for a known source.
- `CATALOG_INCOMPLETE`: some queries failed; do not treat a single remaining match as unique.
- `SNAPSHOT_MISSING`: a historical local snapshot is absent. Opening a current skill does not recover an arbitrary historical version.
- `SNAPSHOT_CONFLICT`: the ref and requested snapshot belong to different identities/versions.
- DATABASE_NOT_FOUND, DATABASE_AMBIGUOUS: supply a database ID/URL/exact registered alias, or set config.default_database for creation; inspect candidates and do not select the first one. config set-default saves a canonical ID.
- `IMPORT_AMBIGUOUS`: provide SKILL.md, a portable manifest or one top-level Markdown file.
- `CREATE_CONFLICT`: create requires a new name; use import to replace the existing Skill or supply another --name.
- `OUTPUT_CONFLICT`: choose a new destination; the existing output differs and is never overwritten.
- `INVALID_ARCHIVE`, `ARCHIVE_TOO_LARGE`: fix the ZIP or import size/count limits (32 MiB compressed ZIP, 128 MiB expanded/folder, 10,000 entries); unsafe/duplicate paths, links, special files and checksum failures are rejected.
- `WRITE_CONFLICT`: remote version differs from the pinned baseline; refresh the current target and rebuild the edit.
- `WRITE_PARTIAL`, `WRITE_OUTCOME_UNKNOWN`: inspect details.stage/completed/page_id and refresh the current page before an explicit retry; do not refresh the old pinned ref. For unfinished sync, retain its receipt and reconcile before another apply.
- `MARKDOWN_INCOMPLETE`: truncated or unsupported page Markdown prevents safe writes.
- `INVALID_REFERENCES`, `REFERENCE_PATH_CONFLICT`, `REFERENCE_NOT_FOUND`: fix page links, safe distinct Markdown paths and page access in References.
- `UNSUPPORTED_FILE`: add Files to retain non-reference assets, or submit only main/reference Markdown.
- `INPUT_FAILED`, `INVALID_INPUT`, `FILE_TOO_LARGE`: correct the local input or size (20 MiB per upload).
- `FILE_NOT_FOUND`: inspect files and preserve the actual layout.
- `BINARY_FILE`: use output; do not decode binary content as instructions.
- `AUTH_REQUIRED`, `ACCESS_DENIED`, `NTN_UNAVAILABLE`: diagnose the selected credential and runtime; config.token overrides environment/login credentials. Use config clear-token to restore fallback. Never ask the user to paste credentials into command output or start a login implicitly.
- Transport failures: inspect `details.reason` or nested `cause_details.reason` (`timeout`, `process`, `dns`, `tls`, `network`, `invalid_response`); never request raw stderr that may contain credentials or signed URLs.
- Read/query calls retry transient network and service failures up to three times with 1/2/4-second backoff; mutation calls never retry automatically.
- After readback of an interrupted reference import, repeat the same input/database to reuse matching child-page IDs; duplicate paths fail with `REFERENCE_PATH_CONFLICT`.

Line numbers are inclusive and 1-based. Relative paths resolve from the containing file. Traversal outside the skill root is rejected. Scripts are files; reading them does not authorize execution.

Create/import priority: --database > config.default_database > sole discovered skill database; failed defaults never fall back. Both accept ZIP/folder/Markdown, choose manifest or SKILL.md/unique Markdown and accept --name/--description overrides. References Markdown becomes editable child pages; writes restore Notion page links. Files preserves source bytes, extra frontmatter and other assets in a source ZIP (20 MiB including manifest). Without Files only main/reference Markdown is accepted and export is normalized. Create rejects existing invocation names. Import creates absent names, reuses identical content, or replaces different body/metadata/whole file sets on the existing page. Omitted reference pages remain in Notion but are excluded from new snapshots. Imported page IDs never select the target. Overwrite uses fresh version checks; --dry-run validates the storage mode and reports create/reuse/update without mutation. Write replaces one logical file and keeps others; unchanged bytes return unchanged=true. Pinned refs are online write baselines; child-only edits cause conflicts. Body/properties/files are separate requests; partial/unknown outcomes require readback.

Export accepts names/page IDs/URLs, pinned refs and snapshot IDs. Pinned exports are offline. --output is required; .zip selects ZIP, otherwise a directory, with --format zip|directory available. Output includes .ntn-skills.json, original source names/bytes/paths for unchanged imports, and current remote edits otherwise. Preserve the manifest for reimport. Deterministic ZIPs contain no generated page/version identity or timestamps. ZIP output fits 20 MiB; portable content fits 128 MiB and 10,000 entries including the manifest. Identical existing output returns reused=true; different output fails with OUTPUT_CONFLICT. Success includes content_id, main_path, format, output and files. Reimporting an unchanged export reuses its page.

With `import --target`, select an existing current page or pinned main-version baseline once. Imported name/description changes preserve page ID; --database constrains that target, reference-file targets are rejected, and missing/inaccessible/stale targets fail with no create/name fallback. Imported identity metadata itself never selects the target. [Mutation contract](../../../docs/protocol.md#mutation-contract).

Sync binds canonical page IDs to logical local paths. Equal registration may initialize a baseline; differing or absent ordinary local leaves need explicit source-selection initialization. Plan is a preview with retained digest-protected state; --all checks shared-page candidates and independent baselines. A review copy remains executable only against its registered resources after scope/version/base/hash/link rechecks. Apply advances baselines only after confirmed convergence and persists per-binding/group receipts; reconcile reads outcomes without replay. Unresolved receipts fence affected resources. Logical links are preserved, target drift is rejected, and commit guards cannot promise atomicity against external retargeting. Unbind retains content/bases/plans/receipts; removed/replaced bytes use system Trash. [Workflow](../../../docs/usage.md#synchronizing-local-skills).

Reconcile pending operations before reactivating/relabeling a binding. Recovery permits an unchanged binding or one unbind that leaves it inactive; a later revision returns `SYNC_PLAN_STALE` while retaining the fence. [Recovery contract](../../../docs/protocol.md#synchronization).

Cache status is offline. Clear requires one current target or --all and retires only disposable scoped observations via system Trash, preserving immutable snapshots/objects and all sync state. Missing retention support fails rather than deleting permanently. Config/state/cache roots are separate; isolate all three. Upgrades rebuild disposable cache while retaining pinned/state/config data; uninstall retains all roots. [Policy, cleanup and migration](../../../docs/usage.md#cache-policy-and-cleanup).

Before moving bytes, clear invalidates the entire selected content/catalog batch and rejects its delayed publishers. A retention error preserves unmoved files without making those observations usable again; refresh for a new current observation. Pinned versions and sync recovery remain available. [Retention contract](../../../docs/protocol.md#environment-and-local-storage).
