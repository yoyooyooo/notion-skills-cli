---
name: ntn-skills-sync
description: Manage active Git/GitLab/Linear sources, review complete Source candidates, run finite update policy, explicitly admit members, and select fixed Git/HTTP/local sources or shared Profile/View defaults. Keep exact identities and original plans; report each affected item and unresolved result.
compatibility: Requires ntn-skills, Node.js 22.22.3+ within 22.x or 24.20.0+, and an existing Notion token; reads need Read content and writes need Insert/Update content. Local replacement requires supported system Trash retention.
metadata:
  publisher: ntn-skills
  builtin-id: notion/ntn-skills-sync
---

# Maintain sources and supply rules

Identify the selected library and record first. A `shared_skill` locator uses shared native Source/Profile rules. One-time content edits belong to `ntn-skills-maintain`; consuming a remote workflow needs no sync binding.

## Manage an active Source definition

For the four-table shared library, use `ctl library sources`, not the retired library's `ctl sync upstream` subscription path. Sources owns provider/location/ref/selection and its Origin/member binding. `Selected Version` is the separate exact content pin; changing a definition alone does not advance it.

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

`check/fetch` are read-only provider operations. `prepare` freezes the complete member plus current ownership and content expectations. Use `--all-bound` instead of `--target` to acquire a Source once and freeze every enabled bound Skill, including the complete membership observation. `apply` uses that exact candidate, preserves whole custom files and old pins, and verifies the resulting directory. Default `--storage auto` uses an unchanged complete public GitHub tree directly when its fixed identities have been verified; other supported inputs use retained source objects. Explicit `--storage fixed-git` does not silently fall back. Use `sources reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY` to inspect the original selection without repeating it. Never re-create a frozen plan from current text to make an unknown result look complete.

`put --input DEFINITION --expect FINGERPRINT` changes one full configuration; use the fingerprint from `show` or `absent` for a new stable ID. `bind SOURCE_ID --target SKILL_PAGE_ID --member EXACT_MEMBER --expect-origin CURRENT_SOURCE_PAGE_OR_none --entry LIBRARY_ENTRY` changes only association. Providers include generic Git, registry and explicitly mapped Linear issue/document content. Auth stays on the machine. Shared contributor sets require explicit composition, not a single-source overwrite. See [source decisions](references/synchronization.md#active-sources-definitions) before authoring configurations.

## Source names and repository-level management

A Source is a provider location plus its chosen ref/policy/options, not one row per discovered Skill. A compatible repository can select multiple exact roots; each Skill retains its own Source Member and selected immutable version. Separate configurations for different branches, filters, credentials policies or transformation options must not be merged merely because the URL matches.

The Source title is an editable display label. Stable Source ID and native page relations own identity; repository paths remain in Location. Renaming in Notion or through the CLI preserves members and selected content. Because the full configuration fingerprint includes the title, an older prepared configuration change may require a fresh preview.

```bash
ntn-skills ctl library sources rename SOURCE_ID nowledge --entry LIBRARY
ntn-skills ctl library sources consolidate --source KEEP_SOURCE_ID --name nowledge --entry LIBRARY --dry-run
ntn-skills ctl library sources remove --source SOURCE_ID --entry LIBRARY --dry-run
```

Inspect the returned exact plan and use its `next.argv` to execute. Consolidation unions compatible roots on the retained Source, preserves member keys and selected versions, rebinds Skills/Records Origin, then moves now-empty duplicate Source pages to Trash. No body, fixed source payload or upstream repository is edited. Removal operates on an exact Source's member closure, not a title substring; outside Requires and ambiguous shared ownership refuse or preserve rows. Saved `--operation` continues only the original scope. Neither operation claims cross-machine atomicity or permanent deletion of private historical copies.

## Run finite policy and review member changes

```bash
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode check
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode prepare --output ./candidate.json
ntn-skills ctl library sources run SOURCE_ID --entry LIBRARY_ENTRY --all-bound --mode policy --due
ntn-skills ctl library sources run-list
ntn-skills ctl library sources run-status SOURCE_RUN_ID --output ./original-candidate.json
```

Check and prepare modes are remotely read-only. Policy skips disabled Sources, skips provider rediscovery for pinned Sources, prepares manual candidates and applies auto candidates only where verified protection allows. Auto requires an explicit `options.check_interval_ms` of one minute through 366 days. Registered file requests are still processed for enabled Sources when pinned, not due or unchanged. This command performs one bounded invocation; it installs no scheduler or daemon.

Use `--max-requests`, `--max-bytes` and `--duration-ms` to set the invocation budget. Actual HTTP attempts include retries; waits count toward time, and admitted response overshoot is reported. Git subprocess deadlines are separate from HTTP byte counts. Exit 75 pauses, 4 preserves unknown/incomplete outcomes, and 3 identifies review-required results. A completed check or prepared manual candidate is not a content application. Offline run status may show an interrupted running checkpoint; do not infer that its last write was never sent.

Automatic editable-body replacement remains blocked when no atomic content precondition is available. Report `BODY_REPLACEMENT_UNSAFE` or a missing initial projection as pending work; selecting a revision alone does not prove the Notion page displays it. Source check status, selected revision, displayed revision, custom ancestry and session pin remain distinct. Same-state-root invocations share a local fence; coordinate one management writer per library across machines.

Explicitly admit an exact new member with `sources admit SOURCE_ID --entry LIBRARY_ENTRY --member EXACT_MEMBER --skill-id NEW_ID --output PLAN`, then `admit-apply PLAN` or `admit-reconcile PLAN`, both with the same `--entry`. New entries remain disabled unless preparation includes `--enable`. Existing enabled or disabled Source/member bindings prevent duplicate admission. Default Views and user Members/Requires are not expanded by new upstream candidates.

Use `member-prepare SOURCE_ID --entry LIBRARY_ENTRY --target PAGE_ID --member EXACT_NEW_MEMBER --output PLAN` for an explicit path rebind, or replace `--member` with `--retain-removed` to detach a confirmed removed member while preserving its selected bytes and custom content. Execute with `member-apply`; inspect with `member-reconcile`. These decisions preserve user relations and old pins, do not infer renames, and do not automatically select a new revision.

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

If an original result belongs to a different operation family, retain its returned IDs and recovery action. Do not convert it into a Source plan, reconnect the content or infer ownership from a display name.

Report verified changed/unchanged results, conflicts and unresolved items separately. Use [source and synchronization decisions](references/synchronization.md) for scoped recovery details; do not treat old bindings as already retired or a source-built test as a completed migration.
