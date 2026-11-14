# Contributing

## Development setup

Use Bun 1.4.3 for dependency installation, building and the pure test suites, with the committed lockfile. Development and the published CLI run on Node.js 22.22.3+ within 22.x, or Node.js 24.20.0+; install Node.js and npm as well for the real SQLite and fresh-consumer checks. Clone the repository, then work from the checkout root:

```bash
git clone https://github.com/yoyooyooo/notion-skills-cli.git
cd notion-skills-cli
bun install --frozen-lockfile
bun run dev --help
bun run check && bun run package:check
```

Use `bun run scripts/dev.ts <command>` (or `bun run dev <command>`) to run the current TypeScript sources without building or touching `dist`. The thin Bun entry starts Node with a loader only for the existing Markdown text imports. Node executes the same command implementation, Effect HTTP engine and official SQLite driver as the npm package. Arguments, caller working directory, signals and exit status pass through; Bun does not open the production state database.

The normal npm `ntn-skills` executable contains the source-selection shim. With no override it runs its installed bundle, with no subprocess or package-manager lookup. An explicit absolute `NTN_SKILLS_DEV_ROOT` selects a checkout and executes `bun run "$NTN_SKILLS_DEV_ROOT/scripts/dev.ts"`; an invalid root fails rather than silently using another version. Unset the variable to return to the npm package. No dated release directories, alternate global wrappers or version manager are needed.

```bash
ntn-skills --version                         # installed npm package
NTN_SKILLS_DEV_ROOT=/absolute/checkout ntn-skills --help
bun run /absolute/checkout/scripts/dev.ts --help
```

This override is for CLI invocation, not the SDK embedded in a host plugin. Pi normally loads `npm:pi-context-broker` from its own npm package store; use its native package override for Broker development, rather than introducing another launcher. Source paths belong to the explicit development environment, never consumer prompts. See the [host integration contract](docs/host-integration.md).

For repeatable live verification, read `.cursor/skills/verify-ntn-skills/SKILL.md` and its feature map in the source checkout. Its executable `control.ts` isolates credential config/state/cache and XDG bases, records real CLI actions/readback, and preserves evidence while moving owned scratch to system Trash. Builtin verification must also isolate HOME and `NTN_SKILLS_DATA_HOME`/`XDG_DATA_HOME` because installation defaults to shared Agent links. The map routes the [implemented sync/cache design](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sync-cache-cli-design.md) to acceptance cases; definitions are not passing results. Live mutations need current authorization; npm excludes these repository-local files.

Build and pack a consumer artifact from the checkout root:

```bash
bun run build
node packages/cli/dist/ntn-skills.js --help
mkdir -p release
bun pm pack --cwd packages/cli --destination ../../release
```

