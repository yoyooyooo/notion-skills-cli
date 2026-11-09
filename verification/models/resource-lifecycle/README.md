# Resource lifecycle models

These bounded models check selected lifecycle contracts. Product implementation, installed-package behavior and live service acceptance require their separate evidence. The six TLA+ modules have independent negative controls and use the actual Pstack `statechart` checker and graph compiler, pinned at `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`, and TLC 1.7.4.

## Run

Prepare Pstack's `pstack/skills/statechart` outside the repository at that commit. Download `tla2tools.jar` from the official TLA+ 1.7.4 release and verify SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. Use Java 11 or later, and a Node version that executes stripped TypeScript, such as Node 24. Java and Node are local tools; no Notion credentials or live database is required.

Set `PSTACK_STATECHART_ROOT` to the skill directory and `TLA2TOOLS` to that verified jar, then run:

```sh
node scripts/verify-resource-lifecycle.mjs --out "$(mktemp -d /tmp/notion-formal.XXXXXX)"
```

The runner checks tool identity and the reviewed source hashes, including explicitly unmodeled context bindings, copies the model inputs outside the repository, executes Pstack's original `check` and `compile` functions, and writes `summary.json`, each `report.md`, `chart.mmd`, and original TLC output. Temporary tool files are retained inside the output directory instead of permanently deleted. The adapter changes cleanup only, not checking, predicates, bounds, shortest-path selection or graph compilation.

Broken configurations are expected to fail their named properties. The runner is successful only when all positive configurations pass and each negative configuration breaks exactly its expected rule set. It refuses unexamined rules and tool errors. A property made unreachable by a different mutation is not a successful negative control; use the isolated configurations.

## Scope

| Model | What it checks | Important limit |
| --- | --- | --- |
| ProjectionRace | A human edit survives the update boundary. The present editable-page guard blocks unsafe replacement; bypassing it admits a counterexample. | Passing by refusing writes does not prove automatic updates can make progress. The unsafe branch is a rejected proposal, not a reproduced production loss. |
| UpdateCommit | Complete selected resources, no blind retry after an unknown outcome, original-operation receipt, stable existing session pin. | A logical single selection operation, not all remote writes or a global transaction. `objects` abstracts exact available resources; it does not require storing upstream bytes in Notion. |
| AuditRun | No semantic writes, reverse inventory before complete coverage, retained progress on resume, honest permission-limited reports. | A coarse abstraction of the audit coordinator. The reverse scan is one step; pagination, HTTP accounting, endpoint/credential fences and concurrent live changes need implementation tests. |
| ImportCreate | Complete approved input before dispatch, one original mutable-page request per stage, durable ACK before confirmation, whole-tree verification before explicit enablement. | Four abstract stages for one explicitly enabled create: root, Files/resources, metadata/selection, enablement. Exact immutable Record reconciliation is separate from mutable-page ACK authority. Disabled creation, arbitrary files, codec normalization and concurrent user edits need product tests. |
| CreateRecovery | Complete original evidence, separate original/recovery histories, no uncertain-stage redispatch and exact Projection authority before transport. | One or three original ACK pages, one abstract suffix and three mutable stages. Full payloads, arbitrary cardinality, cold completion and provider behavior require product tests. |
| AcknowledgedContinuation | Complete original request/ACK authority for an already allocated tree, fresh body checks before continuation stages, no uncertain redispatch and full shared proofs before a cold result. | Three visible pages and four abstract stages. Exact requests, byte commitments, all native files, intermediate Record writes and edits after a check require product tests. |

Safety configurations exhaust their finite reachable state spaces. Liveness is checked only in `AuditRun.liveness.cfg` and `AuditRun.reset.cfg`. It assumes weak fairness of progress steps and that the modeled resumptions are supplied. It does not promise completion when a caller never resumes, permission never returns, or providers never answer. Unknown update outcomes intentionally permit waiting without claiming progress.

Only terminal states or an explicit environmental wait may stutter. No global always-enabled stutter action hides deadlocks. Views omit terminal/wait self-loops and steps that have the same visible label; original TLC reports retain the actual model trace. Combined broken UpdateCommit is useful for exploring interaction, while isolated controls establish each failure independently.

