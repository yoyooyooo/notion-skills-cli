# Bidirectional sync and read-cache verification plan

Status: acceptance matrix for the implemented CLI, updated 2026-10-28. Daily pinned `apply` and sync `connect/run` use the existing mutation, binding, plan and recovery contracts below. Advanced plan/apply/reconcile and read-policy flags remain available. [Protocol](../../../../docs/protocol.md) owns executable semantics; the [CLI design](../../../../docs/sync-cache-cli-design.md) records rationale. This document defines cases, not passing results; select the cases affected by the change and record actual outcomes in the external run ledger.

This plan applies Lauren Poteto Rules: exercise the user interface, inspect resulting state, preserve evidence, and distinguish deterministic regression proof from live-provider proof. The existing [verification Skill](../SKILL.md) owns launch, evidence and cleanup procedures. No live mutation is authorized merely by this plan.

## Outcomes and acceptance invariants

1. A one-sided edit reaches the other side without changing the bound Notion page identity. Differing two-sided edits stop without overwriting either side.
2. The common baseline advances only after confirmed convergence. A read, cache refresh, plan, conflict, failed write or unresolved outcome cannot advance it.
3. A fresh eligible cache hit performs no Notion request. Expiry, explicit refresh and sync/write operations follow their documented online validation policy. A cached validation time is an observation, not proof of present remote access.
4. Logical symlink paths resolve through the complete chain to their real targets. Existing links survive content updates; a changed chain or destination invalidates a saved plan.
5. Removing disposable cache leaves bindings, baselines, pinned snapshots, referenced objects and unfinished-operation receipts intact. Personal files and configuration remain outside the run.
6. Each successful snapshot contains the complete main/reference/asset set. Reference-only edits and page-only normalization cannot produce missing files or endless synchronization.

For the aligned native source-bundle path, establish the first checkpoint through complete publication/body/resource validation. Expire the ordinary observation without changing metadata: the installed CLI must reuse complete main/reference/script/binary files and report `freshness.validation="metadata"` without Markdown/block reads or repeated ZIP download. Change only a reference revision, root body, inclusion or immutable file identity and require full current reading, never stale fallback. Stable edits to committed content must become readable without an inspect/accept step; malformed ownership, incomplete resources and unfinished publication still fail. Original-operation verification and tracked/local write guards remain separate. Signed URL query renewal alone must remain eligible. Exercise a same-timestamp edit: ordinary metadata reuse may miss it under the accepted policy, while `--refresh` and explicit `--max-age 0` must detect it. New scopes/machines, cleared checkpoints, missing versions and mutable external URLs must require full validation. Verify writes/sync still read strongly; keep controlled-provider and live Notion outcomes separate.


## SQLite upgrade and crash boundaries (AH-256)

Mutable state belongs to `state.sqlite`; historical JSON paths are importer inputs. Only an existing pre-SQLite environment needs the independent installed `ntn-skills-migrate STATE --config-directory CONFIG --cache-directory CACHE --backup-directory EXTERNAL_BACKUP --old-writers-stopped` before normal commands. New/current SQLite environments do not run this migration. Stop old binaries/jobs first; the marker cannot revoke an arbitrary old executable. Record the private backup outside evidence containing credentials.

| Case | Actual action and required proof |
| --- | --- |
| Q1 | Migrate an old environment containing multiple bindings, initialized/uninitialized bases, fixed snapshots/assets, exact reviewed plans and pending sync/publication operations. New processes must read pinned bytes, inspect bindings/operations and preserve original IDs/digests. |
| Q2 | Interrupt validation/import/config retirement, then rerun unchanged input. Normal startup remains blocked until switched; changed source, missing/hash-invalid objects, unsupported schema and corrupt SQLite fail explicitly. |
| Q3 | Kill a real process holding an official transaction. A fresh process sees the old committed baseline/edge together, never half advancement. Competing registration/generation processes produce one accepted generation transition. |
| Q4 | Reserve a generation in one process, clear in another, then attempt delayed publication. Publication fails `CACHE_INVALIDATED`; pinned snapshots, objects, plans, bases and pending operations remain readable. |
| Q5 | Interrupt file publication before/after durable rename and before pointer commit. Registered snapshots always verify all referenced bytes; unreferenced durable files are permitted and preserved. |
| Q6 | Back up through `ctl backup --output DIR`, restore the DB and referenced files into independent roots, and consume with a new installed process. Record SQLite version, journal mode, synchronous mode and bounded busy failure from actual Node runtimes. |