The archive filename follows the package version. Consumers install that tarball with npm as described in [the README](README.md#installation). Update source with `git pull --ff-only`, reinstall dependencies and rebuild before producing a new tarball.

`check` runs type checking, formatting checks, both test hosts and the Node.js distribution build. `bun run test` runs the Bun suites and the real SQLite/configuration and sync-consumer suites on Node through official `@effect/vitest` 4.0.5 and its Vitest 5 runner; `test:unit` and `test:node` select those lanes individually. Existing database assertions, competing processes, crash rollback, backups and fences execute against the same official SQLite driver as production. The sync suite uses a Node HTTP fixture with the production Node platform and resource finalizers. CLI tests launch Node children. `package:check` validates documentation links, packs the CLI and installs it with npm in a fresh consuming project, then executes the installed binary with Node.js. CI covers Node.js 22 and 24 on Linux and macOS. Run both checks before proposing a pull request or release. Tests must not depend on personal credentials or mutate a live Notion workspace. Keep live verification separate and disclose the environment and authorization used. Modeled domain and argument failures produce JSON; implementation defects retain their Effect cause and Node runtime diagnostics.

CI uses Ubuntu and macOS 15 with Node.js 22.22.3 and 24.20.0. Each job runs `bun run check` and `bun scripts/package-check.ts`, not the local Skill's `control.ts init/package` wrapper. The actual uploads are `ntn-package-check.json`, controlled-authoring and maintenance-pi. A summary's SQLite logical-retirement marker is not proof of physical system Trash. Inspect the relevant workflow results for the exact change; local wrapper outputs and prior cleanup checks retain their own scopes. These deterministic checks require no live Notion credentials.

The compact `packages/core/test/fixtures/router-original/.ntn-skills.json` manifest is a byte-preservation golden input for independent Router round trips. Its original bytes, including whitespace and final newline, are part of the fixture contract. Biome disables formatting for that exact file only; the containing fixture directory, tests and production sources remain in the normal root check.

Builtin transaction tests retain both replaced trees and released lock receipts in their own temporary fixture using the public `ChildProcessSpawner` service boundary. Executable access is checked with the host filesystem, and released fences are renamed only after verifying their fixture ownership; they do not launch macOS Trash for each assertion. The default spawner still exercises system Trash in the real process and installed-consumer suites. Keep process teardown attached to the command Scope and keep the 5-second transaction-test deadline unchanged.

Keep Effect, platform, SQLite and Effect test integration versions aligned at 4.0.5. New commands use `effect/cli`; external execution uses scoped Effect platform capabilities. Pure path and identity transformations remain ordinary TypeScript. Preserve the [JSON and ref contract](docs/protocol.md), explicit discovery coverage and immutable snapshot semantics.

Preserve the [naming contract](docs/protocol.md#identity-and-references): Notion Name and authored frontmatter `name` are exact human-readable values, nonempty and free of control characters. Unicode, digits, spaces and hyphens are allowed. Derive callable aliases separately with NFC normalization, lowercase, surrounding-whitespace trimming, whitespace runs replaced by `-`, and percent-encoding outside Unicode letters, marks, numbers, `_` and `-`. Never rewrite an authored name to its alias or use aliases as stable identity. Alias collisions require exact selectors; title changes preserve page IDs and stable member keys. `--name` is an explicit human-title override. Keep package builtin IDs and slugs unchanged.

Official optional Skill sources live under `skills/notion/<frontmatter-name>/` and are registered explicitly in `packages/cli/src/builtins.ts` with a `notion/<name>` ID. Embed each selected UTF-8 file and ship the same source tree; keep the Skill self-contained with relative internal references. Update the package file inventory and installed consumer smoke when adding files. `builtin` metadata identifies package input, never remote ownership; preserve create-on-first-publish and exact-target update semantics. Keep the existing general bootstrap at `skills/ntn-skills`.

Edit Skill and documentation sources at the repository root. `packages/cli/build.ts` generates `packages/cli/skills`, `docs`, both READMEs, CONTRIBUTING, SECURITY, CHANGELOG, LICENSE and THIRD_PARTY_NOTICES; rebuild these copies rather than editing them directly.

Builtin installation has one writer under the XDG data root, with default shared links and optional additional Agent destinations. Keep version-2 tree receipts and distribution ownership outside transient host profiles; profile receipt-v1 support is a guarded migration input, not another installation path. Exercise default installation, multiple targets, update through links, foreign-target/local-edit protection, status without writes and interrupted migration. Use isolated data/HOME and preserve all replaced bytes through the existing retention capability.

Add behavior tests for plausible consumer-visible failures: ambiguity, pagination, partial discovery, file boundaries, version consistency and permission failure. Avoid asserting implementation text or internal call wiring. A pull request should explain the user-visible problem, resulting behavior and checks actually run. Keep unrelated changes separate.

## Direct source dogfooding

Use one checkout and the existing source-selection shim; no release, dated install directory or upgrade/rollback service is required. Existing global `ntn-skills` users set `NTN_SKILLS_DEV_ROOT` to this checkout. Without that launcher, the equivalent entry is `bun run /absolute/notion-skills-cli/scripts/dev.ts` followed by the same arguments; neither route depends on a maintainer's cache.

Start with your own Notion connection and an owned parent page shared with that connection. Authoring and library creation need write capabilities, while strictly read-only consumption keeps its documented refusal boundary. Store a token through `ctl config set-token --stdin` from a trusted secret source, or set `NOTION_API_TOKEN`; do not put credentials in Broker config or public issue reports.

```sh
export NTN_SKILLS_DEV_ROOT=/absolute/notion-skills-cli
ntn-skills ctl library init --parent YOUR_OWNED_PARENT_PAGE_ID
# Copy the returned entry/database ID; do not hand-build the library tables.
ntn-skills create ./my-skill --database ENTRY_FROM_INIT
ntn-skills list --database ENTRY_FROM_INIT --query my-skill
ntn-skills use REF_FROM_LIST --database ENTRY_FROM_INIT
```

`./my-skill/SKILL.md` needs normal name/description frontmatter and your instructions; supporting files can live in `references/`. Create/read return exact refs for later `write` or `apply`; copy those refs instead of guessing IDs. See [shared authoring](docs/shared-authoring.md) for editing and pending-operation handling.

For Pi, build this CLI once, then build the existing Broker against it. The CLI shim does **not** automatically replace the Broker's embedded SDK:

```sh
cd /absolute/notion-skills-cli
bun run build
cd /absolute/pi-context-broker
bun install --frozen-lockfile
NTN_SKILLS_BUILD_ENTRY=/absolute/notion-skills-cli/packages/cli/dist/ntn-skills.js bun run build:broker
pi install /absolute/pi-context-broker/packages/context-broker
```

Keep only one Broker package entry in Pi; use `pi remove OLD_BROKER_SOURCE` for a previous entry, preserving other extensions. Configure its Notion source with your entry ID as in the [Broker quick start](https://github.com/yoyooyooo/pi-context-broker#quick-start), then open a new Pi session. Existing sessions are not restarted by editing this configuration. When CLI/SDK implementation changes, rebuild the CLI and `build:broker` at the same paths; source-only CLI invocation needs no rebuild. Test the changed path and inspect the actual Session when integration changes, rather than rerunning every host/model or preparing a new release.

## Documentation and verification records

Keep user documentation focused on supported behavior, examples and durable design decisions. Keep verification Skills as executable recipes, with negative cases and evidence requirements. Store dated run ledgers, candidate hashes, private machine paths and raw failures outside the checkout; link a public issue or CI run only when it adds needed context. Removing a superseded report from the tree does not change its historical result. Do not remove regression tests or relax acceptance criteria as part of documentation cleanup.

## Compatibility and deprecation

The 0.x series is experimental. A minor release may change public commands or protocol behavior incompatibly; a patch release preserves existing semantics and provides compatible fixes. Consumers should tolerate additional JSON fields and handle unfamiliar error codes as structured failures. Additional fields or codes must not silently change the meaning of existing fields or successful operations.

Document a deprecation and its replacement in the relevant reference and [CHANGELOG](CHANGELOG.md), including migration steps and the version that removes it. Breaking changes must be called out before consumers upgrade. Update both READMEs ([English](README.md) and [简体中文](README.zh-CN.md)), the [usage guide](docs/usage.md), [protocol documentation](docs/protocol.md), [host integration](docs/host-integration.md) and affected Skill references when public behavior changes. Keep language navigation, commands, release status, capabilities and limits equivalent; detailed guides are maintained in English. Verify README rendering, anchors and packaged language files when the entry structure changes.

## Git and release workflow

Update your checkout with `git pull --ff-only`. Integration is fast-forward only; rebase contributions onto the current target branch rather than creating merge commits. Keep reviewable commits focused on the change.

The private core is bundled into the CLI distribution. Before release, verify the tarball from outside the workspace and follow [the release procedure](docs/releasing.md). Releases use immutable annotated `v<version>` tags; publishing a registry package or creating a hosted repository requires explicit release authorization. A prepared version or local tarball does not establish that a package is published.

## Reporting bugs and vulnerabilities

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for bugs and usage questions. Include the command, sanitized response, Node and package versions, expected behavior and a minimal reproduction. Never include credentials, signed URLs, private Skill contents or personal database identifiers in public reports. Report vulnerabilities through [the private channel in SECURITY.md](SECURITY.md#reporting-a-vulnerability).