ImportCreate distinguishes a lost response with no durable ACK from an acknowledged request whose readback was interrupted. Only the latter can continue by observing the original stage; the former may wait indefinitely. Its four isolated controls break repeated dispatch, early enablement, inference from current visibility, and dispatch after the pre-execution inventory review becomes stale. Input drift is modeled before the first dispatch of an invocation; it does not claim a filesystem transaction spanning all remote requests. Execution uses frozen approved bytes. A passing UpdateCommit selection model alone does not establish complete create/import recovery.

## Current storage, projection and prefix-recovery correspondence

Source-refresh previews preserve a known native custom file mode, matching the actual snapshot composition. Unknown modes stay absent. This projection correction changes no selection, acknowledgement or body-write authority. The existing finite model results remain inherited evidence; the Git refresh integration regression covers the corrected preview and unchanged custom body.

The current review preserves the original four models and their 19 configurations, invariants and bounds, and adds the separately scoped CreateRecovery model with four configurations. Source-refresh routes complete fixed manifests through typed storage preflight. Original create dispatch compares immutable Record requests by their verified canonical logical envelopes; mutable page-request ACK authority, original dispatch ordering and the original complete-verification/enablement boundary remain unchanged. The new exact recovery metadata allowance checks PATCH scope before the first transport write. It is mapped to CreateRecovery, not added to UpdateCommit or the original ImportCreate transition system.

The `files` map in `coverage.json` also binds reviewed context that is explicitly listed in `unmodeled_bindings`. Fixed-manifest gzip/Base64 storage, 1 MiB logical/180 KiB encoded limits, arbitrary path counts, transport framing and canonical cache representation require their source, Node and real-input tests. Native v9/v10/v11/v12 projection predicts document boundaries and literal-token rendering, including top-level heading text and the observed purpose-specific separators, while preserving original submitted wire bytes; the models do not prove those bytes, actual Notion rendering or retained-policy compatibility.

The historical v1/v8 main-before-manifest recovery, exact payload schemas and original journal/ACK metadata remain hash-bound review context. CreateRecovery adds only the stated bounded v1/v9 state and authority mapping; ImportCreate has no transition for this separate operation. Both recovery variants preserve acknowledged original pages and inputs, write a separate recovery decision/outcome and never invent an absent original terminal. Exact original request sets, compact response proofs, versioned cold completion, pending-create suppression and consumer reconstruction still require code and installed/live evidence. Their controlled tests are listed in `unmodeled_bindings`.

The durable ACK schema is defined in the existing Sources model, which depends only on Effect. Generic dispatch and prefix review import that same schema directly. Shared recovery Binding, Observation and File schemas now live in a separate proof-model dependency instead of an execution module. Their fields and validation remain unchanged. Schema placement and ESM initialization order require fresh Node process checks; the finite state models do not prove them.

No existing property was weakened or bound reduced. The new recovery model has only the scope stated below; codec correctness remains unmodeled. Public CLI/SDK acceptance and real-service recovery remain separate gates.

Complete supporting YAML headers and known modes remain distinct from the editable body. File-add v2 binds the full original input; v11 source admission retains complete C1/N1 metadata ancestry. Public write/apply compare submitted headers with both the fresh consumer object and retained native ownership. Restore-follow uses the creation projection for its exact no-body-write comparison; differing bodies still reach the unchanged `requireSafeBodyReplacement` guard. These serialization changes do not alter ProjectionRace or UpdateCommit. Header integrity, old plan compatibility and cold complete bytes are checked by the source and installed/live tests listed in `coverage.json`, not by the finite models.

Explicit body review v2 retains the original write candidate's native mode and complete frontmatter with the accepted observation. Its stable original-operation identity still selects any retained v1 local/shared plan before reconciliation; v1 plan/event/receipt bytes remain unchanged. Missing intent, conflicting versions and incomplete unknown results fail read-only. An exact opaque file/operation address in the same Store also selects read-only recovery after a credential-scope change, without inspecting another scope payload. An empty independent Store cannot infer an unknown request elsewhere from absent remote facts; this is not distributed mutual exclusion or provider CAS. These codecs, version choices and opaque-address checks remain unmodeled context. The existing finite models and guard proofs were not rerun or enlarged for this lane. Focused tests and exact real observations provide separate implementation evidence; native main-ACK recovery has its own review and mapping.

