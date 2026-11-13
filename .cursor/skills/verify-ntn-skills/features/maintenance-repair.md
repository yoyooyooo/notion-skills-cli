# MNT03 original-page repair

Use this map for the controlled historical repair and one selected Files-row adoption. Native draft adoption stays on `adopt`. This page does not record a live or installed pass.

## Public shape

Main mounts `repairCommand` from `packages/cli/src/commands-maintenance-repair.ts` under `ctl`.

```sh
ntn-skills ctl repair plan PAGE --entry historical-missing-main --database DATABASE --dry-run
ntn-skills ctl repair apply PAGE --entry historical-missing-main --database DATABASE --operation OPERATION_ID
ntn-skills ctl repair show OPERATION_ID --database DATABASE --page PAGE
ntn-skills ctl repair reconcile OPERATION_ID --database DATABASE --page PAGE
```

`managed-file` adds `--path` and `--owner`. `ordinary-child` returns the unsupported same-page branch and crawls no descendants. `next.argv` is an array, not a shell string. Apply repeats the operation ID. It does not require a handwritten record.

`recognizeRepairOperation` is the family recognizer. Its family is `maintenance-repair`. Generic `ctl operation resume` does not own these IDs.

## Focused proof

From the checkout, without production Notion:

```sh
bun test packages/core/test/shared-native-repair.test.ts packages/core/test/shared-file-adoption.test.ts packages/core/test/shared-create-dispatch-repair.test.ts packages/cli/test/maintenance-repair.test.ts packages/core/test/shared-native-adoption.test.ts --timeout 60000
bun -e 'import { checkMaintenanceRepairHttp } from "./scripts/package-smoke/maintenance-repair.ts"; console.log(JSON.stringify(await checkMaintenanceRepairHttp()))'
```

The second command reuses the authoring fixture request closure. It is source-function proof. It is not an installed package run and not a live Notion run.

## Required observations

- Dry-run and show/reconcile do not add journal or Notion writes.
- A legal Skill ID, URL, author metadata, enabled state, body, and prior completed history stay in place.
- A 32-byte NUL Main File ID is blank, not a legal ID.
- Partial metadata, archive, wrong scope, nonempty binding, clone, foreign ID, permission failure, Files conflict, and an unknown original operation stop before writes.
- A changed body or frontier stops before writes.
- A lost PATCH is not sent again. A matching current ID does not become an ACK.
- An accepted but lost plan response is not posted again. A lost outcome is not posted again.
- Repeating a completed operation adds no rows.
- Current consumption refuses the owner while the repair outcome is absent, and does not use that owner's headers to block another Skill.
- A File ID filled before its outcome is not current-ready.
- `sharedCreateDispatch` still rejects a creation Main File ID patch and rejects a repair POST before transport.

## Formal mapping

No lifecycle or operation-recovery model changes. Do not refresh coverage hashes for this slice. `AuditRun` still does not model repair fields. `AcknowledgedRecordPrefix` still owns exact ACK records. The new gate is the implementation barrier `assertSharedRepairPending`, called from `openSharedSnapshot` after the native adoption barrier.
