# Current maintenance and consumption verification

The [current contract](current-contract.md) defines the product. This page maps
implemented current behavior to its owner and focused verification. It replaces
the former original-ACK, pinned-history, Git-main takeover and retained-repair
correspondence. Those former passes do not certify the current line.

## Current correspondence

| Behavior | Implementation | Focused verification |
| --- | --- | --- |
| One strict native/resource/source descriptor; finite Skill readiness | `shared-current-file.ts`, `shared-current-index.ts` | `shared-current-index.test.ts` |
| Complete current tree; native edits; local body freshness; zero semantic writes | `shared-snapshot.ts` | `shared-current-snapshot.test.ts` |
| Current stable Source selection and complete source layout | `shared-current-source.ts` | `shared-current-source.test.ts` |
| Current exact resources, inline or one original attachment | `shared-current-resource.ts`, current resource Records functions | `shared-current-resource.test.ts` |
| Single per-file acquisition v5 and current-locator checks | `shared-acquisition-model.ts`, `shared-fixed-acquisition.ts` | `shared-acquisition-contract.test.ts` |
| Current Profile replacement and finite local pending intent | `shared-profile.ts` | `shared-profile.test.ts` |
| HTTP limits, cancellation and read sharing | Existing request engine and coalescing | Existing request-budget, request-engine-contract and shared-read-coalescing tests |

Paths above are within `packages/core/src` and `packages/core/test`. The
[current-convergence](https://github.com/yoyooyooo/notion-skills-cli/blob/next/.cursor/skills/verify-ntn-skills/features/current-convergence.md)
entry chooses the necessary group. It does not run every table entry for every change.

## What the current tree checks

A cold native read fetches current Skill metadata, complete selected Files metadata
and necessary native bodies, then rechecks the current owner. The three-native-file
fixture needs six requests cold, or three requests with zero body reads on unchanged
metadata revalidation. A valid outer TTL cache hit is a separate zero-HTTP path.
The reader never queries event DAGs, original-operation
proofs or remote snapshot history. Warm metadata revalidation reuses verified
native bytes; editing one body's timestamp requires that body, and a missing
native object reads the current body. This current read is distinct from an old
task selection, which cannot silently acquire later native text.

The full-body deadline is independent of metadata renewals. Name/Description
changes return current display metadata without rewriting authored frontmatter or
changing content identity. File renames preserve File ID; removed rows do not
survive through cached event heads or tombstones. Current same-owner page links
are materialized against current bindings.

Resource acquisition verifies exact bytes and mode. Generated resource or Source
body edits never transfer authority. A complete directory and all file bindings
remain visible even when only the entry or one exact resource is downloaded.

Pending current operations, missing Content descriptors, owner/path conflicts,
incomplete pagination, permission failure and incomplete bodies block a complete
result. Query POST is read I/O. Creating Records, adopting edits, rendering missing
pages or repairing operations would be semantic writes and is forbidden here.

## Public boundary

Current `ctl library` exposes init, inspect, files and profile. The content,
Source-refresh, sync, archive, graph-release, repair and old migration writers are
not public routes while the current writer is being completed. A removed route
must fail, not redirect to a compatibility handler.

Current Profile tests may establish in-place rule replacement, unknown-response
reconciliation and no-op behavior. They do not establish the unfinished
content/Source writer, full projection generation or live library cleanup.

## Retired validation requirements

The former Git-only reader, automatic adoption, first-main takeover, old HTTP
takeover journeys, permanent snapshot recovery, original ACK/review/completion
chains and historical source-carrier repair are outside current acceptance.
Do not restore them to satisfy an old command example or test.

The operation-recovery and resource-lifecycle coverage files still describe old
implementation correspondence. They are not executed by the current entry until
a current behavior has an explicit applicable mapping, or the obsolete model is
retired. Do not update hashes or remove counterexamples to make them appear current.
Existing request-engine checks remain independently useful for their actual scope.

## Remaining acceptance

AH-504/507 must connect the current writer and finite recovery. AH-501 must
populate every supporting Files row and full reading projection. AH-505/513 must
resolve current references and remove actual obsolete Notion objects after
preserving unique current bytes. AH-517 must finish code, package and guidance
retirement. A documentation rewrite alone does not finish those tasks.

Use the matching complete CLI/SDK package and Broker for AH-1063's single actual
Pro Pi journey. A controlled HTTP fixture is not live Notion, package installation,
host delivery or a model result. AH-516 still owns every Pro-local Skill and
exposure/update edge. OMP/Tern host acceptance remains deferred.
