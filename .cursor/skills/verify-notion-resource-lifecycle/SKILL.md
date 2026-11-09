---
name: verify-notion-resource-lifecycle
description: Check Notion Skill file ownership, guarded body replacement, source selection, reviewed complete imports, pinned consumption and read-only resumable audits with TLA+/TLC and Pstack statecharts. Use when changing these lifecycle boundaries. Trace exact source hashes and distinguish finite model coverage from installed and live acceptance.
---

# Verify Notion resource lifecycles

Use the existing `verify-ntn-skills` Skill for live Notion, public CLI, installed SDK, physical-machine behavior and performance. This Skill checks finite lifecycle contracts; it does not duplicate those acceptance claims or authorize publishing, repair, deletion, production writes or a daemon.

## Establish the exact correspondence

Read `verification/models/resource-lifecycle/coverage.json` and `README.md`. The synchronization record identifies the reviewed source commit and exact working-tree hashes. Formal assets were originally imported from `de3e7414568fca8bf62c2f2fc99ca3c217b871b6`; that import is provenance, not the current product base. Compare every recorded hash with the checkout. For changed files, trace the named functions and their callers before changing the model or synchronization record.

| Model | Reviewed contract | Limits |
| --- | --- | --- |
| ProjectionRace | The automatic projection refusal boundary and isolated replacement-helper contract, versus a rejected read-check-unconditional-replace alternative. | Explicit complete-body-match restore and request submission are unmodeled. A new source version, earlier read, UI lock or confirmation does not create atomic edit protection. |
| UpdateCommit | Complete retention before one authorized selection; one original dispatch, honest unknown outcomes and stable existing session pins. | It does not model every dispatcher, all source adapters, multiple writers or arbitrary resources. |
| AuditRun | Read-only reverse inventory, declared coverage and monotone resumption under a finite budget. | Two roots and one orphan abstract the real paginated audit; the model does not prove network cost, SQL crash recovery or a globally atomic database snapshot. |
| ImportCreate | A reviewed complete input, disabled creation, durable original acknowledgements, bounded continuation and enablement only after all abstract stages verify. | Two retained inputs (document and raw resource) and four stages abstract a single explicitly enabled creation. Actual file formats, immutable-record reconciliation and manual edits require code and installed tests. |
| CreateRecovery | A separately reviewed v9 creation recovery, one or three original ACK pages, a complete original request set, no unknown-attempt replay and exact Projection authority before the first write. | One abstract missing suffix and three mutable stages. It does not prove Markdown v10, arbitrary request counts, cold-record validation, current-body atomicity, transport permissions or actual Notion behavior. |
| AcknowledgedContinuation | Complete original request/ACK authority for an allocated tree, fresh body checks before continuation stages, no uncertain redispatch and full shared proofs before cold completion. | Three visible pages and four abstract stages. Exact requests, byte commitments, every immutable Record subrequest, native rendering and edits after a check require implementation evidence. |

A passing model is not completion of its linked Issue. Negative controls describe the consequence of removing a guard; classify a production defect only with its current code correspondence or a live reproduction.

## Run the verification

Use the README's pinned Pstack and TLC setup outside the checkout. With `PSTACK_STATECHART_ROOT` and `TLA2TOOLS` configured:

```sh
node scripts/verify-resource-lifecycle.mjs --out "$(mktemp -d /tmp/notion-formal.XXXXXX)"
bun test packages/core/test/shared-file-state.test.ts packages/core/test/shared-file-observer.test.ts packages/core/test/shared-file-observer-readonly.test.ts packages/core/test/shared-inventory-import.test.ts
```

Read each original `report.md`, `tlc.out`, `summary.json` and `chart.mmd`. Require complete finite exploration in positive safety configurations and exactly the listed broken rules in each negative control. In the fairness case, state the environment assumptions. An unchecked rule, parser failure, timeout or missing chart is not a pass.

Run the real-code mutation exercise only in an isolated worktree with all writers of covered source files paused:

```sh
python3 scripts/check-resource-lifecycle-mutations.py --out /tmp/notion-resource-guard-mutations
```

Each original baseline must pass, removing the real guard must trigger an assertion failure, and restoring its exact bytes must pass again. The script stops rather than overwriting a concurrent change. Preserve all original output outside the repository. It changes no live Notion content.

