---
name: ntn-skills-sync
description: Manage Notion Skill Sources, fixed revisions and Profile/View defaults. Use for Git/GitLab/Linear definitions, refreshing a selected member, HTTP/local resource permissions or an interrupted source operation. Preserve custom Notion files, exact identities and the original operation.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and an existing Notion token; reads need Read content and writes need Insert/Update content. Local retention requires supported system Trash.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Maintain sources and supply rules

Identify the exact library and record first. Sources defines provider input; the Skill selects a fixed revision and Notion owns its metadata and custom files. Use `ntn-skills-maintain` for content edits and `ntn-skills` for consumption.

## Manage an active Source definition

Use `ctl library sources` to manage provider definitions. Sources owns provider/location/ref/selection and its Origin/member binding. `Selected Version` is the separate exact content pin; changing a definition alone does not advance it.

```bash
ntn-skills ctl library sources list --entry LIBRARY_ENTRY
ntn-skills ctl library sources show SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources members SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources check SOURCE_ID --entry LIBRARY_ENTRY
ntn-skills ctl library sources fetch SOURCE_ID --entry LIBRARY_ENTRY --member EXACT_MEMBER --output ./source-files
ntn-skills ctl library sources prepare SOURCE_ID --entry LIBRARY_ENTRY --target SKILL_PAGE_ID --output ./refresh.json
ntn-skills ctl library sources apply ./refresh.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library sources apply ./refresh.json --entry LIBRARY_ENTRY
```

`check/fetch` are read-only provider operations. `prepare` freezes the complete member plus current ownership and content expectations. `apply` retains the exact candidate before selecting it, preserves whole custom files and old pins, and verifies the resulting directory. It does not run scripts, update every member, rewrite native projections or silently follow a branch. Use `sources reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY` to inspect the original selection without repeating it. Never re-create a frozen plan from current text to make an unknown result look complete.

`put --input DEFINITION --expect FINGERPRINT` changes one full configuration; use the fingerprint from `show` or `absent` for a new stable ID. `bind SOURCE_ID --target SKILL_PAGE_ID --member EXACT_MEMBER --expect-origin CURRENT_SOURCE_PAGE_OR_none --entry LIBRARY_ENTRY` changes only association. Providers include generic Git, registry and explicitly mapped Linear issue/document content. Auth stays on the machine. Shared contributor sets require explicit composition, not a single-source overwrite. See [source decisions](references/synchronization.md#active-sources-definitions) before authoring configurations.

## Select a fixed shared source

Use an exact authorized commit and repository-relative root:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY --commit FULL_COMMIT --root skills/example
ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --url https://github.com/OWNER/REPOSITORY --commit FULL_COMMIT --root skills/example
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY \
  --source SOURCE_ID_FROM_REGISTER --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

`FULL_COMMIT` is the complete immutable 40-character Git commit. Register creates the fixed source identity; selection changes only the native Source property. The CLI generates the selection plan. Preserve it unchanged for execution or reconciliation. Use `--native` instead of `--source` when deliberately clearing Source. Use `--dry-run` on selection apply when a preview is needed.

Current consumption uses the selected revision. Updating to a later commit requires that explicit new selection. Customized Notion files retain their whole bodies; delegate an intentional `restore-follow` to content maintenance. Name, Description, Default Context and Router Members stay native Notion metadata.

Advanced HTTP/local composition accepts a fixed plan through `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. Consult its actual help and [source and synchronization decisions](references/synchronization.md). Local Provider bindings are explicit machine/workspace read permissions. Machine roots and signed HTTP retrieval addresses remain machine-only. Never copy credentials or silently upload local resource bytes.

To share an exact complete local snapshot containing restricted local bytes, use `ctl library snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY --allow-local-archive` only within that archive's explicit scope. This authorizes the selected bytes once and preserves durable restrictions; restore-follow's same-named flag covers only its selected body.

## Choose shared Profile and View defaults

```bash
ntn-skills ctl views --database LIBRARY_ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --profile PROFILE_ID --database LIBRARY_ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

Use `profile list` to discover IDs. When changing rules, `profile set` requires the full `--name`, `--enabled true|false` and exact `--base` revision from `show`; `--base new` is for a new Profile. Supply `--default-view VIEW_ID` intentionally: omitting it clears the old default. The machine stores only entry and Profile ID. `profile unbind` leaves shared rules intact.

Explicit `list --view VIEW_ID --database LIBRARY_ENTRY` takes precedence. Without a default View, use the first View in API order. Bare `list` discovers the accessible source scope; follow `next_cursor` while `has_more` is true for the complete observation. Profile/View choices do not grant access or activate workflow bodies; hosts own session selection and first-submission timing.

## Resolve the original operation

Shared source registration uses `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID`; source selection uses `source select reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY`. For a Profile revision, repeat its complete original `profile set` arguments with `--reconcile`. These paths inspect retained original facts without replaying unknown mutations. Current property equality is insufficient proof.

Report verified changed/unchanged results, conflicts and unresolved items separately. Use [source and synchronization decisions](references/synchronization.md) for scoped recovery details.
