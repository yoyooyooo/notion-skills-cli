# Contributing

Use Bun 1.4.3 for development and the committed lockfile. The CLI's minimum runtime is Bun 1.3.0. From the checkout root:

```bash
bun install --frozen-lockfile
bun run check && bun run package:check
bun run dev --help
```

`check` runs type checking, formatting checks, tests and the distribution build. `package:check` validates documentation links, packs the CLI and installs it in a fresh consuming project for a smoke check. Run both before proposing a pull request or release. Tests must not depend on personal credentials or mutate a live Notion workspace. Keep live verification separate and disclose the environment and authorization used.

Keep Effect and platform versions aligned at 4.0.4. New commands use `effect/cli`; external execution uses scoped Effect platform capabilities. Pure path and identity transformations remain ordinary TypeScript. Preserve the [JSON and ref contract](docs/protocol.md), explicit discovery coverage and immutable snapshot semantics.

Preserve the Skill naming contract: Notion Name uses ASCII English letters and single spaces (1-64 characters); its lowercase form with spaces replaced by hyphens is the invocation name and must equal the export frontmatter name. Do not introduce independent alias configuration or silently normalize invalid titles. Descriptions and file contents may use any language.

Add behavior tests for plausible consumer-visible failures: ambiguity, pagination, partial discovery, file boundaries, version consistency and permission failure. Avoid asserting implementation text or internal call wiring. A pull request should explain the user-visible problem, resulting behavior and checks actually run. Keep unrelated changes separate.

## Compatibility and deprecation

The 0.x series is experimental. A minor release may change public commands or protocol behavior incompatibly; a patch release preserves existing semantics and provides compatible fixes. Consumers should tolerate additional JSON fields and handle unfamiliar error codes as structured failures. Additional fields or codes must not silently change the meaning of existing fields or successful operations.

Document a deprecation and its replacement in the relevant reference and [CHANGELOG](CHANGELOG.md), including migration steps and the version that removes it. Breaking changes must be called out before consumers upgrade. Update [README](README.md), [protocol documentation](docs/protocol.md), [host integration](docs/host-integration.md) and affected Skill references when public behavior changes.

## Git and release workflow

Update your checkout with `git pull --ff-only`. Integration is fast-forward only; rebase contributions onto the current target branch rather than creating merge commits. Keep reviewable commits focused on the change.

The private core is bundled into the CLI distribution. Before release, verify the tarball from outside the workspace and follow [the release procedure](docs/releasing.md). Releases use immutable annotated `v<version>` tags; publishing a registry package or creating a hosted repository requires explicit release authorization. A prepared version or local tarball does not establish that a package is published.

## Reporting bugs and vulnerabilities

Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for bugs and usage questions. Include the command, sanitized response, runtime and `ntn` versions, expected behavior and a minimal reproduction. Never include credentials, signed URLs, private Skill contents or personal database identifiers in public reports. Report vulnerabilities through [the private channel in SECURITY.md](SECURITY.md#reporting-a-vulnerability).
