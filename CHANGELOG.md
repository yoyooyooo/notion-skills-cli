# Changelog

## 0.2.0 — 2026-10-14

Current-target reads now reuse complete observations for up to five minutes, and catalogs for up to 60 seconds. Callers that require immediate remote validation must use `--refresh`; pinned snapshot reads remain immutable and offline. Preserve existing configuration/state when upgrading; disposable observations now use the separate cache root.

- Read skills from databases with rich-text Description and References, without requiring native Skills exports.
- Materialize reference pages as relative Markdown files, preserve links through create/import/write/export, and include referenced-page edits in version conflicts.
- Create editable reference child pages during imports and retain omitted pages in Notion while excluding them from new snapshots and exports.
- Support page-only libraries without Files, with normalized Markdown and repeat imports that reuse existing pages; optional Files retains exact source bytes and other assets.
- Report the selected storage mode in doctor and update CLI help, both READMEs, protocol and Agent integration references.
- Resume interrupted reference imports using existing child-page IDs, reject duplicate paths, and normalize equivalent relative links when comparing page-only content.
- Report safe transport failure reasons without exposing raw stderr, credentials or signed URLs; preserve unknown write outcomes.
- Retry transient read/query transport and service failures up to three times with bounded backoff; mutation requests are never retried automatically.
- Recover transient References attachment downloads with scoped timeouts and bounded retry; reject denied access without retry or signed URL disclosure.
- Add repository-local verification recipes and command-to-case coverage with isolated config/state/cache and XDG bases, preserved evidence and system-Trash cleanup.
- Limit npm documentation files to the explicit public guide set; keep implementation designs and verification maps repository-only without broken package-relative links.
- Add `sync bind/status/plan/apply/reconcile/unbind`, immutable checked plans, per-binding common baselines, grouped multi-target distribution and durable partial/unknown-operation recovery without replaying mutations.
- Resolve local directory, parent and per-file symlink chains; preserve links on writes, reject saved-target drift at commit guards, retain removed/replaced bytes and fence cooperating processes. Native Node filesystem calls retain a documented check-to-syscall race.
- Change current reads to complete bounded observations: 5m Skill and 60s catalog defaults, mutually exclusive `--refresh`/`--offline`/`--max-age`, explicit source/freshness metadata and unchanged immutable pinned reads. Writes, sync and doctor still validate online.
- Add XDG/application cache roots, cache-only status/retirement and configurable cache policy; preserve configuration, bindings, baselines, plans, receipts, immutable snapshots and content objects through cache cleanup/upgrade.
- Add `import --target` for verified whole-Skill replacement on one existing page, preserving page identity across rename and rejecting stale, missing or non-main targets without creation fallback.
- Run CI on Ubuntu/macOS 15 and Node.js 22/24 through the package verification controller, retain consumer evidence/tarballs as artifacts, and exercise explicit Linux retention failure without losing cached bytes.
- Fence the entire content/catalog retirement batch before system Trash operations, so unavailable retention preserves bytes without exposing later observations or accepting delayed publishers.

## 0.1.3 — 2026-10-14

- Wait for the npm attestation document to become available after registry metadata appears.
- Give each CLI boundary scenario its own test timeout.

## 0.1.2 — 2026-10-14

- Publish from GitHub Actions with npm OIDC; verify provenance for public repositories and registry evidence for private repositories.
- Simplify installation and release documentation.

## 0.1.0 — 2026-10-14

Initial npm release, published with maintainer web authentication.

### Public repository baseline

- Set the public npm package name to `ntn-skills`, matching the executable and bootstrap Skill; retain the `notion-skills-cli` source repository.
- Add equivalent English and Simplified Chinese READMEs with a centered header, language switch and section navigation; package both language files.
- Move detailed operations into the [usage guide](docs/usage.md), and document source-access and release status.
- Separate consumer installation and use from contributor source/build steps in both READMEs; consumers install a built tarball with npm and run on Node.js 22.19.0 or newer.
- Replace the Bun runtime platform, executable shebang and distribution target with Node.js; keep Bun 1.4.3 for development/build/tests, and exercise npm consumers on Node.js 22 and 24 in CI.
- Add an English installation and first-read walkthrough, tarball consumption, upgrade and uninstall instructions, and explicit runtime/platform evidence boundaries in [README](README.md).
- Document metadata freshness separately from retained snapshots and upload staging, inherited workspace/API endpoint settings, network behavior and optional local data cleanup across the [protocol](docs/protocol.md), [host integration](docs/host-integration.md) and [Skill reference](skills/ntn-skills/references/integration.md).
- Use the returned snapshot ID to list every attachment; a pinned file ref filters only its own path.
- Set the public issue and private vulnerability-reporting channels, security support for the latest patch of the current 0.x series, and a seven-day acknowledgement target without a promised fix deadline in [SECURITY](SECURITY.md).
- Define 0.x compatibility, deprecation migration guidance and fast-forward integration in [CONTRIBUTING](CONTRIBUTING.md), and prepare the package/release metadata and CI release lane.
- Update production archive dependency `fflate` to 0.8.3.

### Initial 0.1.0 functionality

- Add Bun development monorepo with a Node.js CLI using Effect 4.0.4, platform services, schemas, and scoped ntn transport.
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