`sqlite-state.node.test.ts` uses real competing/killed Node processes and filesystem bytes; `config.node.test.ts` covers persistent retirement/corruption. Both run through official Effect Vitest integration with `bun run test:node`; the root `bun run test` also runs the pure Bun suites. Installed package migration is driven by `package-smoke.ts`. Neither controlled boundary proof nor a local test pass establishes live Notion or host acceptance. Record each case as implemented/tested/unverified with machine evidence. SQL cache retirement no longer depends on Trash; Trash remains required when retiring actual user/installation files.


## Three evidence layers

| Layer | Environment and entry | What it proves | What it cannot prove |
| --- | --- | --- | --- |
| Deterministic regression | Existing core test runner, injected provider and clock, isolated filesystem | Change classification, TTL boundaries, negative write paths, partial/unknown outcomes, restart transitions and link races | Actual Notion acceptance, real authentication or service timing |
| Real CLI and Notion | `bun run dev`, default official `ntn`, isolated config/state/cache, designated disposable pages | Actual push/pull, Reference changes, saved content, identity preservation and warm-read timing | Every transport failure or atomic provider commit |
| Installed consumer | Existing `bun run package:check` and `scripts/package-smoke.ts`, npm tarball installed outside the workspace, Node.js | Packaged flags, XDG routing, offline cached reads and persisted state across CLI processes | Live Notion operations from seeded offline fixtures |

A planned recipe is not a passing result. Do not infer the Node.js surface from Bun-only proof or actual provider behavior from a fake service. Maintainability review checks ownership of baseline writes, strong-validation bypass and symlink commit handling separately from runtime assertions.

## Isolation, fixture and harness prerequisites

Extend the existing helper only where the new surface requires it:

- The helper creates private `scratch/config`, `scratch/state`, `scratch/cache` and `scratch/data` and overrides the application roots plus XDG config/state/cache/data bases. Installed-consumer smoke also overrides all four roots/bases. Builtin management requires an owned HOME for default shared links. Verify selected paths in each run; root overrides alone do not prove a path honors them. Keep live runs on official `ntn`, with no alternate REST implementation.
- Parent Bun startup may write a transpiler cache before helper isolation is active. Strict filesystem-sentinel proof must give that launcher an owned separate XDG cache outside the initially empty run root and include it in evidence/cleanup; distinguish it from child product writes.
- Preserve local manifests, content hashes, baseline versions, link text/resolved destinations and operation receipts in `evidence` before cleanup. Keep content and IDs private; record argument arrays, safe error details, exit status and timestamps, never tokens, signed URLs or raw provider stderr.
- Drive deterministic time at the application's clock boundary, not with five-minute sleeps or a production test-time environment variable. Use recorded requests at the injected provider boundary to assert reads versus mutations. Filesystem failure injection must target the actual commit operation, not return a fabricated success.
- Run each scenario in its own temporary directory and launch a second CLI process for persistence/recovery cases. Place an unrelated sentinel outside the owned run and prove it survives. Use the existing system-trash cleanup procedure; do not permanently delete scratch or unrelated files.
- Use a dedicated disposable Skill with a valid unique English title, `SKILL.md`, two reference pages including one nested path, and one binary asset. For byte-preservation proof the database must have `Files`. Use a separate page-only Skill to exercise normalized Markdown equality. Native Skills require an actual accessible native database before claiming that branch.
- Create two independent local copies for multi-target scenarios. Create relative and multi-hop directory links, a linked parent directory and a per-file link in temporary locations. Record links and final destinations before the action. Do not use the six retained user Skills as failure-injection fixtures.
- The real live fixture requires explicitly authorized page creation/edits and recorded page IDs. Modify reference pages through official `ntn` as an independent editor when testing Notion-side changes, then reopen through `ntn-skills`; do not use the sync implementation to synthesize both sides of a round trip.

