# NXT maintenance and consumption delivery

This records the AH-1050 acceptance run begun on 2026-11-15. The owning tickets define the completion gates; code, controlled HTTP, real Notion, installed packages, actual Pi, and bounded model behavior are separate evidence classes.

## Exact starting inputs

- CLI baseline: `4580b7d6d692013091d5c66e90d703d51fd5fb10`; continue existing PR #10.
- Broker baseline: `2d8e112ed7b6b7e0b55372eb3284f1692bc5d12f`; continue existing Broker PR #12.
- Owned test library: `library-c7f71664-a24e-44a2-a20d-a30cbf7d17e1`; entry `4195636c-236e-8104-aafa-f7366fe421ce`.
- Original six-file Skill: `skill-908879fb92f1a4b4f957b440a011ea5cc13b16a2f450c5af926bf62cfa066566`; page `4195636c-236e-81e0-be28-ed9a783bd84a`.
- Original snapshot: `s_e086282444fc61d2da3f7b5ad78056be63fe3e202df8fc408f2ee71eb7a4bdcb`.
- Fixed Git input: `nowledge-co/community`, A `d6e546efe17c9ba48291a67356c4be6f7a7883a8`, B `657919af19c22951796b326af44032a63dec24f2`; only the two preselected member roots are in scope.
- Original evidence root: `/Users/yoyo/Documents/code/personal/verification-evidence/nxt-20261115-jTFsQ9`. Original outputs, failures, journals and .started dispatch markers are retained there. No credentials are included in this document or those command envelopes.

## Verification corrections that remain part of the evidence

The first CLI envelopes recorded a bundle hash but inherited `NTN_SKILLS_DEV_ROOT`. The package launcher consequently selected the daily development checkout at `2c491ff838a4231d5d8d850c5d55a63571f2562b`. Their observed library effects remain real, but those envelopes do not establish execution of the named baseline/candidate bundle. `evidence/nxt-launcher-attribution-correction.json` identifies all 18 original affected records without overwriting them. The verification harness now removes the variable from child processes and records the execution choice; the global environment is unchanged. Direct imports of `dist/sdk.js` do not pass through that launcher.

The corrected packaged CLI comparison uses independent empty clients, equal content and freshness, and zero remote writes:

| Read | Baseline requests / response bytes | Candidate requests / response bytes |
| --- | ---: | ---: |
| Cold main | 10 / 55,098 | 10 / 55,098 |
| Warm main | 0 / 0 | 0 / 0 |
| Explicit refresh | 10 / 55,098 | 10 / 55,098 |

These main-read measurements establish parity, not an optimization. The separate immutable supporting-resource comparison records actual duplicate HTTP attempts and does not trade away freshness or pin validation.

For two simultaneous public SDK `readResources` calls on the original pinned 52-byte `scripts/example.sh`, baseline-03 used 12 requests / 39,730 response bytes and candidate-02 used 10 / 32,937. That is 2 fewer requests (16.7%) and 6,793 fewer response bytes (17.1%). Both results were ready with identical bytes, hash, executable mode and 120-second budget; permission/pin qualification remained independent, no remote writes occurred, and unknown-byte/in-flight counts were zero. Each client began empty and bootstrapped through public reads. Candidate-01, which showed no savings because it exercised a different internal resource path, is preserved. The gain is for this duplicate immutable resource path, not a claim of lower cost for every read.

The required six-scenario comparison also ran against the existing loopback/source fixture with the frozen baseline SDK (`9ed7bcaee73c0aec6345dde4565e9b7e47b9bb0529da02d1461877cc4707f213`) and final installed SDK (`7166f4051b7b4f01bced0c5daa607b304a4735d17b7bde008841ffcacddb6042`). Each arm used an independent empty Store, equal fixture authorization/library/owners, fixed Git roots/revision/blob hashes/modes, equal effective freshness and read-only resource budgets. No author Store or object database was copied, and no real Notion or natural-model request occurred.

