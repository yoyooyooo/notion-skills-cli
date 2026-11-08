# Resource lifecycle models

This is planning-time verification, not a claim that the proposed source updater or audit command is implemented. The three TLA+ modules are deliberately small and have independent negative controls. They use the actual Pstack `statechart` checker and graph compiler, pinned at `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`, and TLC 1.7.4.

## Run

Prepare Pstack's `pstack/skills/statechart` outside the repository at that commit. Download `tla2tools.jar` from the official TLA+ 1.7.4 release and verify SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. Use Java 11 or later, and a Node version that executes stripped TypeScript, such as Node 24. Java and Node are local tools; no Notion credentials or live database is required.

Set `PSTACK_STATECHART_ROOT` to the skill directory and `TLA2TOOLS` to that verified jar, then run:

```sh
node scripts/verify-resource-lifecycle.mjs --out "$(mktemp -d /tmp/notion-formal.XXXXXX)"
```

The runner checks tool identity and covered source hashes, copies the model inputs outside the repository, executes Pstack's original `check` and `compile` functions, and writes `summary.json`, each `report.md`, `chart.mmd`, and original TLC output. Temporary tool files are retained inside the output directory instead of permanently deleted. The adapter changes cleanup only, not checking, predicates, bounds, shortest-path selection or graph compilation.

Broken configurations are expected to fail their named properties. The runner is successful only when all positive configurations pass and each negative configuration breaks exactly its expected rule set. It refuses unexamined rules and tool errors. A property made unreachable by a different mutation is not a successful negative control; use the isolated configurations.

## Scope

| Model | What it checks | Important limit |
| --- | --- | --- |
| ProjectionRace | A human edit survives the update boundary. The present editable-page guard blocks unsafe replacement; bypassing it admits a counterexample. | Passing by refusing writes does not prove automatic updates can make progress. The unsafe branch is a rejected proposal, not a reproduced production loss. |
| UpdateCommit | Complete selected resources, no blind retry after an unknown outcome, original-operation receipt, stable existing session pin. | A logical single selection operation, not all remote writes or a global transaction. `objects` abstracts exact available resources; it does not require storing upstream bytes in Notion. |
| AuditRun | No semantic writes, reverse inventory before complete coverage, retained progress on resume, honest permission-limited reports. | A proposed command. The reverse scan is one abstract step; pagination, byte budgets and concurrent live changes need implementation tests. |

Safety configurations exhaust their finite reachable state spaces. Liveness is checked only in `AuditRun.liveness.cfg` and `AuditRun.reset.cfg`. It assumes weak fairness of progress steps and that the modeled resumptions are supplied. It does not promise completion when Dagu stays stopped, permission never returns, or providers never answer. Unknown update outcomes intentionally permit waiting without claiming progress.

Only terminal states or an explicit environmental wait may stutter. No global always-enabled stutter action hides deadlocks. Views omit terminal/wait self-loops and steps that have the same visible label; original TLC reports retain the actual model trace. Combined broken UpdateCommit is useful for exploring interaction, while isolated controls establish each failure independently.

## Code correspondence and mutation replay

`coverage.json` records the reviewed commit, content hashes and the boundary of each abstraction. A hash mismatch means the model needs review, not that the product is incorrect. Use `/maintain-formal-verification-skill` to compare the changed functions and move the synchronization commit only after confirming the correspondence.

```sh
bun test packages/core/test/shared-file-state.test.ts packages/core/test/shared-file-observer.test.ts packages/core/test/shared-file-observer-readonly.test.ts
python3 scripts/check-resource-lifecycle-mutations.py --out /tmp/notion-resource-guard-mutations
```

The second command requires an isolated linked Git worktree and a new output directory. It runs each real-code baseline, removes one actual guard, requires an assertion failure rather than a tool/syntax failure, restores the original exact bytes, and reruns. Pause other writers of the covered files before starting; it refuses to restore over a concurrent edit. The four guards are the editable-body replacement helper, projection after human adoption, read-only observation of an unconfirmed edit without pending operations, and the semantic read-only transport around an ordinary auto-adopting observer. The first helper has no product caller in this reviewed tree and does not describe all explicit authoring writers. The third test covers only the observer's new-adoption stop; the fourth exercises the independent descendant-call capability boundary. Existing reconciliation uses read-only record lookup; it is not evidence of an automatic repair bug. Remote behavior is represented by controlled Notion fixtures; no live page is modified.

The new `withReadOnlyNotion` transport boundary and its focused tests reject downstream semantic mutations before scheduling. Current status inspection uses that boundary. AuditRun remains a proposed inventory, budget and coverage contract; its model result cannot close AH-688 or later audit tasks without their independent public-path evidence.

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
