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
| Native daily creation, partial updates, registration and managed deletion | Public `skill` commands, native writer and finite operation kernel | Corresponding core/CLI management tests; live Notion and Pi checked separately |
| One unfinished intent, unknown-result observation, finite pending cleanup | `shared-current-operation.ts` | `shared-current-operation.test.ts`, `shared-current-operation.node.test.ts` |
| Full text, code and binary reading projections | `shared-current-projection.ts` | `shared-current-projection.test.ts` |
| Explicit complete-text projection, native preservation and nonblocking recovery | `shared-current-projection-write.ts` | `shared-current-projection-write.test.ts` |
| Exact Trash owner restoration followed by normal projection | `shared-current-projection-restore.ts`, `shared-current-operation.ts` | Existing projection-write, operation/Node and CLI projection tests |
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
and necessary native bodies, then rechecks the current owner. The current snapshot
tests bind request counts to their exact fixture. Unchanged metadata revalidation
reuses body bytes; a valid outer TTL cache hit is a separate zero-HTTP path.
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

Current `ctl library` exposes init, inspect, files, operation, skill, import,
projection, source and profile. `skill create|update|register|remove` owns daily
native authoring, machine registration and scoped deletion cleanup. Import
accepts a complete resource/native tree, with dry run and resume on the same route.
Source apply/refresh reconciles the complete selected Git member set through the
same operation kernel, including additions, removals and missing-owner rebuilds.
Source enable/disable, unreferenced removal and exact file takeover/restore-follow
use that current coordinator. Projection uses the same finite kernel and existing
renderer, keeps the real Skill ready, and verifies full text on existing pages.
Daily batches preserve human policy. Repeating a plain single-Skill or daily
command continues only a projection with matching target, policy and complete
input; explicit recovery retains the original policy and budgets. Conflicts and
unconfirmed writes stop with exact coordinates. Arbitrary raw property patches, sync, archive,
graph-release, repair and old migration writers are not public routes. A removed
route must fail without redirecting to a compatibility handler.