## Sync regression matrix

`B` denotes the last confirmed common baseline; `L` and `N` denote current local and Notion content under the bound storage mode. Compare bytes where preservation is supported and normalized portable identities in page-only mode.

| ID | Setup and action | Required observable result |
| --- | --- | --- |
| S1 | First connect/bind with identical content; repeat connect and run | Correct page/path binding, reused same edge, initialized common baseline and no content mutation on repetition; timestamp changes alone do not imply content change |
| S2 | First connect/bind with existing differing content and no base | Neither side is selected implicitly; explicit `--from local|notion` initializes only the bound page/path and is confirmed by readback |
| S3 | Local-only main/reference/asset addition, modification and removal | Plan selects push; apply preserves page ID and unrelated files, exports the exact expected file set, and advances baseline only after verification |
| S4 | Notion-only reference edit with unchanged main body; apply | Plan selects pull; the changed reference reaches local storage and the complete Skill remains present |
| S5 | Both sides independently reach the same new content | Convergence is recognized without a content write; baseline records the observed new content |
| S6 | Both sides differ from B and each other, including changes in different files | Whole-Skill conflict under the proposed conservative policy; both contents and baseline remain intact, no mutation request or local overwrite |
| S7 | Save plan, then modify local content or remote main/reference before apply | Stale plan is rejected before its content writes; independent edit survives and baseline does not advance |
| S8 | Rename bound Notion page, create a same-alias decoy in another database | Binding follows original page ID, never redirects by alias; unsupported metadata changes stop explicitly rather than creating/rebinding a page |
| S9 | Sync A to a new version, then sync independent local B with its older baseline | B still detects the remote change. Divergent candidates from A/B conflict before a batch overwrites either candidate |
| S10 | Two logical paths resolve to one real directory; then bind that directory to distinct pages | Same-edge target is handled once; incompatible bindings fail before writes |
| S11 | An initialized binding loses its local root, remote access, link target or complete reference read | Explicit error, no whole-Skill deletion propagation, no successful shortened snapshot, unchanged baseline |
| S12 | Repeat pull/push in page-only mode with equivalent paragraph/link formatting | No endless update loop; equality follows the accepted normalization rules while code-fence content remains significant |
| S13 | Plan removes a tracked local file or an included reference | Local content is retained through system Trash with a receipt; Notion reference leaves the inclusion list while its page remains available; unrelated target-root content is preserved |
| S14 | First connect to an absent ordinary leaf under a resolvable parent | Connect initializes from Notion and creates only the intended directory; advanced bind alone stays uninitialized, and a dangling symlink is rejected |
| S15 | Batch plan has one local candidate and two unchanged independent copies for the same page | One remote update produces one verified accepted content set, then both copies converge with separate baseline generations; differing local candidates stop before writes |

A rejected plan may populate read caches. Compare baseline bytes and actual content, not arbitrary directory mtimes. Local metadata and source formatting that the storage mode cannot preserve must be classified explicitly rather than silently discarded.

## Symlink filesystem matrix

Run these cases against the real temporary filesystem, including cases where the target lies outside the logical Skill directory.

| ID | Setup and action | Required observable result |
| --- | --- | --- |
| L1 | Pull through a relative, multi-hop directory link and a linked parent | Final real-directory contents match the remote portable Skill; `lstat` and `readlink` show that every pre-existing link survives |
| L2 | Modify the real directory, then push through its logical path | Local change is detected at the real target and read back from the bound Notion page |
| L3 | `SKILL.md` or a reference is itself a link to a real file | Update the final file, preserve the per-file link, and do not replace it with a staged regular file |
| L4 | Change a root, parent or per-file link after plan; include retargeting to a byte-identical directory | Apply stops before writing to the replacement target; both the previous target and new target retain their content |
| L5 | Break a chain or introduce a link cycle | Clear nonzero failure with no baseline/content change and no interpretation as deletion |
| L6 | Inject chain/target change between execution preflight and commit | The actual commit boundary rejects target drift. A single earlier `realpath` check does not establish this property |
| L7 | Run two sync processes against the same real target | The second process is fenced or fails stale-state checks; it cannot overwrite a changed base or publish a mixed successful result |

