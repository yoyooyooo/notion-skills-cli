# Observe original migration operation families

`verify-migration-operation-origins.py` binds each retained operation to the exact
row and payload in an already verified SQLite backup. It supplements the frozen
migration input with `operation_origin` and payload retention evidence. It does
not dispatch or reconcile an operation, query Notion, alter terminal evidence, or
invent missing original fields.

## Complete storage enumeration

The existing Node 24 collector now writes two additional private sidecars in its
new run directory. Its `input.json` and `operation-index.json` keep the original
selection: the five explicit command domains, every upstream batch and every
integrity row. The command predicate is the original SQLite JSON predicate;
local terminal-looking states do not select or exclude rows.

| Sidecar | Retained evidence |
| --- | --- |
| `operation-storage-index.json` | Every row in `upstream_commands`, `upstream_operations`, `integrity_operations` and, when present, `operation_reviews`: original table and SQL key, payload SHA-256 and UTF-8 byte length, JSON validity and type, observed family, all other SQL columns, and exact backup-row pointer. |
| `operation-reviews.json` | Every original review row, using its real `id` key and preserving the exact `payload_json` string, including whitespace. Its SQL `operation_id` remains a separate original field. |

These are storage-row counts, not counts of independent operations. Materialized
cache entries, maps and member pointers stay separate from the selected plan
operations. Recognized prefixes with unexpected shapes and malformed JSON remain
visible as unclassified rows; no label removes original bytes from the backup.
Family labels describe the observed storage shape and do not decode its complete
reference set or assert remote success. An absent legacy review table is recorded
as `null`/`table_present:false`, distinct from a present table with zero rows.

Run the same collector with explicit paths and a fresh destination:

```sh
node .cursor/skills/verify-ntn-skills/scripts/shared-migration-inventory.ts \
  --catalog "$MIGRATION_CATALOG_JSON" \
  --backup "$MIGRATION_BACKUP" \
  --target-library "$MIGRATION_TARGET_LIBRARY_ID" \
  --run "$MIGRATION_NEW_RUN"
```

The path variables must be absolute; the new run must be outside the backup.
Its original summary binds both sidecar hashes and `source-fingerprints.json`,
which records the collector's source hash and exact backup identity. Preserve the
backup: command/support payloads remain in its original rows, referenced by the
sidecar rather than copied into invented operations. This collection still sets
`references_complete:false`, zero verified current outcomes and an empty approved
scope. It does not claim complete migration readiness.

## Verify original row provenance and sidecars

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

For an input enriched by the pin-retention verifier, also pass
`--inventory-summary ORIGINAL_INVENTORY/summary.json` to verify its storage
sidecars. The pin receipt must bind that exact original summary and inventory
hash. Without a bound storage receipt, older runs remain supported and the
output explicitly reports `storage_inventory.status:not_observed`; successful
selected-row verification alone does not establish full storage enumeration.

Keep the generated evidence private. The output directory must be new. It
contains the complete supplemented `input.json`, per-item
`operation-origins.jsonl`, and a summary with input/output hashes and source-table
counts. Exit `0` means every supplied operation has verified row provenance;
exit `2` retains one or more unverified items; exit `1` indicates an input binding
or read failure. The script uses the byte and strict JSON helpers from the
adjacent pin-retention verifier. The summary records hashes of both verifier and
helper source files. When storage verification succeeds, the output also retains
the exact original sidecar and source-fingerprint bytes.

The input is bound to its preceding receipt. The backup hash is checked before
and after opening SQLite with `mode=ro&immutable=1`. Each exact row must match the
original index's payload SHA, byte length and SQL columns, and its parsed payload
must equal the entire retained `raw`. The original row and payload identities
must also agree. No input or backup file is overwritten.

For storage sidecars, the verifier reads the fixed sibling filenames beside the
original summary, checks their bound hashes, then reconstructs the index from the
read-only backup. It compares every row, family, SQL column, byte hash and review
JSON string, and requires the selected set to equal the original operation index.
Dropping a row, duplicating it, changing its role or reformatting a review payload
fails even if a modified sidecar has a newly calculated hash. Paths inside JSON
payloads are never followed as source files.

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
enumerated. The storage sidecars expose rows outside the selected inventory without
quietly adding, dropping or approving them. Replan from the new frozen input;
neither the verifier nor the planner authorizes production migration.

Synthetic tests:

```sh
node .cursor/skills/verify-ntn-skills/scripts/shared-migration-inventory.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts -p test_verify_migration_operation_origins.py -v
```

The Python suite also runs the actual Node 24 collector against synthetic SQLite
backups; set `MIGRATION_INVENTORY_NODE` if its executable is not named `node`.
Tests retain their small temporary fixtures and contain no private identifiers,
user paths or credentials. The planner's family tests are
`shared-migration-operation.test.ts` and `shared-migration-operation-plan.test.ts`.
