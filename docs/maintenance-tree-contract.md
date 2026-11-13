# Progressive maintenance of one Skill

One `apply` owns a complete proposed tree and one immutable parent operation. It does not create a second journal or make a multi-page Notion transaction atomic.

## Authoring

Read the exact current Skill with `read PAGE --database ENTRY --authoring` and copy its returned main ref. Put only added or edited native Markdown files in a separate directory. An ordinary split submits the updated `SKILL.md` and two new `references/*.md` files together:

```sh
ntn-skills apply PINNED_MAIN_REF --input ./changes --dry-run
ntn-skills apply PINNED_MAIN_REF --input ./changes
```

Omitted files remain unchanged, including raw resources and executable modes. New native files retain their nominated `100644` or `100755` mode in their ownership facts. Existing file modes are not silently changed. Main frontmatter must agree with current metadata or explicit `--name` / `--description` options; repeating metadata is not permission to submit a conflicting header. Non-native resource mutations retain the explicit `ctl resource` workflow.

Moves, deletion and revival are explicit. The `--changes` option reads one versioned JSON manifest; it does not execute a script:

```json
{"version":1,"moves":[{"from":"references/old.md","to":"references/new.md"}],"removes":["references/unused.md"],"revives":[{"path":"references/retained.md"}]}
```

Use only the changes requested for the current operation. Supply updated referring Markdown through `--input`; a missing submitted file never means delete. The main entrypoint is protected. Paths must be canonical NFC relative paths; case collisions, existing tombstones, duplicate ownership and unsupported path cycles fail before native mutation. Equal bytes never infer a move.

An optional `rewrites` array names exact `{path,start,end,from,to}` destination spans in the frozen input. Offsets are JavaScript UTF-16 string offsets. The parser checks the original span and link context. Code fences, inline code, escaped examples, external URLs and unrelated ownership are not rewritten. Complete file edits are the normal author-facing interface; no manual offset calculation is required.

## Identity and execution

The parent freezes baseline scope/version, complete target manifest, exact child plans and their ordered stages: allocate, revive, move, retire, author, metadata. Full target bytes are reconstructed from verified baseline objects and child candidates before dispatch. A string containing a hash is never evidence for the corresponding bytes. Each layout child must belong to the retained parent; its preceding children must have exact original applied outcomes. Caller-supplied lists or counts cannot bypass the prefix proof.

Supporting-file moves preserve File ID and native page. Deletion adds a tombstone without deleting the page or body. `ctl file undelete PAGE PATH --entry ENTRY` revives that same identity from its retained content. It is separate from source `restore-follow`. Changed tombstone bytes, inaccessible pages and competing path owners stop the revival rather than create a substitute page.

## Original recovery

```sh
ntn-skills ctl operation show ORIGINAL_ID --target PAGE --entry ENTRY
ntn-skills ctl operation reconcile ORIGINAL_ID --target PAGE --entry ENTRY
ntn-skills ctl operation resume ORIGINAL_APPLY_ID --target PAGE --entry ENTRY
```

Show reports retained intent, not success. Reconcile is read-only and checks the original outcome. Explicit resume is available for an original apply only; it continues a verified prefix and an actually undispatched suffix under the original local journal and current guards. Missing remote query rows or matching current bytes cannot prove an unsent request. An unknown allocation, body PATCH or outcome POST stops the suffix without replay. A different Store can inspect shared completion but cannot invent missing dispatch authority.

Partial current trees remain behind the original pending-operation barrier. Previously selected pins retain their exact bytes. Concurrent human changes are kept; no automatic compensation overwrites them. A verified `partial` or `not_applied` outcome is not a completed requested edit. Repeating identical actual current input creates no new child operation; repeating stale authored metadata is still a conflict.

The related models abstract bounded scope and ordered effects. Installed CLI, actual HTTP, source row/body oracles and original session evidence remain separate acceptance obligations; neither a model diagram nor exit zero substitutes for those checks.

## Native link allocation boundary

Logical path validation is not proof that Notion can preserve a local URL. Same-owner existing targets are converted to exact native page URLs before dispatch. A new linked target has no native page ID until its allocation is acknowledged. The current command rejects such same-batch links before writing and recommends staging the new reference pages, obtaining a fresh author pin, then applying the linked bodies. This includes cyclic new references; the prior permissive transport fixture is not retained as live-service proof. Existing body/reference edits still use one parent apply, and no transaction/automatic rollback is claimed.

Complete operation identity remains defined over the full plan. Oversized repeated representations use the lossless `derived-text-v1` stored representation; all omitted fields are reconstructed through the frozen normalization/projection version and checked against the original operation digest. The actual stored fact is still bounded to 64 KiB. Unknown dispatch, original authority, scope and prefix/suffix rules are unchanged.
