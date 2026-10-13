# Releasing

The public package is `notion-skills-cli`; its executable is `ntn-skills`. Only `packages/cli` is published. `packages/core` stays private, and both package versions are kept equal. Development and packing use Bun 1.4.3; CI also exercises the packed CLI on Bun 1.3.0 on Linux and macOS.

This repository contains a release procedure, not evidence that npm publication or Trusted Publishing has already succeeded. Publishing requires a separate, explicit maintainer approval. Creating or pushing a release tag starts a publication workflow, so treat that operation as publication approval too.

## Before a release

Use a clean checkout of `main`, with `origin` pointing to `yoyooyooo/notion-skills-cli`. Install Bun 1.4.3, Node 24, npm 11.15.0 or newer, Git, and GitHub CLI. Configure Git author identity and permission to push tags. npm registry reads must work; an unavailable registry stops the release.

```sh
bun install --frozen-lockfile
bun run release:precheck 0.1.1
bun run package:check
```

Replace `0.1.1` with the intended version. Precheck fetches remote state, reads published versions, checks the clean branch and exact `HEAD == origin/main`, and runs `bun run check`. It creates no release commit or tag. `--dry-run` prints the decision without running the quality check. Both modes fetch Git refs. `package:check` creates a Bun tarball, inspects its contents, and installs it into a fresh consumer for CLI and offline snapshot checks.

Use explicit versions for prereleases, for example `0.2.0-rc.1`. They publish to `next`; stable versions publish to `latest`. Versions use SemVer without build metadata. A version must exceed every previously tagged or published release. `patch`, `minor`, and `major` choose a bump from the highest known version; bumping from a prerelease requires an explicit version.

## First npm publication

A new npm package name cannot have a Trusted Publisher until its first version exists. The first release is an interactive, official-registry web-auth publication by a maintainer. The generic `npm-publish` procedure applies here; AGS changeset commands and AGS package filters do not apply.

Obtain explicit approval for the package name, exact version, and tarball before publishing. For the first version, prepare the immutable release commit locally without pushing its tag:

```sh
bun run release 0.1.0 --no-push
```

The local `--no-push` preparation enforces a clean source checkout and `HEAD == origin/main`, aligned versions, registry version availability, the quality gate, and changes limited to configured version/lock files. It creates a local annotated tag for inspection; permission to publish that tag is still separate. Before packing, record `git rev-parse v0.1.0^{commit}`, `git rev-list --parents -n 1 v0.1.0`, and `git diff-tree --no-commit-id --name-only -r v0.1.0`. Confirm its single parent is the exact fetched `origin/main`, its only changed paths are the two configured manifests and `bun.lock`, its manifests both contain `0.1.0`, and each manifest differs from its parent only in top-level `version`. Preserve those results with the tarball hash and registry evidence.

The first exact version may match the version already on `main`; the script still creates a release commit with one parent. The script returns to `main` and retains the annotated local tag. Create a separate checkout of that tag for packing, so the published archive comes from its exact tree:

```sh
git worktree add --detach ../notion-skills-cli-first-release v0.1.0
cd ../notion-skills-cli-first-release
bun install --frozen-lockfile
bun run check
bun run package:check
```

`package:check` prints a JSON result containing `archive`, `integrity`, `name`, and `version`. Use that exact absolute archive path for the approved publication. Authenticate interactively and confirm the account first:

```sh
npm login --auth-type=web --registry https://registry.npmjs.org
npm whoami --registry https://registry.npmjs.org
npm publish /absolute/path/from/package-check.json --access public --tag latest --registry https://registry.npmjs.org
```

The last command is an external publication and must wait for its own approval. Do not use directory `npm publish`, a dummy first version, saved tokens, or `--provenance` for this local bootstrap: GitHub Actions provenance is established by subsequent tag workflows.

Read back the exact package before creating its GitHub Release:

```sh
npm view notion-skills-cli@0.1.0 name version dist.integrity --json --registry https://registry.npmjs.org
npm view notion-skills-cli dist-tags --json --registry https://registry.npmjs.org
bun scripts/package-smoke.ts --registry notion-skills-cli@0.1.0
```

Compare registry integrity against the approved tarball's `integrity`. Allow several minutes for registry visibility. Once these checks succeed, configure the Trusted Publisher below. The bootstrap version has no Actions provenance, so the provenance-required repair workflow rejects it. Complete its public tag and GitHub Release only after separate approval for this bootstrap exception:

The following example runs only after exact registry name/version/integrity and `latest` readback, a successful fresh registry consumer, and approval for both the tag and Release. Record the workflow state before disabling it. Use a shell trap to restore it even if the push or Release fails:

```sh
set -eu
restore_publish() {
  gh workflow enable publish.yml --repo yoyooyooo/notion-skills-cli
  gh api repos/yoyooyooo/notion-skills-cli/actions/workflows/publish.yml --jq .state
}
trap restore_publish EXIT
gh workflow disable publish.yml --repo yoyooyooo/notion-skills-cli
test "$(gh api repos/yoyooyooo/notion-skills-cli/actions/workflows/publish.yml --jq .state)" = disabled_manually
git push origin refs/tags/v0.1.0
gh release create v0.1.0 --repo yoyooyooo/notion-skills-cli --verify-tag --title v0.1.0 --notes "First release, published with maintainer web authentication. This bootstrap version has no GitHub Actions provenance." --latest=false
```

Run from the checkout containing the approved annotated tag and correct `origin`. Inspect the restoration readback even after a failure; restore manually if it is not `active`. Preserve the tag if the Release fails. This workflow-disable exception applies only to the first local web-auth version. Later automated releases use higher versions and require full provenance. Manual repair is available only for versions with this automated lane's provenance.

