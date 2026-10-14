# Host integration

Start with [installation and Quick start](../README.md#installation) before configuring a host. The 0.x series is experimental; [the compatibility policy](../CONTRIBUTING.md#compatibility-and-deprecation) and [changelog](../CHANGELOG.md) describe consumer expectations. This document defines an adapter contract, not a claim that adapters have been installed in other applications.

## Portable shell integration

The host needs Node.js 22.19.0 or newer on PATH to launch the installed `ntn-skills` executable. Install the built package with npm using [the consumer installation instructions](../README.md#installation); online operations also need the official `ntn` CLI. Bun belongs to the repository's development/build path.

Install `skills/ntn-skills` in the host's supported local skill directory. Add this instruction when the host needs a broad remote-library trigger:

> When a task may benefit from a workflow in the Notion skill library, use the ntn-skills bootstrap Skill to discover applicable workflows before choosing one. Read metadata first, then only the selected workflow's files.

The bootstrap Skill can call `ntn-skills read skill://...` through a shell tool. It cannot add a protocol handler to a built-in Read tool.

Global configuration defaults to `~/.config/ntn-skills/config.json`; retained snapshots/recovery state to `~/.local/state/ntn-skills`; disposable observations to `~/.cache/ntn-skills`. Set `NTN_SKILLS_CONFIG_HOME`, `NTN_SKILLS_HOME` and `NTN_SKILLS_CACHE_HOME` to isolate all three complete application directories; XDG config/state/cache bases are also supported. Authentication selects config.token > non-empty NOTION_API_TOKEN > existing ntn login; a shared config token overrides a host's environment credential. Pass a token to `config set-token --stdin` through a trusted stdin pipe, never arguments/logs. `config clear-token` restores fallback; sanitized config reports token presence, not validity. Separate roots do not isolate official `ntn` login; where local login identity cannot be distinguished safely, current reads validate identity online and unpinned offline lookup fails. [Storage and scope contract](protocol.md#environment-and-local-storage).

`NTN_SKILLS_NTN_BIN` selects the official CLI executable (default `ntn`). `NOTION_WORKSPACE_ID` and `NOTION_API_BASE_URL` enter the authentication scope and are inherited by `ntn`; its authentication rules govern workspace selection, and `ntn api` honors the API base URL override. Use a trusted executable and endpoint, since authenticated API requests may reach that endpoint. Signed archive downloads follow the service's returned URLs independently. See [the environment contract](protocol.md#environment-and-local-storage).

The CLI sends no analytics requests of its own. Online calls use official `ntn` and signed Notion downloads; `ntn` has its own policies. Local access covers configuration/state/cache, explicit inputs and requested outputs. Snapshots, upload staging, sync plans/baselines/receipts contain private bytes and have no automatic garbage collection. Content/catalog freshness defaults are five minutes/60 seconds and do not control retention. Uninstalling leaves all roots in place; preserve pinned versions and unfinished recovery receipts. Cache clearing retires only disposable observations through system Trash. [Cleanup guidance](usage.md#upgrade-and-uninstall) and [security policy](../SECURITY.md).

## Startup metadata integration

A startup hook runs `ntn-skills list` and injects Skill name/description/ID/alias/ref metadata together with the database map, `source`, `freshness`, `fetched_at` and `coverage`. Join database_id to title/domain alias; keep these separate from invocation alias. List paginates without bodies/manifests; `--query` retains the full queried database map. Catalog default age is 60 seconds; use `--refresh` for fresh discovery or intentional `--offline` for cached discovery. Preserve failed_sources identities and incomplete/search-limited coverage. Hosts retain both same-alias pages across databases and select by database scope/page-ID ref rather than a name-only map.

Each listed `name` is the English Notion display title; `alias` is its lowercase form with spaces replaced by hyphens. Use this invocation name when exposing a skill to the host. References mode generates matching frontmatter from properties; native Skills mode validates export frontmatter on online activation. Propagate `INVALID_SKILL_NAME` and `INVALID_SKILL` instead of synthesizing a different name.

On activation, call `ntn-skills read <ref>` with an actual current ref returned by list. Require `ok: true` and retain `content`, `source`, `freshness`, pinned `ref`, `snapshot_id` and `version_id`. Ordinary reads may select content validated within five minutes (`source=local_cache`); use `--refresh` when activation requires current remote access/content (`source=notion`). Hosts must preserve the observation time/age/limit/stale status, not infer freshness from snapshot creation. Once selected, the complete snapshot fixes supporting instructions for the task. List all files with `["files", snapshot_id]` and follow pinned refs (`source=local_snapshot`); pinned versions do not claim latest freshness. Inspecting, summarizing, editing or configuring a Skill does not activate its instructions. Downloaded contents/scripts never execute automatically. [Read walkthrough](usage.md#reading-a-fixed-version).

All --database flags accept one ID, URL or exact case-sensitive registered alias. Register domains with source add frontend --database DATABASE_ID, then invoke ["read", name, "--database", "frontend"]. Database titles are display labels only. Repeated --database values return INVALID_ARGUMENT before online access/mutation. config set-default accepts the same selector but stores its ID and affects create/import only. Pinned requests with an alias constraint resolve it locally and enforce cached database ownership. See [database selection](protocol.md#identity-and-references).

Databases with rich-text Description and References are discoverable alongside native Skills databases. References mode reads page Markdown, materializes included pages under references/, and rewrites Notion page links relative to the containing file. The version includes every reference page, so child-only edits can cause WRITE_CONFLICT. Host adapters use the same commands and pinned refs for either storage mode. See [References pages](protocol.md#references-pages).

## Built-in Read protocol integration

An adapter implements the host's URI dispatch contract:

1. Accept only `skill://` requests owned by this adapter. A host already using this scheme must make routing explicit; do not override its existing local skill handler.
2. Invoke the executable with an argument array: `["read", uri]`. No shell interpolation.
3. Parse stdout as JSON and honor both `ok` and exit status.
4. Return `content`, `path`, `ref`, `snapshot_id`, `version_id`, `source`, `freshness`, `range`, and `has_more` to the Agent. Accept additional JSON fields and propagate unfamiliar error codes as failures.
5. Persist the returned snapshot in the host's activation state. Subsequent relative reads must use pinned refs or pass `--from` with the pinned containing-file ref.
6. Forward errors as tool failures, including candidate IDs and coverage. Never turn errors into an empty skill document.
7. Handle binary assets through --output and a host viewer. Identical existing bytes return reused=true; differing output fails with OUTPUT_CONFLICT. Never execute imported scripts automatically.

The CLI accepts `--lines` to implement ranged text reads, and `resolve` to preserve versions while resolving relative references. An adapter should not reimplement name matching or path normalization.

An adapter may expose one of `--refresh`, `--offline` or `--max-age DURATION` for a current target; the flags are mutually exclusive. Pinned targets or pinned relative `--from` reject refresh/max-age and permit redundant offline. Failed online validation never silently falls back to stale content. A cached observation does not prove current permission; use JSON for freshness metadata rather than raw text. [Read-policy usage](usage.md#reading-a-fixed-version).

## Explicit write integration

For authorized Skill maintenance, invoke `["write", uri, "--input", localFile]` with an argument array. Use the ref returned by read as the version baseline. A successful write returns a new snapshot; adopt it explicitly for subsequent work and preserve the old activation snapshot for tasks already using it. Do not route host Write requests to local snapshot objects. CLI support for skill:// writes does not register a built-in Write adapter.

Use `--dry-run` to report a concrete target/action. Propagate conflicts and partial/unknown results without automatic retries. Create/import without target choose explicit database > configured default > sole fresh discovery. Inputs are ZIP/folder/Markdown; `--name`/`--description` override metadata. `import INPUT --target TARGET` instead selects one existing current page or pinned main-version baseline, preserves page ID through rename and fails without create/name fallback; database is a constraint. Reject reference-file targets. References become editable pages; omitted references remain in Notion. Files preserves original bytes/frontmatter/assets; page-only output is normalized. Success returns verified snapshot metadata. [Mutation contract](protocol.md#mutation-contract).

For portable output, invoke `["export", selector, "--output", localPath]`, optionally with `--format zip|directory`. Pinned selection is offline; current selection uses bounded content policy, with `--refresh` for fresh remote validation. Preserve `.ntn-skills.json` for reimport. Identical destinations return `reused=true`; differing destinations fail with `OUTPUT_CONFLICT`. Export never mutates Notion. [Portable contract](protocol.md#portable-export-contract).

## Explicit local synchronization

Hosts can register a logical distribution directory with `["sync", "bind", pageId, "--path", directory, "--as", label]`. If contents differ or the ordinary local leaf is absent, review a single-binding `sync plan LABEL --from notion|local`, then `sync apply --plan PLAN_ID`. Later `sync plan LABEL` or `sync plan --all` compares each confirmed common baseline. `--output` saves an identical review copy; apply accepts its path and still checks registered binding, plan digest, remote version/scope, baseline generation, local hashes and resolved link proof.

`sync status` is local/provisional unless refreshed; it cannot activate or advance a baseline. Baselines advance only after verified convergence. Preserve operation receipts on interruptions; `sync reconcile LABEL` reads actual outcomes without replay, and affected resources stay fenced while outcome is unresolved. Logical directory/parent/per-file links survive writes to final destinations; link drift rejects a saved plan. Commit-boundary guards do not supply an atomic guarantee against external link retargeting. Removed/replaced bytes require system Trash retention. `sync unbind LABEL` deactivates configuration while retaining content/baselines/plans/receipts. [Workflow and limits](usage.md#synchronizing-local-skills).

Expose offline `cache status` for effective roots/observations and `cache clear TARGET [--database SELECTOR]` or `cache clear --all` with optional `--dry-run`. Clear retires only disposable observations through system Trash; immutable versions and sync state remain. `config set-cache-policy --read-max-age 5m --catalog-max-age 60s` and `config clear-cache-policy` control defaults without changing authentication/sources/bindings. [Cache usage](usage.md#cache-policy-and-cleanup).


This repository ships the portable Skill, CLI, and adapter contract. It does not register adapters into unrelated Agent applications or alter their global configuration.

The [bootstrap Skill integration reference](../skills/ntn-skills/references/integration.md) follows the same contract. Package maintenance and publishing use [the release procedure](releasing.md).
