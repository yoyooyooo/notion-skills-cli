---
name: ntn-skills
description: Discover, read, create, import, export and maintain reusable workflows in Notion Skills Databases through ntn-skills. Use when a task may benefit from the Notion skill library, when the user names a remote skill, follows skill:// references, or asks to create/import/export/update a Skill. Read metadata first, then only needed files; use pinned refs as the baseline for authorized writes.
compatibility: Requires Bun, official ntn CLI, ntn-skills, and an existing Notion Read content connection with Skills API access. Creating/importing/updating requires Insert/Update content capabilities. Shell tool access is sufficient; host protocol adapters are optional.
---

# Remote Notion skills

Use Notion as the maintained source and ntn-skills for progressive reads and explicit authorized writes. Do not install or load every remote skill's contents to discover what is available.

Authentication priority is non-empty config.token > NOTION_API_TOKEN > existing ntn login. Save through `config set-token --stdin` with piped input; clear with `config clear-token` to restore fallback. Tokens are plaintext in private configuration, never command arguments/output. `config show` reports token_configured only; use doctor for actual access checks. Never prompt for or print credentials, or start login implicitly. See [authentication and host isolation](references/integration.md).

Notion Name uses ASCII English letters and single spaces, with no surrounding spaces and at most 64 characters. Its lowercase, hyphenated form is the skill's invocation name: `Resource Tag Governance` → `resource-tag-governance`. Each listed `name` is the display title and `alias` is that invocation name. The export's `SKILL.md` name must match it. Descriptions and contents may use any language.

1. If remote metadata is already supplied, choose from it; otherwise run ntn-skills list. It paginates automatically and returns databases/skills/count/coverage without bodies. Join each Skill database_id to the database map for title and domain alias. --query filters Skill Name/alias/Description and retains the full queried database map. --refresh belongs to list only; broaden a query if nothing relevant appears. Use database list to discover databases without querying Skill rows.
2. Select a workflow by its name and Description. List entries are discovery data. Inspecting, editing, summarizing, or configuring a skill does not activate its instructions.
3. Run `ntn-skills read "<exact display name>"` or pass the listed ref. It resolves unique names/aliases and obtains its own snapshot; no open step is required.
4. Record the returned `snapshot_id` and pinned `ref`. Read supporting files only when the current step needs them, using the same snapshot:

   ```bash
   ntn-skills read <snapshot-id> --path references/guide.md
   ntn-skills read references/guide.md --from '<pinned SKILL.md ref>'
   ```

5. Relative links resolve from the containing file. Use `read relative-path --from '<pinned ref>'`; resolve is an optional helper. `read`, `files`, `open`, `write` and `export` share targets: Name, invocation alias, page ID/URL, skill:// ref or snapshot ID. --path supplies a path only when the target has none; --from rejects --path. `files <snapshot-id>` returns pinned file refs.
6. For binary bytes, use --output and a host viewer; identical local output is reused, differing output returns OUTPUT_CONFLICT. Reading scripts does not authorize execution.
7. Keep one snapshot throughout a workflow. Pinned refs/snapshot IDs read files or export offline; a new unpinned online read adopts the current version. Historical snapshots remain immutable.

`skill://<name-or-page-id>/<path>?snapshot=<id>` is handled by this CLI. A built-in Read tool accepts it only if the host registered an adapter. Do not assume a Skill can register that adapter.

Output is JSON with ok, identity, snapshot, path and content. Errors are JSON with nonzero exit status. Do not treat a failed command as Skill content. Cross-database same-name Skills are allowed: retain both page identities. On SKILL_AMBIGUOUS, use details.databases with candidate database_id to select a domain, or use a returned page-ID ref. Every --database accepts one ID, URL or exact case-sensitive registered alias; repeated flags fail before execution and titles are display labels only. Register with source add frontend --database DATABASE_ID, then read NAME --database frontend. Unknown or conflicting aliases fail without fallback. Pinned alias constraints resolve locally and enforce cached database ownership. On incomplete discovery, report failed_sources database_id/alias/title/data_source_id instead of claiming uniqueness. Search cannot prove full workspace enumeration.

For maintenance, edit one local file and run `ntn-skills write '<pinned ref>' --input ./SKILL.md --dry-run`, then execute within the current authorization. --path selects a file only when the target has no path. A pinned target is an online version baseline. Stale refs return WRITE_CONFLICT; identical input returns unchanged=true without upload or mutation. Writes preserve extra frontmatter, nested/binary supporting files and every unrelated logical file in the source ZIP. notion_page_id in SKILL.md must match the target. A changed write returns a new pinned snapshot.

Create/import target priority is --database > config.default_database > sole freshly discovered Skills Database. config set-default accepts an ID/URL/registered alias, validates online and saves a canonical ID. Inspect with config show and remove with config clear-default. Name conflict/reuse/update is scoped to the selected database; the same name elsewhere does not conflict. Failed defaults never fall back; multiple/failed discoveries require explicit selection. The default does not restrict reads.

`create <input>` and `import <input>` share ZIP/folder/Markdown inputs, --name/--description overrides and source preservation. Portable manifests select metadata/entrypoints; other ZIPs/folders choose SKILL.md or one top-level Markdown after wrapper removal. A single Markdown filename is the body. Missing names derive from English filenames; missing descriptions require --description. Extra Skill frontmatter, arbitrary filenames and nested files are retained in ntn-skills-source.zip. Imported page IDs never select a target. Input ZIP max 32 MiB compressed; expanded/folder max 128 MiB/10,000 entries; source ZIP max 20 MiB including its manifest. Unsafe/duplicate paths, links and special files fail before mutation.

Create is pure creation: an existing invocation name returns CREATE_CONFLICT, even with identical content. Import creates absent names, reuses identical content with action=reuse/reused=true, or overwrites differing content with action=update on the existing page. Overwrite replaces the body, metadata and whole file set and retains the page ID. Multiple matching pages fail. --dry-run reports create/reuse/update without changes. Version checks precede content changes and committing uploads; they are client checks without an atomic server guarantee.

`export <target> --output <path> [--format zip|directory]` writes a complete reversible Skill. .zip selects ZIP; other paths select directory. Pinned targets work offline. Preserve .ntn-skills.json for metadata/entrypoint and title casing. Original source bytes stay exact while their recorded projection matches current body/metadata; live edits regenerate the main file and retain other content. ZIP order/timestamps are deterministic. Identical destinations return reused=true; different output returns OUTPUT_CONFLICT. Reimport reuses identical content or overwrites differing same-name content.

New pages write body after properties to preserve an initial H1, then attach a source ZIP recording normalized body/name/description. Successful changes verify metadata, readback, exported body, bundle bytes and complete file identity. Create/import return input_type/main_path/content_id/action/reused; write adds previous_version_id/path/unchanged. Body/properties/files are separate requests. Insert/Update and Read content are required. WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN includes stage/page identity; read back before retrying. Dry runs cannot prove service acceptance.

See [commands and errors](references/commands.md) for exact flags and responses. See [discovery and host integration](references/integration.md) when setting up metadata injection or handling missing sources.
