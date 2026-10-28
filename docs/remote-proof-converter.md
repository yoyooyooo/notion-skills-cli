# Standalone remote publication proof conversion

`ntn-skills-proof-convert` converts explicitly enumerated, already committed Notion publication proofs. It supports selected historical v1-to-v2 formulas and the separately selected `canonical-name-v2` repair for proofs committed before canonical frontmatter preserved display names. It is a separate operator artifact. The normal CLI accepts only current version 2 proofs and imports no historical formula or conversion fallback. This tool is also separate from the offline local-state migrator.

The converter writes only the existing Publication property, addressed by its observed property ID. It preserves the operation ID, intended hash, current authored root, references, downloaded assets, source bundle, upstream provenance, Members and Default Context. Missing or empty Publication means unmanaged content and is rejected by this tool. Ordinary unmanaged-page behavior remains with the normal CLI.

## Build and runtime

Build to a fresh directory outside the normal package:

```sh
bun scripts/build-proof-converter.ts /absolute/new-proof-converter-package
```

Install that directory's exact dependencies with npm, then run its `ntn-skills-proof-convert.js` with supported Node (`^22.22.3 || >=24.20.0`). The generated package pins official `effect`, `@effect/platform-node` and `@effect/sql-sqlite-node` to `4.0.5`. Bun is the build tool, not the execution runtime. The entrypoint runs the same Node/SQLite admission policy as the CLI before opening Store. It uses the existing Notion and Store services, configured roots, credential routing and `ntn` transport. Configure these deliberately before planning; the plan binds the hashed credential identity and exact content-library parent. The converter does not discover pages or infer an allowlist from a database query.

## Operator input and historical evidence

Prepare a UTF-8 JSON allowlist:

```json
{
  "format": 1,
  "targets": [
    {
      "page_id": "11111111-1111-4111-8111-111111111111",
      "database_id": "22222222-2222-4222-8222-222222222222",
      "data_source_id": "33333333-3333-4333-8333-333333333333",
      "source_format": "original-provenance-v1",
      "expected_publication": "EXACT ORIGINAL COMMITTED MARKER JSON STRING",
      "expected_default_context": false,
      "expected_members": [],
      "audit_ref": "/absolute/retained-before-conversion-page.json",
      "audit_sha256": "SHA256 OF EXACT RETAINED AUDIT FILE BYTES"
    }
  ]
}
```

Replace the explanatory strings with actual retained evidence. `expected_publication` is the exact rich-text string, including JSON whitespace and key order. The audit file is a retained raw Notion page JSON object with `id`, `parent.database_id`, `parent.data_source_id` and `properties`. Its old Publication, Default Context and Members must establish the exact operator expectations. Extract a raw page object from an existing historical receipt when necessary and retain the original receipt alongside the extracted file. Hash the extracted file's exact bytes. A newly read live page is not historical authorization for previously unguarded metadata.

Every target requires explicit boolean `expected_default_context`, an explicit sorted, unique array of canonical UUID `expected_members`, and existing corresponding remote properties. These expectations must come from retained publication evidence or an explicit operator-reviewed metadata baseline. The converter never populates them from a live read. Listing a page constitutes the operator's explicit authorization to convert that exact owned target; unrelated owned pages are outside the list.

Two incompatible historical variants used marker version 1. `source_format` is mandatory:

- `original-provenance-v1` verifies `ownership_hash = SHA256(canonical(publicationOwnership(page)))`.
- `extended-guard-v1` verifies `ownership_hash = SHA256(canonical({ ownership, default_context, members }))`.

Only the selected formula is evaluated. There is no probing, fallback or automatic variant detection. Both require the complete current manifest hash and the old revision `SHA256(canonical([operation_id, intended_hash, manifest_hash, ownership_hash]))` to match the exact old committed marker. A writing marker, malformed marker, altered provenance or divergent content blocks conversion. Version 2 uses the nested guard formula; the extended variant can retain its hashes while changing only marker version.

### Explicit canonical name repair for committed v2 proofs

Use `source_format: "canonical-name-v2"` only for the proven alias-to-display-name projection change. It requires the same exact page/parent, original committed Publication string, Members, Default Context and original raw metadata audit as above, plus `canonical_baseline_ref` and `canonical_baseline_sha256`. Do not mix it with v1 targets in one plan. It supports Skill, Router and Prompt through their exact entrypoints; it never treats an arbitrary v2 mismatch as migratable.

The baseline is strict JSON `{ format: 1, snapshot, files, receipt_ref, receipt_sha256 }`. `snapshot` is the original retained snapshot manifest; `files` contains every original snapshot file as `{ path, bytes, sha256, base64 }`, including `ntn-skills-source.zip`. Read these bytes from the original content-addressed object cache, not a newly authored replacement. `receipt_ref` identifies the original verified create/write receipt JSON or its captured command wrapper with JSON `stdout`; its exact bytes are hashed by `receipt_sha256`. The receipt must bind the original record, snapshot ID and version. Keep the original receipt, snapshot and source export alongside the baseline for review. The converter verifies the snapshot identity, every retained byte hash, complete path set, original proof manifest, ownership and full revision; the original committed proof remains the content authority.

Planning compares the retained raw references and metadata to the current graph. Every nonentry file and the source archive must remain byte-identical. The only permitted entrypoint change is its exact canonical JSON frontmatter line from `"name": aliasFor(displayName)` to `"name": displayName`; body, other frontmatter, resource links, paths and bytes must match. Router proof reconstruction excludes the generated Members index while retaining the complete snapshot entrypoint for byte comparison. Marker/creation-link serialization changes, unknown or truncated Markdown, changed references or assets and extra baseline fields are rejected. The proposed proof keeps the operation ID, intended hash, ownership hash and optional creation proof and changes only the manifest hash and its derived revision.