Do not atomically rename a staged directory over a logical symlink or replace a linked file. A successful response alone cannot prove link preservation. If the implementation cannot fence the preflight-to-commit race, report that limitation instead of marking L6 passed. Generated Agent Kit views remain subject to later distribution; verification proves the requested write destination, not persistence against a different distributor's later writes.

## Cache, time and identity matrix

The designed default is TTL = 300,000 ms. Test exact boundaries with a controlled clock; never derive freshness from access time or from main-page edit time alone.

| ID | Setup and action | Required observable result |
| --- | --- | --- |
| C1 | Cold read followed by a fresh eligible read | Same complete version/content; warm call adds zero provider requests and does not move `validated_at` or the sync baseline |
| C2 | Read at validated_at + 299,999 ms, +300,000 ms and +300,001 ms | First call hits cache; expiry calls validate online. Evaluate boundary cases in isolated runs so one refresh does not reset another case's TTL |
| C3 | Repeated cache hits followed by expiry; simulate a clock rollback | Hits cannot indefinitely extend freshness; negative/invalid age forces validation or explicit offline handling |
| C4 | Explicit refresh during TTL; ordinary read after an independent remote reference edit | Refresh sees the change immediately. Ordinary reads may show the bounded old version during TTL but must reveal the new complete content after validation |
| C5 | Remote version unchanged during refresh | Keep immutable snapshot/content objects stable, update validation observation only; do not claim a new content version |
| C6 | Expired cache with network/rate-limit failure, then explicit `--offline` selection | Default online read fails; offline reads report age/source and fail on missing or unsafe-scope selection. Failure does not reset `validated_at`; no stale-on-error flag is required |
| C7 | Online validation returns denied/missing/unauthorized | No automatic stale fallback. Content checksums and old cache do not prove current permission |
| C8 | Change token, workspace, API endpoint or official-login identity | No automatic reuse across identity scopes. Zero-network eligibility is claimed only when local identity can be distinguished safely; an undetectable official-login change must retain online identity checking |
| C9 | Rename a Skill or introduce alias ambiguity; read using page ID and scoped alias | Cache keys preserve identity/database scope; strong refresh discovers ambiguity or rename instead of selecting an arbitrary cached page |
| C10 | Corrupt/remove the latest index or a referenced object | No corrupted successful read. Online mode rebuilds disposable indexes safely or reports corruption; pinned reads retain integrity errors |
| C11 | Remove only XDG cache; start a new process | Bindings, common baseline, pending receipts and pinned reads survive; current read repopulates cache without adopting a new sync baseline |
| C12 | Warm cache contains old remote N; local differs; then run sync/write | Online validation discovers actual remote change and rejects conflict. Read TTL cannot authorize an overwrite |
| C13 | Successful local mutation followed immediately by ordinary read | Read uses verified new content; it cannot return the previous still-fresh pointer. Partial/unknown writes invalidate affected latest pointers until reconciliation |
| C14 | Two processes refresh one Skill concurrently; inject interruption while publishing cache/snapshot | Readers observe a complete old or new version or an explicit error, never a partially published manifest; latest pointer cannot regress to an older observation |
| C15 | `read`, `open`, `files`, `export` and relative pinned reads under their declared policies | Exercise every entry point whose semantics change; returned file refs stay in one complete snapshot, and historical refs remain immutable |
| C16 | Upgrade a state containing old catalogs and immutable snapshots to an empty new cache root | Normal current read rebuilds disposable indexes; pinned versions remain readable, old catalogs cannot manufacture a fresh Skill observation, and no common baseline is invented |
| C17 | Refresh one bound page in another process, then run local-only `sync status` and offline `cache status` | Output reports observed remote version/time and provisional comparison; no network or baseline change. Explicit sync-status refresh can change the observation but cannot claim synchronization |
| C18 | Clear one target cache in a scope containing other targets and incomplete/ambiguous catalogs | Only appropriate observations are retired; retained catalogs cannot gain a false exhaustive status. Other scopes, baselines, plans and content objects survive |
| C19 | Clear a batch containing content and catalog observations where system retention is unavailable or fails on the first move | Every selected content/catalog observation is invalidated before retention begins; delayed publishers are rejected. Unmoved bytes, pinned content, baselines/plans/receipts remain intact despite the explicit nonzero retention error |
| C20 | `ctl cache identity [--database SELECTOR]` across equivalent database selectors, local preference/TTL changes and changed credentials/remote selection | Equivalent database aliases/IDs/URLs retain identity; cwd, executable spelling, local roots/preferences, TTL and sync bindings do not partition it. Changed credentials, selected databases or upstream catalog scope change identity. The effective TTL is returned separately; no token/network output. Run `bun test packages/cli/test/cli.test.ts --test-name-pattern 'consumer catalog identity'`; actual Pi/OMP shared-index/export/session proof belongs to the Broker's [shared-cache route](https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md#共享-notion-缓存). |

