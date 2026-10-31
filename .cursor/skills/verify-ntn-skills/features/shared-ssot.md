# Shared Notion SSOT verification

Verify the implemented AH-498 slice through `ctl library` and ordinary `list/read/files`. The [protocol](../../../../docs/protocol.md#shared-notion-library) owns command semantics; the [architecture checkpoint](../../../../docs/shared-ssot-architecture.md) records observed results and open work. This recipe defines acceptance work. Its presence is not a pass, and the complete epic remains open.

## Scope and preparation

Use the [Skill launch procedure](../SKILL.md#launch) and its existing `control.ts cli` driver. Keep evidence outside the checkout. The driver builds the formal CLI from source and runs it with Node.js; call that **source-built CLI** evidence. Installed npm package, second physical machine, native UI and actual model behavior require their own executions.

Bind these values from captured outputs or the task's exact fixture receipt:

| Variable | Meaning |
| --- | --- |
| `RUN` | Absolute owned helper run directory |
| `PARENT` | Owned Notion fixture parent authorized for table creation |
| `ENTRY` | Skills database entry returned by initialization, never the Files/Records table |
| `TARGET` | Exact Skill page in that library |
| `CURRENT_REF` | Current unpinned shared record ref returned by its catalog |
| `SNAPSHOT`, `FILE_REF` | Complete local snapshot ID and a supporting pinned ref returned by read/files |
| `SHARED_PIN` | Exact `snapshot-...` archive pin returned by snapshot save |
| `COMMIT`, `ROOT`, `URL` | Explicit immutable Git selection authorized for the source case |
| `SOURCE_MANIFEST` | Exact inspect product JSON or bare fixed manifest saved in the owned evidence area |
| `MIGRATION_INPUT` | Version 1 migration evidence with explicitly frozen scope and preservation inventories |
| `ROUTER_REF`, `ROUTER_SNAPSHOT`, `MEMBER_REF` | Selected current Router ref, its complete fixed snapshot, and a member ref actually returned by its index |

For native ownership cases, select an owned fixture with a valid Skill ID, main File ID and at least two distinct supporting File IDs, canonical logical paths, exact Skill relations and complete editable bodies. Preserve how those rows were created. `ctl library init` creates tables, not populated Skill examples; no normal shared-row creation command is implied by this recipe. Use authorized native Notion editing or a separately recorded fixture setup. Do not route fixture creation through legacy References import commands.

Inspect the actual command surface before live effects:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library --help
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- schema ctl library snapshot restore
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- schema ctl library source register
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- schema ctl library migration plan
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read --help
```

The wrapper reports the product exit and evidence path. Inspect both; an expected product failure is not a wrapper failure. Inherit credentials without printing or copying them. Do not install transport overrides or mutate private SQLite/cache records to manufacture live outcomes. No source script is executed.

## SS01 — Layout, stable identity and read-only inspection

For a new owned fixture, run initialization once. For an existing selected entry, start with inspect:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library init --parent "$PARENT"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library inspect "$ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library files "$TARGET" --entry "$ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library state "$TARGET" --entry "$ENTRY"
```

Record exact database/data-source/property identities and relation directions. `files.main` is separate from `files.files`; its `count` is the supporting-file count. Check paths and all cursor pages against the fixture inventory. Inspection and state must not read bodies, fetch provider objects or write ownership. Missing baseline state is `uninitialized`, not inferred `following`.

A new library must register a native Members relation targeting its own Skills data source before publishing the descriptor. Rename the relation and require continued resolution by property ID; delete/recreate it or point it elsewhere and require rejection. An older library without this optional binding must remain usable for ordinary Skills, while its Router reads fail explicitly before any body observation or retention. Do not auto-upgrade an old descriptor to make the test pass; SS13 covers member consumption.

After a confirmed successful initialization, repeat the same parent and verify reuse of all identities. If any create or Members/descriptor PATCH result is unknown, retain the original operation and use its reported recovery route; do not repeat an unqualified create or PATCH. `init --parent "$PARENT" --operation "$OPERATION"` must only read back the original identities. Cover accepted-but-hidden Members and descriptor responses; missing readback remains incomplete, with zero recovery mutations. Property-rename, deleted/recreated property, foreign parent/relation, duplicate stable ID, unsafe path and incomplete pagination cases belong in controlled tests plus designated real schema fixtures. Confirm native `Supporting Files` navigation separately in Notion UI; relation data alone does not prove click-through usability.

## SS02 — Explicit catalog without content traversal

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$ENTRY" --refresh --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- list --database "$ENTRY" --metrics
```

Require the shared descriptor, stable shared record identities, correct enabled eligibility and complete explicit coverage. The cold catalog may query entry/schema/Skills metadata; it must not traverse Files, Records, bodies, unrelated Upstream tables or provider content. The eligible warm catalog should make zero remote requests. Preserve `coverage.failed_sources`; returned records never turn partial coverage into a complete inventory.

For shared View changes, also drive `views --database "$ENTRY"` and `list --database "$ENTRY" --view "$VIEW_ID" --metrics`, binding `VIEW_ID` from native View discovery. Require native membership and order, `Enabled` filtering without adding a Default Context filter, renamed-property identity and zero body/Files/Records/provider requests. Test a selected row whose stable Skill ID is also claimed by a valid nonmember, including a disabled nonmember; it must conflict. Unrelated malformed nonmembers and collisions only among unselected records must not poison the selected View. This is metadata acceptance, not Profile or host supply proof.

The current real three-member shared View sample used five metadata requests and no body/provider requests or writes. Keep that live observation separate from controlled membership/collision cases and from arbitrary View sizes.

## SS03 — Complete native snapshot and zero-request pins

The first read of previously uninitialized native bodies can persist plan/object/event facts. Run it only within the fixture's existing write authorization:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$CURRENT_REF" --database "$ENTRY" --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$SNAPSHOT" --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$FILE_REF" --metrics
```

Require a complete main plus supporting-file inventory, correct hashes/lengths and a single immutable snapshot. Copy `SNAPSHOT` and `FILE_REF` from preceding outputs; do not guess their encoding. Pinned files and resource reads must use exact local bytes with zero remote work. Verify that downloading/reading a script did not execute it.

Record first adoption writes separately from steady-state consumption. The development three-file native example made 27 requests: 9 metadata, 3 current-body, 6 retained-body queries and 9 writes. This is a measured fixture result, not a required constant for every library or later revision.

## SS04 — Whole-file adoption persists

Use native Notion editing on the owned fixture to make one substantive main-body change, then one supporting-body change. Keep the unchanged files' exact hashes and state heads for comparison. Read the current target with `--refresh --metrics`, inspect shared state, and require the entire changed file to become `custom` with retained exact normalized bytes. Only CRLF-to-LF normalization is permitted in normalization version 1.

Change that body back to the earlier text, read again and require it to stay `custom`. Change only Name or Description and verify unchanged normalized body does not create an adoption event. A source-following fixture must use an actual established projection baseline; never substitute the latest Git text as a baseline. Restore-follow, tombstone, movement and other lifecycle cases require their own implemented public actions and evidence; `ctl library state` does not perform them.

Repeat state/retained-body reconstruction in a fresh independent state root using the same authorized remote library. This proves cache independence on that host. It does not count as a second physical machine.

## SS05 — Expiry, full verification and metrics

After a complete warm read, record the verification time and run the ordinary current-target path after its chosen short age has expired:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$CURRENT_REF" --database "$ENTRY" --max-age 1s --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$CURRENT_REF" --database "$ENTRY" --metrics
```

For unchanged content, require metadata-only revalidation, no shared state writes or provider/body downloads, and the same snapshot ID. The observed three-file expired example used six metadata requests. Repeat an eligible TTL hit and require zero requests without advancing body verification time. Separately exercise `--refresh` and `--max-age 0` as full validation; do not count them as the cheap expiry path.

Controlled-clock tests must prove that metadata renewal cannot push full-body verification past its independent 24-hour deadline, including unchanged reported page timestamps. Change one file and verify unchanged objects are reused. Test missing or corrupt local objects, member addition/removal, ambiguous identities and incomplete pagination without publishing partial snapshots.

`--metrics` is a root `list/read/files` flag. Shared `files/state/source inspect/register/snapshot save/restore` emit metrics automatically; descriptor inspect and init do not. Reject `read --raw --metrics` with structured error JSON before effects. Count retained body-bearing Records queries as body transfer, and split provider tree metadata from blob traffic. Keep request counts, bytes, duplicate counts, peak concurrency, queue/retry waits, elapsed samples and sample count; never derive p50/p95 claims from one run.

Exercise coalescing and concurrency through the formal Notion service with controlled transport and clocks. Identical eligible in-flight reads in one service share one attempt; different credentials, paths, bodies or methods do not. Completed requests, file-bearing calls and mutations must not be merged. Cancel one waiter while another remains, then cancel the last waiter and verify request/permit release; retry backoff must hold no permit. Separate CLI processes do not share the in-flight map or semaphore.

`NTN_SKILLS_NOTION_CONCURRENCY` must default to four when unset or empty, accept integers 1–64 and reject other nonempty values. Hold long requests at configured caps and verify both that cap and the separate SQL admission interval. A queued attempt's permit and SQL waits must share the logical request's original five-minute deadline, including retries. Use a controlled owner with a longer network timeout to prove a waiter still times out at its own admission deadline; the owner's network attempt remains governed by its independent timeout. Record queue waits and cancellation separately from on-wire requests.

## SS06 — Original operation, unknown result and recovery

Use controlled transport tests for precise failure placement, and a separately authorized real fixture for actual response loss. Preserve original IDs, frozen body, parent events, hashes, lengths and observation time before comparing results. Cover unknown plan, object and event writes, process restart, local pending surviving cache clear, duplicate observation and incompatible event heads.

Once a pending original plan is known, recovery must only reconcile that plan/object/event. No current-body read or replacement POST may be disguised as recovery. A complete reconciliation returns `SHARED_OBSERVATION_RECONCILED`; a later explicit read must observe today's body before publishing current content. An incomplete readback remains unresolved. Check the local SQLite dispatch survives restart and is retired only after shared facts prove completion.

**Open boundary:** a first plan POST that is unknown and invisible to an empty independent client cannot be distinguished from a never-sent plan. Do not report N09 complete, physical exactly-once creation or a distributed lock. Stable IDs and duplicate fact merging do not remove that limit. Preserve the original run and pending state; do not clean it, create a new ID or retry a mutation merely because a query is empty.

## SS07 — Fixed Git manifests, candidate registration and consumption

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source inspect "$URL" --commit "$COMMIT" --root "$ROOT"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source register "$TARGET" --entry "$ENTRY" --url "$URL" --commit "$COMMIT" --root "$ROOT"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source register "$TARGET" --entry "$ENTRY" --manifest "$SOURCE_MANIFEST"
```

Inspect before registering. Require the exact commit, tree, scoped paths, Git blob IDs and declared sizes. Reject a truncated tree, path aliases/escape, scoped symlink/submodule and invalid hashes. Registration must return one stable immutable source binding and leave Source selection, editable page bodies and following baselines unchanged. Repeated confirmed registration may attach the same fact; an unknown registration requires identical inputs plus `--reconcile` and never a newer commit.

For the manifest form, save the exact inspect product JSON from evidence, not the control helper's outer envelope. Verify both this full response and the bare fixed manifest produce the same source identity with zero provider requests. Notion verification/retention is still expected. Reject every combination of `--manifest` with `--url`, `--commit` or `--root` before effects. Freeze the original input for `--reconcile`; a new inspection is not a substitute for the original manifest.

The public development metadata example was `https://github.com/anthropics/skills`, commit `ca45fc496a3436251f191354091d557da31c15b5`, root `skills/skill-creator`: 18 files, two provider metadata requests and zero blob downloads. The separate real consumption sample used 7 metadata, 1 current-body and 18 provider requests, zero writes, peak concurrency 4 and 15.807 seconds for one sample. Its final 20 files included 17 Git resources checked against their Git blob IDs and 3 custom files retaining their original SHA-256 hashes; warm `files` made zero requests. Keep inspection and consumption evidence distinct. These observations do not prove private repository support, full binary coverage, script execution or latency percentiles.

## SS08 — Exact shared archive and empty-state restore

Start with an already complete local shared snapshot and preserve its entire manifest and file hash/length inventory:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library snapshot save "$SNAPSHOT" --entry "$ENTRY"
```

Retain `shared_pin` and `verification`. `objects_and_manifest` records object and manifest confirmation for that operation; an idempotent existing completion may report `manifest` only. A manifest-only response does not prove every object remains available now. Unknown archive outcomes retain the same snapshot/plan and require `--reconcile`; do not replace the original local snapshot.

Initialize a separate owned helper run on an empty state root, without copying objects, snapshots or private configuration. Supply ordinary authentication and only the exact library entry, Skill target and shared pin. Bind `RESTORED_OUTPUT` to an absent directory under that run's owned scratch area. Drive:

```bash
RESTORE_RUN="$(mktemp -d "${TMPDIR:-/tmp}/ntn-skills-shared-restore-XXXXXX")"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts init --run "$RESTORE_RUN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RESTORE_RUN" -- ctl library snapshot restore "$SHARED_PIN" --entry "$ENTRY" --target "$TARGET"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RESTORE_RUN" -- files "$RESTORED_SNAPSHOT" --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RESTORE_RUN" -- export "$RESTORED_SNAPSHOT" --projection snapshot --output "$RESTORED_OUTPUT"
```

Bind the restored snapshot from the command response and output to an owned absolute path. Compare every restored byte against the saved inventory, including binary resources where covered. Require zero current-body and provider reads during restore, current access to the exact stable Skill, and no advancement of latest. Re-edit current content before a second restore and require the old pin's bytes to stay exact. Repeat on an independent physical machine for cross-machine acceptance; a second helper run alone is insufficient.

The real new-state restore sample made five metadata and three retained-body requests, with zero current-body/provider requests or writes. Exported SHA-256 hashes for all three files matched the saved inventory. This proves the observed empty-local-state recovery on that host; the physical-machine and additional failure cases remain independently tracked.

## SS09 — Failure and preservation boundaries

Use designated fixtures or controlled tests for missing/corrupt chunks, malformed manifest, conflicting same record ID, foreign Skill relation, inaccessible target, removed property ID and body/envelope size overflow. Require explicit failure before visible snapshot publication. Missing history must not substitute current text, latest Git or another pin. Oversized observation envelopes must fail before storing a dispatch receipt for a write that was never sent.

Exercise legacy creation/publication/mutation calls against shared locators and require their documented refusal while their shared implementations remain unavailable. Do not mark Profile, normal write/project-back or host supply complete from metadata parsing alone. Shared Router metadata consumption has SS13; it does not stand in for actual host selection or member-body execution.

## SS10 — Pagination and cost matrix

Run metadata-only and consumption matrices for N=1/10/100/101/300 and changed files k=0/1/many. Separate controlled provider tests from actual Notion results. Verify cursor progress, complete IDs, duplicate conflict detection, no reverse-relation 25-item dependency and no per-file metadata GET loop. A deliberate N+1 implementation must fail the cost guard.

Two independent real 101-file fixtures remain incomplete. The first stopped when its 77th create returned unknown, with 76 supporting files visible and the original operation still unsettled. The second stopped at its 97th unknown create, with 96 visible. Preserve both original operations and exact identities. Neither is a live 101 pass; controlled pagination results do not fill that evidence gap.

## SS11 — Delivery and remaining acceptance

Run the installed package against the same explicit entry after the public source path succeeds. Record archive integrity, installed executable path/version, Node runtime and exact results. Then run pro and mini on distinct physical machines, followed by the linked Broker native UI and real-model recipes. Mini is now reachable through its registered SSH connection and has independently available authentication; its installed package is the older 0.3.0. The candidate has not been installed or verified there. Connectivity and old-package availability do not complete candidate acceptance. Uninstalled candidate hosts, unopened UI or fixture-only model responses remain unrun.

Before any production migration, preserve an approved exact inventory, backup verification, existing user edits, old pins and original unresolved operations. A catalog with returned rows and failed coverage is not a complete migration list. Keep legacy schema-unknown operations intact for diagnosis. Production switch, AK ownership handoff, old caller retirement and release each need their own evidence; do not infer them from this recipe.

## SS12 — Read-only migration review

Freeze version 1 input according to the [migration evidence contract](../../../../docs/protocol.md#shared-migration-review), including the approved legacy identities, backup reference, catalog coverage and all preservation inventories. Drive the public command:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration plan --input "$MIGRATION_INPUT"
```

Require `mode:read_only_plan`, deterministic input hash/plan identity, complete retained input and stable Skill/File mappings. A blocker-free input is `reviewable`; incomplete evidence is `blocked`. Both must return `apply_allowed:false`, keep cleanup and original-operation replay disabled, and leave remote content and original local records unchanged. Reviewable output is not fresh remote verification or production authorization.

Cover incomplete catalog coverage despite many returned rows, IDs outside the explicitly approved scope, unverified backup, missing body retention, conflicting paths, unsupported source semantics, opaque legacy fields and unsettled original operations. Never remove unknown `external_assets` or original intent to satisfy the schema. The production read-only inventory with 300 returned rows and a failed Guizang source remains incomplete; the verified backup and two preserved schema-unknown operations do not resolve that blocker. This recipe provides no migration apply step.

## SS13 — Router member metadata and fixed index

Use a library whose descriptor registers native Members and a Router selecting accessible, enabled Skill members from that same library. Drive its ordinary current read, retain the returned Router snapshot, and read that exact fixed version:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$ROUTER_REF" --database "$ENTRY" --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$ROUTER_SNAPSHOT" --offline --metrics
```

Require complete relation pagination, batched member metadata, stable identities and the generated `## Members` list of name/ref/description. The Router's own body may be read or initially retained; none of its members' bodies, Files, Records or provider blobs may be prefetched. After deliberately changing a member name, description or membership in the owned fixture, a refreshed current Router must reflect the new metadata while the old snapshot keeps its exact index. Selecting an actual returned `MEMBER_REF` then reads that member's own snapshot lazily. A Router pin freezes the index, not every member's body version.

Cover renamed registered properties, more than 25 relation entries, 101-entry controlled pagination, incomplete/repeated cursors, disabled or missing members, foreign library/parent, Prompt/nested Router and stable-ID conflict. A valid nonmember claiming a selected member's ID must conflict, while unrelated malformed nonmembers do not become an unrelated failure. A library without registered Members fails before Router body observation or shared writes; ordinary Skills remain usable. Old incomplete shared Router snapshots must fail even with `--offline` instead of producing a misleading empty index or adopting today's metadata. Record installed-host/UI selection and actual model/member-body use separately under SS11.

## Evidence and cleanup

Keep a case ledger with case ID, exact entry point, runtime/artifact, remote fixture identity, expected and actual result, request metrics, exit status and evidence path. Mark every case `passed`, `failed`, `blocked` or `unrun`; keep observed facts separate from intended acceptance. Test-suite counts identify selected commands and must not be presented as total repository tests.

Retain private page IDs, raw Skill bytes, full shared pins and backup paths in external evidence, not public documentation. The architecture checkpoint may report sanitized counts and failure boundaries. Once all original unknown operations have been resolved or their required recovery state deliberately preserved, use the Skill's cleanup route. Never delete pending state or unrelated user records to obtain a clean verification run.
