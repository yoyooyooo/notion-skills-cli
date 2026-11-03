# Documentation

Start with the repository README in [English](../README.md) or [简体中文](../README.zh-CN.md) for requirements, installation and the first successful read. Source development/build instructions belong to [Contributing](../CONTRIBUTING.md#development-setup). Detailed guides below are maintained in English.

- [Usage guide](usage.md): installation, authentication, discovery, fixed/current reads, one pinned apply for file/metadata changes, source/local connection and recurring runs, publication progress and original-operation recovery, cache policy, upgrade and uninstall.
- [Shared library authoring](shared-authoring.md): ordinary native creation, pinned body/resources/metadata apply, individual file lifecycle, fixed source selection, Profile/View defaults and matching original-operation recovery.
- [Source management](sources-management.md): active provider-neutral Sources, exact Skill/member relationships, Git/GitLab and Linear acquisition, frozen prepare/apply and original-operation reconciliation. Mutable configuration stays separate from fixed content pins.
- [CLI and ref contract](protocol.md): identities, selectors, fixed snapshots, JSON responses, storage, synchronization/recovery, cache boundaries and errors.
- [Saved Skill graphs](graph-releases.md): explicitly retain selected roots and Requires, restore exact history on another machine, and materialize fixed files on demand while preserving complete export verification.
- [Graph preparation performance](graph-preparation-performance.md): request batching, derived directory cache boundaries, reproducible measurements and the limits of each observation.
- [Host integration](host-integration.md): metadata injection, activation state, ordinary `$...@builtin` selection across OMP/Pi/Tern, `/context-broker` session controls and explicit local distribution, plus Read/Write adapters.
- [Historical operator commands](historical-operations.md): retained one-off actions in the independent migration artifact; absent from the daily CLI.
- [Releasing](releasing.md): immutable tags, first publication, Trusted Publishing, registry verification and repair.
- [Independent portable conversion](portable-converter.md): v1 archive inventories, offline preserved-byte conversion, explicit owned remote plan/apply and proof prerequisite; excluded from normal runtime.
- [Entrypoint Skill](../skills/ntn-skills/SKILL.md): discover/read remote workflows and route other tasks; available as `notion/ntn-skills` in the builtin catalog.
- [Content maintenance Skill](../skills/notion/ntn-skills-maintain/SKILL.md): create/update selected shared native content, file identity and portable copies, with the matching shared or earlier Publication recovery path.
- [Synchronization Skill](../skills/notion/ntn-skills-sync/SKILL.md): select fixed shared sources and Profile defaults, maintain existing upstream/local relationships, review conflicts and continue original operations. All three support independent local management; [usage, receipts and identity rules](usage.md#optional-official-skills) keep package installation separate from remote publication.
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md) and [changelog](../CHANGELOG.md): compatibility, maintenance and release status.
- [Sync/cache CLI design](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sync-cache-cli-design.md): repository-only accepted design and rationale for implemented commands; protocol owns current semantics.
- [Sync/cache acceptance matrix](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/sync-cache-verification-plan.md): repository-only acceptance/evidence requirements and [command coverage map](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/README.md#accepted-design-coverage). Runtime outcomes belong in each external run ledger. These maintenance files are excluded from the npm package; use the source checkout while changes are unpublished.

The protocol owns command and response semantics. Host and Skill guidance follows that contract; release claims require the evidence described in the release procedure.
