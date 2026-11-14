# Maintenance audit contract

MNT02 / AH-1026 and MNT07 / AH-1031 share the existing audit run. They do not add a second engine, a remote repair, or a live-library claim.

## Scope

`--target` reads the selected Skill page, its direct Requires and Origin pages, and that page's File and Record headers. File and Record queries use a Skill relation filter and omit Payload. `--all` and `--census` keep independent unfiltered scans. A cleared owner is visible only to those scans.

`inventory.complete` means an unfiltered table finished. A reachable run leaves it empty. Owner queries are `scope.kind = "reachable"` plus `owner_coverage`. `inspection_scope`, `reverse_table_completeness`, and `skill_states` stay separate from depth. Depth still selects metadata, content, or history. Permission, pagination, and an owner outside the observed rows are not deletion.

A full-library conflict is claimed only from a completed unfiltered census. Two observed rows can still conflict inside a reachable read. The finding records `library_census: "unobserved"` in that case.

A bad page id or an unreadable target becomes `TARGET_PAGE_UNAVAILABLE` or `TARGET_PAGE_OUTSIDE_LIBRARY`. An invalid main file id is `MAIN_FILE_ID_INVALID` even when the tree cannot be built (`SKILL_TREE_UNAVAILABLE`). The run does not collapse those into an undifferentiated execution failure.

Current rules are `resource-audit-v3`. v1 and v2 checkpoints stay readable offline and cannot resume. Budgets, cancellation, checkpoints, zero remote writes, and offline report are unchanged.

Both the initial and final reachable observations publish each received owner result before starting the next query. If Files access is denied and the following Records request exhausts the budget, the paused online and offline reports retain the permission finding and its owner coverage. Resume replays the confirmed denial within that original task; a separate final observation may establish that access has since changed, while the original denied response remains in the run's evidence. Budget exhaustion is an additional fact, not a replacement for an already received failure.

## Retention

The same report carries `growth` and `next`. Growth lists active files, tombstones, original operation headers, snapshot and body-fact headers, known history retainers, and unobserved private pins. Metadata and the default report do not load every Record payload. Same-owner equal Record ID headers are `possible_equivalent` until a full payload comparison exists. Conflicting header facts are errors. Equal header hashes across owners are reported as a header observation only; body equality is unverified and no merge is proposed. An unlinked script is not an orphan.

`next.argv` is one explicit read-only recommendation with a reason. Optional `alternatives` describe a separate full census or further inspection; the audit executes neither. Details are bounded while counts retain their observed denominator. Audit does not garbage-collect, delete, merge or repair remote rows.

A healthy target's default next action reports that same retained run. The broader reverse census remains an optional alternative rather than silently expanding the target's scope.

## Verification ownership

`AuditRun` retains the original full reverse-census contract. `AuditScope` separately abstracts target closure, early observation, budget continuation and the boundary between target and global completeness. Its configured counterexamples reject missing owner facts, mutation, scope switching, progress loss and target-as-global claims. These bounded models do not prove concrete pagination, response bytes or current Notion permission scope. Public installed Node runs compare the same target with zero and 120 unrelated rows; each records the actual HTTP ledger and unchanged source hash. A three-request pause must retain an already observed root identity failure. An actual deletion followed by audit checks tombstone identity without adding remote facts.
