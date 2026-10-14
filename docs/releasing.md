# Releasing

The public package and executable are `ntn-skills`, running on Node.js 22.19.0 or newer. The source repository remains `yoyooyooo/notion-skills-cli`. Only `packages/cli` is published. `packages/core` stays private, and both package versions are kept equal. Development and packing use Bun 1.4.3; CI installs the tarball with npm and exercises it on Node.js 22 and 24 on Linux and macOS.

Releases push an annotated tag and publish through GitHub Actions OIDC. The repository can remain private. npm provenance is enabled and verified only for public repositories; private releases retain registry integrity, signatures and consumer checks.

## Before a release

Use a clean checkout of `main`, with `origin` pointing to `yoyooyooo/notion-skills-cli`. Install Bun 1.4.3, Node 24, npm 11.15.0 or newer, Git, and GitHub CLI. Configure Git author identity and permission to push tags. npm registry reads must work; an unavailable registry stops the release.

```sh
bun install --frozen-lockfile
bun run release:precheck 0.1.1
bun run package:check
```

Replace `0.1.1` with the intended version. Precheck fetches remote state, reads published versions, checks the clean branch and exact `HEAD == origin/main`, and runs `bun run check`. It creates no release commit or tag. `--dry-run` prints the decision without running the quality check. Both modes fetch Git refs. `package:check` creates a Bun tarball, inspects its contents, and installs it with npm into a fresh consumer for Node.js CLI and offline snapshot checks. Registry readback uses the same Node.js consumer path.

Before integration, require all four CI jobs for the PR's current head: Ubuntu and macOS 15, each with Node.js 22.19.0 and 24. Jobs run the full deterministic suite and controller-driven installed-consumer verification, then upload seven-day evidence artifacts. macOS exercises system Trash; Linux proves explicit unavailable-retention failure with preserved bytes. Real Notion acceptance remains separate and must not use PR secrets. The tag publication job repeats `check` and package verification on Linux/Node 24; it does not replace the PR's macOS/runtime matrix.

Use explicit versions for prereleases, for example `0.2.0-rc.1`. They publish to `next`; stable versions publish to `latest`. Versions use SemVer without build metadata. A version must exceed every previously tagged or published release. `patch`, `minor`, and `major` choose a bump from the highest known version; bumping from a prerelease requires an explicit version.

## First npm publication

`0.1.0` was published with maintainer web authentication. Subsequent releases use the Trusted Publisher below. Published versions cannot be replaced.

## Configure npm Trusted Publishing

