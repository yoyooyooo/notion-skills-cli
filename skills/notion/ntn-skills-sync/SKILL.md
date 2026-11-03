---
name: ntn-skills-sync
description: Manage active Git/GitLab/Linear source definitions, explicitly refresh one bound Skill, and select fixed Git/HTTP/local sources or shared Profile/View defaults for a Notion Skill library, or maintain existing upstream subscriptions and local synchronization bindings. Use for source revisions, shared supply rules, local resource scopes, recurring legacy sync or interrupted operations. Keep exact identities and original plans; report each affected item.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and an existing Notion token; reads need Read content and writes need Insert/Update content. Local replacement requires supported system Trash retention.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Maintain sources and supply rules

Identify the selected library and record first. A `shared_skill` locator uses shared native Source/Profile rules. Existing upstream subscriptions and local sync bindings keep their earlier workflows until explicitly migrated. One-time content edits belong to `ntn-skills-maintain`; consuming a remote workflow needs no sync binding.

## Manage an active Source definition

For the four-table shared library, use `ctl library sources`, not the retired library's `sync upstream` subscription path. Sources owns provider/location/ref/selection and its Origin/member binding. `Selected Version` is the separate exact content pin; changing a definition alone does not advance it.

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

Advanced HTTP/local composition accepts a fixed plan through `ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON`. Consult its actual help and [source and synchronization decisions](references/synchronization.md). Local Provider bindings are explicit machine/workspace read permissions, separate from old two-way sync bindings. Machine roots and signed HTTP retrieval addresses remain machine-only. Never copy credentials or silently upload local resource bytes.

To share an exact complete local snapshot containing restricted local bytes, use `ctl library snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY --allow-local-archive` only within that archive's explicit scope. This authorizes the selected bytes once and preserves durable restrictions; restore-follow's same-named flag covers only its selected body.

## Choose shared Profile and View defaults

```bash
ntn-skills views --database LIBRARY_ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --profile PROFILE_ID --database LIBRARY_ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

Use `profile list` to discover IDs. When changing rules, `profile set` requires the full `--name`, `--enabled true|false` and exact `--base` revision from `show`; `--base new` is for a new Profile. Supply `--default-view VIEW_ID` intentionally: omitting it clears the old default. The machine stores only entry and Profile ID. `profile unbind` leaves shared rules intact.

Explicit `list --view VIEW_ID --database LIBRARY_ENTRY` takes precedence. Without a default View, use the first View in API order. Bare `list` remains complete discovery. Profile/View choices do not grant access or activate workflow bodies; hosts own session selection and first-submission timing.

## Maintain existing legacy bindings

For an existing legacy upstream library, connect and run within the requested scope:

```bash
ntn-skills sync upstream connect SOURCE --database DATABASE --root skills --name 'Team Skills'
ntn-skills sync upstream run --target SUBSCRIPTION_ID
```

Use supported `--ref`, `--include` and `--exclude` to preserve the chosen source range. Retain the returned subscription ID; repeat `--target` for a selected batch. `--all` requires every enabled subscription to be in scope. Run checks original pending work first. Legacy tracked body/resources/Name/Description follow upstream; explicit `sync upstream fork` preserves a personal member. An inaccessible page is not proof of deletion.

For an existing local synchronization relationship:

```bash
ntn-skills sync local connect CURRENT_PAGE_ID --path /absolute/skill-directory --as release-review
ntn-skills sync local run release-review
```

A missing directory initializes from Notion; equal content establishes the baseline. For differing existing work, use only the user's chosen `--from notion` or `--from local` direction. Run preserves each binding's common baseline, checks pending work and stops on competing edits. Do not infer direction from timestamps or remove unrelated files. Generated snapshot directories remain consumption output unless the user explicitly submits selected files through normal authoring.

## Resolve the original operation

Shared source registration uses `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID`; source selection uses `source select reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY`. For a Profile revision, repeat its complete original `profile set` arguments with `--reconcile`. These paths inspect retained original facts without replaying unknown mutations. Current property equality is insufficient proof.

Legacy `sync upstream/local status` inspects existing state and `check` obtains a current observation. Neither proves a successful run. Repeat the ordinary run to use its guarded original-operation recovery; advanced saved-plan review remains available when needed. Preserve exact results, operation IDs, receipts and current content. An invisible first request on another machine can remain unresolved; do not recreate it to force progress.

Report verified changed/unchanged results, conflicts and unresolved items separately. Use [source and synchronization decisions](references/synchronization.md) for scoped recovery details; do not treat old bindings as already retired or a source-built test as a completed migration.
