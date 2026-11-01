# Join retained native metadata observations to migration entries

`enrich-migration-metadata.py` is an offline join between a frozen migration
catalog, two saved native metadata query rounds, and retained Router property
evidence. It changes only individual `metadata_complete` flags. Original record,
metadata, raw payloads, file/body evidence, ownership, Source semantics, approval,
operation terminal state and overall inventory completeness stay unchanged.

The new native evidence lives in separate, hashed files. No entry schema change
or metadata wrapper is required, and the original metadata value stays at its
original location in the new input.

```sh
python3 -B scripts/enrich-migration-metadata.py \
  --input PRECEDING_INVENTORY/input.json \
  --input-summary PRECEDING_INVENTORY/summary.json \
  --observations SAVED_QUERIES/observations.json \
  --observations-summary SAVED_QUERIES/summary.json \
  --router-evidence RETAINED_ROUTER_EVIDENCE_DIRECTORY \
  --output NEW_METADATA_EVIDENCE_DIRECTORY
```

The adjacent `collect-migration-router-metadata.py` supplies the existing pure
metadata and pagination parser. The enrichment script never constructs its
network reader, launches `ntn`, downloads files or opens a live state database.
The destination must be new. Keep all generated evidence private and outside
the repository.

## Input and association

The migration input is bound to the preceding inventory, pin-retention or
operation-origin summary. Saved query observations have this shape:

```json
{
  "initial": { "DATA_SOURCE_ID": ["complete raw page objects"] },
  "confirm": { "DATA_SOURCE_ID": ["complete raw page objects"] }
}
```

The accompanying query summary is retained as input context. The output receipt
binds the exact bytes of both query artifacts; summary counts alone do not prove
catalog or Source inventory completeness. Extra observed subscriptions remain
outside this join unless an original catalog entry selects them. They are not
classified as disabled, excluded or approved.

Each catalog entry must select one exact page in each round. The page ID,
database and data-source parent must match the original locator. Duplicate,
missing, moved, archived or trashed pages stay unverified. Current native name,
description, kind and Default Context must agree with the original record.
Entrypoint must still match the original kind. Subscription targets and an
explicitly retained Enabled value must also agree.

Native title and built-in Description property identities follow the original
reader's contract. The original optional native Kind and Default Context
defaults are preserved. Subscription Source and Published Members are observed
as complete raw metadata, without approving their provider or interpreting
unknown Source options. A missing original metadata field stays absent and
incomplete; this script does not invent a replacement metadata model.

## Router evidence and pagination

Router summaries must match their evidence, receipt and request files by hash
and length. Every numbered raw response is checked against its request receipt.
The existing observer then replays those exact retained responses offline. The
replayed result must equal the recorded Router observation. A claimed `stable`
status by itself is insufficient.

Complete relation evidence must match the same property ID and type. Every
inline query relation value must be present unchanged in the full retained
relation. `has_more:true` must represent additional entries, even when the
inline list contains only 23 entries. Complete inline relations must equal the
full membership. Other supported truncated property types require the exact
retained inline shape before their complete values can be joined. Unobserved
pagination stays incomplete.

The two query observations and the later Router observations must agree on page
identity, parent, edit markers, archival state and every managed property after
the proven property expansions. This boundary check is not an atomic snapshot
or a validation of referenced member bodies.

## Narrow handling of native file access URL renewal

The only URL-renewal exception is the original built-in Files property ID:

```text
notion%3A%2F%2Fskills%2Ffiles_property
```

For a native `type:file` item on that property, changing an access URL and expiry
can be recognized only when all of these remain true:

- Both URLs use a supported Notion S3 access form with the recognized signing
  fields, strict UTF-8 query decoding and valid percent encoding.
- The scheme, host and object path are identical. Non-signing query segments
  remain byte-for-byte identical; `+` and `%20` are not conflated.
- Original control characters, whitespace, user information and malformed URL
  forms are rejected before parsing can erase them.
- File name, type, array position and every other descriptor or nested field are
  unchanged. Unknown file properties receive no renewal exception.

The evidence retains both original URLs and expiry timestamps, plus the exact
matching access coordinate. Its coordinate hash identifies that observation
only. `content_identity_verified` and `body_identity_verified` remain false.
Replacing an object behind the same coordinate would still require independent
body-byte evidence; this script never supplies it.

## Output and failure behavior

| Artifact | Contents |
| --- | --- |
| `input.json` | The original input with only per-entry `metadata_complete` recomputed. |
| `metadata-evidence.jsonl` | Original metadata/record values, both raw query page objects, query positions, complete observed properties, Router evidence bindings, comparisons and issues. |
| `metadata-receipts.jsonl` | Per-entry verified/unverified result and exact evidence-line hash. |
| `summary.json` | Input and output hashes, retained Router artifact hashes, counts, failure codes and unchanged migration gates. |

All original input artifacts and Router evidence hashes are checked again before
output is written. A runtime comparison also confirms that restoring only the
original metadata flags reconstructs the complete original migration input.

Exit `0` means every selected entry has verified metadata within these supplied
observations. Exit `2` retains one or more incomplete entries with their failure
codes. Exit `1` indicates a global binding, retained-evidence or file failure.
No outcome authorizes applying migration, settles an operation, or changes
catalog coverage, Source inventory completeness, file membership or ownership.

Synthetic verification:

```sh
python3 -B -m unittest discover \
  -s scripts -p test_enrich_migration_metadata.py -v
```

The tests cover immutable original values, both Router families, ordinary Skills,
23-item truncated relations, exact offline response replay, URL renewal and its
malformed/unknown-field counterexamples, metadata drift, original-record
mismatch, missing evidence, hash tampering and output preservation. Fixtures
contain synthetic identities and retain their small temporary files.
