# Documentation

The [current library contract](current-contract.md) owns current authority, file
descriptors, acquisition, finite operations and remaining cutover work. The
registered CLI parser owns available commands. This `next` line has one current
reader and no old authoring or history fallback.

## Current entrypoints

| Need | Read |
| --- | --- |
| Installation and first current read | [English README](../README.md) or [简体中文](../README.zh-CN.md) |
| Four-table ownership, current fields and implementation boundary | [Current contract](current-contract.md) |
| Current CLI commands and everyday consumption | [Usage](usage.md) |
| Complete input, current import, reading projections and resume | [Authoring](shared-authoring.md) |
| Output contracts, cache, request limits and local storage | [Protocol](protocol.md) |
| Create/inspect a current layout | [Setup](../skills/notion/ntn-skills-maintain/references/setup.md) |
| Agent consumption | [Entrypoint Skill](../skills/ntn-skills/SKILL.md) |
| Current content inspection and authoring availability | [Maintenance Skill](../skills/notion/ntn-skills-maintain/SKILL.md) |
| Current Profiles and Source boundaries | [Profile/Source Skill](../skills/notion/ntn-skills-sync/SKILL.md) |
| Implemented behavior and bounded verification correspondence | [Maintenance verification](maintenance-verification-review.md) |
| Build and contribute | [Contributing](../CONTRIBUTING.md) |

Use `ntn-skills schema COMMAND...` for exact command fields. The current root
contains list/read/use/files/export/schema/ctl. `ctl library` contains init,
inspect, files, import and the singular `profile` family.

## Retired procedures

Earlier authoring, sync, Source onboarding, saved-graph, historical operation,
repair and inventory recipes describe APIs that are being removed. They are no
longer execution guidance for this branch, even if an old file remains in the
repository or a package inventory. Do not follow their create/apply/adopt/archive/
restore steps or use an older binary to make them run.

Current import writes one complete resource tree with full reading projections
and a finite unfinished operation. Source refresh, relationship updates, the
one-time live-data converter and actual library cleanup remain incomplete.
Historical model/coverage files do not certify these replacements. Actual old
document/module/package removal belongs to the same AH-517 cutover; navigation
alone does not establish that cleanup.

The existing [current-convergence journey](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md)
is the verification entry. It reuses six domain checks and records controlled
code, installed packages, live Notion and Pi outcomes separately.
