# Fixed resource reads, version 1

`ntn-skills/sdk` exports `RESOURCE_READ_CONTRACT_VERSION = 1`, `readResources`,
and `decodeResourceReadResult`. This capability is
independent of `SDK_VERSION = 1` and `CONSUMER_CONTRACT_VERSION = 1`.

```ts
import { readResources, decodeResourceReadResult } from "ntn-skills/sdk";

const input = {
  version: 1 as const,
  refs: [firstPinnedFileRef, secondPinnedFileRef],
  budget: { maxFiles: 16, maxBytes: 1_048_576, timeBudgetMs: 30_000 },
};
const result = await readResources(input, { database, signal });
// A persisted or transported result is checked without opening a source runtime.
const verified = await decodeResourceReadResult(result, input);
```

## Selection and budgets

All refs must be exact pinned file references belonging to one owner and one
snapshot. A batch reads resources only: including the snapshot entrypoint fails
before object acquisition. Use `consume` for main instructions and dependency
preparation, or `readSkill` for an individual main/file read. The reserved
`consume` v1 `requestedFiles` field remains unsupported when nonempty. A combined
prepare-and-files operation would need its own explicit contract.

An empty selection, an unfixed reference, a mixed owner/pin, or duplicate input
refs fails. A stable File ID resolves through the selected snapshot's frozen
binding; an old path hint can resolve to its actual path. Two refs resolving to
the same file also fail. The output preserves request order and records both
`requested_ref` and canonical `ref`.

| Budget | Default | Hard maximum | Enforcement |
| --- | ---: | ---: | --- |
| `maxFiles` | 16 | 64 | Input admission, before runtime acquisition |
| `maxBytes` | 1,048,576 | 16,777,216 | Sum of selected file bytes, after manifest/identity admission and before object download |
| `timeBudgetMs` | 30,000 | 120,000 | Whole operation, including source access and materialization |

Each explicit budget is a positive integer. Shared chunks do not reduce the
declared selected-file byte total. A byte-budget failure can follow metadata
requests needed to establish identity; it does not imply that no network request
occurred. Cancellation and deadline termination wait for owned request cleanup.

## Ready result and byte semantics

The ready result contains the complete verified manifest and its digest, a
`selection` (`scope`, `owner`, `snapshot_id`, `version_id`), effective `budget`,
ordered `files`, `totals`, and `materialization.status = "selected_files_ready"`.
It does not claim that unselected files exist locally or that any content was
delivered to a model; `delivery.status` is `not_observed`.

Each file carries `requested_ref`, `ref`, optional `file_id`, `path`, `bytes`,
`sha256`, `encoding`, and `content`. UTF-8 text uses `encoding: "utf8"`; decoding
preserves BOM, CRLF, Unicode and an empty string. NUL-containing or invalid UTF-8
files use canonical `encoding: "base64"`. The digest always covers the original
bytes, not the base64 characters. The SDK writes no host output directory.

The result is entirely ready, failed, or cancelled. A bad selected object cannot
produce a partial ready result. Validated immutable cache chunks can remain after
a failure; the API does not promise cache transaction rollback. The pure decoder
checks the manifest, selected identities/order, canonical refs, content bytes,
hashes, totals, budget, and expected request when supplied.

## Read plan

One SDK operation owns one runtime and one metrics callback. The implementation
opens metadata once and reads only selected objects. Retained storage reuses the
multi-file materializer, including shared-chunk deduplication and bounded object
queries. It does not loop over `readSkill`, scan all cached files, prepare a graph,
or fall back to today's source version. A complete local pin retains existing
offline semantics; retained restoration keeps current library/owner admission.

Core controlled-source tests establish cold selected-object behavior. The npm
fixture is deliberately warm and establishes independent package exports,
decoder behavior, lifecycle cleanup and exact output. Its zero requests must
not be presented as a cold remote download measurement. See
[consumer contract](consumer-contract.md) and the existing
`.cursor/skills/verify-ntn-skills/features/skill-consumption.md` verification route.
