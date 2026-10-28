# Historical operator commands

Ordinary maintenance uses `ntn-skills apply`, `sync local run`, `sync upstream run` and the original `operation list/show/reconcile/resume`. Historical one-off actions are available only in the independent `ntn-skills-state-migration` artifact. They are not prerequisites for creating, reading, editing or synchronizing current content.

The artifact contains two executables:

| Executable | Responsibility |
| --- | --- |
| `ntn-skills-migrate` | Offline import of explicitly selected legacy local state with stopped writers and an external backup |
| `ntn-skills-operator` | Existing guarded historical publication, adoption and targeted repair actions; these may contact and modify Notion |

The normal `ntn-skills` package does not install these executables. Maintainers build the independent artifact from the source repository with `bun scripts/build-migration.ts /absolute/new-package-directory`, then pack that directory. Install the resulting supplied archive explicitly when a retained historical operation requires it. Help works offline:

```bash
ntn-skills-operator --help
ntn-skills-operator upstream --help
ntn-skills-operator operation --help
```

Keep the original state/configuration roots and operation identities. Moving a command to this artifact does not change its original guards or authorize another request after an unknown outcome. Follow the `next.argv` returned by the retained operation. When that selects ordinary `ntn-skills operation resume`, continue through the ordinary CLI.

## Available historical actions

| Group | Commands |
| --- | --- |
| Frozen editable-file publication | `upstream publish-files` |
| Existing publication adoption | `upstream content-adopt-plan`, `content-adopt-apply` |
| Retained source conversion repairs | `upstream source-rich-text-repair-{plan,apply,reconcile,show}`, `source-root-fidelity-{plan,apply,reconcile,show}`, `source-root-completion-{plan,apply,reconcile,show}` |
| Existing map checkpoint adoption | `upstream map-checkpoint-adopt-plan`, `map-checkpoint-adopt-apply` |
| Historical subscription creation evidence | `upstream adopt-plan`, `adopt-apply`, `prepare-plan`, `prepare-apply` |
| Explicit one-member replacement | `upstream rebuild`, `restore-deleted` |
| Bounded body completion | `operation body-completion-plan`, `body-completion-apply`, `body-completion-reconcile` |
| Separately reviewed creation attempt | `operation supersede-plan`, `supersede-apply` |
| Historical marker inspection/acceptance | `operation inspect-edit`, `accept-edit` |

Stable edits made directly in Notion after a committed publication are available through an ordinary current read. They do not need an inspect/accept ceremony. Current reads still reject incomplete publications, malformed ownership and incomplete content; they never settle a pending operation or change synchronization ownership. Existing pinned snapshots keep their prior bytes.

## Explicit one-member replacement

`ntn-skills-operator upstream rebuild SUBSCRIPTION_ID MEMBER_KEY --operation p_OPERATION` is an explicit one-member rebuild. The operation ID matches `p_` plus 1–100 letters, digits or hyphens. The first use fetches that member from the current upstream source and freezes those bytes, revision and subscription configuration. The same operation resumes that frozen source; only a different operation fetches again. Rebuild runs on the shared target's publisher subscription.

An owned previous page is moved to Notion Trash and verified there before publication. Missing permission or a lost response stays unknown and is not treated as success or as proof of Trash. Publication creates a distinct page: native rendered main Markdown plus References child pages for supporting Markdown, with scripts and non-Markdown assets in Files/the source bundle. It does not require the old page ID or byte-identical Markdown round-trip. The selected member may share an invocation name with another exact page; ordinary create, replace and upstream apply still reject that collision. Only the selected member mapping changes; another member changing meanwhile stops the rebuild. The member page `Default Context` is retained separately from the subscription Router `Default Context`. Omitting it preserves the previous member page checkbox, including false when there is no previous page; an explicit boolean writes only the new member page and fails with `PROPERTY_UNAVAILABLE` when that checkbox property is absent. The first operation freezes the current source revision and the complete source manifest so cross-member resource resolution stays bound to those bytes. A repeated name or alias is addressed by exact page ID.