Test XDG base precedence and application-specific overrides in fresh child processes, including `NTN_SKILLS_DATA_HOME` over `XDG_DATA_HOME` for builtin storage. Online commands may retain HOME for official authentication; local builtin commands require an owned HOME and data root. Assert outputs stay inside the owned run, keep configuration secrets out of output and observe actual selected directories. Cache cleanup never acts as state cleanup or object garbage collection.

## Command acceptance

The [protocol](../../../../docs/protocol.md) owns exact parameters; these cases validate their implemented consequences. The [CLI design](../../../../docs/sync-cache-cli-design.md) records the accepted decisions. Inspect actual help before capturing command evidence.

| ID | Setup and action | Required observable result |
| --- | --- | --- |
| P1 | Combine read-policy flags, repeat singleton flags, submit invalid/overflow durations or pinned refresh | Exit 2 before online work or mutation; valid zero/suffixed durations follow the declared policy |
| P2 | Bind with `--dry-run`, then register equal/different contents | Dry-run does not save a binding/baseline; equal registration initializes a verified base, differing registration reports uninitialized without copying content |
| P3 | Plan without a binding/`--all`, combine both, or use `--from` with `--all` | Invalid arguments fail before writes; explicit single-binding source choice still enforces remote/content/link preconditions |
| P4 | Apply by exact plan ID or copied JSON; alter the plan or registered binding | Valid artifacts refer to the same immutable plan; tampering or drift cannot authorize writes |
| P5 | Import a differing name using a pinned explicit target; repeat using stale/missing/non-main targets | The bound page identity remains stable; unsafe/stale targets are rejected with no create/name fallback |
| P6 | Unbind or clear only cache, then inspect content and retained state | Content, common bases and receipts survive; deactivation does not silently redirect another binding |
| P7 | Save/clear cache policy and launch a new CLI process | New reads use effective policy; other config fields/token presence remain intact and secrets never enter output |
| P8 | Reconcile an unfinished write, then request another apply | Fresh readback precedes any new write; already-converged content can advance the baseline without replay, unresolved outcomes remain explicit |
| P9 | Save a plan with `--output`, repeat identical output, then use a differing occupied file | Plan ID and reviewed copy correspond; reuse is allowed, differing output is rejected without replacement; helper import-plan JSON is rejected by product apply |
| P10 | Bind a duplicate edge or label, unbind with/without dry-run, then attempt an older saved apply | Exact duplicate edge is reusable; label collision cannot redirect a binding. Dry-run leaves configuration intact, real deactivation preserves content/receipts and invalidates older applies |
| P11 | Drive root/subcommand help, raw output, errors and both TTY/non-TTY conflict paths | Actual help lists implemented flags; JSON commands emit one value, raw remains text-only, safe errors contain no secrets, and no interactive conflict choice is introduced |

## Interruption and unknown outcomes

These faults require deterministic orchestration at observable boundaries; use the existing injected provider and filesystem capabilities, then restart through the public use case/CLI. Keep fake-provider proof separate from ordinary live acceptance.

