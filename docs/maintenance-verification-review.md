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
| Explicit Git contribution preparation, batched target scope and mixed-tree writes | `shared-current-source-input.ts`, `shared-current-source-management.ts`, `shared-current-source-write.ts` | Corresponding Source input/management/write tests |
| Current exact resources, inline, attachment or a single-original ZIP carrier | `shared-current-resource.ts`, `shared-current-records.ts` | `shared-current-resource.test.ts` |
| Complete current input, original bytes, stable Files and owner-scoped retirement | `shared-current-write-input.ts`, `shared-current-write.ts` | `shared-current-write-input.test.ts`, `shared-current-write.test.ts` |
| One unfinished intent, unknown-result observation, finite pending cleanup | `shared-current-operation.ts` | `shared-current-operation.test.ts`, `shared-current-operation.node.test.ts` |
| Full text, code and binary reading projections | `shared-current-projection.ts` | `shared-current-projection.test.ts` |
| Current upload identity, multipart transmission and actual HTTP requests | `shared-current-upload.ts`, `notion-http.ts` | `shared-current-upload.test.ts`, `shared-current-upload-http.test.ts` |
| Single per-file acquisition v5 and current-locator checks | `shared-acquisition-model.ts`, `shared-fixed-acquisition.ts` | `shared-acquisition-contract.test.ts` |
| Current Profile replacement and finite local pending intent | `shared-profile.ts` | `shared-profile.test.ts` |
| Portable relation round-trip, complete same-library targets, cycle checks and same-operation writes | `shared-current-relations.ts`, `export.ts` | `shared-current-relations.test.ts`, current import and writer tests |
| Shared HTTP limits across Notion, managed provider HTTP, multipart and cleanup; Git subprocess deadline | `shared-current-invocation.ts`, `request-budget-http.ts` | `shared-current-invocation.test.ts`, `request-budget.test.ts` |
| HTTP cancellation and read sharing | Existing request engine and coalescing | Existing request-engine-contract and shared-read-coalescing tests |

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
Reference checks use that complete directory and only the loaded bodies. Deferred
Markdown is checked when selected, so directory listing does not download all
supporting text. A complete import checks all input references before Notion access.

Pending current operations, missing Content descriptors, owner/path conflicts,
incomplete pagination, permission failure and incomplete bodies block a complete
result. Query POST is read I/O. Creating Records, adopting edits, rendering missing
pages or repairing operations would be semantic writes and is forbidden here.

## Public boundary

Current `ctl library` exposes init, inspect, files, import, source and profile. Import
accepts a complete resource/native tree, with dry run and resume on the same route.
Source apply/refresh coordinates explicit current Git contributions with the same
operation kernel. Source removal/takeover, partial relationship updates, sync, archive, graph-release,
repair and old migration writers are not public routes. A removed route must
fail without redirecting to a compatibility handler.

Current Profile tests establish in-place rule replacement, unknown-response
reconciliation and no-op behavior for Profile rules. The current writer and
projection tests cover their own operation and output. The existing installed
package runner exercises dry run, import, files, individual reads, exact export
and zero-write reimport. None establishes live library cleanup.

## Retired validation requirements

The former Git-only reader, automatic adoption, first-main takeover, old HTTP
takeover journeys, permanent snapshot recovery, original ACK/review/completion
chains and historical source-carrier repair are outside current acceptance.
Do not restore them to satisfy an old command example or test.

The operation-recovery and resource-lifecycle models, coverage files, dedicated
mutation scripts and historical diagrams are retired with their cancelled
protocols. Current resource and recovery Skills select the existing implementation
regressions. The two request-engine models retain all 21 configurations and their
original rules; they do not prove the multi-step current writer.

## Remaining acceptance

AH-504/507 still own partial writes, Source takeover/removal and real-scope recovery
exits. AH-501 must populate and verify every actual supporting Files row and
reading projection in the live library. AH-505/513 must
resolve current references and remove actual obsolete Notion objects after
preserving unique current bytes. AH-517 must finish code, package and guidance
retirement. A documentation rewrite alone does not finish those tasks.

Use the matching complete CLI/SDK package and Broker for AH-1063's single actual
Pro Pi journey. A controlled HTTP fixture is not live Notion, package installation,
host delivery or a model result. AH-516 still owns every Pro-local Skill and
exposure/update edge. OMP/Tern host acceptance remains deferred.
