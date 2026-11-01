# Enrich two retained pilot records offline

Use this bounded followup after `prepare-migration-pilot-review.py` has produced a complete new draft. It does not call the CLI or a remote service. It writes a new draft only after checking all evidence and calling the actual core `resolveMigrationActivation` with `legacy_catalog_active_page_v2`.

```bash
bun scripts/enrich-migration-pilot-facts.ts --config FROZEN_PRIVATE_CONFIG
```

The config uses `version:1`, `format:migration-pilot-factual-enrichment`, an absent absolute `output`, and these frozen file objects: `{ "path": "ABSOLUTE_RETAINED_FILE", "sha256": "ACTUAL_SHA256" }`.

| Field | Retained input |
| --- | --- |
| `original_input` | Full original migration input, before the pilot file assembly |
| `assembled_input` | Full new draft produced by the preceding assembly |
| `original_metadata_root` | Absolute original metadata directory, not a mirror coordinate |
| `row_origins` | That directory's `row-origins.json` |
| `schema` | `schema.raw.json` |
| `schema_request`, `schema_completion` | Original schema GET request/completion |
| `entries` | Exactly two `{label,legacy_id,row,query_request,query_receipt}` selections; the final three fields are frozen file objects |

Each retained row origin supplies its original query path/hash, array index and byte interval. The script reads that existing query locally, checks the exact row slice and verifies its successful unfiltered query request at API `2026-03-11`. It does not make another query. Preserve raw `in_trash`/`is_archived` and absent `archived` bytes. Never add missing values to a raw response.

The factual mapping is explicitly named `legacy_catalog_tracked_reference_pages_v1`. It requires original `Sync Mode=tracked`, typed References links matching every retained supporting native page, one exact main page, and distinct native page identities. It only maps `legacy_mode=tracked` and `legacy_layout=ordinary_page`. The new `legacy_catalog_activity` carries the full original row/schema JSON and the API-specific activity policy; `legacy_catalog_factual_enrichment` retains the original classification and query/schema provenance.

Full original approval, coverage, backup, preservation, readiness evidence and unselected entries remain unchanged. The script leaves every file, ownership, Source selection, `files_complete` and `metadata_complete` value unchanged. Conflicting known classifications and prior enrichment are rejected instead of overwritten. The generated Router remains unchanged.

Keep the original input, assembled input and new `draft-input.json`, `entry-proposals.json`, `input-bindings.json` and `summary.json`. The summary says `prepared_with_explicit_gaps`; it is not a review, an approved migration or a current Notion observation. Source conversion, file ownership, Router closure and original-operation readiness remain separate evidence work. Do not add IDs to approval or change those facts to make this script pass.

Run the focused test `bun test packages/core/test/shared-migration-pilot-facts.test.ts` before using the private config. Temporary test evidence is retained for inspection. Running this source script does not rebuild or change the installed CLI artifact.
