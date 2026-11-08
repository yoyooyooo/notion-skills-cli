# Resource lifecycle models

These bounded models check selected lifecycle contracts. Product implementation, installed-package behavior and live service acceptance require their separate evidence. The four TLA+ modules have independent negative controls and use the actual Pstack `statechart` checker and graph compiler, pinned at `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`, and TLC 1.7.4.

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

Safety configurations exhaust their finite reachable state spaces. Liveness is checked only in `AuditRun.liveness.cfg` and `AuditRun.reset.cfg`. It assumes weak fairness of progress steps and that the modeled resumptions are supplied. It does not promise completion when a caller never resumes, permission never returns, or providers never answer. Unknown update outcomes intentionally permit waiting without claiming progress.

Only terminal states or an explicit environmental wait may stutter. No global always-enabled stutter action hides deadlocks. Views omit terminal/wait self-loops and steps that have the same visible label; original TLC reports retain the actual model trace. Combined broken UpdateCommit is useful for exploring interaction, while isolated controls establish each failure independently.

ImportCreate distinguishes a lost response with no durable ACK from an acknowledged request whose readback was interrupted. Only the latter can continue by observing the original stage; the former may wait indefinitely. Its four isolated controls break repeated dispatch, early enablement, inference from current visibility, and dispatch after the pre-execution inventory review becomes stale. Input drift is modeled before the first dispatch of an invocation; it does not claim a filesystem transaction spanning all remote requests. Execution uses frozen approved bytes. A passing UpdateCommit selection model alone does not establish complete create/import recovery.

## Current storage, projection and prefix-recovery correspondence

The current review keeps the same four models, 19 configurations, invariants and bounds. Source-refresh changes only route complete fixed manifests through typed storage preflight. Original create dispatch compares immutable Record requests by their verified canonical logical envelopes; mutable page-request ACK authority, original dispatch ordering and the original complete-verification/enablement boundary remain unchanged. These changes do not add transitions to UpdateCommit or ImportCreate.

The `files` map in `coverage.json` also binds reviewed context that is explicitly listed in `unmodeled_bindings`. Fixed-manifest gzip/Base64 storage, 1 MiB logical/180 KiB encoded limits, arbitrary path counts, transport framing and canonical cache representation require their source, Node and real-input tests. Native projection v9 predicts two creation document boundaries while preserving original submitted wire bytes; the models do not prove that prediction, actual Notion rendering or retained-policy compatibility.

The three `shared-create-recovery-prefix*` modules, their routing caller and the durable ACK schema in `shared-sources-model.ts` are hash-bound review context only. ImportCreate has no state for an acknowledged original v1/v8 main before its manifest, the exact original local journal and ACK metadata, a separately reviewed suffix operation, two operation histories, or a versioned compact recovery completion. The new path preserves the original main and input, requires its original ACK, writes a separate recovery decision/outcome and never invents the absent original terminal. Code and installed/live tests must establish those facts; passing ImportCreate does not establish this new recovery protocol, its pending-create suppression or cold consumption. Its controlled tests are listed separately in `unmodeled_bindings`.

The durable ACK schema is defined in the existing Sources model, which depends only on Effect. Generic dispatch and prefix review import that same schema directly, preserving its fields and validation while avoiding an eager read from the execution-module cycle. Schema placement and ESM initialization order require fresh Node process checks; the finite state models do not prove them.

No property was weakened, no bound was reduced and no new recovery or codec model is claimed. Public CLI/SDK acceptance and real-service recovery remain separate gates.

## Code correspondence and mutation replay

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
