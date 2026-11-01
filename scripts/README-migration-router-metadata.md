# Observe current Router metadata for migration

`collect-migration-router-metadata.py` collects native metadata for the exact
Router items already retained in a frozen migration input. It writes a separate
evidence directory and leaves the input unchanged. It does not produce a new
migration input or promote approval, completeness, Source interpretation, user
pin designations or operation terminal outcomes.

```sh
python3 scripts/collect-migration-router-metadata.py \
  --input PRECEDING_INVENTORY/input.json \
  --input-summary PRECEDING_INVENTORY/summary.json \
  --output NEW_ROUTER_EVIDENCE_DIRECTORY
```

The matching summary may come from the original inventory, the pin retention
verifier or the operation origin verifier. The collector checks the input hash
before reading and checks both local files again before finishing. The output
directory must be new. Generated evidence contains private native metadata and
must stay outside the repository.

## Reads and preserved facts

The standalone script uses only the Python standard library and the installed
official `ntn` executable. Each request uses this shell-free argument form:

```text
ntn api v1/pages/PAGE_ID --notion-version 2026-03-11 -X GET
```

Existing `ntn` authentication is inherited. The collector never reads or prints
tokens, captures the environment, or writes native content. `--ntn-bin` selects
an executable. `--timeout` defaults to 45 seconds per request; `--interval`
defaults to 0.4 seconds between sequential request starts. There are no automatic
retries, provider reads, member body requests or operation recovery actions.

Two original Router families are observed:

| Original locator | Requested native fields |
| --- | --- |
| `notion_subscription` | Name, Description, Default Context, Status, Source, Published Members and Target Database ID. |
| `notion_page` | Native title, Description, Default Context, Kind, Members and References. Title uses the `title` property ID; Description prefers the original built-in property ID. References is retained as native rich text. |

Every additional page property is retained, including unknown Source options,
publication details, Files, Tags and relation properties. Source and Published
Members retain their original rich text and exact joined text. If the text is
valid JSON, the full parsed value is included without schema filtering. Invalid
JSON remains an observed fact; it is not repaired or approved.

The selected Router list does not enumerate all subscriptions or Sources.
Subscriptions absent from the content catalog are not treated as disabled or
out of scope. Other source inventory and interpretation gaps remain separate.

## Pagination and observed stability

For each selected Router, the collector reads its native page, finishes necessary
property pagination, and reads the page again. A successful initial page is
reread even when a property chain fails. It compares page identity, parent, edit
markers, archival state and all original properties. Original raw bytes and
unknown fields are retained for both reads.

Relations with `has_more:true` are always expanded, including inline lists with
fewer than 25 entries. An absent relation pagination flag also triggers a
property read. Inline complete relations need no extra request. Pure text
title/rich-text values need no extra request merely because they contain many
text segments: the page API limit concerns populated mentions, not text length.
Rich text containing mentions is expanded; people lists reaching the page limit
are also expanded. See the official [page response limits](https://developers.notion.com/reference/retrieve-a-page)
and [property item pagination contract](https://developers.notion.com/reference/property-item-object).

Returned property IDs are already URL encoded and are inserted unchanged into
the property path. Only cursors are encoded as query parameters. Every wrapper
and item must match the exact requested property identity and type. Pagination
requires advancing cursors and complete response markers. Missing or repeating
cursors, foreign items, incomplete responses and repeated relation targets stop
that property observation. The collector constructs each known API path and
never follows an arbitrary `next_url`.

`stable` means the selected metadata and page markers matched at the two observed
boundaries and every needed property chain was exhausted. This is **not an atomic
snapshot**, file-content verification, reference-target validation, or permission
to migrate. Both full raw responses remain available. A difference in a Files
URL or its expiry time is reported as a metadata difference; no fields are
silently ignored and no signed URL is used as a content identity. Downloaded
bytes would need their own hash evidence in a later content observation.

## Output

| Artifact | Contents |
| --- | --- |
| `raw/000001.json`, etc. | Exact bytes returned by each `ntn` stdout, including failed JSON responses when present. |
| `requests.jsonl` | GET path, observation role, start/end times, response file/hash/byte count and read result. No credentials or raw stderr. |
| `router-evidence.jsonl` | Entire original retained Router item, original page responses, complete observed property values, field bindings, issues and stability comparison. |
| `router-receipts.jsonl` | Per-Router result and exact evidence-line hash, with request references and observed fields. |
| `summary.json` | Input hashes, observation counts, evidence hashes and explicit unchanged migration gates. |

Exit `0` means every selected Router has a stable metadata observation. Exit `2`
means at least one is changed, incomplete or unavailable; collected raw evidence
is still retained. Exit `1` indicates a global input or file failure. An
interrupted output without a summary is partial evidence and cannot be treated
as a finished collection.

Synthetic verification:

```sh
python3 -B -m unittest discover \
  -s scripts -p test_collect_migration_router_metadata.py -v
```

Tests exercise encoded IDs, cursor integrity, 101-member and 23-inline-member
pagination, unknown raw fields, both Router families, plain text versus mentions,
changed metadata, failed rereads, immutable inputs and the GET-only transport.
All fixtures use synthetic identities and retain their small temporary files.
