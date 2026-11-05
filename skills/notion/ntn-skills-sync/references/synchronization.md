# Synchronization decisions

## Daily paths

| Relationship | Start once | Continue |
| --- | --- | --- |
| Active shared Source | `ctl library sources put` and exact `bind` | `sources prepare`, reviewed `apply`; `reconcile` original plan |
| Existing legacy Git subscription | `sync upstream connect SOURCE --database LIBRARY` | `sync upstream run --target SUBSCRIPTION_ID` |
| Existing legacy local relationship | `sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL` | `sync local run LABEL` |
| All authorized active legacy relationships | Register each relationship | The relevant `run --all` |
| One-time import/export/edit | Use `ntn-skills-maintain` | No recurring binding is established |

Use installed help/schema for flags and actual output fields. Do not manufacture internal subscription, plan, proof or receipt JSON as part of a normal connection. Existing low-level add/update and plan/apply commands remain useful for explicit advanced configuration or saved-plan review.

## Active Sources definitions

The current four-table model separates mutable Sources from immutable selected content in Records. Use `ctl library sources providers` for offline capabilities and `list/show/members --entry ENTRY` for complete current identities and associations. The Sources reverse relation may be truncated by Notion; `members` queries the forward Skills Origin relation and follows all cursors. A Source with no current bound members is valid; a retained former published-members manifest is not permission to recreate deleted content or guess by name.