Trash, publication and the member-map write are separate Notion and local steps, not one atomic transaction. Interruptions keep the original unknown outcome. Repeat the same command and operation to continue from the retained stage; do not replay that unknown request or start recovery by choosing a new operation.

`ntn-skills-operator upstream restore-deleted SUBSCRIPTION_ID MEMBER_KEY --operation p_OPERATION` uses the same frozen publication and member-map transaction without moving an active page to Trash. The original page must already be in Notion Trash and still be readable with the expected publisher, member key, content database and member Default Context. Live or foreign pages fail with `UPSTREAM_TARGET_CONFLICT`; missing, inaccessible and other failed reads retain their original errors. Repeat the same command and operation after interruption; switching between restore and rebuild with one operation ID fails with `UPSTREAM_OPERATION_MISMATCH`. An unresolved member-map write retains its unknown state and is never replayed.

## A separate creation attempt after an unknown result

`ntn-skills-operator operation supersede-plan ORIGINAL --intent-index ZERO_BASED_INDEX --operator-intent TEXT` records a separately reviewed new creation intent when the original unknown page POST cannot be recovered. Planning saves complete current-scope discovery with zero exact original candidates, the original receipt/intent digests, frozen source, parent/sibling guards and any upstream mapping. Its guard hash expires after five minutes. A complete API-visible zero count does not prove the original POST never succeeded: its object may appear later, and the plan explicitly records that risk. `ntn-skills-operator operation supersede-apply PLAN_ID --guard-hash HASH` consumes one new creation attempt through the same publication engine, retaining the original unknown receipt unchanged. An uncertain new attempt requires reconciliation/review and cannot itself be superseded. Root upstream pointers move only after the new publication commits and a full-payload guarded compare-and-swap succeeds; owned child replacement preserves exact root/sibling guards and source paths without name adoption.

## Historical subscription identity evidence

An old uncertain add without identity proof retains its original audit. `ntn-skills-operator upstream adopt-plan --evidence FILE` requires strict JSON containing `operation_id`, `scope`, `database_id`, `data_source_id`, `target_database_id`, `source_config_hash`, exact `page_id`, `created_time` and an explicit `creation_evidence` reference. It reads that page and matches its creation time, parent and complete configuration. Review its plan hash, then `ntn-skills-operator upstream adopt-apply OPERATION_ID --plan-hash HASH` rechecks the exact page version and binds locally with zero remote writes. Names never prove identity. An original GET-only failure can instead use `ntn-skills-operator upstream prepare-plan --evidence FILE` and reviewed `ntn-skills-operator upstream prepare-apply OPERATION_ID --plan-hash HASH`: evidence binds the original failure receipt and frozen executable hashes, exact failed data-source GET and anchored awaited-preflight-before-POST source lines. Preparation preserves the original command inside its audit and permits the original add operation ID to perform its single first POST. Neither recovery command changes remote content or deletes existing pages.

## Frozen editable-file publication

`ntn-skills-operator upstream publish-files PLAN MEMBER --operation NEW` publishes the exact frozen candidate and moves its original parent pointer only after committed live verification; run its returned selected `ntn-skills sync upstream apply` to accept the member and publish the subscription map. If that file publication has an unknown terminal append on its own known page, `--supersede OLD_OPERATION` explicitly creates a distinct page with a new operation. The old page/receipt/request remain untouched and unresolved; the new command checks the original owner, frozen bytes and writing marker, and cannot replace an accepted target. A timeout or repeated absent read is never proof that the old write failed.

For exact flags, use the selected operator command's `--help`. The [public protocol](protocol.md) owns ordinary result/recovery semantics and [local-state upgrade](protocol.md#local-sqlite-authority-and-explicit-upgrade).
