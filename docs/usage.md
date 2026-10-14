# Usage guide

Start with [English](../README.md#quick-start) or [简体中文](../README.zh-CN.md#快速开始) for the first successful read. This guide covers installation variants and everyday operations. The [protocol](protocol.md) owns exact command, response and storage semantics; the [documentation index](README.md) routes to host integration and publishing.

## Installation options

Install [Node.js 22.19.0 or newer](https://nodejs.org), including npm. Online use also needs the [official Notion CLI](https://developers.notion.com/cli). [Source builds](../CONTRIBUTING.md#development-setup) use Bun 1.4.3.

### Install from npm globally

Install from the official registry:

```bash
npm install --global ntn-skills --registry https://registry.npmjs.org
ntn-skills --help
```

On Unix, npm installs global executables under `$(npm prefix --global)/bin`; ensure that directory is on PATH. If it is missing, add it to your shell configuration:

```bash
export PATH="$(npm prefix --global)/bin:$PATH"
```

### Install a local tarball globally

For an offline or unpublished build, replace the archive path with the file supplied by a maintainer:

```bash
npm install --global /absolute/path/ntn-skills-VERSION.tgz
ntn-skills --help
```

The filename follows the package version. Global PATH setup is the same as for registry installation.

### Install in a consuming project

From the consuming project's root:

```bash
npm install ntn-skills --registry https://registry.npmjs.org
export PATH="$PWD/node_modules/.bin:$PATH"
ntn-skills --help
```

This consumes the built package with Node.js. Global and project-local installs use the same package boundary. Build and pack steps belong to [Contributing](../CONTRIBUTING.md#development-setup).

To pin a published version, use `ntn-skills@VERSION`. To consume a local tarball instead, replace the package name with its absolute archive path.

## Authentication

Authentication priority is non-empty `config.token` → non-empty `NOTION_API_TOKEN` → existing `ntn login`. Configure `ntn` through [its authentication guide](https://developers.notion.com/cli/get-started/authentication), or pipe one token from a trusted secret source into `ntn-skills config set-token --stdin`. Never place a token in a command argument or a report.

The saved token is plaintext in the private configuration file. `set-token` works offline and validates input shape, not remote access. `config show` exposes `token_configured` and omits the token. Check access with `doctor`. Remove a saved token with `config clear-token` to restore environment/login fallback. Both commands preserve sources and the default database. The CLI never starts login or reads `ntn`'s private credential files.

Read content and an accessible database with rich-text Description/References are sufficient for page-based reads. Existing native Skills databases use the Skills export API when References is absent. Mutations require Insert/Update content; uploads additionally require a Files property. `doctor` reads and caches one available Skill and reports skill_read.storage.

Eligible cached reads require a locally distinguishable credential/workspace/endpoint scope. With existing official `ntn login`, the CLI may need online identity validation even for an otherwise warm read; unpinned `--offline` lookup fails when scope cannot be determined safely. Explicit pinned snapshots remain offline and can outlive remote permission. Never infer current authorization from cached bytes.

## Discovery and identity

Default discovery paginates Notion Search and accepts native Skills databases or data sources with rich-text Description and References. Registered sources supplement Search. Search is eventually consistent and [does not guarantee exhaustive enumeration](https://developers.notion.com/reference/search-optimizations-and-limitations). A missing result means absent from the discovered scope, not necessarily from the workspace.

Replace database placeholders before running:

```bash
ntn-skills source add frontend --database 'FRONTEND_DATABASE_ID_OR_URL'
ntn-skills source add ops --database 'OPS_DATABASE_ID_OR_URL'
ntn-skills database list
ntn-skills list --database frontend
ntn-skills read 'Release Review' --database ops
ntn-skills source list
ntn-skills list --refresh
```

Every `--database` accepts one ID, Notion URL or exact registered alias. Aliases are case-sensitive; database titles are display labels. Repeated selectors fail even when identical, and an inaccessible selection never falls back. `config set-default 'frontend'` stores the canonical ID and affects creation/import only. Omitting a selector for reads still discovers all visible and registered sources. Pinned reads with alias constraints resolve registrations locally and check the cached database ownership.

`list --query` filters Name, invocation alias and Description after pagination. It returns metadata plus the full queried `databases` map and `coverage`; bodies and file manifests are excluded. Join each Skill's `database_id` to that map. A Skill's invocation alias and its database's registered alias have different meanings. `database list` discovers databases without querying Skill rows. No custom Status field is assumed or silently filtered. Catalog observations default to 60 seconds; `list --refresh` validates online, and `--offline` deliberately uses an eligible stored catalog without upgrading its coverage.

Notion Names use ASCII English letters with single spaces, no surrounding spaces, and at most 64 characters. Lowercasing and replacing spaces with hyphens yields the invocation name: `Release Review` → `release-review`. References mode generates matching frontmatter from properties; native exports must have matching root/frontmatter names. Description and contents may use any language. Name lookup accepts exact display titles or invocation names; page IDs and page URLs select a specific Skill. Same-name collisions return `SKILL_AMBIGUOUS`; failed discovery prevents proving name uniqueness and returns `CATALOG_INCOMPLETE`. [Identity and selector contract](protocol.md#identity-and-references).

## Reading a fixed version

An unpinned read selects a complete snapshot from a recent eligible observation or validates online and saves it locally, while emitting only the requested file. The default content age limit is five minutes. Retain `read.ref`, `read.snapshot_id` and `freshness` for the task. Use `files` with the snapshot ID to list every file; a file ref filters only that file.

Replace these placeholders with values returned by `list`, `read` and `files`:

```bash
ntn-skills read 'REF_FROM_LIST'
ntn-skills files 'SNAPSHOT_ID_FROM_READ'
ntn-skills read 'ATTACHMENT_REF_FROM_FILES'
```

For a relative file, resolve from the containing file's pinned ref:

```bash
ntn-skills read reference.md --from 'PINNED_CONTAINING_FILE_REF'
```

That relative file must exist in the snapshot. `read --lines 10-30` uses inclusive, 1-based lines and reports `range` and `has_more`. `--raw` emits successful UTF-8 text; failures remain JSON. Binary files require `--output ./attachment.bin`. Identical output is reused with `reused=true`; different existing output returns `OUTPUT_CONFLICT` without overwrite. Scripts are never executed.

`read`, `open`, `files`, `export` and `list` accept one of `--refresh`, `--offline` or `--max-age DURATION`; the flags are mutually exclusive. `--refresh` validates online regardless of age, `--offline` uses only eligible local observations even when expired, and `--max-age 30s` overrides the invocation's age limit (`0` requires validation). Expired ordinary reads wait for validation and fail on validation error; there is no automatic stale fallback. A hit never moves `validated_at`.

```bash
ntn-skills read 'REF_FROM_LIST' --refresh
ntn-skills open 'CURRENT_PAGE_ID' --max-age 30s
ntn-skills files 'CURRENT_PAGE_ID' --offline
```

JSON reports `source=notion` for online validation, `local_cache` for an unpinned observation, and `local_snapshot` for an explicitly pinned version. Preserve `freshness` (policy, validation time, age, effective limit and stale status) when deciding whether the observation is suitable. Pinned reads, including relative reads with pinned `--from`, work offline; `--offline` is redundant, while `--refresh` and `--max-age` are invalid. A pinned version makes no latest-remote freshness claim. Historical snapshots must already exist on this machine. `open` returns metadata/file refs without contents. `--raw` omits JSON freshness fields. [Response contract](protocol.md#success).

## References pages

Create a rich-text `References` property alongside `Description`. Add page mentions or links; whitespace separators are allowed. Link labels ending in `.md` specify a filename, including `references/subdirectory/guide.md`. Other labels use the referenced page's title, normalized into a lowercase filename. Chinese titles are supported. Duplicate paths fail with REFERENCE_PATH_CONFLICT; inaccessible or incomplete pages fail the read rather than producing a partial skill.

Every listed page is materialized under `references/`. The property is the complete inclusion list: additional pages linked in the body stay online links until added to References. Markdown links, Notion page mentions and bare Notion URLs to included pages become relative paths; code examples and unrelated external links remain unchanged. Reference-page changes participate in version checks even if the main page is untouched. Pinned reads and exports remain offline.

Create/import write `references/**/*.md` as child pages, allocate all pages before rewriting links, and update References with their paths. Write updates an existing reference page or adds a new one. Import replaces the inclusion list; omitted pages remain in Notion but disappear from the current skill file set. Child-page blocks are retained during body updates. Non-reference assets and exact source bytes use the optional Files source bundle. Without Files, only the main Markdown and reference Markdown are accepted; source formatting/frontmatter is normalized. Keep Files for reversible arbitrary-file imports.


## Creating, importing, exporting and updating skills

Select a database explicitly, save a creation default, or let the CLI use the sole discovered skill database. The order is `--database` → `config.default_database` → sole fresh discovery. Multiple databases, failed registered sources or an inaccessible configured default require a valid selection. `config clear-default` removes the preference offline; it does not change read scope.

After registering `ops`, replace the pinned-ref placeholder with a ref returned by `read`:

```bash
ntn-skills config set-default ops
ntn-skills config show
ntn-skills create ./my-skill --dry-run
ntn-skills create ./my-skill
ntn-skills import ./my-skill.zip --dry-run
ntn-skills import ./my-skill.zip
ntn-skills import ./workflow.md --name 'My Workflow' --description 'When to use this workflow'
ntn-skills export 'My Workflow' --output ./my-workflow.zip
ntn-skills export 'PINNED_REF_FROM_READ' --output ./my-workflow
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md --dry-run
ntn-skills write 'PINNED_REF_FROM_READ' --input ./SKILL.md
```

`create` and `import` accept one ZIP, folder or `.md`/`.markdown` file. A portable `.ntn-skills.json` manifest selects metadata and entrypoint. Other folder/ZIP inputs use `SKILL.md` or a unique top-level Markdown after wrapper removal; ambiguous inputs fail. A single Markdown input supplies the body regardless of filename. `--name` and `--description` override metadata. Optional Files preserves extra frontmatter, original bytes, filenames and nested supporting files in a source ZIP; without it main/reference Markdown follows [the page normalization rules](#references-pages). Imported page IDs do not select a target.

`create` rejects an existing invocation name with `CREATE_CONFLICT`. `import` creates when absent, reuses identical content, or replaces a same-name Skill's body, metadata and whole file set while keeping its page ID. Both decisions are scoped to the selected database. `--dry-run` reports create/reuse/update without uploading or mutating.

`import INPUT --target TARGET` replaces a selected existing page instead of selecting by imported name. Use a current selector or a pinned main-file ref/snapshot as the expected-version baseline; a reference-file target is invalid. Name/description overrides can rename that page without changing its ID. `--database` constrains the target rather than redirecting it through a creation default. Missing/inaccessible targets fail with no create or same-name fallback; stale pinned targets return `WRITE_CONFLICT`. Preview with `--dry-run`, then reuse the exact target within authorization.

```bash
ntn-skills import ./renamed-skill --target 'PINNED_MAIN_REF_FROM_READ' --database ops --dry-run
ntn-skills import ./renamed-skill --target 'PINNED_MAIN_REF_FROM_READ' --database ops
ntn-skills read 'TARGET_PAGE_ID' --database ops --refresh
```

`write` replaces one logical file and retains the others. A target ref with a file path cannot combine with `--path`. Pinned refs and snapshot IDs provide an online version baseline; stale versions return `WRITE_CONFLICT`. Identical input returns `unchanged=true` without uploading or mutating. Updated `SKILL.md` name/description also update the page properties. If `notion_page_id` is present, it must match the target.

`export` writes every file plus the portable manifest. `.zip` selects ZIP; other paths select a directory; `--format zip|directory` overrides that choice. Pinned exports work offline. Preserve the manifest for reimport. ZIP bytes are deterministic; differing existing output fails rather than overwriting. [Portable format and source preservation](protocol.md#portable-export-contract).

ZIP input is limited to 32 MiB compressed, 128 MiB expanded and 10,000 entries; folders use the expanded/entry limits. Generated source ZIPs and portable ZIP output must fit 20 MiB compressed. Unsafe paths, links, special files, duplicates and checksum failures are rejected. Notion read-export archives use gzip/tar and are separate from local import inputs.

Successful changes return a verified snapshot and pinned refs. Body, properties and file uploads are separate requests; client version checks cannot guarantee an atomic transaction or name uniqueness. `WRITE_PARTIAL` and `WRITE_OUTCOME_UNKNOWN` report stage and identities. Inspect the target before retrying. Dry runs do not prove service acceptance. [Mutation contract](protocol.md#mutation-contract) and [error recovery](protocol.md#errors).

After an interrupted reference import, read the current returned page ID with `--refresh`, then explicitly repeat `import` with the same input/database and, if used, the same explicit target to reuse matching child-page IDs. Duplicate child paths fail with `REFERENCE_PATH_CONFLICT`. For transport failures, inspect `details.reason` or nested `cause_details.reason`; raw `ntn` stderr is excluded from CLI JSON.

## Synchronizing local Skills

Bind one existing Notion page to one logical local Skill directory. Labels are local configuration, separate from invocation aliases. Bind resolves the page once; later operations follow its canonical page ID even after rename. It never creates a remote page or chooses a content source implicitly. Equal initial contents can establish a verified baseline; differing contents or an absent ordinary leaf report `needs_initialization`.

Replace page/plan placeholders with actual returned values and choose `--from` only when initializing or deliberately resolving a conflict:

```bash
ntn-skills sync bind PAGE_ID --path ~/.agents/skills/release-review --as release-review-global --dry-run
ntn-skills sync bind PAGE_ID --path ~/.agents/skills/release-review --as release-review-global
ntn-skills sync plan release-review-global --from notion
ntn-skills sync apply --plan PLAN_ID_FROM_INITIALIZATION
ntn-skills sync status release-review-global
ntn-skills sync status release-review-global --refresh
ntn-skills sync plan release-review-global --output ./reviewed-sync-plan.json
ntn-skills sync apply --plan ./reviewed-sync-plan.json
ntn-skills sync plan --all
ntn-skills sync plan release-review-global --from local
ntn-skills sync apply --plan PLAN_ID_FROM_RESOLUTION
ntn-skills sync reconcile release-review-global
ntn-skills sync unbind release-review-global --dry-run
ntn-skills sync unbind release-review-global
```

Status without refresh inspects local content, common baseline and last remote observation only; its comparison is provisional. Refresh updates the observation without advancing a baseline. Plan always reads strongly, persists a state artifact and changes no Skill content/baseline. Exactly one binding or `--all` is required; `--from local|notion` is single-binding only. One-sided changes choose direction from the confirmed baseline; differing two-sided changes stop until an explicit source-selection plan is reviewed. Batch plans reject competing contents for one page and can fan out one accepted update to independent unchanged copies with separate baselines.

Apply accepts the returned plan ID or an identical reviewable JSON copy. It rechecks schema/digest, current registered bindings, scope, baseline generation, remote expected version, local hashes, logical/resolved path and link proof before effects. Editing a copied plan or moving it to another machine does not authorize execution. Only readback-confirmed convergence advances a baseline. There is no global transaction: a later failure can leave earlier verified bindings complete, recorded independently in the receipt. Retain unfinished receipts; they fence affected resources. Reconcile observes actual local/remote results without replaying writes, and advances a baseline only when convergence is proved. It reports divergence so a new checked plan can be made.

Reconcile unfinished operations before reactivating or relabeling a binding. Recovery accepts an unchanged binding or one unbind that leaves it inactive; rebinding changes its revision and retains the old operation's fence with `SYNC_PLAN_STALE`. [Recovery contract](protocol.md#synchronization).

Logical directory, parent and per-file symlinks are supported and preserved through writes to their final destinations. Changed chains/targets invalidate saved plans, including byte-identical retargets. A missing ordinary leaf under a resolvable parent can initialize from Notion; dangling links/cycles and a missing established root are errors, never deletion intent. Commit-boundary checks cannot promise an atomic filesystem transaction across an external process's link retargeting. Removed/replaced tracked bytes are retained through system Trash; unrelated files survive. Unbind deactivates configuration and retains local/remote content, common bases, plans and recovery receipts. [Authoritative command/output contract](protocol.md).

## Cache policy and cleanup

Content observations default to five minutes (`300000` ms), catalogs to 60 seconds (`60000` ms). Save either or both defaults offline; clearing policy restores built-ins and preserves all other configuration/state. Durations are finite nonnegative integers: `0`, `Ns`, `Nm`, `Nh`, `Nd`; bare nonzero numbers, fractions, negatives and overflow are invalid.

```bash
ntn-skills config set-cache-policy --read-max-age 5m --catalog-max-age 60s
ntn-skills config show
ntn-skills config clear-cache-policy
ntn-skills cache status
ntn-skills cache status PAGE_ID --database ops
ntn-skills cache clear PAGE_ID --database ops --dry-run
ntn-skills cache clear PAGE_ID --database ops
ntn-skills cache clear --all --dry-run
ntn-skills cache clear --all
```

Cache status is offline and reports effective roots and recorded scopes/observations without declaring any stored account current. Targeted clear retires appropriate latest/selector/catalog observations in the selected scope; `--all` retires disposable observations across recorded scopes. Exactly one target or `--all` is required. Unsafe local name/account selection fails instead of guessing; use a page ID and explicit database when needed. Clearing conservatively retires catalogs containing the target rather than fabricating exhaustive coverage. System Trash retention is required and missing support fails explicitly; no permanent deletion is substituted. It never removes immutable snapshots/objects, bindings, common bases, plans, uploads or unfinished receipts, and is not state reset or garbage collection. [Storage contract](protocol.md#environment-and-local-storage).

Clear invalidates the entire selected content/catalog observation batch before moving files. If system Trash is unavailable or fails, it reports an error and leaves unmoved bytes in place; those old observations still cannot serve current reads/status. Refresh to obtain a new current observation. Pinned reads, configuration and sync recovery state remain available. [Retention contract](protocol.md#environment-and-local-storage).

## Commands and output

Run `ntn-skills --help` or `ntn-skills <command> --help` for flags and examples. Help is offline and an explicit `--help` takes precedence without running the command. Normal output is JSON, including errors; help/version are text. Exit status is 0 for success, 1 for operation failure and 2 for invalid arguments. `read --raw` affects successful content only.

The [bootstrap command reference](../skills/ntn-skills/references/commands.md) lists commands and errors. The [protocol](protocol.md) defines exact selectors and result semantics.

## Configuration and storage

Configuration defaults to `~/.config/ntn-skills/config.json`; retained state to `~/.local/state/ntn-skills`; disposable observations to `~/.cache/ntn-skills`. `NTN_SKILLS_CONFIG_HOME`, `NTN_SKILLS_HOME` and `NTN_SKILLS_CACHE_HOME` each name a complete application directory and take priority over `$XDG_CONFIG_HOME/ntn-skills`, `$XDG_STATE_HOME/ntn-skills` and `$XDG_CACHE_HOME/ntn-skills` respectively. Isolate all three when separating hosts or verification runs. [Environment contract](protocol.md#environment-and-local-storage).

When the new configuration is absent, source/list access can migrate the old state-directory configuration, retaining a `.migrated` backup. New configuration wins; invalid legacy configuration fails without migration. Snapshots do not move.

State retains private immutable manifests/content objects, upload staging, sync baselines, plans and receipts, with no automatic garbage collection. Latest/catalog/selector observations belong in cache. On upgrade preserve existing state/config, snapshots/objects and recovery data; rebuild disposable indexes under the cache root. Historical state catalogs cannot establish a fresh current observation or initialize a sync baseline. An empty cache causes online validation rather than state deletion. Older pinned scope formats remain readable offline; obtain a fresh online ref before writing from an older format. Online calls use `ntn` and signed export URLs; the CLI sends no analytics requests of its own. [Security policy](../SECURITY.md).

## Upgrade and uninstall

For a registry installation, repeat the global or project-local npm install command with the desired published version. For a tarball installation, obtain the newer built archive and repeat its install command. Read [the changelog](../CHANGELOG.md) before upgrading across a 0.x minor version. Source updates, builds and packaging follow [Contributing](../CONTRIBUTING.md#development-setup).

Remove a global installation with:

```bash
npm uninstall --global ntn-skills
```

Remove a project dependency in each consuming project with:

```bash
npm uninstall ntn-skills
```

Uninstalling retains all three roots, including historical pinned versions, sync bindings/baselines/plans and unfinished receipts. Before uninstalling, run `ntn-skills config clear-token` to remove a saved token if desired; environment credentials and `ntn` login belong to their tools. Record effective paths with `cache status` and `config show`, stop hosts using them, and retain required pinned versions/recovery evidence before optional reclamation. `cache clear --all` retires only disposable observations to system Trash. Move state/config application directories or legacy backups through system Trash/approved retention only when deliberately retiring that data: removing state makes pinned refs unavailable and loses sync recovery history. No cleanup step permanently deletes content.
