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
| ProjectionRace | The product's fail-closed restore-follow / automatic projection guard, and a rejected read-check-unconditional-replace alternative. | A new source version, a matching earlier read, a normal UI lock or a confirmation does not create atomic edit protection. |
| UpdateCommit | Complete retention before one authorized selection; one original dispatch, honest unknown outcomes and stable existing session pins. | It does not model every dispatcher, all source adapters, multiple writers or arbitrary resources. |
| AuditRun | Read-only reverse inventory, declared coverage and monotone resumption under a finite budget. | Two roots and one orphan abstract the real paginated audit; the model does not prove network cost, SQL crash recovery or a globally atomic database snapshot. |
| ImportCreate | A reviewed complete input, disabled creation, durable original acknowledgements, bounded continuation and enablement only after all abstract stages verify. | Two retained inputs (document and raw resource) and four stages abstract a single explicitly enabled creation. Actual file formats, immutable-record reconciliation and manual edits require code and installed tests. |

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

## Explain results in domain terms

For the human-edit counterexample, identify the initial read, subsequent human edit and unconditional replacement. Trace `requireSafeBodyReplacement` through restore-follow in the body writer and the source-run policy. Explicit manual author writes have their own protocol and are outside this model's guard-coverage claim. A current byte match is an observation, not a server-enforced precondition.

For selection and import, distinguish a dispatch, its durable original acknowledgement, current visibility and a verified outcome. Reconciliation of an immutable exact fact has a different authority from acknowledgement of a mutable page request. Do not use an equal current page to manufacture a missing acknowledgement or replay a lost create.

For audit, distinguish surviving roots, reverse-table orphans, complete target coverage, the full library denominator and resume progress. A target audit can be complete while a derived library inventory remains partial. The real audit uses `withReadOnlyNotion` across descendant helpers, bounds each invocation and checkpoints observed outcomes. Its integration and Node SQLite tests establish details absent from the finite model. Normal current reads can adopt new whole-file edits and are not a substitute for a read-only audit.

Map these cases into the existing `verify-ntn-skills` resource, audit, import-create-recovery and shared-SSOT features. Keep source tests, independent installed CLI/SDK results and real Notion evidence separate. Import checks derive expected hashes, modes and paths from the pre-operation manifest, then audit and consume the actual result independently of the importer's `verified` field.

Use Pstack `/statechart` semantics: retain generated Mermaid, label states in domain language, preserve distinct rule-breaking states and disclose hidden self-loops. Use Pele for SVG rendering. Do not remove a failed rule or hide its bad path to obtain a passing chart.

## Maintain the verification

When code changes, apply `/maintain-formal-verification-skill`: decide whether a failure is a changed intended contract, model drift or a product defect. Move the reviewed commit and hashes only after tracing that distinction. Run the existing matrix, and keep each new negative control isolated enough to identify the guard it removes.

Performance, arbitrary data sizes, source parsing, actual permissions, concurrent Notion edits, multiple writers, machine-bound local access and complete historical retention need their own tests or additional models. A finite pass does not authorize production imports, host installation, cleanup or changes to the editing protocol.
