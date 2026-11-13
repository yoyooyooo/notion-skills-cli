# Resource audit: AH-690–AH-695

AH-1024 adds the [maintenance matrix](skill-maintenance.md). A disabled unregistered draft is not a corrupt managed Skill. Its metadata classification does not authorize adoption, prove empty history, or establish content availability. Preserve reverse-table findings when its identities are missing.

## User contract and boundaries

`ctl library audit run` audits one exact Skill or the complete registered library;
`resume` continues the same local run; `report` reads the retained result offline;
`list` discovers retained run IDs even when cancellation produced no final stdout.
Execution (`completed`, `paused`, `execution_failed`), coverage (`full`, `partial`,
`permission_limited`), and finding severity are independent. Reports name the
requested depth, observation interval, rule version, permission identity, and
stable physical/business identities. An interval is not an atomic Notion snapshot.

All remote calls execute inside `withReadOnlyNotion`. Query POSTs are reads;
page/record mutations, adoption, repair, operation replay and arbitrary web crawling
are forbidden. Successful audits write only local derived state. Original unknown
operation receipts, user object caches, fixed history and private session pins are
never garbage-collected by audit retention.

## Coverage and minimal falsifiable checks

| Ticket | Product obligation | Negative/continuation evidence |
| --- | --- | --- |
| AH-690 | Exact identity, complete selected file tree, independent ownership and current body, deterministic Markdown/native references, metadata/content scope | Missing local reference; duplicate IDs/paths; multiple owners; Requires cycle; cross-scope native link; truncated body/403/404/unknown operation remain explicit; unmaterialized manifest files and unlinked scripts remain valid |
| AH-691 | Independent unfiltered Skills, Files and Records-header census, including disabled and malformed rows | >100 rows; >25 relation values; vanished owner with surviving File; blank IDs/cleared relations do not hide subsequent rows; reverse coverage absent cannot be full |
| AH-692 | Durable Store checkpoint, stable-ID queue, request-level progress inside one Skill, actual retry/byte/time budget, new-process resume | Two small budgets advance; retries cannot bypass admission; cancellation/crash before/after checkpoint preserves confirmed prefix; rule/permission/library mismatch rejects reuse; changed objects invalidate related work |
| AH-693 | Bounded finite incremental runs, fair due ordering, cheap census, valid immutable/body reuse, bounded local history | Child/relation/selection/rules/scope change invalidates; failing/new targets do not starve old work; deleted/bad rows detected; added/persistent/recovered findings require comparable checked coverage |
| AH-694 | Explicit retained history and remote recoverability; local availability independently reported | Missing/corrupt chunk, wrong owner, denied remote with warm local bytes, unresolved operation references; private session references remain globally unenumerable; no deletion recommendation |
| AH-695 | Installed run/resume/offline report, schema/help/protocol, explicit exit states | Independent package and empty local state; paused process followed by resume; report performs zero remote calls; wrong run/scope/rules/corrupt checkpoint/output overwrite rejected; real owned orphan/deleted-reference findings retained |

The actual HTTP request budget is checked before every attempt, including retries;
admission and retry waits count against the invocation deadline. Byte accounting
states its response-boundary overshoot and excludes HTTP/TLS framing. A large
response is never described as a hard byte cutoff. The checkpoint stores confirmed
request observations and exact object versions; cursors are continuation evidence,
not object identity. Failed individual items remain findings and do not erase or
starve later stable-ID tasks. Global authentication/library failure pauses explicitly.
The deadline also interrupts an admitted slow Notion response or provider stream;
Notion preserves uncertain-write classification for other opt-in budget callers.
Final local checkpoint persistence can finish after the request deadline and its
elapsed time remains visible. Known request bytes must fit before dispatch.

New checkpoints bind credential, exact API origin and API version before any read.
Resuming under another endpoint/version is rejected before a request. Historical
checkpoints without endpoint proof remain readable offline but cannot continue.
Records identities use their existing owner scope. Equal body IDs under different
Skills are valid; equal-header physical copies remain separate warning evidence,
and conflicting owner-scoped headers remain errors.

## Implementation ownership and proof mapping

This slice owns new `shared-audit*.ts`, the opt-in request-budget service/transport
hook, focused tests, and `commands-library-audit.ts`. Root owns shared command
wiring, public docs, package/build integration and this skill's index links.
Existing state, source, file-state, retained-object and reference owners are reused.