Native inventory recovery review v5/outcome v7 is a separate unmodeled branch for one disabled native v1 main with its sole original projection-11 POST/ACK and no existing Records. Original prepared/executed inventory intent and credential-scoped journals authorize the explicit fixed-v12 review; equal current content alone does not. The recovery preserves the page, original input/wire and complete native metadata, appending only its exact immutable Record union without creating a Skill/File page, PATCH or enablement. A repeated or unknown attempt reconciles the original recovery without continuing an undispatched suffix. Cold completion reconstructs the original input and full retained ACK/body/event facts; its dispatch commitment uses the same validated ACK observation, while a later independent read must reject changed facts. Existing ImportCreate, CreateRecovery and AcknowledgedContinuation models keep their prior scope. The first hidden-unknown Record and single-observation ACK counterexamples are direct implementation tests, not new model claims. Installed public commands and the original live operation remain separate evidence.

Exact Source batch run keys are now registered in SQLite. Their mutable checkpoints are separate from immutable original member requests and ACKs. Cross-process Node tests exercise dry/apply/reconcile and retirement; no lifecycle model claims to prove SQLite persistence.

## Code correspondence and mutation replay

### Reviewed v9 creation recovery

`CreateRecovery` is a separate bounded abstraction of the v9-to-v10 recovery protocol. The initial history is either one acknowledged main with no original terminal, or three acknowledged native pages with the original `needs_review` terminal retained. One abstract missing suffix stands for the complete remaining native set. The mutable stages are suffix creation, an exact Projection metadata change and explicit enablement. Initial events must cover the bounded file set before enablement, and a separate completion follows acknowledged verification.

The model keeps the original pages and original terminal state distinct from the recovery operation. A missing original request/ACK set blocks admission and is rechecked before apply. An incomplete recovery has only read-only reconciliation: even a visible page or an ACK for an intermediate stage cannot dispatch the next stage through this protocol. Projection metadata is authorized before transport; checking the same scope after the write cannot satisfy that rule. ExistingBodyWriteForbidden records whether a body-bearing mutation request reaches transport; it does not claim that Notion accepted the field or that actual text was lost.

| Configuration | Removed boundary | Expected broken rules |
| --- | --- | --- |
| `CreateRecovery.cfg` | None | None |
| `CreateRecovery.original.cfg` | Complete original evidence at review/apply | `OriginalEvidenceRequired` |
| `CreateRecovery.replay.cfg` | No redispatch of an uncertain recovery stage | `AtMostOneRecoveryDispatch` |
| `CreateRecovery.scope.cfg` | Exact Projection authority before transport | `ProjectionAuthorityBeforeWrite`, `ExistingBodyWriteForbidden` |

This model does not prove the actual 76 original dispatches, the 35 native/407 effective paths, Markdown v10 rendering, byte hashes, compact observations, Record serialization, the cold completion validator or provider permissions. The original-set boolean stands for the implemented full manifest, object, Source, dispatch and ACK checks; the scope boolean stands for complete current owner/path/source/disabled/body checks. A current-scope change is modeled before a stage's check, not as an atomic Notion transaction after that check. The actual new behavior needs the original raw response receipts, controlled tests, fresh Node startup and installed/live acceptance.

The existing `ProjectionRace`, `UpdateCommit`, `AuditRun` and `ImportCreate` configurations retain their earlier boundaries. `ImportCreate` still describes the original create invocation, not this second operation. The shared original reference-request builder preserves the original wire body. The optional `recovery_file_projections` allowance adds a new, explicitly scoped metadata authority and does not authorize any existing body write. The old four guard removals do not exercise that new allowance.

Run only this group when the other exact model/config/view inputs and their reviewed source correspondence remain unchanged:

