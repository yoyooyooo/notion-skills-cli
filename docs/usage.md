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

Read content, an enabled Skills API and an accessible typed Skills Database are needed for reads. Mutation and upload verification also require Insert/Update content capabilities. `doctor` checks runtime, authentication, discovery and export capability. A valid connection alone does not prove a Skill is accessible or exportable.

## Discovery and identity

Default discovery paginates Notion Search, accepts only `database_type: "skills"`, queries each discovered data source and deduplicates page IDs. Registered sources supplement Search. Search is eventually consistent and [does not guarantee exhaustive enumeration](https://developers.notion.com/reference/search-optimizations-and-limitations). A missing result means absent from the discovered scope, not necessarily from the workspace.

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

`list --query` filters Name, invocation alias and Description after pagination. It returns metadata plus the full queried `databases` map and `coverage`; bodies and file manifests are excluded. Join each Skill's `database_id` to that map. A Skill's invocation alias and its database's registered alias have different meanings. `database list` discovers databases without querying Skill rows. No custom Status field is assumed or silently filtered. Metadata freshness is 60 seconds; `list --refresh` bypasses it, while online reads check exports independently.

Notion Names use ASCII English letters with single spaces, no surrounding spaces, and at most 64 characters. Lowercasing and replacing spaces with hyphens yields the invocation name: `Release Review` → `release-review`. The export root and `SKILL.md` frontmatter name must match. Description and contents may use any language. Name lookup accepts exact display titles or invocation names; page IDs and page URLs select a specific Skill. Same-name collisions return `SKILL_AMBIGUOUS`; failed discovery prevents proving name uniqueness and returns `CATALOG_INCOMPLETE`. [Identity and selector contract](protocol.md#identity-and-references).

## Reading a fixed version

An unpinned read obtains the current exported version and saves the complete snapshot locally, while emitting only the requested file. Retain `read.ref` and `read.snapshot_id` for the task. Use `files` with the snapshot ID to list every file; a file ref filters only that file.

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

Pinned reads work offline and return `source: "local_snapshot"`. Unpinned reads check current remote access and version before cache reuse. Historical snapshots must already exist on this machine; Notion's current API cannot retrieve arbitrary old export versions. `open` is an optional helper returning metadata and file refs without contents. [Response contract](protocol.md#success).

## Creating, importing, exporting and updating skills

Select a database explicitly, save a creation default, or let the CLI use the sole discovered Skills Database. The order is `--database` → `config.default_database` → sole fresh discovery. Multiple databases, failed registered sources or an inaccessible configured default require a valid selection. `config clear-default` removes the preference offline; it does not change read scope.

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

`create` and `import` accept one ZIP, folder or `.md`/`.markdown` file. A portable `.ntn-skills.json` manifest selects metadata and entrypoint. Other folder/ZIP inputs use `SKILL.md` or a unique top-level Markdown after wrapper removal; ambiguous inputs fail. A single Markdown input supplies the body regardless of filename. `--name` and `--description` override metadata. Extra frontmatter, original bytes, filenames and nested supporting files are retained in a source ZIP. Imported page IDs do not select a target.

`create` rejects an existing invocation name with `CREATE_CONFLICT`. `import` creates when absent, reuses identical content, or replaces a same-name Skill's body, metadata and whole file set while keeping its page ID. Both decisions are scoped to the selected database. `--dry-run` reports create/reuse/update without uploading or mutating.

`write` replaces one logical file and retains the others. A target ref with a file path cannot combine with `--path`. Pinned refs and snapshot IDs provide an online version baseline; stale versions return `WRITE_CONFLICT`. Identical input returns `unchanged=true` without uploading or mutating. Updated `SKILL.md` name/description also update the page properties. If `notion_page_id` is present, it must match the target.

`export` writes every file plus the portable manifest. `.zip` selects ZIP; other paths select a directory; `--format zip|directory` overrides that choice. Pinned exports work offline. Preserve the manifest for reimport. ZIP bytes are deterministic; differing existing output fails rather than overwriting. [Portable format and source preservation](protocol.md#portable-export-contract).

ZIP input is limited to 32 MiB compressed, 128 MiB expanded and 10,000 entries; folders use the expanded/entry limits. Generated source ZIPs and portable ZIP output must fit 20 MiB compressed. Unsafe paths, links, special files, duplicates and checksum failures are rejected. Notion read-export archives use gzip/tar and are separate from local import inputs.

Successful changes return a verified snapshot and pinned refs. Body, properties and file uploads are separate requests; client version checks cannot guarantee an atomic transaction or name uniqueness. `WRITE_PARTIAL` and `WRITE_OUTCOME_UNKNOWN` report stage and identities. Inspect the target before retrying. Dry runs do not prove service acceptance. [Mutation contract](protocol.md#mutation-contract) and [error recovery](protocol.md#errors).

## Commands and output

Run `ntn-skills --help` or `ntn-skills <command> --help` for flags and examples. Help is offline and an explicit `--help` takes precedence without running the command. Normal output is JSON, including errors; help/version are text. Exit status is 0 for success, 1 for operation failure and 2 for invalid arguments. `read --raw` affects successful content only.

The [bootstrap command reference](../skills/ntn-skills/references/commands.md) lists commands and errors. The [protocol](protocol.md) defines exact selectors and result semantics.

## Configuration and storage

Configuration defaults to `~/.config/ntn-skills/config.json`; state defaults to `~/.local/state/ntn-skills`. `NTN_SKILLS_CONFIG_HOME` and `NTN_SKILLS_HOME` each name a complete application directory. XDG base-directory alternatives and inherited workspace/API settings are defined in [the environment contract](protocol.md#environment-and-local-storage).

When the new configuration is absent, source/list access can migrate the old state-directory configuration, retaining a `.migrated` backup. New configuration wins; invalid legacy configuration fails without migration. Snapshots do not move.

State contains private workflow bytes, immutable manifests, content-addressed objects, metadata caches and upload staging, with no automatic garbage collection. Credential scope separates online caches. Historical pinned refs remain readable offline after the credential-scope format change, but writes against an older scope require a fresh online read. A cached copy is not proof of current remote authorization. Online calls use `ntn` and signed export URLs; the CLI sends no analytics requests of its own. [Security policy](../SECURITY.md).

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

Uninstalling retains configuration and snapshots. Before uninstalling, run `ntn-skills config clear-token` if you want to remove a saved token; environment credentials and `ntn` login state belong to their own tools. For optional data reclamation, locate the effective config/state directories, stop hosts using them, and move only those application directories and legacy config backups to the system Trash or your approved retention process. Clearing state removes historical local versions required by pinned refs. Configuration cleanup is a separate choice.
