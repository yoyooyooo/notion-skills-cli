# Observe original migration operation families

`verify-migration-operation-origins.py` binds each retained operation to the exact
row and payload in an already verified SQLite backup. It supplements the frozen
migration input with `operation_origin` and payload retention evidence. It does
not dispatch or reconcile an operation, query Notion, alter terminal evidence, or
invent missing original fields.

Use the original inventory or the completed pin-observation output, with its
matching summary:

```sh
python3 scripts/verify-migration-operation-origins.py \
  --input PRECEDING_INVENTORY/input.json \
  --input-summary PRECEDING_INVENTORY/summary.json \
  --index ORIGINAL_INVENTORY/operation-index.json \
  --backup VERIFIED_BACKUP/state.sqlite \
  --output NEW_OPERATION_EVIDENCE_DIRECTORY
```

Keep the generated evidence private. The output directory must be new. It
contains the complete supplemented `input.json`, per-item
`operation-origins.jsonl`, and a summary with input/output hashes and source-table
counts. Exit `0` means every supplied operation has verified row provenance;
exit `2` retains one or more unverified items; exit `1` indicates an input binding
or read failure. The script uses the byte and strict JSON helpers from the
adjacent pin-retention verifier.

The input is bound to its preceding receipt. The backup hash is checked before
and after opening SQLite with `mode=ro&immutable=1`. Each exact row must match the
original index's payload SHA, byte length and SQL columns, and its parsed payload
must equal the entire retained `raw`. The original row and payload identities
must also agree. No input or backup file is overwritten.

The planner recognizes identity by the explicitly proven source table:

| Original table | Identity evidence |
| --- | --- |
| `upstream_commands` | Original operation ID, scope, database, supported command domain and original state. The original schema makes `phase` optional. |
| `upstream_operations` | Original operation ID, plan ID, subscription, batch state and member operation states. There is no command phase. |
| `integrity_operations` | Original operation and publication IDs, intended hash, exact marker identity and row state. The original state is `marker.state`; absent scope and phase stay absent. |

Opaque source options, inputs, intents and all other original payload fields
remain untouched. A verified origin removes only an incorrectly applied operation
identity blocker. Local `verified` and `committed` values do not prove a current
remote outcome: `UNSETTLED_OPERATION`, `terminal_verified`, terminal evidence and
`automatic_replay:false` retain their existing meaning.

This tool deliberately preserves each item's `complete` and `references`, as
well as the overall operations inventory's `complete`. A fully retained payload
does not establish that its complete historical reference set has been
enumerated. The table counts expose rows outside the selected inventory without
quietly adding, dropping or approving them. Replan from the new frozen input;
neither the verifier nor the planner authorizes production migration.

Synthetic tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts -p test_verify_migration_operation_origins.py -v
```

Tests retain their small temporary fixtures and contain no private identifiers,
user paths or credentials. The planner's family tests are
`shared-migration-operation.test.ts` and `shared-migration-operation-plan.test.ts`.