Open [the package Access page](https://www.npmjs.com/package/ntn-skills/access) after the first version is visible. Add a GitHub Actions Trusted Publisher with these exact fields:

| npm field | Value |
| --- | --- |
| Organization or user | `yoyooyooo` |
| Repository | `notion-skills-cli` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed action | Allow `npm publish` |

The owner is the GitHub owner, which can differ from the npm username. The workflow does not set a GitHub environment. It uses a GitHub-hosted runner with `id-token: write`, Node 24, and npm 11.15.0. It does not use package-manager cache, `registry-url` in setup-node, or `NODE_AUTH_TOKEN`. Do not add npm tokens to Actions secrets.

Read the configuration back with `npm trust list ntn-skills`, or inspect the authenticated Access page if terminal 2FA is unavailable. A new configuration must complete its first successful OIDC publish within two days; otherwise delete the expired connection and recreate it. The "not yet validated" status means no publish has used that connection yet.

## Automated releases

Commit and integrate source changes into `origin/main` before releasing. The checkout must be clean and match that remote branch.

Release a patch or an explicit prerelease:

```sh
bun run release patch
# Or an explicit prerelease:
bun run release 0.2.0-rc.1
```

The script creates a temporary `release/` branch from the exact fetched `origin/main`, changes only the two package versions and `bun.lock`, runs the local quality check, creates an annotated `v<version>` tag, and pushes only that tag. It never runs `npm publish`. The version commit stays off `main`. On success it returns to the original branch and removes only the temporary branch ref; the tag preserves the commit. On failure it preserves the branch and files for inspection. It never resets, restores, cleans, deletes files, or moves a tag.

The workflow proves tag/version equality, valid SemVer, synchronized versions, an annotated tag, one release parent, authorized changed paths, and version-only package JSON changes. A first publication requires the parent to equal current `origin/main`. A repair permits an older parent only while it remains an ancestor of `origin/main`.

After quality and fresh consumer checks, the workflow packs and inspects the actual tarball, hashes it, and publishes it through npm OIDC. All tags share one non-cancelling publication queue. Registry readback proves name, version, channel and integrity. Public-repository releases additionally verify provenance against the digest, repository, workflow, tag and commit. Private-repository releases disable provenance because npm does not support it. A fresh registry install and signature check precede GitHub Release creation.

Release notes use the previous published version's tag when available and group Conventional Commits. The workflow does not rewrite `CHANGELOG.md`; maintainers update it in normal source changes.

## Failure and repair

Pushed tags are immutable, including failed tags. If publication failed before npm accepted the version, fix the source or publisher configuration on `main` and choose a higher version. Do not delete or force-push the tag. Registry read errors are not evidence that a version is absent.

If npm accepted the version but a later verification or GitHub Release step failed, rerun against the original tag:

```sh
gh workflow run publish.yml --repo yoyooyooo/notion-skills-cli --ref v0.1.1 -f tag=v0.1.1
```

Manual dispatch is repair-only and requires that exact tag as the workflow ref and an already published npm version. A run retry refuses to publish an unpublished failed tag. An existing version skips publication and repeats archive, registry integrity, signatures and consumer checks, plus provenance for public repositories, before repairing its Release. A changed artifact fails verification.

For a repair after a newer version has shipped, the selected dist-tag may already point to a higher version. The workflow accepts that forward state, verifies the older exact artifact, and never moves a dist-tag backward. A fresh publication must advance its selected channel.

## Deprecation, security patches, and withdrawal

The maintainer handles registry changes, release corrections, and security coordination. Report vulnerabilities through [SECURITY.md](../SECURITY.md). Prepare a fix through normal review, release a higher patch version, and describe the affected versions and upgrade path without exposing credentials or private reports.

Deprecation changes registry metadata and requires approval. For an affected version, use a precise, actionable message:

```sh
npm deprecate ntn-skills@0.1.1 "Security issue fixed in 0.1.2; upgrade to 0.1.2 or newer." --registry https://registry.npmjs.org
npm view ntn-skills@0.1.1 deprecated --registry https://registry.npmjs.org
```

Replace the versions and message with the verified incident facts. Prefer a patch and deprecation to withdrawal. If a compromised archive or exposed secret requires removal, follow npm's unpublish policy and obtain explicit incident approval before running `npm unpublish ntn-skills@VERSION --registry https://registry.npmjs.org`. Never unpublish as routine rollback. Rotate exposed credentials independently of package withdrawal. Published version numbers and their Git tags remain permanently reserved.

## Local boundary exercises

Use a disposable repository and a local bare `origin` to exercise release behavior without external publication. Copy the real release script and config, commit a minimal workspace fixture to `main`, push that fixture to its local origin, and provide a fake `npm` executable that returns controlled `npm view` results. `--no-push` creates only local tags. `--skip-local-check` and `--allow-branch` are accepted only with `--no-push` for such fixtures; production publication always runs the configured local check and exact remote-base gate.

Useful cases include clean success, dirty tree rejection, version mismatch, remote-main drift, invalid SemVer, explicit prerelease, forbidden repeat tag, registry error, check-created unauthorized files, and a local failure preserving its branch. The evidence helper supports `version VERSION`, `manifest PACKED_JSON`, and `channel VERSION CHANNEL_VERSION ALREADY_PUBLISHED` for controlled SemVer, packed-manifest, and forward-channel repair cases. These fixtures do not prove npm OIDC or GitHub Release behavior; that evidence comes from a separately authorized real release.
