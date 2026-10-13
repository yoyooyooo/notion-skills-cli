# notion-skills-cli

Read workflows stored in Notion from an Agent or a terminal. **`ntn-skills`** lists Skill names and descriptions, reads the workflow you choose, and keeps its supporting files at one fixed version for your task.

```bash
ntn-skills list
ntn-skills read 'Release Review'
```

`Release Review` is an illustrative Skill title. Use a title or ref returned by your own `list` response. The executable and bootstrap Skill are named `ntn-skills`; the package is `notion-skills-cli`.

**0.1.0 is experimental and prepared for its first release.** The GitHub repository and reporting links below identify the intended public destination; repository creation and reporting availability are not yet verified. Registry availability is not claimed. See [installation](#installation) for source and local tarball options, and [the changelog](CHANGELOG.md) for release status.

## Why metadata first, then a fixed version

A workflow library can contain more instructions than a task needs. `list` returns names, descriptions and identities so an Agent can choose a relevant workflow without loading every document. `read` then loads only the selected file for the Agent, while saving the complete Skill export locally.

Notion remains editable while a task is running. If a workflow changes between reading its instructions and an attachment, mixing those versions can change what the task means. A successful read returns a pinned `ref` and `snapshot_id`; reuse them for every supporting file in that task. A later online read can activate a newer version for a new task. Existing snapshots stay unchanged.

The CLI also supports explicit create, import, export and write operations. It does not synchronize in the background or execute downloaded scripts. The implementation uses Bun and Effect **4.0.4**, with a private core bundled into the CLI distribution.

## Requirements and validation scope

- Bun >= 1.3.0; development uses Bun 1.4.3.
- Official Notion CLI `ntn`, with `api --notion-version` support.
- A Notion connection with Read content access, the Skills API enabled, and at least one accessible database whose `database_type` is `skills`.

The observed platform is macOS arm64: offline behavior has been exercised with Bun 1.3, and real Notion workflows with Bun 1.4.3 and `ntn` 0.22.12. Linux will be checked by CI; that is not a claim that a CI run has already passed. Windows is unverified. This CLI depends on `ntn`'s authentication and service behavior; these observations do not establish compatibility with every `ntn` version or platform.

Authentication priority is `config.token` > non-empty `NOTION_API_TOKEN` > existing `ntn login`. Set up the official CLI through [its authentication guide](https://developers.notion.com/cli/get-started/authentication), or pipe a token from a trusted secret source into `ntn-skills config set-token --stdin`. Remove that saved token with `ntn-skills config clear-token`. Both configuration commands work offline. The saved token is plaintext in the private configuration file and is never passed as a command argument or shown in configuration output. `config show` reports only `token_configured`, not credential validity. `ntn-skills` never starts login or reads `ntn`'s private credential files.

## Installation

Once the public repository is available, clone it and run these commands in the repository root. If you already have this checkout, start with `bun install --frozen-lockfile`:

```bash
git clone https://github.com/yoyooyooo/notion-skills-cli.git
cd notion-skills-cli
bun install --frozen-lockfile
bun run build
bun packages/cli/dist/ntn-skills.js --help
```

You can invoke the built file directly with Bun. To register the package for local linking, run from that checkout:

```bash
cd packages/cli
bun link
```

In a separate Bun consuming project, link the registered package and put that project's executables on your shell's PATH:

```bash
bun link notion-skills-cli
export PATH="$PWD/node_modules/.bin:$PATH"
ntn-skills --help
```

For a tarball installation, build first, then pack from `packages/cli`:

```bash
mkdir -p ../../release
bun pm pack --destination ../../release
```

In a separate Bun consuming project, install the generated file by its local path. For example, when the checkout is a sibling directory:

```bash
bun add ../notion-skills-cli/release/notion-skills-cli-0.1.0.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
ntn-skills --help
```

The filename follows the package version. These commands consume a local artifact; they do not require or imply an npm release. Maintainers use [the release procedure](docs/releasing.md) to publish.

## Quick start

Start after installation, with Bun and `ntn` available and authentication configured. Your accessible typed Skills Database must contain at least one valid Skill: its Notion Name uses English letters separated by single spaces, and its exported `SKILL.md` frontmatter `name` matches the lowercase name with spaces replaced by hyphens. For example, `Release Review` maps to `release-review`. A plain database with a similar title does not meet this requirement.

```bash
ntn-skills doctor
ntn-skills list
```

`doctor` checks runtime, authentication, discovery and export capability. With the required Skill available, expect `ok: true`, `authentication: "available"`, `skill_count` of at least one, and `skills_api: {"checked": true, "available": true}`. Resolve its errors or unavailable export capability before continuing. A successful `list` response has `ok: true`, `count` of at least one, and entries in `skills`. Read `coverage` as well: Search is not guaranteed to enumerate your entire workspace. If you know a database that Search has not found, use `ntn-skills list --database <your-database-id-or-url>`.

Copy the exact `ref` from an entry in `skills`, then pass it to `read` as one quoted argument:

```bash
ntn-skills read '<ref copied from skills[].ref>'
```

The angle-bracket text above tells you which value to copy; do not enter it literally. The successful read contains `ok: true`, the requested file in `content`, an `s_`-prefixed `snapshot_id`, an opaque `version_id`, a `ref` containing `?snapshot=...`, and `source: "notion"`. These fields are defined in [the output contract](docs/protocol.md#success).

Copy that returned pinned `ref` and keep it with the task. To inspect attachments from the same version:

```bash
ntn-skills files '<snapshot_id copied from read.snapshot_id>'
ntn-skills read '<attachment ref copied from files[].ref>'
```

Choose a file that `files` actually returned. Use `snapshot_id` to list the complete version; a file ref such as `read.ref` filters only that file. Each returned file ref carries the same snapshot. A pinned read returns `source: "local_snapshot"` and works without authentication or network access. For binary attachments, add `--output ./attachment.bin` and open the result with an appropriate viewer. A relative text attachment can also be read with `ntn-skills read reference.md --from '<pinned containing-file ref>'`, when that file exists in the Skill.

`read` saves a complete snapshot and emits only the requested file. `open` is an optional helper returning snapshot metadata and file refs without contents. Unpinned reads check current remote access and export version before cache reuse. Historical snapshots can only be read if already present on this machine.

Use `--lines 10-30` for inclusive, 1-based ranges. Results include `range` and `has_more`; no content is silently truncated. Use `--raw` for UTF-8 text without the JSON envelope, or `--output <local-path>` for binary content. Identical output is reused with `reused=true`; different output returns `OUTPUT_CONFLICT`. Scripts are never executed.

## Discovery and identity

By default, paginate Notion Search for data sources and accept only `database_type: "skills"`. Query every discovered data source, deduplicate page IDs, and expose names, descriptions, IDs, aliases, and refs.

Notion Search is eventually consistent and [does not guarantee exhaustive enumeration](https://developers.notion.com/reference/search-optimizations-and-limitations). Responses state coverage explicitly. A missing skill means absent from the discovered scope, not absent from the workspace.

Register stable aliases for databases serving different domains:

```bash
ntn-skills source add frontend --database <frontend-database-id-or-url>
ntn-skills source add ops --database <ops-database-id-or-url>
ntn-skills database list
ntn-skills list --database frontend
ntn-skills read 'Release Review' --database ops
ntn-skills config set-default frontend
ntn-skills source list
ntn-skills list --refresh
```

Every `--database` accepts one Database ID, Notion URL or exact registered alias; `config set-default` accepts the same selectors and persists the canonical ID. Aliases match case-sensitively, never by database title; IDs/URLs have priority. Unknown aliases return DATABASE_NOT_FOUND, conflicting alias mappings return DATABASE_AMBIGUOUS, and inaccessible selections never fall back. Repeated --database values return INVALID_ARGUMENT (exit 2), including repeated identical values. Omit the selector to discover all visible/registered databases; the creation default does not restrict reads. Pinned reads/exports with an alias constraint resolve it from local configuration without network access.

Registered sources supplement automatic discovery; names alone never determine whether a database is a Skills Database. No custom Status field is assumed or silently filtered. `list --query` filters Skill Name, invocation alias and Description metadata after pagination; it returns `databases`, `skills`, `count` and `coverage`, without bodies or file manifests. The databases map contains database_id/title/alias/data_source_ids for the full queried scope, including empty databases and those with no query matches. Join each Skill's database_id to that map; its alias is the Skill invocation name, distinct from the database alias. Failed source entries identify database_id/alias/title and, for row-query failures, data_source_id. `database list` discovers databases without querying Skill rows. `--refresh` belongs to `list`; reads obtain the current export independently.

Notion Name must contain only ASCII English letters (`A-Z`, `a-z`) separated by single spaces, with no leading/trailing spaces and at most 64 characters. The invocation name is derived by lowercasing and replacing each space with `-`: `Release Review` becomes `release-review`. `list` exposes the display title as `name` and the invocation name as `alias`; `SKILL.md` frontmatter `name` and its export directory must match that invocation name. Invalid titles return `INVALID_SKILL_NAME` with the page ID; export-name mismatches return `INVALID_SKILL`. Description and file contents may use any language.

Name lookup accepts the exact display title or invocation name. Different databases may contain the same name. Unscoped collisions return SKILL_AMBIGUOUS with candidate Skill identities and a databases map for their owning IDs; use --database with a registered alias to select one domain. Page IDs and Notion page URLs select an exact skill. If any source fails, name resolution returns CATALOG_INCOMPLETE; it cannot safely infer uniqueness. A direct page ID still requires a valid Name and matching export name. Returned pinned refs use page IDs; explicit historical snapshot reads preserve their original identity and contents and reject a mismatched --database constraint.

## Creating, importing, exporting and updating skills

```bash
ntn-skills config set-default <database-id-or-url>
ntn-skills config show
ntn-skills create ./my-skill --dry-run
ntn-skills create ./my-skill
ntn-skills import ./my-skill.zip --dry-run
ntn-skills import ./my-skill
ntn-skills import ./workflow.md --name 'My Workflow' --description 'When to use this workflow'
ntn-skills export 'My Workflow' --output ./my-workflow.zip
ntn-skills export '<pinned SKILL.md ref>' --output ./my-workflow
ntn-skills write '<pinned SKILL.md ref>' --input ./SKILL.md --dry-run
ntn-skills write '<pinned SKILL.md ref>' --input ./SKILL.md
ntn-skills write 'skill://release-review/checklist.md' --input ./checklist.md
```

Creation selects `--database` first, then `config.default_database`, then the only discovered Skills Database. Discovery is fresh and fully paginated within Search visibility; zero/multiple databases and failed registered sources require an explicit choice. A configured but inaccessible default fails instead of falling back. `ntn-skills config clear-default` removes the preference offline. Read discovery remains broad; the default affects creation only.

`create <input>` and `import <input>` share the same input rules: one ZIP, folder, or `.md`/`.markdown` file with any filename. Portable exports use `.ntn-skills.json` for metadata and the entrypoint; other ZIP/folder inputs use `SKILL.md`, otherwise the only top-level Markdown file after removing one enclosing directory. Ambiguous inputs return `IMPORT_AMBIGUOUS`. A single Markdown input always supplies the body. `--name` and `--description` override frontmatter/manifest metadata; absent names derive from English filenames, and absent descriptions require `--description`. Name/Description map to page properties; ordinary frontmatter remains body content. Extra Skill metadata, original bytes, filenames and nested paths are retained in `ntn-skills-source.zip` and expanded for reads/exports. Imported `notion_page_id` never selects a target.

Both commands freshly query the selected database by invocation name. `create` requires a new name and returns `CREATE_CONFLICT` if one already exists, even when content is identical. `import` creates when absent, returns `action=reuse` and `reused=true` for identical content, or returns `action=update` and replaces the existing page's body, metadata and entire file set for different content. Overwrite retains the page ID and checks a fresh remote version before changing content and before committing uploaded files. Multiple matching pages fail with `SKILL_AMBIGUOUS`. `--dry-run` reports the same create/reuse/update decision without mutation. The content digest includes metadata, paths and file hashes. Name uniqueness and version checks are client preflight checks; Notion provides no atomic uniqueness or conditional commit.

Input ZIPs allow 32 MiB compressed, 128 MiB expanded and 10,000 entries; folders allow 128 MiB and 10,000 entries. The generated source ZIP, including its manifest, must fit 20 MiB compressed, 128 MiB expanded and 10,000 entries. Unsafe/duplicate/reserved paths, links, special files and checksum failures fail before mutation.

`export <name-or-page-or-ref-or-snapshot> --output <path>` exports a complete importable ZIP or directory. The default is ZIP for `.zip` output paths, directory otherwise; `--format zip|directory` selects explicitly. Pinned refs and snapshot IDs work offline. Output contains `.ntn-skills.json` and every content file; generated metadata excludes page/version IDs and timestamps. Source files remain byte-exact while the page body and metadata match their recorded projection. Current remote edits replace the main file with canonical Markdown while retaining extra frontmatter and supporting files. Native Notion Skills export a canonical `SKILL.md` without `notion_page_id`. ZIP order, timestamps and compression are deterministic. Identical existing output returns `reused=true`; different output returns `OUTPUT_CONFLICT` without overwrite. Preserve the manifest for arbitrary entrypoint names and display-title casing. See [the portable format contract](docs/protocol.md#portable-export-contract).

`write <target> --input <local-file> [--path <file>]` replaces one logical file and retains the other files. Targets share the read/files/export syntax: display Name, invocation alias, page ID/URL, `skill://` ref or snapshot ID. A ref with a file path cannot combine with `--path`. Pinned refs and snapshot IDs are online version baselines; authentication scope, page identity and current `version_id` must match or the operation fails. Unpinned targets capture the current baseline. SKILL.md name/description update page properties; `notion_page_id` must match the page. Extra frontmatter, nested paths and binary attachments are retained in the source ZIP. Identical input returns `action=unchanged` and `unchanged=true` without upload or mutation. `--dry-run` validates and reports the target. Requires Update/Insert and Read content for uploads and verification. Dry runs cannot prove service acceptance; `WRITE_OUTCOME_UNKNOWN` requires readback before retrying.

Successful changes return a verified snapshot and pinned refs; create/import also return `input_type`, `main_path`, `content_id`, `action` and `reused`. Notion normalizes page Markdown; the source ZIP preserves the original bytes until body or metadata changes. New pages write properties first and then Markdown to preserve initial H1 headings. Source bundles are attached after recording the normalized body projection. Verification compares properties, page readback, exported body and portable file identity, preserving fenced-code blank lines. Body, properties and files are separate requests. `WRITE_PARTIAL` and `WRITE_OUTCOME_UNKNOWN` include stage, completed operations and page/database IDs; inspect the target before retrying. Historical snapshots remain immutable.


## Commands

| Command | Behavior |
| --- | --- |
| `list [--query text] [--database selector] [--refresh]` | List Skill metadata, database maps and coverage; automatic pagination |
| `database list [--database selector]` | Discover database IDs, titles and aliases without querying Skill rows |
| `open <target>` | Optional snapshot metadata and file refs |
| `read <target> [--path file]` | One file, default `SKILL.md`; pinned refs/snapshot IDs are offline |
| `read <relative-path> --from <ref>` | Relative file in the containing ref's version |
| `files <target> [--path file-or-directory]` | File paths, byte counts and pinned refs |
| `resolve <relative-path> --from <ref>` | Resolve a file reference and preserve snapshot |
| `source add <alias> --database <selector>` | Register one database ID/URL or rename an existing registered alias locally |
| `source list` | Local source registrations |
| `config show / set-token --stdin / clear-token / set-default <selector> / clear-default` | Inspect sanitized configuration; manage authentication and the creation default |
| `create <zip-or-folder-or-markdown> [--name title] [--description text] [--dry-run]` | Pure creation; existing name fails |
| `import <zip-or-folder-or-markdown> [--name title] [--description text] [--dry-run]` | Create, reuse or overwrite same-name content |
| `export <target> --output <path> [--format zip\|directory]` | Complete reversible Skill; reuse identical output |
| `write <target> [--path file] --input <file> [--dry-run]` | Replace one file; unchanged bytes do not mutate |
| `doctor` | Runtime, auth, discovery, and export capability checks |

Run `ntn-skills <command> --help` for flags. Output is JSON by default, including errors. Exit status: 0 success, 1 operation failure, 2 invalid CLI arguments. Help/version are text. `read --raw` affects successful content only; failures remain JSON.

Root help explains the discovery/read/pinned-attachment workflow, authentication, configuration paths and error recovery. Each command's help describes arguments and flags, online/offline behavior and usage examples. `SNAPSHOT_ID`, `PINNED_REF` and `DATABASE_ID` in examples are placeholders to replace with returned values or a known database ID. Help is available without credentials or writable state/configuration directories. Explicit `--help` takes precedence over other arguments and does not run the command.

## Upgrade and uninstall

For a source installation, run in the checkout root:

```bash
git pull --ff-only
bun install --frozen-lockfile
bun run build
```

A local link uses that rebuilt checkout. For a tarball installation, pack the new version and run `bun add <path-to-new-tarball>` in the consuming project. Read [the changelog](CHANGELOG.md) for migration instructions before upgrading across a 0.x minor version.

To uninstall a project dependency, run in each consuming project:

```bash
bun remove notion-skills-cli
```

To unregister the source package from Bun's link registry, run in the checkout's `packages/cli` directory:

```bash
bun unlink
```

`bun unlink` unregisters the current package directory; it does not replace removing the dependency from a consuming project. If you chose a global installation, use `bun remove --global notion-skills-cli` instead of the project removal command.

Uninstalling leaves configuration and cached state in place. Before uninstalling, use `ntn-skills config clear-token` if you want to remove a saved token. Environment credentials and `ntn` login state belong to their own tools. If you also want to discard configuration, snapshots or upload staging, first locate the effective directories below and stop any hosts using them. Move only those application directories and any legacy configuration backups to your system's Trash or approved retention process. Clearing state removes the local historical versions needed by pinned refs; configuration cleanup is a separate choice.

## Configuration, snapshots and storage

Global source registrations, the optional default creation database and an optional plaintext `token` are stored in `~/.config/ntn-skills/config.json`. Configuration directory precedence: `NTN_SKILLS_CONFIG_HOME`, then `$XDG_CONFIG_HOME/ntn-skills`, then `~/.config/ntn-skills`. The explicit override names the full application directory. `NTN_SKILLS_HOME` controls state only. For example, a configuration without a token is `{"sources": [], "default_database": "12345678-1234-1234-1234-123456789abc"}`. Replace the example ID with your database; use config set-default to validate it before saving. `config set-token --stdin` trims surrounding whitespace and rejects empty or multiple values before saving; `clear-token` removes only the token. All configuration changes preserve the other settings. Config output omits the token and adds `token_configured`; `set-token` saves without remote validation, so use `doctor` to check access.

When the new config is absent, the next `source list` or `list` operation validates the old state-directory `config.json`, copies it to the config directory, and renames the original to `config.json.<uuid>.migrated` as a backup. Existing new configuration takes precedence; malformed legacy configuration fails without migration. Snapshots do not move.

State directory precedence: `NTN_SKILLS_HOME`, then `$XDG_STATE_HOME/ntn-skills`, then `~/.local/state/ntn-skills`. List metadata has a 60-second freshness TTL; `list --refresh` bypasses it. The TTL is not a deletion policy. Snapshot manifests, content-addressed `objects`, metadata cache files and `uploads` staging have no automatic garbage collection and can accumulate until you choose to reclaim state. Online reads/files/exports check current access and the export version before cache reuse.

Snapshots are identified by a digest of authentication scope, page ID, and opaque skill `version_id`. Immutable manifests refer to content-addressed files; manifests are atomically published after all objects exist. Reads verify file hashes. Snapshot state and command output never contain credentials or signed download URLs; only an explicitly saved config.token persists a credential. Authentication scope includes user identity, selected workspace, API endpoint, and the selected credential's digest (or an ntn-login marker). Changing the selected token separates online caches; the same token selected from configuration or the environment shares a scope. The credential-scope format changed in this release: previously cached pinned refs remain readable offline, but a pinned write with an older scope requires a fresh online read. State uses private directory/file modes. A cached snapshot is a local copy, not proof of current remote authorization.

Historical export versions cannot be requested from Notion's current API. Only snapshots already cached on this machine can be read historically. No background update modifies an existing task's snapshot. Explicit create/import/write commands update Notion; the CLI does not run background synchronization or install remote skill bodies into Agent skill directories.

Notion export archives use gzip/tar with one skill root, ordinary files/directories, and PAX/GNU path metadata. Links, special entries, duplicate paths, traversal, invalid frontmatter, and malformed archives fail. Limits: 32 MiB compressed, 128 MiB expanded, 10,000 files. Local `import` accepts ZIP, folder or Markdown as described above; gzip/tar exports are read snapshots rather than import inputs. `--output` exports an individual file for an image/PDF consumer.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `NTN_SKILLS_NTN_BIN` | Executable path or name for the official CLI child process; defaults to `ntn` |
| `NOTION_API_TOKEN` | Credential fallback when no configuration token is present |
| `NTN_SKILLS_CONFIG_HOME` | Full application configuration directory |
| `XDG_CONFIG_HOME` | Configuration base; the application uses its `ntn-skills` child directory |
| `NTN_SKILLS_HOME` | Full application state directory |
| `XDG_STATE_HOME` | State base; the application uses its `ntn-skills` child directory |
| `NOTION_WORKSPACE_ID` | Included in authentication scope and inherited by `ntn`; workspace selection follows `ntn`'s authentication rules |
| `NOTION_API_BASE_URL` | Included in authentication scope, default `https://api.notion.com`, and inherited by `ntn api` as its API base URL override |

Both values separate local cache scopes and reach the official `ntn` child process. Use [its authentication guide](https://developers.notion.com/cli/get-started/authentication) for workspace selection and `ntn api --help` for API endpoint overrides. Select a trusted endpoint: `ntn` may send its authentication credential there. Export archive downloads use the signed URLs returned by the service, independently of the API base URL.

### Network and local data

`ntn-skills` sends no analytics or telemetry requests of its own. Online operations invoke the selected `ntn` executable for Notion authentication/API calls and uploads, and read signed archive download URLs returned by Notion. `ntn` has its own behavior and policies; this statement does not attest to its telemetry or privacy practices.

Local access covers application configuration and state, explicitly supplied ZIP/folder/Markdown or write input paths, and requested output destinations. Local inputs may be uploaded by explicitly authorized create/import/write commands. State includes Skill contents and upload staging, so protect it like the source documents. The CLI does not execute imported scripts or read `ntn`'s private login files. [Security](SECURITY.md) explains retention, permissions and private vulnerability reporting.

## Agent integration

Install the [bootstrap Skill](skills/ntn-skills/SKILL.md) in your host's skill directory. A generic Skill cannot register a new protocol with a host's built-in Read tool. CLI protocol support works everywhere shell tools are available; direct `Read skill://...` requires a host adapter. See [host integration](docs/host-integration.md) and the [output contract](docs/protocol.md).

The [bootstrap integration reference](skills/ntn-skills/references/integration.md) carries the same discovery, authentication, environment and snapshot rules for Agents.

For automatic awareness of all remote skills, a host startup hook must call `list` and inject only the metadata entries. Without that hook, a host instruction can tell the Agent to use the bootstrap Skill to discover applicable workflows. Installation of a bootstrap Skill alone does not expose every remote skill at startup.

## Development

```bash
bun install --frozen-lockfile
bun run check && bun run package:check
bun run dev --help
```

- `packages/core`: schemas, refs, discovery, Notion transport, archive decoding, snapshot storage.
- `packages/cli`: Effect CLI, Bun runtime, distribution build.
- `skills/ntn-skills`: bootstrap Skill and focused references.
- `packages/*/test`: behavior tests independent of personal Notion credentials.

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Releasing](docs/releasing.md) · [MIT license](LICENSE)

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for bugs and usage questions with sanitized details. Report vulnerabilities through [the private security channel](SECURITY.md#reporting-a-vulnerability).

API references: [Skills export](https://developers.notion.com/reference/agent-skills/get-skill-directory), [Database type](https://developers.notion.com/reference/database), [Notion CLI](https://developers.notion.com/cli/reference/commands).