## Configure npm Trusted Publishing

Open [the package Access page](https://www.npmjs.com/package/notion-skills-cli/access) after the first version is visible. Add a GitHub Actions Trusted Publisher with these exact fields:

| npm field | Value |
| --- | --- |
| Organization or user | `yoyooyooo` |
| Repository | `notion-skills-cli` |
| Workflow filename | `publish.yml` |
| Environment | Leave empty |
| Allowed action | Allow `npm publish` |

The owner is the GitHub owner, which can differ from the npm username. The workflow does not set a GitHub environment. It uses a GitHub-hosted runner with `id-token: write`, Node 24, and npm 11.15.0. It does not use package-manager cache, `registry-url` in setup-node, or `NODE_AUTH_TOKEN`. Do not add npm tokens to Actions secrets.

Read the configuration back with `npm trust list notion-skills-cli`. If the terminal cannot complete 2FA, inspect the authenticated Access page. Configuration readback alone does not prove that an OIDC publication works. The first authorized automated release must also pass registry, integrity, provenance, consumer, and GitHub Release checks.

## Automated releases

After approval for a release:

```sh
bun run release patch
# Or an explicit prerelease:
bun run release 0.2.0-rc.1
```

The script creates a temporary `release/` branch from the exact fetched `origin/main`, changes only the two package versions and `bun.lock`, runs the local quality check, creates an annotated `v<version>` tag, and pushes only that tag. It never runs `npm publish`. The version commit stays off `main`. On success it returns to the original branch and removes only the temporary branch ref; the tag preserves the commit. On failure it preserves the branch and files for inspection. It never resets, restores, cleans, deletes files, or moves a tag.

The workflow proves tag/version equality, valid SemVer, synchronized versions, an annotated tag, one release parent, authorized changed paths, and version-only package JSON changes. A first publication requires the parent to equal current `origin/main`. A repair permits an older parent only while it remains an ancestor of `origin/main`.

After quality and fresh consumer checks, the workflow runs `bun pm pack`, inspects the actual packed manifest for unresolved `catalog:` and `workspace:` references, hashes that archive, and publishes that archive through npm OIDC. All tag refs share one non-cancelling publication queue. npm readback retries for roughly five minutes, proving name, version, selected channel, integrity, and provenance bound to the package digest, repository, workflow, tag ref, and commit. A fresh registry install and npm signature verification run before a separate job can create the GitHub Release. GitHub Releases are created without changing the repository's latest-release marker, including during repairs.

Release notes use the previous published version's tag when available and group Conventional Commits. The workflow does not rewrite `CHANGELOG.md`; maintainers update it in normal source changes.

## Failure and repair

Pushed tags are immutable, including failed tags. If publication failed before npm accepted the version, fix the source or publisher configuration on `main` and choose a higher version. Do not delete or force-push the tag. Registry read errors are not evidence that a version is absent.

If npm accepted the version but a later verification or GitHub Release step failed, rerun against the original tag:

```sh
gh workflow run publish.yml --repo yoyooyooo/notion-skills-cli --ref v0.1.1 -f tag=v0.1.1
```

Manual dispatch is repair-only and requires that exact tag as the workflow ref and an already published npm version. A run retry also refuses to publish an unpublished failed tag. An existing version skips `npm publish`, then repeats the archive, registry integrity, provenance, signature, and clean install checks before repairing its Release. A changed artifact or wrong provenance fails rather than overwriting publication evidence.

For a repair after a newer version has shipped, the selected dist-tag may already point to a higher version. The workflow accepts that forward state, verifies the older exact artifact, and never moves a dist-tag backward. A fresh publication must advance its selected channel.

## Deprecation, security patches, and withdrawal

The maintainer handles registry changes, release corrections, and security coordination. Report vulnerabilities through [SECURITY.md](../SECURITY.md). Prepare a fix through normal review, release a higher patch version, and describe the affected versions and upgrade path without exposing credentials or private reports.

Deprecation changes registry metadata and requires approval. For an affected version, use a precise, actionable message:

```sh
npm deprecate notion-skills-cli@0.1.1 "Security issue fixed in 0.1.2; upgrade to 0.1.2 or newer." --registry https://registry.npmjs.org
npm view notion-skills-cli@0.1.1 deprecated --registry https://registry.npmjs.org
```

Replace the versions and message with the verified incident facts. Prefer a patch and deprecation to withdrawal. If a compromised archive or exposed secret requires removal, follow npm's unpublish policy and obtain explicit incident approval before running `npm unpublish notion-skills-cli@VERSION --registry https://registry.npmjs.org`. Never unpublish as routine rollback. Rotate exposed credentials independently of package withdrawal. Published version numbers and their Git tags remain permanently reserved.

## Local boundary exercises

Use a disposable repository and a local bare `origin` to exercise release behavior without external publication. Copy the real release script and config, commit a minimal workspace fixture to `main`, push that fixture to its local origin, and provide a fake `npm` executable that returns controlled `npm view` results. `--no-push` creates only local tags. `--skip-local-check` and `--allow-branch` are accepted only with `--no-push` for such fixtures; production publication always runs the configured local check and exact remote-base gate.

Useful cases include clean success, dirty tree rejection, version mismatch, remote-main drift, invalid SemVer, explicit prerelease, forbidden repeat tag, registry error, check-created unauthorized files, and a local failure preserving its branch. The evidence helper supports `version VERSION`, `manifest PACKED_JSON`, and `channel VERSION CHANNEL_VERSION ALREADY_PUBLISHED` for controlled SemVer, packed-manifest, and forward-channel repair cases. These fixtures do not prove npm OIDC or GitHub Release behavior; that evidence comes from a separately authorized real release.