| Controlled scenario | Baseline requests / response bytes | Final SDK requests / response bytes | Result |
| --- | ---: | ---: | --- |
| Cold | 18 / 30,990 | 18 / 30,990 | Equal complete content and version |
| Warm | 0 / 0 | 0 / 0 | Equal complete content and version |
| Expired, unchanged | 7 / 19,400 | 7 / 19,400 | Equal one-millisecond policy; actual ages 1,697 and 1,769 ms, with original validation time preserved |
| One reference changed | 10 / 23,740 | 10 / 23,740 | Equal changed selection; unchanged script, binary and source main not fetched again |
| One script object missing | 5 / 9,322; `SOURCE_CACHE_CORRUPT` | 6 / 9,374; ready | Final SDK fetched only the exact missing 52-byte script, preserving hash and mode |
| Two Skills from the same repository | 28 / 56,654 | 28 / 56,654 | First root fetched three source payloads totaling 239 bytes; the second reused them without another provider fetch |

These totals match both SDK metrics and independently closed fixture HTTP/provider-fetch observations. Provider decoded payload bytes are included: cold is 15 fixture HTTP requests plus three provider fetches; the missing-object candidate is five fixture requests plus one 52-byte provider fetch. Git TLS/wire bytes remain unobserved. Five scenarios establish parity; the missing-object scenario establishes recovery with one necessary extra fetch, not a request reduction or two successful baseline/candidate reads. The initial helper's invalid ISO-time comparison and future edit timestamp were rejected and preserved. The complete original ledger and frozen inputs are in `evidence/nxt-sdk-cost-matrix-03/report.json`.

The original packaged baseline still rejects main links to not-yet-allocated references before writing: `SHARED_NATIVE_REFERENCE_UNBOUND`, 24 requests, 118,458 response bytes, zero writes. That was the prior safe contract; a single complete maintenance intent is this batch's new capability.

Anonymous GitHub content requests returned HTTP 403 with an exhausted public quota during fixed-source admission. The two original failed preparations remain preserved. Admission now accepts an explicit `--storage retained` selection through the existing retained-source implementation; it does not silently downgrade a failed fixed-Git proof. Git discovery still verifies the frozen commit and member input, and upstream content is never executed.

A real packaged write preflight exposed a missing `source-rejection-<hash>.json` case in the SQLite operation-address classifier. Both attempted creates stopped with zero Notion writes. The fix extends only the exact shared-source journal address and retains that journal in the protected operation domain; a real Node reopen/enumeration regression covers persistence.

## Result semantics and limits

One maintenance parent retains its complete input and original allocation outcomes before resolving links to actual acknowledged page IDs. An unknown allocation is never replayed. New supporting files that themselves reference other unallocated new files still fail preflight; the existing staged route remains available for that explicit boundary.

Source selection, still-following native body replacement, request feedback, and overall task completion are reported separately. Explicit `--update-following` authorizes only the fixed candidate and observed following baseline. Custom ownership remains custom when bytes coincide. A complete old-string match is not an atomic page revision compare-and-swap, and no such guarantee is claimed.

Shared freshness policy resolves explicit request settings before Skill policy, Profile policy and defaults. Revalidation uses the original validation time. Expiry does not erase fixed content. Cache capacity applies to identified optional rebuildable payloads, not physical database size or protected history. Reclamation requires an exact preview, a verified archive and successful system Trash before conditional removal of the exact cache row; pins, objects and operation evidence stay protected.

Pi working-set budgets cover the complete active Notion root/Requires union. Explicit release preserves shared requirements and original Session history; stale completion cannot restore a released root. Configuration saved, runtime reloaded, and a successful body read are distinct onboarding states.

## Same-library acceptance

The final installed CLI completed the following independent checks against the owned library. Counts are observed HTTP attempts and Notion writes for the named operation, not a synthetic estimate of the entire journey.

