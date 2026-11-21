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
| Explicit complete-text projection, native preservation and nonblocking recovery | `shared-current-projection-write.ts` | `shared-current-projection-write.test.ts` |
| Daily Source membership ∪ Skill 日用 ∪ Default Context, complete metadata only | `shared-current-daily.ts` | `shared-current-daily.test.ts` |
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

Current `ctl library` exposes init, inspect, files, operation, import, projection,
source and profile. Import
accepts a complete resource/native tree, with dry run and resume on the same route.
Source apply/refresh reconciles the complete selected Git member set through the
same operation kernel, including additions, removals and missing-owner rebuilds.
Source enable/disable, unreferenced removal and exact file takeover/restore-follow
use that current coordinator. Projection uses the same finite kernel and existing
renderer, keeps the real Skill ready, and verifies full text on existing pages.
Daily batches preserve human policy. Repeating a plain single-Skill or daily
command continues only a projection with matching target, policy and complete
input; explicit recovery retains the original policy and budgets. Conflicts and
unconfirmed writes stop with exact coordinates. Partial relationship patches, sync, archive,
graph-release, repair and old migration writers are not public routes. A removed
route must fail without redirecting to a compatibility handler.

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

## Daily acceptance and deferred work

AH-500 reuses the public sync, rebuild and consumption results from AH-504/AH-516.
Check the selected daily set, complete paths/bytes/modes, preserved user policies,
upstream removals, same-version zero writes and consumption after a physical page
is rebuilt. Replaced runtime code, callers and completed one-time conversion
wiring leave in the same implementation wave; AH-517 covers static leftovers only.

Use the matching CLI/SDK package and Broker for the necessary actual Pro Pi
samples. A controlled HTTP fixture is not live Notion, default installation,
host delivery or a model result. Keep the original Store when testing a rebuilt
Skill, and isolate global Skills with `pi -ns`. AH-1063 records the first native/Git
baseline; it does not certify a later pairing or the full daily batch.

Required Files metadata and original bytes belong to current consumption.
AH-501/AH-1141 now require full daily main and supporting text in Notion. Run the
public projection command, read back actual bodies and repeat to establish zero
semantic writes. Report native bodies as verified and non-text files as skipped.
The public command and controlled tests do not prove live daily coverage. Non-daily
text and binary presentation remain deferred. AH-505/AH-507/AH-513 cover additional
governance, recovery and non-daily data; those tasks do not block the daily batch.
Agent-kit main-path Skills and global exposure stay available. OMP/Tern and other
hosts remain deferred.
