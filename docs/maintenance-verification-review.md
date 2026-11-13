# Progressive maintenance: implementation and model correspondence

AH-1024 extends the existing authorship, audit and original-operation owners. The prior baseline is `6c38e747a9e40186fdf9d4ecda033eb5b413561c`. This review records actual boundaries; execution results belong to a frozen run, not to this text or a refreshed source hash.

## Audit scope

`readReachableAudit` observes the selected page before relation-filtered Files and Records headers. Its callback retains already observed identity failures when the invocation exhausts its budget. A target run never marks an unfiltered table complete. `auditReachableReady` requires the owned observations; `auditReport` checks initial and final coverage. A full-library run still scans all tables independently and can find lost relations.

`AuditScope` abstracts four kinds of owner facts, a target/library choice, a bounded budget and one resumption. Scope immutability, read-only capability and checkpoint monotonicity map to the original scheduler, transport and stored run. Concrete HTTP counts, pagination, dependencies and permissions require implementation tests. Installed target checks compare zero and 120 unrelated rows from an independent actual-HTTP ledger; a three-request pause preserves an already observed root error.

V3 checkpoints cannot resume historical rules. Growth is descriptive: tombstones retain owner and File ID; operation and object headers use different denominators; equal header hashes do not prove equal bodies; private pins remain unobserved. No diagnostic grants cleanup or repair authority.

## Complete intent and ordered effects

`shared-skill-apply-tree.ts` classifies explicit moves/removes/revivals and exact reference spans. Omitted files remain in the final tree. The v2 parent retains its verified baseline, child candidates, ordered stages and full target manifest. `loadSharedApplyReferenceTree` reconstructs actual bytes from baseline objects and child candidates. A hash string is never a file body.

`authenticateApplyParent` requires the retained parent, exact child and every preceding applied child outcome. `continueSharedSkillApply` preserves verified effects and stops on unknown results. Explicit `resumeSharedSkillApply` requires the original local parent journal, verified prefix and genuinely undispatched suffix; remote query absence cannot create missing dispatch authority. A different Store may inspect shared historical completion but cannot invent a missing local journal.

`MaintenanceApply` models three ordered children. Dispatch, provider application, received acknowledgement, verified retained outcome and parent progress are separate. The acknowledgement variable records historical response receipt, not a claim that every child family writes a separate ACK row. Native allocation uses the durable source dispatcher. Body writes publish an applied outcome only after the exact response, body and ownership event verify. Parent recovery relies on original outcomes, never current equality.

The current-snapshot barrier rejects pending trees. Existing pins retain selected bytes and still obey current permission checks. Delete records a tombstone and retains the page/body. Explicit undelete restores the same File ID and exact retained bytes; it is not source-follow restoration.

These finite models do not promise atomic Notion transactions, compare-and-swap, arbitrary plan length, eventual unknown resolution or every native subrequest interleaving. Actual bytes, source changes, reference parsing, lost responses, row growth and package installation need separate concrete evidence.

## Original-page repair

Historical-main repair and managed-file adoption freeze one exact owner, native page, complete body, editable-property preimage, relationship and original-operation frontier. `sharedCreateDispatch` permits only the nominated blank-identity PATCH; ordinary creation does not acquire a general metadata-edit capability. Original body, plan and outcome are retained separately. Credential-scoped SQLite locators and POST markers are barriers, not a second remote authority.

Completion readers validate the full original plan, expected outcome and retained body. A matching current File ID, outcome header or another credential's ACK cannot manufacture completion. `assertSharedRepairPending` checks this exact owner before current consumption. Unknown requests are preserved rather than replaced. Ordinary child-page placement explicitly remains unsupported when its original page cannot safely become a managed database row.

Existing acknowledgement and creation models retain their bounds. Repair's metadata parsing and new entry authorization are unmodeled concrete guards; source tests and actual owned Notion readback prove those boundaries separately.

## Commands and host

Canonical `ctl audit/file/resource` spellings share their handlers with retained historical spellings. `ctl operation` delegates each exact original family. Show is not completion; reconcile is read-only; only explicit original apply resume has its narrow suffix authority. The Pi fixture validates that a proposed next.argv is the same owner's read-only original reconcile before it executes it.

Mock supplies model decisions only. Actual CLI, SDK, Pi tools, serializer, source writes and session recording run normally. The independent oracle checks native calls, exact source bodies, whole generated directory objects, each operation's effects and actual HTTP. Repeated paths in author commands or audit reports are not duplicate directories. Duplicate native call IDs remain visible to the verifier.

Independent installation, real Notion, real Pi with a loopback model and real-model usability are separate evidence scopes. A successful one does not stand in for another. No result authorizes a global installation change, production inventory repair, main merge or publication.
