# Synchronization decisions

## Daily paths

| Relationship | Start once | Continue |
| --- | --- | --- |
| Git source to Notion | `sync upstream connect SOURCE --database LIBRARY` | `sync upstream run --target SUBSCRIPTION_ID` |
| Existing Notion item to one local directory | `sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL` | `sync local run LABEL` |
| All authorized active relationships | Register each relationship | The relevant `run --all` |
| One-time import/export/edit | Use `ntn-skills-maintain` | No recurring binding is established |

Use installed help/schema for flags and actual output fields. Do not manufacture internal subscription, plan, proof or receipt JSON as part of a normal connection. Existing low-level add/update and plan/apply commands remain useful for explicit advanced configuration or saved-plan review.

## Upstream connection and run

The connection chooses a source, target database and member discovery scope. Optional ref/root/include/exclude values belong to the selected source. A repeated structural connection reuses its existing subscription; a display-name match alone does not establish identity. If configuration needs to change, inspect and update the exact subscription rather than creating another row.

A run resolves original pending writes first. It reuses their frozen input and operation IDs, then discovers current source changes. Unknown original creation blocks a replacement create. A failed or partial subscription does not prevent another selected subscription from completing.

When an original tracked page is explicitly in Notion Trash, run can publish the current selected source into a new page and advance that member's map. It preserves the old page, other members, Tags and Default Context. Source exclusion/removal does not recreate the member; a fork preserves local ownership. Missing access or an unavailable response cannot establish deletion. Report the new exact page ID after restoration because an old live ref does not acquire a new identity.

Tracked content changes belong to the upstream source. Ordinary local edits to body, files, Name or Description require `sync upstream fork SUBSCRIPTION_ID MEMBER_KEY`. Fork/track uses the existing accepted baseline; do not overwrite a conflict or alter ownership metadata manually. A direct Notion edit remains readable while synchronization preserves it as a conflict. Default Context is independently editable and does not accept a content revision.

Notion's Upstream row reports Sync Status, Last Sync Attempt, Last Synced and Sync Summary. Only successful completion advances Last Synced. CLI member results distinguish created/updated/unchanged/retained/forked/restored/conflicted/unresolved outcomes. A status-write failure can coexist with successful member effects; inspect the returned original operation before deciding what remains.

## Local initialization and direction

A local connection follows an existing current page ID and a logical local path. It does not create the remote item. Preserve intended symlinks. A missing ordinary leaf under an accessible parent can be created from Notion; a dangling link or a missing established root is a path error.

If local and remote contents initially agree, connect verifies the common baseline. If a local directory already contains different content, choose the initial winner from the task's explicit intent:

```bash
ntn-skills sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL --from notion
ntn-skills sync local connect PAGE_ID --path ABSOLUTE_PATH --as LABEL --from local
```

Use one of these, not both. If the task has not chosen between distinct work, show the relevant difference and obtain that content decision. Once initialized, ordinary run uses the common baseline: one-sided edits propagate, equal new content converges, and different two-sided edits conflict.

A tracked upstream item can be pulled locally, but local changes cannot be pushed back over its upstream ownership. Edit the source or deliberately fork first. An ordinary import/edit outside sync does not advance the local common baseline.

## Deliberate plan review

When a task needs a frozen preview before mutation:

```bash
ntn-skills sync local plan LABEL --output ./sync-plan.json
ntn-skills sync local apply --plan ./sync-plan.json
```

Review applicability, conflicts, target page/path, direction and file additions/removals. Apply the saved plan unchanged. A changed source, baseline, credential scope or link target makes it stale; reread and replan rather than editing hashes or preconditions. `--from` is a deliberate single-binding initialization/conflict decision and does not bypass freshness checks.

For multiple copies of one page, inconsistent local candidates conflict before writes. Execution across several pages/directories is not globally atomic. Some bindings can finish before a later failure; report their actual results. Plans are local execution artifacts, not instructions to copy to another machine.

## Recovery and completion

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

## Observation and stopping

Upstream `status` is an offline scoped view; `check` reads current subscription/member metadata. Metadata is not a fresh body read. Unknown means unobserved, not missing. Automatic subscription Routers require at least two active published Skills; one member remains independently usable without a Router. Read a returned Router/member ref only when the current task needs its instructions.

Local `status` can be provisional; `check` or refreshed status observes current sides without advancing a baseline. Only verified synchronization establishes convergence. After local content changes, use the consuming host's documented reload/restart path.

`sync local unbind LABEL` deactivates the relationship while retaining both contents and recovery state. Upstream removal likewise acts on the selected registration; do not delete unrelated content or state as a recovery shortcut.
