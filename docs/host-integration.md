# Host integration

Start with [installation and Quick start](../README.md#installation) before configuring a host. Version 0.1.0 is experimental; [the compatibility policy](../CONTRIBUTING.md#compatibility-and-deprecation) and [changelog](../CHANGELOG.md) describe consumer expectations. This document defines an adapter contract, not a claim that adapters have been installed in other applications.

## Portable shell integration

The host needs Node.js 22.19.0 or newer on PATH to launch the installed `ntn-skills` executable. Install the built package with npm using [the consumer installation instructions](../README.md#installation); online operations also need the official `ntn` CLI. Bun belongs to the repository's development/build path.

Install `skills/ntn-skills` in the host's supported local skill directory. Add this instruction when the host needs a broad remote-library trigger:

> When a task may benefit from a workflow in the Notion skill library, use the ntn-skills bootstrap Skill to discover applicable workflows before choosing one. Read metadata first, then only the selected workflow's files.

The bootstrap Skill can call `ntn-skills read skill://...` through a shell tool. It cannot add a protocol handler to a built-in Read tool.

Global configuration defaults to `~/.config/ntn-skills/config.json`; set `NTN_SKILLS_CONFIG_HOME` to isolate a host's configuration. `XDG_CONFIG_HOME` is also supported. Authentication selects config.token > non-empty NOTION_API_TOKEN > existing ntn login; a shared config token overrides a host's environment credential. Pass the token to `config set-token --stdin` through a stdin pipe, never arguments, and do not log the input. `config clear-token` restores environment/login fallback; config output exposes only token_configured, not the credential or its validity. Cached snapshots remain under the state directory selected by `NTN_SKILLS_HOME` or `XDG_STATE_HOME`. Set both application overrides when isolating separate host identities. See [the authentication contract](protocol.md#success) for cache scope and offline behavior.

`NTN_SKILLS_NTN_BIN` selects the official CLI executable (default `ntn`). `NOTION_WORKSPACE_ID` and `NOTION_API_BASE_URL` enter the authentication scope and are inherited by `ntn`; its authentication rules govern workspace selection, and `ntn api` honors the API base URL override. Use a trusted executable and endpoint, since authenticated API requests may reach that endpoint. Signed archive downloads follow the service's returned URLs independently. See [the environment contract](protocol.md#environment-and-local-storage).

The CLI sends no analytics requests of its own. Online calls use `ntn` and signed Notion export downloads; this does not attest to `ntn`'s own privacy behavior. Local access covers application configuration/state, explicit inputs and requested outputs. Hosts should disclose that snapshots and `uploads` staging contain private Skill or input bytes and have no automatic garbage collection. The 60-second metadata TTL controls freshness only. Uninstalling the package leaves local data in place; use [the cleanup guidance](usage.md#upgrade-and-uninstall) and [security policy](../SECURITY.md) to decide what to retain.

## Startup metadata integration

A startup hook runs ntn-skills list and injects Skill name/description/ID/alias/ref metadata together with the databases map. Join Skill database_id to database title/alias; keep these separate from the Skill invocation alias. The command paginates automatically and returns databases/skills/count/coverage without bodies or file manifests. --query filters Skill Name/alias/Description and retains the full queried database map; --refresh bypasses the list cache. Preserve coverage, including failed_sources database_id/alias/title/data_source_id: empty search does not prove an empty workspace. Use database list for discovery without Skill row queries. Hosts must retain both candidates when different databases contain the same invocation name, then choose by database scope or page-ID ref instead of overwriting entries in a name-only map.

Each listed `name` is the English Notion display title; `alias` is its lowercase form with spaces replaced by hyphens. Use this invocation name when exposing a skill to the host. The CLI validates the title and requires matching export frontmatter on online activation. Propagate `INVALID_SKILL_NAME` and `INVALID_SKILL` instead of synthesizing a different name.

On activation, call `ntn-skills read <ref>` with an actual ref returned by list. Require `ok: true` and retain `content`, `source`, the pinned `ref`, `snapshot_id` and `version_id`. Metadata lets the Agent choose a workflow before loading its instructions. Activation fixes a complete exported version locally, so a later Notion edit cannot change an attachment halfway through the task. List every file with `["files", snapshot_id]`; passing the pinned file ref filters only that file. Follow returned attachment refs through that same snapshot; pinned reads use `source: "local_snapshot"`. If metadata changes after injection, the online activation is authoritative and may fail or obtain a newer version. List metadata is cached for 60 seconds; use --refresh when explicitly requested. See [the full read walkthrough](../README.md#quick-start).

All --database flags accept one ID, URL or exact case-sensitive registered alias. Register domains with source add frontend --database DATABASE_ID, then invoke ["read", name, "--database", "frontend"]. Database titles are display labels only. Repeated --database values return INVALID_ARGUMENT before online access/mutation. config set-default accepts the same selector but stores its ID and affects create/import only. Pinned requests with an alias constraint resolve it locally and enforce cached database ownership. See [database selection](protocol.md#identity-and-references).

## Built-in Read protocol integration

An adapter implements the host's URI dispatch contract:

1. Accept only `skill://` requests owned by this adapter. A host already using this scheme must make routing explicit; do not override its existing local skill handler.
2. Invoke the executable with an argument array: `["read", uri]`. No shell interpolation.
3. Parse stdout as JSON and honor both `ok` and exit status.
4. Return `content`, `path`, `ref`, `snapshot_id`, `version_id`, `source`, `range`, and `has_more` to the Agent. Accept additional JSON fields and propagate unfamiliar error codes as failures.
5. Persist the returned snapshot in the host's activation state. Subsequent relative reads must use pinned refs or pass `--from` with the pinned containing-file ref.
6. Forward errors as tool failures, including candidate IDs and coverage. Never turn errors into an empty skill document.
7. Handle binary assets through --output and a host viewer. Identical existing bytes return reused=true; differing output fails with OUTPUT_CONFLICT. Never execute imported scripts automatically.

The CLI accepts `--lines` to implement ranged text reads, and `resolve` to preserve versions while resolving relative references. An adapter should not reimplement name matching or path normalization.

## Explicit write integration

For authorized Skill maintenance, invoke `["write", uri, "--input", localFile]` with an argument array. Use the ref returned by read as the version baseline. A successful write returns a new snapshot; adopt it explicitly for subsequent work and preserve the old activation snapshot for tasks already using it. Do not route host Write requests to local snapshot objects. CLI support for skill:// writes does not register a built-in Write adapter.

Use --dry-run to report the concrete target/action. Propagate CREATE_CONFLICT, WRITE_CONFLICT, WRITE_PARTIAL and WRITE_OUTCOME_UNKNOWN with details; uncertain responses must not trigger automatic retries. Create/import select --database > configured default > sole discovered database. Both accept ZIP/folder/Markdown and --name/--description overrides, preserving original bytes, extra frontmatter and nested paths. Create rejects existing names. Import creates absent names, reuses identical content, or replaces differing content on the same page including its whole file set. Success returns action/content_id/reused and pinned snapshot metadata. Write targets include refs and snapshot IDs as version baselines; unchanged input returns unchanged=true with no mutation. See [the mutation contract](protocol.md#mutation-contract).

For complete portable output, invoke ["export", selector, "--output", localPath], optionally adding --format zip or directory. A pinned ref or snapshot ID exports offline; other selectors obtain the current version online. Preserve .ntn-skills.json for reimport. Propagate OUTPUT_CONFLICT; identical destinations return reused=true. Export never mutates Notion. See [the portable contract](protocol.md#portable-export-contract) for exact-byte source preservation, current edits and deterministic ZIPs.


This repository ships the portable Skill, CLI, and adapter contract. It does not register adapters into unrelated Agent applications or alter their global configuration.

The [bootstrap Skill integration reference](../skills/ntn-skills/references/integration.md) follows the same contract. Package maintenance and publishing use [the release procedure](releasing.md).