| Operation | Observed result | Requests / writes |
| --- | --- | ---: |
| Single-apply preview | Complete sparse maintenance intent accepted; no remote mutation | 50 / 0 |
| Single apply | Main text split into two linked references, one file renamed, eight final logical files independently verified | 221 / 23 |
| Old six-file pin repeated | Stale baseline refused with `WRITE_CONFLICT` | 22 / 0 |
| Apply-returned pin repeated after request-schema installation | Changed library descriptor refused with `WRITE_CONFLICT` | 22 / 0 |
| Fresh authoring pin, then the same unchanged intent | `status=unchanged`, `verified=true`, `completion=no_op`; author and retained-remote effects both `none` | 34 / 0 |
| Old graph saved with explicit local-archive consent | Six original files retained through the public graph route | 19 / 5 |
| Old graph restored by an independent empty client | Original six files' bytes/hashes/logical modes restored without copying an author Store | 8 / 0 |
| Restored old pin exported offline | All six originals matched; new references absent, original path and executable mode retained | 0 / 0 |
| Explicit Source A-to-B following update | One following body updated; custom member received no body PATCH | 178 measured HTTP attempts plus one Git acquisition |
| Original restore-follow request and feedback | Custom body retained, following body restored, exact original operation reconciled, feedback verified | 224 / 7 |

The single apply retained parent `skill-apply-295b7ede9096a3e843b443345d343ec195f161c5daa345ada4ea5adea0bf364d.c2b3994067b09e7e4b00ebd138ca6df02a8a4a880372bc7efb95b86a08b7b581`. Independent readback verified the complete canonical body and all eight files. The main file is 348 bytes after native Markdown canonicalization; the sparse local input's 340 bytes are not the final-body oracle. Renaming preserved the original stable file/page identity. Original scripts and binary content retained their bytes and logical modes.

The two conflict results remain failures of those original stale-baseline attempts. Installing the public request schema added six control-property IDs to the shared library descriptor, which participates in the authoring snapshot version. Recomputing both versions against the same eight-file frontier reproduced the difference. Profile changes and content mutation did not cause it. A new public authoring read established `s_daf629e2d9299300e093852d0b6405545aed8d9ffb692d2c994070f067779040`; only that new baseline supported the successful no-op.

Source run `source-run-c44dc695-ee6c-4dab-9581-320c15d5b32e` finished with whole-tree verification and acknowledged Source feedback. Editing a following body made it custom; restoring its exact native A bytes left it custom. The explicit B update changed only the still-following member. Both old A pins remained readable offline. The retained source used native canonical Markdown; equal upstream Markdown and equal native body are separate observations. Git wire bytes were not measured.

Restore-follow request `file-request-9c7936fd6779629452167c84028efb67dba8dada44c394c6ad7e2649bc6743e7` retained its original 166-byte custom preimage and restored the 3,972-byte following body through run `source-run-f18974dc-5fc4-42ee-84d8-7fc6e73efe4b`. Its seven writes comprise five original restore writes, one request-feedback write and one Source-feedback write. The nested feedback step's `body_writes=0` is not a whole-run zero-write claim. The returned read-only reconciliation command completed the original operation without replaying its body write.

## Freshness, capacity and growth

Two Profile revisions were appended through public calls, each using six requests and one write. Two independent empty clients then observed the shared default and Skill override without copying state. Each cold read used 15 requests / 122,359 response bytes. A zero-age Skill override revalidated with 10 requests / 115,597 response bytes; removing it restored the 60,000 ms Profile policy, and both its first read and warm repeat used zero requests while retaining the original `validated_at`. An explicit zero age still forced each 15-request refresh. These ten consumption calls made no remote writes. Source effective policy changed from 15 to 90 seconds without running Source synchronization. Eligibility and complete-body lifetimes stayed at 300,000 and 86,400,000 ms.