```sh
node scripts/verify-resource-lifecycle.mjs --model CreateRecovery --out /absolute/new/recovery-model-run
```

The full runner now includes the prior 19 configurations and these four. Its source hash check still applies to the complete `files` map before a selected run. Do not update `synchronized_commit` to an uncommitted candidate or call inherited results a fresh run.

Two additional real-code mutations replay the new boundaries in a separate candidate worktree:

```sh
python3 scripts/check-create-recovery-mutations.py \
  --protected-worktree /absolute/active/product-worktree \
  --out /absolute/new/recovery-guard-mutations
```

The copy must contain the exact frozen candidate, its own dependency files and its own caches. The runner refuses a symlink that escapes that copy and never mutates the protected worktree. It reuses `shared-create-known-recovery.test.ts`: a missing original Record dispatch must refuse review; a `markdown` key on the Projection request must produce zero transport writes. The second mutation removes only the first-PATCH check and leaves the later postcondition intact, so the counterexample demonstrates the real check-after-write defect. Each case requires baseline pass, an assertion failure after guard removal, byte/mode restoration and restored pass. Whole-source hashes are retained before and after.

Only self-loops and steps merged into the same domain label are hidden by the recovery chart. Fault labels retain distinct combinations of missing evidence, repeated dispatch, late authority checks and a body-bearing request reaching transport; they must not be merged into a benign or ambiguous state.

`coverage.json` records the reviewed commit, content hashes and the boundary of each abstraction. A hash mismatch means the model needs review, not that the product is incorrect. Use `/maintain-formal-verification-skill` to compare the changed functions and move the synchronization commit only after confirming the correspondence.

```sh
bun test packages/core/test/shared-file-state.test.ts packages/core/test/shared-file-observer.test.ts packages/core/test/shared-file-observer-readonly.test.ts
python3 scripts/check-resource-lifecycle-mutations.py --out /tmp/notion-resource-guard-mutations
```

The second command requires an isolated linked Git worktree and a new output directory. It runs each real-code baseline, removes one actual guard, requires an assertion failure rather than a tool/syntax failure, restores the original exact bytes, and reruns. Pause other writers of the covered files before starting; it refuses to restore over a concurrent edit. The four guards are the editable-body replacement helper, projection after human adoption, read-only observation of an unconfirmed edit without pending operations, and the semantic read-only transport around an ordinary auto-adopting observer. The first helper is called by changed-body restore-follow; automatic source-run policy also refuses unsupported projection replacement. Explicit manual authoring writers keep their own protocol and are outside this all-writer guard claim. The third test covers only the observer's new-adoption stop; the fourth exercises the independent descendant-call capability boundary. Existing reconciliation uses read-only record lookup; it is not evidence of an automatic repair bug. Remote behavior is represented by controlled Notion fixtures; no live page is modified.

The `withReadOnlyNotion` transport boundary rejects downstream semantic mutations before scheduling. Current status inspection and the audit coordinator use it. Trace `runSharedAudit`/`resumeSharedAudit`, their durable observations, reverse census and request budgets separately; the coarse AuditRun result does not prove those implementation details. Likewise, trace `prepareInventoryImport`, `sharedCreateDispatch` and complete pre-enable verification against the ImportCreate boundary. Update `coverage.json` only after the exact changed symbols have been reviewed; old hashes are not evidence for a new tree.

These tests replay the local safety boundary. They do not reproduce data loss in Notion, prove every guard caller is correct, or prove the new whole-library auditor. For those claims, use the live and installed-package recipes in the existing verification Skill.

## Statechart rendering

Use `pele@1.9.0`, installed outside the repository, for the generated `.mmd` files. Render with `{ limit: 1000000, outputLimit: 8000000, maxEdges: 10000 }`. Keep source `.mmd`, report, SVG and source/hash metadata together. Display only the compact primary charts; complete mutation traces remain in the report bundle. Generated run logs, screenshots, binaries and private library data do not belong in Git.

The report generator requires the completed model result and actual mutation replay summary:

