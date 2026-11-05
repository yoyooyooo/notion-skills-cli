# Selected snapshot consumption

A complete immutable manifest and a complete local file set are different states.
The existing `read`, `files`, `prepare`, `export` and SDK `consume` interfaces
preserve their identities and output contracts while selecting only the object
bytes required by the current operation.

## Selection and readiness

| Internal demand | Required object bytes |
| --- | --- |
| `manifest` | None; validate the complete file directory and its identities. |
| `entrypoint` | The snapshot's main file. |
| `target` | The file selected by the fixed target, resolving a stable File ID before using its path hint. |
| `all` | Every file, with the existing full integrity checks. |

The complete directory remains available in every partial result. It includes
unselected files, their hashes and stable File bindings. A missing or corrupt
unselected object does not prevent a fixed main or unrelated resource read. The
same object must fail or be restored under the existing rules when selected; a
complete export still requires every file to pass.

`materialization.materialized_paths` reports the paths actually verified for
this operation. `local_files_ready: false` means that the operation has not
established readiness of the entire local set; it does not claim every omitted
file is absent. Only a verified selection covering the whole manifest can report
`local_files_ready: true`. A one-file snapshot therefore becomes complete after
its entrypoint is verified.

SDK `consume` keeps contract version 1. An entry with only its main verified
reports `entry_ready`; the full manifest and source-body proof remain present.
Resource batches retain their separate versioned contract. Host delivery and
instruction activation are not inferred from any local readiness state.

## Fixed local and retained snapshots

The reader validates immutable metadata before reading selected objects.
Existing complete snapshot JSON does not imply that all objects are still local.
Missing selected bytes can use the existing retained manifest for the exact same
scope, owner and pin. Restoration checks the frozen tree against the selected
manifest and obtains only the missing requested files. Previously verified
selected bytes can be reused.

Corrupt selected bytes are an integrity failure, not permission to fetch a newer
current version or silently overwrite a bad object. Unselected objects are not
scanned to decide whether the requested subset is ready. Graph-release
`entrypoints` restoration follows the same rule; full restoration and export
continue to check the complete set.

A complete local fixed pin preserves its existing offline semantics. Retained
restoration keeps its normal current scope/library/owner admission. Offline
missing-object failures remain explicit. Neither a short reference nor a local
proof grants new source access.

## Current cache and complete reference validation

Current shared content has an additional complete-reference gate. An older
cached snapshot with valid object hashes may still contain an unresolved or
invalid shared reference. Merely having a snapshot ID or the current generator
marker does not establish that this gate ran.

A disposable local validation receipt is recorded only after the complete tree's
object sizes/hashes and shared references have actually passed. The receipt binds
scope, record identity, snapshot/version and a canonical digest of the complete
snapshot manifest, including file bindings and reference/relationship metadata.
An explicit selective cache lookup may reuse that receipt, then verify the
requested object bytes. Ordinary complete callers retain full object validation.

Missing, older or mismatched receipts require the original complete check.
A broken current reference still fails locally, including offline current reads;
explicit historical pins retain their original source semantics. A changed
manifest cannot reuse an earlier receipt merely because its snapshot ID was
copied.

Recording or reusing this receipt does not renew `validated_at`, extend
`shared_body_valid_until`, change the observation generation or clear pending
work. Current selection still checks credential scope, database, TTL, full-body
deadline, invalidation and pending/unknown work. Cache clearing cannot revive an
old observation through this receipt.

## Scope of the improvement

This separates complete-manifest and complete-reference evidence from repeated
local object acquisition. It improves fixed/partial-cache reads and eligible
current cache hits. It does not turn an unobserved mutable current tree into a
verified immutable snapshot.

A genuinely cold, unfixed current selection may still need all existing body
observations to establish its complete version, native references and ownership
state. Source ownership planning, Git content-identity conversion and legacy
whole-archive retrieval keep their existing semantics. Any remaining full-source
or ZIP cost must be reported; it is not random access merely because the final
read returns one file.

Verification uses actual object-read counts, complete output/hash comparison,
partial-cache failures, unchanged freshness and independent package/Pi paths.
Warm seeded fixtures, controlled source acquisition and live Notion observations
are reported separately. Follow the existing
`.cursor/skills/verify-ntn-skills/features/skill-consumption.md` route.