Installed capacity verification created an 8,678-byte derived graph index through public consumption, previewed that exact row, wrote and fsynced a hash-verified archive, verified the actual system Trash copy, and reclaimed the index conditionally. Protected payloads of 16,768 bytes and six objects totaling 6,155 bytes remained unchanged. Consumption stayed ready with a zero-byte derived-index budget; restoring the 64 MiB default rebuilt the same 8,678 bytes. Each of three consumption calls made one 364-byte authorization request and zero writes. SQLite remained physically 290,816 bytes: the capacity claim concerns logical optional payloads, not physical shrinkage or `VACUUM`.

The final public audit is original run `audit-41804e85-3dc1-426d-8a09-60291158048f`. It completed a full four-table metadata census with severity counts error/warning/info = 0/0/0, 11 requests, 136 request bytes, 634,864 response bytes and zero writes. It observed 4 Skills, 12 supporting Files, 100 Records pages and 1 Source. The 100 Records comprise 40 objects, 29 operations, 23 file events, 4 source records, 2 Profiles, 1 snapshot and 1 graph archive.

Relative to the original one-Skill fixture (1 Skill, 5 Files, 20 Records and no Source), the final census added 3 Skills, 7 Files, 80 Records and 1 Source. All original page IDs remained present; the first 20 Records preserved their page ID, Record ID, kind, entity, owner and header hash exactly. This is an offline comparison of retained metadata and did not reread historical bodies or issue additional HTTP requests. All 117 observed page IDs across the four tables were unique.

Page identity and record identity are distinct: the 100 pages contain 90 Record IDs and 100 distinct kind/Record-ID/owner-set identities; ten object IDs occur under two different owners with equal header hashes. This does not establish body equality, redundant ownership or permission to merge. The old graph references eight retained identities; its save performed five new writes and reused three existing identities. Control-property additions are schema metadata, not extra table rows.

All 100 Records remain protected. This census did not inspect body payloads, active/tombstone state, private pins, external Sessions or whole-library reference closure, and it is not an atomic snapshot. Payload bytes, physical remote size and total library content size remain unknown. Zero content bytes/hashes verified at metadata depth means unobserved content, not an empty library. No remote deletion, merge, repair or garbage collection occurred.

The original audit's durable report was reproduced offline with no credential, a blocked network function, zero fetch attempts and zero HTTP requests. Its durable counters and content matched exactly; only per-invocation `request_metrics` were excluded. The first driver's failed comparison of the online and offline dynamic envelopes is retained. Correcting that comparison did not start another census.

## Installed artifacts and commit pairing

The product commit is CLI `e59354faa42830f3f098397314a08de3cd829e86` (C1). A fresh build and official pack from that commit reproduced the complete installed archive, CLI bundle and SDK byte for byte. The following verification/workflow/report commit (C2) changes no package input. Broker commit `95238840bf2d6955bb8024e39d2b93b9ea3c114a` (B1) pins C1 for CI and release verification; CLI CI pins B1. Both use actual Pi 1.5.2 for the current maintenance gate. This avoids a circular commit dependency while checking the same product bytes.

| Artifact | SHA-256 |
| --- | --- |
| CLI bundle | `3f4fb23cf2c6b4359257f5193d897c1ec2ec42e89f96bbcc38594c1803294528` |
| Public SDK bundle | `7166f4051b7b4f01bced0c5daa607b304a4735d17b7bde008841ffcacddb6042` |
| `ntn-skills-0.1.0.tgz` | `b231ca15e7e0d33494b6632c2b6327563fd2d4bc0eab85e58d23d4faf733937b` |
| `pi-context-broker-0.0.2.tgz` | `1903cd65ae5f897763f1e9ed7187d7b00f08a09bf40e3640c6b4933abc6ea176` |
| `ntn-skills-state-migration-1.0.0.tgz` | `e539b4679a5c28517ec99b415f25e3eb6210bab20c193d266e4c83a61275805a` |

