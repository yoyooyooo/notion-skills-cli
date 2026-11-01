# Native Markdown preimages for the two retained migration Skills

This collector makes one default Markdown GET for each of the 44 plus 7 native
page identities already recorded in two frozen snapshots. The Source ZIP in each
snapshot has no corresponding native page and is excluded. It does not discover
scope, read block children, call the public snapshot reader, or mutate Notion.

## Run

Use the existing official `ntn` authentication. The collector neither reads nor
copies credentials. Supply the exact snapshot files and their independently
retained SHA256 values; the output directory must not exist.

```bash
python3 scripts/collect-migration-native-preimages.py \
  --snapshot /absolute/doc-snapshot.json DOC_SNAPSHOT_SHA256 \
  --snapshot /absolute/shared-snapshot.json SHARED_SNAPSHOT_SHA256 \
  --notion-bin /absolute/path/to/ntn \
  --output /absolute/new-native-preimages-evidence --check
```

Then invoke the same command without `--check` for the explicitly requested
observation. Check mode makes no request and creates no evidence directory.
Every request is `GET v1/pages/{id}/markdown`, with API version `2026-03-11` and
the default Markdown version. The command never switches to v2 or retries.

The first failed request, invalid JSON, wrong response page, truncation, unknown
block, unsupported-content marker, or warning stops the run. Completed evidence
and failed raw stdout remain in place; `stopped.json` records the failure. Do
not rerun against an existing output directory. A successful run writes
`summary.json` with exactly 51 GETs and 51 complete native responses.

## Evidence and its limits

- `inputs/`: exact original snapshot bytes, with hashes in `input-bindings.json`.
- `raw/`: the original stdout bytes for each GET, including partial/error output.
- `requests/`: a write-once request saved before dispatch and an independent
  receipt saved after raw retention and validation. Each receipt is also appended
  to `requests.jsonl`. Files and the append journal are fsynced before proceeding.
  Raw stderr is not retained; real transport completion records only its hash
  and byte count.
- `preimages/`: the exact page/path association, original materialized-reference
  and canonical-file descriptors, and a `native_preimage` descriptor containing
  request versions/path, the raw JSON retention path/hash/size, and the native
  body hash. Body normalization version 1 changes CRLF to LF only.

The original snapshots' `references[].markdown` already includes materialized
typed links. It is not historical wire data. The collector compares hashes and
keeps the representations separate; equality or inequality does not establish
ownership, authorize a transformation, or turn a new response into an old one.

The frozen snapshot binds the original page/path mapping. No fresh References
property is read, so this observation does not prove the current membership is
unchanged, cross-page atomicity, or stability between a historical canonical
snapshot and the new raw observations. The migration input, approval, source
semantics, ownership and operation outcomes are never updated.

The descriptor is compatible with the migration conversion's native preimage:
read `native_preimage.retention_ref` as unchanged UTF-8 bytes, verify its hash and
size, and supply that exact text as `response_json`. Do not JSON-reserialize the
raw response. This collector supplies evidence only; a separate explicit review
and conversion still decides how it may be used.

## Controlled tests

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover \
  -s scripts -p test_collect_migration_native_preimages.py -v
```

Tests use synthetic snapshots and mocked GET results. They retain their temporary
directories and make no external requests.