The plan kind is `remote-proof-canonical-name-v2`. Its `before` includes the current graph `version_id`, original baseline and receipt bytes, original metadata audit, credential scope and all fresh raw responses/files. Apply binds the exact reviewed plan hash and this version by comparing a complete new observation to `before`; there is no version fallback. The existing durable attempt, final metadata guard, Publication-only PATCH and complete readback apply unchanged. Planning and baseline preparation grant no remote-write permission; review each exact allowlisted page and plan before applying it.


## Plan, review and apply

Create the output directory first. Planning reads remote content and writes a local immutable plan; it sends zero remote mutations:

```sh
node /absolute/new-proof-converter-package/ntn-skills-proof-convert.js plan \
  --input /absolute/owned-allowlist.json \
  --output /absolute/review/remote-proof-plan.json
```

The command prints `plan_hash`, the SHA-256 of the exact saved plan file bytes. Review the saved file and its original audit sources before using that hash. Existing plan output is never overwritten. Planning calls `readReferences(record, rawPage)` directly, bypassing the runtime publication reader that correctly rejects v1 markers. The old source bundle cannot mask changed root or reference Markdown: the manifest is calculated from the current direct reference projection, current downloaded files, and authored Router root.

The strict plan shape is:

```text
{ format: 1, kind: "remote-proof-v1-to-v2", targets: [
  { input: <exact allowlist target>,
    before: { credential_identity, audit_base64, raw_page, reads,
              record, references, files, publication, ownership, guard, manifest_hash,
              version_id, canonical_baseline_base64?, receipt_base64? },
    after: { publication: <exact new committed v2 marker JSON string> } }
] }
```

`reads` retains all reference/root Markdown and property/member metadata responses. `references` retains page ID, path and complete Markdown. `files` retains path, byte count, SHA-256 and exact base64 bytes, including the original source ZIP and preserved bundle files. `raw_page` retains the original complete metadata, including Publication property ID and parent. Expiring signed attachment URLs are excluded from comparisons, while downloaded byte identity is always compared. Plans and ledgers may contain private content; generated files use mode `0600`.

Apply the exact reviewed plan:

```sh
node /absolute/new-proof-converter-package/ntn-skills-proof-convert.js apply \
  --plan /absolute/review/remote-proof-plan.json \
  --expected-plan-hash EXACT_PRINTED_PLAN_HASH \
  --ledger /absolute/review/remote-proof-ledger \
  --apply
```

Apply strictly decodes the plan, verifies every retained file's byte identity, and recomputes the selected old proof and exact proposed v2 marker. It re-reads the full current graph and compares it against the reviewed plan. It then persists and syncs an immutable attempt, re-reads root metadata immediately before PATCH, and immediately reads metadata after the request, including a transport error. It never retries PATCH. Success requires the exact planned v2 marker plus a complete fresh read matching all preserved content, scope and guard evidence. Only automatic last-editor metadata and Publication's own value may change. A non-converted result stops the batch and exits with an unresolved error after printing its result.

These are guarded read/write operations, **not remote compare-and-swap**. Notion provides no CAS here. Stop concurrent publishers and manual editing during conversion. A change observed at a guard blocks the operation; an external edit in the remaining provider race window can only be detected by subsequent readback.

## Ledger and recovery

Use one retained ledger directory for the target set across every invocation. Do not remove it or switch to another directory to force a write.

Before any PATCH, `<page-id>.attempt.json` is atomically installed without replacement and synced. Its shape is `{ format: 1, kind: "remote-proof-conversion-attempt", plan_hash, page_id, target }`, containing the exact before/after target. Even a crash between that durable attempt and the request permanently forbids a second PATCH through this ledger. A different plan bound to an existing attempt is blocked. Each readback produces a separate immutable `<page-id>.<uuid>.observation.json`, retaining `plan_hash`, write outcome/response, observed raw metadata and, when readable, the complete graph.

Read-only reconciliation uses the same exact plan and hash:

```sh
node /absolute/new-proof-converter-package/ntn-skills-proof-convert.js reconcile \
  --plan /absolute/review/remote-proof-plan.json \
  --expected-plan-hash EXACT_PRINTED_PLAN_HASH \
  --ledger /absolute/review/remote-proof-ledger
```

Results are `converted` (exact new proof and preserved graph observed), `unchanged` (exact old proof and graph remain), `conflict` (different marker or graph), or `unknown` (readback could not establish a state). A prior attempt makes even the `apply` command read-only for that page. An unknown response is reconciled by observation; it never grants permission to resend. An unchanged result after an attempted write remains a manual investigation, including a possible crash before send. Keep the plan, original baseline sources and every ledger file for review. No result claims server-side locking or CAS.

## Integration checks

The converter's Node tests use the existing official Node runner and are included in its discovery. The integration owner can select them explicitly with:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/proof-converter/test/converter.node.test.ts
```

The tests use controlled Notion transport, a loopback attachment server, and actual Node filesystem plans/ledgers. They cover both historical variants, mismatched selected formula, preservation, root/reference/asset/source-bundle/provenance/metadata drift, unmanaged rejection, required explicit metadata and baseline identity, and unknown-outcome reconciliation with at most one PATCH. Build/typecheck and these tests are release integration checks; no execution of this tool implies authorization to convert additional remote pages.
