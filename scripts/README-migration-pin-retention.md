# Verify retained migration snapshots

`verify-migration-pin-retention.py` supplements an existing version-1 migration
inventory with exact, per-snapshot retention evidence. It requires Python 3 and
its standard library. It does not open the active state database, contact Notion,
execute retained scripts, change operation outcomes or execute a migration.

```sh
python3 scripts/verify-migration-pin-retention.py \
  --input ORIGINAL_INVENTORY/input.json \
  --summary ORIGINAL_INVENTORY/summary.json \
  --audit ORIGINAL_INVENTORY/object-verification.jsonl \
  --backup VERIFIED_BACKUP/state.sqlite \
  --objects VERIFIED_BACKUP/objects \
  --output NEW_RETENTION_EVIDENCE_DIRECTORY
```

The output directory must not exist. Keep these paths and generated evidence
private; they contain original local identities and references. The program
preserves its input and backup and writes three new files:

- `input.json`: the complete original migration input, with per-item
  `retention_verified` and a hash-bound receipt added for verified candidates.
  With `--complete-observation`, supported original reference sets and the item's
  `complete` flag are also completed from the retained evidence.
- `pin-retention.jsonl`: each candidate's exact database row, manifest identity,
  file and source-file index, original audit line references, and any failure.
- `summary.json`: original input hashes, verified counts, backup enumeration
  differences, reference inventory gaps, and output hashes.

Verification binds the original collector's input and object-audit hashes,
rechecks the complete SQLite backup hash, opens it with `mode=ro&immutable=1`, and
checks each exact snapshot row. It compares every declared `files` and
`source_files` entry with the original manifest, then verifies its original audit
row and the actual retained object bytes. Shared objects are hashed once per run.
The database hash is checked again before output. No original file is overwritten.

Exit `0` means every supplied candidate has verified retention evidence. Exit `2`
means the new output includes one or more unverified candidates; inspect the
complete per-item evidence. With `--complete-observation`, exit `0` additionally
requires every supplied original payload/reference observation to be complete;
unsupported observations produce exit `2` while retaining their verified bytes.
Exit `1` means the input evidence could not be bound or
read, or the output directory already exists. None of these exits authorizes
migration. Replan explicitly from the new `input.json`; `apply_allowed` remains
false in the planner.

## Completeness and historical references

Retained cache snapshots can protect old pins without claiming that a user
explicitly pinned every snapshot. By default this tool preserves `asserted_user_pin`,
every item's `complete`, and the inventory's `complete` flag. It does not turn an
absent user pin designation into a review requirement.

Each receipt reports the exact content identity and Router member identities
found in the original manifest, including any absent from the inventory's
`references`. Native resource page IDs in `references` are reported separately;
they are retained file pages, not automatically catalog content records. The
summary also reports snapshot rows omitted from the candidate index and historical
mapping rows or payloads that need their own inventory. Those are bounded,
read-only follow-ups for assessing completeness. Historical interpretation and
production migration approval remain separate decisions.

To complete supported individual observations, rerun against the **original**
inventory and its original summary with `--complete-observation` and a new output
directory. The tool preserves all original references and adds the exact content
identities observed in the retained manifest. The item becomes `complete:true`
only after its exact payload and known reference fields have been observed. An
unrecognized manifest field or reference shape leaves the item incomplete.
Missing target mappings remain the planner's separate `REFERENCE_UNRESOLVED`
blocker. The pin inventory's `complete`, migration scope, user pin designations
and every operation outcome remain unchanged.

Historical subscription Routers may have a single generated `ROUTER.md` without
a `router_members` manifest field. The verifier accepts only the exact old
`openSubscription` / `canonicalMain` format: original JSON-string frontmatter,
matching description, the complete Members section, unique ordered
`skill://UUID/SKILL.md` member refs, and an exact whole-file round trip. It reads
only the already hash-verified backup object. Historical zero-member and
one-member snapshots remain valid observations of their original bytes; this
does not enable a current Router or assert a current membership. Extra text,
ambiguous links, duplicate members or metadata mismatches leave the observation
incomplete. Original manifest and body bytes are never rewritten.

Run the synthetic tests without creating Python bytecode:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts -p test_verify_migration_pin_retention.py -v
```

The tests retain their small temporary fixtures for inspection. They use no real
library IDs, user paths, credentials or network access.