For changes to the reviewed v9 recovery path, select the new group instead of rerunning unchanged model groups:

```sh
node scripts/verify-resource-lifecycle.mjs --model CreateRecovery --out /absolute/new/recovery-model-run
python3 scripts/check-create-recovery-mutations.py --protected-worktree /absolute/active/worktree --out /absolute/new/recovery-guard-run
```

The second command runs from a separate candidate worktree with its own dependency tree and caches. It reuses the public recovery and dispatcher fixtures. Removing the complete-original-dispatch-set check must make an incomplete original admission fail the test's independent refusal assertion. Removing the first-PATCH scope check must fail the independent zero-transport-write assertion even though the later scope check still returns an error. A post-write error does not establish safe rejection.

The existing four mutation cases still cover their original body, ownership and read-only boundaries. They do not cover the recovery metadata allowance, the complete original request set or its two histories. Do not report them as new recovery proof.

## Explain results in domain terms

For the human-edit counterexample, identify the initial read, subsequent human edit and unconditional replacement. Trace `automaticSourceStops` for the automatic source-run refusal and keep the `requireSafeBodyReplacement` mutation's isolated helper scope explicit. Changed-body restore no longer calls that helper: an explicit restore uses one nonempty complete old-body match, frozen-input revalidation and full candidate readback. Manual authoring and this restore protocol are outside ProjectionRace. Complete string matching is not page revision CAS; a matching earlier GET alone is not a server-enforced precondition.

For selection and import, distinguish a dispatch, its durable original acknowledgement, current visibility and a verified outcome. Reconciliation of an immutable exact fact has a different authority from acknowledgement of a mutable page request. Do not use an equal current page to manufacture a missing acknowledgement or replay a lost create.

Keep `request --submit`, ACK-bound exact Record GET and projection 13 in `unmodeled_bindings`. Submission fixes body/frontier/identity/Source authority; only a verified selection advance within that same Source definition/member may vary. Exact Record GET requires the original durable ACK and the full Record validator, not query visibility or a guessed page ID. Projection 13 covers one bounded creation-list rendering rule, supported by a minimal repository counterexample and a separate complete native81 observation. None of these paths acquires a finite-model proof by updating source hashes; retain the historical v11-to-v12 native recovery contract unchanged.

For audit, distinguish surviving roots, reverse-table orphans, complete target coverage, the full library denominator and resume progress. A target audit can be complete while a derived library inventory remains partial. The real audit uses `withReadOnlyNotion` across descendant helpers, bounds each invocation and checkpoints observed outcomes. Its integration and Node SQLite tests establish details absent from the finite model. Normal current reads can adopt new whole-file edits and are not a substitute for a read-only audit.

Map these cases into the existing `verify-ntn-skills` resource, audit, import-create-recovery and shared-SSOT features. Keep source tests, independent installed CLI/SDK results and real Notion evidence separate. Import checks derive expected hashes, modes and paths from the pre-operation manifest, then audit and consume the actual result independently of the importer's `verified` field.

Use Pstack `/statechart` semantics: retain generated Mermaid, label states in domain language, preserve distinct rule-breaking states and disclose hidden self-loops. Use Pele for SVG rendering. Do not remove a failed rule or hide its bad path to obtain a passing chart.

## Maintain the verification

When code changes, apply `/maintain-formal-verification-skill`: decide whether a failure is a changed intended contract, model drift or a product defect. Move the reviewed commit and hashes only after tracing that distinction. Run the affected existing model group when its modeled contract changes, and keep each new negative control isolated enough to identify the guard it removes.

When only one reviewed model group changes, run that selected group and retain the exact prior receipts for unchanged groups. Record source, runner, model/config/view hashes and the reviewed correspondence; inherited evidence is not a new execution. A projection serialization change does not by itself require changing ProjectionRace or UpdateCommit. A new first-write authority branch requires its own code-level counterexample and explicit mapping.

For changes explicitly outside every model, synchronize the actual source hashes and unmodeled scope without relabeling prior model results as fresh runs. Preserve all six models' existing bounds and receipts; use the relevant code and installed/live evidence for the new path.

Performance, arbitrary data sizes, source parsing, actual permissions, concurrent Notion edits, multiple writers, machine-bound local access and complete historical retention need their own tests or additional models. A finite pass does not authorize production imports, host installation, cleanup or changes to the editing protocol.