The final CLI package was independently installed with lifecycle scripts disabled and the development launcher override absent. Broker bundles both the CLI and SDK from the same package realpath. Their embedded hashes differ from the inputs because Bun 1.4.3 rebundles and minifies them; independent application of that exact transformation reproduced both embedded files, and all 94 archive files matched the independent installation. Broker's default development dependency remains the published `ntn-skills@0.3.0` fallback. The NXT CI/release checks use their explicit C1 override; the fallback is not evidence for this candidate.

The duplicate-resource cost comparison above used an earlier candidate bundle before the output-mapper and SQLite journal fixes. It is not relabeled as a final-bundle experiment. The final immutable installation separately passed all 22 public SDK consumer cases and the complete CLI/Broker/migration installed smoke, including actual required Pi, authoring, unknown/acknowledged original-operation recovery, file modes and moves, no-op, audit interrupt/recovery, drafts, budgets and migration. The original smoke's Pi launch record is authoritative: it requested 1.5.2 but installed its owned 1.5.0 fallback. That original maintenance fixture preallocated both references before Pi and therefore does not establish AH-1053's single-intent Pi requirement. Its separate real-Notion controlled run and three natural tasks used Pi 1.5.2.

## Actual Pi and the bounded model assessment

Actual Pi protocol evidence and natural model outcomes are recorded separately. The controlled provider run used four real Pi processes and 29 final serialized HTTP requests. It covered cold connection preview/apply/reload, list/read/use, two-reference batching, follow-up, failed refresh preserving the old pin, successful refresh, working-set budget/release, independent resume, reuse and actual compaction. Complete bodies appeared zero or one time in effective model input; Session prefixes were preserved. There were 41 actual Notion dispatches plus four injected pretransport refusals, all 45 SDK attempts closed, and zero Notion writes. Compact/resume used one metadata request each without rereading bodies.

The frozen natural assessment used `magpie/group/worker`, medium thinking, three tasks with one attempt each, at most ten actual model dispatches per task and 4,096 output tokens per request. There were 27 actual dispatches in total. No task was retried or extended to obtain a passing result.

| Natural task | Actual model dispatches | Outcome and observed boundary |
| --- | ---: | --- |
| Cold onboarding | 10 | Failed at the hard budget. No final answer, connection or Notion request. Five legitimate owned reads were blocked by the original experimental guard; the rest of the budget was consumed during discovery. |
| Maintenance | 10 | Failed at the hard budget. The Session contains 21 tool calls and 10 guard refusals; it never reached a fresh target read, preview or apply. Eight startup catalog reads occurred; author operations and Notion writes were zero. |
| Read, batch references, then explicitly adopt | 7 | Passed the fixed two-turn task. Read preceded use, both references were batched, and adoption caused no extra body read or script execution. One incorrect source UUID call was rejected and then corrected. |

The third task's seven final wire bodies matched the serializer hook. Its complete-body copy vectors were `(0,0,0)` for the first three requests, then `(1,0,0)`, then `(1,1,1)` for the final three. It made 25 Notion requests and zero writes. Recorded usage was 26,760 input, 2,153 output, 10,752 cache-read and 1,524 reasoning tokens, with 39,665 total tokens as reported by the provider. A configured zero price is not a claim of free inference.

Deterministic guard corrections now admit the legitimate owned read shapes and the maintenance task's exact authoring target without treating `--json` as an authorization condition. Read-only tasks still force read-only access, and foreign or pinned authoring, credential reads, unrestricted child programs and unowned output paths remain refused. These corrections have local regression evidence; they do not change either original natural task result.

The maintenance run also exposed a verifier attribution gap: an approved compound shell spawned Node grandchildren that the original direct-child-only finality check could not close. The original strict result remains incomplete. The corrected verifier follows recorded parent/child ancestry only for a guard-approved shell whose command and tool-call ID match the original Session, and still requires terminal process/HTTP records. Foreign, unfinished, missing-parent and unapproved-child evidence remains incomplete. This local verifier correction makes no new model or Notion request and does not turn the failed maintenance task into a successful one.

