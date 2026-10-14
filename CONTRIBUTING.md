# Contributing

## Development setup

Use Bun 1.4.3 for development and the committed lockfile. The published CLI runs on Node.js 22.19.0 or newer; install Node.js and npm as well for the fresh-consumer checks. Clone the repository, then work from the checkout root:

```bash
git clone https://github.com/yoyooyooo/notion-skills-cli.git
cd notion-skills-cli
bun install --frozen-lockfile
bun run dev --help
bun run check && bun run package:check
```

Use `bun run dev <command>` to exercise the TypeScript CLI entrypoint directly during development; it uses the default official `ntn` transport without requiring a distribution build.

For repeatable live verification, read `.cursor/skills/verify-ntn-skills/SKILL.md` and its feature map in the source checkout. Its executable `control.ts` isolates config/state/cache and XDG bases, records real CLI actions and readback, and preserves evidence while moving owned scratch to system Trash. The map routes the [implemented sync/cache design](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sync-cache-cli-design.md) to acceptance cases; case definitions are not passing results. Live mutations require current task authorization; the npm package excludes these repository-local maintenance files, so unpublished changes must be read from the checkout.

Build and pack a consumer artifact from the checkout root:

```bash
bun run build
node packages/cli/dist/ntn-skills.js --help
mkdir -p release
bun pm pack --cwd packages/cli --destination ../../release
```

The archive filename follows the package version. Consumers install that tarball with npm as described in [the README](README.md#installation). Update source with `git pull --ff-only`, reinstall dependencies and rebuild before producing a new tarball.

`check` runs type checking, formatting checks, tests and the Node.js distribution build. `package:check` validates documentation links, packs the CLI and installs it with npm in a fresh consuming project, then executes the installed binary with Node.js. CI covers Node.js 22 and 24 on Linux and macOS. Run both checks before proposing a pull request or release. Tests must not depend on personal credentials or mutate a live Notion workspace. Keep live verification separate and disclose the environment and authorization used.

CI uses Ubuntu and macOS 15 with Node.js 22.19.0 and 24. Every job runs the complete deterministic suite, then drives package verification through `control.ts init/package`; successful runs retain the installed-consumer outputs and exact tarball. Per-matrix evidence is uploaded for seven days, including available failure records. macOS jobs require `/usr/bin/trash`, exercise real cache retirement and recycle owned scratch. Linux consumers verify `RETENTION_UNAVAILABLE` and unchanged cached bytes; Linux scratch remains on the disposable runner because no recycle capability is implemented. These checks require no live Notion credentials. Before integration, inspect all four checks for the PR's current head, not an earlier main run.

Keep Effect and platform versions aligned at 4.0.4. New commands use `effect/cli`; external execution uses scoped Effect platform capabilities. Pure path and identity transformations remain ordinary TypeScript. Preserve the [JSON and ref contract](docs/protocol.md), explicit discovery coverage and immutable snapshot semantics.

Preserve the Skill naming contract: Notion Name uses ASCII English letters and single spaces (1-64 characters); its lowercase form with spaces replaced by hyphens is the invocation name and must equal the export frontmatter name. Do not introduce independent alias configuration or silently normalize invalid titles. Descriptions and file contents may use any language.

Add behavior tests for plausible consumer-visible failures: ambiguity, pagination, partial discovery, file boundaries, version consistency and permission failure. Avoid asserting implementation text or internal call wiring. A pull request should explain the user-visible problem, resulting behavior and checks actually run. Keep unrelated changes separate.

## Compatibility and deprecation

The 0.x series is experimental. A minor release may change public commands or protocol behavior incompatibly; a patch release preserves existing semantics and provides compatible fixes. Consumers should tolerate additional JSON fields and handle unfamiliar error codes as structured failures. Additional fields or codes must not silently change the meaning of existing fields or successful operations.

Document a deprecation and its replacement in the relevant reference and [CHANGELOG](CHANGELOG.md), including migration steps and the version that removes it. Breaking changes must be called out before consumers upgrade. Update both READMEs ([English](README.md) and [简体中文](README.zh-CN.md)), the [usage guide](docs/usage.md), [protocol documentation](docs/protocol.md), [host integration](docs/host-integration.md) and affected Skill references when public behavior changes. Keep language navigation, commands, release status, capabilities and limits equivalent; detailed guides are maintained in English. Verify README rendering, anchors and packaged language files when the entry structure changes.

## Git and release workflow

Update your checkout with `git pull --ff-only`. Integration is fast-forward only; rebase contributions onto the current target branch rather than creating merge commits. Keep reviewable commits focused on the change.

The private core is bundled into the CLI distribution. Before release, verify the tarball from outside the workspace and follow [the release procedure](docs/releasing.md). Releases use immutable annotated `v<version>` tags; publishing a registry package or creating a hosted repository requires explicit release authorization. A prepared version or local tarball does not establish that a package is published.

## Reporting bugs and vulnerabilities

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for bugs and usage questions. Include the command, sanitized response, runtime and `ntn` versions, expected behavior and a minimal reproduction. Never include credentials, signed URLs, private Skill contents or personal database identifiers in public reports. Report vulnerabilities through [the private channel in SECURITY.md](SECURITY.md#reporting-a-vulnerability).
