# Contributing

## Development setup

Use Bun 1.4.3 with the committed lockfile. The CLI and SDK run on Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+.

```bash
git clone https://github.com/yoyooyooo/notion-skills-cli.git
cd notion-skills-cli
bun install --frozen-lockfile
bun run dev --help
```

`bun run dev <command>` starts the current TypeScript implementation under Node with the Markdown loader. It preserves the caller's working directory, signals and exit status. `NTN_SKILLS_DEV_ROOT=/absolute/checkout ntn-skills <command>` explicitly selects this checkout for the installed CLI launcher. The SDK embedded in a host uses its installed package and does not follow that CLI override.

Use `git pull --ff-only` for updates. Preserve existing local edits. Keep source changes and their direct consumers in the same change; remove retired routes instead of retaining aliases or fallback readers.

## Follow the current contract

Read [the current contract](docs/current-contract.md) before changing table fields, authority, file acquisition or public behavior. Skills, Files, Sources and Records describe current facts. Ordinary consumption must not write Notion. Current native page bodies are authoritative; Source and resource descriptors bind exact original bytes. A complete directory does not imply that every supporting file is already cached.

The public SDK is version 2. Source management APIs and the `readOnly` input have been removed. Hosts must require SDK v2 before consuming current content; all consumption is already read only. Consumer and resource result contracts remain version 1. Protocol numbers describe incompatible formats and do not introduce content version management.

The shipped CLI exposes `list`, `read`, `use`, `files`, `export` and the current `ctl` tree. `ctl library import` replaces one complete resource/native tree and its declared portable relationships. Source apply/refresh, file takeover/restore-follow and enable/disable/remove use the same finite operation kernel. A Source removal requires a complete library metadata census; a missing Origin relation cannot hide a Content reference. Explicit supersede keeps one unfinished handoff and never restores ready by clearing an unresolved action. Inspect `ntn-skills schema` and a specific `schema ctl ...` path for the actual command contract. Do not copy old authoring examples into current guidance.

Keep Effect, platform, SQLite and Effect test integration versions aligned at 4.0.5. Use `effect/cli` for commands and scoped Effect services for external execution. Put validation at the external boundary; preserve authorization, complete pagination, byte checks, request budgets and cancellation cleanup.

## Verify the changed boundary

```bash
bun run typecheck
bun run format:check
bun run test
bun run package:check
```

The tests use controlled fixtures and must not depend on personal credentials or mutate production Notion. The package check builds a fresh external artifact, verifies its manifest, declaration closure and packaged links, installs it with npm, and runs the installed CLI and SDK. It checks current discovery, complete Files pagination, exact resource bytes, missing-cache reselection, limits, zero-write consumption and real HTTP cancellation. Its import journey checks dry run, current writes, per-file reads, exact export and unchanged reimport. It does not establish live Notion cutover or Pi daily acceptance.

Use the existing verification entry and [verification review](docs/maintenance-verification-review.md) for a scoped implementation or migration check. A test definition is not a passing result. Report which actual command or user flow ran, its result and any remaining boundary. Keep live data conversion and daily Pi verification separate from the controlled package gate.

The compact `packages/core/test/fixtures/router-original/.ntn-skills.json` is a byte-preservation fixture. Its whitespace and final newline are intentional. Builtin lifecycle tests use isolated application and agent directories; preserve that isolation when extending a test.

## Build a fresh consumer artifact

```bash
artifact_root=$(mktemp -d)
bun packages/cli/build.ts --outdir "$artifact_root/package"
bun pm pack --cwd "$artifact_root/package" --destination "$artifact_root"
```

An external output directory must not already exist. It contains only the current generated declaration closure and public package dependencies. This avoids carrying old generated files into the tarball. `bun run build` remains available for local development.

Update both [English](README.md) and [简体中文](README.zh-CN.md) entrypoints, the current contract and affected built-in references when public behavior changes. Keep commands, limits and implementation status consistent. Every relative link in a shipped document must resolve inside the package.

PR descriptions should explain the concrete problem, the resulting behavior and the checks that ran. Keep deferred writer or migration work visible rather than adding compatibility paths to make an old fixture pass. A local build or tarball is not a published release. Publishing a registry package, tag or hosted release requires explicit release authorization.