The corrected single-intent installed-Pi driver then used actual Pi 1.5.2, the same immutable packages and the existing controlled HTTP fixture. Its original `nxt-single-apply-pi-f95iey` run completed the one apply, preserved the old pin and consumed the result. Independent offline analysis verified zero preallocation, exactly one actual apply, a complete 6,115-byte original main split into 2,903- and 3,030-byte reference bodies, distinct new File/page identities and a binding count of 3 to 5. The original source ledger records 482 controlled HTTP requests and 34 fixture writes: 15 for initial creation and 19 in the Pi maintenance window. There were no real Notion writes or natural-model calls.

That original run remains failed under its old `MNT_RESOURCE_BODY_NOT_UNIQUE` oracle. The extracted reference body was also a legitimate substring of the retained old-main authoring result. Both independent analyses locate the final raw count of two as one exact old-main contribution plus one new-reference contribution; the repeat response contains no body. The corrected oracle binds the old command, owner, snapshot, native tool-result bytes and hash before accounting for that contribution separately. Raw counts remain visible, and altered or unknown extra copies still fail. `reanalysis-01/single-apply-reanalysis.json` records the independent conclusion without rewriting the original gate result or starting another local Pi. Exact C2 CI runs the corrected installed gate anew.

## Verification inventory

| Gate | Observed local result |
| --- | --- |
| CLI Bun full suite, first final run | 4,318 passed / 2 failed out of 4,320. Both failures were historical test fixtures; their original logs remain. |
| Focused Bun fixture corrections | Migration cleanup now includes migration 0011: 1 passed / 13 assertions. Shared-resource display baseline uses the current body/frontier: 8 passed / 54 assertions. |
| CLI Node full suite, first final run | 815 passed / 1 failed out of 816. The stale protected-address fixture was corrected from 24 to 25 keys and its focused regression passed. |
| Remaining Node migration inventory | 7 passed / 1 explicit skip, zero failures. |
| Maintenance unit gate | Original gate: 18 passed / 1 explicit actual-Pi skip. Corrected single-intent/oracle regressions: 23 passed / 1 optional actual-Pi skip; final type and formatting checks passed. Actual-Pi execution and its original oracle failure are reported separately above. |
| Final type and formatting checks | Passed, including the corrected fixtures. |
| Installed public SDK and complete package smoke | 22 SDK cases passed; immutable CLI/Broker/migration smoke exited zero. |
| Operation recovery formal model | 35 configurations, 376 properties, 40 protected inputs, six real guard mutations passed. |
| Lifecycle formal model | 40 configurations, 119 reviewed protected inputs, four real guard mutations passed. |
| Request engine formal/runtime checks | 21 configurations, 19 negative configurations, 19 guard groups, 82 Bun cases / 455 assertions and five Node SDK cases passed. |
| Broker local check | 838 passed / 1 explicit skip out of 839 Node tests; five other conditional CLI/SQLite skips recorded separately. Type/build, host/adapters, consumption and completion gates passed. |
| Broker working-set formal checks | Seven SelectionGraph and seven DeliveryBoundary configurations and their actual guards passed. |

The first full-suite failures are not rewritten into a claim that those full runs passed. Exact PR-head CI reruns the corrected trees and is reported with its own SHA and run URLs in the existing PRs and Linear. Old green checks do not qualify a new head. No npm publication or merge is part of this acceptance run.

Statechart review covered three representative CLI charts and four Broker charts, including negative cases. Text, release edges and violation colors were readable without clipping or overlap at an appropriate zoom. This was representative visual review of exported charts, not a claim that every chart or a browser UI was inspected. The original SVGs were retained.

## Long-term documentation and acceptance status

