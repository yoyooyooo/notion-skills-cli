# Contributing

## Development setup

Use Bun 1.4.3 with the committed lockfile. The CLI and SDK run on Node.js 22.23.5+ within 22.x, 24.22.3+ within 24.x, or 26.13.1+ within 26.x.

For paired or parallel development, start with the Broker's
[isolated development guide](https://github.com/yoyooyooo/pi-context-broker/blob/next/docs/isolated-development.md).
Its `scripts/paired-environment.mjs` creates two independent clones from `next`,
uses task branches, builds private CLI/Broker generations and gives every run
separate application state. That guide owns the command contract. Do not rebuild
a checkout used by the normal CLI or Pi installation for a development experiment.

For a separately owned CLI-only checkout:

```bash
git clone --branch next https://github.com/yoyooyooo/notion-skills-cli.git
cd notion-skills-cli
git switch -c work/my-change
bun install --frozen-lockfile
bun run dev --help
```

`bun run dev <command>` starts the current TypeScript implementation under Node with the Markdown loader. It preserves the caller's working directory, signals and exit status. `NTN_SKILLS_DEV_ROOT=/absolute/checkout ntn-skills <command>` explicitly selects this checkout for the installed CLI launcher. The SDK embedded in a host uses its installed package and does not follow that CLI override.

Use `git pull --ff-only` for updates. Preserve existing local edits. Keep source changes and their direct consumers in the same change; remove retired routes instead of retaining aliases or fallback readers.

## Follow the current contract

Read [the current contract](docs/current-contract.md) before changing table fields, authority, file acquisition or public behavior. Skills, Files, Sources and Records describe current facts. Ordinary consumption must not write Notion. Current native page bodies are authoritative; Source and resource descriptors bind exact original bytes. A complete directory does not imply that every supporting file is already cached.

The public SDK is version 2. Source management APIs and the `readOnly` input have been removed. Hosts must require SDK v2 before consuming current content; all consumption is already read only. Consumer and resource result contracts remain version 1. Protocol numbers describe incompatible formats and do not introduce content version management.

The shipped CLI exposes `list`, `read`, `use`, `files`, `export`, the offline `skills` family and the current `ctl` tree. `ctl library skill create/update/register/remove` owns native authorship, partial changes, page registration and scoped deletion cleanup. `ctl library import` replaces one complete resource/native tree and its declared portable relationships. Source apply/refresh, file takeover/restore-follow and enable/disable/remove use the same finite operation kernel. A Source removal requires a complete library metadata census; a missing Origin relation cannot hide a Content reference. Explicit supersede keeps one unfinished handoff and never restores ready by clearing an unresolved action. Inspect `ntn-skills schema` and a specific `schema ctl ...` path for the actual command contract. Do not copy old authoring examples into current guidance.

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

The existing Broker [integration Skill](https://github.com/yoyooyooo/pi-context-broker/blob/next/.agents/skills/verify-notion-skills-integration/SKILL.md)
owns paired environment isolation and CLI/SDK/Broker identity checks. An isolated
run does not establish normal daily installation or natural Agent acceptance.
The formal guards and strict current-`next` delivery requirements remain unchanged.

Product guidance is delivered by the package's `skills list/get/path` commands.
The installed package check compares the three Skills' main and supporting files
with the archive, checks raw Markdown and JSON output, and verifies that `path`
locates the actual packaged files. It also checks offline execution with no
credentials or usable application directories. Keep these checks in the existing
package gate; do not add a Skill installation or Notion-copy lifecycle.
The paired Broker checks its own embedded CLI and file locations through the
existing integration entry. Installed bytes and actual model delivery remain
separate observations.

Retain fixture bytes only while an actual test or documented research consumer
uses them. Preserve original failure inputs and unique evidence before retiring
an obsolete fixture.

## Compatibility and documentation

The public CLI, SDK and packaged guides follow the same release. During 0.x,
minor releases may change commands, configuration or SDK formats. Patch releases
are intended to preserve those public contracts. A necessary security correction
may narrow unsafe behavior; document the affected behavior and upgrade steps in
the changelog and current guides. There is no fixed deprecation grace period or
promise to support every previous minor release. Keep versioned protocol guards
explicit and remove retired callers with their implementation.

Keep current user instructions in README and `docs/`, contributor constraints in
AGENTS and verification Skills, and run status in the issue or PR. Before removing
a document or fixture, check its consumers and move any unique current contract
to its existing owner. Keep model sources, configuration, tool locks, coverage maps
and executable fixtures. Generated charts belong in a new external run directory;
retain useful failure originals with their run evidence. Ordinary superseded docs
remain traceable through their exact Git commit. Update links and package guards
in the same change; do not add a parallel archive to the active documentation.

## Build a fresh consumer artifact

```bash
artifact_root=$(mktemp -d)
bun packages/cli/build.ts --outdir "$artifact_root/package"
bun pm pack --cwd "$artifact_root/package" --destination "$artifact_root"
```

An external output directory must not already exist. It contains only the current generated declaration closure and public package dependencies. This avoids carrying old generated files into the tarball. `bun run build` remains available for local development.

Update both [English](README.md) and [简体中文](README.zh-CN.md) entrypoints, the current contract and affected built-in references when public behavior changes. Keep commands, limits and implementation status consistent. Every relative link in a shipped document must resolve inside the package.

PR descriptions should explain the concrete problem, the resulting behavior and the checks that ran. Keep deferred writer or migration work visible rather than adding compatibility paths to make an old fixture pass. A local build or tarball is not a published release. Publishing a registry package, tag or hosted release requires explicit release authorization.
