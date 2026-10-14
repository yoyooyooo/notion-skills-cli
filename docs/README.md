# Documentation

Start with the repository README in [English](../README.md) or [简体中文](../README.zh-CN.md) for requirements, installation and the first successful read. Source development/build instructions belong to [Contributing](../CONTRIBUTING.md#development-setup). Detailed guides below are maintained in English.

- [Usage guide](usage.md): installation, authentication, discovery, fixed/current reads, import/export/write, checked local synchronization, cache policy, upgrade and uninstall.
- [CLI and ref contract](protocol.md): identities, selectors, fixed snapshots, JSON responses, storage, synchronization/recovery, cache boundaries and errors.
- [Host integration](host-integration.md): metadata injection, activation state and optional Read/Write adapters.
- [Releasing](releasing.md): immutable tags, first publication, Trusted Publishing, registry verification and repair.
- [Bootstrap Skill](../skills/ntn-skills/SKILL.md): progressive discovery and consumption from an Agent's shell tools.
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md) and [changelog](../CHANGELOG.md): compatibility, maintenance and release status.
- [Sync/cache CLI design](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sync-cache-cli-design.md): repository-only accepted design and rationale for implemented commands; protocol owns current semantics.
- [Sync/cache acceptance matrix](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/sync-cache-verification-plan.md): repository-only acceptance/evidence requirements and [command coverage map](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/README.md#accepted-design-coverage). Runtime outcomes belong in each external run ledger. These maintenance files are excluded from the npm package; use the source checkout while changes are unpublished.

The protocol owns command and response semantics. Host and Skill guidance follows that contract; release claims require the evidence described in the release procedure.
