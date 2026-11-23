# Documentation

Start with the README to create a library and its first Skill. Use the task
guides for later changes and the reference documents for exact behavior.

| Need | Read |
| --- | --- |
| Install, authenticate, create four tables, and read your first Skill | [English quick start](../README.md#quick-start) or [中文快速开始](../README.zh-CN.md#快速开始) |
| Set up an existing library, copy packaged workflows, or inspect interrupted initialization | [Setup](../skills/notion/ntn-skills-maintain/references/setup.md) |
| Discover, read, use, and export content | [Usage](usage.md) |
| Write Skill refs, choose Library context, or copy a local batch | [Reference contract](skill-reference-redesign.md) and [batch import](shared-authoring.md#import-an-explicit-local-batch) |
| Authorize hosted MCP and search remote Notion content | [Remote content search](notion-mcp.md) |
| Create, edit, register, or remove native Skills | [Native authoring](shared-authoring.md#manage-native-skills) |
| Import a complete tree, generate reading pages, or resume a write | [Authoring](shared-authoring.md) |
| Work through an Agent | [Entrypoint Skill](../skills/ntn-skills/SKILL.md) |
| Apply native maintenance instructions | [Maintenance Skill](../skills/notion/ntn-skills-maintain/SKILL.md) |
| Manage Git Sources, file authority, or shared Profile rules | [Profile and Source Skill](../skills/notion/ntn-skills-sync/SKILL.md) |
| Check or synchronize upstream Git from a CLI, SDK or external scheduler | [Source synchronization](source-sync.md) |
| Understand four-table ownership and current implementation limits | [Library contract](current-contract.md) |
| Look up output fields, cache rules, request limits, and local storage | [Protocol](protocol.md) |
| Check implemented behavior and its verification scope | [Maintenance verification](maintenance-verification-review.md) |
| Build or contribute on `next` | [Contributing](../CONTRIBUTING.md) |
| Connect the library to Pi | [pi-context-broker](https://github.com/yoyooyooo/pi-context-broker/blob/next/README.md) |

## Exact command syntax

Use `ntn-skills schema COMMAND...` or the selected command's `--help`. Both
come from the registered parser.

The root commands are `list`, `read`, `use`, `files`, `export`, `schema`, `auth`, and `ctl`.
`auth mcp` manages the independent hosted-search token or OAuth connection.
`ctl library` contains `init`, `inspect`, `files`, `operation`, `skill`, `import`, `import-batch`, `members-plan`,
`projection`, `source`, and the singular `profile` family.

The current CLI does not expose the retired top-level authoring, sync, historical
snapshot, archive, or repair routes. Follow the current guides instead of old
command examples.

## Verification boundaries

The [current-convergence journey](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md)
routes verification to the existing domain checks. Source tests, independent
installed packages, live Notion behavior, and actual Pi use establish different
results. A passing local test does not establish a completed library migration
or an independently verified first-time setup.