`put` takes a complete version-1 definition with `source_id`, name, description, enabled, policy, adapter, selection and options. Read the installed `sources put --help` and the [Source management guide](https://github.com/yoyooyooo/notion-skills-cli/blob/main/docs/sources-management.md) for exact Git and Linear JSON examples. Copy the last observed fingerprint into `--expect`; edits do not change current Skill pins. `bind` requires exact target/member and expected current Origin. Old multi-publisher settings remain provenance; a single-origin refresh deliberately rejects shared_target_set.

`check` resolves a complete provider candidate. `fetch` writes one exact member's portable files to a new/identical directory. `prepare SOURCE --entry ENTRY --target PAGE --output PLAN` combines exact provider bytes with the current native custom/following/tombstone state and verifies the effective file tree without remote writes. `apply PLAN --entry ENTRY` checks the original configuration, target, resources and current expectations, stores content chunks and the bundle, then uses the common guarded selection journal. It verifies the result and records the last successful revision; no automatic cron, whole-library sync or native-body overwrite is implied.

Linear uses a machine-only `LINEAR_API_KEY` and the fixed official GraphQL endpoint. Select explicit issue/document IDs and file paths including SKILL.md. An observation hash binds the returned bytes and updatedAt, not an invented historical API commit. Git uses host authentication and exact resolved commits. Shared definitions never contain credentials, arbitrary headers or executable commands. Do not copy credentials to test another machine.

After interrupted refresh, `sources reconcile PLAN --entry ENTRY` observes the exact retained original selection. A visible new pin alone does not prove the original outcome. Acknowledged resource steps are immutable; an unknown original write is not resent. A candidate removing a bound following file or yielding broken final references needs an explicit content decision, not dropped files or looser validation.

## Shared fixed sources

A shared library selects immutable source identities while native Notion properties and whole-file customizations remain authoritative. Use the exact page and Skills database entry:

```bash
ntn-skills ctl library source inspect https://github.com/OWNER/REPOSITORY --commit FULL_40_HEX_COMMIT --root skills/example
ntn-skills ctl library source register SKILL_PAGE_ID --entry LIBRARY_ENTRY --url https://github.com/OWNER/REPOSITORY --commit FULL_40_HEX_COMMIT --root skills/example
ntn-skills ctl library source select prepare SKILL_PAGE_ID --entry LIBRARY_ENTRY --source SOURCE_ID --output ./source-selection.json
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY --dry-run
ntn-skills ctl library source select apply ./source-selection.json --entry LIBRARY_ENTRY
```

Register freezes the candidate; select changes only the native Source property. The CLI generates the plan. Keep its exact content and IDs for application or reconciliation. Use `--native` instead of `--source` to clear Source intentionally. Register can also consume the complete `source inspect` JSON or its bare manifest with `--manifest FILE`, mutually exclusive with URL/commit/root; this form makes no provider request. A source change never selects a newer revision implicitly or discards customized Notion bodies. Content maintenance owns an explicit `ctl library file restore-follow`.

### HTTP/local composition and resource bindings

`ctl library source composition inspect PLAN_JSON --verify` and `composition register SKILL_PAGE_ID --entry LIBRARY_ENTRY --manifest PLAN_JSON` accept an existing fixed composition plan. There is no ordinary interactive builder. Files must have complete fixed identities; unresolved paths, collisions or access failures remain errors. `source resource show` reports redacted machine configuration. Use `source resource --help` for local workspace bindings, exact HTTP origin policy and machine-only retrieval locations. These bindings grant reads, not a two-way sync relationship or authorization to publish local bytes. Machine paths, credentials and signed retrieval URLs never belong in shared records or portable manifests. Native restore-follow requires separate `--allow-local-archive` authorization for selected local bytes.

Archiving an exact complete local snapshot uses `ctl library snapshot save SNAPSHOT_ID --entry LIBRARY_ENTRY`. A new archive containing local-restricted bytes requires its own `--allow-local-archive`; that flag authorizes only this archive and preserves durable content restrictions. Use the original snapshot with `--reconcile` after interruption. It does not authorize a different snapshot or replay an unknown write. Restore-follow's same-named flag covers only its selected native body.

### Shared Profile defaults

```bash
ntn-skills ctl library profile list --entry LIBRARY_ENTRY
ntn-skills ctl library profile show PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --profile PROFILE_ID --database LIBRARY_ENTRY
ntn-skills ctl library profile bind PROFILE_ID --entry LIBRARY_ENTRY
ntn-skills list --default-view
```

Create or replace a complete rule with `profile set PROFILE_ID --entry LIBRARY_ENTRY --name NAME --enabled true|false --base REVISION [--default-view VIEW_ID]`. Use `--base new` only for a new Profile; otherwise copy the exact current revision from show. Omitting the optional View removes an old default. `profile unbind` removes only the machine binding. Explicit `list --view VIEW_ID --database LIBRARY_ENTRY` takes precedence; absent a configured default, use the first View in API order. Bare list discovers the accessible source scope; follow every returned cursor for the complete observation. Rules do not grant access or activate bodies.

### Shared recovery

| Original operation | Read-only reconciliation |
| --- | --- |
| Git source registration | `ctl library source reconcile SKILL_PAGE_ID --entry LIBRARY_ENTRY --source ORIGINAL_SOURCE_ID` |
| Composition registration | Repeat its exact `composition register` input with `--reconcile` |
| Source selection | `ctl library source select reconcile ORIGINAL_PLAN --entry LIBRARY_ENTRY` |
| Profile revision | Repeat the exact complete `profile set` intent with `--reconcile` |

Preserve original input and IDs. Equal current properties or absent remote results do not prove an unknown original request succeeded or was never sent. Missing facts remain unresolved, especially on an independent machine with no local receipt. Do not send these shared IDs to legacy `operation resume`. A verified recovery proves its reported status, not necessarily completion of the intended change.

## Existing legacy upstream connection and run

The connection chooses a source, target database and member discovery scope. Optional ref/root/include/exclude values belong to the selected source. A repeated structural connection reuses its existing subscription; a display-name match alone does not establish identity. If configuration needs to change, inspect and update the exact subscription rather than creating another row.

A run resolves original pending writes first. It reuses their frozen input and operation IDs, then discovers current source changes. Unknown original creation blocks a replacement create. A failed or partial subscription does not prevent another selected subscription from completing.

When an original tracked page is explicitly in Notion Trash, run can publish the current selected source into a new page and advance that member's map. It preserves the old page, other members, Tags and Default Context. Source exclusion/removal does not recreate the member; a fork preserves local ownership. Missing access or an unavailable response cannot establish deletion. Report the new exact page ID after restoration because an old live ref does not acquire a new identity.

Tracked content changes belong to the upstream source. Ordinary local edits to body, files, Name or Description require `sync upstream fork SUBSCRIPTION_ID MEMBER_KEY`. Fork/track uses the existing accepted baseline; do not overwrite a conflict or alter ownership metadata manually. A direct Notion edit remains readable while synchronization preserves it as a conflict. Default Context is independently editable and does not accept a content revision.

Notion's Upstream row reports Sync Status, Last Sync Attempt, Last Synced and Sync Summary. Only successful completion advances Last Synced. CLI member results distinguish created/updated/unchanged/retained/forked/restored/conflicted/unresolved outcomes. A status-write failure can coexist with successful member effects; inspect the returned original operation before deciding what remains.

## Existing legacy local initialization and direction

A local connection follows an existing current page ID and a logical local path. It does not create the remote item. Preserve intended symlinks. A missing ordinary leaf under an accessible parent can be created from Notion; a dangling link or a missing established root is a path error.

If local and remote contents initially agree, connect verifies the common baseline. If a local directory already contains different content, choose the initial winner from the task's explicit intent:

```bash
ntn-skills sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL --from notion
ntn-skills sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL --from local
```

Use one of these, not both. If the task has not chosen between distinct work, show the relevant difference and obtain that content decision. Once initialized, ordinary run uses the common baseline: one-sided edits propagate, equal new content converges, and different two-sided edits conflict.

A tracked upstream item can be pulled locally, but local changes cannot be pushed back over its upstream ownership. Edit the source or deliberately fork first. An ordinary import/edit outside sync does not advance the local common baseline.

## Legacy saved-plan review

When a task needs a frozen preview before mutation:

```bash
ntn-skills sync local plan LABEL --output ./sync-plan.json
ntn-skills sync local apply --plan ./sync-plan.json
```

Review applicability, conflicts, target page/path, direction and file additions/removals. Apply the saved plan unchanged. A changed source, baseline, credential scope or link target makes it stale; reread and replan rather than editing hashes or preconditions. `--from` is a deliberate single-binding initialization/conflict decision and does not bypass freshness checks.

For multiple copies of one page, inconsistent local candidates conflict before writes. Execution across several pages/directories is not globally atomic. Some bindings can finish before a later failure; report their actual results. Plans are local execution artifacts, not instructions to copy to another machine.

## Legacy recovery and completion

Use ordinary run first for an authorized retry. It checks original unfinished work before creating new plans. Retain the returned operation ID if the result remains partial or unknown:

```bash
ntn-skills operation show OPERATION_ID
ntn-skills operation reconcile OPERATION_ID
ntn-skills operation resume OPERATION_ID
```

Use the next action reported for that operation. Reconcile reads actual effects; resume continues only supported original work. Never assume a failed response means no effect. Unknown creation, changed content or changed ownership remains unresolved rather than producing another artifact.

| Outcome | Response |
| --- | --- |
| Verified run | Report completed objects and their exact identities |
| Content conflict | Preserve both sides and apply the user's source/merge decision through a fresh plan |
| Stale unused plan | Observe current state and create a new plan |
| Unknown original write | Retain and inspect/resume that operation; no new create |
| Missing permission or source | Repair access/source configuration; do not infer deletion |
| Local retention or path failure | Preserve old bytes and restore the required path/Trash capability |
| Partial batch | Report completed and unresolved participants separately |

Historical migration and repair work belongs to the separate operator tool for an explicitly diagnosed case. Do not turn its internal proof commands into a daily run prerequisite. Preserve operation records, baselines and original configuration while a result is unresolved.

## Legacy observation and stopping

Upstream `status` is an offline scoped view; `check` reads current subscription/member metadata. Metadata is not a fresh body read. Unknown means unobserved, not missing. Automatic subscription Routers require at least two active published Skills; one member remains independently usable without a Router. Read a returned Router/member ref only when the current task needs its instructions.

Local `status` can be provisional; `check` or refreshed status observes current sides without advancing a baseline. Only verified synchronization establishes convergence. After local content changes, use the consuming host's documented reload/restart path.

`sync local unbind LABEL` deactivates the relationship while retaining both contents and recovery state. Upstream removal likewise acts on the selected registration; do not delete unrelated content or state as a recovery shortcut.
