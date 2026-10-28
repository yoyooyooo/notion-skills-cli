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

Use `bun run dev <command>` to build the current sources and execute the freshly built CLI with Node.js. Successful builds stay silent; failed builds report diagnostics on stderr and stop the command. Argv and exit status pass through to the same production entrypoint used by the package. It uses the default official `ntn` transport. The official SQLite driver uses `node:sqlite`; running the product through Bun is unsupported.

A developer-owned global `ntn-skills` shim can use `exec bun run --silent "/absolute/checkout/scripts/dev.ts" "$@"`. Configure consumer hosts with `command: [ntn-skills]` and launch them in a neutral workspace outside the source checkout. The shim owns the implementation path; consumer prompts need only the public command and selected refs. See the [host integration contract](docs/host-integration.md).

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

CI uses Ubuntu and macOS 15 with Node.js 22.22.3 and 24.20.0. Every job runs the complete deterministic suite, then drives package verification through `control.ts init/package`; successful runs retain the installed-consumer outputs and exact tarball. Per-matrix evidence is uploaded for seven days, including available failure records. macOS jobs require `/usr/bin/trash`, exercise real cache retirement and recycle owned scratch. Linux consumers verify `RETENTION_UNAVAILABLE` and unchanged cached bytes; Linux scratch remains on the disposable runner because no recycle capability is implemented. These checks require no live Notion credentials. Before integration, inspect all four checks for the PR's current head, not an earlier main run.

The compact `packages/core/test/fixtures/router-original/.ntn-skills.json` manifest is a byte-preservation golden input for independent Router round trips. Its original bytes, including whitespace and final newline, are part of the fixture contract. Biome disables formatting for that exact file only; the containing fixture directory, tests and production sources remain in the normal root check.

Builtin transaction tests retain both replaced trees and released lock receipts in their own temporary fixture using the public `ChildProcessSpawner` service boundary. Executable access is checked with the host filesystem, and released fences are renamed only after verifying their fixture ownership; they do not launch macOS Trash for each assertion. The default spawner still exercises system Trash in the real process and installed-consumer suites. Keep process teardown attached to the command Scope and keep the 5-second transaction-test deadline unchanged.

Keep Effect, platform, SQLite and Effect test integration versions aligned at 4.0.5. New commands use `effect/cli`; external execution uses scoped Effect platform capabilities. Pure path and identity transformations remain ordinary TypeScript. Preserve the [JSON and ref contract](docs/protocol.md), explicit discovery coverage and immutable snapshot semantics.

Preserve the [naming contract](docs/protocol.md#identity-and-references): Notion Name and authored frontmatter `name` are exact human-readable values, nonempty and free of control characters. Unicode, digits, spaces and hyphens are allowed. Derive callable aliases separately with NFC normalization, lowercase, surrounding-whitespace trimming, whitespace runs replaced by `-`, and percent-encoding outside Unicode letters, marks, numbers, `_` and `-`. Never rewrite an authored name to its alias or use aliases as stable identity. Alias collisions require exact selectors; title changes preserve page IDs and stable member keys. `--name` is an explicit human-title override. Keep package builtin IDs and slugs unchanged.

Official optional Skill sources live under `skills/notion/<frontmatter-name>/` and are registered explicitly in `packages/cli/src/builtins.ts` with a `notion/<name>` ID. Embed each selected UTF-8 file and ship the same source tree; keep the Skill self-contained with relative internal references. Update the package file inventory and installed consumer smoke when adding files. `builtin` metadata identifies package input, never remote ownership; preserve create-on-first-publish and exact-target update semantics. Keep the existing general bootstrap at `skills/ntn-skills`.

Edit Skill and documentation sources at the repository root. `packages/cli/build.ts` generates `packages/cli/skills`, `docs`, both READMEs, CONTRIBUTING, SECURITY, CHANGELOG, LICENSE and THIRD_PARTY_NOTICES; rebuild these copies rather than editing them directly.

Builtin installation has one writer under the XDG data root, with default shared links and optional additional Agent destinations. Keep version-2 tree receipts and distribution ownership outside transient host profiles; profile receipt-v1 support is a guarded migration input, not another installation path. Exercise default installation, multiple targets, update through links, foreign-target/local-edit protection, status without writes and interrupted migration. Use isolated data/HOME and preserve all replaced bytes through the existing retention capability.

Add behavior tests for plausible consumer-visible failures: ambiguity, pagination, partial discovery, file boundaries, version consistency and permission failure. Avoid asserting implementation text or internal call wiring. A pull request should explain the user-visible problem, resulting behavior and checks actually run. Keep unrelated changes separate.

## Compatibility and deprecation

The 0.x series is experimental. A minor release may change public commands or protocol behavior incompatibly; a patch release preserves existing semantics and provides compatible fixes. Consumers should tolerate additional JSON fields and handle unfamiliar error codes as structured failures. Additional fields or codes must not silently change the meaning of existing fields or successful operations.

Document a deprecation and its replacement in the relevant reference and [CHANGELOG](CHANGELOG.md), including migration steps and the version that removes it. Breaking changes must be called out before consumers upgrade. Update both READMEs ([English](README.md) and [简体中文](README.zh-CN.md)), the [usage guide](docs/usage.md), [protocol documentation](docs/protocol.md), [host integration](docs/host-integration.md) and affected Skill references when public behavior changes. Keep language navigation, commands, release status, capabilities and limits equivalent; detailed guides are maintained in English. Verify README rendering, anchors and packaged language files when the entry structure changes.

## Git and release workflow

Update your checkout with `git pull --ff-only`. Integration is fast-forward only; rebase contributions onto the current target branch rather than creating merge commits. Keep reviewable commits focused on the change.

The private core is bundled into the CLI distribution. Before release, verify the tarball from outside the workspace and follow [the release procedure](docs/releasing.md). Releases use immutable annotated `v<version>` tags; publishing a registry package or creating a hosted repository requires explicit release authorization. A prepared version or local tarball does not establish that a package is published.

## Reporting bugs and vulnerabilities

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for bugs and usage questions. Include the command, sanitized response, runtime and `ntn` versions, expected behavior and a minimal reproduction. Never include credentials, signed URLs, private Skill contents or personal database identifiers in public reports. Report vulnerabilities through [the private channel in SECURITY.md](SECURITY.md#reporting-a-vulnerability).