`projection PAGE_ID --restore` restores the same trashed owner through a narrow
finite intent, retires it and runs ordinary automatic projection. Both stages
share one budget and preserve current Source selection, identity, flags and
Notion authority. It accepts a single exact page, filters and budget limits;
daily, dry-run and manual operation/resume/cancel modes are rejected. An existing
live and complete result is a zero-write no-op. A page externally trashed during
an older unfinished projection is refused without replacing its marker.

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
regressions and [retained finite models](https://github.com/yoyooyooo/notion-skills-cli/blob/next/docs/formal-verification-maintenance.md).
Keep each model's complete configured rules and negative controls; request-engine
results do not prove the multi-step current writer.

## Daily acceptance scope

Check the selected daily set, complete paths/bytes/modes, preserved user policies,
upstream removals, same-version zero writes and consumption after a physical page
is rebuilt. Remove replaced runtime callers and completed conversion wiring in the
same implementation change. Retain still-unique author copies until the selected
replacement has been verified.

Use the matching CLI/SDK package and Broker for actual Pi samples. A controlled
HTTP fixture does not establish live Notion, the normal installation, host delivery
or model behavior. Keep the original Store when testing a rebuilt Skill; use the
chosen verification profile's declared native Skill and extension settings. Earlier
results remain bound to their original package, inputs and run scope.

Required Files metadata and original bytes belong to consumption. Reading-page
acceptance uses the public projection command, full actual body readback and a
repeat with zero semantic writes. Report native bodies as verified and non-text
files as skipped. Record coverage of unselected data and other hosts separately;
source tests do not establish those deployments.

## Native daily authoring acceptance

Use the existing management tests, package gate and paired Pi integration. This
procedure defines required observations, not a passing result or a new harness.
When a real provider changes content, preserve the original input, complete
readback and HTTP outcome before reducing it to a regression. Keep nearby unsafe
cases strict, including changed code and link targets; do not normalize away an
unknown write or replay it to obtain a clean sample.

1. Exercise public `skill create` with supported Markdown main/supporting content
   and an exact resource. Verify full Notion readback and the returned native
   normalization report. Normal LF/CRLF and terminal newlines must not require
   per-Skill trimming. Content loss, changed code or link destinations must fail;
   an echo fixture alone cannot establish live Notion behavior.
2. Use `skill update` on one file and selected author metadata. Preserve an
   unmentioned native edit, other current bindings, stable IDs and user policy.
   Native reads/exports use the actual Notion body and stored frontmatter/mode;
   resource/Source originals keep exact bytes. Do not claim native original-byte
   equality after normalization. Repeat unchanged intents and count real zero writes.
3. Register an authorized page already in the current Skills table. Keep its
   exact page/body, including frontmatter-looking body text; supply genuinely
   missing business metadata rather than inventing it. Verify automatic identity
   and Content registration, current native consumption, and a second unchanged
   registration. Refuse foreign/conflicting pages and implicit authority conversion.
4. Remove the authorized target through `skill remove`. Check supporting Files,
   unused owned resources and incoming same-library Members/Requires together;
   retain referencing Skills, remaining relations and Profiles. Relations must be
   observed while the target is live, before Trash hides them. Check complete
   pagination, bounded replacement, interruption recovery and a zero-write repeat.
   An auxiliary Agent may not patch fields, relations or pending state to finish.
5. Use the installed Pi entry and the selected verification profile with
   group/worker for the natural journey. Keep that profile's extension and native
   Skill settings explicit.
   Provide the author task, content and authorized scope; let the installed main
   builtin route to maintain and its public actions. Do not seed the prompt with
   the correct command, internal fields or expected answer. Check real worker
   calls, full provider-delivered body, subsequent native edits without projection
   and finite operation retirement. Installed package, live Notion and natural Pi
   results remain separate, with exact loaded artifacts, receipts and failures.

Unknown responses and budget interruption use the existing operation regressions.
The same intent may continue; conflicting input cannot be hidden by clearing
state. All unexecuted observations remain not_run. Scoped CRUD does not certify
whole-library legacy cleanup or unrelated Source configuration changes.

## Single-command Trash recovery

Run this only on the task's authorized exact Skill after its batch and prior
operations have completed. This is a live acceptance procedure; implementation
or fixture results alone do not mark it passed.

1. Save the actual owner page ID, stable Skill/Main File IDs, complete supporting
   File bindings, Enabled/Default Context/日用/期望删除 values, current Source
   revision, selected/excluded reading paths and complete body/byte observations.
   Verify there is no unfinished owner intent before preparing the fault.
2. Clear only generated Source reading bodies, leaving native author content and
   exact originals intact, then move the whole Skill page to Trash. Use reversible,
   explicitly authorized test preparation; permanent deletion is outside this
   route. Clearing text ensures the test proves rendering as well as untrashing.
3. Execute exactly one public product command:

   ```sh
   ntn-skills ctl library projection SKILL_PAGE_ID --restore --entry LIBRARY_ENTRY
   ```

   Include the original custom filters and required budgets in that same command
   when applicable. No Agent or auxiliary writer may patch pages, fix bindings,
   clear pending or supply missing bodies during or after the command to make the
   result pass. A product failure remains failed until the product path is fixed.
4. Inspect the actual successful receipt and read back the complete result.
   Compare the original physical page, stable identities, four flags, retained
   native/resource content, selected reading inventory, complete generated text,
   links and full consumption bytes/modes. Account for selected page creation or
   exclusion through the command's real row/body counts. Confirm ready and retired
   finite intents; restoration alone does not establish complete projection.
5. Run the identical public command again. Require `restoration.status: "unchanged"`,
   an unchanged projection, zero row/body changes, zero semantic Notion writes and
   no pending current operation. Keep actual top-level request metrics and budget;
   zero writes does not mean zero HTTP.

Use existing projection/write fixtures for lost restore ACK, interruption before
owner binding or intent retirement, and a later projection append interruption.
Repeat the same public command to verify each supported recovery. Verify zero-write
refusal for foreign/duplicate/unavailable owners, unfinished content work and an
older pending projection whose owner was externally trashed. A Source that is not
ready must never produce a complete result. Do not add another runner or recovery
ledger. Report controlled, installed-package and live results separately as
passed, failed, blocked or not_run, with their actual commands and remaining scope.