| ID | Interruption point | Required observable result after restart |
| --- | --- | --- |
| R1 | Before any mutation | No content change or baseline movement; new plan can be generated safely |
| R2 | Notion accepted a body/property/reference change but its response was lost | Preserve unknown-outcome receipt; read back before another write; do not duplicate child pages or automatically replay the mutation |
| R3 | Some reference/file operations succeeded and another failed | Explicit partial result, old common baseline retained, affected latest pointer not trusted as a successful current version |
| R4 | Both sides were updated but process stopped before baseline publication | Reconciliation verifies both sides and converges baseline without replaying an already accepted content change |
| R5 | Local commit fails due to permission/disk/rename error | No success or new baseline; retain staged/old bytes and receipt needed to reconcile actual per-file results |
| R6 | Baseline or receipt is malformed; start another process | Stop with a state error; never reinterpret lost/corrupt baseline as authority to overwrite an existing target |
| R7 | Grouped remote push succeeds, one local fan-out completes and another fails | A receipt distinguishes remote and each local result; only verified converged bindings advance their bases. Reconciliation does not replay the accepted remote write or hide remaining divergence |

Inspect complete file sets and reference IDs after recovery, not just response codes. The Notion provider currently has client-side preflight rather than an atomic multi-request compare-and-swap; these tests must not be reported as proof of server-side atomicity.

## Live acceptance sequence

After implementation and deterministic tests pass, execute one small end-to-end sequence against the designated fixture. Capture fresh readback and portable file hashes after each mutation:

1. Initialize isolated config/state/cache, diagnose official `ntn`, import the fixture through the real CLI and establish an equal binding. Record page/reference IDs, complete file manifest and baseline.
2. Edit one local reference and the binary asset, generate/apply a push plan, reopen the page with the strong-read policy, and compare exported bytes with the expected local files. Repeat sync to observe no content writes.
3. Independently edit only a Notion reference through official `ntn`; perform a strong read, generate/apply a pull plan through the multi-hop local link, and inspect the final real files and link identities.
4. Make differing local and Notion edits; generate a conflict and attempt the documented rejected apply. Read both sides again and compare them with pre-attempt evidence. Then resolve using the chosen explicit policy, confirming page identity and convergence.
5. Save a valid plan, retarget one link to a byte-identical alternative, and prove apply rejects it without altering either destination.
6. Read once to establish cache, repeat within TTL, then independently change the reference. Verify ordinary read's bounded-old result and immediate explicit refresh result. Record snapshot IDs, sources, validation times and wall-clock timings.
7. Run the page-only round trip with equivalent formatting; repeat sync and verify stable semantic content rather than expecting byte equality the provider cannot preserve.
8. Move only run-owned cache to system Trash, restart the CLI, confirm pinned reads and baseline persist, then perform an online read to rebuild the index. Export required evidence before normal scratch cleanup.

Extend the existing helper's `cli` mode to drive actual implemented commands; do not invent a `sync` helper mode or copy product synchronization logic into the harness. Consult `--help` before capturing final recipes. For TTL correctness use clock-controlled regressions; the live run need not sleep five minutes. Authorization for the fixture is separate from authorization to change retained user Skills.

## Feature-map and harness maintenance

