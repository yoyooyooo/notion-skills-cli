---
name: verify-notion-resource-lifecycle
description: Check Notion Skill file ownership, editable projection guards, source publication ordering, pinned consumption, and read-only resumable audit proposals using TLA+/TLC and Pstack statecharts. Use before implementing those lifecycles or changing the covered guards. Distinguish implemented safeguards from proposed coordinator and audit behavior.
---

# Verify Notion resource lifecycles

Use the existing `verify-ntn-skills` Skill for live Notion, public CLI, installed SDK, physical-machine behavior and performance. This Skill adds formal planning checks; it does not duplicate those acceptance claims or authorize publishing, repair, deletion, production writes or a daemon.

## First establish what is being checked

Read `verification/models/resource-lifecycle/coverage.json` and `README.md`. The reviewed product base is `9f4cdc993bca61273a878382782c6eb1ef2747be`; the exact reviewed working-tree bytes are recorded in `coverage.json`. Formal assets were imported from `de3e7414568fca8bf62c2f2fc99ca3c217b871b6`, not used as the product base. Compare the recorded file hashes with the checkout. For changed files, trace the named functions and callers before updating the model or synchronization record.

ProjectionRace models an existing fail-closed helper plus a rejected automatic-overwrite proposal. The helper has no product callers in the reviewed tree; this is not coverage of existing explicit authoring writers. UpdateCommit and AuditRun describe proposed coordinator contracts. A passing model is not implementation completion. Do not classify their broken variants as production bugs without a code or live reproduction.

## Run the verification

Use the README's pinned Pstack and TLC setup outside the checkout. With `PSTACK_STATECHART_ROOT` and `TLA2TOOLS` configured:

```sh
node scripts/verify-resource-lifecycle.mjs --out "$(mktemp -d /tmp/notion-formal.XXXXXX)"
bun test packages/core/test/shared-file-state.test.ts packages/core/test/shared-file-observer.test.ts packages/core/test/shared-file-observer-readonly.test.ts
```

Read each original `report.md`, `tlc.out`, `summary.json` and `chart.mmd`. Require complete finite exploration in positive safety configurations. Require exactly the listed violated rules in each negative control. In the fairness case, state the environment assumptions. No unchecked rule, failed parser, timeout or missing chart is a pass.

Run the real-code mutation exercise only in an isolated worktree with all writers of the covered source files paused:

```sh
python3 scripts/check-resource-lifecycle-mutations.py --out /tmp/notion-resource-guard-mutations
```

Each original baseline must pass, the removed real guard must trigger an assertion failure, and restoring its exact bytes must pass again. The script stops rather than overwrites a concurrent change. Preserve outputs outside the repository. It changes no live Notion content.

## Explain every result in domain terms

For the human-edit counterexample, name the read, human edit and unconditional replace separately. For the update model, distinguish one dispatch, unknown response, current visibility and original receipt. For the audit model, distinguish surviving roots, orphan reverse inventory, coverage and resume progress. The current implementation cannot use a normal auto-adopting read as a strict read-only audit. Existing pending observation and body-write reconciliation use read-only reconcile mode; do not infer a write from a function name. The focused `readOnly` regression covers the separate new-adoption stop. The new `withReadOnlyNotion` boundary is exercised by `notion-readonly.test.ts` and `notion-readonly-observation.test.ts`; it does not implement the proposed audit inventory, budget or coverage coordinator. Trace the current status path through `verify-ntn-skills/features/resource-phase1.md`.

Use Pstack `/statechart` semantics: show the generated Mermaid, label states in the reader's words, preserve distinct rule-breaking states, and disclose hidden self-loops. Use Pele for SVG rendering. Do not draw a passing design by removing a failed rule or hiding its bad path.

## Maintain the verification

When code changes, use `/maintain-formal-verification-skill`: decide whether failures are a changed intended contract, model drift, or a product defect. Map a reproduced counterexample into the existing public CLI/SDK verification map. Move the reviewed commit and hashes only after that review. Performance, arbitrary data sizes, source parsing, actual permissions, Notion concurrency, multi-writer failover and full garbage-collection safety require their own tests or additional models.