`verification/models/resource-lifecycle/AuditRun.tla` is a coarse invariant model:
read-only, complete means forward plus reverse coverage, monotone checkpoint, and
eventual report. It does not prove actual HTTP budgets or pagination. Link those
properties to executable core/transport tests and independently installed CLI
evidence before changing model status from proposed to exercised. Controlled tests,
live owned Notion evidence, independent package evidence and human UI observations
remain distinct. No live/human claim is implied by this contract file.

## Target scope and retention (AH-1026 / AH-1031)

Current rules are `resource-audit-v3`. v1 and v2 reports remain readable and cannot resume.
`--target` reads one page, its direct Requires and Origin pages, and filtered File and Record
headers. `inventory.complete` stays an unfiltered census. Reachable runs report
`inspection_scope: reachable_target`, `reverse_table_completeness: unobserved`, and
`ownership_coverage`. `--all` and `--census` still scan every registered row, which is what
makes a cleared owner visible. Same-owner equal Record headers are `possible_equivalent`
until payloads are compared. Conflicting headers are errors. Cross-owner equal bodies and
unlinked scripts are not orphans or conflicts. `growth` and `next` describe retention and
help or resume argv. They do not garbage-collect, merge, repair, or claim live library state.
The contract is [maintenance-audit-contract.md](../../../../docs/maintenance-audit-contract.md).

## Exercised evidence

AH-1025 adds `shared-audit-draft.test.ts` and the `checkAuditDrafts` slice in the
existing installed package smoke. Both directory classification and full audit
reports must agree on an unfinished disabled draft. Existing bindings and history
remain findings. Metadata success does not imply content/history verification.
Current v3 rules reject resuming v1 and v2 while retaining their offline reports.
See [the source correspondence review](../../../../docs/maintenance-state-verification.md).

- `shared-audit*.test.ts` covers independent census, retained history, exact graph
  failure, same-run continuation, cancellation, offline discovery, scope mismatch,
  complete pagination and denied-object fairness.
- `request-budget.test.ts` uses the actual transport boundary for retry permits,
  known request-byte admission, one admitted response overshoot, queue waits,
  admitted slow reads/writes and a stalled provider response stream.
- `shared-audit-sqlite.node.test.ts` resumes actual SQLite Store checkpoints in
  separate fresh Node processes. Exact audit/source-run/inventory-import domains
  are exercised, and original evidence cannot be overwritten.
- Source CLI evidence under `nr31-inventory-63c2b4b0` completed the owned fixture's
  397-file history audit across three invocations. The 28 Records and native
  main/reference/Source state had identical before/after digests, 22 actual
  requests and zero writes; offline report made zero requests. This is distinct
  from the later independent installed-package gate and human UI observation.
- Production census uses a separate explicit readonly scope and preserves its
  actual pauses, incomplete coverage and findings. Initial counts do not prove
  completed per-resource content or history coverage.

## Installed process-signal continuation

The existing package smoke calls `scripts/package-smoke/audit.ts`. Its owned
loopback service reuses `shared-audit-fixture.ts`; every product command runs the
independently installed Node bin with an empty per-case Store. The service never
seeds consumer checkpoints or invokes an internal audit entrypoint.

Four cases send actual SIGINT or SIGKILL to that exact child PID, either while a
read response is withheld before its observation checkpoint, or after a readonly
SQLite observer confirms a durable completed-task/read prefix and the next read
is withheld. This does not claim a kill inside an arbitrary SQLite instruction.
Each case uses offline `list` to recover the original run ID, a bounded new-process
`resume`, another continuation to completion, and offline `report`. Confirmed
observation hashes/timestamps and completed tasks must survive. SIGKILL keeps the
unfinalized invocation visible; resumed accounting must remain an explicit lower
bound. Existing same-host dead-PID lock recovery is exercised without clearing a
fence or modifying the Store.

The evidence retains actual argv/PID/exit/signal, HTTP methods and byte observations,
checkpoint snapshots, budgets, original run ID and final coverage. GETs and exact
query POSTs are the only allowed service calls; before/after remote fixture hashes
must match. This covers installed controlled-service OS recovery for AH-692 and
the corresponding AH-695 continuation slice, not real Notion orphan/deleted-link
acceptance, physical Mini, human UI or a final candidate unless that exact archive
is recorded. A prepared recipe alone is not an exercised pass.