The [feature-map command coverage](README.md#accepted-design-coverage) connects every implemented command to case IDs and proof layers. Update that mapping, this matrix and executable recipes together when a flag/default/result changes.

The helper's migration plan `{database,entries:[...]}` at `evidence/plan.json` is an import-verification input. A product sync plan `p_<sha256>` is persisted under the product state root and carries binding/version/path preconditions. Use `IMPORT_PLAN` versus `SYNC_PLAN_ID`/`SYNC_PLAN_FILE` in new recipes; never pass one schema to the other's `--plan` entry. The outer helper accepts a product plan only as CLI arguments after `--`.

Fresh live readback explicitly bypasses read TTL with `--refresh`: the helper's import/verify/reuse observations and current-target read/write/export recipes use it. Pinned reads continue using their fixed versions.

Keep an external case ledger with case ID, source revision/runtime, entry point, expected result, outcome (`passed`, `failed`, `not_run`) and evidence paths. A plan ID or helper exit without content/state readback is insufficient. Do not commit private Skill content, page IDs or failure logs into the recipe map. New commands remain unrun until implementation and the required fixture are available.

When changing this Skill's instructions, evaluate agent use separately from product behavior: a routine offline read, a conflict and an unknown-write task should demonstrate correct route selection, actual interface use, evidence collection and recovery ordering. Use fresh sessions where available and do not supply expected actions in the evaluated task. Record this instruction evaluation as unrun if no such session was exercised; adding prose does not prove better agent behavior.

## Performance proof

Use the same Skill, authentication mode, process entry, complete content and network environment for cold/strong-refresh versus warm eligible reads. Preserve per-run wall time, cache policy, snapshot ID, validation observation and safe provider request counts when actually observable. A changed result is not a comparable warm-read sample.

Use a small fixed repeated sample (for example five runs per mode), report individual samples plus median, and exclude warm-up/setup explicitly. Count zero remote calls at the recorded provider boundary in deterministic tests; independently launch a warmed eligible CLI with an unavailable `ntn` executable outside the normal live helper to prove it does not depend on that executable. This is failure-injection/offline proof, not live authentication proof. Official-login modes that require online identity validation have a different expected request count and must not be labeled zero-network.

The acceptance invariant is elimination of remote calls for eligible fresh reads, correct result bytes and bounded freshness. Do not prescribe an unmeasured speedup factor or infer zero requests from a short elapsed time. References revalidation may still require full page/attachment reads; reducing expiry-time calls is a separate claim requiring its own correctness and measured evidence.

## Test placement, evidence and completion gate

Core tests reuse injected `Notion`/`Store` layers, controlled Effect clocks and isolated real filesystems. Closure-local request counters observe provider calls; sync-local tests inject faults at actual filesystem commit boundaries. These fixtures do not replace real-provider proof.

| Area | Implementation and evidence boundary |
| --- | --- |
| Clock/cache freshness | Core `cache.test.ts` uses injected provider and Effect Clock for exact age boundaries, scopes, complete content and retirement; `catalog.test.ts` owns discovery/title invariants |
| Bind/plan/apply/recovery | Core `sync.node.test.ts` runs through official Effect Vitest on Node, using provider/store capabilities, a Node HTTP fixture and the real filesystem adapter for common baselines, grouped operations, saved plans and partial/unknown receipts |
| XDG routing and publication | Core `config.node.test.ts` exercises root precedence, causal generations and retirement with real Store/file boundaries on Node |
| Real links and local commit | Core `sync-local.test.ts` exercises multi-hop/parent/per-file links, actual commit-boundary faults, retained bytes and another process's locks |
| Immutable snapshots/References/import | Existing snapshot/References/write/import suites protect fixed refs, complete versions, explicit-target page identity and semantic reuse |
| CLI/Node.js packaging | CLI tests launch the source command with isolated roots; package smoke installs a packed npm consumer and launches it through Node.js |

Permanent tests cover consumer-visible conflict, freshness, identity, recovery and filesystem behavior. CLI/package suites own command and distribution boundaries. Real-provider runs and repeated timing collection remain external evidence; seeded package fixtures prove offline consumption.

For each case retain setup, expected behavior, exact entry point/arguments, exit/error, before/after portable identities, baseline bytes, file hashes, safe request observations and link proof where relevant. Record `passed`, `failed` or `not_run` with a reason; a fake-provider run cannot turn a missing live branch into passed. Cleanup receipts must show retained evidence and system-trash handling.

Completion for the affected behavior requires:

- Required regressions pass, including stale plans, reference-only change, TTL boundary, baseline/cache separation, per-file links and partial/unknown recovery.
- The supported real CLI push/pull/conflict sequence passes with readback; unsupported/unavailable provider storage modes remain explicitly unproven.
- The installed Node.js consumer exercises affected entry points and XDG separation, including central data storage and shared links when explicit installation changes. Historical migration/operator cases need separate evidence only when their behavior changes; they are not daily setup steps. Run `bun run check` and `bun run package:check` after integration.
- Public behavior documentation and recipes are updated together: protocol, usage, both READMEs, host/Bootstrap Skill guidance and affected verification entries. Document edits do not count as runtime evidence.
- Review verifies baseline has one convergence writer, cache freshness cannot authorize mutations, and local commits preserve/fence real destinations. Report the provider's non-atomic commit limitation and any unresolved filesystem race accurately.
