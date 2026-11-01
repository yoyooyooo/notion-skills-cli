# Shared Notion SSOT verification

Verify the implemented AH-498 slice through `ctl library`, ordinary `list/read/files` and native `create/apply/write/update`. The [shared authoring guide](../../../../docs/shared-authoring.md) provides the user workflow; SS12 covers N15 migration review/execution, and SS14–SS16 below cover N07 file lifecycle, N10 fixed compositions and N13 authoring. The [protocol](../../../../docs/protocol.md#shared-notion-library) owns command semantics; the [architecture checkpoint](../../../../docs/shared-ssot-architecture.md) records observed results and open work. This recipe defines acceptance work. Its presence is not a pass, and the complete epic remains open.

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

For native ownership cases, select an owned fixture with a valid Skill ID, main File ID and at least two distinct supporting File IDs, canonical logical paths, exact Skill relations and complete editable bodies. Preserve how those rows were created. `ctl library init` creates tables; use ordinary `create INPUT --database ENTRY` with the complete authorized UTF-8 Skill folder to populate a native fixture through SS16. Keep its returned stable identities and create operation. Authorized native Notion editing remains available for natural-edit cases. Do not use legacy References import or hand-written ownership/proof facts to manufacture shared acceptance.

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

### Current effective-tree references and historical pins

Validate deterministic local Markdown links/images after fixed Base/Mount files, native whole-file customizations, tombstones, logical moves and canonical main generation form the complete effective tree. A provider-only subtree may be incomplete until custom files supply its targets or replace its body. Current reads must return `SHARED_REFERENCE_BROKEN` for any unresolved final target before publishing a snapshot. Existing broken references also block an unrelated lifecycle addition; do not introduce a delta-only exemption.

Exercise the retained failure shape with synthetic data: an HTTP README with seven missing relative targets, an unrelated plain-text addition, a custom file that supplies a provider target, and a complete custom body that replaces broken provider Markdown. Change an upstream script path while retaining the custom main's old reference and require an explicit current failure. Verify that a previously admitted unchecked current cache fails without network access for both TTL hits and unpinned offline reads. Reading that exact historical pin must still verify and return the original bytes with zero requests.

The 2026-11-01 real mixed-fixture lifecycle dry-run stopped on seven inherited HTTP links before mutation and without a file-management operation ID. Preserve that run as a negative result. Its earlier N11 source-selection, reuse, rollback and historical-byte evidence belongs to the recorded CLI versions before the consumption reference gate; do not relabel those results as a pass under the new gate. Any positive lifecycle run on an already existing complete native fixture is separate evidence.

## SS04 — Whole-file adoption persists

Use native Notion editing on the owned fixture to make one substantive main-body change, then one supporting-body change. Keep the unchanged files' exact hashes and state heads for comparison. Read the current target with `--refresh --metrics`, inspect shared state, and require the entire changed file to become `custom` with retained exact normalized bytes. Only CRLF-to-LF normalization is permitted in normalization version 1.

Change that body back to the earlier text, read again and require it to stay `custom`. Change only Name or Description and verify unchanged normalized body does not create an adoption event. A source-following fixture must use an actual established projection baseline; never substitute the latest Git text as a baseline. SS14 drives restore-follow, tombstone and movement through their public actions; `ctl library state` only inspects their results.

Repeat state/retained-body reconstruction in a fresh independent state root using the same authorized remote library. This proves cache independence on that host. It does not count as a second physical machine.

## SS05 — Expiry, full verification and metrics

After a complete warm read, record the verification time and run the ordinary current-target path after its chosen short age has expired:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$CURRENT_REF" --database "$ENTRY" --max-age 1s --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- files "$CURRENT_REF" --database "$ENTRY" --metrics
```

For unchanged content, require metadata-only revalidation, no shared state writes or provider/body downloads, and the same snapshot ID. An earlier, separate three-file expired example used six metadata requests; this is not the cost of the reviewed-history fixture below. Repeat an eligible TTL hit and require zero requests without advancing body verification time. Separately exercise `--refresh` and `--max-age 0` as full validation; do not count them as the cheap expiry path.

Include an original `needs_review` body write that was completed by an independent public `accepted_observed` review. Retain the original plan, response, preimage, candidate and review chain. Current consumption may reuse the verified canonical Record envelopes only after a fresh, fully paginated metadata query that excludes Payload and verifies the exact remote page/Record/Skill/Kind/Entity/Hash/version identities. The cache receipt is scoped to credentials and the library; the retained object and canonical envelope hashes are checked again locally. Authoring preflight and review dry-run must keep their existing behavior. Missing remote facts, partial reviews, conflicting duplicates, changed page versions and corrupt cached objects must not be accepted from a local completion marker.

Record the first cache-filling read separately: an empty or upgraded cache needs additional metadata and complete retained-body reads. Then use the same homes and unchanged target for the expired samples. Preserve the real pre-fix failure, which returned the same snapshot but made 14 metadata and 6 retained-body requests. The formal pre-fix regression reproduced those six retained-body reads; the controlled fix now requires exactly 15 metadata requests and zero body/write/provider requests for its one reviewed history: three pagination requests, one Skill request and 11 named history queries. This bound belongs to that fixture; do not inflate a fixed constant to conceal per-file or growing history work. Keep the original failed/stopped run unchanged; the independent successful measurement below does not rewrite its verdict.

The 2026-11-01 real N02 run at source commit `6df0c30143d3de5d74dae45e20d30c131f85045a` completed 61 eligible Node CLI processes on one host. This is one native fixture with two logical files and three physical files, including retained write/review history; exact-pin reads use the original N13 historical pin. It is not a measured N=1/10/100/101/300 or changed-file-count matrix (`full_N_k_matrix_claimed=false`).

| Path | Successful samples | Remote requests per sample | CLI process timing (ms) |
| --- | --- | --- | --- |
| Cold cache fill | 1 | 27: 20 metadata, 2 current-body, 5 retained-body; zero writes/provider | Single duration 43,548.159; no percentiles |
| Warm current | 20 | Zero throughout | p50 329.364; p95 668.813; min–max 302.879–706.972 |
| Expired current | 20 | Exactly 20 metadata each; zero current-body, retained-body, writes and provider | p50 28,691.717; p95 35,386.392; min–max 23,465.101–39,016.385 |
| Original N13 exact pin | 20 | Zero throughout | p50 314.781; p95 389.819; min–max 281.967–404.577 |

The cold sample transferred 6,512 request bytes and 189,995 response bytes, with peak concurrency 1, duplicate requests 0 and retry wait 0. Keep this initial current/history population cost separate from expired cache reuse. The real fixture's 20 metadata requests include pagination, Skill identity and original write/review history management. Explain that history work as K; neither this observed total nor the controlled fixture's 15 requests is a universal constant or proof of cost at every history size. The expired path meets the zero-body requirement while still taking 23.465–39.016 seconds here. Do not report it as generally low latency.

The process interval is actual Node CLI spawn through close, excluding build, executable/argument hashing and receipt writing. Percentiles use nearest rank `ceil(p * n)` on the 20 successful samples per group; displayed milliseconds are rounded to three decimals. Retain the exact samples: summary SHA-256 `85320a5c643056b40c62680d1bf4b0ad0a919736cf6bf792f3b21bf73416a81d`, samples SHA-256 `2d222433d5da147470d70c408d0332398f8fe6a5fcecc3dd437f4e058707586a`. Private fixture identities, pins and host paths stay in the external evidence.

Controlled-clock tests must prove that metadata renewal cannot push full-body verification past its independent 24-hour deadline, including unchanged reported page timestamps. Change one file and verify unchanged objects are reused. Test missing or corrupt local objects, member addition/removal, ambiguous identities and incomplete pagination without publishing partial snapshots.

`--metrics` is a root `list/read/files` flag. Shared `files/state/source inspect/register/snapshot save/restore` emit metrics automatically; descriptor inspect and init do not. Reject `read --raw --metrics` with structured error JSON before effects. Count retained body-bearing Records queries as body transfer, and split provider tree metadata from blob traffic. Keep request counts, bytes, duplicate counts, peak concurrency, queue/retry waits, elapsed samples and sample count; never derive p50/p95 claims from one run.

For end-to-end CLI timing, use the command record's verified `cli_process_timing` receipt. Its interval is the actual Node CLI spawn through process close; build, executable/argument hashing and receipt writing are outside the interval. Collect warm, expired and exact-pin samples separately with the same declared fixture, homes and build. Missing or mismatched receipts, failed commands and timeouts cannot become successful samples. `request_duration` measures individual requests; an `operation_duration` with zero samples supplies no operation percentile. Preserve each successful process duration and state the percentile method and sample count.

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

For a new archive containing local-restricted bytes, require `LOCAL_RESOURCE_ARCHIVE_REQUIRED` without authorization and zero archive writes. After reviewing that exact snapshot and its paths, drive `ctl library snapshot save "$SNAPSHOT" --entry "$ENTRY" --allow-local-archive` through the same helper. This authorizes only that archive; durable content restrictions survive it and cache clearing. An original pending archive still reconciles its frozen plan without replay. Restore-follow's same-named flag covers only its selected body, not arbitrary snapshots.

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

Exercise the public shared creation/mutation routes in SS16 and require their native protocol, with no hidden References/Publication fallback. Unsupported native binary creation, legacy `markdown_files` storage and mixed/multiple layout apply must fail before writes without omitting files. Existing legacy bindings retain their own supported recovery. Do not mark Profile or host supply complete from metadata parsing alone. Shared Router metadata consumption has SS13; it does not stand in for actual host selection or member-body execution.

## SS10 — Pagination and cost matrix

Run metadata-only and consumption matrices for N=1/10/100/101/300 and changed files k=0/1/many. Separate controlled provider tests from actual Notion results. Verify cursor progress, complete IDs, duplicate conflict detection, no reverse-relation 25-item dependency and no per-file metadata GET loop. A deliberate N+1 implementation must fail the cost guard.

Two independent real 101-file fixtures remain incomplete. The first stopped when its 77th create returned unknown, with 76 supporting files visible and the original operation still unsettled. The second stopped at its 97th unknown create, with 96 visible. Preserve both original operations and exact identities. Neither is a live 101 pass; controlled pagination results do not fill that evidence gap.

## SS11 — Delivery and remaining acceptance

Run the installed package against the same explicit entry after the public source path succeeds. Record archive integrity, installed executable path/version, Node runtime and exact results. Then run pro and mini on distinct physical machines, followed by the linked Broker native UI and real-model recipes. Mini is now reachable through its registered SSH connection and has independently available authentication; its installed package is the older 0.3.0. The candidate has not been installed or verified there. Connectivity and old-package availability do not complete candidate acceptance. Uninstalled candidate hosts, unopened UI or fixture-only model responses remain unrun.

The controlled phase11 checkpoint passed full typecheck/build, 9 pin verifier tests, shared core 658/658, and 5/5 Source tests through the actual built CLI with a controlled service. Broker 58/58 covers controlled adapter/View/model-observer behavior, not actual model responses. These suite results do not satisfy the live Notion, installed-host, UI or physical-machine cases below, and overlapping counts must not be summed into a repository total.

Before any production migration, preserve an approved exact inventory, backup verification, existing user edits, old pins and original unresolved operations. A catalog with returned rows and failed coverage is not a complete migration list. Keep legacy schema-unknown operations intact for diagnosis. Production switch, AK ownership handoff, old caller retirement and release each need their own evidence; do not infer them from this recipe.

## SS12 — N15 concrete migration review, approval and original recovery

Freeze version 1 input according to the [migration evidence contract](../../../../docs/protocol.md#shared-migration-review), including the original approval set, backup reference, catalog coverage and all preservation inventories. Keep the original unchanged; new observations belong in a separate draft. The offline inventory command remains:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration plan --input "$MIGRATION_INPUT"
```

Require `mode:read_only_plan`, deterministic input hash/plan identity, complete retained input and stable Skill/File mappings. A blocker-free input is `reviewable`; incomplete evidence is `blocked`. Both return `apply_allowed:false`, keep cleanup and original-operation replay disabled, and leave remote content and original local records unchanged. Plan output is neither a concrete execution review nor production authorization.

Bind `LEGACY_ID` to one exact retained identity, `RETAINED_FILES` to its complete managed directory or ZIP, and `RAW_RESPONSES` to exact `PAGE_UUID.default.json`/`PAGE_UUID.v2.json` files matching frozen `raw.native_preimage` descriptors. Bind `EXACT_SOURCE_FILES` to the complete selected fixed tree, including source-only assets; omit `--source-files` only for an unselected Source. Preserve original native JSON hashes/lengths, logical file bytes and proposed wire/readback hashes separately. Do not relabel a materialized snapshot or source ZIP as native wire evidence.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration review --input "$MIGRATION_INPUT" --legacy-id "$LEGACY_ID" --entry "$ENTRY" --files "$RETAINED_FILES" --preimages "$RAW_RESPONSES" --source-files "$EXACT_SOURCE_FILES"
```

Retain the complete product JSON as `MIGRATION_REVIEW` and its independently inspected digest as `REVIEW_ID`. Require `status:reviewed`, `dry_run:true`, `apply_allowed:false`, unchanged approvals and no Notion writes or create journal. Target-library and Router-member metadata reads are permitted and must be counted; do not claim zero remote requests. Report extra input paths and valid portable container metadata separately. Read-only review can defer entry/file gaps belonging to other independent records; preserve the complete input, every full-plan blocker and the original global readiness result. Keep the target's unknown ownership blocking; Source/preservation gaps and operation impacts that are unknown or reach its dependency closure remain failures. Router-member dependencies and same-physical-page aliases remain related; empty references cannot establish that an operation with unknown impact is independent.

For an ordinary legacy Skill/Prompt whose `Enabled` is absent, cover the explicit [active-page mapping](../../../../docs/shared-migration-activation.md): complete retained original page row and matching data-source schema, exact identities/property IDs/types and no Enabled definition. V1 requires both `archived:false` and `in_trash:false`. Explicit v2 with API `2026-03-11` requires `in_trash:false`, permits absent `archived`, and rejects contradictory archive flags when present. Require the review to show `original_enabled:absent` and the named activation policy without altering the raw row or record. Explicit Enabled values, activity flags missing under the selected policy, mismatched schema parent, filtered properties and Router input must fail. Retained v1 candidates must keep their original policy.

Only after an explicit decision on that concrete review, bind `APPROVED_INPUT` to a separate frozen input whose approved set includes the target. Only `approved_legacy_ids` and its derived readiness-basis hash may differ. Content, Source, native preimages, library, member bindings, preservation and isolation receipts remain review-bound. Exercise both gates through the same public command:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration apply --input "$APPROVED_INPUT" --review "$MIGRATION_REVIEW" --review-id "$REVIEW_ID" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration apply --input "$APPROVED_INPUT" --review "$MIGRATION_REVIEW" --review-id "$REVIEW_ID"
```

New public reviews bind `origin.candidate.execution_policy` into the candidate/origin/review digest. Ordinary targets use `copy_to_new_native_v1`; an explicit, validated `legacy_committed_publication_v1` descriptor selects `copy_to_new_native_v2`. Saved candidates without this field keep their original full-plan gate. Exercise the existing core boundary tests with `bun test packages/core/test/shared-migration-copy-boundary.test.ts packages/core/test/shared-migration-asof-boundary.test.ts` and distinguish these outcomes:

1. A complete, approved target A beside an independent, unapproved B with entry/file gaps can prepare, dry-run and create under the explicit copy policy while the full plan remains `blocked`. Keep B, its blockers and the entire input/preservation inventory unchanged. Empty approval, a changed policy under the old digest, same-page alias gaps, incomplete Router members and Source gaps must fail before writing. Unmarked saved candidates still fail their original full-plan gate in the A/B case.
2. A declared complete disjoint impact plus `isolation.verified:true` and receipt references can satisfy structural readiness without verifying the actual receipts. Require apply/dry-run and direct create execution to return `SHARED_MIGRATION_RECEIPT_UNVERIFIED`, naming the original operation and impact/isolation references, before any new journal or native write. Unknown operation impact remains blocking without such declarations too. Cover nested batch items and integrity `marker.creation` parent/subscription fields even when top-level page IDs and references are absent. Keep original unknown states and recovery paths; a boolean or reference alone must not unlock execution.

3. A v2 copy must reconstruct one complete retained publication from the original parent observations, committed manifest/guard, fixed member revision, authored export and native response bytes. Use [the retained-publication derivation](../../../../scripts/README-migration-publication.md) to produce a new draft with zero remote requests and unchanged approval/history/coverage. Drive the public review with its derived `native/` files, original preimages and complete fixed Source tree. Require `retained_operations` and `retained_catalog_coverage` in the review digest. An approved exact copy may create new pages while original operations remain unknown and the full plan remains blocked. Missing target bytes, changed Source, incomplete known aliases, changed retained history and a relabelled v1 review must fail before writes. Verify the new copy through ordinary `read/files/export`, compare its files against the frozen fixed Source, and confirm the original history remains unchanged. This proves the retained copy only; source cutover, current legacy terminal state and global enumeration remain separate gates.

Once the execution gates pass, require dry-run to return the frozen native plan with no journal, current-body read or Notion write. Real apply must reuse native create, keep the new Skill disabled until its complete files verify, preserve selected Source and file ownership, and verify the current snapshot read-only. Success requires `status:created`, `verified:true`, original operation/review/candidate IDs and a complete pinned snapshot. Compare old pages, original pins and unresolved operation evidence before/after; source cutover, caller retirement and cleanup are separate work.

Cover a wrong digest, approval-only change versus content/preimage/Source/member changes, unsupported layout, missing retention, unverified original-operation receipts, same stable identity with a changed name after an unknown POST, and absent cross-machine origin. A target's unknown operation must block a fresh write; do not clear it or remove unknown `external_assets` to satisfy a gate. For `WRITE_OUTCOME_UNKNOWN`, stop and preserve the original operation. For a completed native create followed by a changed or invalid current tree, require `WRITE_VERIFICATION_FAILED`, `native_create_completed:true`, `current_snapshot_verified:false`, `requires_fresh_read:true`, original verification error details and zero extra adoption. Do not mistake that error for zero prior writes.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library migration reconcile --entry "$ENTRY" --operation "$MIGRATION_OPERATION"
```

Bind `MIGRATION_OPERATION` to the original returned create operation. Without its local journal, add `--target "$NEW_TARGET"` using the exact new page from retained evidence. Require zero POST/PATCH/provider fetches and no current-body adoption or partial-tree resume. Success verifies only `verification:original_create_outcome`; `current_snapshot_verified:false` and `requires_fresh_read:true` remain, with no current pin. Preserve unresolved partial archives, missing outcomes and invisible first creates; never pass this operation to generic `operation resume`. Any later explicit current read is separate and follows normal adoption rules.

The controlled migration checkpoint passed 30 migration core tests and full typecheck; the preceding public-boundary checkpoint passed 23 core and 4 public CLI tests. These overlapping suites do not establish live migration or sum to a repository total. The real pilot's retained current files, fixed Source checks and 51 complete native responses are read-only evidence, not an approved or ready migration. Record target-local binding and receipt-blocking cases separately; the suite counts above do not prove an unexecuted case. No production cutover is claimed here.

## SS13 — Router member metadata and fixed index

Use a library whose descriptor registers native Members and a Router selecting accessible, enabled Skill members from that same library. Drive its ordinary current read, retain the returned Router snapshot, and read that exact fixed version:

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$ROUTER_REF" --database "$ENTRY" --metrics
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$ROUTER_SNAPSHOT" --offline --metrics
```

Require complete relation pagination, batched member metadata, stable identities and the generated `## Members` list of name/ref/description. The Router's own body may be read or initially retained; none of its members' bodies, Files, Records or provider blobs may be prefetched. After deliberately changing a member name, description or membership in the owned fixture, a refreshed current Router must reflect the new metadata while the old snapshot keeps its exact index. Selecting an actual returned `MEMBER_REF` then reads that member's own snapshot lazily. A Router pin freezes the index, not every member's body version.

Cover renamed registered properties, more than 25 relation entries, 101-entry controlled pagination, incomplete/repeated cursors, disabled or missing members, foreign library/parent, Prompt/nested Router and stable-ID conflict. A valid nonmember claiming a selected member's ID must conflict, while unrelated malformed nonmembers do not become an unrelated failure. A library without registered Members fails before Router body observation or shared writes; ordinary Skills remain usable. Old incomplete shared Router snapshots must fail even with `--offline` instead of producing a misleading empty index or adopting today's metadata. Record installed-host/UI selection and actual model/member-body use separately under SS11.

## SS14 — N07 native file lifecycle and restore-follow

Use one owned Skill with a complete baseline. Bind `NEW_PATH` to an absent supporting path, `MOVED_PATH` to a safe unused destination, `BODY_INPUT` to retained UTF-8 input, and `FOLLOW_PATH` to a customized file with an actual fixed-source baseline. Inspect each command's help and exercise its `--dry-run` first, requiring zero Notion writes. Positive add/move/delete inputs must keep the complete tree's relative links valid; the commands never rewrite references for the test.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library file add "$TARGET" "$NEW_PATH" --entry "$ENTRY" --input "$BODY_INPUT"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library file move "$TARGET" "$NEW_PATH" "$MOVED_PATH" --entry "$ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library file delete "$TARGET" "$MOVED_PATH" --entry "$ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library file restore-follow "$TARGET" "$FOLLOW_PATH" --entry "$ENTRY"
```

Capture fresh `files/state/read` results between completed operations. Add must create exactly one File identity/page; move must keep that identity, body and original source path; delete must retain the page/body and an explicit tombstone. Old pins retain their earlier inventory. Incoming or moved-file relative link/image breakage, path collision, unsafe paths, stale metadata/event heads, main move/delete and missing access must fail without weakening complete-tree checks. Missing access is never deletion intent; upstream reappearance cannot revive a tombstone.

Restore-follow must retain the complete custom body, use the exact currently selected revision and a moved file's original source path, then verify the new body and following state. Cover main and supporting files, missing source content, binary rejection, source changes during preparation and `--allow-local-archive` for the selected local body. Native Name/Description must remain authoritative. For unknown add/delete/move, preserve `OPERATION` and drive `ctl library file reconcile "$TARGET" "$OPERATION" --entry "$ENTRY"` through the helper. For unknown restore-follow, drive an exact current read; follow `read_again` after the original body operation settles. Neither path may repeat an unknown write or infer success from today's equal body. Record `not_applied`/`partial` as those verified outcomes, not completed edits.

## SS15 — N10 fixed composition, resource scope and Source selection

Use a reviewed immutable `COMPOSITION` fixture containing the affected Git/HTTP/local mounts plus native custom files. This advanced input is a fixed source plan, not a hand-authored adoption/proof requirement for daily Skill creation. Configure only its explicitly authorized machine/workspace resources through helper `cli`: `ctl library source resource bind-local BINDING --machine-scope MACHINE_SCOPE --workspace-scope WORKSPACE_SCOPE --workspace-root WORKSPACE_ROOT --root RESOURCE_ROOT`, and exact HTTPS origins through `resource http-policy --origin ORIGIN`. Machine-only HTTP retrieval input uses `resource http-locations --manifest FIXED_FILES --locations PRIVATE_LOCATIONS`. Copy placeholder values from the reviewed fixture; never put its machine paths, credentials or signed URLs into shared facts or the checkout. `resource show` must expose only redacted identities/policy.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source composition inspect "$COMPOSITION" --verify
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source composition register "$TARGET" --entry "$ENTRY" --manifest "$COMPOSITION"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source select prepare "$TARGET" --entry "$ENTRY" --source "$SOURCE_ID" --output "$SELECTION_PLAN"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source select apply "$SELECTION_PLAN" --entry "$ENTRY" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- ctl library source select apply "$SELECTION_PLAN" --entry "$ENTRY"
```

Bind `SOURCE_ID` from registration and `SELECTION_PLAN` to a new owned evidence file. Verify fixed hashes/lengths for every materialized byte and separate provider metadata/blob work. Composition registration must remain metadata-only and unselected; selection must use the unedited CLI-generated plan and change only native Source. Current consumption must preserve custom Notion files/metadata, moved source paths and tombstones while materializing the complete mixed tree. No branch advances implicitly. `--native` is the explicit alternative to `--source` when clearing selection.

Cover path/prefix collisions, missing or foreign workspace binding, revoked HTTP origins, wrong hashes/sizes and provider failures without another source fallback or partial snapshot. Local-content restrictions remain durable even when exact bytes are reused through another cache path; SS08 covers explicit one-archive authorization. Do not claim the origin policy is DNS-rebinding isolation. Unknown registration uses `source reconcile "$TARGET" --entry "$ENTRY" --source "$SOURCE_ID"`; unknown selection uses `source select reconcile "$SELECTION_PLAN" --entry "$ENTRY"`, both through helper `cli` with zero replay writes. Equal current Source is insufficient proof. Keep controlled resource/service cases distinct from real Git/HTTP/local/Notion consumption and independent-machine evidence.

## SS16 — N13 public native create and pinned authoring

Stage `AUTHOR_INPUT` as an ordinary UTF-8 Skill folder with main and two supporting files; preserve original bytes and expected complete paths. No manifest or adopt/proof command is required for this Skill input. Prompt/Router still use their explicit portable v2 kind declaration. After creation, bind `CURRENT_REF`, `PINNED_MAIN` and file refs from the returned/discovered exact record. Stage `CHANGE_INPUT` with only changed existing main/support files and an explicitly nominated `DESCRIPTION`. Re-read and rebind the current pin between separate completed mutations.

```bash
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$AUTHOR_INPUT" --database "$ENTRY" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- create "$AUTHOR_INPUT" --database "$ENTRY"
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- read "$CURRENT_REF" --database "$ENTRY" --refresh
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- apply "$PINNED_MAIN" --database "$ENTRY" --input "$CHANGE_INPUT" --description "$DESCRIPTION" --dry-run
bun .cursor/skills/verify-ntn-skills/scripts/control.ts cli --run "$RUN" -- apply "$PINNED_MAIN" --database "$ENTRY" --input "$CHANGE_INPUT" --description "$DESCRIPTION"
```

Creation must keep the new Skill disabled until its whole native body set verifies; retain exact Skill/File/page IDs, original input and `create_operation_id`. Name collision, binary input and unsupported projection must fail without partial omission. An interrupted same-intent retry must reconcile original allocations without blind page POST replay. For apply, verify complete fresh-tree preflight, changed main/support bytes and nominated native properties, unchanged other files/properties, and immutable old pins. Retain `apply_operation_id`, child outcomes, `changes`, scope and new refs. Exercise `write "$FILE_REF" --database "$ENTRY" --input "$BODY_INPUT"` and `update "$PINNED_MAIN" --database "$ENTRY" --description "$DESCRIPTION"` through the same helper with fresh baselines; retain their body/metadata operation IDs. Matching frontmatter is allowed; unrequested Name/Description changes, unsupported main fields or mismatched page identity are rejected. Record original-input, frozen request and projected-candidate hashes separately. Include an authored H1, inline code, bold containing inline code, and a fenced-code block in the native fixture; require the heading and literal code content to survive. Projection version 2 must select the create/file-add wire separately from body-write wire and freeze the expected native readback before dispatch. Use independent captured native responses rather than echoing request Markdown as the test oracle. Retained version 1 plans must reconstruct without adopting the new policy; projection does not permit arbitrary changed Markdown.

Controlled failures must cover stale pins, a stale later child after an earlier applied child, unknown child stopping the remainder, lost parent outcome resolved only from exact child outcomes, missing/corrupt original plans, and oversized complete envelopes before dispatch. Apply is sequential and non-atomic. One isolated add/delete is supported; mixed/multiple layout changes must return `SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED` before writes, with full reference checks intact. Exact-target replace inherits these limits. Native metadata has no atomic CAS. Require zero writes for dry-run and true no-op paths; an unchanged result creates no substitute operation. Shared current-read reconciliation must preserve original intent and refuse to turn missing facts into unsent work; shared IDs never enter legacy `operation resume`. The SS06 invisible-first-plan boundary remains open. Successful cases require the requested applied/already-unchanged result, `verified:true` and no dry-run; a verified `not_applied`/`partial` recovery is not success. Fresh-session builtin/help usage, actual Notion writes and installed-host/model behavior remain separate evidence.

The 2026-11-01 real native-fixture lifecycle checkpoint passed 35 public CLI commands across the add (15), move (7) and delete (13) stages, including their verification commands. All three stages used the same frozen CLI artifact, SHA-256 `9da56444052e6587dc0788782bea0cfac7ab6a7d270551dfce288d9f8b34a9dd`. The final verified inventory contained two logical files, three physical files and three retained file bindings; delete preserved the removed file through its tombstone and retained binding. The accepted baseline, post-add and post-move pins retained all original physical-file bytes (3, 4 and 4 files respectively), and their exact-pin reads reported zero remote requests. Keep restore-follow and the remaining SS14 cases separately evidenced.

The earlier v1 lifecycle controller stopped after three offline, read-only commands because its expected renderer framing differed. Preserve that stopped run and its original inputs/results unchanged. The later successful stages use their own evidence and do not overwrite or relabel the earlier stop.

Projection policy 4 adds the independently observed simple-list spacing, inline-link label rendering and unaligned-table padding. Policy 5 additionally predicts the native blank separator between a paragraph and its following list. Exercise the retained restore-follow discrepancy with original input and response kept separate, then require a new plan and digest before another write. Verify old policy 1–4 plans and migration candidates still reconstruct with their original versions, including the final native create plan. Keep multi-paragraph lists, nested lists and fenced content intact; unproved alignment or table spans must fail before dispatch. The focused regression is `shared-notion-projection-v4.test.ts`, which covers the separate v4 and v5 policies. A matching later diagnostic GET is evidence for prediction, not the original mutation response. Actual creation and current read still need separate outcomes; a partial disabled migration remains under its original review outcome and cannot be restarted under a new policy to bypass it.

## Evidence and cleanup

Keep a case ledger with case ID, exact entry point, runtime/artifact, remote fixture identity, expected and actual result, request metrics, exit status and evidence path. Mark every case `passed`, `failed`, `blocked` or `unrun`; keep observed facts separate from intended acceptance. Test-suite counts identify selected commands and must not be presented as total repository tests.

Retain private page IDs, raw Skill bytes, full shared pins and backup paths in external evidence, not public documentation. The architecture checkpoint may report sanitized counts and failure boundaries. Once all original unknown operations have been resolved or their required recovery state deliberately preserved, use the Skill's cleanup route. Never delete pending state or unrelated user records to obtain a clean verification run.