Nine existing Notion pages were updated: project index, onboarding, ownership, Sources, recovery, public contract, performance, verification and governance. Each write has an acknowledged PATCH and independent complete Markdown-v2 readback. Every preexisting prefix/suffix remained byte-identical; new content matched after the observed inline-code representation and two escaped underscores were accounted for. The index is [Notion Skills project documentation](https://www.notion.so/4125636c236e81f28894e4bbb4eab711). The first mismatched Markdown-read-format preimage stopped before writing and remains recorded.

All four daily configuration sentinels remained unchanged: CLI configuration, Pi settings, Broker configuration and the shell environment file. Test clients, package installations, authoring state and temporary projections stayed in the owned acceptance roots.

AH-1052 remains In Progress because no cold natural Agent selected a recovery route from an original partial/unknown result in this batch. The installed Pi's actual reconcile argv matched the public show result and original operation exactly, but that controlled driver followed a successful apply and stopped on partial/unknown; it proves that protocol route, not cold recovery selection. AH-1056 remains In Progress because the natural cold session did not produce the required complete route. AH-1057 remains In Progress because the fixed natural maintenance task did not reach fresh read/preview/apply, and its AH-1056 dependency remains open. AH-1063 and parent AH-1050 therefore remain In Progress: the original requirement that all 15 child scopes pass has not been met. The bounded assessment itself was performed and its failures were preserved. Passing command, package, formal and controlled-Pi evidence remains valid for its own scope; none substitutes for the missing natural-task success.

The other functional tickets are judged against their own original conditions and exact-head CI. The existing delivery PRs remain [CLI #10](https://github.com/yoyooyooo/notion-skills-cli/pull/10) and [Broker #12](https://github.com/yoyooyooo/pi-context-broker/pull/12). Their current commit/check URLs and Linear updates are recorded after publication, without making a report commit depend on its own future hash or CI outcome.

## Evidence index

These paths are relative to the frozen evidence root above. They preserve original attempts rather than overwriting failed evidence with later conclusions.

| Scope | Evidence |
| --- | --- |
| Frozen intent and baseline | `evidence/nxt-baseline.json`, `evidence/nxt-intents.json` |
| Execution attribution correction | `evidence/nxt-launcher-attribution-correction.json` |
| Complete body oracle and version diagnosis | `evidence/nxt-pi-oracle-02/manifest.json`, `evidence/nxt-single-apply-version-diagnostic.json` |
| Old pin in the independent client | `evidence/nxt-old-pin-independent-proof.json` |
| Source and original request | `evidence/nxt-source-b-proof.json`, `evidence/nxt-custom-sticky-proof.json`, `evidence/nxt-file-request-proof.json` |
| Immutable resource cost | `evidence/nxt-sdk-resource/` |
| Six-scenario final SDK comparison | `evidence/nxt-sdk-cost-matrix-03/report.json` |
| Shared Profile, actual Trash and audit | `evidence/nxt-cache/index-04.json`, `evidence/nxt-cache/installed-profile-01/`, `evidence/nxt-cache/installed-capacity-03/`, `evidence/nxt-cache/installed-audit-01/` |
| Package identity | `evidence/nxt-packages/C1-reproduction/manifest.json`, `evidence/nxt-broker-packages/final-02/installed-pair.json` |
| Final installed smoke and SDK | `evidence/nxt-gates/installed-cli-broker-final-03.log`, `evidence/nxt-sdk-final-consumer/report.json` |
| Controlled actual Pi | `evidence/nxt-pi-final/controlled-IPBURV/evidence/` |
| Single-intent installed Pi and original failure review | `evidence/nxt-single-apply-pi-f95iey/reanalysis-01/single-apply-reanalysis.json`, `evidence/nxt-single-apply-contained-main-review.json` |
| Three original natural attempts | `evidence/nxt-pi-final/model-onboarding-ZXUVXm/evidence/`, `evidence/nxt-pi-final/model-maintenance-4eoqN9/evidence/`, `evidence/nxt-pi-final/model-read-use-nca69z/evidence/` |
| Original-condition acceptance judgment | `evidence/nxt-acceptance-judgment.md`, `evidence/nxt-acceptance-issue-snapshot.json` |
| Long-term page readbacks and daily sentinels | `evidence/nxt-docs/final-index-02.json`, `evidence/nxt-daily-sentinels-final.json` |