```sh
node scripts/render-resource-lifecycle.mjs --run /absolute/model-run \
  --pele /absolute/renderer/node_modules/pele \
  --mutations /absolute/guard-mutations/summary.json --out /absolute/new/report
```

The long-term design and acceptance sequence live in [Notion](https://app.notion.com/p/4125636c236e819bba12c71af9a0c0f5). Track implementation in [AH-681](https://linear.app/yoyooyooo/issue/AH-681). The phase-one feature map is `.cursor/skills/verify-ntn-skills/features/resource-phase1.md`; do not copy the planning document into the repository or generated report.

## Complete acknowledged continuation

`AcknowledgedContinuation` models the narrower second decision after a known v3/v10 recovery has allocated every native page and retained each original ACK, before any Projection metadata, initial event or enable mutation. The bounded state starts with three visible pages and independently varies the original ACK set and exact request-set predicate. Visibility never supplies missing original authority. Review and apply check that authority separately; a new continuation preserves the original pages and `needs_review` history. Four abstract stages retain original ACK facts, publish exact metadata/events, enable the complete tree and retain a separate completion. A cold reader must find the complete shared proof set even if a local writer previously completed.

| Configuration | Removed boundary | Expected broken rule |
| --- | --- | --- |
| `AcknowledgedContinuation.cfg` | None | None |
| `AcknowledgedContinuation.original.cfg` | Complete original request and ACK set | `CompleteOriginalAuthority` |
| `AcknowledgedContinuation.fresh.cfg` | Fresh current body check before a stage | `FreshBodyBeforeWrite` |
| `AcknowledgedContinuation.cold.cfg` | Complete immutable ACK facts at cold verification | `ColdVerificationNeedsSharedProof` |
| `AcknowledgedContinuation.replay.cfg` | Original uncertain request is never repeated | `AtMostOneContinuationDispatch` |

The state model abstracts complete-set and body-equality predicates. It does not model JSON fields, hash collision resistance, individual immutable Record writes, the actual 34/35 native allocations, 397/407 full file manifests, Notion formatting or a transaction between a fresh check and a later request. The existing dispatcher still owns exact metadata-only PATCH authority. Earlier creation, recovery and unknown-POST continuation versions retain their own contracts.

New review v4/outcome v5 binds an original v10 fixed Git mismatch to v11. A fully acknowledged earlier recovery uses continuation review v2/outcome v6. Their compact file commitments are reconstructed from the complete retained original plan and explicit policy, including all metadata and events. Each full frozen native POST and durable ACK is retained in a separate ordinary object Record, bound by the reviewed directory. Ordinary review and ACK records retain the 64 KiB ceiling. The cold reader checks complete original request bodies, response hashes, exact page/owner/native metadata and the reconstructed complete plan; a response digest alone cannot supply the missing fact. Coherently altered proof headers and review commitments are negative implementation cases.

Pure ACK, frozen POST, observation and file-commitment schemas live outside execution modules. `shared-create-acknowledgement-import.node.test.ts` starts independent native Node processes at each affected public/runtime/model entry. This catches module initialization cycles that a preloaded Effect fixture or one import order can hide. The finite model does not establish ESM initialization or wire-byte compatibility.

After freezing the reviewed source mapping, run the new formal group through the same pinned Pstack checker:

```sh
node scripts/verify-resource-lifecycle.mjs --model AcknowledgedContinuation \
  --out /absolute/new/acknowledged-continuation-model
```

Run the three new implementation mutations only in an independent linked worktree with its own dependencies and the exact frozen source/test snapshot:

```sh
python3 scripts/check-acknowledged-continuation-mutations.py \
  --protected-worktree /absolute/active-worktree \
  --out /absolute/new/acknowledged-continuation-mutations
```

The runner requires a green baseline, an assertion counterexample after removing each actual boundary, exact source restoration and a green rerun. It covers the complete recovery dispatch/ACK denominator, fresh body rejection before the first continuation write and the shared cold full-ACK reader. It preserves original logs and source hashes. These mutations are additional evidence for the new branch; the earlier four lifecycle and two recovery mutations keep their original scope. Public CLI/SDK installation and the original live owned operations remain separate acceptance gates.
