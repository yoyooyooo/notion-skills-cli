# Changelog

## Unreleased

Version **0.1.0** is prepared as the initial experimental release. It has not been published to npm; local builds and tarballs do not establish publication. See [the release procedure](docs/releasing.md) for immutable annotated tags, registry readback and GitHub Release ordering.

### Public repository baseline

- Add an English installation and first-read walkthrough, local linking and tarball consumption, upgrade and uninstall instructions, and explicit runtime/platform evidence boundaries in [README](README.md).
- Document metadata freshness separately from retained snapshots and upload staging, inherited workspace/API endpoint settings, network behavior and optional local data cleanup across the [protocol](docs/protocol.md), [host integration](docs/host-integration.md) and [Skill reference](skills/ntn-skills/references/integration.md).
- Use the returned snapshot ID to list every attachment; a pinned file ref filters only its own path.
- Set the public issue and private vulnerability-reporting channels, security support for the latest patch of the current 0.x series, and a seven-day acknowledgement target without a promised fix deadline in [SECURITY](SECURITY.md).
- Define 0.x compatibility, deprecation migration guidance and fast-forward integration in [CONTRIBUTING](CONTRIBUTING.md), and prepare the package/release metadata and CI release lane without claiming a published package.
- Update production archive dependency `fflate` to 0.8.3.

### Initial 0.1.0 functionality

- Add Bun monorepo with Effect 4.0.4 CLI, platform services, schemas, and scoped ntn transport.
- Discover accessible typed Skills Databases with explicit search coverage and registered-source supplementation.
- Resolve exact skill names, metadata-derived aliases, page IDs, and page URLs; return structured missing/ambiguous/incomplete errors.
- Read immutable export snapshots one file at a time, including line ranges, UTF-8 BOM text, and explicit binary output.
- Support skill:// refs, pinned snapshots, and relative reference resolution.
- Ship ntn-skills bootstrap Skill, host integration contract, contributor/security policies, and reproducible CI checks.
- Keep parser failures machine-readable, with optional Boolean switches and no interactive wizard.
- Bound rate-limit retries and validate Notion error responses with Schema.
- Package docs and bundled dependency licenses, and check formatting with pinned Biome.
- Store global source configuration under ~/.config/ntn-skills with XDG_CONFIG_HOME and NTN_SKILLS_CONFIG_HOME overrides; migrate legacy registrations once and retain a backup without moving snapshots.
- Require English-letter Notion titles with single spaces and derive the invocation name by lowercasing and replacing spaces with hyphens; validate matching export frontmatter and preserve historical snapshot reads.
- Make root and command help self-contained for agents with argument/flag descriptions, online/offline modes, usage examples, output conventions, storage and error-recovery guidance.
- Add create/write with dry runs, shared targets, pinned-version conflict detection, verified snapshots and explicit partial/unknown outcomes; preserve nested paths and extra metadata in the source ZIP.
- Add config.default_database and config show/set-default/clear-default; create selects an explicit database, the configured default, or the sole discovered Skills Database. Preserve the default when adding sources and reject ambiguous/incomplete discovery.
- Add import for a local ZIP, folder or any .md/.markdown filename, with one-Skill entrypoint selection, name/description overrides, bounded ZIP decoding, preserved attachment bytes, dry runs and verified new snapshots.
- Preserve initial H1 headings on create/import by writing Markdown after page creation and compare normalized write responses with page readback and exported content.
- Add complete ZIP/directory export with offline pinned refs, a versioned portable manifest, deterministic archive bytes, content digests and reuse/conflict handling for existing output.
- Preserve imported source bytes, arbitrary Markdown filenames, extra frontmatter and nested supporting files in a retained source ZIP; reconstruct current edits without changing historical snapshots.
- Make create pure creation with CREATE_CONFLICT on an existing invocation name; import creates absent names, reuses identical content or replaces different content on the same page with version checks.
- Compare page and Skills Markdown across equivalent plain-text code labels and paragraph spacing without discarding blank lines inside fenced code.
- Rename the discovery command from catalog to list; make ntn-skills list the agent-facing entrypoint in help, the bootstrap Skill and host integration, with automatic pagination and metadata-only output.
- Unify read/files/open/write/export targets across names, invocation aliases, page IDs/URLs, refs and snapshot IDs; use --path instead of second positional paths and remove read --snapshot/refresh modes.
- Replace ls with files and databases with database list; database discovery no longer queries Skill rows. List queries match invocation aliases and return compact metadata/count/coverage.
- Reuse identical local read/export output with reused=true; reject differing output with OUTPUT_CONFLICT. Identical writes return unchanged=true without remote mutation.
- Add optional global config.token with priority over NOTION_API_TOKEN and existing ntn login; set via config set-token --stdin, clear offline, preserve other settings and expose only token_configured in configuration output.
- Scope online caches by the selected credential digest; existing pinned snapshots remain readable offline, while pinned writes from an older scope format require a fresh online read.
- Accept Database IDs, URLs and exact registered aliases consistently across --database flags and config set-default; persist defaults as canonical IDs and enforce alias constraints on offline pinned targets.
- Return the queried databases map in list, retain cross-database same-name Skills, and include database maps in ambiguity errors plus owning database labels in failed-source coverage.
- Reject repeated --database values before execution, including identical values and --database=value; explicit help remains offline and takes precedence.
- Accept notion.so URLs alongside notion.com/notion.site when resolving database and page identities.
