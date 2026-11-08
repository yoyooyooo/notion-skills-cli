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
scope, owner and pin. New shared snapshots can also retain `shared_acquisition`:
the original library binding, fixed source ID/revision and source path, or the
exact retained resource manifest ID. These are retrieval locations for the one
authoritative `Snapshot.files` directory, not a second file manifest. Acquisition
validates current scope/library/owner access, then verifies the original selected
hash, size and mode. It never consults the current Source selection for substitute
bytes. Restoration obtains only missing requested files; verified selected bytes
can be reused.

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

Logical current reads can carry one complete scoped Skills metadata observation
from selector resolution to native-reference compilation, as defined in the
[metadata consumption contract](shared-metadata-consumption.md). The current page
and its body remain independent observations; the handoff does not renew any
cache lifetime or substitute directory fields for source/ownership facts.

Current shared content has an additional complete-reference gate. An older
cached snapshot with valid object hashes may still contain an unresolved or
invalid shared reference. Merely having a snapshot ID or the current generator
marker does not establish that this gate ran.

A disposable local validation receipt binds scope, record identity,
snapshot/version and the canonical digest of the complete snapshot manifest,
including file bindings, frozen acquisition and reference/relationship metadata.
It is recorded after the required object sizes/hashes and the complete logical
reference tree pass. Optional `verified_paths` records partial byte coverage:
all Markdown and the main file must be present, and only supporting raw files
with frozen acquisition routes can be omitted. Absence of `verified_paths`
preserves the old complete-byte proof. An explicit selective cache lookup may
reuse this receipt, then verify its requested bytes. Full export and authoring
still validate every effective object.

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

## Effective current source ownership

An uncached current read first plans the complete selected immutable source.
`planSelectedSharedSource` retains the validated source binding and returns the
full path/length/content-identity directory plus an exact-path materializer.
Git descriptors retain their Git blob OID identity. New management-verified Git
bindings can additionally freeze SHA-256 and known `100644`/`100755` mode for each
path; the new optional fields enter the new binding identity. Legacy absence keeps
the original identity and requires full byte acquisition to derive a complete
SHA-256 directory. A Git OID is never treated as SHA-256. Reading a derived cache
does not change either identity. A known SHA-256 can reuse bytes already read from
another transport after size, SHA-256 and Git OID all verify. The full-byte resolver
remains the path for authoring and explicit source refresh.

Current consumption then follows these boundaries:

1. Admit the complete source directory, including every Base/Mount collision,
   path alias, declared size, HTTP location/origin and local machine/workspace
   binding. An excluded resource cannot conceal an invalid declaration.
2. Read complete shared membership and ownership facts, reconcile original
   operations under the existing rules, and reject unresolved, orphaned or
   conflicting state. Plan logical placement against the full source directory.
3. Acquire source inputs needed by that ownership state and the requested bytes.
   Ordinary main reads, directory listing and graph preparation may defer
   non-Markdown resources when every source entry has a declared SHA-256. All
   effective Markdown still participates in current reference validation.
   Existing custom
   files, tombstones and suppressed move paths do not require their original
   SHA-256 source bytes. A following move reads its original source path and
   renders it at the final logical path.
4. Observe current native bodies, compose the complete logical directory, validate
   its references and publish the immutable snapshot. Unselected raw entries
   retain their declared hash/size/mode and exact retrieval locations. No empty
   placeholder bytes stand in for unavailable data. Full export, resource
   management and `read --authoring` verify every effective file.

The placement planner is shared by metadata planning and full-byte composition.
Omitted source files are neither empty files nor a replacement full manifest.
Missing required bytes fail explicitly. Source provenance, stable File IDs and
the source replaced by a custom move remain available after composition.

Two dependencies deliberately keep source reads:

- A legacy custom main with unknown original frontmatter can still require the
  source main for additional YAML fields. A custom body with retained frontmatter,
  including known empty frontmatter, uses that baseline instead of a later Source.
  Managed name/description retain their existing precedence. Following files use
  selected source bytes and mode together; custom mode remains its own baseline.
- An overridden Git original may carry a durable SHA-256 local-content
  restriction. A Git OID alone, or a disposable OID-to-hash cache record, cannot
  establish that restriction. Its verified original bytes remain required for
  classification when its immutable binding has no SHA-256. A new binding with a
  management-verified SHA-256 can check the existing durable restriction directly;
  it does not have to redownload a shadowed original just to recover its hash.

Complete declared local SHA identities conservatively restrict matching source
aliases, including an effective HTTP path whose local alias is excluded. Only
selected, actually verified bytes can establish a new durable restriction through
materialization. An acquired alias is marked before its object or derived Git
index is published, so a later required-source failure cannot leave that object
unrestricted in the cache. Verified cache hits are classified before returning.
Existing markers continue to propagate through replacement and logical moves.
Skipping source bytes never grants archive permission.

Required source acquisition precedes the observer's adoption side effects. If a
required provider fails, the invocation cannot first retain a new user edit as
an adopted fact or publish a successful snapshot. Consequently, a following file
that becomes custom during this very read may still incur its original source
read. Eliminating that cost would require separating pure observation from its
commit, which this change does not do.

`--refresh` and `--max-age 0` renew the current metadata/required-body observation;
they do not implicitly request every raw resource. The independent native-body
deadline still applies. Raw immutable identity and management-page edit time do
not create a new native-body verification claim. The per-owner file-observation
cache uses one generation-ordered `latest.json` slot. Older generation records
remain readable, while repeated refreshes no longer append an entire observation
list each time. Cache retirement fences in-flight reserved generations and leaves
immutable snapshots, objects and original-operation evidence intact.

## Retained-source selection and archive cost

Retained-source materialization validates the complete immutable manifest before
selecting objects, including equal-hash length consistency. It reads each
selected content object once. An empty selection performs no object or archive
acquisition after validation. A corrupt selected cached object remains an
integrity failure; an unselected corrupt or missing object is untouched.

If a selected object is missing from a legacy retained bundle, recovery still
downloads and validates the entire ZIP and all its members. Only the missing
selected objects are published after that whole-archive check. This saves
unnecessary local publication but does not provide remote random access. Report
the complete archive payload and requests even when the final read is small.

## Scope of the improvement

This separates complete-manifest and complete-reference evidence from repeated
local object acquisition. It improves fixed/partial-cache reads and eligible
current cache hits, and avoids source acquisition for already established
ownership overrides. It does not turn an unobserved mutable current tree into a
verified immutable snapshot.

A genuinely cold, unfixed current selection may still need all existing body
observations to establish its complete version, native references and ownership
state. Git privacy classification, source main metadata, a newly observed
ownership transition and legacy whole-archive retrieval can still require
additional source bytes. Report those costs separately; returning one file does
not establish that only one file was acquired.

Verification uses actual object-read counts, complete output/hash comparison,
partial-cache failures, unchanged freshness and independent package/Pi paths.
Warm seeded fixtures, controlled source acquisition and live Notion observations
are reported separately. Follow the existing
`.cursor/skills/verify-ntn-skills/features/skill-consumption.md` route.
